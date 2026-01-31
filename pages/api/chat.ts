import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

type Role = "user" | "assistant";

type StepDef = {
  id?: number;
  name?: string;
  expects?: string; // "name" | "concern" | etc
  prompt?: string;
  keywords?: string[];
};

type ScriptDef = {
  steps: StepDef[];
};

type FaqItem = {
  q: string;
  a: string;
  tags?: string[];
};

type ChatState = {
  step: number;
  name?: string | null;
  concern?: string | null;
  paying?: number | null;
  affordable?: number | null;
  urgent?: string | null;

  // loop guards
  askedNameTries?: number;
  lastPromptKey?: string; // dedupe key of last bot prompt
  lastStepPrompted?: number;
};

type ApiReqBody = {
  sessionId?: string;
  message?: string;
  userMessage?: string;
  history?: string[] | { role: Role; content: string }[];
  language?: string;
  state?: ChatState;
};

type ApiResp = {
  reply: string;
  state: ChatState;
  openPortal?: boolean;
  displayName?: string;
};

function readJsonSafe<T>(p: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalise(s: string) {
  return (s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stripPunctuation(s: string) {
  return s.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
}

function titleCaseName(s: string) {
  const cleaned = stripPunctuation(s);
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function getLocalTimeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function nowTimeStr() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Words we never want to treat as a name */
const NAME_BLOCKLIST = new Set(
  [
    "yes",
    "yeah",
    "yep",
    "ok",
    "okay",
    "sure",
    "alright",
    "right",
    "no",
    "nah",
    "hello",
    "hi",
    "hey",
    "good",
    "morning",
    "afternoon",
    "evening",
    "thanks",
    "thank you",
    "please",
    "mate",
    "pal",
    "bro",
    "bruv",
    "sir",
    "madam",
    "mr",
    "mrs",
    "ms",
    "miss",
    "i",
    "im",
    "i'm",
    "me",
    "my",
    "mine",
    "so",
    "and",
    "or",
    "but",
    "because",
    "well",
    "just",
    "like",
    "basically",
    "reset",
  ].map((x) => x.toLowerCase())
);

/** Words we should drop if they appear after a name (e.g. "Mark too"). */
const NAME_TAIL_STOPWORDS = new Set(["too", "as", "also", "thanks", "thank", "mate", "pal"].map((x) => x.toLowerCase()));

/** Obvious profanity we should refuse as a name (keep this short + safe). */
const PROFANITY = ["fuck", "fuck off", "shit", "twat", "cunt", "bitch", "crap", "wanker", "dick"];

function containsProfanity(s: string) {
  const t = normalise(s);
  return PROFANITY.some((w) => t.includes(w));
}

function containsDebtContent(s: string) {
  const t = normalise(s);
  return /debt|debts|credit|card|cards|loan|loans|overdraft|arrears|repayments|interest|missed|struggling|behind|bailiff|ccj|default|collections|payday/i.test(
    t
  );
}

/**
 * Small-talk detection:
 * IMPORTANT: if the message contains debt content, it is NOT small talk.
 */
function looksLikeGreetingOrSmallTalk(s: string) {
  const t = normalise(s);
  if (!t) return false;

  // If there's real debt content, do NOT route to small talk
  if (containsDebtContent(t)) return false;

  // strict greetings
  const isBareHello =
    t === "hello" || t === "hi" || t === "hey" || t === "hiya" || t === "morning" || t === "afternoon" || t === "evening";

  const isGoodGreeting =
    t === "good morning" ||
    t === "good afternoon" ||
    t === "good evening" ||
    t.startsWith("good morning") ||
    t.startsWith("good afternoon") ||
    t.startsWith("good evening");

  // "how are you" small talk
  const isHowAreYou = t.includes("how are you") || t.includes("how r you") || t.includes("how are u");

  // time question
  const isTime = t.includes("what is the time") || t === "what time is it" || t.startsWith("what time");

  // joke request
  const isJoke = t.includes("tell me a joke") || t === "joke" || t.includes("make me laugh");

  // If message is longer than a small greeting and doesn't match the above patterns, don't treat as small talk
  if (t.length > 45 && !isHowAreYou && !isTime && !isJoke) return false;

  return isBareHello || isGoodGreeting || isHowAreYou || isTime || isJoke;
}

/**
 * IMPORTANT: small talk reply should NOT ask the user questions.
 * We answer briefly, then the handler appends the current scripted prompt.
 */
function smallTalkReply(userText: string) {
  const t = normalise(userText);
  const greeting = getLocalTimeGreeting();

  if (t.includes("what is the time") || t === "what time is it" || t.startsWith("what time")) {
    return `It’s ${nowTimeStr()} right now.`;
  }

  if (t.includes("tell me a joke") || t === "joke" || t.includes("make me laugh")) {
    return `Okay — quick one: Why did the scarecrow get promoted? Because he was outstanding in his field.`;
  }

  if (t.includes("how are you") || t.includes("how r you") || t.includes("how are u")) {
    return `${greeting}! I’m doing well, thanks for asking.`;
  }

  if (t.includes("good morning") || t.includes("good afternoon") || t.includes("good evening")) {
    return `${greeting}!`;
  }

  if (t === "hello" || t === "hi" || t === "hey" || t === "hiya") {
    return `${greeting}!`;
  }

  return null;
}

/** Acknowledgement-only messages should NOT advance any step. */
function isAckOnly(userText: string) {
  const t = normalise(userText);
  if (!t) return true;
  const acks = new Set([
    "ok",
    "okay",
    "kk",
    "alright",
    "right",
    "cool",
    "nice",
    "thanks",
    "thank you",
    "cheers",
    "yep",
    "yeah",
    "yes",
    "no",
    "nope",
    "nah",
    "no worries",
    "got it",
    "fine",
    "great",
  ]);
  return acks.has(t);
}

function isSubstantiveAnswer(userText: string) {
  const t = normalise(userText);
  if (!t) return false;
  if (isAckOnly(t)) return false;
  if (t.length <= 2) return false;
  return true;
}

function extractName(userText: string): { ok: boolean; name?: string; reason?: string } {
  const raw = userText.trim();

  if (!raw) return { ok: false, reason: "empty" };
  if (containsProfanity(raw)) return { ok: false, reason: "profanity" };

  const t = stripPunctuation(raw);

  const trimTail = (nameText: string) => {
    const tokens = stripPunctuation(nameText)
      .split(" ")
      .filter(Boolean)
      .filter((tok) => !NAME_TAIL_STOPWORDS.has(normalise(tok)));
    return tokens.slice(0, 2).join(" ");
  };

  const m1 = t.match(/\bmy name is\s+(.+)$/i);
  if (m1?.[1]) {
    const cand = titleCaseName(trimTail(m1[1]));
    const simple = normalise(cand);
    if (!cand) return { ok: false, reason: "empty" };
    if (NAME_BLOCKLIST.has(simple)) return { ok: false, reason: "block" };
    return { ok: true, name: cand };
  }

  const m2 = t.match(/\bi am\s+(.+)$/i) || t.match(/\bi'?m\s+(.+)$/i) || t.match(/\bim\s+(.+)$/i);
  if (m2?.[1]) {
    const cand = titleCaseName(trimTail(m2[1]));
    const simple = normalise(cand);
    if (!cand) return { ok: false, reason: "empty" };
    if (NAME_BLOCKLIST.has(simple)) return { ok: false, reason: "block" };
    return { ok: true, name: cand };
  }

  const tokens = t.split(" ").filter(Boolean);
  if (tokens.length >= 1 && tokens.length <= 3) {
    const first = normalise(tokens[0]);
    if (NAME_BLOCKLIST.has(first)) return { ok: false, reason: "block" };

    const debtish = /debt|debts|loan|loans|credit|card|cards|struggling|help|worried/i.test(t);
    if (!debtish && tokens.length <= 3) {
      const cand = titleCaseName(tokens.join(" "));
      const simple = normalise(cand);
      if (cand && !NAME_BLOCKLIST.has(simple)) return { ok: true, name: cand };
    }
  }

  return { ok: false, reason: "no_match" };
}

function extractAmounts(text: string): { paying?: number; affordable?: number } {
  const cleaned = text.replace(/,/g, "");
  const nums = [...cleaned.matchAll(/£\s*([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
  const bare = [...cleaned.matchAll(/\b([0-9]{2,7})(?:\.[0-9]+)?\b/g)].map((m) => Number(m[1]));
  const all = nums.length ? nums : bare;

  if (all.length >= 2) return { paying: all[0], affordable: all[1] };
  if (all.length === 1) {
    const t = normalise(text);
    if (t.includes("afford") || t.includes("could pay") || t.includes("can pay")) return { affordable: all[0] };
    if (t.includes("paying") || t.includes("pay ") || t.includes("currently pay")) return { paying: all[0] };
    return { paying: all[0] };
  }
  return {};
}

function bestFaqMatch(userText: string, faqs: FaqItem[]) {
  const t = normalise(userText);
  let best: { score: number; a: string } | null = null;

  for (const f of faqs) {
    const q = normalise(f.q || "");
    if (!q) continue;

    let score = 0;
    if (t === q) score += 100;
    if (t.includes(q) || q.includes(t)) score += 60;

    const tags = (f.tags || []).map(normalise);
    for (const tag of tags) {
      if (tag && t.includes(tag)) score += 10;
    }

    const tTokens = new Set(t.split(" ").filter((x) => x.length >= 3));
    const qTokens = q.split(" ").filter((x) => x.length >= 3);
    let overlap = 0;
    for (const tok of qTokens) if (tTokens.has(tok)) overlap++;
    score += overlap;

    if (!best || score > best.score) best = { score, a: f.a };
  }

  if (best && best.score >= 18) return best.a;
  return null;
}

function promptKey(step: number, prompt: string) {
  return `${step}:${normalise(prompt).slice(0, 120)}`;
}

const FALLBACK_STEP0 = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";

function stripLeadingIntroFromPrompt(prompt: string) {
  const p = (prompt || "").trim();
  const lowered = normalise(p);
  if (lowered.startsWith("hello! my name’s mark.")) return p.replace(/^Hello!\s+My name’s Mark\.\s*/i, "");
  if (lowered.startsWith("hello! my name's mark.")) return p.replace(/^Hello!\s+My name'?s Mark\.\s*/i, "");
  return p;
}

/** Step 0 variant so we don’t repeat the exact same question after small talk (professional wording) */
function step0SmalltalkVariant(cleanPrompt: string) {
  const canon = "what prompted you to seek help with your debts today?";
  if (normalise(cleanPrompt) === canon) {
    return "To begin, what has made you reach out about your debts today?";
  }
  return cleanPrompt;
}

/**
 * Robust script loader:
 * Accepts {steps:[...]}, {script:{steps:[...]}}, {flow:{steps:[...]}}, or just an array.
 */
function loadScriptDef(scriptPath: string): ScriptDef {
  const raw = readJsonSafe<any>(scriptPath, null);

  let steps: any[] = [];
  if (Array.isArray(raw)) steps = raw;
  else if (raw && Array.isArray(raw.steps)) steps = raw.steps;
  else if (raw && raw.script && Array.isArray(raw.script.steps)) steps = raw.script.steps;
  else if (raw && raw.flow && Array.isArray(raw.flow.steps)) steps = raw.flow.steps;
  else if (raw && raw.fullScriptLogic && Array.isArray(raw.fullScriptLogic.steps)) steps = raw.fullScriptLogic.steps;

  const normalized: StepDef[] = steps
    .filter(Boolean)
    .map((s: any, idx: number) => {
      const id = typeof s?.id === "number" ? s.id : idx;
      return {
        id,
        name: typeof s?.name === "string" ? s.name : `step_${id}`,
        expects: typeof s?.expects === "string" ? s.expects : "free",
        prompt: typeof s?.prompt === "string" ? s.prompt : "",
        keywords: Array.isArray(s?.keywords) ? s.keywords : undefined,
      };
    });

  return { steps: normalized };
}

/**
 * Step resolver:
 * - If script uses IDs matching state.step, use that.
 * - Otherwise treat state.step as an index.
 */
function resolveStep(script: ScriptDef, step: number): StepDef | null {
  if (!script.steps?.length) return null;

  const hasIds = script.steps.some((s) => typeof s.id === "number");
  if (hasIds) {
    const byId = script.steps.find((s) => s.id === step);
    if (byId) return byId;
  }
  return script.steps[step] || script.steps[0];
}

function clampNextStep(script: ScriptDef, next: number) {
  if (!script.steps?.length) return next;
  const maxIndex = script.steps.length - 1;
  return Math.max(0, Math.min(next, maxIndex));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  if (req.method !== "POST") {
    return res.status(405).json({
      reply: "Method not allowed.",
      state: { step: 0, askedNameTries: 0, name: null },
    });
  }

  const body = (req.body || {}) as ApiReqBody;
  const userText = (body.userMessage ?? body.message ?? "").toString().trim();

  const history: string[] = Array.isArray(body.history)
    ? typeof (body.history as any)[0] === "string"
      ? (body.history as string[])
      : (body.history as any[]).map((m) => String(m?.content || "")).filter(Boolean)
    : [];

  const scriptPath = path.join(process.cwd(), "utils", "full_script_logic.json");
  const faqPath = path.join(process.cwd(), "utils", "faqs.json");

  const script = loadScriptDef(scriptPath);
  const faqRaw = readJsonSafe<any>(faqPath, []);
  const faqs: FaqItem[] = Array.isArray(faqRaw)
    ? faqRaw
    : Array.isArray(faqRaw?.faqs)
      ? faqRaw.faqs
      : [];

  const state: ChatState = {
    step: 0,
    askedNameTries: 0,
    name: null,
    ...body.state,
  };

  if (normalise(userText) === "reset") {
    const first = resolveStep(script, 0)?.prompt || FALLBACK_STEP0;
    const s: ChatState = { step: 0, askedNameTries: 0, name: null, lastPromptKey: undefined, lastStepPrompted: undefined };
    return res.status(200).json({ reply: first, state: s });
  }

  const currentStepDef = resolveStep(script, state.step);
  const currentPromptFull = currentStepDef?.prompt || FALLBACK_STEP0;

  const currentPromptClean = state.name ? stripLeadingIntroFromPrompt(currentPromptFull) || currentPromptFull : currentPromptFull;

  // ACK-only should just repeat the current scripted prompt, cleanly
  if (isAckOnly(userText)) {
    const key = promptKey(state.step, currentPromptClean);
    return res.status(200).json({
      reply: currentPromptClean,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  // 1) Small talk — but only when it's truly small talk
  if (looksLikeGreetingOrSmallTalk(userText)) {
    const st = smallTalkReply(userText);

    let follow = stripLeadingIntroFromPrompt(currentPromptFull) || currentPromptFull;
    if (state.step === 0) follow = step0SmalltalkVariant(follow);

    const reply = st ? `${st}\n\n${follow}` : follow;
    const key = promptKey(state.step, follow);

    // Avoid repeating exact same prompt forever
    if (state.lastPromptKey === key) {
      const alt =
        state.step === 0
          ? "When you’re ready, please tell me what has made you reach out about your debts today."
          : "When you’re ready, we can continue from where we left off.";
      return res.status(200).json({
        reply: st ? `${st}\n\n${alt}` : alt,
        state: { ...state, lastPromptKey: promptKey(state.step, alt), lastStepPrompted: state.step },
      });
    }

    return res.status(200).json({
      reply,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  // 2) FAQ handling (if user asks a question)
  const faqAnswer = bestFaqMatch(userText, faqs);
  if (faqAnswer) {
    const follow = currentPromptClean;
    const reply = `${faqAnswer}\n\n${follow}`;

    const key = promptKey(state.step, follow);
    return res.status(200).json({
      reply,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  // 3) Script progression
  const stepDef = resolveStep(script, state.step);
  const expects = stepDef?.expects || "free";

  // NAME step
  if (expects === "name") {
    const tries = state.askedNameTries || 0;
    const nameParse = extractName(userText);

    if (nameParse.ok && nameParse.name) {
      const name = nameParse.name;
      const isSameAsMark = normalise(name) === "mark";

      const greet = isSameAsMark
        ? `Nice to meet you, Mark. Nice to meet a fellow Mark.`
        : `Nice to meet you, ${name}.`;

      const nextState: ChatState = {
        ...state,
        name,
        askedNameTries: 0,
        step: clampNextStep(script, state.step + 1),
      };

      const nextPrompt = resolveStep(script, nextState.step)?.prompt || "What’s the main concern with the debts at the moment?";

      return res.status(200).json({
        reply: `${greet} ${nextPrompt}`,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
        displayName: name,
      });
    }

    const nextTries = tries + 1;

    if (nextTries >= 4) {
      const nextState: ChatState = {
        ...state,
        name: "there",
        askedNameTries: nextTries,
        step: clampNextStep(script, state.step + 1),
      };
      const nextPrompt = resolveStep(script, nextState.step)?.prompt || "What’s the main concern with the debts at the moment?";
      return res.status(200).json({
        reply: `No problem. ${nextPrompt}`,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
      });
    }

    const ask =
      nextTries <= 0
        ? "Can you let me know who I’m speaking with? A first name is perfect."
        : nextTries === 1
          ? "Sorry, what first name would you like me to use?"
          : nextTries === 2
            ? "No worries. Just pop a first name and we’ll carry on."
            : "That’s fine. I’ll just call you ‘there’ for now. What’s the main thing you want help with today?";

    return res.status(200).json({
      reply: ask,
      state: { ...state, askedNameTries: nextTries, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
    });
  }

  // amounts step
  if (expects === "amounts") {
    const { paying, affordable } = extractAmounts(userText);

    const nextState: ChatState = {
      ...state,
      paying: typeof paying === "number" ? paying : state.paying ?? null,
      affordable: typeof affordable === "number" ? affordable : state.affordable ?? null,
    };

    const haveBoth = typeof nextState.paying === "number" && typeof nextState.affordable === "number";

    if (!haveBoth) {
      const prompt =
        "Thanks. Roughly what do you pay towards all debts each month, and what would feel affordable? For example: “I pay £600 and could afford £200.”";
      return res.status(200).json({
        reply: prompt,
        state: { ...nextState, lastPromptKey: promptKey(state.step, prompt), lastStepPrompted: state.step },
      });
    }

    nextState.step = clampNextStep(script, state.step + 1);
    const nextPrompt = resolveStep(script, nextState.step)?.prompt || "Is there anything urgent like bailiff action or missed priority bills?";
    const name = nextState.name && nextState.name !== "there" ? nextState.name : null;

    const ack = name ? `Thanks, ${name}.` : "Thanks.";

    return res.status(200).json({
      reply: `${ack} ${nextPrompt}`,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  // concern step
  if (expects === "concern") {
    const t = userText.trim();
    const isTooShort = t.length < 3;
    if (isTooShort) {
      const prompt = stepDef?.prompt || "What would you say your main concern is with the debts?";
      return res.status(200).json({
        reply: prompt,
        state: { ...state, lastPromptKey: promptKey(state.step, prompt), lastStepPrompted: state.step },
      });
    }

    const nextState: ChatState = { ...state, concern: t, step: clampNextStep(script, state.step + 1) };
    const name = nextState.name && nextState.name !== "there" ? nextState.name : null;

    const empathy = name
      ? `Thanks for sharing that, ${name}. That can feel really heavy, but we’ll take it step by step.`
      : `Thanks for sharing that. That can feel really heavy, but we’ll take it step by step.`;

    const nextPrompt = resolveStep(script, nextState.step)?.prompt || "Roughly how much do you pay towards your debts each month?";

    return res.status(200).json({
      reply: `${empathy} ${nextPrompt}`,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  // free steps must progress using the script prompt
  if (expects === "free") {
    if (!isSubstantiveAnswer(userText)) {
      const follow = currentPromptClean;
      return res.status(200).json({
        reply: follow,
        state: { ...state, lastPromptKey: promptKey(state.step, follow), lastStepPrompted: state.step },
      });
    }

    const name = state.name && state.name !== "there" ? state.name : null;

    const nextState: ChatState =
      state.step === 0
        ? { ...state, concern: userText, step: clampNextStep(script, state.step + 1) }
        : { ...state, step: clampNextStep(script, state.step + 1) };

    const nextPrompt =
      resolveStep(script, nextState.step)?.prompt ||
      (currentPromptClean || FALLBACK_STEP0);

    const ack = name ? `Thanks, ${name} — understood.` : "Thanks — understood.";

    return res.status(200).json({
      reply: `${ack} ${nextPrompt}`,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  // last resort: just return current prompt
  return res.status(200).json({
    reply: currentPromptClean || FALLBACK_STEP0,
    state: { ...state, lastPromptKey: promptKey(state.step, currentPromptClean || FALLBACK_STEP0), lastStepPrompted: state.step },
  });
}

