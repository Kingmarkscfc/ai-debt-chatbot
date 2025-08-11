import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import fullScriptLogic from "../../utils/full_script_logic.json";

type Step = { prompt: string; keywords?: string[] };
type Script = { steps: Step[] };

const script = fullScriptLogic as Script;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that — let's get back to helping you become debt-free!",
  "If the aliens return your payslip, pop it in the portal and we’ll keep going."
];

// simple quick reply suggestions per step
function buildQuickReplies(step: Step): string[] {
  const k = (step.keywords || []).slice(0, 6);
  if (k.length) return k.map((x) => x[0].toUpperCase() + x.slice(1));
  // generic suggestions
  return ["I have credit cards", "I have loans", "About £10,000", "Yes", "No", "Continue"];
}

async function getHistory(sessionId: string) {
  const { data } = await supabase
    .from("chat_history")
    .select("messages, step_index")
    .eq("session_id", sessionId)
    .single();

  return {
    messages: (data?.messages as { role: "user" | "assistant"; content: string }[]) || [],
    stepIndex: typeof data?.step_index === "number" ? data!.step_index : 0
  };
}

async function saveHistory(sessionId: string, messages: any[], stepIndex: number) {
  await supabase
    .from("chat_history")
    .upsert({ session_id: sessionId, messages, step_index: stepIndex });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = String(req.body?.message ?? "").trim();
    const lang = (req.body?.lang as string) || "en";
    const sessionId = String(req.body?.sessionId || uuidv4());

    let { messages, stepIndex } = await getHistory(sessionId);

    // Boot with first script step if brand new conversation
    if (!messages.length) {
      const first = script.steps[0]?.prompt || "Hello! How can I help today?";
      messages = [{ role: "assistant", content: first }];
      stepIndex = 0;
      await saveHistory(sessionId, messages, stepIndex);
      return res.status(200).json({
        reply: first,
        sessionId,
        stepIndex,
        totalSteps: script.steps.length,
        quickReplies: buildQuickReplies(script.steps[0] || { prompt: "" })
      });
    }

    if (!userMessage) {
      return res.status(400).json({ reply: "Please type a message.", sessionId });
    }

    // Add user message
    messages.push({ role: "user", content: userMessage });

    // Determine the current script step = number of assistant messages already sent
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    const currentIndex = Math.max(0, Math.min(assistantCount - 1, script.steps.length - 1));
    const currentStep = script.steps[currentIndex] || script.steps[script.steps.length - 1];

    // Naive keyword match to decide if we progress or gently redirect
    const expected = (currentStep.keywords || []).map((k) => k.toLowerCase());
    const lower = userMessage.toLowerCase();
    const matched =
      expected.length === 0 ? true : expected.some((k) => lower.includes(k));

    let reply = "";
    let nextIndex = currentIndex;

    if (matched && currentIndex < script.steps.length - 1) {
      // progress to next step
      nextIndex = currentIndex + 1;
      reply = script.steps[nextIndex]?.prompt || "Let’s keep going.";
    } else if (!matched) {
      // soft nudge with fallback humour + restate current step prompt
      const nudge = fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
      reply = `${nudge} ${currentStep.prompt}`;
    } else {
      // matched but we’re at the end
      reply = currentStep.prompt;
    }

    // Add assistant reply and save
    messages.push({ role: "assistant", content: reply });
    await saveHistory(sessionId, messages, nextIndex);

    // return UI helpers
    const qr = buildQuickReplies(script.steps[nextIndex] || currentStep);

    return res.status(200).json({
      reply,
      sessionId,
      stepIndex: nextIndex,
      totalSteps: script.steps.length,
      quickReplies: qr
    });
  } catch (err: any) {
    console.error("chat.ts error:", err?.message || err);
    return res.status(500).json({
      reply: "Sorry, something went wrong. Please try again in a moment.",
    });
  }
}
