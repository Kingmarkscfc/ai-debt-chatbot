// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

/* =============== Supabase (optional telemetry) =============== */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

/* =============== Types =============== */
type Intent = "SCRIPT" | "QNA" | "SMALLTALK" | "CONTROL" | "OFFTOPIC";
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
    smalltalkAt?: number;
    awaitSmalltalk?: boolean; // NEW: waiting for user's “how are you” reply
  };
};

type Body = {
  sessionId: string;
  userMessage: string;
  history?: string[];
  language?: string;
};

/* =============== FAQs (short) =============== */
const FAQS: { q: RegExp; a: string }[] = [
  { q: /(credit (score|rating|file)|affect|impact)/i, a: "Some options can affect your credit file for a while, but the goal is to stabilise things and move forward." },
  { q: /\bloan(s)?\b/i, a: "We don’t provide loans — we’ll focus on reducing and clearing existing debt rather than adding credit." },
  { q: /\biva\b|\bdmp\b/i, a: "An IVA may freeze interest/charges and can write off a portion; a DMP is flexible but usually repays the full balance over time." },
  { q: /\bhouse|home|property\b/i, a: "You keep paying rent/mortgage as normal. Your home isn’t taken in a DMP/IVA if payments are maintained." },
  { q: /\bcar|vehicle|car finance\b/i, a: "Most people keep their car. If repayments are high, a more affordable vehicle might be discussed." },
  { q: /\bwhat (next|happens)\b/i, a: "Upload documents in the portal, we review your case, then come back with tailored next steps." },
  { q: /\bbenefit(s)?|universal credit|uc\b/i, a: "Normal benefit payments aren’t reduced by starting a plan. We’ll also check deductions that can be included." },
  { q: /\b(bailiff|enforcement)\b/i, a: "An IVA offers legal protection once approved. Before approval (or on a DMP), contact can continue — we’ll work on prevention and priorities." },
];

/* =============== Script (portal at step 5) =============== */
const STEPS = [
  { id: 0, key: "ASK_NAME",    prompt: "Can you let me know who I’m speaking with?" },
  { id: 1, key: "ASK_CONCERN", prompt: "Just so I can point you in the right direction, what would you say your main concern is with the debts?" },
  { id: 2, key: "ASK_AMOUNTS", prompt: "Roughly how much do you pay towards all debts each month, and what would feel affordable for you?" },
  { id: 3, key: "ASK_URGENT",  prompt: "Is anything urgent we should know about — for example bailiff/enforcement, court/default notices, or missed priority bills (rent, council tax, utilities)?" },
  { id: 4, key: "ACK",         prompt: "Before we proceed: there’s no obligation to act on advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?" },
  { id: 5, key: "PORTAL",      prompt: "I can open your secure Client Portal so you can add details, upload documents and check progress. Shall I open it now?" },
  { id: 6, key: "DOCS",        prompt: "Please upload: proof of ID, last 3 months’ bank statements, payslips (3 months or 12 weeks if weekly) if employed, last year’s tax return if self-employed, Universal Credit statements (12 months + latest) if applicable, car finance docs if applicable, and any creditor letters or statements." },
  { id: 7, key: "WRAP",        prompt: "Our assessment team will review your case and come back with next steps. Is there anything else you’d like to ask before we wrap up?" },
] as const;

const NAME_STOP = new Set([
  "hello","hi","hey","hiya","morning","afternoon","evening",
  "good","goodmorning","goodafternoon","goodevening","greetings",
  "how","are","you","today","this","tonight","there"
]);
const BANNED = new Set(["fuck","shit","crap","twat","idiot"]);

