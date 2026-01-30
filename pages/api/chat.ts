import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

type ChatReqBody = {
  sessionId?: string;
  userMessage?: string;
  message?: string; // support older client payloads
  history?: string[];
  language?: string;
};

type ChatResBody = {
  reply: string;
  displayName?: string;
  openPortal?: boolean;
};

type ScriptStep = {
  id?: string;
  text?: string;
  prompt?: string;
  // optional branching fields (your JSON may differ)
  next?: number;
  onYes?: number;
  onNo?: number;
  keywords?: string[];
};

type ScriptJson = {
  steps: ScriptStep[];
};

type FaqItem = {
  q: string;
  a: string;
  keywords?: string[];
};

type FaqJson =
  | FaqItem[]
  | {
      faqs: FaqItem[];
    };

type SessionState = {
  stepIndex: number;
  name?: string;
  lastBot?: string;
  greeted?: boolean;
};

const memStore = new Map<string, SessionState>();

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadScript(): ScriptJson {
  // You told me you have full_script_logic.json in the project
  const p = path.join(process.cwd(), "full_script_logic.json");
  if (!fs.existsSync(p)) return { steps: [] };
  const raw = fs.readFileSync(p, "utf8");
  const parsed = safeJsonParse<ScriptJson>(raw, { steps: [] });
  return parsed?.steps?.length ? parsed : { steps: [] };
}

function loadFaqs(): FaqItem[] {
  // You uploaded faqs.json – it may be either [] or {faqs:[]}
  const candidates = [
    path.join(process.cwd(), "faqs.json"),
    path.join(process.cwd(), "utils", "faqs.json"),
    path.join(process.cwd(), "utils", "faqs.json"),
    path.join(process.cwd(), "data", "faqs.json"),
  ];

  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) return [];

  const raw = fs.readFileSync(hit, "utf8");
  const parsed = safeJsonParse<FaqJson>(raw, []);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray((parsed as any).faqs)) return (parsed as any).faqs;
  return [];
}

function norm(s: string) {
  return (s || "").trim().toLowerCase();
}

