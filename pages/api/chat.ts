import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

import scriptJson from "../../utils/full_script_logic.json";
import faqs from "../../utils/faqs.json";

/** ========================= Setup ========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "") as string
);

type ChatMsg = { role: "user" | "assistant"; content: string };

type Step = {
  id: number;
  name?: string;          // optional (we’ll fallback by index)
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;   // only honored on the "invite_portal" step
  auto_advance?: boolean; // not commonly used but supported
};

type Script = {
  steps: Step[];
  small_talk?: { greetings?: string[]; ack?: string[] };
  empathy?: { re: string; msg: string }[];
};

const S = scriptJson as Script;

/** ========================= Helpers ========================= */
const clean = (s: any) => (s ?? "").toString().trim();
const normalize = (s: string) => clean(s).toLowerCase();
const STEP_TAG = (id: number) => `<!--STEP:${id}-->`;
const readStepTag = (t: string) => {
  const m = t.match(/<!--STEP:(\d+)-->/);
  return m ? parseInt(m[1], 10) : null;
};

const matchAny = (s: string, arr: string[] = []) => {
  if (!arr?.length) return true;
  const low = normalize(s);
  return arr.some(k => low.includes(k.toLowerCase()));
};

const nameByIndex = (id: number) => {
  // Fallback mapping if your JSON doesn’t include "name"
  const map: Record<number, string> = {
    0: "name",
    1: "concern",
    2: "more_detail",
    3: "affordability",
    4: "urgent_check",
    5: "invite_portal",
    6: "portal_followup",
    7: "regulatory_note",
    8: "docs_request",
    9: "wrap_up"
  };
  return map[id] || `step_${id}`;
};

const currentStepName = (st: Step) => st.name || nameByIndex(st.id);

function isPureGreeting(s: string): boolean {
  const g = S.small_talk?.greetings || ["hi","hello","hey","good morning","good afternoon","good evening"];
  const low = normalize(s);
  // “pure” = short & doesn’t carry a debt intent
  const short = low.split(/\s+/).length <= 4;
  const hasDebtWords = /(debt|card|loan|arrears|missed|repay|interest|bailiff|ccj)/i.test(s);
  return short && !hasDebtWords && g.some(w => low.startsWith(w));
}

