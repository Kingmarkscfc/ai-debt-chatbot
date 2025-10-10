import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import type { ChatCompletionMessageParam } from "openai/resources";
import OpenAI from "openai";

import fullScript from "../../utils/full_script_logic.json";
import faqs from "../../utils/faqs.json";

/* -------------------- Setup -------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  // prefer service role where available so we can write safely, fallback to anon
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "")
);

type Step = { id: number; name: string; prompt: string; keywords?: string[]; openPortal?: boolean };
type Script = { steps: Step[]; small_talk?: { greetings?: string[] } };

const SCRIPT = (fullScript as Script).steps;
const GREETINGS = new Set((fullScript as Script).small_talk?.greetings?.map(s => s.toLowerCase()) || []);

// empathetic nudges (regex -> sentence)
const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan."],
  (/miss(ed)?\s+payments?|arrears|late fees?/i as unknown as RegExp, "Missed payments happen — we’ll focus on stabilising things now."),
  (/rent|council\s*tax|water|gas|electric/i as unknown as RegExp, "We’ll make sure essentials like housing and utilities are prioritised."),
  (/credit\s*card|loan|overdraft|catalogue|car\s*finance/i as unknown as RegExp, "We’ll take this step by step and ease the pressure."),
];

const HUMOUR_LITE = [
  "You’re doing the right thing reaching out — let’s sort this together.",
  "No jargon, no judgement — just a clear plan forward.",
];

const STEP_TAG = (n: number) => `[[STEP:${n}]]`;

/* --------------- Helpers (pure) --------------- */
function lastScriptedStep(history: ChatCompletionMessageParam[]): number {
  // Find last assistant message that carries a [[STEP:n]] tag
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant" && typeof m.content === "string") {
      const match = (m.content as string).match(/\[\[STEP:(\d+)\]\]/);
      if (match) return Number(match[1]);
    }
  }
  return -1;
}

function normalize(s: string) {
  return (s || "").toLowerCase().trim();
}

function matchedKeywords(user: string, expected: string[] = []) {
  if (!expected?.length) return true;
  const msg = normalize(user);
  return expected.some(k => msg.includes(k.toLowerCase()));
}

function isEmojiOnly(msg: string) {
  const trimmed = msg.trim();
  return /^([🙂🙁✅❌]|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|👍)$/.test(trimmed);
}

function emojiReply(msg: string) {
  switch (msg.trim()) {
    case "🙂": return "Noted — shall we continue?";
    case "🙁": return "I hear you. We’ll go step by step — ready to continue?";
    case "✅": return "Great — I’ve marked that as done. Next:";
    case "❌": return "No worries — we can adjust. What would you like to change?";
    default:
      if (/^👍/.test(msg)) return "Appreciated — shall we carry on?";
      return "Got it — shall we carry on?";
  }
}

function empathyLine(user: string): string | null {
  for (const [re, line] of EMPATHY) {
    if (re.test(user)) return line;
  }
  return null;
}

function faqHit(user: string) {
  const u = normalize(user);
  // prefer questions and explicit keywords
  let best: { a: string; score: number } | null = null;
  for (const f of faqs as Array<{ q: string; a: string; keywords?: string[] }>) {
    const kws = (f.keywords || []).map(k => k.toLowerCase());
    let score = 0;
    for (const k of kws) if (u.includes(k)) score += 1;
    if (u.endsWith("?")) score += 0.5;
    if (score > 1 && (!best || score > best.score)) {
      best = { a: f.a, score };
    }
  }
  return best?.a || null;
}