function stripPunctuation(s: string) {
  return (s || "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstName(input: string): string | null {
  const t = stripPunctuation(input).trim();
  if (!t) return null;

  // common patterns
  const lowered = t.toLowerCase();
  const patterns = [
    "my name is ",
    "i am ",
    "im ",
    "i'm ",
    "this is ",
    "it is ",
    "its ",
    "it's ",
  ];

  for (const p of patterns) {
    if (lowered.startsWith(p)) {
      const rest = t.slice(p.length).trim();
      const first = rest.split(" ")[0]?.trim();
      return first && first.length >= 2 ? cap(first) : null;
    }
  }

  // If user typed full name like "Mark Hughes", we accept first token
  const firstToken = t.split(" ")[0]?.trim();
  if (!firstToken) return null;

  // reject obvious non-names
  const bad = new Set(["hello", "hi", "hey", "morning", "evening", "afternoon", "test"]);
  if (bad.has(firstToken.toLowerCase())) return null;

  // must contain letters
  if (!/[a-zA-Z]/.test(firstToken)) return null;

  return cap(firstToken);
}

function cap(s: string) {
  const x = (s || "").trim();
  if (!x) return x;
  return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
}

function getGreetingNow(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function isSmallTalk(msg: string) {
  const m = norm(msg);
  return (
    m === "hello" ||
    m === "hi" ||
    m === "hey" ||
    m.includes("how are you") ||
    m.includes("how r u") ||
    m.includes("hows it going") ||
    m.includes("good morning") ||
    m.includes("good afternoon") ||
    m.includes("good evening") ||
    m.includes("what is the time") ||
    m === "time" ||
    m.includes("tell me a joke") ||
    m === "joke" ||
    m.includes("thank") ||
    m.includes("thanks")
  );
}

function smallTalkReply(msg: string): string | null {
  const m = norm(msg);

  if (m === "hello" || m === "hi" || m === "hey") {
    return `${getGreetingNow()}! How are you doing today?`;
  }

  if (m.includes("good morning") || m.includes("good afternoon") || m.includes("good evening")) {
    return `${getGreetingNow()}! How are you doing today?`;
  }

  if (m.includes("how are you") || m.includes("how r u") || m.includes("hows it going")) {
    return `I’m doing well, thanks for asking. How are you feeling today?`;
  }

  if (m.includes("what is the time") || m === "time") {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `It’s ${hh}:${mm}. What’s brought you to reach out today?`;
  }

  if (m.includes("tell me a joke") || m === "joke") {
    return `Alright 😄  What do you call a debt that’s gone on holiday? A *loan* ranger.  
Now, tell me what’s been happening with the debts and we’ll take it step by step.`;
  }

  if (m.includes("thank")) {
    return `You’re welcome. Take your time — what’s the main thing you want help with today?`;
  }

  return null;
}

function faqMatch(userMsg: string, faqs: FaqItem[]): string | null {
  const u = norm(userMsg);
  if (!u) return null;

  // simple keyword scoring
  let best: { score: number; a: string } | null = null;

  for (const f of faqs) {
    const q = norm(f.q);
    const a = f.a || "";
    const keys = (f.keywords || []).map(norm).filter(Boolean);

    let score = 0;

    // direct contains
    if (q && u.includes(q)) score += 6;

    // keyword hits
    for (const k of keys) {
      if (!k) continue;
      if (u.includes(k)) score += 2;
    }

    // overlap heuristic (cheap + effective)
    const uq = new Set(stripPunctuation(u).split(" "));
    const qq = new Set(stripPunctuation(q).split(" "));
    let overlap = 0;
    for (const w of uq) if (qq.has(w) && w.length > 3) overlap++;
    score += Math.min(4, overlap);

    if (score >= 6) {
      if (!best || score > best.score) best = { score, a };
    }
  }

  return best ? best.a : null;
}

function getState(sessionId: string): SessionState {
  const hit = memStore.get(sessionId);
  if (hit) return hit;
  const init: SessionState = { stepIndex: 0, greeted: false };
  memStore.set(sessionId, init);
  return init;
}

function setState(sessionId: string, next: SessionState) {
  memStore.set(sessionId, next);
}

function getStepText(step: ScriptStep | undefined): string {
  if (!step) return "";
  return (step.text || step.prompt || "").trim();
}

function looksLikeYes(msg: string) {
  const m = norm(msg);
  return ["yes", "y", "yeah", "yep", "ok", "okay", "alright", "sure"].includes(m) || m.startsWith("yes ");
}

function looksLikeNo(msg: string) {
  const m = norm(msg);
  return ["no", "n", "nope", "not really"].includes(m) || m.startsWith("no ");
}

function chooseNextIndex(script: ScriptJson, currentIndex: number, userMsg: string): number {
  const step = script.steps[currentIndex];
  if (!step) return currentIndex;

  // basic branching if provided
  if (typeof step.onYes === "number" && looksLikeYes(userMsg)) return step.onYes;
  if (typeof step.onNo === "number" && looksLikeNo(userMsg)) return step.onNo;

  if (typeof step.next === "number") return step.next;

  // default: advance by 1 (safe)
  const next = currentIndex + 1;
  return next < script.steps.length ? next : currentIndex;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ChatResBody>) {
  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed." });
  }

  const body = (req.body || {}) as ChatReqBody;

  const sessionId = (body.sessionId || "").trim() || `sess_${Math.random().toString(36).slice(2)}`;
  const userMessage = (body.userMessage || body.message || "").toString().trim();
  const language = (body.language || "English").toString();

  const script = loadScript();
  const faqs = loadFaqs();

  const state = getState(sessionId);

  // First message safety
  if (!userMessage) {
    const first = state.name
      ? `${getGreetingNow()}, ${state.name}. What prompted you to seek help with your debts today?`
      : `Hello! My name’s Mark. What prompted you to seek help with your debts today?`;
    return res.status(200).json({ reply: first, displayName: state.name });
  }

  // Always allow reset during testing
  if (norm(userMessage) === "reset") {
    const resetState: SessionState = { stepIndex: 0, greeted: false };
    setState(sessionId, resetState);
    return res.status(200).json({
      reply: "No problem — I’ve reset things. What prompted you to seek help with your debts today?",
    });
  }

  // If we still don’t have a name, try to capture it from ANY message naturally
  if (!state.name) {
    const maybeName = extractFirstName(userMessage);
    if (maybeName) {
      const nextState = { ...state, name: maybeName };
      setState(sessionId, nextState);

      // friendly acknowledgement + move forward naturally
      return res.status(200).json({
        reply: `Nice to meet you, ${maybeName}. What’s the main concern with the debts at the moment?`,
        displayName: maybeName,
      });
    }
  }

  // Smalltalk layer: respond like a human FIRST, then gently bring it back
  if (isSmallTalk(userMessage)) {
    const r = smallTalkReply(userMessage);
    if (r) {
      // If they asked smalltalk and we still don't have a name, we can ask after
      if (!state.name && /how are you|hello|hi|hey|morning|afternoon|evening/.test(norm(userMessage))) {
        return res.status(200).json({
          reply: `${r} Can you tell me your first name?`,
        });
      }

      // We have a name: keep it natural and then guide back
      if (state.name) {
        return res.status(200).json({
          reply: `${r} When you’re ready, tell me what’s been happening with the debts and we’ll take it step by step.`,
          displayName: state.name,
        });
      }

      return res.status(200).json({ reply: r });
    }
  }

  // FAQ layer: answer common questions without derailing the flow
  const faqAnswer = faqMatch(userMessage, faqs);
  if (faqAnswer) {
    const nudge = state.name
      ? `\n\nIf you’re happy, ${state.name}, tell me what’s been going on with the debts and I’ll guide you through the options.`
      : `\n\nIf you’re happy, tell me what’s been going on with the debts and I’ll guide you through the options.`;

    return res.status(200).json({
      reply: `${faqAnswer}${nudge}`,
      displayName: state.name,
    });
  }

  // Script engine (light touch): only push the next step AFTER acknowledging user message
  // If script is missing, keep the bot useful rather than looping
  if (!script.steps.length) {
    const nm = state.name ? `, ${state.name}` : "";
    return res.status(200).json({
      reply: `Thanks${nm}. Tell me a bit more about what’s happening — roughly how much you owe, who to, and what your biggest worry is right now?`,
      displayName: state.name,
    });
  }

  // If we’re early in the script and the user gave meaningful info, acknowledge it
  const acknowledgePrefix = state.name
    ? `Thanks, ${state.name}. `
    : `Thanks. `;

  // Decide next step index based on current + user reply
  const nextIndex = chooseNextIndex(script, state.stepIndex, userMessage);
  const nextStep = script.steps[nextIndex];
  const stepText = getStepText(nextStep);

  // If step text is empty, fail gracefully
  if (!stepText) {
    const fallback = `${acknowledgePrefix}I’m with you. What would you say is the main thing you want help with right now — stopping pressure, reducing payments, or finding a formal solution?`;
    const nextState: SessionState = { ...state, stepIndex: nextIndex, lastBot: fallback };
    setState(sessionId, nextState);
    return res.status(200).json({ reply: fallback, displayName: state.name });
  }

  // If the step is the "ask name" type step but we already have a name, skip it
  const stepNorm = norm(stepText);
  const isNamePrompt =
    stepNorm.includes("who i’m speaking with") ||
    stepNorm.includes("who i'm speaking with") ||
    stepNorm.includes("first name");

  if (isNamePrompt && state.name) {
    const skipIndex = Math.min(nextIndex + 1, script.steps.length - 1);
    const skipStep = script.steps[skipIndex];
    const skipText = getStepText(skipStep) || "What would you say your main concern is with the debts?";

    const nextState: SessionState = { ...state, stepIndex: skipIndex, lastBot: skipText };
    setState(sessionId, nextState);

    return res.status(200).json({
      reply: `${acknowledgePrefix}${skipText}`,
      displayName: state.name,
    });
  }

  // Normal script reply
  const finalReply = `${acknowledgePrefix}${stepText}`;
  const nextState: SessionState = { ...state, stepIndex: nextIndex, lastBot: finalReply };
  setState(sessionId, nextState);

  return res.status(200).json({
    reply: finalReply,
    displayName: state.name,
    // openPortal: true when your script reaches that moment later (we’ll wire this to your new doc popup triggers next)
  });
}
