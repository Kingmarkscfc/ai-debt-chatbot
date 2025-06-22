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

  // ✅ Strict request validation with logging
  if (
    !req.body ||
    typeof req.body !== "object" ||
    typeof req.body.message !== "string"
  ) {
    console.error("❌ 400 Error: Invalid request body format", JSON.stringify(req.body, null, 2));
    return res.status(400).json({ reply: "Invalid request format. Please try again." });
  }

  const userMessage = req.body.message.trim();
  const sessionId = req.body.sessionId || uuidv4();

  // 🗃️ Get or init chat history
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

  const currentStepIndex = Math.floor(history.length / 2);
  const currentScriptStep = fullScriptLogic.steps[currentStepIndex] ||
    fullScriptLogic.steps[fullScriptLogic.steps.length -]()
