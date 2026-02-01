import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

type Role = "user" | "assistant";

type StepDef = {
  id: number;
  name: string;
  expects: string; // "name" | "concern" | "amounts" | "free" | etc
  prompt: string;
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
  step: number; // treated as steps[] index
  name?: string | null;
  concern?: string | null;
  paying?: number | null;
  affordable?: number | null;
  urgent?: string | null;

  askedNameTries?: number;
  lastPromptKey?: string;
  lastStepPrompted?: number;

  lastFreeAnswer?: string | null;
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

/**
 * Use Europe/London time so greetings match the UK user experience,
 * not Vercel/server timezone.
 */
function getLocalHourLondon() {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
    return Number.isFinite(hour) ? hour : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

function getLocalTimeGreeting() {
  const h = getLocalHourLondon();
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

const PROFANITY = ["fuck", "fuck off", "shit", "twat", "cunt", "bitch", "crap", "wanker", "dick"];

function containsProfanity(s: string) {
  const t = normalise(s);
  return PROFANITY.some((w) => t.includes(w));
}

function looksLikeGreetingOrSmallTalk(s: string) {
  const t = normalise(s);

  if (
    t === "hello" ||
    t === "hi" ||
    t === "hey" ||
    t.startsWith("hello ") ||
    t.startsWith("hi ") ||
    t.startsWith("hey ")
  )
    return true;

  if (t.includes("good morning") || t.includes("good afternoon") || t.includes("good evening")) return true;

  if (t.includes("how are you") || t.includes("how r you") || t.includes("how are u")) return true;

  if (t.includes("what is the time") || t === "what time is it" || t.startsWith("what time")) return true;

  if (t.includes("tell me a joke") || t === "joke" || t.includes("make me laugh")) return true;

  return false;
}

function hasSubstantiveDebtContent(s: string) {
  const t = normalise(s);

  const debtish =
    /debt|debts|repayment|repayments|loan|loans|credit|card|cards|overdraft|arrears|missed|behind|bailiff|ccj|interest|minimum|defaults|consolidat/i.test(
      t
    );

  const hasMoneyOrNumbers = /£\s*\d+|\b\d{2,}\b/.test(s);

  return debtish || hasMoneyOrNumbers;
}

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

  if (
    t === "hello" ||
    t === "hi" ||
    t === "hey" ||
    t.startsWith("hello ") ||
    t.startsWith("hi ") ||
    t.startsWith("hey ")
  ) {
    return `${greeting}!`;
  }

  return null;
}

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
    "no worries",
    "got it",
    "fine",
    "great",
  ]);
  return acks.has(t);
}

function isQuestionLike(userText: string) {
  const raw = (userText || "").trim();
  if (!raw) return false;
  if (raw.includes("?")) return true;

  const t = normalise(raw);

  if (
    t.startsWith("can you") ||
    t.startsWith("could you") ||
    t.startsWith("do you") ||
    t.startsWith("should i") ||
    t.startsWith("what ") ||
    t.startsWith("why ") ||
    t.startsWith("how ") ||
    t.startsWith("when ") ||
    t.startsWith("where ") ||
    t.startsWith("is ") ||
    t.startsWith("are ") ||
    t.startsWith("will ") ||
    t.startsWith("does ")
  )
    return true;

  if (t.includes("can i ") || t.includes("do i ") || t.includes("should i ") || t.includes("am i ")) return true;

  return false;
}

