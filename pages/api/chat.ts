import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai"; // optional; used only if you want model-polished text
import fullScriptLogic from "../../utils/full_script_logic.json";

// ------- Types -------
type ScriptStep = {
  id: string;
  prompt: string;
  keywords?: string[];
};
type Script = {
  steps: ScriptStep[];
  humor_fallbacks?: string[];
};

// ------- Clients -------
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

const openai =
  process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

// ------- Fallback humour -------
const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that — let’s get you debt-free instead!",
  "As fun as that sounds, I’m here to help with money stress — not become your life coach. Yet."
];

// ------- Helpers -------
async function getStepIndex(sessionId: string): Promise<number> {
  const { data } = await supabase
    .from("chat_sessions")
    .select("step_index")
    .eq("session_id", sessionId)
    .maybeSingle();

  return data?.step_index ?? 0;
}

async function setStepIndex(sessionId: string, stepIndex: number) {
  await supabase.from("chat_sessions").upsert({
    session_id: sessionId,
    step_index: stepIndex,
  });
}

// quick number detector for “amount” step
function containsAmountLike(text: string): boolean {
  const t = text.toLowerCase();
  if (/[£$€]\s*\d/.test(t)) return true;
  if (/\b\d{2,}\b/.test(t)) return true; // 2+ digits
  if (/\b\d+(\.\d+)?\s*k\b/.test(t)) return true; // 10k
  if (/\b(thousand|k)\b/.test(t)) return true;
  return false;
}

function matchesKeywords(message: string, step: ScriptStep): boolean {
  const msg = message.toLowerCase().trim();

  // special-case for the common “total amount” step id
  if (step.id === "total_amount" || step.id === "amount" || step.id === "fact_find_total") {
    if (containsAmountLike(msg)) return true;
  }

  const kws = (step.keywords || []).map(k => k.toLowerCase());
  if (kws.length === 0) return msg.length > 0; // any answer advances

  return kws.some(k => msg.includes(k));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const script = fullScriptLogic as Script;
    const steps = script.steps;
    if (!steps || steps.length === 0) {
      return res.status(500).json({ reply: "Script not configured." });
    }

    const rawMessage = String(req.body?.message ?? "").trim();
    if (!rawMessage) {
      return res.status(400).json({ reply: "Please type a message to continue." });
    }

    const sessionId = String(req.body?.sessionId || uuidv4());

    // INIT / RESTART handling
    const initText = rawMessage.replace(/[\u{1F44B}]/gu, "").trim().toLowerCase(); // strip 👋 if present
    if (initText === "initiate" || initText === "start" || initText === "restart") {
      await setStepIndex(sessionId, 0);
      return res.status(200).json({ reply: steps[0].prompt, sessionId });
    }

    // read current step (default 0)
    let stepIndex = await getStepIndex(sessionId);
    if (stepIndex < 0 || stepIndex >= steps.length) stepIndex = 0;

    const current = steps[stepIndex];

    // Decide if the user answered sufficiently for this step
    const ok = matchesKeywords(rawMessage, current);

    let nextIndex = stepIndex;
    let reply: string;

    if (ok) {
      // advance to next step if possible
      nextIndex = Math.min(stepIndex + 1, steps.length - 1);
      reply = steps[nextIndex].prompt;
    } else {
      // off-topic → humour + restate current prompt
      const fallbacks = script.humor_fallbacks && script.humor_fallbacks.length
        ? script.humor_fallbacks
        : fallbackHumour;
      const funny = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      reply = `${funny} ${current.prompt}`;
    }

    // persist progression
    await setStepIndex(sessionId, nextIndex);

    // Optional: lightly polish the reply with a model (kept robust if key is missing)
    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: nextIndex > 6 ? "gpt-4o" : "gpt-3.5-turbo",
          temperature: 0.4,
          messages: [
            {
              role: "system",
              content:
                "You are Mark, a professional, friendly UK debt advisor. Keep replies concise, clear, and compliant. If humour is present, keep it light and professional. Do not skip steps.",
            },
            { role: "user", content: `Polish this assistant reply without changing meaning: "${reply}"` },
          ],
        });
        reply = completion.choices[0]?.message?.content?.trim() || reply;
      } catch {
        // fall back silently if OpenAI fails
      }
    }

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("chat.ts error:", err?.message || err);
    return res.status(500).json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
