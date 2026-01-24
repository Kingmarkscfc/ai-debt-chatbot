// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

// --------- Supabase (server role for telemetry; non-fatal if missing) ----------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

// --------- Types ----------
type Intent = "SCRIPT" | "QNA" | "SMALLTALK" | "CONTROL" | "OFFTOPIC";
type Sender = "user" | "assistant";

type TurnContext = {
  turn: number;
  // script state we infer from history
  stepId: number;                 // current script step to ask
  haveName: boolean;
  name: string | null;
  mainConcern?: string | null;
  haveAmounts: boolean;
  monthlyPay: number | null;
  affordablePay: number | null;
  urgentFlag?: string | null;     // bailiff/ccj/priority etc
  ackedMoneyHelper: boolean;      // step 4 consent captured
  portalOffered: boolean;         // step 5 prompt sent at least once
  portalOpened: boolean;          // user said yes to open portal
  flags: {
    askedNameAt?: number;
    askedAmountsAt?: number;
    askedConcernAt?: number;
    askedUrgentAt?: number;
    askedAckAt?: number;
    askedPortalAt?: number;
  };
};

type Body = {
  sessionId: string;
  userMessage: string;
  history?: string[];
  language?: string;
};

// --------- Small in-memory FAQ (also used to answer QNA) ----------
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

// --------- Script steps (short track; portal at step 5) ----------
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

// --------- Helpers ----------
const BANNED = new Set(["fuck","shit","crap","twat","idiot"]);
function sanitiseName(raw: string): string | null {
  const first = (raw || "").trim().split(/\s+/)[0];
  if (!first) return null;
  const lo = first.toLowerCase();
  if (BANNED.has(lo)) return null;
  if (lo === "shit") return null; // allow names like "Harshit" (but not exactly "shit")
  const cleaned = first.replace(/[^a-z\-']/gi, "");
  if (!cleaned) return null;
  // Title-case
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
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

function empathetic(core: string, opts?: { cue?: "general" | "arrears" | "bailiff" | "stress" | "name" }) {
  const lead =
    opts?.cue === "bailiff" ? "Bailiff worries can feel intense. " :
    opts?.cue === "arrears" ? "Falling behind happens. " :
    opts?.cue === "name" ? "" :
    "I understand. ";
  return (lead + core).replace(/\s+/g, " ").trim();
}

function classifyIntent(user: string): Intent {
  const s = (user || "").trim().toLowerCase();

  if (/^(reset|restart|open portal|close portal|portal|help|menu)\b/.test(s)) return "CONTROL";

  if (/\b(hi|hello|hey|good (morning|afternoon|evening)|how are you)\b/.test(s)) {
    if (!/\?$/.test(s) && s.split(/\s+/).length <= 10) return "SMALLTALK";
  }

  if (/\?$/.test(s) || /\b(how|what|when|why|can|do|does|should|am i|are i|will)\b/.test(s)) return "QNA";

  if (/\b(football|movie|weather|joke)\b/.test(s)) return "OFFTOPIC";

  return "SCRIPT";
}

function nextPromptFor(stepId: number) {
  const step = STEPS.find(s => s.id === stepId);
  return step ? step.prompt : "Shall we continue?";
}

// simple joke for “tell me a joke?”
function quickJoke() {
  return "Here’s a quick one: Why did the spreadsheet apply for a loan? It had too many outstanding cells.";
}

// --------- Telemetry (best-effort, non-blocking) ----------
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
  } catch {
    /* ignore */
  }
}

// --------- State reducer from history ----------
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

  // Naive parse: walk through messages and infer captured fields
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    // capture name if bot asked name and then user replied
    if (/who I’m speaking with\?|who I'm speaking with\?/i.test(msg)) {
      flags.askedNameAt = i + 1;
    }
    if (!haveName) {
      const maybeName = sanitiseName(msg);
      if (maybeName) {
        haveName = true;
        name = maybeName;
      }
    }

    // concern
    if (/main concern/i.test(msg)) flags.askedConcernAt = i + 1;
    if (!mainConcern && /(bailiff|default|ccj|missed|interest|charges|arrears|rent|council|gas|electric|water|card|loan|overdraft|catalogue|finance)/i.test(msg)) {
      mainConcern = msg;
    }

    // amounts
    if (/how much.*each month|affordable/i.test(msg)) flags.askedAmountsAt = i + 1;
    const monies = parseMoney(msg);
    if (monies.length >= 2 && !haveAmounts) {
      // guess: first = paying, second = affordable (not perfect but good enough to move flow)
      monthlyPay = monies[0];
      affordablePay = monies[1];
      haveAmounts = true;
    }

    // urgent flags
    if (/urgent|bailiff|enforcement|court|default|priority|council tax|rent|utilities?/i.test(msg)) {
      urgentFlag = msg;
    }

    // ACK
    if (/moneyhelper/i.test(msg)) flags.askedAckAt = i + 1;
    if (!ackedMoneyHelper && /\b(yes|yeah|yep|ok|okay|sure|carry on|continue|proceed)\b/i.test(msg)) {
      // only mark acked if we previously asked ack
      if (flags.askedAckAt) ackedMoneyHelper = true;
    }

    // portal offer / open
    if (/secure client portal.*open it now\?/i.test(msg)) {
      portalOffered = true;
      flags.askedPortalAt = i + 1;
    }
    if (portalOffered && /\b(yes|yeah|yep|ok|okay|sure|open|start)\b/i.test(msg)) {
      portalOpened = true;
    }
  }

  // determine stepId loosely based on captured fields
  if (!haveName) stepId = 0;
  else if (!mainConcern) stepId = 1;
  else if (!haveAmounts) stepId = 2;
  else if (!urgentFlag) stepId = 3;
  else if (!ackedMoneyHelper) stepId = 4;
  else if (!portalOffered) stepId = 5;
  else if (portalOffered && !portalOpened) stepId = 5;
  else stepId = 6; // docs, then wrap

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

