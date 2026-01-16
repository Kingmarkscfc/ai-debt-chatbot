// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

/** ---------------- Safe file loader with fallback ---------------- */
function safeLoadJSON<T>(rel: string, fallback: T): T {
  try {
    const p = path.join(process.cwd(), rel);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw) as T;
    }
  } catch {}
  return fallback;
}

/** Defaults if files are missing/broken */
const SCRIPT_DEFAULT = {
  steps: [
    { id: 0, prompt: "Great, I look forward to helping you clear your debts. Can you let me know who I’m speaking to?" },
    { id: 1, prompt: "Just so I can point you in the right direction, what would you say your main concern is with the debts?" },
    { id: 2, prompt: "Thanks — roughly how much do you pay towards all debts each month, and what would feel affordable for you?" },
    { id: 3, prompt: "Understood. Is there anything urgent like enforcement/bailiff action, court or default notices, or missed priority bills (rent, council tax, utilities)?" },
    { id: 4, prompt: "Before we proceed, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?" },
    { id: 5, prompt: "Let’s set up your secure Client Portal so you can add details, upload documents, and check progress. Shall I open it now?", openPortal: true },
    { id: 6, prompt: "While you’re in the portal, I’ll stay here to guide you. You can come back to the chat anytime using the button in the top-right corner. Please follow the outstanding tasks so we can understand your situation. Once you’ve saved your details, say “done” and we’ll continue." },
  ],
};

const FAQS_DEFAULT: Array<{ q: string; a: string; keywords?: string[] }> = [
  { q: "Credit rating", a: "Changing agreements can affect your credit file for a time, but the aim is to stabilise things and help you move forward.", keywords: ["credit score","credit rating","credit file"] },
  { q: "Loans", a: "We don’t provide loans; our role is to help reduce and clear existing debt rather than add more credit.", keywords: ["loan","borrow"] },
];

/** Load external files (tolerant) */
const SCRIPT = safeLoadJSON("utils/full_script_logic.json", SCRIPT_DEFAULT) as typeof SCRIPT_DEFAULT;
const FAQS = safeLoadJSON("utils/faqs.json", FAQS_DEFAULT) as typeof FAQS_DEFAULT;

/** ---------------- Utilities ---------------- */
const normalize = (s: string) => (s || "").trim().toLowerCase();
const stripPunc = (s: string) => s.replace(/[^\p{L}\p{N}\s£\.]/gu, " ").replace(/\s+/g, " ").trim();

