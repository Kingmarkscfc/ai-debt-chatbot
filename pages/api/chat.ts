// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { readFileSync } from "fs";
import path from "path";

/** ---------- Load script + FAQs ---------- */
function loadJSON<T = any>(rel: string): T {
  const p = path.join(process.cwd(), rel);
  return JSON.parse(readFileSync(p, "utf8"));
}
const SCRIPT: {
  steps: Array<{ id: number; prompt: string; keywords?: string[]; openPortal?: boolean }>;
} = loadJSON("utils/full_script_logic.json");
const FAQS: Array<{ q: string; a: string; keywords?: string[] }> = loadJSON("utils/faqs.json");

/** ---------- Helpers ---------- */
const normalize = (s: string) => (s || "").trim().toLowerCase();
const stripPunc = (s: string) => s.replace(/[^\p{L}\p{N}\s£\.]/gu, " ").replace(/\s+/g, " ").trim();

function titleCaseName(raw: string): string {
  let s = raw.trim();
  // Remove trailing “too/also/as well”
  s = s.replace(/\b(too|also|as well)\b\.?$/i, "").trim();
  // Remove leading “my name is / i’m / i am / it’s”
  s = s.replace(/^(my name is|i'm|i am|it'?s|call me)\s+/i, "").trim();
  // Drop obvious non-name tails
  s = s.replace(/\b(and|but|because|,)\b.*$/i, "").trim();
  // One or two words are acceptable; clamp length
  s = s.split(/\s+/).slice(0, 3).join(" ");
  if (!s) return "";
  // Title case
  return s
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function extractMoney(s: string): number[] {
  const out: number[] = [];
  const txt = s.replace(/[, ]/g, "");
  const matches = txt.match(/£?\d+(\.\d{1,2})?/g) || [];
  for (const m of matches) {
    const n = Number(m.replace("£", ""));
    if (!Number.isNaN(n) && n > 0 && n < 1000000) out.push(n);
  }
  return out;
}

function isSmallTalk(s: string): boolean {
  const t = normalize(s);
  return /^(hi|hello|hey|good (morning|afternoon|evening)|how are you|you ok|yo)\b/.test(t);
}

function empatheticAck(user: string): string | null {
  const t = normalize(user);
  if (/(bailiff|enforcement)/.test(t)) return "I know bailiff contact is stressful — we’ll get protections in place quickly.";
  if (/(ccj|county court|default)/.test(t)) return "Court or default letters can be worrying — we’ll address that in your plan.";
  if (/(miss(ed)?\s*payments?|arrears|late fees?)/.test(t)) return "Missed payments happen — we’ll focus on stabilising things now.";
  if (/(rent|council\s*tax|water|gas|electric)/.test(t)) return "We’ll make sure essentials like housing and utilities are prioritised.";
  if (/(credit\s*card|loan|overdraft|catalogue|car\s*finance)/.test(t)) return "We’ll take this step by step and ease the pressure.";
  return null;
}

function faqAnswer(user: string): string | null {
  const t = normalize(user);
  for (const f of FAQS) {
    const keys = (f.keywords || []).map(k => normalize(k));
    if (keys.some(k => t.includes(k))) return f.a;
  }
  return null;
}

/** ---------- State derivation from history ---------- */
type Derived = {
  haveName: boolean;
  name?: string;
  haveConcern: boolean;
  monthly?: number;
  affordable?: number;
  askedUrgent: boolean;
  urgentAnswered: boolean;
  ackAccepted: boolean;
  invitedPortal: boolean;
  portalOpened: boolean;
  lastStepId: number | null;
};

function deriveState(history: string[]): Derived {
  const h = history.map(x => stripPunc(x.toLowerCase()));
  const full = h.join("\n");

  // Name: look for patterns “my name is …”, “I’m …”, “I am …”
  const nameMatch =
    full.match(/\b(my name is|i'?m|i am|call me)\s+([a-z][a-z\s\-']{1,40})/i) ||
    full.match(/\b(sign off|thanks|thank you),?\s+([a-z][a-z\s\-']{1,40})$/i);
  const name = nameMatch ? titleCaseName(nameMatch[2] || "") : undefined;

  // Concern: after user mentions specific debt types or pain words
  const concern = /(bailiff|default|ccj|missed|interest|charges|arrears|rent|council|gas|electric|card|loan|overdraft|catalogue|finance|curious|better deal)/.test(
    full,
  );

  // Amounts window: find the first message where numbers appear after “pay” context
  let monthly: number | undefined;
  let affordable: number | undefined;
  for (const line of h) {
    if (/(pay|repay|towards|per month|monthly)/.test(line)) {
      const nums = extractMoney(line);
      if (nums.length === 1) {
        // If we only have one and it's large, treat as current spend
        if (!monthly && nums[0] >= 50) monthly = nums[0];
      } else if (nums.length >= 2) {
        // Heuristic: larger is current spend, smaller is affordable
        const sorted = [...nums].sort((a, b) => b - a);
        monthly = sorted[0];
        affordable = sorted[sorted.length - 1];
      }
    } else if (/afford|affordable|can manage|could do/.test(line)) {
      const nums = extractMoney(line);
      if (nums.length) affordable = nums[0];
    }
  }

  const askedUrgent = /anything urgent|urgent like enforcement|court letters/i.test(full);
  const urgentAnswered = askedUrgent && /\b(no|none|nothing|not really|yes|bailiff|ccj|default|missed)\b/i.test(full);

  const ackShown = /no obligation|moneyhelper/i.test(full);
  const ackAccepted = ackShown && /\b(yes|ok|okay|carry on|continue|proceed|yep|sure)\b/i.test(full);

  const invitedPortal = /secure client portal/i.test(full);
  const portalOpened = invitedPortal && /\b(yes|ok|okay|open|go ahead|please do|sure)\b/i.test(full);

  // Find last script step id by matching exact prompts we sent earlier
  let lastStep: number | null = null;
  for (const step of SCRIPT.steps) {
    if (history.some(m => m.includes(step.prompt))) lastStep = step.id;
  }

  return {
    haveName: !!name,
    name,
    haveConcern: concern,
    monthly,
    affordable,
    askedUrgent: askedUrgent,
    urgentAnswered,
    ackAccepted,
    invitedPortal,
    portalOpened,
    lastStepId: lastStep,
  };
}

/** ---------- Response generators ---------- */
function greetVariant(user: string): string {
  const t = normalize(user);
  const timey = /good morning|good afternoon|good evening/.exec(t)?.[0];
  if (timey) return `${timey.replace(/\b\w/g, c => c.toUpperCase())}!`;
  if (/how are you/.test(t)) return "I’m good thanks — more importantly, I’m here to help you today.";
  return "Hi!";
}

function nextScriptPrompt(d: Derived): string {
  // Order:
  // 0 name → 1 concern → 2 amounts (monthly then affordable) → 3 urgent → 4 MoneyHelper ack → 5 portal invite → 6 wrap-up
  if (!d.haveName) return "Great, I look forward to helping you clear your debts. Can you let me know who I’m speaking to?";
  if (!d.haveConcern) return "Just so I can point you in the right direction, what would you say your main concern is with the debts?";
  if (!d.monthly && !d.affordable)
    return "Thanks — roughly how much do you pay towards all debts each month, and what would feel affordable for you?";
  if (d.monthly && !d.affordable) return "Thanks — and what would feel affordable for you each month?";
  if (!d.askedUrgent || !d.urgentAnswered)
    return "Understood. Is there anything urgent like enforcement/bailiff action, court or default notices, or missed priority bills (rent, council tax, utilities)?";
  if (!d.ackAccepted)
    return "Before we proceed, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?";
  if (!d.invitedPortal)
    return "Let’s set up your secure Client Portal so you can add details, upload documents, and check progress. Shall I open it now?";
  if (d.invitedPortal && !d.portalOpened)
    return "No problem — I’ll open it whenever you say “open portal”. Meanwhile, would you like a quick summary of options?";
  // After portal opened or declined
  return "While you’re in the portal, I’ll stay here to guide you. You can come back to the chat anytime using the button in the top-right corner. Please follow the outstanding tasks so we can understand your situation. Once you’ve saved your details, say “done” and we’ll continue.";
}

function stitchReply(user: string, d: Derived): { text: string; openPortal?: boolean; displayName?: string } {
  const parts: string[] = [];

  // Small talk: reply but don’t derail the script
  if (isSmallTalk(user)) {
    parts.push(greetVariant(user));
  }

  // Empathy (single line max)
  const empathy = empatheticAck(user);
  if (empathy) parts.push(empathy);

  // If user gave their name, acknowledge naturally
  const maybeName = titleCaseName(user);
  if (!d.haveName && maybeName) {
    parts.push(`Nice to meet you, ${maybeName}.`);
  } else if (d.haveName && d.name && /my name is|i'?m|i am|mark too|also/i.test(user)) {
    parts.push(`Great — we share the same name! Nice to have you here, ${d.name}.`);
  }

  // If user asked something FAQ-like, answer briefly but still move on
  const faq = faqAnswer(user);
  if (faq) parts.push(faq);

  // Script progression
  const prompt = nextScriptPrompt(d);
  parts.push(prompt);

  // Portal open only if this prompt is the invite AND user explicitly said yes
  const wantsPortal = /(^|\b)(yes|ok|okay|sure|open|go ahead|please do)\b/i.test(user);
  const isInvite = /secure Client Portal/i.test(prompt);
  const openPortal = isInvite && wantsPortal;

  const displayName = d.name;

  return { text: parts.join(" "), openPortal, displayName };
}

/** ---------- Handler ---------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { sessionId, userMessage, history = [], language } = req.body || {};
    const user = String(userMessage || "").trim();

    // Reset guard
    if (/^\s*(reset|restart|start over)\s*$/i.test(user)) {
      const intro = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      return res.status(200).json({ reply: intro });
    }

    // Derive current state from full history + this message
    const derived = deriveState(history.concat(user));

    // Generate stitched reply
    const out = stitchReply(user, derived);

    // Telemetry (best-effort, silent). If you have a table chat_telemetry, you can wire it here.
    // Not writing now to keep this endpoint dependency-free and robust.

    return res.status(200).json(out);
  } catch (e: any) {
    return res.status(200).json({ reply: "⚠️ I couldn’t reach the server just now." });
  }
}
