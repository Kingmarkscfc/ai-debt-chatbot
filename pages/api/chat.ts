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

/* ---------- defaults ---------- */
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

/* ---------- word lists ---------- */
const NAME_STOPWORDS = new Set([
  "currently","today","there","here","okay","ok","fine","good","great","thanks","thank","hello","hi","hey",
  "evening","morning","afternoon","yes","no","later","buddy","mate","pal","please"
]);
const DEBT_WORDS = new Set([
  "credit","card","cards","loan","loans","overdraft","catalogue","finance","debts","debt","arrears","interest","charges","repayments","repayment","bills","council","tax","utilities"
]);
const GENERIC_TOPICS = new Set([
  "help","advice","support","money","budget","income","expenditure","situation","problem","issue","issues","worry","concern","concerns"
]);

/* ---------- profanity rules for names ---------- */
const PROFANE_EXACT = new Set([
  "shit","fuck","fucker","fucking","cunt","bitch","ass","arse","wanker","twat","prick","dick","douche","crap" // added "crap"
]);
// allow legit names that contain those substrings (e.g., Harshit)
const WHITELIST_SUBSTRINGS = ["harshit","harshita","shittu"];

function isProfaneExactToken(token: string): boolean {
  return PROFANE_EXACT.has(token.toLowerCase());
}
function isWhitelistedNameLike(s: string): boolean {
  const t = s.toLowerCase();
  return WHITELIST_SUBSTRINGS.some(w => t.includes(w));
}

