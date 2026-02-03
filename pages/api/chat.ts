import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

type Role = "user" | "assistant";

type StepDef = {
  id?: number;
  name?: string;
  expects?: string; // "name" | "concern" | "issue" | "profile" | "total_debt" | "paying" | "affordable" | "debts_list" | etc
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
  // IMPORTANT: step is the STEP INDEX (0..n-1), not StepDef.id
  step: number;
  name?: string | null;
  concern?: string | null; // what prompted them / overall concern
  issue?: string | null; // main issue with the debts
  totalDebt?: number | null;
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

  // UI hints for the frontend (safe: ignored if not implemented)
  uiTrigger?: string; // e.g. "OPEN_CLIENT_PORTAL" / "OPEN_FACT_FIND_POPUP"
  popup?: string; // e.g. "FACT_FIND_CLIENT_INFORMATION" / "DEBT_SLIDER" / "AFFORDABLE_SLIDER"
  portalTab?: string; // e.g. "TAB_2_OUTSTANDING_DEBTS"
  openPortal?: boolean; // legacy flag used by some UIs
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

/**
 * Expanded profanity list (used only for name parsing / abusive slurs as "names").
 * This does NOT block normal debt messages; it just stops "names" like swearwords.
 *
 * NOTE: This list is built from your Naughty words list docx.
 */
const PROFANITY = [
  "anal",
  "anal sex",
  "anus",
  "arse",
  "arsehole",
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "bloody",
  "blowjob",
  "bollocks",
  "boner",
  "boob",
  "boobs",
  "bugger",
  "bullshit",
  "buttplug",
  "clit",
  "cock",
  "cocksucker",
  "coon",
  "crap",
  "cum",
  "cunt",
  "dick",
  "dildo",
  "dyke",
  "fag",
  "faggot",
  "felch",
  "fuck",
  "fucker",
  "fucking",
  "handjob",
  "homo",
  "jerk off",
  "jizz",
  "kike",
  "masterbate",
  "masturbate",
  "motherfucker",
  "nigga",
  "nigger",
  "piss",
  "porn",
  "prick",
  "pussy",
  "rape",
  "retard",
  "rimjob",
  "shit",
  "slut",
  "spastic",
  "tits",
  "twat",
  "wank",
  "wanker",
  "whore",
];

function containsProfanity(s: string) {
  const t = normalise(s);
  return PROFANITY.some((w) => w && t.includes(normalise(w)));
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
    "no worries",
    "got it",
    "fine",
    "great",
  ]);
  return acks.has(t);
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

  // courtesy / niceties that should be acknowledged
  if (t.includes("nice to meet you") || t.includes("pleased to meet you") || t.includes("good to meet you")) return true;

  return false;
}

function detectCourtesy(userText: string): string | null {
  const t = normalise(userText);
  if (
    t.includes("nice to meet you") ||
    t.includes("pleased to meet you") ||
    t.includes("good to meet you") ||
    t.includes("lovely to meet you")
  ) {
    return "Nice to meet you too.";
  }
  return null;
}

/**
 * IMPORTANT: small talk reply should NOT ask the user questions.
 * We answer briefly, then the handler appends the current scripted prompt.
 */
function smallTalkReply(userText: string) {
  const t = normalise(userText);
  const greeting = getLocalTimeGreeting();
  const courtesy = detectCourtesy(userText);

  if (t.includes("what is the time") || t === "what time is it" || t.startsWith("what time")) {
    const base = `It’s ${nowTimeStr()} right now.`;
    return courtesy ? `${courtesy} ${base}` : base;
  }

  if (t.includes("tell me a joke") || t === "joke" || t.includes("make me laugh")) {
    const base = `Okay — quick one: Why did the scarecrow get promoted? Because he was outstanding in his field.`;
    return courtesy ? `${courtesy} ${base}` : base;
  }

  if (t.includes("how are you") || t.includes("how r you") || t.includes("how are u")) {
    const base = `${greeting}! I’m doing well, thanks for asking.`;
    return courtesy ? `${base} ${courtesy}` : base;
  }

  if (t.includes("good morning") || t.includes("good afternoon") || t.includes("good evening")) {
    const base = `${greeting}!`;
    return courtesy ? `${base} ${courtesy}` : base;
  }

  if (
    t === "hello" ||
    t === "hi" ||
    t === "hey" ||
    t.startsWith("hello ") ||
    t.startsWith("hi ") ||
    t.startsWith("hey ")
  ) {
    const base = `${greeting}!`;
    return courtesy ? `${base} ${courtesy}` : base;
  }

  if (courtesy) return `${greeting}! ${courtesy}`;

  return null;
}

