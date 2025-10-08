// pages/api/chat.ts
// Non-loopy script engine + FAQs + gentle empathy + portal trigger + telemetry.
// Keeps your UI shell unchanged (index.tsx continues to POST { sessionId, userMessage/language }).

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

// Prefer service role on the server, fallback to anon
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";

const supabase = createClient(process.env.SUPABASE_URL || "", SUPABASE_KEY);

// OpenAI is used lightly for a one-sentence “nudge” if needed.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// ---------- Load JSON helpers ----------
function loadJson(file: string): any | null {
  try {
    const p = path.join(process.cwd(), "utils", file);
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type Step = { id: number; prompt: string; keywords?: string[]; openPortal?: boolean };
type Script = { steps: Step[] };
const script: Script = loadJson("full_script_logic.json") || { steps: [] };
const faqs: { q: string; a: string; keywords?: string[] }[] = loadJson("faqs.json") || [];

// ---------- Utilities ----------
function clean(x: any) {
  return (x ?? "").toString().trim();
}

function titleCase(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Try to infer a display name from a free-text message like “I’m Mark”, “Mark Hughes”, etc.
function inferDisplayName(msg: string): string | undefined {
  const m = msg
    .replace(/^(i am|i'm|im|my name is|name is|it's|its)\s+/i, "")
    .replace(/[^a-z'\-\s]/gi, "")
    .trim();
  if (!m) return undefined;
  const parts = m.split(/\s+/).slice(0, 3);
  if (!parts.length) return undefined;
  const maybe = parts.join(" ");
  // Avoid obviously wrong/catch-all strings
  if (/^(yes|no|help|okay|ok|sure)$/i.test(maybe)) return undefined;
  return titleCase(maybe);
}

function matchAny(hay: string, keys: string[] = []) {
  if (!keys?.length) return true;
  const msg = hay.toLowerCase();
  return keys.some((k) => msg.includes(k.toLowerCase()));
}

function emojiOnly(s: string) {
  const t = s.trim();
  return /^([🙂🙁✅❌]|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|👍)$/.test(t);
}

function emojiReply(s: string) {
  switch (s.trim()) {
    case "🙂":
      return "Noted! Glad you’re feeling positive. Shall we continue?";
    case "🙁":
      return "I hear you. We’ll take this step by step — you’re not alone.";
    case "✅":
      return "Great — marked as done. Let’s move on.";
    case "❌":
      return "No problem — we can revisit that. What would you like to change?";
    default:
      if (/^👍/.test(s)) return "Appreciated! I’ll keep us moving. 👍";
      return "Got it.";
  }
}

// “Empathy ping”: short supportive sentence if user surfaces pain points.
const EMPATHY_CUES: [RegExp, string][] = [
  [/bailiff|bailiffs|enforcement/i, "I know bailiff contact is stressful — let’s get protections in place quickly."],
  (/ccj|county court|default/i, "Court or default letters can be scary — we’ll address that in your plan."),
  (/miss(ed)? payments?|arrears|late fees?/i, "Missed payments happen; we’ll focus on stabilising things now."),
  (/rent|council tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."),
  (/gambl|crypto|stock/i, "Thanks for being honest — we’ll keep things practical and judgement-free."),
  (/anxious|anxiety|depress|suicid/i, "If you’re feeling overwhelmed, you’re not alone — we’ll take this one step at a time.")
].map((x) => (Array.isArray(x) ? (x as any) : [x, ""])) as any;

function empathyLine(msg: string): string | null {
  const m = msg.toLowerCase();
  for (const [re, line] of EMPATHY_CUES) {
    if (re.test(m)) return line;
  }
  return null;
}

function extractMaxStepFromAssistant(messages: { role: string; content: string }[]) {
  let max = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const match = m.content.match(/\[\[STEP:(\d+)\]\]/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return max;
}

// ---------- Persistence ----------
async function getHistory(sessionId: string) {
  const { data } = await supabase
    .from("messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  return data || [];
}
async function appendMessage(sessionId: string, role: "user" | "assistant", content: string) {
  await supabase.from("messages").insert({ session_id: sessionId, role, content });
}
async function telemetry(sessionId: string, event_type: string, payload: any) {
  await supabase.from("chat_telemetry").insert({ session_id: sessionId, event_type, payload: payload || {} });
}

// ---------- FAQ matching (does not advance step) ----------
function findFaqAnswer(userMsg: string) {
  const msg = userMsg.toLowerCase();
  // 1) keyword hit
  for (const f of faqs) {
    if (f.keywords?.length && matchAny(msg, f.keywords)) return f.a;
  }
  // 2) crude contains on question
  for (const f of faqs) {
    const needle = (f.q || "").toLowerCase().slice(0, Math.min(18, (f.q || "").length));
    if (needle && msg.includes(needle)) return f.a;
  }
  return null;
}

// ---------- Handler ----------
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = clean(req.body?.message || req.body?.userMessage);
    const sessionId = clean(req.body?.sessionId) || Math.random().toString(36).slice(2);
    const language = clean(req.body?.language || req.body?.lang || "English");

    if (!userMessage) return res.status(400).json({ reply: "Invalid message." });

    const history = await getHistory(sessionId);
    let currentStep = extractMaxStepFromAssistant(history);

    // FIRST CALL: if no assistant steps recorded yet, start at step 0 (name)
    if (currentStep === 0 && history.length === 0) {
      const first = script?.steps?.find((s) => s.id === 0)?.prompt || "Can I take your name to get started?";
      await appendMessage(sessionId, "assistant", `${first} [[STEP:0]]`);
      return res.status(200).json({ reply: first, stepIndex: 0 });
    }

    // Fast path: emoji-only
    if (emojiOnly(userMessage)) {
      const r = emojiReply(userMessage);
      await appendMessage(sessionId, "user", userMessage);
      await appendMessage(sessionId, "assistant", `${r} [[STEP:${currentStep}]]`);
      await telemetry(sessionId, "emoji", { msg: userMessage });
      return res.status(200).json({ reply: r, stepIndex: currentStep });
    }

    // Optional empathy one-liner (prepended)
    const empathy = empathyLine(userMessage);

    // FAQ pass — answer but DO NOT advance the step
    const faq = findFaqAnswer(userMessage);
    if (faq) {
      const reply = (empathy ? empathy + " " : "") + faq + "\n\nShall we continue?";
      await appendMessage(sessionId, "user", userMessage);
      await appendMessage(sessionId, "assistant", `${reply} [[STEP:${currentStep}]] [[FAQ]]`);
      await telemetry(sessionId, "faq_hit", { q: userMessage });
      return res.status(200).json({
        reply,
        stepIndex: currentStep,
        quickReplies: ["Continue", "Open Portal", "Something else"]
      });
    }

    // Resolve current and next step from the script
    const steps = script?.steps || [];
    const step = steps.find((s) => s.id === currentStep) || steps[0] || { id: 0, prompt: "Let’s continue." };

    // Special: if this looks like a name reply, surface it to the UI
    let displayName: string | undefined;
    if (currentStep === 0) displayName = inferDisplayName(userMessage);

    // Decide whether to advance
    const shouldAdvance = matchAny(userMessage, step.keywords || []);
    let nextStepId = currentStep;
    let openPortal = false;
    let reply = "";

    if (shouldAdvance) {
      nextStepId = Math.min(
        currentStep + 1,
        steps.length ? steps[steps.length - 1].id : currentStep + 1
      );
      const next = steps.find((s) => s.id === nextStepId);
      reply = (empathy ? empathy + " " : "") + (next?.prompt || step.prompt || "Thanks — let’s continue.");
      if (next?.openPortal) openPortal = true;

      await appendMessage(sessionId, "user", userMessage);
      await appendMessage(sessionId, "assistant", `${reply} [[STEP:${nextStepId}]]`);
      await telemetry(sessionId, "step_advance", { from: currentStep, to: nextStepId, msg: userMessage });

      return res.status(200).json({
        reply,
        stepIndex: nextStepId,
        openPortal,
        displayName, // UI can show “Welcome {name}”
        quickReplies: openPortal ? ["Open Portal", "Continue"] : ["Continue", "Go on"]
      });
    }

    // Gentle nudge back to current question (one sentence, no loop)
    let steer = (empathy ? empathy + " " : "") + "Let’s keep focused on that last question so I can help quickly.";
    try {
      if (openai.apiKey) {
        const system =
          "You are Mark, a professional UK debt advisor. Reply with ONE short, warm sentence. You may use gentle humour sparingly. Steer the user back to the current question.";
        const prompt = `Current question: "${step.prompt}". User: "${userMessage}". Compose a single friendly sentence that nudges them back.`;
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.5,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ]
        });
        steer = (empathy ? empathy + " " : "") + (completion.choices[0]?.message?.content?.trim() || steer);
      }
    } catch {
      // ignore — we already have a fallback
    }

    await appendMessage(sessionId, "user", userMessage);
    await appendMessage(sessionId, "assistant", `${steer} [[STEP:${currentStep}]]`);
    await telemetry(sessionId, "nudge", { step: currentStep });

    return res.status(200).json({
      reply: steer,
      stepIndex: currentStep,
      displayName,
      quickReplies: ["Repeat question", "Open Portal", "Help"]
    });
  } catch (e: any) {
    await telemetry(clean(req.body?.sessionId) || "unknown", "error", { message: String(e?.message || e) });
    return res.status(500).json({ reply: "Sorry, something went wrong on my end." });
  }
}
