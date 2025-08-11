import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fullScriptLogic from "../../utils/full_script_logic.json";
import creditors from "../../utils/creditors.json";

type Msg = { role: "user" | "assistant"; content: string };

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// --- helpers ---
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

const NUMERIC_RE = /(?:£\s*)?[\d,]+(?:\.\d{1,2})?/;

function detectCreditors(text: string): string[] {
  const t = normalize(text);
  const hits = new Set<string>();
  const aliases = creditors.aliases_to_display || {};

  for (const alias in aliases) {
    // whole-word-ish match
    const pat = new RegExp(`\\b${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (pat.test(t)) hits.add(aliases[alias]);
  }

  // generic patterns (council tax, rent arrears, etc.)
  for (const p of creditors.generic_patterns || []) {
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

// --- route ---
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    const sessionId = (req.body?.sessionId as string) || uuidv4();
    let history = await getHistory(sessionId);

    // Kick off scripted flow once (on first message or explicit INITIATE)
    const isInit = history.length === 0 || userMessage.toUpperCase().includes("INITIATE");
    if (isInit) {
      const opening = fullScriptLogic.steps[0]?.prompt ||
        "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      history = [{ role: "assistant", content: opening }];
      await saveHistory(sessionId, history);
      return res.status(200).json({ reply: opening, sessionId });
    }

    // record user msg
    history.push({ role: "user", content: userMessage });

    // current step index = how many assistant prompts already sent
    const currentStepIndex = history.filter(m => m.role === "assistant").length - 1; // -1 because we pushed user
    const step = fullScriptLogic.steps[currentStepIndex] || fullScriptLogic.steps.at(-1)!;

    const expected = (step.keywords || []).map((k: string) => k.toLowerCase());
    const lower = normalize(userMessage);

    // creditor detection + amount detection for early steps
    const foundCreditors = detectCreditors(userMessage);
    const looksLikeAmount = NUMERIC_RE.test(userMessage) || /\b(thousand|hundred|k)\b/i.test(userMessage);

    let matched = false;

    // If this is one of the early information-gathering steps, allow creditor/amount to count as a match.
    if (currentStepIndex <= 2) {
      matched =
        expected.some((k: string) => lower.includes(k)) ||
        foundCreditors.length > 0 ||
        looksLikeAmount;
    } else {
      matched = expected.length === 0 || expected.some((k: string) => lower.includes(k));
    }

    let reply: string;

    if (matched) {
      // progress to next step
      const nextIdx = Math.min(currentStepIndex + 1, fullScriptLogic.steps.length - 1);
      const nextPrompt = fullScriptLogic.steps[nextIdx]?.prompt || step.prompt;

      if (foundCreditors.length > 0 && currentStepIndex <= 2) {
        const ack = `Thanks — I’ve noted ${foundCreditors.slice(0, 3).join(", ")}.`;
        reply = `${ack} ${nextPrompt}`.trim();
      } else if (looksLikeAmount && currentStepIndex <= 2) {
        reply = `Thanks for confirming the amount. ${nextPrompt}`;
      } else {
        reply = nextPrompt;
      }
    } else {
      // gentle nudge with the SAME step (no loop back to intro)
      reply =
        step.prompt +
        (currentStepIndex <= 2
          ? " (It’s okay to just name who you owe — e.g., Barclaycard, Capital One — or a rough total like £5,000.)"
          : "");
    }

    history.push({ role: "assistant", content: reply });
    await saveHistory(sessionId, history);

    // fire-and-forget telemetry (optional; ignore if you haven’t added the table)
    fetch(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/telemetry` : "http://localhost:3000/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        stepIndex: Math.min(currentStepIndex + (matched ? 1 : 0), fullScriptLogic.steps.length - 1),
        matched,
        foundCreditors,
        ts: Date.now()
      })
    }).catch(() => {});

    return res.status(200).json({ reply, sessionId });
  } catch (e: any) {
    console.error("chat.ts error:", e?.message || e);
    return res.status(500).json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
