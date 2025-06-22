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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

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

  // Determine script progression
  const currentStepIndex = Math.floor(history.length / 2);
  const scriptSteps = fullScriptLogic.steps;
  const currentStep = scriptSteps[currentStepIndex] || scriptSteps[scriptSteps.length - 1];
  const basePrompt = currentStep.prompt || "Let’s keep going with your debt help...";

  // Off-topic detection (naive for now)
  const keywords = ["debt", "creditor", "bailiff", "income", "bankruptcy", "IVA", "DMP", "DRO"];
  const isOnTopic = keywords.some((k) => userMessage.toLowerCase().includes(k));

  let humorLine = "";
  if (!isOnTopic) {
    const fallbacks = fullScriptLogic.humor_fallbacks || [];
    if (fallbacks.length > 0) {
      const random = Math.floor(Math.random() * fallbacks.length);
      humorLine = fallbacks[random];
      history.push({ role: "assistant", content: humorLine });
    }
  }

  const systemPrompt =
    "You are a professional and friendly AI debt advisor named Mark. Follow the IVA script step-by-step. If the user goes off-topic, use a friendly humorous fallback, then return to the correct script step. Do not skip or repeat steps. Avoid free-form responses.";

  const completion = await openai.chat.completions.create({
    model: history.length > 12 ? "gpt-4o" : "gpt-3.5-turbo",
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "assistant", content: basePrompt },
    ],
    temperature: 0.7,
  });

  const finalReply = completion.choices[0].message.content?.trim() || basePrompt;

  history.push({ role: "assistant", content: finalReply });

  await supabase.from("chat_history").upsert({
    session_id: sessionId,
    messages: history,
  });

  const fullReply = humorLine ? humorLine + "\n\n" + finalReply : finalReply;

  res.status(200).json({ reply: fullReply, sessionId });
}