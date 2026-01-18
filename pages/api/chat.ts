import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Stateless script engine:
 *  - We infer the current step from prior bot prompts in the text history.
 *  - We "window" each step so we only ask it once; if user doesn't answer clearly, we nudge once and move on.
 *  - We allow side-track FAQ/small-talk but immediately return to the right step.
 */

type Data = {
  reply: string;
  openPortal?: boolean;
  displayName?: string;
};

const BANNED_NAME_PATTERNS = [
  /\b(fuck|f\*+k|f\W*ck|shit|crap|twat|dick|wank|cunt|bitch)\b/i,
];

const SMALL_TALK = [
  /^(hi|hello|hey|hiya)\b/i,
  /\bhow are (you|u)\b/i,
  /\bgood (morning|afternoon|evening)\b/i,
];

const YES = /\b(yes|yeah|yep|ok|okay|sure|please|go ahead|open|start)\b/i;
const NO = /\b(no|not now|later|maybe later|dont|don't|do not)\b/i;

const MONEYHELPER_ACK =
  "Before we proceed, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?";

const STEP_MARKERS = {
  NAME: "§ASK_NAME",
  CONCERN: "§ASK_CONCERN",
  AMOUNTS: "§ASK_AMOUNTS",
  URGENT: "§ASK_URGENT",
  ACK: "§ASK_ACK",
  PORTAL: "§ASK_PORTAL",
  PORTAL_GUIDE: "§PORTAL_GUIDE",
  DOCS: "§ASK_DOCS",
  SUMMARY: "§OFFER_SUMMARY",
} as const;

const EMPATHY_ROTATIONS = [
  "That sounds tough — we’ll take this step by step.",
  "I hear you — let’s make this feel manageable.",
  "Thanks for sharing — we’ll reduce the pressure together.",
  "Understood — we’ll work towards something affordable.",
];

const TRANSITIONS = [
  "To keep things moving,",
  "Next up,",
  "So I can tailor this properly,",
  "To point you the right way,",
];

function rotate(arr: string[], seed: number) {
  return arr[seed % arr.length];
}

function lastBotPromptIndex(history: string[], marker: string): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].includes(marker)) return i;
  }
  return -1;
}

function asked(history: string[], marker: string) {
  return lastBotPromptIndex(history, marker) !== -1;
}

function justAsked(history: string[], marker: string) {
  const idx = lastBotPromptIndex(history, marker);
  return idx === history.length - 1;
}

function alreadyAnswered(history: string[], matcher: RegExp) {
  // Consider last 6 user lines for the answer
  let seen = 0;
  for (let i = history.length - 1; i >= 0 && seen < 12; i--, seen++) {
    const line = history[i];
    if (!line) continue;
    if (matcher.test(line)) return true;
  }
  return false;
}

