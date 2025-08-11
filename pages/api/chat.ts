import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";
import creditorsJson from "../../utils/creditors.json";

// ----- Types for our JSON files -----
type ScriptStep = { prompt: string; keywords?: string[] };
type ScriptLogic = { steps: ScriptStep[] };

type CreditorsJson = {
  aliases_to_display: Record<string, string>;
  generic_patterns: string[];
};

// Assert types for imported JSON
const SCRIPT: ScriptLogic = fullScriptLogic as ScriptLogic;
const CREDITORS: CreditorsJson = creditorsJson as unknown as CreditorsJson;

// ----- Supabase -----
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

type Msg = { role: "user" | "assistant"; content: string };

// ----- Helpers -----
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

const NUMERIC_RE = /(?:£\s*)?[\d,]+(?:\.\d{1,2})?/;

function detectCreditors(text: string): string[] {
  const t = normalize(text);
  const hits = new Set<string>();
  const aliases: Record<string, string> = CREDITORS.aliases_to_display || {};

  for (const alias of Object.keys(aliases)) {
    // whole-word-ish match
    const pat = new RegExp(`\\b${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (pat.test(t)) hits.add(aliases[alias]); // <-- now typed
  }

  for (const p of CREDITORS.generic_patterns || []) {
    const pat = new RegExp(`\\b${p.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (pat.test(t)) hits.add(p.replace(/\b\w/g, c => c.toUpperCase()));
  }

  return Array.from(hits);
}

async function getHistory(sessionId: string): Promise<Msg[]> {
  const { data } = await supabase
    .from("chat_history")
    .select("messages")
    .eq("session_id", sessionId)
    .single();
  return (data?.messages as Msg[]) || [];
}

async function saveHistory(sessionId: string, messages: Msg[]) {
  await supabase.from("chat_history").upsert({ session_id: sessionId, messages });
}

// ----- API Route -----
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    const sessionId = (req.body?.sessionId as string) || uuidv4();
    let history = await getHistory(sessionId);

    // INIT / first turn -> send first scripted step and stop
    const isInit = history.length === 0 || userMessage.toUpperCase().includes("INITIATE");
    if (isInit) {
      const opening =
        SCRIPT.steps[0]?.prompt ||
        "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      history = [{ role: "assistant", content: opening }];
      await saveHistory(sessionId, history);
      return res.status(200).json({ reply: opening, sessionId });
    }

    // Record user message
    history.push({ role: "user", content: userMessage });

    // Determine current step by how many assistant prompts already sent
    const currentStepIndex = Math.max(
      0,
      history.filter(m => m.role === "assistant").length - 1
    );
    const step = SCRIPT.steps[currentStepIndex] || SCRIPT.steps.at(-1)!;

    const expected = (step.keywords || []).map(k => k.toLowerCase());
    const lower = normalize(userMessage);

    // Entity / amount detection for early progression
    const foundCreditors = detectCreditors(userMessage);
    const looksLikeAmount =
      NUMERIC_RE.test(userMessage) || /\b(thousand|hundred|k)\b/i.test(userMessage);

    let matched: boolean;

    if (currentStepIndex <= 2) {
      matched =
        expected.some(k => lower.includes(k)) || foundCreditors.length > 0 || looksLikeAmount;
    } else {
      matched = expected.length === 0 || expected.some(k => lower.includes(k));
    }

    let reply: string;

    if (matched) {
      const nextIdx = Math.min(currentStepIndex + 1, SCRIPT.steps.length - 1);
      const nextPrompt = SCRIPT.steps[nextIdx]?.prompt || step.prompt;

      if (foundCreditors.length > 0 && currentStepIndex <= 2) {
        const ack = `Thanks — I’ve noted ${foundCreditors.slice(0, 3).join(", ")}.`;
        reply = `${ack} ${nextPrompt}`.trim();
      } else if (looksLikeAmount && currentStepIndex <= 2) {
        reply = `Thanks for confirming the amount. ${nextPrompt}`;
      } else {
        reply = nextPrompt;
      }
    } else {
      // Stay on the same step, give a nudge (no jump back to intro)
      reply =
        step.prompt +
        (currentStepIndex <= 2
          ? " (It’s okay to name your creditors — e.g., Barclaycard, Capital One — or a rough total like £5,000.)"
          : "");
    }

    history.push({ role: "assistant", content: reply });
    await saveHistory(sessionId, history);

    // Telemetry (optional; ignore failure)
    const baseUrl =
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
    fetch(`${baseUrl}/api/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        stepIndex: Math.min(
          currentStepIndex + (matched ? 1 : 0),
          SCRIPT.steps.length - 1
        ),
        matched,
        foundCreditors,
        ts: Date.now()
      })
    }).catch(() => {});

    return res.status(200).json({ reply, sessionId });
  } catch (e: any) {
    console.error("chat.ts error:", e?.message || e);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
