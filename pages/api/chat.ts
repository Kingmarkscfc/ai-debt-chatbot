// pages/api/chat.ts
/* eslint-disable no-console */
import { createClient } from "@supabase/supabase-js";
import path from "path";

// Use service role if present; otherwise anon (works on Vercel envs)
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "")
);

// ---- Types (loose to avoid Next type collisions on Vercel) ----
type Step = { prompt: string; keywords?: string[]; openPortal?: boolean };
type Script = { steps: Step[] };
type ChatRow = {
  session_id: string;
  messages: { role: "user" | "assistant"; content: string }[];
  step_index?: number;
  display_name?: string;
};

// ---- Load short script + FAQs (bundled) ----
const script: Script = require(path.join(process.cwd(), "utils", "full_script_logic.json"));
const faqs: { q: string; a: string; keywords?: string[] }[] = (() => {
  try {
    return require(path.join(process.cwd(), "utils", "faqs.json"));
  } catch {
    return [];
  }
})();

// ---- Empathy cues ----
const EMPATHY_CUES: [RegExp, string][] = [
  [/bailiff|bailiffs|enforcement/i, "I know bailiff contact is stressful — let’s get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be scary — we’ll address that in your plan."],
  [/miss(ed)? payments?|arrears|late fees?/i, "Missed payments happen; we’ll focus on stabilising things now."],
  [/rent|council tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/gambl|crypto|stock/i, "Thanks for being honest — we’ll keep things practical and judgement-free."],
  [/anxious|anxiety|depress|suicid/i, "If you’re feeling overwhelmed, you’re not alone — we’ll take this one step at a time."]
];

function empathyLine(msg: string): string | null {
  const m = msg.toLowerCase();
  for (const [re, line] of EMPATHY_CUES) if (re.test(m)) return line;
  return null;
}

// ---- Helpers ----
function normalizeMessage(body: any): string {
  const raw = (body?.message ?? body?.userMessage ?? "").toString().trim();
  return raw;
}

function matchedKeywords(user: string, expected?: string[]): boolean {
  if (!expected || expected.length === 0) return true; // default permissive
  const u = user.toLowerCase();
  return expected.some(k => u.includes(k.toLowerCase()));
}

// Meta-intents that should advance the flow instead of nudging back
const META_ADVANCE = [
  /how (can|do) you help/i,
  /what can you do/i,
  /\bhelp me\b/i,
  /\bwhat happens next\b/i,
  /\bhow does this work\b/i,
  /\bhow will you help\b/i
];

function isMetaAdvance(msg: string) {
  return META_ADVANCE.some(re => re.test(msg));
}

async function getSession(sessionId: string): Promise<ChatRow> {
  const { data } = await supabase
    .from("chat_history")
    .select("session_id,messages,step_index,display_name")
    .eq("session_id", sessionId)
    .single();

  return (
    data || {
      session_id: sessionId,
      messages: [],
      step_index: 0,
    }
  );
}

async function saveSession(row: ChatRow) {
  await supabase.from("chat_history").upsert({
    session_id: row.session_id,
    messages: row.messages,
    step_index: row.step_index ?? 0,
    display_name: row.display_name ?? null,
  });
}

async function telemetry(sessionId: string, event: string, payload: any = {}) {
  try {
    await supabase.from("chat_telemetry").insert({
      session_id: sessionId,
      event_type: event,
      payload,
    });
  } catch {
    /* ignore */
  }
}

// Make sure we never repeat exact same assistant prompt >1 time
function shouldForceAdvance(row: ChatRow, currentPrompt: string): boolean {
  const lastTwoAssistant = row.messages
    .filter((m) => m.role === "assistant")
    .slice(-2)
    .map((m) => m.content);

  const repeats = lastTwoAssistant.filter((c) => c === currentPrompt).length;
  return repeats >= 1; // if we already said it once, don't say it again
}

// If we can find a step titled like “overview/help” jump, else next
function pickAdvanceIndex(currentIndex: number): number {
  const nextIdx = Math.min(currentIndex + 1, script.steps.length - 1);

  // Try to find a step that looks like an options/overview step
  const idx = script.steps.findIndex((s) => {
    const p = s.prompt.toLowerCase();
    return /how we help|overview|options|what we can do|how it works/.test(p);
  });

  if (idx >= 0 && idx > currentIndex) return idx;
  return nextIdx;
}