function smallTalkAnswer(s: string): string | null {
  const low = s.toLowerCase();
  if (/\bhow (are|r) you\b/.test(low) || /how('?s|\s+is)\s+(your|ya)\s+(day|evening|morning)?\b/.test(low)) {
    return "I’m good, thanks for asking — more importantly, let’s focus on getting you the help you need.";
  }
  if (/\bwho (are|r) you\b/.test(low) || /\bwhat('?s|\s+is)\s+your\s+name\b/.test(low)) {
    return "I’m Mark, your UK debt advisor in this chat.";
  }
  if (/\bwhere (are|r) you based\b/.test(low)) {
    return "I’m a UK-based digital advisor.";
  }
  if (/\b(are you (real|human)|is this real)\b/.test(low)) {
    return "I’m a virtual advisor trained on UK guidance — here to support you.";
  }
  return null;
}

function empathyBlurb(s: string): string | null {
  const low = s.toLowerCase();
  // Quick, intent-specific empathy (short & upbeat; no “thanks”)
  if (/bailiff|enforcement|ccj|default|court/.test(low)) return "That’s stressful — we’ll take it one step at a time and protect essentials.";
  if (/miss(ed)? payment|arrears|late fee/.test(low)) return "I’m sorry that’s been happening — we’ll steady things from here.";
  if (/interest|charges|high payment|repay/.test(low)) return "I’m sorry it’s felt heavy — I’ll do my best to help reduce the pressure.";
  if (/debt|card|loan|overdraft|catalogue|finance/.test(low)) return "I’m sorry to hear that — we’ll work out the best route forward together.";
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
  if (!process.env.OPENAI_API_KEY) return `Let’s come back to this: ${currentPrompt}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "You are a kind, concise UK debt advisor named Mark. In one short sentence, acknowledge briefly then steer the user back to the current question without repeating it verbatim." },
        { role: "user", content: `Current question:\n${currentPrompt}\nUser said:\n${userMsg}\nGive one short sentence to guide them back.` }
      ]
    });
    return r.choices[0]?.message?.content?.trim() || `Let’s come back to this: ${currentPrompt}`;
  } catch {
    return `Let’s come back to this: ${currentPrompt}`;
  }
}

/** =============== DB (messages) =============== */
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

/** =============== Handler =============== */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const sessionId = clean(req.body.sessionId) || Math.random().toString(36).slice(2);
    const userMessage = clean(req.body.userMessage || req.body.message);

    // Load history
    let history = await loadHistory(sessionId);

    // First turn → seed with step 0 prompt (no extra lines)
    if (!history.length) {
      const intro = S.steps[0]?.prompt || "Hello — what prompted you to seek help with your debts today?";
      const marked = `${intro}\n${STEP_TAG(0)}`;
      await appendMessage(sessionId, "assistant", marked);
      return res.status(200).json({ reply: intro, sessionId, stepIndex: 0, totalSteps: S.steps.length });
    }

    // Save user input
    if (userMessage) await appendMessage(sessionId, "user", userMessage);

    // Determine current step
    history = await loadHistory(sessionId);
    let currentIdx = lastStepFromHistory(history);
    if (currentIdx == null) currentIdx = 0;
    const currentStep = S.steps[currentIdx] || S.steps[0];
    const currentName = currentStepName(currentStep);

    // Decide whether the user answered the current step
    const answeredCurrent = matchAny(userMessage, currentStep.keywords || []);
    const tokenCount = userMessage.split(/\s+/).filter(Boolean).length;

    // If pure greeting AND we’re still early, acknowledge briefly then ask the same step
    if (isPureGreeting(userMessage) && !answeredCurrent && currentIdx <= 1) {
      const reply = `Hi — I’m here to help. ${personalise(currentStep.prompt, extractNameFromHistory(history))}`;
      const marked = `${reply}\n${STEP_TAG(currentStep.id)}`;
      await appendMessage(sessionId, "assistant", marked);
      return res.status(200).json({ reply, sessionId, stepIndex: currentStep.id, totalSteps: S.steps.length });
    }

    // Small-talk Q (e.g., “how are you?”) → answer briefly, keep same step (no “thanks”)
    const smallQA = smallTalkAnswer(userMessage);
    if (smallQA && !answeredCurrent) {
      const reply = `${smallQA} ${personalise(currentStep.prompt, extractNameFromHistory(history))}`;
      const marked = `${reply}\n${STEP_TAG(currentStep.id)}`;
      await appendMessage(sessionId, "assistant", marked);
      return res.status(200).json({ reply, sessionId, stepIndex: currentStep.id, totalSteps: S.steps.length, openPortal: false });
    }

    // Lightweight empathy (only once per turn, short, no “thanks”)
    const empath = empathyBlurb(userMessage);

    // Name capture if we’re at name step
    let nameState = extractNameFromHistory(history);
    if (!nameState && currentName === "name") {
      const n = extractName(userMessage);
      if (n) nameState = n;
    }

    // Should we advance?
    let nextIdx = currentIdx;
    if (currentStep.auto_advance || answeredCurrent) {
      nextIdx = Math.min(currentIdx + 1, S.steps.length - 1);
    }

    // Portal invite step: only move if they agree; don’t pop early
    if (currentName === "invite_portal") {
      const agree = /^(y(es)?|ok(ay)?|sure|go ahead|open|start|portal|set up)/i.test(userMessage);
      if (!agree && !answeredCurrent) {
        const reply = (empath ? empath + " " : "") + "No problem — I’ll keep the portal closed for now. When you’re ready just say “open the portal”.";
        const marked = `${reply}\n${STEP_TAG(currentStep.id)}`;
        await appendMessage(sessionId, "assistant", marked);
        return res.status(200).json({ reply, sessionId, stepIndex: currentStep.id, totalSteps: S.steps.length, openPortal: false });
      }
    }

    const nextStep = S.steps[nextIdx];
    const nextName = currentStepName(nextStep);

    // Acknowledgement style per step (no generic “Thanks — that helps.”)
    const ACK: Record<string, string> = {
      name: "",            // user just told us their name → no “thanks”, we’ll be warm in the next line
      concern: empath || "Got it.",
      more_detail: empath || "Understood.",
      affordability: "Understood.",
      urgent_check: "Thanks — noted.",
      invite_portal: empath || "",
      portal_followup: "",
      regulatory_note: "",
      docs_request: "",
      wrap_up: ""
    };

    let reply: string;

    if (!currentStep.auto_advance && !answeredCurrent && nextIdx === currentIdx) {
      // Didn’t answer → gentle steer
      const steer = await briefSteer(currentStep.prompt, userMessage);
      // Prefer empathy first, then steer, maybe append an FAQ if appropriate
      const faq = pickFaq(userMessage);
      reply = [empath, steer, faq].filter(Boolean).join(" ");
      const marked = `${reply}\n${STEP_TAG(currentStep.id)}`;
      await appendMessage(sessionId, "assistant", marked);
      return res.status(200).json({ reply, sessionId, stepIndex: currentStep.id, totalSteps: S.steps.length, openPortal: false });
    } else {
      // Advancing to next step
      // Empathy for hardship shares on early steps; otherwise use short ACK from table
      let head = "";
      if (currentName === "name") {
        // Use a friendly line right after learning the name
        const nm = nameState ? `Nice to meet you, ${nameState}.` : "Nice to meet you.";
        head = nm;
      } else {
        head = ACK[currentName] || "";
      }

      reply = [head, personalise(nextStep.prompt, nameState)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }

    // Portal opens ONLY on invite step and ONLY when we just agreed
    let openPortal = false;
    if (currentName === "invite_portal" && currentStep.openPortal) {
      openPortal = true;
    }

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
