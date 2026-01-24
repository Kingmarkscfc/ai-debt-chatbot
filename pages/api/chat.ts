// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

/* ================= Supabase (best-effort telemetry) ================= */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

/* ================= Types ================= */
type Intent = "SCRIPT" | "QNA" | "SMALLTALK" | "CONTROL" | "OFFTOPIC";
type Sender = "user" | "assistant";

type TurnContext = {
  turn: number;
  stepId: number;
  haveName: boolean;
  name: string | null;
  mainConcern?: string | null;
  haveAmounts: boolean;
  monthlyPay: number | null;
  affordablePay: number | null;
  urgentFlag?: string | null;
  ackedMoneyHelper: boolean;
  portalOffered: boolean;
  portalOpened: boolean;
  flags: {
    askedNameAt?: number;
    askedAmountsAt?: number;
    askedConcernAt?: number;
    askedUrgentAt?: number;
    askedAckAt?: number;
    askedPortalAt?: number;
    smalltalkAt?: number; // NEW: avoid repeating smalltalk reply
  };
};

type Body = {
  sessionId: string;
  userMessage: string;
  history?: string[];
  language?: string;
};

/* ================= FAQ (short) ================= */
const FAQS: { q: RegExp; a: string }[] = [
  { q: /(credit (score|rating|file)|affect|impact)/i, a: "Changes to agreements (and some solutions) can affect your credit file for a while, but the goal is to stabilise things and move forward." },
  { q: /\bloan(s)?\b/i, a: "We don’t provide loans — the focus is reducing and clearing existing debt rather than adding credit." },
  { q: /\b(iva).*\b(dmp)|\bdmp.*\b(iva)/i, a: "An IVA can freeze interest/charges and may write off a portion; a DMP is flexible but usually repays the full balance over time." },
  { q: /\bhouse|home|property\b/i, a: "You keep paying rent/mortgage as normal. Your home isn’t taken in a DMP/IVA if payments are maintained." },
  { q: /\bcar|vehicle|car finance\b/i, a: "Most people keep their car. If repayments are very high, a more affordable vehicle might be discussed." },
  { q: /\bwhat (next|happens)\b/i, a: "You can upload documents in the portal, we review your case, then come back with tailored next steps." },
  { q: /\bmortgage\b/i, a: "You can apply anytime, but acceptance is generally more likely after a plan completes." },
  { q: /\bbenefit(s)?|universal credit|uc\b/i, a: "Normal benefit payments aren’t reduced by starting a plan. We’ll also check deductions that can be included." },
  { q: /\b(bailiff|enforcement)\b/i, a: "An IVA offers legal protection once approved. Before approval (or on a DMP), contact can continue — we’ll work on prevention and priorities." },
];

/* ================= Script (portal at step 5) ================= */
const STEPS = [
  { id: 0, key: "ASK_NAME", prompt: "Can you let me know who I’m speaking with?" },
  { id: 1, key: "ASK_CONCERN", prompt: "Just so I can point you in the right direction, what would you say your main concern is with the debts?" },
  { id: 2, key: "ASK_AMOUNTS", prompt: "Roughly how much do you pay towards all debts each month, and what would feel affordable for you?" },
  { id: 3, key: "ASK_URGENT", prompt: "Is anything urgent we should know about — for example bailiff/enforcement, court/default notices, or missed priority bills (rent, council tax, utilities)?" },
  { id: 4, key: "ACK", prompt: "Before we proceed: there’s no obligation to act on advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?" },
  { id: 5, key: "PORTAL", prompt: "I can open your secure Client Portal so you can add details, upload documents and check progress. Shall I open it now?" },
  { id: 6, key: "DOCS", prompt: "To help us assess the best solution, please upload: proof of ID, last 3 months’ bank statements, payslips (3 months or 12 weeks if weekly) if employed, last year’s tax return if self-employed, Universal Credit statements (12 months + latest) if applicable, car finance docs if applicable, and any creditor letters or statements." },
  { id: 7, key: "WRAP", prompt: "Our assessment team will review your case and come back with next steps. Is there anything else you’d like to ask before we wrap up?" },
] as const;

