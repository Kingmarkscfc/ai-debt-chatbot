import type { NextApiRequest, NextApiResponse } from "next";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

/** ============= Supabase (optional telemetry) ============= */
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";
const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
    : null;

async function logTelemetry(sessionId: string, type: string, payload: any) {
  try {
    if (!supabase) return;
    await supabase.from("chat_telemetry").insert({
      session_id: sessionId,
      event_type: type,
      payload
    });
  } catch {
    /* ignore */
  }
}

/** ============= Types ============= */
type Step = {
  id?: number;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
};
type Script = { steps: Step[] };
type FAQ = { q: string; a: string; keywords?: string[] };

/** ============= Load script & FAQs (robust) ============= */
let SCRIPT_STEPS: Step[] = [];
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const file = require("../../utils/full_script_logic.json") as Script;
  if (file?.steps?.length) SCRIPT_STEPS = file.steps;
} catch {
  /* will fall back below if needed */
}
if (!SCRIPT_STEPS.length) {
  SCRIPT_STEPS = [
    { id: 0, prompt: "Great, I look forward to helping you clear your debts. Can you let me know who I’m speaking to?" },
    { id: 1, prompt: "Just so I can point you in the right direction, what would you say your main concern is with the debts?" },
    { id: 2, prompt: "Let’s set up your secure Client Portal so you can add details, upload documents, and check progress. Shall I open it now?", openPortal: true },
    { id: 3, prompt: "While you’re in the portal, I’ll stay here to guide you. Once you’ve saved your details, just say “done” and we’ll continue." },
    { id: 4, prompt: "Before we proceed, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?" },
    { id: 5, prompt: "To assess the best solution and save you money each month, please upload documents: proof of ID; last 3 months’ bank statements; payslips (3 months or 12 weeks if weekly) if employed; last year’s tax return if self-employed; Universal Credit statements (12 months + latest full statement) if applicable; car finance docs if applicable; and any creditor letters or statements." },
    { id: 6, prompt: "Brilliant — our assessment team will now review your case and come back with next steps. You can check progress in your portal anytime. Is there anything else you’d like to ask before we wrap up?" }
  ];
}

let FAQS: FAQ[] = [];
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  FAQS = require("../../utils/faqs.json") as FAQ[];
} catch {
  FAQS = [];
}

/** ============= Helpers ============= */
function norm(s: string) { return (s || "").trim(); }

function isQuestion(u: string): boolean {
  const t = norm(u);
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(how|what|can|will|do|does|did|is|are|should|could|may|might|when|where|why)\b/i.test(t);
}

function matchFAQ(u: string): FAQ | null {
  if (!isQuestion(u)) return null;
  const txt = u.toLowerCase();
  for (const f of FAQS) {
    const kws = f.keywords || [];
    if (kws.length && kws.some(k => txt.includes(k.toLowerCase()))) return f;
  }
  return null;
}

const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|bailiffs|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address them in your plan."],
  [/miss(ed)? payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/struggl|stress|anxious|worried|overwhelmed|pressure/i, "That sounds tough — we’ll take this step by step and ease the pressure."]
];
function empathyLine(u: string): string | null {
  for (const [re, line] of EMPATHY) if (re.test(u)) return line;
  return null;
}

/** Objection/hesitation detection */
const OBJECTION_RE = /(not now|not ready|don.?t want|don.?t trust|is this legit|scam|fee|fees|cost|expensive|not sure|unsure|do i have to|why|how do you|data|privacy|gdpr)/i;

/** Step satisfaction rules tuned to your current script */
function satisfiesStep(user: string, step: Step, stepIndex: number): boolean {
  const u = user.toLowerCase();

  // Step 0 (name): detect common name introductions or a plausible name token
  if (stepIndex === 0) {
    const namePhrases = /(my name is|i am|i'm|im|it's|its|call me|name)/i;
    const looksLikeName = /[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}/.test(user);
    if (namePhrases.test(u) || looksLikeName) return true;
  }

  // Step 2 (open portal): require explicit affirmative/portal words
  if (stepIndex === 2) {
    const okWords = (step.keywords || ["yes","ok","okay","sure","go ahead","open","start","portal","set up"])
      .map(k => k.toLowerCase());
    if (okWords.some(k => u.includes(k))) return true;
    return false;
  }

  // Step 3 (“done” in portal)
  if (stepIndex === 3) {
    const doneWords = (step.keywords || ["done","saved","submitted","uploaded","finished","complete"]).map(k => k.toLowerCase());
    if (doneWords.some(k => u.includes(k))) return true;
  }

  // Generic keyword gate if provided
  if (Array.isArray(step.keywords) && step.keywords.length) {
    if (!step.keywords.some(k => u.includes(k.toLowerCase()))) {
      // also allow short free-text if the prompt is an open question and message is reasonably informative
      if (!/[a-z]{3,}/i.test(user)) return false;
    }
  } else {
    // Otherwise accept any non-trivial text
    if (norm(user).replace(/\s+/g, "").length < 2) return false;
  }

  return true;
}

