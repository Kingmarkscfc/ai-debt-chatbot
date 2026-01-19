import type { NextApiRequest, NextApiResponse } from "next";

type Data = { reply: string; openPortal?: boolean; displayName?: string };

/* -------------------- Small helpers -------------------- */
const norm = (s: string) => (s || "").trim();
const YES = /\b(yes|yeah|yep|ok|okay|sure|please|go ahead|open|start|do it)\b/i;
const NO  = /\b(no|not now|later|maybe later|dont|don't|do not|nah)\b/i;

function nowGreeting(): string {
  try {
    const d = new Date();
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hour12: false,
      timeZone: "Europe/London"
    }).format(d));
    if (hour >= 5 && hour < 12) return "Good morning";
    if (hour >= 12 && hour < 17) return "Good afternoon";
    return "Good evening";
  } catch {
    return "Hello";
  }
}

const GREETING_RX = /\b(hi|hello|hey|hiya|good (morning|afternoon|evening)|how are (you|u))\b/i;
const hasGreeting = (s: string) => GREETING_RX.test(s);

/** Light-touch empathy generator from the latest user text */
function empathize(text: string): string {
  const t = text.toLowerCase();
  if (/(credit\s*cards?|loans?|overdraft|catalogue)/i.test(t)) {
    return "That’s a lot to carry — we’ll take this step by step and reduce the pressure.";
  }
  if (/(interest|charges|fees)/i.test(t)) {
    return "High interest and charges can snowball — we’ll focus on stopping that and finding something sustainable.";
  }
  if (/(bailiff|enforcement)/i.test(t)) {
    return "I know enforcement contact is stressful — we’ll look at protections quickly.";
  }
  if (/(ccj|county court|default)/i.test(t)) {
    return "Court or default letters can be worrying — we’ll address that in your plan.";
  }
  if (/(rent|council\s*tax|utilities|gas|electric|water)/i.test(t)) {
    return "We’ll make sure essentials like housing and utilities are prioritised first.";
  }
  if (/(struggl|worri|stress|anx)/i.test(t)) {
    return "Thanks for sharing — we’ll keep things practical and judgment-free.";
  }
  return "Thanks for telling me that — we’ll keep things simple and focused on solutions.";
}

/** Short confirmation when the user mentions urgent items */
function confirmUrgent(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bcouncil\s*tax\b/.test(t)) {
    return "Noted on the council tax — we’ll prioritise that alongside rent and utilities.";
  }
  if (/\brent\b/.test(t)) return "Got it on rent — we’ll protect essentials first.";
  if (/\b(bailiff|enforcement)\b/.test(t)) return "Understood — we’ll aim to stop enforcement pressure as soon as possible.";
  if (/\b(ccj|county court|default)\b/.test(t)) return "Thanks — I’ll factor the court/default side into the plan.";
  return null;
}