/* ---------------- API Handler ----------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const lang = String(req.body.language || "English");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();

    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // load chat history for session
    let { data: historyRow } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: ChatCompletionMessageParam[] = (historyRow?.messages as any[]) || [];

    // Initialise conversation (no 🌍/globe sentence to avoid TTS saying 'globe')
    if (!history.length) {
      const opening = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      history = [{ role: "assistant", content: `${STEP_TAG(-1)} ${opening}` }];
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply: opening, openPortal: false });
    }

    // Append user
    if (!userMessage) {
      return res.status(200).json({ reply: "Could you tell me a little about what’s brought you here today?", openPortal: false });
    }
    history.push({ role: "user", content: userMessage });

    // Fast path for emoji
    if (isEmojiOnly(userMessage)) {
      const reply = emojiReply(userMessage);
      // Always follow with the current question
      const curStepIdx = Math.max(0, lastScriptedStep(history) + 1);
      const step = SCRIPT[Math.min(curStepIdx, SCRIPT.length - 1)];
      const out = `${reply} ${step.prompt}`;
      history.push({ role: "assistant", content: `${STEP_TAG(step.id)} ${out}` });
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Greeting small talk: acknowledge, then immediately ask Step 0
    const nm = normalize(userMessage);
    if (GREETINGS.has(nm) || /^(hi|hello|hey)\b/i.test(userMessage)) {
      const line = "Hi — you’re in the right place.";
      const step0 = SCRIPT[0];
      const out = `${line} ${step0.prompt}`;
      history.push({ role: "assistant", content: `${STEP_TAG(step0.id)} ${out}` });
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Work out current step based on last tagged step
    let lastIdx = lastScriptedStep(history);
    if (lastIdx < 0) lastIdx = -1; // after opening line
    let currentStepIndex = Math.max(0, lastIdx + 1);
    if (currentStepIndex >= SCRIPT.length) currentStepIndex = SCRIPT.length - 1;

    const currentStep = SCRIPT[currentStepIndex];

    // If the user perfectly answers the current step (keyword match), move forward
    const answered = matchedKeywords(userMessage, currentStep.keywords || []);

    // FAQ interjection (but do not advance step because we still need the answer)
    let faq = null as string | null;
    if (/\?$/.test(userMessage) || /(what|how|can|will|do|is|are)\b/i.test(userMessage)) {
      faq = faqHit(userMessage);
    }

    // Build the reply ensuring: Empathy (if any) + answer (FAQ or brief steer) + ALWAYS end with a question (the script prompt)
    let openPortal = false;
    let replyParts: string[] = [];

    // Empathy (optional)
    const emp = empathyLine(userMessage);
    if (emp) replyParts.push(emp);

    if (faq) {
      // Give short answer then restate the current (or next) question
      replyParts.push(faq);
      // do not advance; ask current step question
      replyParts.push(currentStep.prompt);
      history.push({ role: "assistant", content: `${STEP_TAG(currentStep.id)} ${replyParts.join(" ")}` });
    } else if (answered) {
      // Advance to next step and ask its question
      const nextIdx = Math.min(currentStepIndex + 1, SCRIPT.length - 1);
      const nextStep = SCRIPT[nextIdx];

      // Special gate: Only open portal when the *invite_portal* step is answered affirmatively
      if (nextStep.openPortal) {
        // We are *arriving* at the invite step — we still need to ask it, not open yet.
        replyParts.push(nextStep.prompt);
        history.push({ role: "assistant", content: `${STEP_TAG(nextStep.id)} ${replyParts.join(" ")}` });
      } else if (currentStep.openPortal) {
        // Current step is the portal invite — only open if user said yes
        if (/(yes|ok|okay|sure|go ahead|open|start|set up|yep|yeah)/i.test(userMessage)) {
          openPortal = true;
          // Move to portal follow-up step and ask it
          const pf = SCRIPT.find(s => s.name === "portal_followup") || SCRIPT[nextIdx];
          replyParts.push(pf.prompt);
          history.push({ role: "assistant", content: `${STEP_TAG(pf.id)} ${replyParts.join(" ")}` });
        } else {
          // User declined or unsure — acknowledge and keep flow (ask next non-portal step or repeat politely)
          replyParts.push("No problem — we can open it later when you’re ready.");
          const nxt = SCRIPT.find(s => s.id > currentStep.id && !s.openPortal) || currentStep;
          replyParts.push(nxt.prompt);
          history.push({ role: "assistant", content: `${STEP_TAG(nxt.id)} ${replyParts.join(" ")}` });
        }
      } else {
        // Normal advance
        replyParts.push(nextStep.prompt);
        history.push({ role: "assistant", content: `${STEP_TAG(nextStep.id)} ${replyParts.join(" ")}` });
      }
    } else {
      // Not clearly answering the expected step — use a brief steer (LLM for tone), then re-ask current step
      const systemPrompt =
        "You are Mark, a professional, empathetic UK debt advisor. The user went off-script; reply in ONE short, natural sentence that acknowledges what they said and gently steers back to the current question. Do not repeat the question verbatim; keep it warm and human.";
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Current question: "${currentStep.prompt}". User said: "${userMessage}".` }
          ]
        });
        const steer = completion.choices[0]?.message?.content?.trim();
        if (steer) replyParts.push(steer);
      } catch {
        // silent; fallback below
      }
      if (!replyParts.length) replyParts.push("Got it — that’s useful to know.");
      // ALWAYS end with the current question so the convo never stalls
      replyParts.push(currentStep.prompt);
      history.push({ role: "assistant", content: `${STEP_TAG(currentStep.id)} ${replyParts.join(" ")}` });
    }

    await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });

    return res.status(200).json({
      reply: replyParts.join(" "),
      openPortal
    });

  } catch (err: any) {
    console.error("❌ chat.ts error:", err?.message || err);
    return res.status(500).json({ reply: "Sorry — something went wrong on my end. Let’s try that again." });
  }
}