/* ---------- name utilities ---------- */
function toTitleCaseName(raw: string): string {
  return raw.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
function looksLikeNameToken(token: string): boolean {
  if (!/^[a-z][a-z'\-]{1,30}$/i.test(token)) return false;
  if (NAME_STOPWORDS.has(token.toLowerCase())) return false;
  if (DEBT_WORDS.has(token.toLowerCase())) return false;
  if (GENERIC_TOPICS.has(token.toLowerCase())) return false;
  return true;
}

/* STRICT name capture */
function extractNameFromMessage(msg: string): string | null {
  const s = msg.trim();
  const sNorm = normalize(s);

  // if the line contains any debt/generic keywords, don't treat as a name line
  const tokensAll = sNorm.split(/\s+/);
  if (tokensAll.some(t => DEBT_WORDS.has(t) || GENERIC_TOPICS.has(t))) {
    return null;
  }

  const explicitRe = /\b(my name is|call me|i[' ]?m|i am|it[' ]?s)\s+([a-z][a-z'\-]{1,30})(\s+[a-z][a-z'\-]{1,30})?/i;
  const m = s.match(explicitRe);
  if (m) {
    const first = m[2];
    const last = (m[3] || "").trim();
    const parts = last ? [first, last] : [first];
    if (parts.every(looksLikeNameToken)) return toTitleCaseName(parts.join(" "));
    return null;
  }

  // bare-name acceptance ONLY for a single token that looks like a first name
  const bare = s.replace(/[^a-z'\- ]/gi, " ").trim();
  const parts = bare.split(/\s+/).filter(Boolean);
  if (parts.length === 1 && looksLikeNameToken(parts[0])) {
    return toTitleCaseName(parts[0]);
  }

  return null;
}

/* Sanitise a captured name */
function sanitiseName(name: string | null): { safeName?: string; flagged: boolean } {
  if (!name) return { flagged: false };
  const raw = name.trim();
  const lower = raw.toLowerCase();

  if (isWhitelistedNameLike(lower)) {
    return { safeName: toTitleCaseName(raw), flagged: false };
  }
  const tokens = lower.split(/\s+/);
  if (tokens.some(t => isProfaneExactToken(t))) {
    return { flagged: true };
  }
  return { safeName: toTitleCaseName(raw), flagged: false };
}

/* ---------- small helpers ---------- */
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

/* ---------- derive + name re-ask counting ---------- */
type Derived = {
  askedName: boolean;
  haveName: boolean; name?: string;
  nameFlagged: boolean;
  haveConcern: boolean;
  monthly?: number; affordable?: number;
  askedUrgent: boolean; urgentAnswered: boolean;
  ackShown: boolean; ackAccepted: boolean;
  invitedPortal: boolean; portalOpened: boolean; portalDeclined: boolean;
  lastBot?: string;
  nameReaskCount: number; // NEW
};
function countNameReasks(history: string[]): number {
  const patterns = [
    /i might have misheard your name/i,
    /just a first name is fine/i,
    /no worries — just tell me a first name/i,
    /please share a first name/i,
    /what would you like me to call you\?/i
  ];
  return history.reduce((acc, line) => acc + (patterns.some(r => r.test(line)) ? 1 : 0), 0);
}
function deriveState(history: string[], latest: string): Derived {
  const h = history.map(x => String(x));
  const full = h.join("\n");
  const latestStripped = stripPunc(latest.toLowerCase());

  const lastBot = h.length ? h[h.length - 1] : undefined;
  const askedName = history.some(x => x.includes(SCRIPT.steps[0].prompt));

  // Name (scan last few lines and current) + sanitise
  let rawName: string | undefined;
  for (const line of history.slice(-6)) {
    const n = extractNameFromMessage(line);
    if (n) { rawName = n; break; }
  }
  if (!rawName) {
    const n2 = extractNameFromMessage(latest);
    if (n2) rawName = n2;
  }
  const { safeName: histSafeName, flagged: histFlagged } = sanitiseName(rawName ?? null);
  const name = histFlagged ? undefined : histSafeName;
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

  const nameReaskCount = countNameReasks(history);

  return { askedName, haveName, name, nameFlagged: histFlagged, haveConcern: concern, monthly, affordable, askedUrgent, urgentAnswered, ackShown, ackAccepted, invitedPortal, portalOpened, portalDeclined, lastBot, nameReaskCount };
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

/* ---------- re-ask name variants ---------- */
function nameReaskVariant(count: number): string {
  if (count <= 0) return "I might have misheard your name — what would you like me to call you? (A first name is perfect.)";
  if (count === 1) return "No worries — just tell me a first name to use (e.g., Sam).";
  if (count === 2) return "Please share a first name you’re happy with and we’ll continue.";
  // 3+ : move on gracefully (no loop)
  return "I’ll call you ‘Friend’ for now so we can keep going. If you prefer a different name later, just say: “Call me …”.";
}

/* ---------- compose reply ---------- */
function stitchReply(user: string, d: Derived): { reply: string; openPortal?: boolean; displayName?: string } {
  const parts: string[] = [];

  // potential name & sanitise (fresh input)
  const rawPossible = extractNameFromMessage(user);
  const freshSan = sanitiseName(rawPossible);
  const possibleName = freshSan.flagged ? undefined : freshSan.safeName;

  // If user just provided a profane "name", vary re-ask and then stop re-asking after a few tries
  if (!d.haveName && freshSan.flagged) {
    const variant = nameReaskVariant(d.nameReaskCount);
    // if we’ve already exhausted re-asks, progress to step 1 so we don’t loop on name forever
    if (d.nameReaskCount >= 3) {
      const promptAfter = nextPrompt({ ...d, haveName: true, name: undefined, nameFlagged: false });
      return { reply: `${variant} ${promptAfter}`, openPortal: false, displayName: undefined };
    }
    return { reply: variant, openPortal: false, displayName: asUndef(d.name) };
  }

  // small talk greeting (never echo flagged names)
  const greetName = d.nameFlagged ? undefined : (possibleName ?? d.name);
  if (isSmallTalk(user)) parts.push(greetVariant(user, asUndef(greetName)));

  // if we just captured a safe name, greet and anchor (once)
  if (!d.haveName && possibleName) {
    parts.push(`Nice to meet you, ${possibleName}.`);
  }

  // empathy + faq (best effort)
  const empathy = empatheticAck(user);
  if (empathy) parts.push(empathy);
  const faq = faqAnswer(user);
  if (faq) parts.push(faq);

  // quick-summary acceptance
  const saidYes = /\b(yes|ok|okay|sure|please|go ahead|yep)\b/i.test(user);
  const prevAskedSummary = d.lastBot && /quick summary of options/i.test(d.lastBot);
  if (saidYes && prevAskedSummary) {
    parts.push(buildQuickSummary(d));
    const tail = nextPrompt({ ...d, haveName: d.haveName || !!possibleName, name: asUndef(d.name ?? possibleName), nameFlagged: false });
    if (!/quick summary of options/i.test(tail)) parts.push(tail);
    return { reply: parts.join(" "), openPortal: false, displayName: asUndef(d.name ?? possibleName) };
  }

  // drive the script (personalised)
  const personaName = d.nameFlagged ? undefined : asUndef(d.name ?? possibleName);
  const plannedPrompt = personalise(
    nextPrompt({ ...d, haveName: d.haveName || !!possibleName, name: personaName, nameFlagged: false }),
    personaName
  );

  // anti-repeat guard
  if (d.lastBot && normalize(d.lastBot) === normalize(plannedPrompt)) {
    if (!d.haveName && /who I’m speaking to\?/i.test(plannedPrompt)) {
      parts.push("Just a first name is fine.");
    } else if (/what would you say your main concern/i.test(plannedPrompt)) {
      parts.push("A sentence on your main worry (e.g., interest, missed payments, bailiffs) helps me tailor next steps.");
    } else if (/roughly how much do you pay/i.test(plannedPrompt)) {
      parts.push("You can share two numbers (current monthly and what feels affordable).");
    } else {
      parts.push("Whenever you’re ready, a quick line back is perfect.");
    }
  } else {
    parts.push(plannedPrompt);
  }

  // explicit portal controls
  const wantsOpen = /\b(open (the )?portal|yes open|open please)\b/i.test(user) || (/\b(yes|ok|okay|sure|go ahead|please do)\b/i.test(user) && /secure Client Portal/i.test(plannedPrompt));
  const saysNo = /\b(no|not now|later|do it later|another time)\b/i.test(user);
  const isPortalInvite = /secure Client Portal/i.test(plannedPrompt);

  const openPortal = (isPortalInvite && wantsOpen) || (!isPortalInvite && wantsOpen && d.ackAccepted);

  if (/\bdone\b/i.test(user) && !d.portalOpened) {
    parts.push("I haven’t opened the portal yet. I can open it any time — just say “open portal”.");
  }
  if (isPortalInvite && saysNo) {
    parts.push("No problem — we can keep chatting and I’ll guide you step by step.");
  }

  // if we exhausted name re-asks earlier and progressed, don’t set a fake name
  const displayName = (d.nameReaskCount >= 3 && !personaName) ? undefined : personaName;

  return { reply: parts.join(" "), openPortal, displayName };
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
