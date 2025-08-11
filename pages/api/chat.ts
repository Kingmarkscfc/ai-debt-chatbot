import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

// If Supabase envs are present we’ll use them; otherwise fall back to in-memory
import { createClient } from "@supabase/supabase-js";

// IMPORTANT: keep this relative path – it works in Next API routes
import fullScriptLogic from "../../utils/full_script_logic.json";

type Msg = { role: "user" | "assistant"; content: string };
type SessionRow = { session_id: string; messages: Msg[]; step_index: number };

const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that, but let’s get back to helping you become debt-free!",
  "As fun as that sounds, I’m here to help with your money stress, not become your life coach. Yet.",
];

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Optional Supabase (safe fallback to memory)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// In-memory fallback store (dev only)
const memoryStore = new Map<string, SessionRow>();

async function getSession(sessionId: string): Promise<SessionRow> {
  if (supabase) {
    const { data, error } = await supabase
      .from("chat_history")
      .select("session_id,messages,step_index")
      .eq("session_id", sessionId)
      .single();

    if (error || !data) {
      return { session_id: sessionId, messages: [], step_index: 0 };
    }
    // Ensure defaults
    return {
      session_id: sessionId,
      messages: data.messages || [],
      step_index: typeof data.step_index === "number" ? data.step_index : 0,
    };
  }

  // memory fallback
  return memoryStore.get(sessionId) ?? { session_id: sessionId, messages: [], step_index: 0 };
}

async function saveSession(row: SessionRow): Promise<void> {
  if (supabase) {
    await supabase
      .from("chat_history")
      .upsert({ session_id: row.session_id, messages: row.messages, step_index: row.step_index });
    return;
  }
  memoryStore.set(row.session_id, row);
}

// Very light keyword scoring so we can advance even if not perfect
function scoreMatch(input: string, keywords: string[] = []): number {
  const t = input.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    if (!k) continue;
    const kw = k.toLowerCase().trim();
    if (!kw) continue;
    if (t.includes(kw)) score += 1;
  }
  // numbers suggest amounts (helps the “how much do you owe?” step)
  if (/\d/.test(t)) score += 1;
  return score;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = (req.body?.message ?? "").toString().trim();
    const sessionId = (req.body?.sessionId ?? "").toString().trim();
    if (!userMessage || !sessionId) {
      return res.status(400).json({ reply: "Invalid request.", sessionId });
    }

    // Load session (history + current step)
    const row = await getSession(sessionId);

    // INIT starts the flow (only once)
    if (userMessage.toUpperCase() === "INIT") {
      row.messages = [];
      row.step_index = 0;

      const first = fullScriptLogic.steps?.[0]?.prompt ?? "Hello! My name’s Mark. How can I help today?";
      row.messages.push({ role: "assistant", content: first });
      await saveSession(row);
      return res.status(200).json({ reply: first, sessionId });
    }

    // Append user message
    row.messages.push({ role: "user", content: userMessage });

    const steps = fullScriptLogic.steps || [];
    const currentIdx = Math.min(row.step_index, Math.max(0, steps.length - 1));
    const currentStep = steps[currentIdx] || { prompt: "Let’s keep going…", keywords: [] as string[] };

    // Decide whether to advance
    const s = scoreMatch(userMessage, (currentStep as any).keywords || []);
    const shouldAdvance = s > 0 || ((currentStep as any).keywords || []).length === 0;

    if (shouldAdvance && row.step_index < steps.length - 1) {
      // advance to next step
      row.step_index += 1;
      const nextPrompt = steps[row.step_index]?.prompt || "Let’s continue…";
      row.messages.push({ role: "assistant", content: nextPrompt });
      await saveSession(row);
      return res.status(200).json({ reply: nextPrompt, sessionId });
    }

    // If we’re at the last step, just restate the final instruction
    if (row.step_index >= steps.length - 1) {
      const endPrompt = steps[steps.length - 1]?.prompt || "Thanks — I’m here if you need anything else.";
      row.messages.push({ role: "assistant", content: endPrompt });
      await saveSession(row);
      return res.status(200).json({ reply: endPrompt, sessionId });
    }

    // If we didn’t advance, provide a gentle nudge (not humor by default)
    const nudge =
      currentStep.prompt ||
      "Thanks — just to keep us moving, could you answer the previous question so I can help properly?";
    row.messages.push({ role: "assistant", content: nudge });
    await saveSession(row);
    return res.status(200).json({ reply: nudge, sessionId });
  } catch (err: any) {
    console.error("API /api/chat error:", err?.message || err);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again.", sessionId: req.body?.sessionId });
  }
}
