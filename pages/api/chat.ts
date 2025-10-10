import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import type { ChatCompletionMessageParam } from "openai/resources";
import OpenAI from "openai";

import scriptJson from "../../utils/full_script_logic.json";
import faqs from "../../utils/faqs.json";

// ---------- Setup ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "") as string
);

type Step = { id: number; name: string; prompt: string; keywords?: string[]; openPortal?: boolean; auto_advance?: boolean };
type Script = {
  steps: Step[];
  small_talk?: { greetings?: string[]; ack?: string[] };
  empathy?: { re: string; msg: string }[];
};

// keep super small, deterministic “empathy” without changing state
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

function isGreeting(s: string, S: Script): boolean {
  const g = S.small_talk?.greetings || [];
  const low = s.trim().toLowerCase();
  return g.some(w => low.startsWith(w));
}

function greetAck(S: Script): string {
  const acks = S.small_talk?.ack || [];
  return acks.length ? acks[Math.floor(Math.random()*acks.length)] : "Hi — let’s work through this together.";
}

function clean(s: string) { return (s || "").toString().trim(); }
function normalize(s: string) { return clean(s).toLowerCase(); }

function matchAny(s: string, arr: string[] = []): boolean {
  if (!arr.length) return true;
  const low = normalize(s);
  return arr.some(k => low.includes(k.toLowerCase()));
}

// We embed a tiny step marker in assistant messages so we can *reliably* know state
const STEP_TAG = (id: number) => `<!--STEP:${id}-->`;
const findLastStepInHistory = (history: ChatCompletionMessageParam[]): number | null => {
  for (let i = history.length - 1; i >= 0; i--) {
    const c = typeof history[i].content === "string" ? (history[i].content as string) : "";
    const m = c.match(/<!--STEP:(\d+)-->/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
};

const S = scriptJson as Script;

// Fallback mini-humour if we need a single line and no LLM call
const gentleFallback = [
  "Understood — let’s keep it simple and get you sorted.",
  "Got it. We’ll take this step by step.",
  "No problem — I’ll guide you through."
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = clean(req.body.sessionId) || Math.random().toString(36).slice(2);
    const lang = clean(req.body.language || "English");
    const userMessage = clean(req.body.userMessage || req.body.message);

    // Load conversation history
    let { data: historyRow } = await supabase
      .from("chat_history")
      .select("messages")
      .eq("session_id", sessionId)
      .single();

    let history: ChatCompletionMessageParam[] = (historyRow?.messages || []) as ChatCompletionMessageParam[];

    // Brand-new session → drop just one intro prompt (no extra globe line)
    if (!history.length) {
      const intro = S.steps[0]?.prompt || "Hello! What prompted you to seek help today?";
      const first = `${intro}\n${STEP_TAG(0)}`;
      history = [{ role: "assistant", content: first }];
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply: intro, sessionId, stepIndex: 0, totalSteps: S.steps.length });
    }

    if (!userMessage) {
      const again = "Could you say that again?";
      return res.status(200).json({ reply: again, sessionId, stepIndex: findLastStepInHistory(history) ?? 0, totalSteps: S.steps.length });
    }

    // Append user message
    history.push({ role: "user", content: userMessage });

    // Determine current step deterministically
    let currentStepIdx = findLastStepInHistory(history);
    if (currentStepIdx === null) {
      // Safety: if missing a marker, infer by number of assistant prompts modulo steps
      const assistants = history.filter(m => m.role === "assistant").length;
      currentStepIdx = Math.max(0, Math.min(assistants - 1, S.steps.length - 1));
    }

    const currentStep = S.steps[currentStepIdx] || S.steps[0];

    // small talk: reply warmly once, then re-ask current step (no advancement)
    if (isGreeting(userMessage, S) && currentStepIdx <= 1) {
      const reply = `${greetAck(S)}\n${currentStep.prompt}`;
      const marked = `${reply}\n${STEP_TAG(currentStep.id)}`;
      history.push({ role: "assistant", content: marked });
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });
      return res.status(200).json({ reply, sessionId, stepIndex: currentStep.id, totalSteps: S.steps.length });
    }

    // Light empathy insert (does not change step)
    const empath = empathyBlurb(userMessage, S);

    // FAQ assist (inline, then re-ask prompt)
    const faq = pickFaq(userMessage);

    // If the current step requires a match to advance:
    let nextIdx = currentStepIdx;
    const matched = matchAny(userMessage, currentStep.keywords || []);
    const nameInMsg = extractName(userMessage);

    // Personalisation: store name by echoing in next prompt
    let nameState: string | undefined = extractNameFromHistory(history);
    if (!nameState && currentStep.name === "name" && nameInMsg) {
      nameState = nameInMsg;
    }

    // Decide advancement
    if (currentStep.auto_advance || matched) {
      // advance to next step (but only one at a time)
      nextIdx = Math.min(currentStepIdx + 1, S.steps.length - 1);
    }

    // Special case: name step → if user provided a name, we also personalise the next prompt
    const nextStep = S.steps[nextIdx];
    let reply = personalise(nextStep.prompt, nameState);

    // If not matched and no auto-advance, gently steer back (no loop)
    if (!currentStep.auto_advance && !matched && nextIdx === currentStepIdx) {
      // stay on the same prompt, but add empathy/faq if any, then re-ask current in one line
      const steer = await briefSteer(currentStep.prompt, userMessage);
      reply = [empath, faq, steer].filter(Boolean).join(" ");
    } else {
      // we advanced; prepend empathy or short ack if we have it
      const soft = empath || (currentStepIdx > 0 ? "Thanks — that helps." : "");
      reply = [soft, reply].filter(Boolean).join(" ");
    }

    // Only open portal at the **invite_portal** step AND when the user actually agrees
    let openPortal = false;
    if (currentStep.name === "invite_portal") {
      const agree = /^(y(es)?|ok(ay)?|sure|go ahead|open|start|portal|set up)/i.test(userMessage.trim());
      openPortal = !!(currentStep.openPortal && agree);
      // If user didn’t agree, keep them on the same step (don’t advance)
      if (!agree) {
        nextIdx = currentStepIdx; // hold position
        reply = "No problem — I’ll keep the portal closed for now. When you’re ready just say “open the portal”.";
      }
    }

    // If we advanced to the “portal_guidance” step (after portal opened), add the guidance line once.
    if (nextStep?.name === "portal_guidance") {
      reply = personalise(nextStep.prompt, nameState);
    }

    // Tag the reply with the step we are *now asking*
    const marked = `${reply}\n${STEP_TAG(nextStep.id)}`;
    history.push({ role: "assistant", content: marked });

    // Persist history
    await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history });

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