// --------- Drivers for each skill ----------
async function handleSmalltalk(ctx: TurnContext): Promise<string> {
  const greet = ctx.haveName ? `Nice to hear from you, ${ctx.name}.` : "Nice to hear from you.";
  return `${greet} ${nextPromptFor(ctx.stepId)}`;
}

async function handleQna(user: string, ctx: TurnContext): Promise<string> {
  // Special: jokes
  if (/joke/i.test(user)) {
    return `${quickJoke()} ${ctx.haveName ? `${ctx.name},` : ""} shall we carry on? ${nextPromptFor(ctx.stepId)}`;
  }
  const hit = FAQS.find(f => f.q.test(user));
  const ans = hit ? hit.a : "Here’s a brief answer: I can explain options and how they might affect you, and we’ll tailor it as we go.";
  const bridge = " Shall we continue?";
  return empathetic(ans, { cue: "general" }) + " " + bridge + " " + nextPromptFor(ctx.stepId);
}

async function handleControl(user: string, ctx: TurnContext): Promise<{ reply: string; openPortal?: boolean }> {
  const s = user.toLowerCase();
  if (s.startsWith("reset") || s.startsWith("restart")) {
    // soft reset: go back to step 0
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
  // drive by current step
  switch (ctx.stepId) {
    case 0: { // ask name
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
      // if user provides anything, accept and move on
      return { reply: empathetic("Thanks — that helps. " + nextPromptFor(2)) };
    }

    case 2: { // amounts
      const money = parseMoney(user);
      if (ctx.haveAmounts || money.length >= 2) {
        return { reply: empathetic("Thanks — that gives me a clearer picture. " + nextPromptFor(3), { cue: "general" }) };
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
      // no urgent
      return { reply: nextPromptFor(4) };
    }

    case 4: { // MoneyHelper ack
      if (/\b(yes|yeah|yep|ok|okay|sure|carry on|continue|proceed)\b/i.test(user)) {
        return { reply: "Great — let’s keep going. " + nextPromptFor(5) };
      }
      if (/\b(no|not now|later)\b/i.test(user)) {
        return { reply: "No worries — we can pause here. If you want to continue, just say “carry on”." };
      }
      return { reply: nextPromptFor(4) };
    }

    case 5: { // Portal offer (open only on explicit yes)
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

// --------- API Handler ----------
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

    // intent + (stub) model routing
    const intent = classifyIntent(userText);
    let model = "gpt-4o-mini";
    if (intent === "QNA" || userText.length > 220 || /bailiff|ccj|bankrupt|court|complain|vulnerab/i.test(userText)) {
      model = "gpt-4o";
    }

    // route
    let reply = "";
    let openPortal = false;
    let displayName: string | undefined;

    if (intent === "SMALLTALK") {
      reply = await handleSmalltalk(ctx);
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

    // write telemetry (best-effort)
    writeTelemetry({
      session_id: sessionId,
      turn,
      intent,
      model,
      step_id: ctx.stepId,
    });

    return res.status(200).json({ reply, openPortal, displayName });
  } catch (e: any) {
    return res.status(200).json({ reply: "⚠️ I couldn’t reach the server just now." });
  }
}