/** Find last asked step index by scanning assistant prompts in history */
function lastAskedStepIndex(history: string[]): number {
  let idx = -1;
  for (const msg of history) {
    const next = SCRIPT_STEPS[idx + 1];
    if (next && msg.includes(next.prompt)) idx++;
  }
  return Math.max(-1, Math.min(idx, SCRIPT_STEPS.length - 1));
}

/** Prevent same prompt twice in a row */
function alreadyAsked(history: string[], prompt: string): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (SCRIPT_STEPS.some(s => msg.includes(s.prompt))) return msg.includes(prompt);
  }
  return false;
}

/** ============= Handler ============= */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = (req.body?.sessionId as string) || uuidv4();
    const userMessage: string = norm(
      String(req.body?.userMessage ?? req.body?.message ?? req.body?.text ?? "")
    );
    const language: string = String(req.body?.language || "English");
    const history: string[] = Array.isArray(req.body?.history) ? req.body.history : [];

    if (!userMessage) {
      return res.status(200).json({
        reply: "Please type a message to begin.",
        sessionId,
        stepIndex: 0,
        totalSteps: SCRIPT_STEPS.length
      });
    }

    const askedIdx = lastAskedStepIndex(history);  // last script prompt asked (-1 if none)
    const pendingIdx = Math.min(askedIdx + 1, SCRIPT_STEPS.length - 1);
    const justAsked = askedIdx >= 0 ? SCRIPT_STEPS[askedIdx] : null;
    const pending = SCRIPT_STEPS[pendingIdx];

    let reply = "";
    let openPortal = false;
    let displayName: string | undefined;

    // Optional empathy (short & unobtrusive)
    const emp = empathyLine(userMessage);
    const empPrefix = emp ? emp + " " : "";

    // FAQs — answer only if they asked a question, then restate the step
    const faq = matchFAQ(userMessage);
    const faqPrefix = faq ? faq.a + " " : "";

    // Objection handling — give a short reassurance then restate the current prompt
    let objectionHandled = false;
    if (OBJECTION_RE.test(userMessage)) {
      objectionHandled = true;
    }

    if (justAsked) {
      // We asked a step previously — did they satisfy it?
      const ok = satisfiesStep(userMessage, justAsked, askedIdx);
      if (ok) {
        // advance
        if (pending) {
          reply = `${empPrefix}${faqPrefix}${pending.prompt}`;
          if (pending.openPortal) openPortal = true;
        } else {
          reply = `${empPrefix}${faqPrefix}Thanks — I’m here if you have any other questions.`;
        }
      } else {
        // Not satisfied -> gentle nudge; avoid perfect repetition
        const nudge = objectionHandled
          ? "Totally fair — quick reassurance: everything’s secure and there’s no obligation at this stage. "
          : "";
        if (alreadyAsked(history, justAsked.prompt)) {
          reply = `${faqPrefix}${nudge}In a sentence or two: ${justAsked.prompt}`;
        } else {
          reply = `${faqPrefix}${nudge}${justAsked.prompt}`;
        }
      }
    } else {
      // Nothing asked yet -> ask the first step
      if (pending) {
        reply = `${empPrefix}${faqPrefix}${pending.prompt}`;
        if (pending.openPortal) openPortal = true;
      } else {
        reply = `${empPrefix}${faqPrefix}Thanks — let’s begin.`;
      }
    }

    // Lightweight name capture for step 0
    if (pendingIdx === 1 && justAsked?.id === 0) {
      const maybe = userMessage.match(/[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}/)?.[0];
      if (maybe && maybe.length >= 2) displayName = maybe;
    }

    await logTelemetry(sessionId, "chat", {
      language,
      askedIdx,
      pendingIdx,
      openPortal,
      objectionHandled,
      faqMatched: !!faq
    });

    return res.status(200).json({
      reply: reply || "Thanks — let’s continue.",
      sessionId,
      stepIndex: Math.max(0, pendingIdx),
      totalSteps: SCRIPT_STEPS.length,
      openPortal,
      displayName
    });
  } catch (e) {
    return res.status(200).json({
      reply: "Sorry, something went wrong on my end. Please try again.",
      error: "handled"
    });
  }
}