// ---------- helpers ----------
function extractName(msg: string): string | undefined {
  const m = msg.match(/\b(i'?m|i am|my name is|it'?s|call me)\s+([a-z][a-z'\- ]{1,40})$/i);
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
function extractNameFromHistory(history: ChatCompletionMessageParam[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user") {
      const found = extractName(String(m.content || ""));
      if (found) return found;
    }
  }
  return undefined;
}
function personalise(prompt: string, name?: string) {
  return prompt.replace(/\{name\}/g, name || "there");
}

async function briefSteer(currentPrompt: string, userMsg: string): Promise<string> {
  // Keep LLM use tiny & cheap; if no key, fall back locally
  if (!process.env.OPENAI_API_KEY) {
    return `Let’s keep on track: ${currentPrompt}`;
  }
  try {
    const completion = await new OpenAI({ apiKey: process.env.OPENAI_API_KEY }).chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "Be a UK debt advisor named Mark. Reply in one short, kind sentence, and steer them back to the current question without repeating it verbatim." },
        { role: "user", content: `Current question:\n${currentPrompt}\nUser said:\n${userMsg}\nGive one gentle sentence to guide them back.` }
      ]
    });
    const out = completion.choices[0]?.message?.content?.trim();
    return out || `Let’s keep on track: ${currentPrompt}`;
  } catch {
    return `Let’s keep on track: ${currentPrompt}`;
  }
}

function pickFaq(userMsg: string): string | null {
  try {
    const low = normalize(userMsg);
    // simple keyword match: if multiple match, choose the first
    for (const f of (faqs as any[])) {
      const keys: string[] = Array.isArray(f.keywords) ? f.keywords : [];
      if (keys.some(k => low.includes(k.toLowerCase()))) {
        return f.a as string;
      }
    }
  } catch {}
  return null;
}