/* ================= Helpers ================= */
const BANNED = new Set(["fuck","shit","crap","twat","idiot"]);
const STOP_NAME_TOKENS = new Set([
  "hello","hi","hey","yo","hiya","morning","afternoon","evening",
  "good","goodmorning","goodafternoon","goodevening","greetings"
]);

function determineDaypartUK(): "morning" | "afternoon" | "evening" {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" });
    const parts = fmt.formatToParts(new Date());
    const hour = Number(parts.find(p => p.type === "hour")?.value || "12");
    if (hour < 12) return "morning";
    if (hour < 18) return "afternoon";
    return "evening";
  } catch {
    const hour = new Date().getUTCHours();
    if (hour < 12) return "morning";
    if (hour < 18) return "afternoon";
    return "evening";
  }
}

function nextPromptFor(stepId: number) {
  const step = STEPS.find(s => s.id === stepId);
  return step ? step.prompt : "Shall we continue?";
}

function empathetic(core: string, opts?: { cue?: "general" | "arrears" | "bailiff" | "stress" | "name" }) {
  const lead =
    opts?.cue === "bailiff" ? "Bailiff worries can feel intense. " :
    opts?.cue === "arrears" ? "Falling behind happens. " :
    opts?.cue === "name" ? "" :
    "I understand. ";
  return (lead + core).replace(/\s+/g, " ").trim();
}

function parseMoney(s: string): number[] {
  const out: number[] = [];
  (s.match(/£?\s*([0-9]{1,3}(?:,[0-9]{3})*|\d+)(?:\.\d{1,2})?/g) || []).forEach(m => {
    const n = m.replace(/[^0-9.]/g, "");
    const val = Number(n);
    if (!Number.isNaN(val)) out.push(val);
  });
  return out;
}

function canAsk(nowTurn: number, lastAskedAt?: number, windowTurns = 3) {
  if (lastAskedAt == null) return true;
  return nowTurn - lastAskedAt >= windowTurns;
}

function classifyIntent(user: string): Intent {
  const s = (user || "").trim().toLowerCase();

  if (/^(reset|restart|open portal|close portal|portal|help|menu)\b/.test(s)) return "CONTROL";

  // greet/smalltalk detector
  if (/\b(hi|hello|hey|hiya|good (morning|afternoon|evening)|how are you)\b/.test(s)) {
    return "SMALLTALK";
  }

  if (/\?$/.test(s) || /\b(how|what|when|why|can|do|does|should|am i|are i|will)\b/.test(s)) return "QNA";

  if (/\b(football|movie|weather|joke)\b/.test(s)) return "OFFTOPIC";

  return "SCRIPT";
}

function quickJoke() {
  return "Here’s a quick one: Why did the spreadsheet apply for a loan? It had too many outstanding cells.";
}

async function writeTelemetry(data: {
  session_id: string;
  turn: number;
  intent: Intent;
  model: string;
  step_id: number;
  variant?: string;
}) {
  try {
    if (!supabase) return;
    await supabase.from("chat_telemetry").insert(data);
  } catch { /* ignore */ }
}

