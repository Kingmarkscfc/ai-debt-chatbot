// /pages/api/chat.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";

// Script steps (must exist)
import fullScriptLogic from "../../utils/full_script_logic.json";

// Optional packs (handled defensively if missing or different shapes)
let ukKeywordPack: any = null;
let creditorMap: Record<string, string> = {};
try {
  ukKeywordPack = require("../../utils/keywords_uk.json");
} catch (_) {}
try {
  const creditors = require("../../utils/creditors.json");
  creditorMap = creditors?.normalized_to_display || {};
} catch (_) {}

// --- OpenAI + Supabase ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// --- Utilities ---
type Msg = { role: "user" | "assistant" | "system"; content: string };

const fallbackHumour = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that, but let’s get back to helping you become debt-free!",
  "As fun as that sounds, I’m here to help with your money stress, not become your life coach. Yet."
];

// ---------- Keyword helpers ----------
function getUkKeywords(): string[] {
  if (!ukKeywordPack) return [];
  if (Array.isArray(ukKeywordPack)) return ukKeywordPack.map(String);
  if (ukKeywordPack.keywords && Array.isArray(ukKeywordPack.keywords)) {
    return ukKeywordPack.keywords.map(String);
  }
  const out: string[] = [];
  Object.values(ukKeywordPack).forEach((v: any) => {
    if (Array.isArray(v)) v.forEach(x => out.push(String(x)));
  });
  return out;
}
const UK_KEYWORDS = getUkKeywords().map(k => k.toLowerCase().trim());
const CREDITOR_ALIASES = Object.keys(creditorMap).map(k => k.toLowerCase());

function normalizeText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s£]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAmountScore(msg: string): number {
  const pound = /£\s*\d[\d,\.kK]*/g;
  const plain = /\b\d{3,}\b/g;
  const hasPound = pound.test(msg);
  const hasPlain = plain.test(msg);
  if (hasPound) return 2.5;
  if (hasPlain) return 1.5;
  return 0;
}

function scoreForStep(
  step: { prompt: string; keywords?: string[] },
  msgNorm: string
): { score: number; matches: { step: string[]; uk: string[]; creditors: string[]; amountBoost: number } } {
  let score = 0;
  const matches = { step: [] as string[], uk: [] as string[], creditors: [] as string[], amountBoost: 0 };

  // Step-specific keywords (2.0 each)
  const stepKeywords = (step.keywords || []).map(k => k.toLowerCase());
  for (const k of stepKeywords) {
    if (k && msgNorm.includes(k)) {
      score += 2.0;
      matches.step.push(k);
    }
  }

  // UK pack (0.5 each)
  for (const k of UK_KEYWORDS) {
    if (k && msgNorm.includes(k)) {
      score += 0.5;
      matches.uk.push(k);
    }
  }

  // Creditors (1.2 each)
  for (const alias of CREDITOR_ALIASES) {
    if (alias && msgNorm.includes(alias)) {
      score += 1.2;
      matches.creditors.push(alias);
    }
  }

  // Amount boost for amount-like steps
  const looksLikeAmountStep =
    /how much|total amount|roughly how much|owe in total/i.test(step.prompt || "");
  if (looksLikeAmountStep) {
    const boost = extractAmountScore(msgNorm);
    score += boost;
    matches.amountBoost = boost;
  }

  return { score, matches };
}

function pickNextStepIndex(
  msg: string,
  assistantCount: number
): {
  chosenIndex: number;
  currentIndex: number;
  nextIndex: number;
  currentScore: number;
  nextScore: number;
  currentMatches: ReturnType<typeof scoreForStep>["matches"];
  nextMatches: ReturnType<typeof scoreForStep>["matches"];
} {
  const msgNorm = normalizeText(msg);
  const steps = fullScriptLogic.steps || [];
  const currentIdx = Math.min(assistantCount, steps.length - 1);
  const nextIdx = Math.min(currentIdx + 1, steps.length - 1);

  const cur = scoreForStep(steps[currentIdx], msgNorm);
  const nxt = scoreForStep(steps[nextIdx], msgNorm);

  // default: stay on current step
  let chosen = currentIdx;
  if (nxt.score > cur.score + 1.5) chosen = nextIdx;

  return {
    chosenIndex: chosen,
    currentIndex: currentIdx,
    nextIndex: nextIdx,
    currentScore: cur.score,
    nextScore: nxt.score,
    currentMatches: cur.matches,
    nextMatches: nxt.matches
  };
}