function extractName(userText: string): { ok: boolean; name?: string; reason?: string } {
  const raw = userText.trim();

  if (!raw) return { ok: false, reason: "empty" };
  if (containsProfanity(raw)) return { ok: false, reason: "profanity" };

  const t = stripPunctuation(raw);

  const m1 = t.match(/\bmy name is\s+(.+)$/i);
  if (m1?.[1]) {
    const cand = titleCaseName(m1[1]);
    const simple = normalise(cand);
    if (!cand) return { ok: false, reason: "empty" };
    if (NAME_BLOCKLIST.has(simple)) return { ok: false, reason: "block" };
    return { ok: true, name: cand };
  }

  const m2 = t.match(/\bi am\s+(.+)$/i) || t.match(/\bi'?m\s+(.+)$/i) || t.match(/\bim\s+(.+)$/i);
  if (m2?.[1]) {
    const cand = titleCaseName(m2[1]);
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
    const q = normalise((f as any).q || "");
    if (!q) continue;

    let score = 0;
    if (t === q) score += 100;
    if (t.includes(q) || q.includes(t)) score += 60;

    const tags = ((f as any).tags || (f as any).keywords || []).map(normalise);
    for (const tag of tags) {
      if (tag && t.includes(tag)) score += 10;
    }

    const tTokens = new Set(t.split(" ").filter((x) => x.length >= 3));
    const qTokens = q.split(" ").filter((x) => x.length >= 3);
    let overlap = 0;
    for (const tok of qTokens) if (tTokens.has(tok)) overlap++;
    score += overlap;

    if (!best || score > best.score) best = { score, a: (f as any).a };
  }

  if (best && best.score >= 18) return best.a;
  return null;
}

async function callOpenAI(args: {
  userText: string;
  history: string[];
  language: string;
  state: ChatState;
  scriptStepPrompt: string;
}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const { userText, history, language, state, scriptStepPrompt } = args;

  const isComplex =
    userText.length > 140 ||
    /bankrupt|iva|dmp|dro|court|bailiff|enforcement|council tax|ccj|credit rating|interest/i.test(userText);

  const model = isComplex ? "gpt-4o" : "gpt-4o-mini";

  const system = `
You are a professional, friendly UK debt-advice assistant.
Goals:
- Sound human, calm, empathetic, and professional (avoid em dashes).
- Always respond to what the user just said (acknowledge it properly).
- If the user asks a side question, answer briefly, then return to the current step naturally.
- Follow the current script step without looping.
- Never show internal markers or tags.
- Keep language: ${language}.
Current known name: ${state.name || "unknown"}.
Current step prompt: ${scriptStepPrompt}
`.trim();

  const messages: { role: Role; content: string }[] = [
    { role: "assistant", content: system },
    ...history.slice(-10).map((h) => ({ role: "user" as const, content: h })),
    { role: "user", content: userText },
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.4,
    }),
  });

  if (!r.ok) return null;
  const j = await r.json();
  const reply = j?.choices?.[0]?.message?.content;
  if (typeof reply === "string" && reply.trim()) return reply.trim();
  return null;
}

function promptKey(step: number, prompt: string) {
  return `${step}:${normalise(prompt).slice(0, 120)}`;
}

function getStep(script: ScriptDef, state: ChatState) {
  if (!script?.steps?.length) return null;
  if (script.steps[state.step]) return script.steps[state.step];
  const byId = script.steps.find((s) => s.id === state.step);
  return byId || script.steps[0];
}

function safeAskNameVariant(tries: number) {
  if (tries <= 0) return "Can you let me know who I’m speaking with? A first name is perfect.";
  if (tries === 1) return "Sorry, what first name would you like me to use?";
  if (tries === 2) return "No worries. Just pop a first name and we’ll carry on.";
  return "That’s fine. I’ll just call you ‘there’ for now. What’s the main thing you want help with today?";
}

const FALLBACK_STEP0 = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
const FALLBACK_STEP1 = "What would you say is the main issue with the debts at the moment?";

