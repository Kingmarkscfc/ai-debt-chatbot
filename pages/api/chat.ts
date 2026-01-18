import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

/* ---------- tolerant loaders ---------- */
function safeLoadJSON<T>(rel: string, fallback: T): T {
  try {
    const p = path.join(process.cwd(), rel);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8")) as T;
    }
  } catch {}
  return fallback;
}

/* ---------- defaults (used if your JSONs are missing) ---------- */
const SCRIPT_DEFAULT = {
  steps: [
    { id: 0, prompt: "Great, I look forward to helping you clear your debts. Can you let me know who I’m speaking to?" },
    { id: 1, prompt: "Just so I can point you in the right direction, what would you say your main concern is with the debts?" },
    { id: 2, prompt: "Thanks — roughly how much do you pay towards all debts each month, and what would feel affordable for you?" },
    { id: 3, prompt: "Understood. Is there anything urgent like enforcement/bailiff action, court or default notices, or missed priority bills (rent, council tax, utilities)?" },
    { id: 4, prompt: "Before we proceed, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?" },
    { id: 5, prompt: "Let’s set up your secure Client Portal so you can add details, upload documents, and check progress. Shall I open it now?", openPortal: true },
    { id: 6, prompt: "While you’re in the portal, I’ll stay here to guide you. You can come back to the chat anytime using the button in the top-right corner. Please follow the outstanding tasks so we can understand your situation. Once you’ve saved your details, say “done” and we’ll continue." }
  ]
};
const FAQS_DEFAULT: Array<{ q: string; a: string; keywords?: string[] }> = [
  { q: "Credit rating", a: "Changing agreements can affect your credit file for a time, but the aim is to stabilise things and help you move forward.", keywords: ["credit score","credit rating","credit file"] },
  { q: "Loans", a: "We don’t provide loans; our role is to help reduce and clear existing debt rather than add more credit.", keywords: ["loan","borrow"] },
];

/* ---------- load external files if present ---------- */
const SCRIPT = safeLoadJSON("utils/full_script_logic.json", SCRIPT_DEFAULT) as typeof SCRIPT_DEFAULT;
const FAQS = safeLoadJSON("utils/faqs.json", FAQS_DEFAULT) as typeof FAQS_DEFAULT;

/* ---------- helpers ---------- */
const normalize = (s: string) => (s || "").trim().toLowerCase();
const stripPunc = (s: string) => s.replace(/[^\p{L}\p{N}\s£\.]/gu, " ").replace(/\s+/g, " ").trim();
const asUndef = (v: string | null | undefined): string | undefined => (v ?? undefined);

