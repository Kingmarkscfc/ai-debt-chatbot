import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

type Role = "user" | "assistant";

type StepDef = {
  id: number;
  name: string;
  expects: string; // "name" | "concern" | etc
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

/** Obvious profanity we should refuse as a name (keep this short + safe). */
const PROFANITY = [
  "fuck",
  "fuck off",
  "shit",
  "twat",
  "cunt",
  "bitch",
  "crap",
  "wanker",
  "dick",
];

function containsProfanity(s: string) {
  const t = normalise(s);
  return PROFANITY.some((w) => t.includes(w));
}

function looksLikeGreetingOrSmallTalk(s: string) {
  const t = normalise(s);
  // greetings
  if (
    t === "hello" ||
    t === "hi" ||
    t === "hey" ||
    t.startsWith("hello ") ||
    t.startsWith("hi ") ||
    t.startsWith("hey ")
  )
    return true;

  // "good morning/afternoon/evening"
  if (t.includes("good morning") || t.includes("good afternoon") || t.includes("good evening"))
    return true;

  // how are you
  if (t.includes("how are you") || t.includes("how r you") || t.includes("how are u"))
    return true;

  // time question
  if (t.includes("what is the time") || t === "what time is it" || t.startsWith("what time"))
    return true;

  // joke request
  if (t.includes("tell me a joke") || t === "joke" || t.includes("make me laugh")) return true;

  return false;
}

function smallTalkReply(userText: string) {
  const t = normalise(userText);
  const greeting = getLocalTimeGreeting();

  // what time is it
  if (t.includes("what is the time") || t === "what time is it" || t.startsWith("what time")) {
    return `It’s ${nowTimeStr()} right now.`;
  }

  // joke
  if (t.includes("tell me a joke") || t === "joke" || t.includes("make me laugh")) {
    return `Okay — quick one: Why did the scarecrow get promoted? Because he was outstanding in his field.`;
  }

  // how are you / greetings
  if (t.includes("how are you") || t.includes("how r you") || t.includes("how are u")) {
    return `${greeting}! I’m doing well, thanks for asking. How are you feeling today?`;
  }

  if (t.includes("good morning") || t.includes("good afternoon") || t.includes("good evening")) {
    return `${greeting}! How are you doing today?`;
  }

  if (t === "hello" || t === "hi" || t === "hey" || t.startsWith("hello ") || t.startsWith("hi ") || t.startsWith("hey ")) {
    return `${greeting}! How are you doing today?`;
  }

  return null;
}

function extractName(userText: string): { ok: boolean; name?: string; reason?: string } {
  const raw = userText.trim();

  if (!raw) return { ok: false, reason: "empty" };
  if (containsProfanity(raw)) return { ok: false, reason: "profanity" };

  const t = stripPunctuation(raw);

  // Common explicit patterns
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

  // If user enters two words like "Mark Hughes" treat as name (unless it begins with a stopword)
  const tokens = t.split(" ").filter(Boolean);
  if (tokens.length >= 1 && tokens.length <= 3) {
    // If the first token is a blocklisted word (yes/so/and/hello etc), refuse
    const first = normalise(tokens[0]);
    if (NAME_BLOCKLIST.has(first)) return { ok: false, reason: "block" };

    // If they typed a whole sentence, don't treat it as a name
    // Heuristic: if > 3 tokens or contains debt keywords, it's not a name.
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
  // also allow "1000" if user writes "I pay 1000"
  const bare = [...cleaned.matchAll(/\b([0-9]{2,7})(?:\.[0-9]+)?\b/g)].map((m) => Number(m[1]));
  const all = nums.length ? nums : bare;

  if (all.length >= 2) return { paying: all[0], affordable: all[1] };
  if (all.length === 1) {
    // if phrase hints which one
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

    // direct contains gets high score
    let score = 0;
    if (t === q) score += 100;
    if (t.includes(q) || q.includes(t)) score += 60;

    // tag keyword hits
    const tags = (f.tags || []).map(normalise);
    for (const tag of tags) {
      if (tag && t.includes(tag)) score += 10;
    }

    // shared token overlap
    const tTokens = new Set(t.split(" ").filter((x) => x.length >= 3));
    const qTokens = q.split(" ").filter((x) => x.length >= 3);
    let overlap = 0;
    for (const tok of qTokens) if (tTokens.has(tok)) overlap++;
    score += overlap;

    if (!best || score > best.score) best = { score, a: f.a };
  }

  // threshold to avoid random firing
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
- If the user asks a side question (time/joke/how are you/etc), answer briefly, then return to the current step naturally.
- Follow the current script step without looping.
- Never show internal markers or tags.
- Keep language: ${language}.
Current known name: ${state.name || "unknown"}.
Current step prompt: ${scriptStepPrompt}
`;

  const messages: { role: Role; content: string }[] = [
    { role: "assistant", content: system.trim() },
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
      temperature: 0.5,
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

function nextScriptPrompt(script: ScriptDef, state: ChatState) {
  const stepDef = script.steps.find((s) => s.id === state.step) || script.steps[0];
  return stepDef;
}

function safeAskNameVariant(tries: number) {
  if (tries <= 0) return "Can you let me know who I’m speaking with? A first name is perfect.";
  if (tries === 1) return "Sorry, what first name would you like me to use?";
  if (tries === 2) return "No worries. Just pop a first name and we’ll carry on.";
  return "That’s fine. I’ll just call you ‘there’ for now. What’s the main thing you want help with today?";
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

  // history may come as strings or structured; we only need strings here
  const history: string[] = Array.isArray(body.history)
    ? typeof body.history[0] === "string"
      ? (body.history as string[])
      : (body.history as any[]).map((m) => String(m?.content || "")).filter(Boolean)
    : [];

  // load script + faqs from repo
  const scriptPath = path.join(process.cwd(), "data", "full_script_logic.json");
  const faqPath = path.join(process.cwd(), "utils", "faqs.json");
  const script = readJsonSafe<ScriptDef>(scriptPath, { steps: [] });
  const faqRaw = readJsonSafe<any>(faqPath, []);
  const faqs: FaqItem[] = Array.isArray(faqRaw)
    ? faqRaw
    : Array.isArray(faqRaw?.faqs)
      ? faqRaw.faqs
      : [];

  // starting state
  const state: ChatState = {
    step: 0,
    askedNameTries: 0,
    name: null,
    ...body.state,
  };

  // RESET (test tool)
  if (normalise(userText) === "reset") {
    const first = script.steps?.[0]?.prompt || "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
    const s: ChatState = { step: 0, askedNameTries: 0, name: null, lastPromptKey: undefined, lastStepPrompted: undefined };
    return res.status(200).json({ reply: first, state: s });
  }

  // 1) Small talk / quick questions: answer + return to current step (do not treat as slot-fill)
  if (looksLikeGreetingOrSmallTalk(userText)) {
    const st = smallTalkReply(userText);
    const stepDef = nextScriptPrompt(script, state);
    const follow = stepDef?.prompt || "Can you tell me a bit more so I can help?";
    const reply = st ? `${st}\n\n${follow}` : follow;

    // dedupe so we don't repeat the exact same follow-up forever
    const key = promptKey(state.step, follow);
    if (state.lastPromptKey === key) {
      // vary follow-up lightly
      const alt = state.step === 0
        ? "When you’re ready, tell me what prompted you to reach out about your debts today."
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

  // 2) FAQ handling (if user asks a question)
  const faqAnswer = bestFaqMatch(userText, faqs);
  if (faqAnswer) {
    const stepDef = nextScriptPrompt(script, state);
    const follow = stepDef?.prompt || "Can you tell me a bit more so I can help?";
    const reply = `${faqAnswer}\n\n${follow}`;

    const key = promptKey(state.step, follow);
    return res.status(200).json({
      reply,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  // 3) Script progression
  const stepDef = nextScriptPrompt(script, state);
  const expects = stepDef?.expects || "free";

  // NAME STEP (fix)
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
        step: state.step + 1,
      };

      const nextStepDef = nextScriptPrompt(script, nextState);
      const nextPrompt = nextStepDef?.prompt || "What’s the main concern with the debts at the moment?";

      return res.status(200).json({
        reply: `${greet} ${nextPrompt}`,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
        displayName: name,
      });
    }

    // invalid name -> ask again, but never endlessly, and never using dinosaur wording
    const nextTries = tries + 1;

    if (nextTries >= 4) {
      // stop looping: accept a neutral placeholder and move on
      const nextState: ChatState = {
        ...state,
        name: "there",
        askedNameTries: nextTries,
        step: state.step + 1,
      };
      const nextStepDef = nextScriptPrompt(script, nextState);
      const nextPrompt = nextStepDef?.prompt || "What’s the main concern with the debts at the moment?";
      return res.status(200).json({
        reply: `No problem. ${nextPrompt}`,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
      });
    }

    const ask = safeAskNameVariant(nextTries);
    return res.status(200).json({
      reply: ask,
      state: { ...state, askedNameTries: nextTries, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
    });
  }

  // Example: amounts step (handles “I pay 1000 and can afford 200”)
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

    // advance
    nextState.step = state.step + 1;
    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextPrompt = nextStepDef?.prompt || "Is there anything urgent like bailiff action or missed priority bills?";
    const name = nextState.name && nextState.name !== "there" ? nextState.name : null;

    const ack = name
      ? `Thanks, ${name}.`
      : "Thanks.";

    return res.status(200).json({
      reply: `${ack} ${nextPrompt}`,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  // If this step expects "concern" and user gives a real concern, store + advance
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

    const nextState: ChatState = { ...state, concern: t, step: state.step + 1 };
    const name = nextState.name && nextState.name !== "there" ? nextState.name : null;

    const empathy = name
      ? `Thanks for sharing that, ${name}. That can feel really heavy, but we’ll take it step by step.`
      : `Thanks for sharing that. That can feel really heavy, but we’ll take it step by step.`;

    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextPrompt = nextStepDef?.prompt || "Roughly how much do you pay towards your debts each month?";

    return res.status(200).json({
      reply: `${empathy} ${nextPrompt}`,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  // 4) Free-thinking fallback (OpenAI if available)
  const scriptPrompt = stepDef?.prompt || "Can you tell me a bit more so I can help?";
  const openAiReply = await callOpenAI({
    userText,
    history,
    language,
    state,
    scriptStepPrompt: scriptPrompt,
  });

  if (openAiReply) {
    // still dedupe the current step prompt, but we trust AI to respond humanly
    return res.status(200).json({
      reply: openAiReply,
      state: { ...state },
    });
  }

  // 5) Last-resort deterministic reply: acknowledge + return to step prompt
  const name = state.name && state.name !== "there" ? state.name : null;
  const ack = name ? `Thanks, ${name}.` : "Thanks.";
  const follow = scriptPrompt;

  // no repeat exact same follow forever
  const key = promptKey(state.step, follow);
  if (state.lastPromptKey === key) {
    const alt = state.step === 0
      ? "When you’re ready, tell me what prompted you to reach out about your debts today."
      : "When you’re ready, we can carry on from where we left off.";
    return res.status(200).json({
      reply: `${ack} ${alt}`,
      state: { ...state, lastPromptKey: promptKey(state.step, alt), lastStepPrompted: state.step },
    });
  }

  return res.status(200).json({
    reply: `${ack} ${follow}`,
    state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
  });
}