function pickPossibleName(text: string): string | null {
  // naive capture after "i'm|i am|my name is|call me"
  const m =
    text.match(/\b(?:i['\s]*m|i am|my name is|call me|it's|its)\s+([a-z][a-z'\- ]{1,30})\b/i) ||
    text.match(/^\s*([A-Z][a-z'\-]{1,30})\s*$/);
  const raw = m?.[1]?.trim() || null;
  if (!raw) return null;

  // cleanup
  const name = raw
    .replace(/[^a-z' \-]/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) return null;

  // profanity guard (but allow legit names like "Harshit" if not exact match)
  if (BANNED_NAME_PATTERNS.some((p) => p.test(name))) return null;

  // avoid common non-name phrases sneaking in
  const lower = name.toLowerCase();
  const obviousNonNames = ["credit", "loan", "cards", "debt", "hello", "hi", "hey"];
  if (obviousNonNames.includes(lower)) return null;

  // Title-case
  return name
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function containsSmallTalk(text: string) {
  return SMALL_TALK.some((r) => r.test(text));
}

function containsAmounts(text: string) {
  // capture two numbers like "I pay 1000 and can do 200"
  const nums = text.match(/(\d{1,3}(?:[,\s]\d{3})*|\d+)(?:\.\d{1,2})?/g);
  return (nums?.length || 0) >= 1; // one or two numbers may appear
}

function currencyToNumber(s: string): number {
  const cleaned = s.replace(/[^\d.]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

function extractAmounts(text: string): { current?: number; affordable?: number } {
  // heuristics: the first number tends to be "current", the second "affordable"
  const nums = (text.match(/£?\s*(\d{1,3}(?:[,\s]\d{3})*|\d+)(?:\.\d{1,2})?/g) || []).map((m) =>
    currencyToNumber(m)
  );
  if (nums.length === 0) return {};
  if (nums.length === 1) return { current: nums[0] };
  return { current: nums[0], affordable: nums[1] };
}

function normalise(s: string) {
  return (s || "").toLowerCase();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST") return res.status(405).json({ reply: "Method not allowed." });

  const { userMessage = "", history = [], language, sessionId } = (req.body || {}) as {
    userMessage?: string;
    history?: string[];
    language?: string;
    sessionId?: string;
  };

  const seed = Math.abs((sessionId || "seed").split("").reduce((a, c) => a + c.charCodeAt(0), 0));

  const text = String(userMessage || "").trim();
  const lower = normalise(text);

  // ====== Step inference from prior prompts ======
  const haveName = alreadyAnswered(history, /\b(my name is|i am|i'm|call me)\b/i) ||
    alreadyAnswered(history, /^\s*[A-Z][a-z'\-]{1,30}\s*$/);

  const nameFromThisTurn = pickPossibleName(text);
  const safeName = nameFromThisTurn || null;

  // Small-talk reply (once), then continue
  if (containsSmallTalk(text) && !asked(history, STEP_MARKERS.NAME)) {
    const empathy = rotate(EMPATHY_ROTATIONS, seed + history.length);
    const reply =
      `${empathy} ${TRANSITIONS[(seed + history.length) % TRANSITIONS.length]} can I take your first name? ${STEP_MARKERS.NAME}`;
    return res.status(200).json({ reply });
  }

  // If user tries profanity as name → polite re-ask once, then move on by offering alternatives
  if (!haveName && asked(history, STEP_MARKERS.NAME) && !justAsked(history, STEP_MARKERS.NAME)) {
    if (!safeName) {
      const reply =
        "I might have misheard your name — what would you like me to call you? (A first name is perfect.) " +
        STEP_MARKERS.NAME;
      return res.status(200).json({ reply });
    }
  }

  // ====== Drive scripted flow by windowing each question ======
  // 0) Ask for name (only once)
  if (!asked(history, STEP_MARKERS.NAME)) {
    const empathy = rotate(EMPATHY_ROTATIONS, seed + 1);
    const reply =
      `${empathy} ${TRANSITIONS[(seed + 1) % TRANSITIONS.length]} can I take your first name? ${STEP_MARKERS.NAME}`;
    return res.status(200).json({ reply });
  }

  // 1) If we just captured a name this turn, acknowledge naturally once
  if (safeName && !asked(history, STEP_MARKERS.CONCERN)) {
    const salutation = /mark\b/i.test(safeName) ? "— nice to meet a fellow Mark!" : "";
    const reply =
      `Nice to meet you, ${safeName}${salutation} ` +
      `${TRANSITIONS[(seed + 2) % TRANSITIONS.length]} what would you say your main concern is with the debts? ` +
      STEP_MARKERS.CONCERN;
    return res.status(200).json({ reply, displayName: safeName });
  }

  // 2) Ask concern (one time + soft nudge)
  if (!asked(history, STEP_MARKERS.CONCERN)) {
    const reply =
      `Just so I can point you in the right direction, what would you say your main concern is with the debts? ` +
      STEP_MARKERS.CONCERN;
    return res.status(200).json({ reply });
  }
  if (asked(history, STEP_MARKERS.CONCERN) && !asked(history, STEP_MARKERS.AMOUNTS)) {
    // If user replied with something, move on to amounts
    // If they didn't, we still move forward after a single nudge
    const empathy = rotate(EMPATHY_ROTATIONS, seed + 3);
    const reply =
      `${empathy} Roughly how much do you pay towards all debts each month, and what would feel affordable for you? ` +
      `For example, “I pay £600 and could afford £200.” ` +
      STEP_MARKERS.AMOUNTS;
    return res.status(200).json({ reply });
  }

  // 3) Amounts step (extract two numbers if available; if only one, ask the second once; then continue)
  if (asked(history, STEP_MARKERS.AMOUNTS) && !asked(history, STEP_MARKERS.URGENT)) {
    const { current, affordable } = extractAmounts(text);
    const haveCurrent = alreadyAnswered(history, /\bpay\b|\bcurrently\b|\bper month\b|\bmonth\b/i) || !!current;
    const haveAffordable = alreadyAnswered(history, /\bafford\b|\bfeels affordable\b/i) || !!affordable;

    if (!haveCurrent && !containsAmounts(text) && !justAsked(history, STEP_MARKERS.AMOUNTS)) {
      const reply =
        "Could you share your monthly total towards debts and a figure that would feel affordable? " +
        "e.g., “I pay £600, could afford £200.” " +
        STEP_MARKERS.AMOUNTS;
      return res.status(200).json({ reply });
    }

    if (haveCurrent && !haveAffordable && containsAmounts(text)) {
      const reply =
        "And what monthly amount would feel affordable going forward? " + STEP_MARKERS.AMOUNTS;
      return res.status(200).json({ reply });
    }

    const reply =
      "Understood. Is there anything urgent like enforcement/bailiff action, court or default notices, or missed priority bills (rent, council tax, utilities)? " +
      STEP_MARKERS.URGENT;
    return res.status(200).json({ reply });
  }

  // 4) Urgent flags → ACK
  if (asked(history, STEP_MARKERS.URGENT) && !asked(history, STEP_MARKERS.ACK)) {
    const reply = `${MONEYHELPER_ACK} ${STEP_MARKERS.ACK}`;
    return res.status(200).json({ reply });
  }

  // 5) ACK handling: expect yes/no; on yes → portal offer; on no → reassure & still move to portal offer later
  if (asked(history, STEP_MARKERS.ACK) && !asked(history, STEP_MARKERS.PORTAL)) {
    if (YES.test(lower)) {
      const reply =
        "Great — let’s keep going. I can set up your secure Client Portal so you can add details, upload documents, and check progress. Shall I open it now? " +
        STEP_MARKERS.PORTAL;
      return res.status(200).json({ reply });
    }
    if (NO.test(lower)) {
      const reply =
        "No problem — we’ll proceed at your pace. When you’re ready, I can open the portal for you to add details securely. Would you like to open it now? " +
        STEP_MARKERS.PORTAL;
      return res.status(200).json({ reply });
    }
    // nudge
    const reply = `Quick check — would you like to carry on? (Yes/No) ${STEP_MARKERS.ACK}`;
    return res.status(200).json({ reply });
  }

  // 6) Portal: only open on explicit yes; otherwise keep chatting
  if (asked(history, STEP_MARKERS.PORTAL) && !asked(history, STEP_MARKERS.PORTAL_GUIDE)) {
    if (YES.test(lower)) {
      const reply =
        "Opening your portal now. While you’re in the portal, I’ll stay here to guide you. " +
        "You can come back to the chat anytime using the button in the top-right corner. " +
        "Please follow the outstanding tasks so we can understand your situation. " +
        'Once you’ve saved your details, say “done” and we’ll continue. ' +
        STEP_MARKERS.PORTAL_GUIDE;
      return res.status(200).json({ reply, openPortal: true });
    }
    if (NO.test(lower)) {
      const reply =
        "No worries — we can keep chatting and I’ll guide you step by step. " +
        "Would you like a quick summary of options based on what you’ve told me so far? " +
        STEP_MARKERS.SUMMARY;
      return res.status(200).json({ reply });
    }
    const reply =
      "Would you like me to open the secure Client Portal now? (Yes/No) " + STEP_MARKERS.PORTAL;
    return res.status(200).json({ reply });
  }

  // 7) After portal guide: accept “done”, then ask docs or summary
  if (asked(history, STEP_MARKERS.PORTAL_GUIDE) && !asked(history, STEP_MARKERS.DOCS)) {
    if (/\b(done|saved|submitted|uploaded|finished|complete)\b/i.test(lower)) {
      const reply =
        "Great — to assess the best solution and potentially save you money each month, please upload: " +
        "• Proof of ID • Last 3 months’ bank statements • Payslips (3 months or 12 weeks if weekly) if employed • " +
        "Last year’s tax return if self-employed • Universal Credit statements (12 months + latest full statement) if applicable • " +
        "Car finance docs if applicable • Any creditor letters or statements. " +
        STEP_MARKERS.DOCS;
      return res.status(200).json({ reply });
    }
    // gentle wait message (no loop)
    return res.status(200).json({
      reply:
        "Take your time in the portal. When you’ve saved your details, say “done” and we’ll continue.",
    });
  }

  // 8) Docs → Finish or Summary
  if (asked(history, STEP_MARKERS.DOCS) && !asked(history, STEP_MARKERS.SUMMARY)) {
    if (/\b(done|uploaded|finished|complete)\b/i.test(lower)) {
      const reply =
        "Brilliant — our assessment team will now review your case and come back with next steps. " +
        "You can check progress in your portal anytime. Is there anything else you’d like to ask before we wrap up? " +
        STEP_MARKERS.SUMMARY;
      return res.status(200).json({ reply });
    }
    // Nudge once to confirm uploads later
    const reply =
      "No problem — you can upload documents whenever you’re ready via the 📎 in chat or inside the portal. " +
      "Would you like a quick summary of options so far? " +
      STEP_MARKERS.SUMMARY;
    return res.status(200).json({ reply });
  }

  // 9) Summary / closing
  if (asked(history, STEP_MARKERS.SUMMARY)) {
    if (YES.test(lower)) {
      const reply =
        "Quick summary: \n" +
        "• We’ll protect essentials (rent, council tax, utilities). \n" +
        "• We’ll look at solutions that can freeze interest/charges and reduce monthly cost. \n" +
        "• Your portal is the fastest way to complete details and upload proofs. \n" +
        "Anything else on your mind before we close?";
      return res.status(200).json({ reply });
    }
    if (NO.test(lower)) {
      return res
        .status(200)
        .json({ reply: "Okay — I’m here if anything else comes up. You can return anytime." });
    }
    // graceful final fallback
    return res.status(200).json({
      reply:
        "I’ll stay available here. If you’d like that quick summary, just say “summary”, or type any question.",
    });
  }

  // ====== Global fallbacks: FAQs & empathy ======
  // Minimal FAQ hooks (lightweight, won’t derail the step)
  if (/\b(car|vehicle)\b/i.test(lower) && /\blose|keep\b/i.test(lower)) {
    return res.status(200).json({
      reply:
        "Most people keep their car. If repayments are very high, we’ll discuss affordable options — but keeping essentials is the priority.",
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

  // Final generic catch-all that nudges forward
  const empathy = rotate(EMPATHY_ROTATIONS, seed + history.length + 7);
  const reply =
    `${empathy} If you’re ready, I can open your secure portal now — or we can keep chatting and I’ll guide you.`;
  return res.status(200).json({ reply });
}
