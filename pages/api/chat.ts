import type { NextApiRequest, NextApiResponse } from "next";
import { v4 as uuidv4 } from "uuid";

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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ reply: "Method not allowed" });

  try {
    const message = (req.body?.message ?? "").toString().trim();
    let sessionId = (req.body?.sessionId ?? "").toString().trim();
    let stepIndex = Number(req.body?.stepIndex);

    if (!Number.isFinite(stepIndex) || stepIndex < 0) stepIndex = 0;
    if (!sessionId) sessionId = uuidv4();

    // Choose the prompt for THIS turn
    const safeIdx = Math.min(stepIndex, STEPS.length - 1);
    let reply = STEPS[safeIdx];

    // Very light off-topic detection. We still progress either way.
    const lower = message.toLowerCase();
    const offTopic =
      ["weather", "football", "recipe", "joke"].some((k) => lower.includes(k)) ||
      lower.length < 2;

    if (offTopic) {
      reply = `${HUMOUR[Math.floor(Math.random() * HUMOUR.length)]} ${reply}`;
    }

    // Compute next step index for the NEXT user turn
    const nextStepIndex = Math.min(safeIdx + 1, STEPS.length - 1);

    return res.status(200).json({ reply, sessionId, nextStepIndex });
  } catch (e) {
    console.error("chat error:", e);
    return res
      .status(500)
      .json({ reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