/** Extra debt / finance terms (from your "likely debt terms" list docx) */
const DEBT_TERMS_EXTRA = [
  "Accounts",
  "Accounts payable",
  "Accounts receivables",
  "Administration order",
  "Administrator",
  "Advance billing",
  "Adverse credit history",
  "Aged debt report",
  "Arrears",
  "Assignment",
  "Audit",
  "Bacs",
  "Bad debt",
  "Bad debt relief",
  "Bailiffs",
  "Bailiff’s certificate",
  "Balance sheet",
  "Bankruptcy",
  "Business health check",
  "Business restructuring or turnaround",
  "CCJ",
  "CCJ’s",
  "Cash flow",
  "Cash flow forecast",
  "Charging order",
  "Collection agency",
  "Collections",
  "Company voluntary arrangement (CVA)",
  "Consolidation loan",
  "Consumer credit",
  "County Court Judgment",
  "Credit agreement",
  "Credit card debt",
  "Credit limit",
  "Credit rating",
  "Credit report",
  "Credit score",
  "Creditor",
  "Creditors",
  "Debt",
  "Debt adviser",
  "Debt advice",
  "Debt management plan (DMP)",
  "Debt relief order (DRO)",
  "Debt settlement",
  "Debt write off",
  "Default",
  "Debt collector",
  "Direct debit",
  "Doorstep collector",
  "Enforcement",
  "Equity",
  "Financial statement",
  "Garnishment",
  "High court enforcement officer",
  "HMRC debt",
  "Hire purchase",
  "Insolvency",
  "IVA",
  "Individual voluntary arrangement (IVA)",
  "Interest",
  "Interest rate",
  "Lien",
  "Loan",
  "Loans",
  "Mortgage arrears",
  "Overdraft",
  "Payment plan",
  "PCN",
  "Penalty charge notice",
  "Priority debts",
  "Rent arrears",
  "Secured debt",
  "Unsecured debt",
  "Utility arrears",
  "Warrant of control",
  // NOTE: keep going in your real file if you extend the list further later.
];

