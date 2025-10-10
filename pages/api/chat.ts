import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

import fullScript from "../../utils/full_script_logic.json";
import faqs from "../../utils/faqs.json";

/* -------------------- Setup -------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "")
);

type Step = { id: number; name?: string; prompt: string; keywords?: string[]; openPortal?: boolean };
type ScriptShape = { steps: Step[]; small_talk?: { greetings?: string[] } };

const SCRIPT = (fullScript as ScriptShape).steps;
const GREETINGS = new Set((fullScript as ScriptShape).small_talk?.greetings?.map(s => s.toLowerCase()) || []);

const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan."],
  [/miss(ed)?\s+payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council\s*tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/credit\s*card|loan|overdraft|catalogue|car\s*finance/i, "We’ll take this step by step and ease the pressure."],
];

const STEP_TAG = (n: number) => `[[STEP:${n}]]`;
const OPENING = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";

// Minimum index where portal can be invited (forces it to be later in the script flow)
const MIN_PORTAL_INVITE_INDEX = 4;

/* ----------------- DB helpers ----------------- */
async function loadMessages(sessionId: string) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) return [];
  return (data || []).map(m => ({ role: (m.role as "user" | "assistant"), content: String(m.content || "") }));
}

async function appendMessage(sessionId: string, role: "user" | "assistant", content: string) {
  await supabase
    .from("messages")
    .insert({ session_id: sessionId, role, content });
}

/* --------------- Logic helpers --------------- */
function lastScriptedStepFromHistory(history: Array<{ role: "user" | "assistant"; content: string }>): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant") {
      const match = m.content.match(/\[\[STEP:(\d+)\]\]/);
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

function empathyLine(user: string): string | null {
  for (const [re, line] of EMPATHY) {
    if (re.test(user)) return line;
  }
  return null;
}

function faqHit(user: string) {
  const u = normalize(user);
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

function isAffirmative(s: string) {
  return /(yes|ok|okay|sure|go ahead|open|start|set up|yep|yeah|please|do it)\b/i.test(s);
}

function isGreeting(s: string) {
  const nm = normalize(s);
  return GREETINGS.has(nm) || /^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(s);
}

/* ---------------- API Handler ----------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    const language = String(req.body.language || "English");

    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // Load history from existing 'messages' table
    let history = await loadMessages(sessionId);

    // Bootstrapping: if history is empty, send opening once and store it
    if (history.length === 0) {
      // No 🌍 line to avoid TTS saying “globe”.
      await appendMessage(sessionId, "assistant", `${STEP_TAG(-1)} ${OPENING}`);
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // Append user message (and store it) if present
    if (userMessage) {
      await appendMessage(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    // Determine where we are in the script
    let lastIdx = lastScriptedStepFromHistory(history); // -1 means only opening sent
    let currentIdx = Math.max(0, lastIdx + 1);
    if (currentIdx >= SCRIPT.length) currentIdx = SCRIPT.length - 1;
    let currentStep = SCRIPT[currentIdx];

    let replyParts: string[] = [];
    let openPortal = false;

    // Friendly greeting response — but do NOT reset to opening
    if (isGreeting(userMessage) && lastIdx < 0) {
      // We have only the opening above; proceed to step 0
      currentIdx = 0;
      currentStep = SCRIPT[currentIdx];
      const line = "Hi — you’re in the right place.";
      const out = `${line} ${currentStep.prompt}`;
      await appendMessage(sessionId, "assistant", `${STEP_TAG(currentStep.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Empathy nudge
    const emp = empathyLine(userMessage);
    if (emp) replyParts.push(emp);

    // If user asked a question, try FAQ without advancing step
    if (/\?$/.test(userMessage) || /(what|how|can|will|do|is|are)\b/i.test(userMessage)) {
      const fa = faqHit(userMessage);
      if (fa) {
        replyParts.push(fa);
        replyParts.push(currentStep.prompt);
        const out = replyParts.join(" ");
        await appendMessage(sessionId, "assistant", `${STEP_TAG(currentStep.id)} ${out}`);
        return res.status(200).json({ reply: out, openPortal: false });
      }
    }

    // If the user answered the current step, progress
    const answered = matchedKeywords(userMessage, currentStep.keywords || []);
    if (answered) {
      // Compute next step
      let nextIdx = Math.min(currentIdx + 1, SCRIPT.length - 1);
      let nextStep = SCRIPT[nextIdx];

      // If next step is the portal invite BUT we haven’t reached the minimum index yet, skip forward until >= MIN_PORTAL_INVITE_INDEX
      if (nextStep.openPortal && nextIdx < MIN_PORTAL_INVITE_INDEX) {
        nextIdx = MIN_PORTAL_INVITE_INDEX;
        nextStep = SCRIPT[nextIdx] || nextStep;
      }

      // If current step IS the portal invite, only open on explicit yes
      if (currentStep.openPortal) {
        if (isAffirmative(userMessage)) {
          openPortal = true;
          // Move to portal follow-up (or next)
          const pf = SCRIPT.find(s => s.name === "portal_followup") || nextStep;
          replyParts.push(pf.prompt);
          const out = replyParts.join(" ");
          await appendMessage(sessionId, "assistant", `${STEP_TAG(pf.id)} ${out}`);
          return res.status(200).json({ reply: out, openPortal });
        } else {
          replyParts.push("No problem — we can open it later when you’re ready.");
          // Ask the next non-portal step
          const nxt = SCRIPT.find(s => s.id > currentStep.id && !s.openPortal) || nextStep;
          replyParts.push(nxt.prompt);
          const out = replyParts.join(" ");
          await appendMessage(sessionId, "assistant", `${STEP_TAG(nxt.id)} ${out}`);
          return res.status(200).json({ reply: out, openPortal: false });
        }
      }

      // Otherwise, normal advance
      replyParts.push(nextStep.prompt);
      const out = replyParts.join(" ");
      await appendMessage(sessionId, "assistant", `${STEP_TAG(nextStep.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Off-script / small talk: steer back using a short LLM sentence, then re-ask current prompt
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "You are Mark, a professional, empathetic UK debt advisor. The user went off-script; reply in ONE short, natural sentence that acknowledges what they said and gently steers back to the current question. Do not repeat the question verbatim; keep it warm and human."
          },
          {
            role: "user",
            content: `Current question: "${currentStep.prompt}". User said: "${userMessage}".`
          }
        ]
      });
      const steer = completion.choices[0]?.message?.content?.trim();
      if (steer) replyParts.push(steer);
    } catch {
      // ignore LLM failure; fall back
    }

    if (!replyParts.length) replyParts.push("Thanks for sharing — shall we keep going?");
    replyParts.push(currentStep.prompt);
    const out = replyParts.join(" ");
    await appendMessage(sessionId, "assistant", `${STEP_TAG(currentStep.id)} ${out}`);
    return res.status(200).json({ reply: out, openPortal: false });

  } catch (err: any) {
    console.error("❌ chat.ts error:", err?.message || err);
    return res.status(500).json({ reply: "Sorry — something went wrong on my end. Let’s try that again." });
  }
}
