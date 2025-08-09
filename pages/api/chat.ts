// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";

type Step = { id?: string; prompt: string; keywords?: string[] };
type Script = { steps: Step[]; humor_fallbacks?: string[] };

const script = fullScriptLogic as Script;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// We’ll encode the current step into a system message like: STATE {"step":2}
const STATE_PREFIX = "STATE ";

// Gentle, on-topic nudge only when truly off-topic
const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to sorting your finances!",
  "I’m flattered you think I can do that — but let’s focus on getting you debt-free, yeah?",
  "If the aliens return your payslip, pop it in the portal and we’ll pick up from there!"
];

function extractStepFromHistory(history: { role: string; content: string }[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "system" && msg.content.startsWith(STATE_PREFIX)) {
      try {
        const obj = JSON.parse(msg.content.slice(STATE_PREFIX.length));
        if (typeof obj.step === "number") return obj.step;
      } catch { /* ignore */ }
    }
  }
  return 0; // default to first step
}

function pushState(history: { role: string; content: string }[], step: number) {
  history.push({ role: "system", content: `${STATE_PREFIX}${JSON.stringify({ step })}` });
}

function isNumbery(s: string) {
  // detects things like 1000, 10k, £7000, 7,000 etc.
  const cleaned = s.replace(/[,£$]/g, "").toLowerCase();
  if (/^\s*\d+(\.\d+)?\s*[kK]?\s*$/.test(cleaned)) return true;
  if (/\d/.test(cleaned)) return true;
  return false;
}

function matches(step: Step, user: string): boolean {
  const lower = user.toLowerCase();

  // Step-id specific helpers (so we don’t rely only on keywords)
  const id = (step.id || "").toLowerCase();
  if (id.includes("total") || id.includes("amount")) {
    if (isNumbery(user)) return true;
  }
  if (id.includes("creditors") || id.includes("count")) {
    if (/\b(2|two|yes|yep|yeah|multiple|more than one)\b/i.test(user)) return true;
  }

  // Generic keyword matching
  const kws = (step.keywords || []).map(k => k.toLowerCase());
  if (kws.length === 0) return true;
  return kws.some(k => lower.includes(k));
}

function shouldProgressAnyway(user: string): boolean {
  // If the user wrote a reasonably informative message, don’t get stuck
  // e.g., > 3 words or contains a number/currency
  if (isNumbery(user)) return true;
  const words = user.trim().split(/\s+/);
  return words.length >= 5;
}

const systemPrompt =
  "You are a professional and friendly AI debt advisor named Mark. " +
  "You must strictly follow the scripted steps provided by the app. " +
  "Do NOT jump ahead, and do NOT ask off-script questions. " +
  "If the user's reply is off-topic, gently steer them back. " +
  "Keep responses short, plain, and directly tied to the current step.";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage: string = (req.body?.message || "").toString().trim();
    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    const sessionId = (req.body?.sessionId as string) || uuidv4();

    // Load history
    const { data: row } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: { role: "user" | "assistant" | "system"; content: string }[] =
      (row?.messages as any[]) || [];

    // INIT flow: send step 0 and encode STATE
    if (userMessage === "👋 INITIATE") {
      const first = script.steps[0]?.prompt || "Hello! How can I help with your debts today?";
      history = [{ role: "assistant", content: first }];
      pushState(history, 0);
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply: first, sessionId });
    }

    // Otherwise, continue conversation
    history.push({ role: "user", content: userMessage });

    // Read current step from state
    let stepIndex = extractStepFromHistory(history);
    const currentStep = script.steps[stepIndex] || script.steps[script.steps.length - 1];

    // Try to match. If not matched but message looks informative, progress anyway.
    const ok = matches(currentStep, userMessage) || shouldProgressAnyway(userMessage);
    if (ok && stepIndex < script.steps.length - 1) {
      stepIndex += 1;
    }

    const nextStep = script.steps[stepIndex] || script.steps[script.steps.length - 1];
    let assistantText = nextStep.prompt;

    // If clearly off-topic & not informative, drop a gentle nudge instead of repeating forever
    if (!ok) {
      assistantText =
        fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)] +
        " " +
        currentStep.prompt;
    }

    // Optionally let GPT tidy tone (short + polite), but keep content anchored to prompt
    const completion = await openai.chat.completions.create({
      model: history.length > 14 ? "gpt-4o" : "gpt-3.5-turbo",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Use exactly this message as the assistant's reply (polish lightly, don't change meaning): "${assistantText}"` }
      ],
    });

    const reply = completion.choices[0].message.content?.trim() || assistantText;

    history.push({ role: "assistant", content: reply });
    pushState(history, stepIndex);

    await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("❌ /api/chat error:", err?.message || err);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
