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
  const p = path.join(process.cwd(), "full_script_logic.json");
  if (!fs.existsSync(p)) return { steps: [] };
  const raw = fs.readFileSync(p, "utf8");
  const parsed = safeJsonParse<ScriptJson>(raw, { steps: [] });
  return parsed?.steps?.length ? parsed : { steps: [] };
}

function loadFaqs(): FaqItem[] {
  const candidates = [
    path.join(process.cwd(), "faqs.json"),
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

/**
 * FIXED: Extract first name from a message reliably.
 * - Finds "my name is X", "i am X", "i'm X" ANYWHERE in sentence
 * - Ignores leading filler like yes/yeah/ok/hi etc
 * - Avoids accepting "yes" as a name
 */
function extractFirstName(input: string): string | null {
  const raw = stripPunctuation(input);
  if (!raw) return null;

  const lowered = raw.toLowerCase();

  // 1) Regex patterns anywhere in message
  const patterns: Array<RegExp> = [
    /\bmy name is\s+([a-zA-Z][a-zA-Z'-]{1,})\b/i,
    /\bi am\s+([a-zA-Z][a-zA-Z'-]{1,})\b/i,
    /\bi'?m\s+([a-zA-Z][a-zA-Z'-]{1,})\b/i,
    /\bthis is\s+([a-zA-Z][a-zA-Z'-]{1,})\b/i,
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      const candidate = m[1].trim();
      const cLower = candidate.toLowerCase();
      const reject = new Set(["yes", "yeah", "yep", "ok", "okay", "alright", "sure", "hello", "hi", "hey"]);
      if (reject.has(cLower)) return null;
      return cap(candidate);
    }
  }

  // 2) If no pattern, try first token — but strip common lead-ins first
  let tokens = raw.split(" ").filter(Boolean);
  if (!tokens.length) return null;

  const leadIns = new Set([
    "yes",
    "yeah",
    "yep",
    "ok",
    "okay",
    "alright",
    "sure",
    "hello",
    "hi",
    "hey",
    "morning",
    "afternoon",
    "evening",
    "good",
  ]);

  while (tokens.length && leadIns.has(tokens[0].toLowerCase())) {
    tokens.shift();
  }

  const firstToken = (tokens[0] || "").trim();
  if (!firstToken) return null;

  // reject obvious non-names
  const bad = new Set(["test", "time", "joke"]);
  if (bad.has(firstToken.toLowerCase())) return null;

  // must contain letters
  if (!/[a-zA-Z]/.test(firstToken)) return null;

  return cap(firstToken);
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
    return `Alright 😄 What do you call a debt that’s gone on holiday? A *loan* ranger.  
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

  let best: { score: number; a: string } | null = null;

  for (const f of faqs) {
    const q = norm(f.q);
    const a = f.a || "";
    const keys = (f.keywords || []).map(norm).filter(Boolean);

    let score = 0;
    if (q && u.includes(q)) score += 6;

    for (const k of keys) {
      if (!k) continue;
      if (u.includes(k)) score += 2;
    }

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

  if (typeof step.onYes === "number" && looksLikeYes(userMsg)) return step.onYes;
  if (typeof step.onNo === "number" && looksLikeNo(userMsg)) return step.onNo;

  if (typeof step.next === "number") return step.next;

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
  const language = (body.language || "English").toString(); // kept for later, not used yet

  const script = loadScript();
  const faqs = loadFaqs();

  const state = getState(sessionId);

  if (!userMessage) {
    const first = state.name
      ? `${getGreetingNow()}, ${state.name}. What prompted you to seek help with your debts today?`
      : `Hello! My name’s Mark. What prompted you to seek help with your debts today?`;
    return res.status(200).json({ reply: first, displayName: state.name });
  }

  if (norm(userMessage) === "reset") {
    const resetState: SessionState = { stepIndex: 0, greeted: false };
    setState(sessionId, resetState);
    return res.status(200).json({
      reply: "No problem — I’ve reset things. What prompted you to seek help with your debts today?",
    });
  }

  // Capture name from ANY message (fixed)
  if (!state.name) {
    const maybeName = extractFirstName(userMessage);
    if (maybeName) {
      const nextState = { ...state, name: maybeName };
      setState(sessionId, nextState);

      return res.status(200).json({
        reply: `Nice to meet you, ${maybeName}. What’s the main concern with the debts at the moment?`,
        displayName: maybeName,
      });
    }
  }

  // Smalltalk layer
  if (isSmallTalk(userMessage)) {
    const r = smallTalkReply(userMessage);
    if (r) {
      if (!state.name && /how are you|hello|hi|hey|morning|afternoon|evening/.test(norm(userMessage))) {
        return res.status(200).json({
          reply: `${r} Can you tell me your first name?`,
        });
      }

      if (state.name) {
        return res.status(200).json({
          reply: `${r} When you’re ready, tell me what’s been happening with the debts and we’ll take it step by step.`,
          displayName: state.name,
        });
      }

      return res.status(200).json({ reply: r });
    }
  }

  // FAQ layer
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

  // If script missing, stay helpful
  if (!script.steps.length) {
    const nm = state.name ? `, ${state.name}` : "";
    return res.status(200).json({
      reply: `Thanks${nm}. Tell me a bit more about what’s happening — roughly how much you owe, who to, and what your biggest worry is right now?`,
      displayName: state.name,
    });
  }

  const acknowledgePrefix = state.name ? `Thanks, ${state.name}. ` : `Thanks. `;

  const nextIndex = chooseNextIndex(script, state.stepIndex, userMessage);
  const nextStep = script.steps[nextIndex];
  const stepText = getStepText(nextStep);

  if (!stepText) {
    const fallback = `${acknowledgePrefix}I’m with you. What would you say is the main thing you want help with right now — stopping pressure, reducing payments, or finding a formal solution?`;
    const nextState: SessionState = { ...state, stepIndex: nextIndex, lastBot: fallback };
    setState(sessionId, nextState);
    return res.status(200).json({ reply: fallback, displayName: state.name });
  }

  // Skip name prompt if name already captured
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

  const finalReply = `${acknowledgePrefix}${stepText}`;
  const nextState: SessionState = { ...state, stepIndex: nextIndex, lastBot: finalReply };
  setState(sessionId, nextState);

  return res.status(200).json({
    reply: finalReply,
    displayName: state.name,
  });
}