// ---------- Supabase helpers ----------
async function loadHistory(sessionId: string): Promise<Msg[]> {
  const { data } = await supabase
    .from("chat_history")
    .select("messages")
    .eq("session_id", sessionId)
    .single();
  return (data?.messages as Msg[]) || [];
}

async function saveHistory(sessionId: string, messages: Msg[]): Promise<void> {
  await supabase.from("chat_history").upsert({
    session_id: sessionId,
    messages
  });
}

// NEW: telemetry logger
async function logTelemetry(sessionId: string, payload: {
  user_message: string;
  current_index: number;
  next_index: number;
  chosen_index: number;
  current_score: number;
  next_score: number;
  current_matches: any;
  next_matches: any;
}) {
  try {
    await supabase.from("chat_telemetry").insert({
      session_id: sessionId,
      user_message: payload.user_message,
      current_index: payload.current_index,
      next_index: payload.next_index,
      chosen_index: payload.chosen_index,
      current_score: payload.current_score,
      next_score: payload.next_score,
      current_matches: payload.current_matches,
      next_matches: payload.next_matches
    });
  } catch (e) {
    // non-fatal
    console.warn("Telemetry insert failed:", e);
  }
}

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage: string | undefined = req.body?.message;
    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({ reply: "Invalid request format." });
    }
    const cleanUser = userMessage.trim();
    const sessionId: string = req.body.sessionId || uuidv4();

    // Load history
    let history = await loadHistory(sessionId);

    // INITIATE -> always start at step 0
    if (cleanUser === "👋 INITIATE" || history.length === 0) {
      const opening =
        fullScriptLogic.steps?.[0]?.prompt ||
        "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      const start: Msg[] = [{ role: "assistant", content: opening }];
      await saveHistory(sessionId, start);
      return res.status(200).json({ reply: opening, sessionId });
    }

    // Append user's message
    history.push({ role: "user", content: cleanUser });

    // Where are we? (# of assistant prompts already sent)
    const assistantCount = history.filter(m => m.role === "assistant").length;

    // Scored decision
    const pick = pickNextStepIndex(cleanUser, assistantCount);

    // Telemetry (why we chose this step)
    await logTelemetry(sessionId, {
      user_message: cleanUser,
      current_index: pick.currentIndex,
      next_index: pick.nextIndex,
      chosen_index: pick.chosenIndex,
      current_score: pick.currentScore,
      next_score: pick.nextScore,
      current_matches: pick.currentMatches,
      next_matches: pick.nextMatches
    });

    // If score is super low -> gentle nudge
    const chosenStep = fullScriptLogic.steps[pick.chosenIndex];
    const chosenScore = pick.chosenIndex === pick.currentIndex ? pick.currentScore : pick.nextScore;

    let reply: string;
    if (chosenScore < 0.5) {
      reply = fallbackHumour[Math.floor(Math.random() * fallbackHumour.length)];
    } else {
      reply = chosenStep?.prompt || "Let’s keep going with your debt help...";
    }

    // Save reply
    history.push({ role: "assistant", content: reply });
    await saveHistory(sessionId, history);

    // Optional: refine with model (kept conservative)
    try {
      const sys =
        "You are Mark, a friendly but professional UK debt advisor. Paraphrase the assistant message naturally, keep its meaning, do not add new questions or skip ahead. Keep it short.";
      const completion = await openai.chat.completions.create({
        model: history.length > 12 ? "gpt-4o" : "gpt-3.5-turbo",
        temperature: 0.4,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: reply }
        ]
      });
      const refined = completion.choices[0]?.message?.content?.trim();
      if (refined && refined.length > 0) {
        history[history.length - 1] = { role: "assistant", content: refined };
        await saveHistory(sessionId, history);
        return res.status(200).json({ reply: refined, sessionId });
      }
    } catch {
      // ignore refine errors
    }

    return res.status(200).json({ reply, sessionId });
  } catch (err: any) {
    console.error("❌ Error in /api/chat:", err?.message || err);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