function hasExtraDebtTerm(userText: string) {
  const raw = userText || "";
  const t = ` ${normalise(raw)} `;
  for (const term of DEBT_TERMS_EXTRA) {
    const nt = normalise(term);
    if (!nt) continue;

    // word-ish boundary to reduce false hits on short terms
    if (nt.length <= 3) {
      const re = new RegExp(`\\b${nt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(raw)) return true;
      continue;
    }

    if (t.includes(` ${nt} `) || t.includes(nt)) return true;
  }
  return false;
}

function hasSubstantiveDebtContent(userText: string) {
  const t = normalise(userText);

  const debtish =
    /\b(debt|debts|loan|loans|credit|card|cards|overdraft|catalogue|catalog|klarna|ccj|ccjs|county court|bailiff|bailiffs|enforcement|parking|pcn|parking fine|parking fines|council tax|rent|mortgage|arrears|utility|energy|gas|electric|water|fine|fines|magistrates|attachment of earnings|charging order)\b/i.test(
      t
    );

  return debtish || hasExtraDebtTerm(userText);
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

    const debtish = hasSubstantiveDebtContent(t);
    if (!debtish) {
      const cand = titleCaseName(tokens.join(" "));
      const simple = normalise(cand);
      if (cand && !NAME_BLOCKLIST.has(simple)) return { ok: true, name: cand };
    }
  }

  return { ok: false, reason: "no_match" };
}

function extractFirstNumber(text: string): number | null {
  const cleaned = (text || "").replace(/,/g, "");
  const m1 = cleaned.match(/£\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m1?.[1]) return Number(m1[1]);
  const m2 = cleaned.match(/\b([0-9]{1,7})(?:\.[0-9]+)?\b/);
  if (m2?.[1]) return Number(m2[1]);
  return null;
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
- Follow the current script step without looping or asking the same question again.
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
      temperature: 0.35,
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

/**
 * IMPORTANT: We treat state.step as an INDEX into script.steps.
 * This avoids loops caused by script "id" fields not matching our step counter.
 */
function nextScriptPrompt(script: ScriptDef, state: ChatState) {
  if (!script?.steps?.length) return null;
  return script.steps[state.step] || script.steps[script.steps.length - 1] || script.steps[0];
}

function safeAskNameVariant(tries: number) {
  if (tries <= 0) return "Please can you tell me your first name?";
  if (tries === 1) return "Sorry — what first name would you like me to use?";
  if (tries === 2) return "No worries. Just pop a first name and we’ll carry on.";
  return "That’s fine. I’ll just call you ‘there’ for now. What’s made you reach out about your debts today?";
}

const FALLBACK_STEP0 = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";

function stripLeadingIntroFromPrompt(prompt: string) {
  const p = (prompt || "").trim();
  const lowered = normalise(p);
  if (lowered.startsWith("hello! my name’s mark.")) return p.replace(/^Hello!\s+My name’s Mark\.\s*/i, "");
  if (lowered.startsWith("hello! my name's mark.")) return p.replace(/^Hello!\s+My name'?s Mark\.\s*/i, "");
  return p;
}

function substituteName(prompt: string, state: ChatState) {
  const name = state.name && state.name !== "there" ? state.name : "";
  return (prompt || "").replace(/\{name\}/gi, name || "there");
}

function step0Variant(cleanPrompt: string) {
  const canon = "what prompted you to seek help with your debts today?";
  if (normalise(cleanPrompt) === canon) {
    const variants = [
      "What’s led you to reach out for help with your debts today?",
      "What’s made you get in touch about your debts today?",
      "What’s been happening that made you reach out about your debts today?",
    ];
    return variants[Math.floor(Math.random() * variants.length)];
  }
  return cleanPrompt;
}

function inferExpectFromPrompt(prompt: string) {
  const p = normalise(prompt);
  if (p.includes("who i’m speaking with") || p.includes("who i'm speaking with") || p.includes("your name")) return "name";
  if (p.includes("what prompted") || p.includes("reach out") || p.includes("get in touch")) return "concern";
  if (p.includes("main concern") || p.includes("main issue") || p.includes("biggest issue")) return "issue";
  if (p.includes("complete the fact find")) return "profile";
  if (p.includes("roughly how much debt")) return "total_debt";
  if (p.includes("roughly how much are you paying")) return "paying";
  if (p.includes("how much do you feel you can afford")) return "affordable";
  if (p.includes("add each outstanding debt")) return "debts_list";
  return "free";
}

function buildAcknowledgement(userText: string, state: ChatState) {
  const courtesy = detectCourtesy(userText);
  const name = state.name && state.name !== "there" ? state.name : null;

  if (hasSubstantiveDebtContent(userText)) {
    const base = name ? `Thanks, ${name} — understood.` : "Thanks — understood.";
    return courtesy ? `${courtesy} ${base}` : base;
  }

  if (courtesy) return courtesy;

  return name ? `Thanks, ${name}.` : "Thanks.";
}

function joinAckAndPrompt(ack: string, prompt: string) {
  const a = (ack || "").trim();
  const p = (prompt || "").trim();
  if (!a) return p;
  if (!p) return a;

  const na = normalise(a);
  const np = normalise(p);

  if (na.startsWith("thanks") && np.startsWith("thanks")) return p;
  if (na === np) return p;

  return `${a} ${p}`;
}

function parseUiDirectives(prompt: string): { clean: string; uiTrigger?: string; popup?: string; portalTab?: string; openPortal?: boolean } {
  const raw = prompt || "";
  let clean = raw;

  const out: any = {};

  const trig = raw.match(/\[TRIGGER:\s*([^\]]+)\]/i);
  if (trig?.[1]) {
    const t = trig[1].trim();
    out.uiTrigger = t;
    if (t === "OPEN_CLIENT_PORTAL") out.openPortal = true;
  }

  const pop = raw.match(/\[POPUP:\s*([^\]]+)\]/i);
  if (pop?.[1]) out.popup = pop[1].trim();

  const tab = raw.match(/\[PORTAL:\s*([^\]]+)\]/i);
  if (tab?.[1]) out.portalTab = tab[1].trim();

  clean = clean.replace(/\[TRIGGER:[^\]]+\]/gi, "").replace(/\[POPUP:[^\]]+\]/gi, "").replace(/\[PORTAL:[^\]]+\]/gi, "");
  clean = clean.replace(/\s+/g, " ").trim();

  return { clean, ...out };
}

function semanticSame(a: string, b: string) {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
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
    concern: null,
    issue: null,
    totalDebt: null,
    ...body.state,
  };

  if (normalise(userText) === "reset") {
    const first = script.steps?.[0]?.prompt || FALLBACK_STEP0;
    const parsed = parseUiDirectives(first);
    return res.status(200).json({
      reply: parsed.clean || first,
      uiTrigger: parsed.uiTrigger,
      popup: parsed.popup,
      portalTab: parsed.portalTab,
      openPortal: parsed.openPortal,
      state: {
        step: 0,
        askedNameTries: 0,
        name: null,
        concern: null,
        issue: null,
        totalDebt: null,
        paying: null,
        affordable: null,
        lastPromptKey: undefined,
        lastStepPrompted: undefined,
      },
    });
  }

  const currentStepDef = nextScriptPrompt(script, state);
  const currentPromptFull = substituteName(currentStepDef?.prompt || FALLBACK_STEP0, state);
  const currentPromptClean0 = stripLeadingIntroFromPrompt(currentPromptFull) || currentPromptFull;
  const currentParsed = parseUiDirectives(currentPromptClean0);
  const currentPromptClean = currentParsed.clean || currentPromptClean0;

  if (isAckOnly(userText)) {
    const follow = state.step === 0 ? step0Variant(currentPromptClean) : currentPromptClean;
    return res.status(200).json({
      reply: follow,
      uiTrigger: currentParsed.uiTrigger,
      popup: currentParsed.popup,
      portalTab: currentParsed.portalTab,
      openPortal: currentParsed.openPortal,
      state: { ...state, lastPromptKey: promptKey(state.step, follow), lastStepPrompted: state.step },
    });
  }

  if (looksLikeGreetingOrSmallTalk(userText) && !hasSubstantiveDebtContent(userText)) {
    const st = smallTalkReply(userText);

    let follow = currentPromptClean;
    if (state.step === 0) follow = step0Variant(follow);

    const reply = st ? `${st}\n\n${follow}` : follow;
    const key = promptKey(state.step, follow);

    if (state.lastPromptKey === key) {
      const alt =
        state.step === 0
          ? "When you’re ready, tell me what’s brought you here about your debts today."
          : "When you’re ready, we can carry on from where we left off.";
      return res.status(200).json({
        reply: st ? `${st}\n\n${alt}` : alt,
        uiTrigger: currentParsed.uiTrigger,
        popup: currentParsed.popup,
        portalTab: currentParsed.portalTab,
        openPortal: currentParsed.openPortal,
        state: { ...state, lastPromptKey: promptKey(state.step, alt), lastStepPrompted: state.step },
      });
    }

    return res.status(200).json({
      reply,
      uiTrigger: currentParsed.uiTrigger,
      popup: currentParsed.popup,
      portalTab: currentParsed.portalTab,
      openPortal: currentParsed.openPortal,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  const faqAnswer = bestFaqMatch(userText, faqs);
  if (faqAnswer) {
    const follow = state.step === 0 ? step0Variant(currentPromptClean) : currentPromptClean;
    return res.status(200).json({
      reply: `${faqAnswer}\n\n${follow}`,
      uiTrigger: currentParsed.uiTrigger,
      popup: currentParsed.popup,
      portalTab: currentParsed.portalTab,
      openPortal: currentParsed.openPortal,
      state: { ...state, lastPromptKey: promptKey(state.step, follow), lastStepPrompted: state.step },
    });
  }

  const stepDef = nextScriptPrompt(script, state);
  const rawPrompt = substituteName(stepDef?.prompt || currentPromptFull, state);
  const parsed = parseUiDirectives(stripLeadingIntroFromPrompt(rawPrompt) || rawPrompt);
  const prompt = parsed.clean || (stripLeadingIntroFromPrompt(rawPrompt) || rawPrompt);

  const expects = normalise(stepDef?.expects || inferExpectFromPrompt(prompt) || "free");

  if (expects === "name") {
    const tries = state.askedNameTries || 0;
    const nameParse = extractName(userText);

    if (nameParse.ok && nameParse.name) {
      const name = nameParse.name;
      const isSameAsMark = normalise(name) === "mark";

      const greet = isSameAsMark
        ? "Nice to meet you, Mark — nice to meet a fellow Mark."
        : `Nice to meet you, ${name}.`;

      const nextState: ChatState = {
        ...state,
        name,
        askedNameTries: 0,
        step: Math.min(state.step + 1, Math.max(script.steps.length - 1, 0)),
      };

      const nextStepDef = nextScriptPrompt(script, nextState);
      const nextRaw = substituteName(nextStepDef?.prompt || "What prompted you to seek help with your debts today?", nextState);
      const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);

      let nextPrompt = nextParsed.clean || nextRaw;
      if (nextState.step === 0) nextPrompt = step0Variant(nextPrompt);

      return res.status(200).json({
        reply: `${greet} ${nextPrompt}`,
        uiTrigger: nextParsed.uiTrigger,
        popup: nextParsed.popup,
        portalTab: nextParsed.portalTab,
        openPortal: nextParsed.openPortal,
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
        step: Math.min(state.step + 1, Math.max(script.steps.length - 1, 0)),
      };
      const nextStepDef = nextScriptPrompt(script, nextState);
      const nextRaw = substituteName(nextStepDef?.prompt || "What prompted you to seek help with your debts today?", nextState);
      const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
      const nextPrompt = nextParsed.clean || nextRaw;

      return res.status(200).json({
        reply: `No problem. ${nextPrompt}`,
        uiTrigger: nextParsed.uiTrigger,
        popup: nextParsed.popup,
        portalTab: nextParsed.portalTab,
        openPortal: nextParsed.openPortal,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
      });
    }

    const ask = safeAskNameVariant(nextTries);
    return res.status(200).json({
      reply: ask,
      state: { ...state, askedNameTries: nextTries, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
    });
  }

  if (expects === "concern") {
    const t = userText.trim();
    if (t.length < 3) {
      const follow = step0Variant(currentPromptClean);
      return res.status(200).json({
        reply: follow,
        uiTrigger: parsed.uiTrigger,
        popup: parsed.popup,
        portalTab: parsed.portalTab,
        openPortal: parsed.openPortal,
        state: { ...state, lastPromptKey: promptKey(state.step, follow), lastStepPrompted: state.step },
      });
    }

    const nextState: ChatState = {
      ...state,
      concern: t,
      step: Math.min(state.step + 1, Math.max(script.steps.length - 1, 0)),
    };

    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextRaw = substituteName(nextStepDef?.prompt || "Please can you tell me your first name?", nextState);
    const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
    const nextPrompt = nextParsed.clean || nextRaw;

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextPrompt),
      uiTrigger: nextParsed.uiTrigger,
      popup: nextParsed.popup,
      portalTab: nextParsed.portalTab,
      openPortal: nextParsed.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "issue") {
    const t = userText.trim();
    if (t.length < 2) {
      return res.status(200).json({
        reply: prompt,
        uiTrigger: parsed.uiTrigger,
        popup: parsed.popup,
        portalTab: parsed.portalTab,
        openPortal: parsed.openPortal,
        state: { ...state, lastPromptKey: promptKey(state.step, prompt), lastStepPrompted: state.step },
      });
    }

    const already = state.concern || "";
    const isRepeat = already ? semanticSame(already, t) : false;

    const nextState: ChatState = {
      ...state,
      issue: t,
      step: Math.min(state.step + 1, Math.max(script.steps.length - 1, 0)),
    };

    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextRaw = substituteName(nextStepDef?.prompt || "Before we look at solutions, I just need to make you aware...", nextState);
    const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
    const nextPrompt = nextParsed.clean || nextRaw;

    let ack = buildAcknowledgement(userText, state);
    if (isRepeat) ack = "Thanks — understood.";

    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextPrompt),
      uiTrigger: nextParsed.uiTrigger,
      popup: nextParsed.popup,
      portalTab: nextParsed.portalTab,
      openPortal: nextParsed.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "profile") {
    const nextState: ChatState = {
      ...state,
      step: Math.min(state.step + 1, Math.max(script.steps.length - 1, 0)),
    };

    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextRaw = substituteName(nextStepDef?.prompt || "Thanks — roughly how much debt do you have outstanding?", nextState);
    const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
    const nextPrompt = nextParsed.clean || nextRaw;

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextPrompt),
      uiTrigger: nextParsed.uiTrigger,
      popup: nextParsed.popup,
      portalTab: nextParsed.portalTab,
      openPortal: nextParsed.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "total_debt") {
    const n = extractFirstNumber(userText);
    const nextState: ChatState = {
      ...state,
      totalDebt: typeof n === "number" && !Number.isNaN(n) ? n : state.totalDebt ?? null,
    };

    if (typeof nextState.totalDebt !== "number") {
      const ask = "Roughly how much debt do you have outstanding?";
      return res.status(200).json({
        reply: ask,
        state: { ...nextState, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
      });
    }

    nextState.step = Math.min(state.step + 1, Math.max(script.steps.length - 1, 0));
    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextRaw = substituteName(nextStepDef?.prompt || "Roughly how much are you paying per month to your creditors?", nextState);
    const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
    const nextPrompt = nextParsed.clean || nextRaw;

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextPrompt),
      uiTrigger: nextParsed.uiTrigger,
      popup: nextParsed.popup,
      portalTab: nextParsed.portalTab,
      openPortal: nextParsed.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "paying") {
    const n = extractFirstNumber(userText);
    const nextState: ChatState = {
      ...state,
      paying: typeof n === "number" && !Number.isNaN(n) ? n : state.paying ?? null,
    };

    if (typeof nextState.paying !== "number") {
      const ask = "Roughly how much are you paying per month to your creditors?";
      return res.status(200).json({
        reply: ask,
        state: { ...nextState, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
      });
    }

    nextState.step = Math.min(state.step + 1, Math.max(script.steps.length - 1, 0));
    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextRaw = substituteName(nextStepDef?.prompt || "If we could consolidate everything into one payment, how much could you afford monthly?", nextState);
    const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
    const nextPrompt = nextParsed.clean || nextRaw;

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextPrompt),
      uiTrigger: nextParsed.uiTrigger,
      popup: nextParsed.popup,
      portalTab: nextParsed.portalTab,
      openPortal: nextParsed.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "affordable") {
    const n = extractFirstNumber(userText);
    const nextState: ChatState = {
      ...state,
      affordable: typeof n === "number" && !Number.isNaN(n) ? n : state.affordable ?? null,
    };

    if (typeof nextState.affordable !== "number") {
      const ask = "If we could consolidate everything into one payment, how much do you feel you can afford monthly?";
      return res.status(200).json({
        reply: ask,
        state: { ...nextState, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
      });
    }

    nextState.step = Math.min(state.step + 1, Math.max(script.steps.length - 1, 0));
    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextRaw = substituteName(nextStepDef?.prompt || "The next step is your personal client portal.", nextState);
    const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
    const nextPrompt = nextParsed.clean || nextRaw;

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextPrompt),
      uiTrigger: nextParsed.uiTrigger,
      popup: nextParsed.popup,
      portalTab: nextParsed.portalTab,
      openPortal: nextParsed.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "debts_list") {
    const nextState: ChatState = {
      ...state,
      step: Math.min(state.step + 1, Math.max(script.steps.length - 1, 0)),
    };
    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextRaw = substituteName(nextStepDef?.prompt || "Thank you for letting us know about all of your outstanding debts.", nextState);
    const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
    const nextPrompt = nextParsed.clean || nextRaw;

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextPrompt),
      uiTrigger: nextParsed.uiTrigger,
      popup: nextParsed.popup,
      portalTab: nextParsed.portalTab,
      openPortal: nextParsed.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "free" && script.steps?.length) {
    const meaningful = userText.trim().length >= 2;
    if (meaningful) {
      const nextState: ChatState = {
        ...state,
        step: Math.min(state.step + 1, Math.max(script.steps.length - 1, 0)),
      };
      const nextStepDef = nextScriptPrompt(script, nextState);
      const nextRaw = substituteName(nextStepDef?.prompt || prompt, nextState);
      const nextParsed = parseUiDirectives(stripLeadingIntroFromPrompt(nextRaw) || nextRaw);
      const nextPrompt = nextParsed.clean || nextRaw;

      const ack = buildAcknowledgement(userText, state);
      return res.status(200).json({
        reply: joinAckAndPrompt(ack, nextPrompt),
        uiTrigger: nextParsed.uiTrigger,
        popup: nextParsed.popup,
        portalTab: nextParsed.portalTab,
        openPortal: nextParsed.openPortal,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
      });
    }
  }

  const scriptPromptForAI = prompt || currentPromptClean;
  const openAiReply = await callOpenAI({
    userText,
    history,
    language,
    state,
    scriptStepPrompt: scriptPromptForAI,
  });

  if (openAiReply) {
    return res.status(200).json({
      reply: openAiReply,
      state: { ...state },
    });
  }

  const ack = buildAcknowledgement(userText, state);
  const follow = state.step === 0 ? step0Variant(currentPromptClean) : currentPromptClean;

  const key = promptKey(state.step, follow);
  if (state.lastPromptKey === key) {
    const alt =
      state.step === 0
        ? "When you’re ready, tell me what’s brought you here about your debts today."
        : "When you’re ready, we can carry on from where we left off.";
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, alt),
      state: { ...state, lastPromptKey: promptKey(state.step, alt), lastStepPrompted: state.step },
    });
  }

  return res.status(200).json({
    reply: joinAckAndPrompt(ack, follow),
    state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
  });
}