/* ====== Name handling: never treat greetings as a name ====== */
function sanitiseName(raw: string): string | null {
  if (!raw) return null;
  const first = raw.trim().split(/\s+/)[0];
  if (!first) return null;
  const lo = first.toLowerCase();

  // block greetings & banned words
  if (STOP_NAME_TOKENS.has(lo)) return null;
  if (BANNED.has(lo)) return null;

  // allow real short names like "Li", "Jo"
  const cleaned = first.replace(/[^a-z\-']/gi, "");
  if (!cleaned) return null;

  // Title-case
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/* ================= State from history ================= */
function reduceState(history: string[]): Omit<TurnContext, "turn"> {
  let stepId = 0;
  let haveName = false;
  let name: string | null = null;
  let mainConcern: string | null = null;
  let haveAmounts = false;
  let monthlyPay: number | null = null;
  let affordablePay: number | null = null;
  let urgentFlag: string | null = null;
  let ackedMoneyHelper = false;
  let portalOffered = false;
  let portalOpened = false;
  const flags: TurnContext["flags"] = {};

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];

    if (/who I’m speaking with\?|who I'm speaking with\?/i.test(msg)) flags.askedNameAt = i + 1;
    if (/main concern/i.test(msg)) flags.askedConcernAt = i + 1;
    if (/how much.*each month|affordable/i.test(msg)) flags.askedAmountsAt = i + 1;
    if (/urgent|bailiff|enforcement|court|default|priority|council tax|rent|utilities?/i.test(msg)) flags.askedUrgentAt = i + 1;
    if (/moneyhelper/i.test(msg)) flags.askedAckAt = i + 1;
    if (/secure client portal.*open it now\?/i.test(msg)) flags.askedPortalAt = i + 1;

    // Detect we already replied smalltalk recently
    if (/\b(Good (morning|afternoon|evening)|Nice to hear from you|I’m here to help)\b/i.test(msg)) {
      flags.smalltalkAt = i + 1;
    }

    // capture usable name from user lines only (heuristic: not lines with "?" from bot)
    if (!haveName && !/\?$/.test(msg)) {
      const maybeName = sanitiseName(msg);
      if (maybeName) {
        haveName = true;
        name = maybeName;
      }
    }

    // concern
    if (!mainConcern && /(bailiff|default|ccj|missed|interest|charges|arrears|rent|council|gas|electric|water|card|loan|overdraft|catalogue|finance)/i.test(msg)) {
      mainConcern = msg;
    }

    // amounts
    const monies = parseMoney(msg);
    if (monies.length >= 2 && !haveAmounts) {
      monthlyPay = monies[0];
      affordablePay = monies[1];
      haveAmounts = true;
    }

    // urgent
    if (/bailiff|enforcement|court|default|priority|council tax|rent|utilities?/i.test(msg)) {
      urgentFlag = msg;
    }

    // ACK
    if (!ackedMoneyHelper && /\b(yes|yeah|yep|ok|okay|sure|carry on|continue|proceed)\b/i.test(msg)) {
      if (flags.askedAckAt) ackedMoneyHelper = true;
    }

    // portal
    if (/secure client portal.*open it now\?/i.test(msg)) {
      portalOffered = true;
    }
    if (portalOffered && /\b(yes|yeah|yep|ok|okay|sure|open|start)\b/i.test(msg)) {
      portalOpened = true;
    }
  }

  if (!haveName) stepId = 0;
  else if (!mainConcern) stepId = 1;
  else if (!haveAmounts) stepId = 2;
  else if (!urgentFlag) stepId = 3;
  else if (!ackedMoneyHelper) stepId = 4;
  else if (!portalOffered) stepId = 5;
  else if (portalOffered && !portalOpened) stepId = 5;
  else stepId = 6;

  return {
    stepId,
    haveName,
    name,
    mainConcern,
    haveAmounts,
    monthlyPay,
    affordablePay,
    urgentFlag,
    ackedMoneyHelper,
    portalOffered,
    portalOpened,
    flags,
  };
}

/* ================= Drivers ================= */
async function handleSmalltalk(user: string, ctx: TurnContext): Promise<string> {
  // Avoid repeating smalltalk if we just did it very recently
  if (ctx.flags.smalltalkAt && ctx.turn - (ctx.flags.smalltalkAt || 0) < 2) {
    return nextPromptFor(ctx.stepId);
  }

  // Detect “how are you”
  const asksHowAreYou = /\bhow are you\b/i.test(user);
  const userSaysMorning = /\bgood (morning)\b/i.test(user);
  const userSaysAfternoon = /\bgood (afternoon)\b/i.test(user);
  const userSaysEvening = /\bgood (evening)\b/i.test(user);

  const daypart = determineDaypartUK(); // "morning" | "afternoon" | "evening"
  const correctGreeting =
    daypart === "morning" ? "Good morning!" :
    daypart === "afternoon" ? "Good afternoon!" :
    "Good evening!";

  // If they used a mismatched greeting (e.g., “good morning” at night), gently correct:
  const greetLine =
    userSaysMorning || userSaysAfternoon || userSaysEvening
      ? correctGreeting + " "
      : "";

  if (asksHowAreYou) {
    // Natural reply then bridge to current step
    const nameBit = ctx.haveName && ctx.name ? ` ${ctx.name}` : "";
    return `${greetLine}I’m good, thanks — and I’m here to help${nameBit}. ${nextPromptFor(ctx.stepId)}`;
  }

  // Plain greeting (hi/hello)
  const nameBit = ctx.haveName && ctx.name ? ` ${ctx.name}` : "";
  return `${greetLine}Nice to hear from you${nameBit}. ${nextPromptFor(ctx.stepId)}`;
}

async function handleQna(user: string, ctx: TurnContext): Promise<string> {
  if (/joke/i.test(user)) {
    return `${quickJoke()} ${ctx.haveName ? `${ctx.name}, ` : ""}${nextPromptFor(ctx.stepId)}`;
  }
  const hit = FAQS.find(f => f.q.test(user));
  const ans = hit ? hit.a : "Here’s a brief answer: I can explain options and how they might affect you, and we’ll tailor it as we go.";
  return empathetic(ans) + " " + nextPromptFor(ctx.stepId);
}

async function handleControl(user: string, ctx: TurnContext): Promise<{ reply: string; openPortal?: boolean }> {
  const s = user.toLowerCase();
  if (s.startsWith("reset") || s.startsWith("restart")) {
    return { reply: "No problem — let’s start again. Can you let me know who I’m speaking with?" };
    }
  if (/open portal|portal/.test(s)) {
    return {
      reply: "Opening your portal now. While you’re there, you can upload documents and save progress. When you’re done, say “done” here and we’ll continue.",
      openPortal: true,
    };
  }
  return { reply: nextPromptFor(ctx.stepId) };
}

async function handleOfftopic(ctx: TurnContext): Promise<string> {
  return "We can chat, but let’s get your plan sorted first. " + nextPromptFor(ctx.stepId);
}

async function handleScript(user: string, ctx: TurnContext): Promise<{ reply: string; openPortal?: boolean; displayName?: string }> {
  switch (ctx.stepId) {
    case 0: { // name
      const n = sanitiseName(user);
      if (n) {
        return {
          reply: `Nice to meet you, ${n}. ${nextPromptFor(1)}`,
          displayName: n,
        };
      }
      if (canAsk(ctx.turn, ctx.flags.askedNameAt, 3)) {
        return { reply: "Can you let me know who I’m speaking with?" };
      }
      return { reply: "What name would you like me to use?" };
    }
    case 1: { // concern
      if (canAsk(ctx.turn, ctx.flags.askedConcernAt, 2)) {
        return { reply: empathetic(nextPromptFor(1)) };
      }
      return { reply: empathetic("Thanks — that helps. " + nextPromptFor(2)) };
    }
    case 2: { // amounts
      const money = parseMoney(user);
      if (ctx.haveAmounts || money.length >= 2) {
        return { reply: empathetic("Thanks — that gives me a clearer picture. " + nextPromptFor(3)) };
      }
      if (money.length === 1) {
        return { reply: "Got it. And what would feel affordable each month?" };
      }
      if (canAsk(ctx.turn, ctx.flags.askedAmountsAt, 2)) {
        return { reply: nextPromptFor(2) };
      }
      return { reply: "Roughly what are you paying now, and what feels affordable?" };
    }
    case 3: { // urgent
      if (/bailiff|enforcement/i.test(user)) {
        return { reply: empathetic("We’ll prioritise protections and essentials. " + nextPromptFor(4), { cue: "bailiff" }) };
      }
      if (/court|default|ccj/i.test(user)) {
        return { reply: empathetic("We’ll address court/default concerns in your plan. " + nextPromptFor(4)) };
      }
      if (/rent|council|utilities?|gas|electric|water/i.test(user)) {
        return { reply: empathetic("We’ll make sure priority bills are protected. " + nextPromptFor(4), { cue: "arrears" }) };
      }
      return { reply: nextPromptFor(4) };
    }
    case 4: { // ACK
      if (/\b(yes|yeah|yep|ok|okay|sure|carry on|continue|proceed)\b/i.test(user)) {
        return { reply: "Great — let’s keep going. " + nextPromptFor(5) };
      }
      if (/\b(no|not now|later)\b/i.test(user)) {
        return { reply: "No worries — we can pause here. If you want to continue, just say “carry on”." };
      }
      return { reply: nextPromptFor(4) };
    }
    case 5: { // portal
      if (/\b(yes|yeah|yep|ok|okay|sure|open|start)\b/i.test(user)) {
        return {
          reply: "Opening your portal now. You can come back to the chat anytime using the button in the top-right. Please follow the tasks so we can understand your situation. Once saved, say “done” here and we’ll continue.",
          openPortal: true,
        };
      }
      if (/\b(no|not now|later)\b/i.test(user)) {
        return { reply: "No problem — we’ll proceed at your pace. When you’re ready, say “open portal” and I’ll open it." };
      }
      return { reply: nextPromptFor(5) };
    }
    case 6: { // docs
      if (/\bdone|saved|uploaded|finished|complete(d)?\b/i.test(user)) {
        return { reply: "Brilliant — I’ll review what you’ve added. " + nextPromptFor(7) };
      }
      return { reply: nextPromptFor(6) };
    }
    default: { // wrap
      if (/\b(no|that’s all|thats all|finish|goodbye|thanks|thank you)\b/i.test(user)) {
        return { reply: "You’re welcome. If anything changes, come back anytime — I’m here to help." };
      }
      return { reply: nextPromptFor(7) };
    }
  }
}

/* ================= API Handler ================= */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body as Body;
    const sessionId = body.sessionId;
    const userText = (body.userMessage || "").trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const turn = history.length + 1;

    // build state from history
    const base = reduceState(history);
    const ctx: TurnContext = { turn, ...base };

    // intent + simple model routing
    const intent = classifyIntent(userText);
    let model = "gpt-4o-mini";
    if (intent === "QNA" || userText.length > 220 || /bailiff|ccj|bankrupt|court|complain|vulnerab/i.test(userText)) {
      model = "gpt-4o";
    }

    let reply = "";
    let openPortal = false;
    let displayName: string | undefined;

    if (intent === "SMALLTALK") {
      reply = await handleSmalltalk(userText, ctx);
    } else if (intent === "QNA") {
      reply = await handleQna(userText, ctx);
    } else if (intent === "CONTROL") {
      const r = await handleControl(userText, ctx);
      reply = r.reply;
      openPortal = !!r.openPortal;
    } else if (intent === "OFFTOPIC") {
      reply = await handleOfftopic(ctx);
    } else {
      const r = await handleScript(userText, ctx);
      reply = r.reply;
      openPortal = !!r.openPortal;
      displayName = r.displayName;
    }

    // telemetry (non-blocking)
    writeTelemetry({ session_id: sessionId, turn, intent, model, step_id: ctx.stepId });

    return res.status(200).json({ reply, openPortal, displayName });
  } catch {
    return res.status(200).json({ reply: "⚠️ I couldn’t reach the server just now." });
  }
}