function currencyToNumber(s: string): number {
  const cleaned = s.replace(/[^\d.]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}
function extractAmounts(text: string): { current?: number; affordable?: number } {
  const parts = (text.match(/£?\s*(\d{1,3}(?:[,\s]\d{3})*|\d+)(?:\.\d{1,2})?/g) || [])
    .map(m => currencyToNumber(m));
  if (parts.length === 0) return {};
  if (parts.length === 1) return { current: parts[0] };
  return { current: parts[0], affordable: parts[1] };
}

/* -------------------- Name parsing (polite & safe) -------------------- */
const BANNED_NAME_PATTERNS = [
  /\b(fuck|f\W*ck|shit|crap|twat|dick|wank|cunt|bitch)\b/i,
];

function pickName(s: string): string | null {
  const m =
    s.match(/\b(?:i['\s]*m|i am|my name is|call me|it's|its)\s+([a-z][a-z'\- ]{1,30})\b/i) ||
    s.match(/^\s*([A-Za-z][A-Za-z'\- ]{1,30})\s*$/);

  const raw = m?.[1]?.trim();
  if (!raw) return null;

  const cleaned = raw.replace(/[^a-z'\- ]/gi, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (BANNED_NAME_PATTERNS.some(p => p.test(cleaned))) return null;

  const lower = cleaned.toLowerCase();
  const nonNames = new Set([
    "credit","loan","loans","cards","card","debt","debts",
    "hello","hi","hey","evening","morning","afternoon","good"
  ]);
  if (nonNames.has(lower)) return null;

  return cleaned
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/* -------------------- Anchors for “we already asked this” -------------------- */
const anyLine = (lines: string[], rx: RegExp) => lines.some(line => rx.test(line));

const askedNameRX      = /(can you let me know who i’m speaking with\?|can you let me know who i'm speaking with\?)/i;
const askedConcernRX   = /what would you say your main concern is with the debts\?/i;
const askedAmountsRX   = /how much do you pay.*each month.*what would feel affordable/i;
const askedUrgentRX    = /is there anything urgent.*(enforcement|bailiff|court|default|priority bills)/i;
const askedAckRX       = /there’s no obligation.*moneyhelper.*shall we carry on\?/i;

const askedPortalRX = new RegExp(
  [
    "shall I open.*client portal.*now\\?",
    "would you like me to open.*client portal.*now\\?",
    "would you like to open.*client portal.*now\\?",
    "I can set up your secure Client Portal.*Shall I open it now\\?"
  ].join("|"),
  "i"
);
const portalGuideRX  = /while you’re in the portal, I’ll stay here to guide you/i;
const askedDocsRX    = /please upload:?\s*•?\s*proof of id/i;
const askedSummaryRX = /would you like a quick summary of options/i;

function seenName(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/Nice to meet you,\s+([A-Z][a-z'\- ]{1,30})/i);
    if (m) return m[1].trim();
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = pickName(lines[i]);
    if (n) return n;
  }
  return null;
}

const MONEYHELPER_ACK =
  "Before we proceed, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?";

/* -------------------- Handler -------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST") return res.status(405).json({ reply: "Method not allowed." });

  const { userMessage = "", history = [] } = (req.body || {}) as {
    userMessage?: string;
    history?: string[];
  };

  const text = norm(String(userMessage || ""));
  const lower = text.toLowerCase();
  const historyPrior = history.slice(0, Math.max(0, history.length - 1));
  const nameKnown = !!seenName(historyPrior);

  /* -------- Greeting / small-talk (time-aware; doesn’t advance incorrectly) -------- */
  if (hasGreeting(text)) {
    const greet = nowGreeting();
    if (!nameKnown) {
      return res.status(200).json({
        reply: `${greet}! I’m here to help. Can you let me know who I’m speaking with?`,
      });
    } else {
      return res.status(200).json({
        reply: `${greet}! ${empathize(text)} What would you say your main concern is with the debts?`,
      });
    }
  }

  /* --------------------------------- Step 0: Name --------------------------------- */
  const nameWasAsked = anyLine(historyPrior, askedNameRX);
  if (!nameKnown && !nameWasAsked) {
    return res.status(200).json({
      reply: "Hi — I’m here to help. Can you let me know who I’m speaking with?",
    });
  }

  if (!nameKnown && nameWasAsked) {
    const nameNow = pickName(text);
    if (nameNow) {
      const salute = /mark\b/i.test(nameNow) ? " — nice to meet a fellow Mark!" : "";
      return res.status(200).json({
        reply:
          `Nice to meet you, ${nameNow}${salute}. ${empathize(userMessage)} ` +
          "Just so I can point you in the right direction, what would you say your main concern is with the debts?",
        displayName: nameNow,
      });
    }
    return res.status(200).json({
      reply: "No worries — please share a first name you’re happy with and we’ll continue.",
    });
  }

  /* ----------------------- Step 1: Concern ----------------------- */
  if (!anyLine(historyPrior, askedConcernRX)) {
    return res.status(200).json({
      reply: "Just so I can point you in the right direction, what would you say your main concern is with the debts?",
    });
  }
  if (anyLine(historyPrior, askedConcernRX) && !anyLine(historyPrior, askedAmountsRX)) {
    return res.status(200).json({
      reply:
        `${empathize(userMessage)} ` +
        "Thanks — roughly how much do you pay towards all debts each month, and what would feel affordable for you? " +
        "For example, “I pay £600 and could afford £200.”",
    });
  }

  /* ---------------- Step 2: Amounts (windowed) ---------------- */
  if (anyLine(historyPrior, askedAmountsRX) && !anyLine(historyPrior, askedUrgentRX)) {
    const { current, affordable } = extractAmounts(text);
    const numbersRecently = /\d/.test(historyPrior.slice(-4).join(" "));
    if ((current || affordable) || numbersRecently) {
      return res.status(200).json({
        reply:
          "Understood. Is there anything urgent like enforcement/bailiff action, court or default notices, or missed priority bills (rent, council tax, utilities)?",
      });
    }
    const nudged = anyLine(historyPrior, /for example, “i pay £600 and could afford £200/i);
    if (!nudged) {
      return res.status(200).json({
        reply:
          "Could you share your monthly total towards debts and a figure that would feel affordable? e.g., “I pay £600, could afford £200.”",
      });
    }
    return res.status(200).json({
      reply:
        "No problem — we can estimate as we go. Is there anything urgent like enforcement/bailiff action, court or default notices, or missed priority bills (rent, council tax, utilities)?",
    });
  }

  /* -------------------------- Step 3: Urgent -------------------------- */
  if (anyLine(historyPrior, askedUrgentRX) && !anyLine(historyPrior, askedAckRX)) {
    const confirm = confirmUrgent(userMessage);
    const lead = confirm ? `${confirm} ` : "";
    return res.status(200).json({ reply: `${lead}${MONEYHELPER_ACK}` });
  }

  /* -------- Step 4: Acknowledgement → then offer portal (explicit YES) -------- */
  if (anyLine(historyPrior, askedAckRX) && !anyLine(historyPrior, askedPortalRX)) {
    if (YES.test(lower)) {
      return res.status(200).json({
        reply:
          "Great — let’s keep going. I can set up your secure Client Portal so you can add details, upload documents, and check progress. Shall I open it now?",
      });
    }
    if (NO.test(lower)) {
      return res.status(200).json({
        reply:
          "No problem — we’ll proceed at your pace. When you’re ready, I can open the portal for you to add details securely. " +
          "Would you like me to open it now?",
      });
    }
    return res.status(200).json({ reply: "Quick check — would you like to carry on? (Yes/No)" });
  }

  /* ----- Step 5: Portal decision (recognise ALL offer phrasings) ----- */
  if (anyLine(historyPrior, askedPortalRX) && !anyLine(historyPrior, portalGuideRX)) {
    if (YES.test(lower)) {
      return res.status(200).json({
        reply:
          "Opening your portal now. While you’re in the portal, I’ll stay here to guide you. " +
          "You can come back to the chat anytime using the button in the top-right corner. " +
          "Please follow the outstanding tasks so we can understand your situation. " +
          "Once you’ve saved your details, say “done” and we’ll continue.",
        openPortal: true,
      });
    }
    if (NO.test(lower)) {
      return res.status(200).json({
        reply:
          "No worries — we can keep chatting and I’ll guide you step by step. Would you like a quick summary of options based on what you’ve told me so far?",
      });
    }
    return res.status(200).json({
      reply: "Would you like me to open the secure Client Portal now? (Yes/No)",
    });
  }

  /* ---- Step 6: Portal guide → wait for “done” → then docs request ---- */
  if (anyLine(historyPrior, portalGuideRX) && !anyLine(historyPrior, askedDocsRX)) {
    if (/\b(done|saved|submitted|uploaded|finished|complete)\b/i.test(lower)) {
      return res.status(200).json({
        reply:
          "Great — to assess the best solution and potentially save you money each month, please upload: " +
          "• Proof of ID • Last 3 months’ bank statements • Payslips (3 months or 12 weeks if weekly) if employed • " +
          "Last year’s tax return if self-employed • Universal Credit statements (12 months + latest full statement) if applicable • " +
          "Car finance docs if applicable • Any creditor letters or statements.",
      });
    }
    return res.status(200).json({
      reply: "Take your time in the portal. When you’ve saved your details, say “done” and we’ll continue.",
    });
  }

  /* --------------- Step 7: Docs → Summary / finish --------------- */
  if (anyLine(historyPrior, askedDocsRX) && !anyLine(historyPrior, askedSummaryRX)) {
    if (/\b(done|uploaded|finished|complete)\b/i.test(lower)) {
      return res.status(200).json({
        reply:
          "Brilliant — our assessment team will now review your case and come back with next steps. " +
          "You can check progress in your portal anytime. Is there anything else you’d like to ask before we wrap up?",
      });
    }
    return res.status(200).json({
      reply:
        "No problem — you can upload documents whenever you’re ready via the 📎 in chat or inside the portal. " +
        "Would you like a quick summary of options so far?",
    });
  }

  /* --------------- Step 8: Summary handling --------------- */
  if (anyLine(historyPrior, askedSummaryRX)) {
    if (YES.test(lower)) {
      return res.status(200).json({
        reply:
          "Quick summary:\n" +
          "• We’ll protect essentials (rent, council tax, utilities).\n" +
          "• We’ll look at solutions that can freeze interest/charges and reduce monthly cost.\n" +
          "• Your portal is the fastest way to complete details and upload proofs.\n" +
          "Anything else on your mind before we close?",
      });
    }
    if (NO.test(lower)) {
      return res.status(200).json({
        reply: "Okay — I’m here if anything else comes up. You can return anytime.",
      });
    }
    return res.status(200).json({
      reply: "I’ll stay available here. If you’d like that quick summary, just say “summary”, or type any question.",
    });
  }

  /* -------------------- Lightweight FAQ nudges -------------------- */
  if (/\bcar\b/i.test(lower) && /\blose|keep\b/i.test(lower)) {
    return res.status(200).json({
      reply:
        "Most people keep their car. If repayments are very high, we’ll discuss affordable options — keeping essentials is the priority.",
    });
  }
  if (/\bmortgage\b/i.test(lower)) {
    return res.status(200).json({
      reply:
        "Mortgage applications are often easier after your plan completes, but you can explore options anytime with specialist advice.",
    });
  }
  if (/\bcredit (score|rating|file)\b/i.test(lower)) {
    return res.status(200).json({
      reply:
        "Your credit file can be affected for a while, but the aim is to stabilise things and move forward. We’ll talk through the trade-offs clearly.",
    });
  }

  /* -------------------- Final gentle nudge (safe default) -------------------- */
  return res.status(200).json({
    reply: "If you’re ready, I can open your secure portal now — or we can keep chatting and I’ll guide you.",
  });
}
