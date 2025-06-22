import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../data/full_script_logic.json";
import type { NextApiRequest, NextApiResponse } from "next";
import { ChatCompletionMessageParam } from "openai/resources";

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
    if (!req.body || typeof req.body.message !== "string") {
      console.error("400 Error: Invalid request body", req.body);
      return res.status(400).json({ reply: "Invalid request format." });
    }

    const userMessage = req.body.message.trim();
    const sessionId = req.body.sessionId || uuidv4();

    let { data: historyData } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: ChatCompletionMessageParam[] = [];

    if (userMessage === "👋 INITIATE") {
      const openingLine = fullScriptLogic.steps[0]?.prompt ||
        "Hello, my name is Mark. What language would you like to use today so I can best help you with your debts?";

      history = [{ role: "assistant", content: openingLine }];

      await supabase.from("chat_history").upsert({
        session_id: sessionId,
        messages: history,
      });

      return res.status(200).json({ reply: openingLine, sessionId });
    }

    if (historyData?.messages) {
      history = historyData.messages;
    }

    history.push({ role: "user", content: userMessage });

    const userStepCount = history.filter(m => m.role === "user").length;
    const assistantStepCount = history.filter(m => m.role === "assistant").length;
    const currentStepIndex = Math.min(userStepCount, assistantStepCount);

    const currentScriptStep = fullScriptLogic.steps[currentStepIndex] ||
      fullScriptLogic.steps[fullScriptLogic.steps.length - 1];

    const basePrompt = currentScriptStep?.prompt ||
      "Let’s keep going with your debt help...";

    const systemPrompt =
      "You are a professional and friendly AI debt advisor named Mark. Follow the IVA script strictly step-by-step using the provided script logic. NEVER skip ahead. If the user goes off-topic, bring them back using professional humour. Only use humour for off-topic replies. Do not loop or repeat past steps.";

    const completion = await openai.chat.completions.create({
      model: history.length > 12 ? "gpt-4o" : "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "assistant", content: basePrompt },
      ],
      temperature: 0.7,
    });

    let reply = completion.choices[0].message.content?.trim() || "I'm not sure how to reply to that.";

    // If reply ignores the prompt completely, fall back to humour
    const botIgnoredPrompt = reply.toLowerCase().includes("i don't understand") ||
      reply.toLowerCase().includes("i'm not sure");

    if (botIgnoredPrompt) {
      reply = fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
    }

    history.push({ role: "assistant", content: reply });

    await supabase.from("chat_history").upsert({
      session_id: sessionId,
      messages: history,
    });

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("500 Error in /api/chat:", err.message || err);
    return res.status(500).json({ reply: "Sorry, something went wrong on my end. Please try again shortly." });
  }
}

