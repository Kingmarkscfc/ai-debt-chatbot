// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";

// ---- Types for script JSON ----
type ScriptStep = {
  prompt: string;
  keywords?: string[];
};
type ScriptLogic = {
  steps: ScriptStep[];
};
const script = fullScriptLogic as ScriptLogic;

// ---- Supabase client ----
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// ---- Friendly fallback humour ----
const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that — let’s get back to helping you become debt-free!",
  "As fun as that sounds, I’m here to help with your money stress — not become your life coach. Yet."
];

// ---- helpers ----
function getBaseUrl(req: NextApiRequest) {
  const host = req.headers.host || "localhost:3000";
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  return `${proto}://${host}`;
}

async function logEvent(
  req: NextApiRequest,
  {
    session_id,
    event_type,
    payload
  }: { session_id: string; event_type: string; payload?: any }
) {
  try {
    await fetch(`${getBaseUrl(req)}/api/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id, event_type, payload })
    });
  } catch (e) {
    // Silent fail for telemetry (don’t break the chat)
    console.error("Telemetry post failed:", (e as Error).message);
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    const sessionId = (req.body?.sessionId as string) || uuidv4();

    // load conversation history
    const { data: historyRow } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: { role: "assistant" | "user"; content: string }[] =
      (historyRow?.messages as any[]) || [];

    // INIT / first step
    const isInit = userMessage === "👋 INITIATE" || history.length === 0;
    if (isInit) {
      const opening = script.steps[0]?.prompt ||
        "Hello! My name’s Mark. What prompted you to seek help with your debts today?";

      history = [{ role: "assistant", content: opening }];

      await supabase.from("chat_history").upsert({
        session_id: sessionId,
        messages: history
      });

      await logEvent(req, {
        session_id: sessionId,
        event_type: "session_start",
        payload: { opening }
      });

      return res.status(200).json({ reply: opening, sessionId });
    }

    // append user message
    history.push({ role: "user", content: userMessage });
    await logEvent(req, {
      session_id: sessionId,
      event_type: "user_message",
      payload: { text: userMessage }
    });

    // determine current step: we advance one assistant reply per step
    const assistantCount = history.filter(m => m.role === "assistant").length;
    // assistantCount equals the index of the next step to show
    const currentIndex = Math.min(assistantCount, script.steps.length - 1);

    const currentStep = script.steps[currentIndex] || script.steps[script.steps.length - 1];
    const nextStep = script.steps[currentIndex + 1];

    // keyword matching to decide if we advance
    const expected = (currentStep.keywords || []).map(k => k.toLowerCase());
    const text = userMessage.toLowerCase();
    const matched =
      expected.length === 0 || expected.some(k => text.includes(k));

    let reply: string;

    if (matched && nextStep) {
      // advance to next step
      reply = nextStep.prompt;
      await logEvent(req, {
        session_id: sessionId,
        event_type: "step_advanced",
        payload: {
          from_index: currentIndex,
          to_index: currentIndex + 1,
          used_keywords: expected
        }
      });
    } else if (!matched) {
      // stay on current step but nudge with humour
      reply =
        fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
      await logEvent(req, {
        session_id: sessionId,
        event_type: "fallback_used",
        payload: {
          at_index: currentIndex,
          expected_keywords: expected,
          user_text: userMessage
        }
      });
    } else {
      // matched but no next step (we're at the end)
      reply = currentStep.prompt;
    }

    // append assistant reply and persist
    history.push({ role: "assistant", content: reply });

    await supabase.from("chat_history").upsert({
      session_id: sessionId,
      messages: history
    });

    await logEvent(req, {
      session_id: sessionId,
      event_type: "assistant_reply",
      payload: { step_index: currentIndex, reply }
    });

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("❌ chat.ts error:", err?.message || err);
    try {
      await logEvent(req, {
        session_id: req.body?.sessionId || "unknown",
        event_type: "error",
        payload: { message: err?.message || String(err) }
      });
    } catch {}
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
