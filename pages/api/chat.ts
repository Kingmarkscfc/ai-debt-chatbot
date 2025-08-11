import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";

// Types for the script
type ScriptStep = { prompt: string; keywords?: string[] };
type Script = { steps: ScriptStep[] };
const script = fullScriptLogic as Script;

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that — let’s get back to helping you become debt-free!",
  "As fun as that sounds, I’m here to help with your money stress — not become your life coach. Yet."
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const rawMessage = (req.body?.message ?? "").toString();
    const userMessage = rawMessage.trim();
    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    let sessionId = (req.body?.sessionId as string) || uuidv4();

    // Load history by session
    const { data: historyRow } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: { role: "assistant" | "user"; content: string }[] =
      (historyRow?.messages as any[]) || [];

    // Only start the script when we explicitly get INITIATE
    if (userMessage === "👋 INITIATE") {
      const opening =
        script.steps[0]?.prompt ||
        "Hello! My name’s Mark. What prompted you to seek help with your debts today?";

      history = [{ role: "assistant", content: opening }];

      await supabase
        .from("chat_history")
        .upsert({ session_id: sessionId, messages: history });

      return res.status(200).json({ reply: opening, sessionId });
    }

    // From here on, we assume sessionId is stable (frontend persisted it)
    // and we have at least the intro already if the user sent INITIATE earlier.

    // If history is somehow empty (e.g., user didn’t INIT), fall back to safe start
    if (history.length === 0) {
      const opening =
        script.steps[0]?.prompt ||
        "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      history = [{ role: "assistant", content: opening }];
      await supabase
        .from("chat_history")
        .upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply: opening, sessionId });
    }

    // Append user message
    history.push({ role: "user", content: userMessage });

    // Determine current step via number of assistant messages already sent
    const assistantCount = history.filter((m) => m.role === "assistant").length;
    const currentIndex = Math.min(assistantCount - 1, script.steps.length - 1);
    const currentStep = script.steps[currentIndex] || script.steps[script.steps.length - 1];
    const nextStep = script.steps[currentIndex + 1];

    // Match keywords
    const expected = (currentStep.keywords || []).map((k) => k.toLowerCase());
    const text = userMessage.toLowerCase();
    const matched =
      expected.length === 0 || expected.some((k) => text.includes(k));

    let reply: string;

    if (matched && nextStep) {
      reply = nextStep.prompt; // advance
    } else if (!matched) {
      reply = fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
    } else {
      // matched but last step => repeat final prompt
      reply = currentStep.prompt;
    }

    // Append assistant reply and persist
    history.push({ role: "assistant", content: reply });

    await supabase
      .from("chat_history")
      .upsert({ session_id: sessionId, messages: history });

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("❌ chat.ts error:", err?.message || err);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
