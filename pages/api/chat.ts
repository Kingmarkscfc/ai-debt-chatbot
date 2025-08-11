import type { NextApiRequest, NextApiResponse } from "next";
import { v4 as uuidv4 } from "uuid";

/**
 * Minimal, reliable script for now (you can expand freely).
 * We purposely keep it inline to avoid JSON-import issues and get you unblocked today.
 */
const STEPS: string[] = [
  "Hello! My name’s Mark. What prompted you to seek help with your debts today?",
  "Thanks for sharing. Roughly how much do you owe in total across all debts?",
  "Is this with at least two different unsecured creditors (like credit cards or loans)?",
  "Are any debts joint or guaranteed by someone else (or are you a guarantor)?",
  "Let’s walk through your options briefly (self-help, consolidation, DRO, bankruptcy, DMP, IVA). Which would you like to hear first?",
  "Based on what you’ve said, I can help you prepare the next steps. Are you ready to upload proof of income, debts, and ID now?",
  "Great — you can upload your documents securely via your online portal. I’m here if you need anything else!"
];

const HUMOUR = [
  "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
  "I’m flattered you think I can do that — but let’s focus on getting you debt-free!",
  "If the aliens return your payslip, feel free to upload it later — for now, let’s keep going."
];

// very simple in-memory session store (works on Vercel but resets between cold starts)
const sessionSteps: Record<string, number> = {};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ reply: "Method not allowed" });

  try {
    const rawMsg = (req.body?.message ?? "").toString().trim();
    let sessionId = (req.body?.sessionId ?? "").toString().trim();
    if (!sessionId) sessionId = uuidv4();

    // initialize step if none
    if (sessionSteps[sessionId] === undefined) {
      // index 0 is the intro we already render on the client
      // so the first user reply should move us to step 1
      sessionSteps[sessionId] = 1;
    }

    // If the user said nothing, gently prompt again (but don't change step)
    if (!rawMsg) {
      const idx = sessionSteps[sessionId];
      const reply = STEPS[Math.min(idx, STEPS.length - 1)];
      return res.status(200).json({ reply, sessionId });
    }

    // basic off-topic nudge (we still advance, to avoid loops)
    const lower = rawMsg.toLowerCase();
    const offTopic =
      ["weather", "football", "recipe", "joke"].some((k) => lower.includes(k)) ||
      lower.length < 2;

    let nextIdx = sessionSteps[sessionId];

    // reply with the current step prompt (where we are now)
    let reply = STEPS[Math.min(nextIdx, STEPS.length - 1)];

    // prepare to move forward for the *next* turn
    if (nextIdx < STEPS.length - 1) {
      nextIdx += 1;
    }

    // if off-topic, prepend a quick nudge once (but do not stall)
    if (offTopic) {
      const nudge = HUMOUR[Math.floor(Math.random() * HUMOUR.length)];
      reply = `${nudge} ${reply}`;
    }

    sessionSteps[sessionId] = nextIdx;

    return res.status(200).json({ reply, sessionId });
  } catch (e) {
    console.error("chat error:", e);
    return res.status(500).json({
      reply: "Sorry, something went wrong on my end. Please try again shortly.",
    });
  }
}
