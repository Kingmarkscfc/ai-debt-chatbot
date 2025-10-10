import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

import scriptJson from "../../utils/full_script_logic.json";
import faqs from "../../utils/faqs.json";

// ---------- Setup ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "") as string
);

type ChatMsg = { role: "user" | "assistant"; content: string };

type Step = {
  id: number;
  name: string;           // logical name of the step
  prompt: string;         // what we ask next
  keywords?: string[];    // heuristics for “answered”
  openPortal?: boolean;
  auto_advance?: boolean; // auto-advance once we arrive here
};

type Script = {
  steps: Step[];
  small_talk?: { greetings?: string[]; ack?: string[] };
  empathy?: { re: string; msg: string }[];
};

const S = scriptJson as Script;

// ---------- Utilities ----------
const clean = (s: any) => (s ?? "").toString().trim();
const normalize = (s: string) => clean(s).toLowerCase();
const matchAny = (s: string, arr: string[] = []) => {
  if (!arr?.length) return true;
  const low = normalize(s);
  return arr.some(k => low.includes(k.toLowerCase()));
};

const STEP_TAG = (id: number) => `<!--STEP:${id}-->`;
function readStepTag(text: string): number | null {
  const m = text.match(/<!--STEP:(\d+)-->/);
  return m ? parseInt(m[1], 10) : null;
}

// Pure greeting (short, doesn’t answer)
function isGreeting(s: string, S: Script): boolean {
  const g = S.small_talk?.greetings || [];
  const low = s.trim().toLowerCase();
  return g.some(w => low.startsWith(w));
}
function greetAck(S: Script): string {
  const acks = S.small_talk?.ack || [];
  return acks.length ? acks[Math.floor(Math.random() * acks.length)] : "Hi there — I’m here to help.";
}

