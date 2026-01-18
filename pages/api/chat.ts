import type { NextApiRequest, NextApiResponse } from "next";

type Data = {
  reply: string;
  openPortal?: boolean;
  displayName?: string;
};

/* -------------------- Helpers & constants -------------------- */
const YES = /\b(yes|yeah|yep|ok|okay|sure|please|go ahead|open|start)\b/i;
const NO  = /\b(no|not now|later|maybe later|dont|don't|do not)\b/i;

const MONEYHELPER_ACK =
  "Before we proceed, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?";

const BANNED_NAME_PATTERNS = [
  /\b(fuck|f\W*ck|shit|crap|twat|dick|wank|cunt|bitch)\b/i,
];

const GREETINGS = [
  /\b(hi|hello|hey|hiya)\b/i,
  /\bgood (morning|afternoon|evening)\b/i,
  /\bhow are (you|u)\b/i,
];

function norm(s: string) { return (s || "").trim(); }
function hasGreeting(s: string) { return GREETINGS.some(r => r.test(s)); }
function greetingText(s: string) {
  const m = s.match(/\bgood (morning|afternoon|evening)\b/i);
  return m ? `Good ${m[1].toLowerCase()}!` : /how are/i.test(s) ? "I’m good, thanks!" : "Hi!";
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

// name capture with safety & false-positive filters
function pickName(s: string): string | null {
  const m =
    s.match(/\b(?:i['\s]*m|i am|my name is|call me|it's|its)\s+([a-z][a-z'\- ]{1,30})\b/i) ||
    s.match(/^\s*([A-Z][a-z'\-]{1,30})\s*$/);
  const raw = m?.[1]?.trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^a-z'\- ]/gi, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (BANNED_NAME_PATTERNS.some(p => p.test(cleaned))) return null;

  const lower = cleaned.toLowerCase();
  const nonNames = new Set(["credit","loan","loans","cards","card","debt","debts","hello","hi","hey","evening","morning","afternoon","good"]);
  if (nonNames.has(lower)) return null;

  return cleaned.split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/* ---------- “Have we asked” detectors (anchor on our own phrasing) ---------- */
function anyLine(lines: string[], rx: RegExp) { return lines.some(line => rx.test(line)); }

const askedNameRX     = /can I take your first name\?/i;
const askedConcernRX  = /what would you say your main concern is with the debts\?/i;
const askedAmountsRX  = /how much do you pay.*each month.*what would feel affordable/i;
const askedUrgentRX   = /is there anything urgent.*(enforcement|bailiff|court|default|priority bills)/i;
const askedAckRX      = /there’s no obligation.*moneyhelper.*shall we carry on\?/i;
const askedPortalRX   = /shall I open.*client portal.*now\?/i;
const portalGuideRX   = /while you’re in the portal, I’ll stay here to guide you/i;
const askedDocsRX     = /please upload:?\s*•?\s*proof of id/i;
const askedSummaryRX  = /would you like a quick summary of options/i;

function seenName(lines: string[]): string | null {
  // prefer our own greeting line
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/Nice to meet you,\s+([A-Z][a-z'\- ]{1,30})/i);
    if (m) return m[1].trim();
  }
  // fallback: last declared name
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = pickName(lines[i]);
    if (n) return n;
  }
  return null;
}

/* -------------------- Handler -------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST") return res.status(405).json({ reply: "Method not allowed." });

  const { userMessage = "", history = [], sessionId } = (req.body || {}) as {
    userMessage?: string;
    history?: string[];
    sessionId?: string;
  };

  // Evaluate state on PRIOR history only (exclude current user turn)
  const historyPrior = history.slice(0, Math.max(0, history.length - 1));
  const text = norm(String(userMessage || ""));
  const lower = text.toLowerCase();

  /* -------------------- Small-talk first -------------------- */
  const haveNameAlready = !!seenName(historyPrior);
  const nameWasAsked    = anyLine(historyPrior, askedNameRX);

  if (hasGreeting(text)) {
    const greet = greetingText(text);
    if (!haveNameAlready) {
      // If we haven't asked for name yet OR we asked and they replied with more small-talk,
      // respond naturally and (re-)ask for a first name, no “misheard” wording.
      if (!nameWasAsked) {
        return res.status(200).json({
          reply: `${greet} I’m here to help. To get started, what first name should I use?`,
        });
      } else {
        return res.status(200).json({
          reply: `${greet} Just so I address you properly, what first name should I use?`,
        });
      }
    } else {
      // We already know their name; acknowledge and push forward smoothly.
      return res.status(200).json({
        reply: `${greet} Let’s keep going — what would you say your main concern is with the debts?`,
      });
    }
  }

  /* -------------------- Step 0: Name -------------------- */
  if (!haveNameAlready && !nameWasAsked) {
    return res.status(200).json({
      reply: "Hi! I’m here to help. To get started, what first name should I use?",
    });
  }

  const nameNow = pickName(text);
  if (!haveNameAlready && nameWasAsked) {
    if (nameNow) {
      const salute = /mark\b/i.test(nameNow) ? " — nice to meet a fellow Mark!" : "";
      return res.status(200).json({
        reply:
          `Nice to meet you, ${nameNow}${salute}. ` +
          "Just so I can point you in the right direction, what would you say your main concern is with the debts?",
        displayName: nameNow,
      });
    }
    // They didn’t give a usable name — gently re-ask (no “misheard”)
    return res.status(200).json({
      reply: "No worries — what first name should I use?",
    });
  }

  /* -------------------- Step 1: Concern -------------------- */
  if (!anyLine(historyPrior, askedConcernRX)) {
    return res.status(200).json({
      reply: "Just so I can point you in the right direction, what would you say your main concern is with the debts?",
    });
  }
  if (anyLine(historyPrior, askedConcernRX) && !anyLine(historyPrior, askedAmountsRX)) {
    return res.status(200).json({
      reply:
        "Thanks — roughly how much do you pay towards all debts each month, and what would feel affordable for you? " +
        `For example, “I pay £600 and could afford £200.”`,
    });
  }

  /* -------------------- Step 2: Amounts (windowed) -------------------- */
  if (anyLine(historyPrior, askedAmountsRX) && !anyLine(historyPrior, askedUrgentRX)) {
    const { current, affordable } = extractAmounts(text);
    const alreadyMentionedNumbers = /\d/.test(historyPrior.slice(-4).join(" "));
    if ((current || affordable) || alreadyMentionedNumbers) {
      return res.status(200).json({
        reply:
          "Understood. Is there anything urgent like enforcement/bailiff action, court or default notices, or missed priority bills (rent, council tax, utilities)?",
      });
    }
    const nudgeSeen = anyLine(historyPrior, /for example, “i pay £600 and could afford £200/i);
    if (!nudgeSeen) {
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

  /* -------------------- Step 3: Urgent -------------------- */
  if (anyLine(historyPrior, askedUrgentRX) && !anyLine(historyPrior, askedAckRX)) {
    return res.status(200).json({ reply: MONEYHELPER_ACK });
  }

  /* -------------------- Step 4: Acknowledgement → yes/no → portal offer -------------------- */
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
          "No problem — we’ll proceed at your pace. When you’re ready, I can open the portal for you to add details securely. Would you like to open it now?",
      });
    }
    return res.status(200).json({ reply: "Quick check — would you like to carry on? (Yes/No)" });
  }

  /* -------------------- Step 5: Portal (open only on explicit YES) -------------------- */
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
    return res.status(200).json({ reply: "Would you like me to open the secure Client Portal now? (Yes/No)" });
  }

  /* -------------------- Step 6: Portal guide → wait “done” → docs -------------------- */
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

  /* -------------------- Step 7: Docs → Summary/finish -------------------- */
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

  /* -------------------- Step 8: Summary / closing -------------------- */
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

  /* -------------------- Lightweight FAQ nudges (don’t derail steps) -------------------- */
  if (/\bcar\b/i.test(lower) && /\blose|keep\b/i.test(lower)) {
    return res.status(200).json({
      reply: "Most people keep their car. If repayments are very high, we’ll discuss affordable options — keeping essentials is the priority.",
    });
  }
  if (/\bmortgage\b/i.test(lower)) {
    return res.status(200).json({
      reply: "Mortgage applications are often easier after your plan completes, but you can explore options anytime with specialist advice.",
    });
  }
  if (/\bcredit (score|rating|file)\b/i.test(lower)) {
    return res.status(200).json({
      reply: "Your credit file can be affected for a while, but the aim is to stabilise things and move forward. We’ll talk through the trade-offs clearly.",
    });
  }

  /* -------------------- Final gentle nudge -------------------- */
  return res.status(200).json({
    reply: "If you’re ready, I can open your secure portal now — or we can keep chatting and I’ll guide you.",
  });
}
