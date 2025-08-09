// /pages/api/chat.ts
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";
import creditors from "../../utils/creditors.json";
import type { NextApiRequest, NextApiResponse } from "next";
import { ChatCompletionMessageParam } from "openai/resources";

// If you want OpenAI back in, we can re-enable later. For now keep it deterministic to kill looping.
// import OpenAI from "openai";
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that, but let’s get back to helping you become debt-free!",
  "As fun as that sounds, I’m here to help with your money stress, not become your life coach. Yet."
];

type Step = { prompt: string; keywords?: string[] };
type Script = { steps: Step[] };
const script: Script = fullScriptLogic as Script;

const creditorKeys = Object.keys(
  (creditors as any)?.normalized_to_display || {}
).map((k) => k.toLowerCase());

// Basic normalizer for fuzzy contains
function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage: string | undefined = req.body?.message?.toString().trim();
    if (!userMessage) {
      return res.status(400).json({ reply: "Invalid message." });
    }
    const sessionId = req.body.sessionId || uuidv4();

    // 1) Load history
    let { data: historyData } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: ChatCompletionMessageParam[] = historyData?.messages || [];

    // 2) INITIATE -> send very first script prompt only once
    if (userMessage === "👋 INITIATE") {
      const first = script.steps[0]?.prompt || "Hello! How can I help with your debts today?";
      history = [{ role: "assistant", content: first }];
      await supabase.from("chat_history").upsert({
        session_id: sessionId,
        messages: history
      });
      return res.status(200).json({ reply: first, sessionId });
    }

    // 3) Append user message
    history.push({ role: "user", content: userMessage });

    // Current step index = how many assistant prompts we’ve already sent
    const assistantCount = history.filter((m) => m.role === "assistant").length;
    const currentStepIndex = Math.min(assistantCount - 1, script.steps.length - 1);
    const nextIndex = Math.min(currentStepIndex + 1, script.steps.length - 1);

    const currentStep = script.steps[Math.max(currentStepIndex, 0)] || script.steps[0];
    const nextStep = script.steps[nextIndex] || script.steps[script.steps.length - 1];

    // 4) Match by keywords OR creditor hit
    const expectedKeywords = (currentStep.keywords || []).map((k) => k.toLowerCase());
    const msgN = norm(userMessage);

    const keywordHit =
      expectedKeywords.length === 0 ||
      expectedKeywords.some((k) => msgN.includes(norm(k)));

    const creditorHit = creditorKeys.some((ck) => msgN.includes(ck));

    let reply = "";

    if (keywordHit || creditorHit) {
      // advance
      reply = nextStep.prompt || "Let’s keep going with your debt help.";
    } else {
      // humour fallback ONLY if truly off-topic
      reply = fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
    }

    history.push({ role: "assistant", content: reply });

    await supabase.from("chat_history").upsert({
      session_id: sessionId,
      messages: history
    });

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("❌ Error in /api/chat:", err?.message || err);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
