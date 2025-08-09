// /pages/api/chat.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";

// ---------- Types ----------
type Step = {
  id?: string;
  prompt: string;
  keywords?: string[];
};
type Script = { steps: Step[] };

const script = fullScriptLogic as Script;

// ---------- Supabase (optional) ----------
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "";
const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// We’ll use/expect a table like:
//   chat_progress(session_id text primary key, step_index int)
// If it’s not there, we seamlessly fall back to memory:
const memoryProgress: Record<string, number> = {};

// ---------- Humour ----------
const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that, but let’s get back to helping you become debt-free!",
  "As fun as that sounds, I’m here to help with your money stress, not become your life coach. Yet."
];

// ---------- Helpers ----------
async function getStepIndex(sessionId: string): Promise<number> {
  // Try Supabase first
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("chat_progress")
        .select("step_index")
        .eq("session_id", sessionId)
        .single();

      if (!error && data && typeof data.step_index === "number") {
        return data.step_index;
      }
    } catch {
      // fall back silently
    }
  }
  // Memory fallback
  return memoryProgress[sessionId] ?? 0;
}

async function setStepIndex(sessionId: string, stepIndex: number): Promise<void> {
  // Try Supabase first
  if (supabase) {
    try {
      const { error } = await supabase
        .from("chat_progress")
        .upsert({ session_id: sessionId, step_index: stepIndex });
      if (!error) return;
    } catch {
      // fall back silently
    }
  }
  // Memory fallback
  memoryProgress[sessionId] = stepIndex;
}

function matchedKeywords(step: Step | undefined, userText: string): boolean {
  if (!step) return false;
  const kws = (step.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
  if (kws.length === 0) return true; // no keywords means always accept and move on
  const t = userText.toLowerCase();
  return kws.some(k => t.includes(k));
}

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const raw = req.body;
    if (!raw || typeof raw.message !== "string") {
      return res.status(400).json({ reply: "Invalid request format." });
    }

    const userMessage = raw.message.trim();
    const sessionId: string = raw.sessionId || uuidv4();

    // INIT / RESET
    if (userMessage.toLowerCase().includes("initiate")) {
      await setStepIndex(sessionId, 0);
      const first = script.steps[0]?.prompt || "Hello! How can I help today?";
      return res.status(200).json({ reply: first, sessionId });
    }

    // Current step
    let stepIndex = await getStepIndex(sessionId);
    const current = script.steps[stepIndex];

    // If we’re somehow beyond the last step, just finish gracefully
    if (!current) {
      const endMsg =
        "Thanks for going through everything. If you’re ready, you can upload your documents securely via your portal. I’m here if you need anything else!";
      return res.status(200).json({ reply: endMsg, sessionId });
    }

    // Decide whether to advance
    const ok = matchedKeywords(current, userMessage);

    let reply: string;

    if (ok) {
      // Advance to the next step (or finish if none)
      stepIndex = Math.min(stepIndex + 1, script.steps.length - 1);
      await setStepIndex(sessionId, stepIndex);
      reply = script.steps[stepIndex]?.prompt || current.prompt;
    } else {
      // Off-topic → humour + restate current step succinctly
      const funny = fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
      reply = `${funny} ${current.prompt}`;
    }

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("❌ /api/chat error:", err?.message || err);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again shortly." });
  }
}
