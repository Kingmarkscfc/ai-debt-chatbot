import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";
import type { NextApiRequest, NextApiResponse } from "next";
import { ChatCompletionMessageParam } from "openai/resources";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that, but let’s get back to helping you become debt-free!",
  "As fun as that sounds, I’m here to help with your money stress, not become your life coach. Yet."
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = req.body.message?.trim();
    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    const sessionId = req.body.sessionId || uuidv4();

    // Step 1: Load history from Supabase
    let { data: historyData } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: ChatCompletionMessageParam[] = historyData?.messages || [];

    // INITIATE logic
    if (userMessage === "👋 INITIATE") {
      const firstStep = fullScriptLogic.steps[0]?.prompt || "Hello, how can I help?";
      history = [{ role: "assistant", content: firstStep }];
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply: firstStep, sessionId });
    }

    // Add user message to history
    history.push({ role: "user", content: userMessage });

    const assistantMessages = history.filter(m => m.role === "assistant");
    const currentStepIndex = assistantMessages.length;

    const currentScriptStep = fullScriptLogic.steps[currentStepIndex] || {};
    const expectedKeywords = (currentScriptStep.keywords || []).map(k => k.toLowerCase());
    const messageLower = userMessage.toLowerCase();

    const matched = expectedKeywords.length === 0 || expectedKeywords.some(k => messageLower.includes(k));

    let reply = "";

    if (matched && stepCount < fullScriptLogic.steps.length) {
      reply = fullScriptLogic.steps[stepCount]?.prompt || "Let’s keep going with your debt help.";
    } else if (!matched) {
      // Use fallback humour
      reply = fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
    } else {
      reply = "Thanks for sticking with me. Let’s move forward.";
    }

    history.push({ role: "assistant", content: reply });

    await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("❌ Error in chat.ts:", err.message || err);
    return res.status(500).json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
