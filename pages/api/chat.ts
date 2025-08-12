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
  "I’m flattered you think I can do that — let’s get you debt-free instead!",
  "All good! Let’s keep momentum and focus on your finances."
];

type Step = { prompt: string; keywords?: string[] };
type Script = { steps: Step[] };

function nextStepIndex(history: ChatCompletionMessageParam[]) {
  const assistantCount = history.filter(m => m.role === "assistant").length;
  // first assistant message is intro; next is step 1, etc.
  return Math.min(assistantCount, (fullScriptLogic as Script).steps.length - 1);
}

function matchedKeywords(user: string, expected: string[] = []) {
  if (!expected.length) return true;
  const msg = user.toLowerCase();
  return expected.some(k => msg.includes(k.toLowerCase()));
}

function isEmojiOnly(msg: string) {
  const trimmed = msg.trim();
  return /^([🙂🙁✅❌]|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|👍)$/.test(trimmed);
}

function emojiReply(msg: string) {
  switch (msg.trim()) {
    case "🙂": return "Noted! Glad you’re feeling positive. Shall we continue?";
    case "🙁": return "I hear you. Let’s tackle this step by step — you’re not alone.";
    case "✅": return "Perfect — marked as done. Next bit:";
    case "❌": return "No worries — we can revisit that later. What would you like to change?";
    default:
      if (/^👍/.test(msg)) return "Appreciated! I’ll keep things moving. 👍";
      return "Got it.";
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = (req.body.message || "").toString().trim();
    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    const sessionId = req.body.sessionId || uuidv4();
    const lang = (req.body.lang || "en") as string;

    let { data: historyData } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: ChatCompletionMessageParam[] = historyData?.messages || [];

    // On brand-new sessions, push intro
    if (!history.length) {
      const first = (fullScriptLogic as Script).steps[0]?.prompt ||
        "Hello! I’m Mark. What prompted you to seek help with your debts today?";
      history = [{ role: "assistant", content: first }];
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply: first, sessionId, stepIndex: 0, totalSteps: (fullScriptLogic as Script).steps.length });
    }

    // Append user message
    history.push({ role: "user", content: userMessage });

    // Handle emoji-only messages quickly (no LLM call)
    if (isEmojiOnly(userMessage)) {
      const reply = emojiReply(userMessage);
      history.push({ role: "assistant", content: reply });
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply, sessionId, stepIndex: nextStepIndex(history), totalSteps: (fullScriptLogic as Script).steps.length });
    }

    // Work out current step + keywords
    const stepIdx = nextStepIndex(history);
    const script = (fullScriptLogic as Script);
    const step = script.steps[stepIdx] || script.steps[script.steps.length - 1];

    // Decide to progress or nudge
    let reply = "";
    if (matchedKeywords(userMessage, step.keywords || [])) {
      const nextIdx = Math.min(stepIdx + 1, script.steps.length - 1);
      reply = script.steps[nextIdx]?.prompt || step.prompt;
      history.push({ role: "assistant", content: reply });
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({
        reply,
        sessionId,
        stepIndex: nextIdx,
        totalSteps: script.steps.length,
        quickReplies: ["Yes","No","Not sure","Continue","Go back"]
      });
    } else {
      // Gentle nudge back with minimal LLM help for tone
      const systemPrompt =
        "You are Mark, a professional UK debt advisor. The user went off-script; gently steer them back to the current question. Keep it one short sentence.";
      const completion = await openai.chat.completions.create({
        model: history.length > 12 ? "gpt-4o" : "gpt-3.5-turbo",
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Current question: "${step.prompt}". User said: "${userMessage}". Reply briefly and steer back.` }
        ]
      });
      reply = completion.choices[0].message.content?.trim() || fallbackHumour[Math.floor(Math.random()*fallbackHumour.length)];
      history.push({ role: "assistant", content: reply });
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({
        reply,
        sessionId,
        stepIndex: stepIdx,
        totalSteps: script.steps.length,
        quickReplies: ["Repeat question","Continue","Help"]
      });
    }
  } catch (err: any) {
    console.error("❌ Error in chat.ts:", err.message || err);
    return res.status(500).json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