// New: reciprocal small-talk Q&A (answer then steer back)
function smallTalkAnswer(s: string): string | null {
  const low = s.toLowerCase();
  // “how are you” / “how’s your day”
  if (/(^|\b)how('?s|\s+is)?\s+(your|ya)\s+(day|evening|morning)?\b/.test(low) || /\bhow are you\b/.test(low)) {
    return "I’m good, thanks for asking — more importantly, let’s focus on you.";
  }
  // “who are you / what’s your name”
  if (/\bwho (are|r) you\b/.test(low) || /\bwhat('?s|\s+is)\s+your\s+name\b/.test(low)) {
    return "I’m Mark, your UK debt advisor in this chat.";
  }
  // “where are you based”
  if (/\bwhere (are|r) you based\b/.test(low)) {
    return "I’m a UK-based digital advisor, here to help wherever you are.";
  }
  // “are you real / human”
  if (/\b(are you (real|human)|is this real)\b/.test(low)) {
    return "I’m a virtual advisor — friendly, trained on UK guidance, and here to support you.";
  }
  return null;
}

function empathyBlurb(s: string, S: Script): string | null {
  if (!S.empathy) return null;
  for (const e of S.empathy) {
    try {
      const rx = new RegExp(e.re, "i");
      if (rx.test(s)) return e.msg;
    } catch {}
  }
  return null;
}

function extractName(msg: string): string | undefined {
  const m = msg.match(/\b(i'?m|i am|my name is|it'?s|call me)\s+([a-z][a-z'\- ]{1,40})/i);
  if (m) return tidyName(m[2]);
  if (/^[A-Za-z][A-Za-z'\- ]{1,40}$/.test(msg.trim())) return tidyName(msg.trim());
  return undefined;
}
function tidyName(raw: string) {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
function personalise(prompt: string, name?: string) {
  return prompt.replace(/\{name\}/g, name || "there");
}

function pickFaq(userMsg: string): string | null {
  try {
    const low = normalize(userMsg);
    for (const f of (faqs as any[])) {
      const keys: string[] = Array.isArray(f.keywords) ? f.keywords : [];
      if (keys.some(k => low.includes(k.toLowerCase()))) return (f as any).a as string;
    }
  } catch {}
  return null;
}

async function briefSteer(currentPrompt: string, userMsg: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return `Let’s keep on track: ${currentPrompt}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "Be a UK debt advisor named Mark. Reply in one short, kind sentence, and steer them back to the current question without repeating it verbatim." },
        { role: "user", content: `Current question:\n${currentPrompt}\nUser said:\n${userMsg}\nGive one gentle sentence to guide them back.` }
      ]
    });
    return r.choices[0]?.message?.content?.trim() || `Let’s keep on track: ${currentPrompt}`;
  } catch {
    return `Let’s keep on track: ${currentPrompt}`;
  }
}

// ---------- DB (messages table) ----------
async function loadHistory(sessionId: string): Promise<ChatMsg[]> {
  const { data } = await supabase
    .from("messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  return (data || []) as ChatMsg[];
}

async function appendMessage(sessionId: string, role: "user" | "assistant", content: string) {
  await supabase.from("messages").insert({ session_id: sessionId, role, content });
}

function lastStepFromHistory(history: ChatMsg[]): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const s = readStepTag(history[i].content || "");
    if (typeof s === "number" && !Number.isNaN(s)) return s;
  }
  return null;
}

function extractNameFromHistory(history: ChatMsg[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      const n = extractName(history[i].content || "");
      if (n) return n;
    }
  }
  return undefined;
}

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = clean(req.body.sessionId) || Math.random().toString(36).slice(2);
    const userMessage = clean(req.body.userMessage || req.body.message);

    // Load history from existing `messages` table
    let history = await loadHistory(sessionId);

    // FIRST TURN: seed with intro (no globe line)
    if (!history.length) {
      const intro = S.steps[0]?.prompt || "Hello! What prompted you to seek help today?";
      const marked = `${intro}\n${STEP_TAG(0)}`;
      await appendMessage(sessionId, "assistant", marked);
      return res.status(200).json({ reply: intro, sessionId, stepIndex: 0, totalSteps: S.steps.length });
    }

    // Append user input
    if (userMessage) await appendMessage(sessionId, "user", userMessage);

    // Compute current step
    history = await loadHistory(sessionId);
    let currentStepIdx = lastStepFromHistory(history);
    if (currentStepIdx == null) currentStepIdx = 0;
    const currentStep = S.steps[currentStepIdx] || S.steps[0];

    // Determine if the user already answered the current step
    const answeredCurrent = matchAny(userMessage, currentStep.keywords || []);
    const tokenCount = userMessage.split(/\s+/).filter(Boolean).length;

    // Pure greeting (short + not answering)
    const pureGreeting = isGreeting(userMessage, S) && !answeredCurrent && tokenCount <= 4;
    if (pureGreeting && currentStepIdx <= 1) {
      const reply = `${greetAck(S)}\n${currentStep.prompt}`;
      const marked = `${reply}\n${STEP_TAG(currentStep.id)}`;
      await appendMessage(sessionId, "assistant", marked);
      return res.status(200).json({ reply, sessionId, stepIndex: currentStep.id, totalSteps: S.steps.length });
    }

    // New: reciprocal small-talk Q (brief answer, stay on the SAME step)
    const smallQA = smallTalkAnswer(userMessage);
    if (smallQA && !answeredCurrent) {
      const reply = `${smallQA} ${personalise(currentStep.prompt, extractNameFromHistory(history))}`;
      const marked = `${reply}\n${STEP_TAG(currentStep.id)}`;
      await appendMessage(sessionId, "assistant", marked);
      return res.status(200).json({ reply, sessionId, stepIndex: currentStep.id, totalSteps: S.steps.length, openPortal: false });
    }

    // Empathy + FAQ candidates
    const empath = empathyBlurb(userMessage, S);
    const faq = pickFaq(userMessage);

    // Name capture
    let nameState = extractNameFromHistory(history);
    if (!nameState && currentStep.name === "name") {
      const n = extractName(userMessage);
      if (n) nameState = n;
    }

    // Advance logic
    let nextIdx = currentStepIdx;
    if (currentStep.auto_advance || answeredCurrent) {
      nextIdx = Math.min(currentStepIdx + 1, S.steps.length - 1);
    }

    // Portal gating at the dedicated step ONLY
    if (currentStep.name === "invite_portal") {
      const agree = /^(y(es)?|ok(ay)?|sure|go ahead|open|start|portal|set up)/i.test(userMessage.trim());
      if (!agree) {
        const reply = "No problem — I’ll keep the portal closed for now. When you’re ready just say “open the portal”.";
        const marked = `${reply}\n${STEP_TAG(currentStep.id)}`;
        await appendMessage(sessionId, "assistant", marked);
        return res.status(200).json({ reply, sessionId, stepIndex: currentStep.id, totalSteps: S.steps.length, openPortal: false });
      }
    }

    const nextStep = S.steps[nextIdx];
    let reply = personalise(nextStep.prompt, nameState);

    if (!currentStep.auto_advance && !answeredCurrent && nextIdx === currentStepIdx) {
      // Didn’t match → steer back to current step
      const steer = await briefSteer(currentStep.prompt, userMessage);
      reply = [empath, faq, steer].filter(Boolean).join(" ");
    } else {
      // Advanced → add soft acknowledgement
      const soft = empath || (currentStepIdx > 0 ? "Thanks — that helps." : "");
      reply = [soft, reply].filter(Boolean).join(" ");
    }

    // Decide whether to open portal (only on invite_portal and only after agreement)
    let openPortal = false;
    if (currentStep.name === "invite_portal" && currentStep.openPortal) {
      openPortal = true;
    }

    // Tag with the *next* step we’re asking
    const marked = `${reply}\n${STEP_TAG(nextStep.id)}`;
    await appendMessage(sessionId, "assistant", marked);

    return res.status(200).json({
      reply,
      sessionId,
      stepIndex: nextStep.id,
      totalSteps: S.steps.length,
      openPortal
    });

  } catch (err: any) {
    console.error("❌ chat.ts error:", err?.message || err);
    return res.status(200).json({ reply: "Sorry, I hit a snag there — please try again.", error: true });
  }
}