function stripLeadingIntroFromPrompt(prompt: string) {
  const p = (prompt || "").trim();
  const lowered = normalise(p);
  if (lowered.startsWith("hello! my name’s mark.")) return p.replace(/^Hello!\s+My name’s Mark\.\s*/i, "");
  if (lowered.startsWith("hello! my name's mark.")) return p.replace(/^Hello!\s+My name'?s Mark\.\s*/i, "");
  return p;
}

function step0SmalltalkVariant(cleanPrompt: string) {
  const canon = "what prompted you to seek help with your debts today?";
  if (normalise(cleanPrompt) === canon) {
    return "How can I help you with your debts today?";
  }
  return cleanPrompt;
}

function startsWithThanks(p: string) {
  const t = normalise(p);
  return t.startsWith("thanks") || t.startsWith("thank you");
}

/**
 * A short professional acknowledgement based on what the user said.
 */
function buildAcknowledgement(userText: string, state: ChatState) {
  const t = normalise(userText);
  const name = state.name && state.name !== "there" ? state.name : null;

  if (!t) return null;

  // ✅ FIX: acknowledge BOTH when both are present
  const mentionsCards = t.includes("credit card") || t.includes("credit cards") || t.includes("cards");
  const mentionsLoans = t.includes("loan") || t.includes("loans");

  if (mentionsCards && mentionsLoans) {
    return name
      ? `Thanks, ${name} — I understand it’s mainly your credit cards and loans.`
      : `Thanks — I understand it’s mainly your credit cards and loans.`;
  }

  if (t.includes("consolidat")) {
    return name
      ? `Thanks, ${name} — I understand you’re looking to consolidate your debts.`
      : `Thanks — I understand you’re looking to consolidate your debts.`;
  }

  if (mentionsCards) {
    return name ? `Thanks, ${name} — I understand it’s mainly your credit cards.` : `Thanks — I understand it’s mainly your credit cards.`;
  }

  if (mentionsLoans) {
    return name ? `Thanks, ${name} — I understand it’s mainly loans.` : `Thanks — I understand it’s mainly loans.`;
  }

  if (t.includes("high interest")) {
    return name
      ? `Thanks, ${name} — high interest can make things feel relentless.`
      : `Thanks — high interest can make things feel relentless.`;
  }

  if (t.length <= 18) {
    return name ? `Thanks, ${name} — understood.` : `Thanks — understood.`;
  }

  return name ? `Thanks for explaining that, ${name}.` : `Thanks for explaining that.`;
}

function joinAckAndPrompt(state: ChatState, userText: string | null, prompt: string) {
  const p = (prompt || "").trim();
  if (!p) return buildAcknowledgement(userText || "", state) || "Thanks.";

  if (startsWithThanks(p)) return p;

  const ack = userText ? buildAcknowledgement(userText, state) : null;
  if (ack) return `${ack} ${p}`.trim();

  return `Thanks. ${p}`.trim();
}

function shouldAdvanceFree(userText: string) {
  const t = userText.trim();
  if (!t) return false;
  if (isAckOnly(t)) return false;
  const tn = normalise(t);
  if (tn === "yes" || tn === "no" || tn === "yep" || tn === "nah") return false;
  return t.length >= 3;
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
  const language = (body.language || "English").toString();

  const history: string[] = Array.isArray(body.history)
    ? typeof (body.history as any)[0] === "string"
      ? (body.history as string[])
      : (body.history as any[]).map((m) => String(m?.content || "")).filter(Boolean)
    : [];

  const scriptPath = path.join(process.cwd(), "utils", "full_script_logic.json");
  const faqPath = path.join(process.cwd(), "utils", "faqs.json");
  const script = readJsonSafe<ScriptDef>(scriptPath, { steps: [] });
  const faqRaw = readJsonSafe<any>(faqPath, []);
  const faqs: FaqItem[] = Array.isArray(faqRaw) ? faqRaw : Array.isArray(faqRaw?.faqs) ? faqRaw.faqs : [];

  const state: ChatState = {
    step: 0,
    askedNameTries: 0,
    name: null,
    ...body.state,
  };

  if (normalise(userText) === "reset") {
    const first = script.steps?.[0]?.prompt || FALLBACK_STEP0;
    const s: ChatState = {
      step: 0,
      askedNameTries: 0,
      name: null,
      lastPromptKey: undefined,
      lastStepPrompted: undefined,
      lastFreeAnswer: null,
    };
    return res.status(200).json({ reply: first, state: s });
  }

  const currentStepDef = getStep(script, state);
  const currentPromptFull = currentStepDef?.prompt || (state.step === 1 ? FALLBACK_STEP1 : FALLBACK_STEP0);
  const currentPromptClean = stripLeadingIntroFromPrompt(currentPromptFull) || currentPromptFull;

  if (isAckOnly(userText)) {
    const key = promptKey(state.step, currentPromptFull);
    return res.status(200).json({
      reply: currentPromptFull,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  if (looksLikeGreetingOrSmallTalk(userText) && !hasSubstantiveDebtContent(userText)) {
    const st = smallTalkReply(userText);

    let follow = currentPromptClean;
    if (state.step === 0) follow = step0SmalltalkVariant(follow);

    const reply = st ? `${st}\n\n${follow}` : follow;

    const key = promptKey(state.step, follow);
    if (state.lastPromptKey === key) {
      const alt =
        state.step === 0
          ? "When you’re ready, tell me what’s prompted you to reach out about your debts."
          : "When you’re ready, we can carry on from where we left off.";
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

  if (isQuestionLike(userText)) {
    const faqAnswer = bestFaqMatch(userText, faqs);
    if (faqAnswer) {
      const follow = currentPromptClean || currentPromptFull;
      const reply = `${faqAnswer}\n\n${follow}`;
      const key = promptKey(state.step, follow);
      return res.status(200).json({
        reply,
        state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
      });
    }
  }

  const stepDef = getStep(script, state);
  const expects = stepDef?.expects || "free";

  if (expects === "name") {
    const tries = state.askedNameTries || 0;
    const nameParse = extractName(userText);

    if (nameParse.ok && nameParse.name) {
      const name = nameParse.name;
      const isSameAsMark = normalise(name) === "mark";

      const greet = isSameAsMark ? `Nice to meet you, Mark — nice to meet a fellow Mark.` : `Nice to meet you, ${name}.`;

      const nextState: ChatState = {
        ...state,
        name,
        askedNameTries: 0,
        step: state.step + 1,
      };

      const nextStepDef = getStep(script, nextState);
      const nextPrompt = nextStepDef?.prompt || FALLBACK_STEP1;

      return res.status(200).json({
        reply: `${greet} ${stripLeadingIntroFromPrompt(nextPrompt) || nextPrompt}`,
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
        step: state.step + 1,
      };
      const nextStepDef = getStep(script, nextState);
      const nextPrompt = nextStepDef?.prompt || FALLBACK_STEP1;
      return res.status(200).json({
        reply: `No problem. ${stripLeadingIntroFromPrompt(nextPrompt) || nextPrompt}`,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
      });
    }

    const ask = safeAskNameVariant(nextTries);
    return res.status(200).json({
      reply: ask,
      state: { ...state, askedNameTries: nextTries, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
    });
  }

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

    nextState.step = state.step + 1;
    const nextStepDef = getStep(script, nextState);
    const nextPrompt = nextStepDef?.prompt || "Is there anything urgent like bailiff action or missed priority bills?";

    return res.status(200).json({
      reply: joinAckAndPrompt(nextState, userText, nextPrompt),
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "concern") {
    const t = userText.trim();
    if (t.length < 3) {
      const prompt = stepDef?.prompt || FALLBACK_STEP1;
      return res.status(200).json({
        reply: prompt,
        state: { ...state, lastPromptKey: promptKey(state.step, prompt), lastStepPrompted: state.step },
      });
    }

    const nextState: ChatState = { ...state, concern: t, step: state.step + 1 };
    const nextStepDef = getStep(script, nextState);
    const nextPrompt = nextStepDef?.prompt || "Roughly how much do you pay towards your debts each month?";

    const ack = buildAcknowledgement(userText, nextState) || "Thanks for explaining that.";
    const combined = startsWithThanks(nextPrompt)
      ? `${ack} ${stripLeadingIntroFromPrompt(nextPrompt) || nextPrompt}`
      : `${ack} ${nextPrompt}`;

    return res.status(200).json({
      reply: combined.trim(),
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "free") {
    const currentPrompt = stepDef?.prompt || currentPromptFull;

    if (shouldAdvanceFree(userText)) {
      const nextState: ChatState = {
        ...state,
        lastFreeAnswer: userText,
        concern: state.step === 0 && !state.concern ? userText : state.concern ?? null,
        step: state.step + 1,
      };

      const nextStepDef = getStep(script, nextState);
      const nextPrompt = nextStepDef?.prompt || FALLBACK_STEP1;

      return res.status(200).json({
        reply: joinAckAndPrompt(nextState, userText, nextPrompt),
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
      });
    }

    const key = promptKey(state.step, currentPrompt);
    if (state.lastPromptKey === key) {
      const alt =
        state.step === 0
          ? "When you’re ready, tell me what’s prompted you to reach out about your debts."
          : "When you’re ready, please answer the question above and we’ll continue.";
      return res.status(200).json({
        reply: alt,
        state: { ...state, lastPromptKey: promptKey(state.step, alt), lastStepPrompted: state.step },
      });
    }

    return res.status(200).json({
      reply: currentPrompt,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  const scriptPrompt = stepDef?.prompt || currentPromptFull;
  const openAiReply = await callOpenAI({
    userText,
    history,
    language,
    state,
    scriptStepPrompt: scriptPrompt,
  });

  if (openAiReply) {
    return res.status(200).json({
      reply: openAiReply,
      state: { ...state },
    });
  }

  const follow = scriptPrompt;
  const combined = joinAckAndPrompt(state, userText, follow);

  const key = promptKey(state.step, follow);
  if (state.lastPromptKey === key) {
    const alt =
      state.step === 0
        ? "When you’re ready, tell me what’s prompted you to reach out about your debts."
        : "When you’re ready, we can carry on from where we left off.";
    return res.status(200).json({
      reply: alt,
      state: { ...state, lastPromptKey: promptKey(state.step, alt), lastStepPrompted: state.step },
    });
  }

  return res.status(200).json({
    reply: combined,
    state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
  });
}