function looksLikeNameRaw(raw: string): boolean {
  const t = normalize(raw);

  // Hard filters: greetings or obvious non-name content
  if (/(^|\s)(hi|hello|hey|good (morning|afternoon|evening)|how are you|you ok)(\s|$)/.test(t)) return false;
  if (/[?@#:/\\]/.test(t)) return false; // likely not a bare name
  if (t.length < 2 || t.length > 40) return false;

  // Accept one or two tokens of letters/hyphens/apostrophes
  const tokens = t.split(/\s+/).slice(0, 2);
  if (tokens.length === 0 || tokens.length > 2) return false;
  if (!tokens.every(x => /^[a-z][a-z'\-]*$/i.test(x))) return false;

  return true;
}

function toTitleCaseName(raw: string): string {
  const cleaned = raw.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  return cleaned;
}

function extractNameFromMessage(msg: string): string | null {
  const s = msg.trim();

  // Patterned forms
  const p = s.match(/\b(my name is|i'?m|i am|it'?s|call me)\s+([a-z][a-z\s'\-]{1,40})/i);
  if (p) {
    const n = p[2].trim().split(/\s+/).slice(0, 2).join(" ");
    return toTitleCaseName(n);
  }

  // Bare name (e.g., "Mark" or "Mark Hughes")
  if (looksLikeNameRaw(s)) {
    return toTitleCaseName(s);
  }

  return null;
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
  return /^(hi|hello|hey|good (morning|afternoon|evening)|how are you|you ok)\b/.test(t);
}

function greetVariant(user: string): string {
  const t = normalize(user);
  const timey = /good (morning|afternoon|evening)/.exec(t)?.[0];
  if (timey) return timey.replace(/\b\w/g, c => c.toUpperCase()) + "!";
  if (/how are you/.test(t)) return "I’m good thanks — more importantly, I’m here to help you today.";
  return "Hi!";
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

/** ---------------- Derive state from history ---------------- */
type Derived = {
  askedName: boolean;
  haveName: boolean; name?: string;
  haveConcern: boolean;
  monthly?: number; affordable?: number;
  askedUrgent: boolean; urgentAnswered: boolean;
  ackAccepted: boolean;
  invitedPortal: boolean; portalOpened: boolean;
};

function deriveState(history: string[], latest: string): Derived {
  const h = history.map(x => stripPunc(String(x).toLowerCase()));
  const full = h.join("\n");
  const latestStripped = stripPunc(latest.toLowerCase());

  // Was the "name" question asked already?
  const askedName = history.some(x => x.includes(SCRIPT.steps[0].prompt));

  // Try to find a name in the whole convo
  let name: string | undefined;
  // 1) Look through history lines for explicit "my name is …"
  for (const line of history.slice(-6)) { // recent window
    const n = extractNameFromMessage(line);
    if (n) { name = n; break; }
  }
  // 2) If still none, try latest message
  if (!name) {
    const n2 = extractNameFromMessage(latest);
    if (n2) name = n2;
  }

  const haveName = !!name;

  // Concern detection
  const concern = /(bailiff|default|ccj|missed|interest|charges|arrears|rent|council|gas|electric|card|loan|overdraft|catalogue|finance|curious|better deal)/.test(full + "\n" + latestStripped);

  // Money window
  let monthly: number | undefined;
  let affordable: number | undefined;
  const linesToScan = history.concat(latest).slice(-10);
  for (const line of linesToScan) {
    const ln = line.toLowerCase();
    if (/(pay|repay|towards|per month|monthly)/.test(ln)) {
      const nums = extractMoney(ln);
      if (nums.length === 1) {
        if (!monthly && nums[0] >= 50) monthly = nums[0];
      } else if (nums.length >= 2) {
        const sorted = [...nums].sort((a, b) => b - a);
        monthly = sorted[0];
        affordable = sorted[sorted.length - 1];
      }
    } else if (/afford|affordable|can manage|could do/.test(ln)) {
      const nums = extractMoney(ln);
      if (nums.length) affordable = nums[0];
    }
  }

  const askedUrgent = /anything urgent.*(enforcement|bailiff|court|default|priority)/i.test(full);
  const urgentAnswered = askedUrgent && /\b(no|none|nothing|not really|yes|bailiff|ccj|default|missed)\b/i.test(full + " " + latestStripped);

  const ackShown = /no obligation.*moneyhelper/i.test(full);
  const ackAccepted = ackShown && /\b(yes|ok|okay|carry on|continue|proceed|yep|sure)\b/i.test(full + " " + latestStripped);

  const invitedPortal = /secure client portal/i.test(full);
  const portalOpened = invitedPortal && /\b(yes|ok|okay|open|go ahead|please do|sure)\b/i.test(full + " " + latestStripped);

  return { askedName, haveName, name, haveConcern: concern, monthly, affordable, askedUrgent, urgentAnswered, ackAccepted, invitedPortal, portalOpened };
}

/** ---------------- Script driver ---------------- */
function nextPrompt(d: Derived): string {
  // If we asked for the name, and now we have a name, move on (do NOT re-ask)
  if (!d.haveName) return SCRIPT.steps[0].prompt;
  if (!d.haveConcern) return SCRIPT.steps[1].prompt;
  if (!d.monthly && !d.affordable) return SCRIPT.steps[2].prompt;
  if (d.monthly && !d.affordable) return "Thanks — and what would feel affordable for you each month?";
  if (!d.askedUrgent || !d.urgentAnswered) return SCRIPT.steps[3].prompt;
  if (!d.ackAccepted) return SCRIPT.steps[4].prompt;
  if (!d.invitedPortal) return SCRIPT.steps[5].prompt;
  if (d.invitedPortal && !d.portalOpened) return "No problem — I’ll open it whenever you say “open portal”. Meanwhile, would you like a quick summary of options?";
  return SCRIPT.steps[6].prompt;
}

function stitchReply(user: string, d: Derived): { reply: string; openPortal?: boolean; displayName?: string } {
  const parts: string[] = [];

  // Human niceties
  if (isSmallTalk(user)) parts.push(greetVariant(user));
  const empathy = empatheticAck(user);
  if (empathy) parts.push(empathy);

  // Only greet-by-name if we just captured one AND we’re not re-asking
  const possibleName = extractNameFromMessage(user);
  if (!d.haveName && possibleName) {
    parts.push(`Nice to meet you, ${possibleName}.`);
  }

  // FAQ hook (kept short so it doesn't derail the script)
  const faq = faqAnswer(user);
  if (faq) parts.push(faq);

  // Drive script
  const prompt = nextPrompt({ ...d, haveName: d.haveName || !!possibleName, name: d.name ?? possibleName ?? undefined });
  parts.push(prompt);

  // Only open the portal if current prompt is the invite AND the user said yes-now
  const wantsPortal = /\b(yes|ok|okay|sure|open|go ahead|please do)\b/i.test(user);
  const isInvite = /secure client portal/i.test(prompt);
  const openPortal = isInvite && wantsPortal;

  return { reply: parts.join(" "), openPortal, displayName: d.name ?? possibleName ?? undefined };
}

/** ---------------- Handler ---------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") return res.status(200).json({ ok: true });
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const userMessage = String(body.userMessage ?? "").trim();
    const history: string[] = Array.isArray(body.history) ? body.history.map(String) : [];

    // Reset always works
    if (/^\s*(reset|restart|start over)\s*$/i.test(userMessage)) {
      return res.status(200).json({ reply: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" });
    }

    // Derive state from (history + current)
    const derived = deriveState(history, userMessage);

    // Build reply
    const out = stitchReply(userMessage, derived);
    return res.status(200).json(out);
  } catch {
    // Never surface a 500—return a safe intro so the chat continues
    return res.status(200).json({ reply: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" });
  }
}
