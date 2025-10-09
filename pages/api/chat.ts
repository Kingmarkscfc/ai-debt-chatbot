// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- Optional deps (won't crash if missing) ---
let openai: OpenAI | null = null;
try {
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch (_) {
  openai = null;
}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";
const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
    : null;

// --- Script & FAQs (robust loads) ---
type Step = { prompt: string; keywords?: string[] };
type Script = { steps: Step[] };

let SCRIPT_STEPS: Step[] = [
  { prompt: "Great, I look forward to helping you clear your debts. Can I take your full name?" },
  { prompt: "Thanks. What’s your main concern with the debts right now (e.g., payment pressure, creditor contact, interest)?" },
  { prompt: "Understood. I’ll set you up with a quick portal to gather details and documents. Ready to start?" },
  { prompt: "Opening your secure portal now—this only takes a minute and helps us tailor a plan." },
];

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const script = require("../../utils/full_script_logic.json") as Script;
  if (script?.steps?.length) SCRIPT_STEPS = script.steps;
} catch (_) {
  // keep defaults
}

type FAQ = { q: string; a: string; keywords?: string[] };
let FAQS: FAQ[] = [];
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  FAQS = require("../../utils/faqs.json") as FAQ[];
} catch (_) {
  FAQS = [];
}

// --- Helpers ---
const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|bailiffs|enforcement/i, "I know bailiff contact is stressful — let’s get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be scary — we’ll deal with those in your plan."],
  [/miss(ed)? payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/gambl|crypto|stock/i, "Thanks for being honest — we’ll keep things practical and judgement-free."],
];

function pickEmpathy(u: string): string | null {
  for (const [re, line] of EMPATHY) if (re.test(u)) return line;
  return null;
}

function matchFAQ(u: string): FAQ | null {
  const txt = u.toLowerCase();
  for (const f of FAQS) {
    const kws = f.keywords || [];
    if (kws.some(k => txt.includes(k.toLowerCase()))) return f;
  }
  return null;
}

function nameLike(u: string) {
  const trimmed = u.trim();
  if (trimmed.length < 2) return null;
  // naive-ish: two words or contains space/hyphen/apostrophe
  if (/\b[a-z]+[ -'][a-z]+/i.test(trimmed) || /\s/.test(trimmed)) return trimmed;
  return null;
}

function nextStepIndex(history: string[]) {
  // We only get text array from the client, so we infer:
  // Count how many times we sent a script prompt already by looking for exact matches.
  let count = 0;
  for (const h of history) {
    if (SCRIPT_STEPS.some(s => s.prompt === h)) count++;
  }
  // first reply after greeting = step0
  return Math.min(count, Math.max(0, SCRIPT_STEPS.length - 1));
}

function okJson(res: NextApiResponse, payload: any) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(JSON.stringify(payload));
}

async function logTelemetry(sessionId: string, type: string, payload: any) {
  try {
    if (!supabase) return;
    await supabase.from("chat_telemetry").insert({
      session_id: sessionId,
      event_type: type,
      payload,
    });
  } catch {
    // swallow
  }
}

// --- Handler ---
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = (req.body?.sessionId as string) || uuidv4();

    // Accept multiple field names to be safe
    const userMessage: string = String(
      req.body?.userMessage ?? req.body?.message ?? req.body?.text ?? ""
    ).trim();

    const language: string = String(req.body?.language || "English");
    const history: string[] = Array.isArray(req.body?.history) ? req.body.history : [];

    if (!userMessage) {
      return okJson(res, {
        reply: "Please type a message to begin.",
        sessionId,
        stepIndex: 0,
        totalSteps: SCRIPT_STEPS.length,
      });
    }

    // Quick FAQ
    const faq = matchFAQ(userMessage);
    if (faq) {
      const empathy = pickEmpathy(userMessage);
      const reply = empathy ? `${empathy} ${faq.a}` : faq.a;
      await logTelemetry(sessionId, "faq", { q: faq.q });
      return okJson(res, {
        reply,
        sessionId,
        stepIndex: nextStepIndex(history),
        totalSteps: SCRIPT_STEPS.length,
      });
    }

    // Script progression (no loops)
    const stepIdx = nextStepIndex(history);
    let reply = "";
    let openPortal = false;
    let displayName: string | undefined;

    if (stepIdx === 0) {
      // We just asked for the name
      const nm = nameLike(userMessage);
      if (nm) {
        displayName = nm;
        reply = SCRIPT_STEPS[1]?.prompt || "What’s your main concern right now?";
      } else {
        reply = "Got it — may I take your full name so I can personalise things?";
      }
    } else if (stepIdx === 1) {
      // We asked for the main concern
      const empathy = pickEmpathy(userMessage);
      reply = (empathy ? `${empathy} ` : "") + (SCRIPT_STEPS[2]?.prompt || "I’ll set up your portal to gather details. Ready to start?");
    } else if (stepIdx === 2) {
      // Ask to open portal
      const yesy = /\b(yes|yeah|ok|okay|yep|sure|ready|start|go)\b/i.test(userMessage);
      if (yesy) {
        reply = SCRIPT_STEPS[3]?.prompt || "Opening your secure portal now.";
        openPortal = true;
      } else {
        reply = "No problem — when you’re ready, I can open the secure portal to move things forward.";
      }
    } else {
      // Past the core steps — keep helpful, avoid loops
      const empathy = pickEmpathy(userMessage);
      reply = (empathy ? `${empathy} ` : "") + "If you’d like, I can open your portal so you can add details and upload documents.";
      // try to infer intent to open
      if (/\b(portal|upload|register|sign ?in|log ?in)\b/i.test(userMessage)) openPortal = true;
    }

    // Gentle off-script steering via OpenAI (optional)
    if (!reply && openai) {
      try {
        const sys = "You are Mark, a UK debt advisor. Reply warmly in one sentence and avoid repetition.";
        const cmp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.5,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userMessage },
          ],
        });
        reply = cmp.choices[0]?.message?.content?.trim() || "Thanks — let’s keep going.";
      } catch {
        reply = "Thanks — let’s keep going.";
      }
    }

    // Always respond with JSON so the frontend never hits .catch
    await logTelemetry(sessionId, "chat", { stepIdx, openPortal });
    return okJson(res, {
      reply: reply || "Thanks — let’s continue.",
      sessionId,
      stepIndex: Math.min(stepIdx + 1, SCRIPT_STEPS.length - 1),
      totalSteps: SCRIPT_STEPS.length,
      openPortal,
      displayName,
    });
  } catch (e: any) {
    // Never leak stack; always JSON
    return okJson(res, {
      reply: "Sorry, something went wrong on my end. Please try again.",
      error: "handled",
    });
  }
}
