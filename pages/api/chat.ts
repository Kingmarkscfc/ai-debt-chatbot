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
    // ...inside handler after you computed userMessage and sessionId

// Load history
let { data: historyData } = await supabase
  .from("chat_history")
  .select("messages")
  .eq("session_id", sessionId)
  .single();

let history: ChatCompletionMessageParam[] = historyData?.messages || [];

const normalized = userMessage.toLowerCase().trim();

// INITIATE: force step 0 and reset history
if (normalized.includes("initiate") || normalized === "👋 initiate" || normalized === "👋" || normalized === "initiate") {
  const firstPrompt = fullScriptLogic.steps[0]?.prompt
    || "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
  history = [{ role: "assistant", content: firstPrompt }];
  await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
  return res.status(200).json({ reply: firstPrompt, sessionId });
}

// Add user message
history.push({ role: "user", content: userMessage });

// Determine current step by assistant script turns already sent
const assistantMsgs = history.filter(m => m.role === "assistant");
let stepIndex = assistantMsgs.length; // 0 means we’ve sent step 0

// Clamp to script length - 1
stepIndex = Math.min(stepIndex, fullScriptLogic.steps.length - 1);

const currentStep = fullScriptLogic.steps[stepIndex] || {};
const expected = (currentStep.keywords || []).map((k: string) => k.toLowerCase());
const messageLower = userMessage.toLowerCase();

const matched = expected.length === 0 || expected.some(k => messageLower.includes(k));

// Decide reply
let reply: string;

if (matched) {
  // Advance to the NEXT step if we matched, else stick on current
  const nextIndex = Math.min(stepIndex + 1, fullScriptLogic.steps.length - 1);
  reply = fullScriptLogic.steps[nextIndex]?.prompt
    || "Let’s keep going with your debt help.";
} else {
  // Only humour if the step actually expects keywords AND we’re past step 0
  if (expected.length > 0 && stepIndex > 0) {
    const jokes = [
      "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
      "I’m flattered you think I can do that, but let’s get back to helping you become debt-free!",
      "As fun as that sounds, I’m here to help with your money stress, not become your life coach. Yet."
    ];
    reply = jokes[Math.floor(Math.random() * jokes.length)];
  } else {
    // Nudge back to the current step’s prompt instead of joking
    reply = currentStep.prompt || "Let’s keep going with your debt help.";
  }
}

// Save and return
history.push({ role: "assistant", content: reply });
await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
return res.status(200).json({ reply, sessionId });