function checkFaq(user: string) {
  const u = user.toLowerCase();
  for (const f of faqs) {
    const keys = f.keywords || [];
    if (keys.some((k) => u.includes(k.toLowerCase()))) {
      return f.a;
    }
  }
  return null;
}

// ---- Handler ----
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const sessionId = (req.body?.sessionId || "").toString() || Math.random().toString(36).slice(2);
    const lang = (req.body?.language || "English").toString();
    const userMessage = normalizeMessage(req.body);
    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    // Load/create session row
    let row = await getSession(sessionId);
    if (!row.messages || !Array.isArray(row.messages)) row.messages = [];
    if (typeof row.step_index !== "number") row.step_index = 0;

    // Initialise new sessions with intro
    if (row.messages.length === 0) {
      const first = script.steps[0]?.prompt || "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      row.messages.push({ role: "assistant", content: first });
      await saveSession(row);
      return res.status(200).json({ reply: first, sessionId, stepIndex: 0, totalSteps: script.steps.length });
    }

    // Append user message
    row.messages.push({ role: "user", content: userMessage });

    // Telemetry
    telemetry(sessionId, "user_message", { text: userMessage, step_index: row.step_index });

    // FAQ hook (does not advance; answers inline)
    const faq = checkFaq(userMessage);
    const empath = empathyLine(userMessage);

    // Current step
    const stepIdx = Math.min(Math.max(row.step_index || 0, 0), script.steps.length - 1);
    const step = script.steps[stepIdx] || script.steps[script.steps.length - 1];

    // Decide whether to advance
    let willAdvance = false;

    // 1) If user hits meta-advance (“how can you help?”), advance
    if (isMetaAdvance(userMessage)) {
      willAdvance = true;
    }

    // 2) If keywords match, advance
    if (!willAdvance && matchedKeywords(userMessage, step.keywords)) {
      willAdvance = true;
    }

    // 3) If we would repeat same prompt again, force advance to avoid loop
    if (!willAdvance && shouldForceAdvance(row, step.prompt)) {
      willAdvance = true;
    }

    // Craft reply
    let reply = "";
    let nextIdx = stepIdx;

    if (willAdvance) {
      nextIdx = pickAdvanceIndex(stepIdx);
      const nextStep = script.steps[nextIdx] || step;
      reply = nextStep.prompt;

      // Optional portal trigger if step has flag
      const openPortal = !!nextStep.openPortal;

      // Prepend empathy (short) if present
      if (empath) reply = `${empath} ${reply}`;

      row.messages.push({ role: "assistant", content: reply });
      row.step_index = nextIdx;
      await saveSession(row);

      telemetry(sessionId, "advance", { from: stepIdx, to: nextIdx, reason: "match/meta/guard" });

      return res.status(200).json({
        reply,
        sessionId,
        stepIndex: nextIdx,
        totalSteps: script.steps.length,
        openPortal
      });
    }

    // No advance → respond briefly; include FAQ answer if any, otherwise nudge (but NOT the same prompt twice)
    if (faq) {
      reply = empath ? `${empath} ${faq}` : faq;
    } else {
      // gentle steer but do not repeat if already said
      if (shouldForceAdvance(row, step.prompt)) {
        // If we’d repeat, move on instead
        const forcedIdx = pickAdvanceIndex(stepIdx);
        const forcedStep = script.steps[forcedIdx] || step;
        reply = empath ? `${empath} ${forcedStep.prompt}` : forcedStep.prompt;
        row.step_index = forcedIdx;
      } else {
        reply = empath ? `${empath} ${step.prompt}` : step.prompt;
      }
    }

    row.messages.push({ role: "assistant", content: reply });
    await saveSession(row);

    return res.status(200).json({
      reply,
      sessionId,
      stepIndex: row.step_index,
      totalSteps: script.steps.length
    });
  } catch (err: any) {
    console.error("❌ chat handler error:", err?.message || err);
    return res.status(500).json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
