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
    /* ignore telemetry errors */
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
} catch { /* fallback below */ }

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
const norm = (s: string) => (s || "").trim();
const GREETING_RE = /^(hi|hello|hey|good (morning|afternoon|evening)|hiya|yo)\b/i;

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

/** Soft name extraction (for nicer confirmation) */
function extractName(s: string): string | null {
  // Look for common patterns first
  const m =
    s.match(/(?:my name is|i am|i'm|im|it's|its|call me)\s+([A-Z][a-z]+(?: [A-Z][a-z]+){0,3})/i) ||
    s.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+){0,3})$/);
  const pick = m?.[1] || m?.[0] || "";
  const cleaned = norm(pick).replace(/\.$/, "");
  return cleaned || null;
}

/** Step satisfaction rules */
function satisfiesStep(user: string, step: Step, stepIndex: number): boolean {
  const u = user.toLowerCase();

  // Step 0 (name): detect introductions or a plausible name token
  if (stepIndex === 0) {
    const namePhrases = /(my name is|i am|i'm|im|it's|its|call me|name)/i;
    const looksLikeName = /[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}/.test(user);
    if (namePhrases.test(u) || looksLikeName) return true;
  }

  // Step 3 (“done” in portal)
  if (stepIndex === 3) {
    const doneWords = (step.keywords || ["done","saved","submitted","uploaded","finished","complete"]).map(k => k.toLowerCase());
    if (doneWords.some(k => u.includes(k))) return true;
  }

  // If the step has keywords, require at least one match or a reasonably informative free-text answer
  if (Array.isArray(step.keywords) && step.keywords.length) {
    if (!step.keywords.some(k => u.includes(k.toLowerCase()))) {
      if (!/[a-z]{3,}/i.test(user)) return false;
    }
  } else {
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

    const askedIdx = lastAskedStepIndex(history);      // last script prompt index we asked (-1 if none)
    const pendingIdx = Math.min(askedIdx + 1, SCRIPT_STEPS.length - 1);
    const justAsked = askedIdx >= 0 ? SCRIPT_STEPS[askedIdx] : null;
    const pending = SCRIPT_STEPS[pendingIdx];

    let reply = "";
    let openPortal = false;
    let displayName: string | undefined;

    // Empathy + FAQ (short, optional)
    const emp = empathyLine(userMessage);
    const empPrefix = emp ? emp + " " : "";

    const faq = matchFAQ(userMessage);
    const faqPrefix = faq ? faq.a + " " : "";

    // Objection handling — short reassurance then restate current prompt
    const objectionHandled = OBJECTION_RE.test(userMessage);
    const nudgePrefix = objectionHandled
      ? "Totally fair — everything is secure and there’s no obligation at this stage. "
      : "";

    // 0) If no step has been asked yet and the user greets us, greet back + ask step 0
    if (askedIdx < 0 && GREETING_RE.test(userMessage)) {
      reply = `Hi! ${empPrefix}${faqPrefix}${SCRIPT_STEPS[0].prompt}`;
      await logTelemetry(sessionId, "chat", { language, askedIdx, pendingIdx, openPortal: false, greeted: true, faqMatched: !!faq });
      return res.status(200).json({
        reply,
        sessionId,
        stepIndex: 0,
        totalSteps: SCRIPT_STEPS.length,
        openPortal: false
      });
    }

    // If we asked a step previously — did they satisfy it?
    if (justAsked) {
      const ok = satisfiesStep(userMessage, justAsked, askedIdx);

      if (ok) {
        // Special nicety: if they just answered step 0 with a name, greet them by name before moving on
        if (askedIdx === 0) {
          const maybeName = extractName(userMessage);
          if (maybeName) {
            displayName = maybeName;
            const first = maybeName.split(" ")[0];
            reply = `Nice to meet you, ${first}. ${empPrefix}${faqPrefix}${pending.prompt}`;
          } else {
            reply = `${empPrefix}${faqPrefix}${pending.prompt}`;
          }
        } else {
          reply = `${empPrefix}${faqPrefix}${pending.prompt}`;
        }

        // IMPORTANT: never open the portal before step 4 (hard gate)
        // Even if the JSON marks an earlier step with openPortal, we only open from step index >= 4.
        if (pending.openPortal && pendingIdx >= 4) {
          openPortal = true;
        }
      } else {
        // Not satisfied -> gentle nudge; avoid repeating exact prompt back-to-back
        const base = `${faqPrefix}${nudgePrefix}`;
        if (alreadyAsked(history, justAsked.prompt)) {
          reply = `${base}In a sentence or two: ${justAsked.prompt}`;
        } else {
          reply = `${base}${justAsked.prompt}`;
        }
      }
    } else {
      // Nothing asked yet -> start at step 0, with a friendly lead
      reply = `${empPrefix}${faqPrefix}${SCRIPT_STEPS[0].prompt}`;
      // (No portal at start)
      openPortal = false;
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