function toTitleCaseName(raw: string): string {
  return raw.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
const NAME_STOPWORDS = new Set([
  "currently","today","there","here","okay","ok","fine","good","great","thanks","thank","hello","hi","hey",
  "evening","morning","afternoon","yes","no","later","buddy","mate","pal"
]);

function looksLikeNameToken(token: string): boolean {
  if (!/^[a-z][a-z'\-]{1,30}$/i.test(token)) return false;
  return !NAME_STOPWORDS.has(token.toLowerCase());
}
function looksLikeNameRaw(raw: string): boolean {
  const t = normalize(raw);
  if (/(^|\s)(hi|hello|hey|good (morning|afternoon|evening)|how are you|you ok)(\s|$)/.test(t)) return false;
  if (/[?@#:/\\0-9]/.test(t)) return false;
  if (t.length < 2 || t.length > 40) return false;
  const tokens = t.split(/\s+/).slice(0, 2);
  if (tokens.length === 0 || tokens.length > 2) return false;
  return tokens.every(looksLikeNameToken);
}

function extractNameFromMessage(msg: string): string | null {
  const s = msg.trim();
  // “my name is X / call me X”
  const p1 = s.match(/\b(my name is|call me)\s+([a-z][a-z\s'\-]{1,40})/i);
  if (p1) {
    const cand = toTitleCaseName(p1[2]);
    const ok = cand.split(/\s+/).every(looksLikeNameToken);
    if (ok) return cand;
  }
  // “i’m/i am/it’s X”
  const p2 = s.match(/\b(i[' ]?m|i am|it[' ]?s)\s+([a-z][a-z'\-]{1,30})(\s+[a-z][a-z'\-]{1,30})?/i);
  if (p2) {
    const cand = toTitleCaseName((p2[2] + " " + (p2[3] || "")).trim());
    const ok = cand.split(/\s+/).every(looksLikeNameToken);
    if (ok) return cand;
  }
  // bare name
  if (looksLikeNameRaw(s)) return toTitleCaseName(s);
  return null;
}

/* ---------- NEW: name sanitiser (avoid echoing profanity) ---------- */
const PROFANE_EXACT = new Set([
  "shit","fuck","fucker","fucking","cunt","bitch","ass","arse","wanker","twat","prick","dick","douche"
]);
// allow legit names that contain those substrings (e.g., Harshit)
const WHITELIST_SUBSTRINGS = ["harshit","harshita","shittu"]; // extend as needed

function sanitiseName(name: string | null): { safeName?: string; flagged: boolean } {
  if (!name) return { flagged: false };
  const raw = name.trim();
  const lower = raw.toLowerCase();

  // allow-list if any safe substring matches
  if (WHITELIST_SUBSTRINGS.some(w => lower.includes(w))) {
    return { safeName: toTitleCaseName(raw), flagged: false };
  }
  // exact token profanity check (per token)
  const tokens = lower.split(/\s+/);
  if (tokens.some(t => PROFANE_EXACT.has(t))) {
    return { flagged: true };
  }
  return { safeName: toTitleCaseName(raw), flagged: false };
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
function greetVariant(user: string, name?: string): string {
  const t = normalize(user);
  const timey = /good (morning|afternoon|evening)/.exec(t)?.[0];
  const withName = name ? ` ${name}` : "";
  if (timey) return `${timey.replace(/\b\w/g, c => c.toUpperCase())}! Nice to meet you${withName}.`;
  if (/how are you/.test(t)) return `I’m good, thanks — and it’s great to meet you${withName}. I’m here to help.`;
  return `Hi${withName}!`;
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

/* ---------- derive state from history ---------- */
type Derived = {
  askedName: boolean;
  haveName: boolean; name?: string;
  haveConcern: boolean;
  monthly?: number; affordable?: number;
  askedUrgent: boolean; urgentAnswered: boolean;
  ackShown: boolean; ackAccepted: boolean;
  invitedPortal: boolean; portalOpened: boolean; portalDeclined: boolean;
  lastBot?: string;
};
function deriveState(history: string[], latest: string): Derived {
  const h = history.map(x => String(x));
  const full = h.join("\n");
  const latestStripped = stripPunc(latest.toLowerCase());

  const lastBot = h.length ? h[h.length - 1] : undefined;
  const askedName = history.some(x => x.includes(SCRIPT.steps[0].prompt));

  // Name (scan last few lines and current)
  let name: string | undefined;
  for (const line of history.slice(-6)) {
    const n = extractNameFromMessage(line);
    if (n) { name = n; break; }
  }
  if (!name) {
    const n2 = extractNameFromMessage(latest);
    if (n2) name = n2;
  }
  const haveName = !!name;

  // Concern keywords
  const concern = /(bailiff|default|ccj|missed|interest|charges|arrears|rent|council|gas|electric|card|loan|overdraft|catalogue|finance|curious|better deal)/i.test(full + "\n" + latestStripped);

  // Money window (last 10 lines + latest)
  let monthly: number | undefined;
  let affordable: number | undefined;
  const linesToScan = history.concat(latest).slice(-10);
  for (const line of linesToScan) {
    const ln = line.toLowerCase();
    if (/afford|affordable|can manage|could do/.test(ln)) {
      const nums = extractMoney(ln);
      if (nums.length) affordable = nums[0];
    }
    if (/(pay|repay|towards|per month|monthly)/.test(ln)) {
      const nums = extractMoney(ln);
      if (nums.length) {
        monthly = Math.max(...nums);
        if (nums.length >= 2) affordable = Math.min(...nums);
      }
    }
  }

  const askedUrgent = /anything urgent.*(enforcement|bailiff|court|default|priority)/i.test(full);
  const urgentAnswered = askedUrgent && /\b(no|none|nothing|not really|yes|bailiff|ccj|default|missed|council tax)\b/i.test(full + " " + latestStripped);

  const ackShown = /no obligation.*moneyhelper/i.test(full);
  const ackAccepted = ackShown && /\b(yes|ok|okay|carry on|continue|proceed|yep|sure)\b/i.test(full + " " + latestStripped);

  const invitedPortal = /secure Client Portal/i.test(full);
  const portalOpened = invitedPortal && /\b(yes|ok|okay|open|go ahead|please do|sure)\b/i.test(full + " " + latestStripped);
  const portalDeclined = invitedPortal && /\b(no|not now|later|do it later|another time)\b/i.test(full + " " + latestStripped);

  return { askedName, haveName, name, haveConcern: concern, monthly, affordable, askedUrgent, urgentAnswered, ackShown, ackAccepted, invitedPortal, portalOpened, portalDeclined, lastBot };
}

/* ---------- script driver ---------- */
function personalise(prompt: string, name?: string): string {
  if (!name) return prompt;
  if (prompt.startsWith("Just so I can point you in the right direction")) {
    return prompt.replace("direction,", `direction, ${name},`);
  }
  if (prompt.startsWith("Thanks — roughly how much do you pay")) {
    return `Thanks, ${name} — roughly how much do you pay towards all debts each month, and what would feel affordable for you?`;
  }
  if (prompt.startsWith("Understood. Is there anything urgent")) {
    return `Understood, ${name}. Is there anything urgent like enforcement/bailiff action, court or default notices, or missed priority bills (rent, council tax, utilities)?`;
  }
  if (prompt.startsWith("Before we proceed")) {
    return `Before we proceed, ${name}, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?`;
  }
  return prompt;
}

function nextPrompt(d: Derived): string {
  if (!d.haveName) return SCRIPT.steps[0].prompt;
  if (!d.haveConcern) return SCRIPT.steps[1].prompt;

  if (d.monthly == null && d.affordable == null) return SCRIPT.steps[2].prompt;
  if (d.monthly == null && d.affordable != null) return "Thanks — and roughly how much are you currently paying across all debts each month?";
  if (d.monthly != null && d.affordable == null) return "Thanks — and what would feel affordable for you each month?";

  if (!d.askedUrgent || !d.urgentAnswered) return SCRIPT.steps[3].prompt;

  if (!d.ackAccepted) return SCRIPT.steps[4].prompt;

  if (!d.invitedPortal) return SCRIPT.steps[5].prompt;

  if (d.portalDeclined) {
    return "No problem — we can keep chatting and I’ll guide you step by step. Would you like a quick summary of options based on what you’ve told me so far?";
  }

  if (d.invitedPortal && !d.portalOpened) {
    return "Whenever you’re ready just say “open portal”. Meanwhile, would you like a quick summary of options?";
  }

  return SCRIPT.steps[6].prompt;
}

/* ---------- summaries ---------- */
function buildQuickSummary(d: Derived): string {
  const monthly = d.monthly ?? undefined;
  const affordable = d.affordable ?? undefined;

  const saving = (monthly && affordable && monthly > affordable) ? ` (targeting a reduction from ~£${monthly.toFixed(0)} to ~£${affordable.toFixed(0)})` : "";
  const urgent = d.urgentAnswered ? "" : " We’ll also check if anything urgent needs priority protection.";
  return [
    "Here’s a quick summary of options:",
    "• DMP: an informal plan to reduce payments and freeze interest where possible; flexible and can be adjusted.",
    "• IVA (if suitable): a formal agreement that can stop interest/charges and may write off a portion of debt after fixed affordable payments.",
    "• Self-help/negotiation: we can help you contact creditors with affordable offers.",
    "• Bankruptcy/DRO (where appropriate): we’ll explain fully if those are relevant.",
    `We’ll tailor the choice to your disposable income${saving}.${urgent}`
  ].join(" ");
}

/* ---------- compose reply ---------- */
function stitchReply(user: string, d: Derived): { reply: string; openPortal?: boolean; displayName?: string } {
  const parts: string[] = [];

  // potential name & sanitise
  const rawPossible = extractNameFromMessage(user); // string | null
  const { safeName: possibleName, flagged: nameFlagged } = sanitiseName(rawPossible);

  // small talk
  if (isSmallTalk(user)) parts.push(greetVariant(user, asUndef(possibleName ?? d.name)));

  // if we just captured a name and it’s safe, greet and anchor
  if (!d.haveName && possibleName) {
    parts.push(`Nice to meet you, ${possibleName}.`);
  }
  // if we captured a profane exact token as a “name”, handle gently
  if (!d.haveName && nameFlagged) {
    parts.push("I might have misheard your name — what would you like me to call you?");
    // Do not proceed to next stages until we have a clean name
    parts.push(SCRIPT.steps[0].prompt);
    return { reply: parts.join(" "), openPortal: false, displayName: asUndef(d.name) };
  }

  // empathy + faq (best effort)
  const empathy = empatheticAck(user);
  if (empathy) parts.push(empathy);
  const faq = faqAnswer(user);
  if (faq) parts.push(faq);

  // Handle explicit "yes" to a quick-summary question from previous bot line
  const saidYes = /\b(yes|ok|okay|sure|please|go ahead|yep)\b/i.test(user);
  const prevAskedSummary = d.lastBot && /quick summary of options/i.test(d.lastBot);
  if (saidYes && prevAskedSummary) {
    parts.push(buildQuickSummary(d));
    const tail = nextPrompt({ ...d, haveName: d.haveName || !!possibleName, name: asUndef(d.name ?? possibleName) });
    if (!/quick summary of options/i.test(tail)) parts.push(tail);
    return { reply: parts.join(" "), openPortal: false, displayName: asUndef(d.name ?? possibleName) };
  }

  // drive the script (personalised)
  const prompt = personalise(
    nextPrompt({ ...d, haveName: d.haveName || !!possibleName, name: asUndef(d.name ?? possibleName) }),
    asUndef(d.name ?? possibleName)
  );
  parts.push(prompt);

  // explicit portal controls
  const wantsOpen = /\b(open (the )?portal|yes open|open please)\b/i.test(user) || (/\b(yes|ok|okay|sure|go ahead|please do)\b/i.test(user) && /secure Client Portal/i.test(prompt));
  const saysNo = /\b(no|not now|later|do it later|another time)\b/i.test(user);
  const isPortalInvite = /secure Client Portal/i.test(prompt);

  const openPortal = (isPortalInvite && wantsOpen) || (!isPortalInvite && wantsOpen && d.ackAccepted);

  if (/\bdone\b/i.test(user) && !d.portalOpened) {
    parts.push("I haven’t opened the portal yet. I can open it any time — just say “open portal”.");
  }

  return { reply: parts.join(" "), openPortal, displayName: asUndef(d.name ?? possibleName) };
}

/* ---------- handler ---------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") return res.status(200).json({ ok: true });
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const userMessage = String(body.userMessage ?? "").trim();
    const history: string[] = Array.isArray(body.history) ? body.history.map(String) : [];

    // reset
    if (/^\s*(reset|restart|start over)\s*$/i.test(userMessage)) {
      return res.status(200).json({ reply: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" });
    }

    const derived = deriveState(history, userMessage);
    const out = stitchReply(userMessage, derived);
    return res.status(200).json(out);
  } catch {
    return res.status(200).json({ reply: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" });
  }
}

