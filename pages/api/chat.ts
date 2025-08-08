// /pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";

type Step = {
  id?: string;
  prompt: string;
  keywords?: string[];
  next?: string | null;
};

type Script = {
  steps: Step[];
  humor_fallbacks?: string[];
};

const script = fullScriptLogic as Script;

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

const fallbackHumour =
  script.humor_fallbacks && script.humor_fallbacks.length
    ? script.humor_fallbacks
    : [
        "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
        "I’m flattered you think I can do that, but let’s get back to helping you become debt-free!",
        "As fun as that sounds, I’m here to help with your money stress, not become your life coach. Yet."
      ];

// Utility: figure next step index by assistant turns so far
function getCurrentStepIndex(history: { role: string; content: string }[]) {
  const assistantTurns = history.filter(m => m.role === "assistant").length;
  // assistantTurns == 0 ➜ about to send step 0; ==1 ➜ step 1, etc.
  return Math.min(assistantTurns, script.steps.length - 1);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const rawMessage = req.body?.message;
    if (typeof rawMessage !== "string") {
      return res.status(400).json({ reply: "Invalid request format." });
    }

    const userMessage = rawMessage.trim();
    const sessionId = req.body.sessionId || uuidv4();

    // Load chat history (array of { role, content })
    let { data: row } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: { role: "user" | "assistant"; content: string }[] =
      (row?.messages as any[]) || [];

    // INITIATE bootstraps step 0
    if (userMessage === "👋 INITIATE") {
      const step0 = script.steps[0];
      const opening = step0?.prompt || "Hello! How can I help with your debts today?";
      history = [{ role: "assistant", content: opening }];

      await supabase.from("chat_history").upsert({
        session_id: sessionId,
        messages: history
      });

      return res.status(200).json({ reply: opening, sessionId });
    }

    // Add user message
    history.push({ role: "user", content: userMessage });

    // Work out which step we’re on based on assistant turns already sent
    let stepIndex = getCurrentStepIndex(history);
    const currentStep = script.steps[stepIndex] || script.steps[script.steps.length - 1];

    // Keyword match to decide if we can advance
    const expected = (currentStep.keywords || []).map(k => k.toLowerCase());
    const msgLower = userMessage.toLowerCase();
    const matched =
      expected.length === 0 || expected.some(k => (k && msgLower.includes(k)));

    let reply = "";

    if (matched) {
      // Advance to next step if possible, else repeat current
      const nextIndex = Math.min(stepIndex + 1, script.steps.length - 1);
      reply = script.steps[nextIndex]?.prompt || currentStep.prompt || "Let’s keep going.";
      // If we advanced, set stepIndex to next (because we will have sent that assistant turn)
      stepIndex = nextIndex;
    } else {
      // Off-topic → gentle humour nudge + re-ask current step prompt
      const nudge = fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
      reply = `${nudge}\n\n${currentStep.prompt || "Let’s get back on track."}`;
    }

    // Save assistant reply
    history.push({ role: "assistant", content: reply });

    await supabase.from("chat_history").upsert({
      session_id: sessionId,
      messages: history
    });

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("❌ /api/chat error:", err?.message || err);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again shortly." });
  }
}