/* =============== Helpers =============== */
function determineDaypartUK(): "morning" | "afternoon" | "evening" {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" })
      .formatToParts(new Date());
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
function nextPrompt(stepId: number) {
  return STEPS.find(s => s.id === stepId)?.prompt || "Shall we continue?";
}
function empathetic(s: string) { return s.replace(/\s+/g, " ").trim(); }
function parseMoney(s: string): number[] {
  const out: number[] = [];
  (s.match(/£?\s*([0-9]{1,3}(?:,[0-9]{3})*|\d+)(?:\.\d{1,2})?/g) || []).forEach(m => {
    const n = Number(m.replace(/[^0-9.]/g, ""));
    if (!Number.isNaN(n)) out.push(n);
  });
  return out;
}
function canAsk(nowTurn: number, lastAskedAt?: number, windowTurns = 3) {
  if (lastAskedAt == null) return true;
  return nowTurn - lastAskedAt >= windowTurns;
}
function quickJoke() {
  return "Quick one: Why did the spreadsheet apply for a loan? Too many outstanding cells.";
}
function sanitiseName(raw: string): string | null {
  if (!raw) return null;
  const first = raw.trim().split(/\s+/)[0];
  if (!first) return null;
  const lo = first.toLowerCase();
  if (NAME_STOP.has(lo)) return null;
  if (BANNED.has(lo)) return null;
  const cleaned = first.replace(/[^a-z\-']/gi, "");
  if (!cleaned) return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/* Smalltalk markers embedded in assistant replies to track state through history */
const ST_MARKER_ASK = "§ASKED_HOW_ARE_YOU";
const ST_MARKER_DONE = "§SMALLTALK_DONE";

/* =============== Build state from plain history text =============== */
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

  let lastAskHowIdx = -1;
  let lastSmalltalkDoneIdx = -1;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];

    if (/who I’m speaking with\?|who I'm speaking with\?/i.test(msg)) flags.askedNameAt = i + 1;
    if (/main concern/i.test(msg)) flags.askedConcernAt = i + 1;
    if (/how much.*each month|affordable/i.test(msg)) flags.askedAmountsAt = i + 1;
    if (/urgent|bailiff|enforcement|court|default|priority|council tax|rent|utilities?/i.test(msg)) flags.askedUrgentAt = i + 1;
    if (/moneyhelper/i.test(msg)) flags.askedAckAt = i + 1;
    if (/secure client portal.*open it now\?/i.test(msg)) flags.askedPortalAt = i + 1;

    if (msg.includes(ST_MARKER_ASK)) lastAskHowIdx = i;
    if (msg.includes(ST_MARKER_DONE)) lastSmalltalkDoneIdx = i;

    if (!haveName && !/\?$/.test(msg)) {
      const maybe = sanitiseName(msg);
      if (maybe) { haveName = true; name = maybe; }
    }

    if (!mainConcern && /(bailiff|default|ccj|missed|interest|charges|arrears|rent|council|gas|electric|water|card|loan|overdraft|catalogue|finance)/i.test(msg)) {
      mainConcern = msg;
    }

    const monies = parseMoney(msg);
    if (monies.length >= 2 && !haveAmounts) {
      monthlyPay = monies[0];
      affordablePay = monies[1];
      haveAmounts = true;
    }

    if (/bailiff|enforcement|court|default|priority|council tax|rent|utilities?/i.test(msg)) {
      urgentFlag = msg;
    }

    if (!ackedMoneyHelper && /\b(yes|yeah|yep|ok|okay|sure|carry on|continue|proceed)\b/i.test(msg)) {
      if (flags.askedAckAt) ackedMoneyHelper = true;
    }

    if (/secure client portal.*open it now\?/i.test(msg)) portalOffered = true;
    if (portalOffered && /\b(yes|yeah|yep|ok|okay|sure|open|start)\b/i.test(msg)) portalOpened = true;
  }

  flags.awaitSmalltalk = lastAskHowIdx > lastSmalltalkDoneIdx;

  if (!haveName) stepId = 0;
  else if (!mainConcern) stepId = 1;
  else if (!haveAmounts) stepId = 2;
  else if (!urgentFlag) stepId = 3;
  else if (!ackedMoneyHelper) stepId = 4;
  else if (!portalOffered) stepId = 5;
  else if (portalOffered && !portalOpened) stepId = 5;
  else stepId = 6;

  return {
    stepId, haveName, name, mainConcern,
    haveAmounts, monthlyPay, affordablePay,
    urgentFlag, ackedMoneyHelper, portalOffered, portalOpened,
    flags,
  };
}

/* =============== Intent & routing =============== */
function classifyIntent(user: string): Intent {
  const s = (user || "").trim().toLowerCase();
  if (/^(reset|restart|open portal|close portal|portal|help|menu)\b/.test(s)) return "CONTROL";
  if (/\b(hi|hello|hey|hiya|good (morning|afternoon|evening)|how are you)\b/.test(s)) return "SMALLTALK";
  if (/\?$/.test(s) || /\b(how|what|when|why|can|do|does|should|am i|are i|will)\b/.test(s)) return "QNA";
  if (/\b(football|movie|weather|joke)\b/.test(s)) return "OFFTOPIC";
  return "SCRIPT";
}

/* =============== Smalltalk handlers =============== */
function buildCorrectGreeting(user: string) {
  const saysMorning = /\bgood (morning)\b/i.test(user);
  const saysAfternoon = /\bgood (afternoon)\b/i.test(user);
  const saysEvening = /\bgood (evening)\b/i.test(user);
  const daypart = determineDaypartUK();
  const correct = daypart === "morning" ? "Good morning!" : daypart === "afternoon" ? "Good afternoon!" : "Good evening!";
  return (saysMorning || saysAfternoon || saysEvening) ? correct + " " : "";
}

async function handleSmalltalkStart(user: string, ctx: TurnContext): Promise<string> {
  const greet = buildCorrectGreeting(user);
  const asksHowAreYou = /\bhow are you\b/i.test(user);
  const nameBit = ctx.haveName && ctx.name ? ` ${ctx.name}` : "";

  if (asksHowAreYou) {
    // ask back and WAIT for their reply
    return `${greet}I’m good, thanks — and I’m here to help${nameBit}. How are you doing today? ${ST_MARKER_ASK}`;
  }
  // plain greeting → light acknowledgement, then bridge
  return `${greet}Nice to hear from you${nameBit}. ${nextPrompt(ctx.stepId)}`;
}

async function handleSmalltalkFollowup(user: string, ctx: TurnContext): Promise<string> {
  const u = user.toLowerCase();
  let ack = "Thanks for telling me.";
  if (/\b(good|great|fine|ok|okay|not bad|alright)\b/.test(u)) ack = "Glad to hear it.";
  if (/\b(not great|not good|stressed|worried|anxious|overwhelmed|bad)\b/.test(u)) ack = "Sorry it’s been tough — we’ll keep things simple.";
  const nameBit = ctx.haveName && ctx.name ? ` ${ctx.name}` : "";
  return `${ack}${nameBit ? " " + nameBit : ""}. ${nextPrompt(ctx.stepId)} ${ST_MARKER_DONE}`;
}

/* =============== Other handlers =============== */
async function handleQna(user: string, ctx: TurnContext): Promise<string> {
  if (/joke/i.test(user)) {
    return `${quickJoke()} ${ctx.haveName ? `${ctx.name}, ` : ""}${nextPrompt(ctx.stepId)}`;
  }
  const hit = FAQS.find(f => f.q.test(user));
  const ans = hit ? hit.a : "Here’s a quick answer, and we’ll tailor things to you as we go.";
  return empathetic(ans) + " " + nextPrompt(ctx.stepId);
}

async function handleControl(user: string, ctx: TurnContext) {
  const s = user.toLowerCase();
  if (s.startsWith("reset") || s.startsWith("restart")) {
    return { reply: "No problem — let’s start again. Can you let me know who I’m speaking with?" };
  }
  if (/open portal|portal/.test(s)) {
    return {
      reply: "Opening your portal now. While you’re there you can upload documents and save progress. When you’re done, say “done” here and we’ll continue.",
      openPortal: true,
    };
  }
  return { reply: nextPrompt(ctx.stepId) };
}

async function handleOfftopic(ctx: TurnContext): Promise<string> {
  return "We can chat, but let’s get your plan sorted first. " + nextPrompt(ctx.stepId);
}

async function handleScript(user: string, ctx: TurnContext) {
  switch (ctx.stepId) {
    case 0: {
      const n = sanitiseName(user);
      if (n) return { reply: `Nice to meet you, ${n}. ${nextPrompt(1)}`, displayName: n };
      if (canAsk(ctx.turn, ctx.flags.askedNameAt, 3)) return { reply: "Can you let me know who I’m speaking with?" };
      return { reply: "What name would you like me to use?" };
    }
    case 1: {
      if (canAsk(ctx.turn, ctx.flags.askedConcernAt, 2)) return { reply: empathetic(nextPrompt(1)) };
      return { reply: empathetic("Thanks — that helps. " + nextPrompt(2)) };
    }
    case 2: {
      const money = parseMoney(user);
      if (ctx.haveAmounts || money.length >= 2) return { reply: empathetic("Thanks — that gives me a clearer picture. " + nextPrompt(3)) };
      if (money.length === 1) return { reply: "Got it. And what would feel affordable each month?" };
      if (canAsk(ctx.turn, ctx.flags.askedAmountsAt, 2)) return { reply: nextPrompt(2) };
      return { reply: "Roughly what are you paying now, and what feels affordable?" };
    }
    case 3: {
      if (/bailiff|enforcement/i.test(user)) return { reply: empathetic("We’ll prioritise protections and essentials. " + nextPrompt(4)) };
      if (/court|default|ccj/i.test(user)) return { reply: empathetic("We’ll address court/default concerns in your plan. " + nextPrompt(4)) };
      if (/rent|council|utilities?|gas|electric|water/i.test(user)) return { reply: empathetic("We’ll make sure priority bills are protected. " + nextPrompt(4)) };
      return { reply: nextPrompt(4) };
    }
    case 4: {
      if (/\b(yes|yeah|yep|ok|okay|sure|carry on|continue|proceed)\b/i.test(user)) return { reply: "Great — let’s keep going. " + nextPrompt(5) };
      if (/\b(no|not now|later)\b/i.test(user)) return { reply: "No worries — we can pause here. If you want to continue, just say “carry on”." };
      return { reply: nextPrompt(4) };
    }
    case 5: {
      if (/\b(yes|yeah|yep|ok|okay|sure|open|start)\b/i.test(user)) {
        return {
          reply: "Opening your portal now. You can come back to the chat anytime using the button in the top-right. Please follow the tasks so we can understand your situation. Once saved, say “done” here and we’ll continue.",
          openPortal: true,
        };
      }
      if (/\b(no|not now|later)\b/i.test(user)) return { reply: "No problem — we’ll proceed at your pace. When you’re ready, say “open portal” and I’ll open it." };
      return { reply: nextPrompt(5) };
    }
    case 6: {
      if (/\bdone|saved|uploaded|finished|complete(d)?\b/i.test(user)) return { reply: "Brilliant — I’ll review what you’ve added. " + nextPrompt(7) };
      return { reply: nextPrompt(6) };
    }
    default: {
      if (/\b(no|that’s all|thats all|finish|goodbye|thanks|thank you)\b/i.test(user)) return { reply: "You’re welcome. If anything changes, come back anytime — I’m here to help." };
      return { reply: nextPrompt(7) };
    }
  }
}

/* =============== Telemetry (non-blocking) =============== */
async function writeTelemetry(data: {
  session_id: string; turn: number; intent: Intent; model: string; step_id: number; variant?: string;
}) {
  try { if (!supabase) return; await supabase.from("chat_telemetry").insert(data); } catch {}
}

/* =============== API =============== */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body as Body;
    const sessionId = body.sessionId;
    const userText = (body.userMessage || "").trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const turn = history.length + 1;

    // compute state
    const base = reduceState(history);
    const ctx: TurnContext = { turn, ...base };

    // intent + simple model routing
    const intent = ctx.flags.awaitSmalltalk ? "SMALLTALK" : classifyIntent(userText);
    let model = "gpt-4o-mini";
    if (intent === "QNA" || userText.length > 220 || /bailiff|ccj|bankrupt|court|complain|vulnerab/i.test(userText)) {
      model = "gpt-4o";
    }

    let reply = "";
    let openPortal = false;
    let displayName: string | undefined;

    if (intent === "SMALLTALK") {
      if (ctx.flags.awaitSmalltalk) {
        reply = await handleSmalltalkFollowup(userText, ctx); // ends with §SMALLTALK_DONE
      } else {
        reply = await handleSmalltalkStart(userText, ctx);    // may add §ASKED_HOW_ARE_YOU
      }
    } else if (intent === "QNA") {
      reply = await handleQna(userText, ctx);
    } else if (intent === "CONTROL") {
      const r = await handleControl(userText, ctx);
      reply = r.reply; openPortal = !!r.openPortal;
    } else if (intent === "OFFTOPIC") {
      reply = await handleOfftopic(ctx);
    } else {
      const r = await handleScript(userText, ctx);
      reply = r.reply; openPortal = !!r.openPortal; displayName = r.displayName;
    }

    writeTelemetry({ session_id: sessionId, turn, intent, model, step_id: ctx.stepId });

    return res.status(200).json({ reply, openPortal, displayName });
  } catch {
    return res.status(200).json({ reply: "⚠️ I couldn’t reach the server just now." });
  }
}
