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

  if (
    !req.body ||
    typeof req.body.message !== "string" ||
    req.body.message.trim().length === 0
  ) {
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
    const openingLine =
      fullScriptLogic.steps[0]?.prompt ||
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

  const currentStepIndex = Math.floor(history.length / 2);
  const currentScriptStep =
    fullScriptLogic.steps[currentStepIndex] ||
    fullScriptLogic.steps[fullScriptLogic.steps.length - 1];

  const basePrompt = currentScriptStep.prompt || "Let’s keep going with your debt help...";

  const systemPrompt =
    "You are a professional and friendly AI debt advisor named Mark. Follow the IVA script step-by-step using the prompt provided. If the user goes off-topic, gently bring them back using light humour. Do not skip steps or loop. Ensure the flow strictly follows the script.";

  try {
    const completion = await openai.chat.completions.create({
      model: history.length > 12 ? "gpt-4o" : "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "assistant", content: basePrompt },
      ],
      temperature: 0.7,
    });

    const reply =
      completion.choices[0].message.content?.trim() ||
      "Hmm... I’m not quite sure how to reply to that. Let’s get back on track!";

    history.push({ role: "assistant", content: reply });

    await supabase.from("chat_history").upsert({
      session_id: sessionId,
      messages: history,
    });

    return res.status(200).json({ reply, sessionId });
  } catch (error) {
    console.error("❌ OpenAI error:", error);
    return res.status(500).json({
      reply:
        "Oops, something went wrong while I was trying to help. Let’s give it another go in a moment!",
    });
  }
}
