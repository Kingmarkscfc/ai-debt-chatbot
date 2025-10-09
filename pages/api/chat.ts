// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/* ---------- Optional deps (no hard crash if unset) ---------- */
let openai: OpenAI | null = null;
try {
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch {
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

/* ---------- Script & FAQs (robust loads) ---------- */
type Step = { prompt: string; keywords?: string[] };
type Script = { steps: Step[] };

let SCRIPT_STEPS: Step[] = [
  { prompt: "Great, I look forward to helping you clear your debts. Can I take your full name?" },
  { prompt: "Thanks. What’s your main concern with the debts right now (e.g., payment pressure, creditor contact, interest)?" },
  { prompt: "I’ll set you up with a quick portal to gather details and documents. Ready to start?" },
  { prompt: "Opening your secure portal now." }
];

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const script = require("../../utils/full_script_logic.json") as Script;
  if (script?.steps?.length) SCRIPT_STEPS = script.steps;
} catch {
  /* keep defaults */
}

type FAQ = { q: string; a: string; keywords?: string[] };
let FAQS: FAQ[] = [];
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  FAQS = require("../../utils/faqs.json") as FAQ[];
} catch {
  FAQS = [];
}

/* ---------- Helpers ---------- */
const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|bailiffs|enforcement/i, "I know bailiff contact is stressful — let’s get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be scary — we’ll deal with those in your plan."],
  [/miss(ed)? payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/gambl|crypto|stock/i, "Thanks for being honest — we’ll keep things practical and judgement-free."]
];

function pickEmpathy(u: string): string | null {
  for (const [re, line] of EMPATHY) if (re.test(u)) return line;
  return null;
}

// Only treat something as a FAQ if it's phrased like a question
function isQuestion(u: string): boolean {
  const t = u.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(how|what|can|will|do|does|did|is|are|should|could|may|might)\b/i.test(t);
}

function matchFAQ(u: string): FAQ | null {
  if (!isQuestion(u)) return null;
  const txt = u.toLowerCase();
  for (const f of FAQS) {
    const kws = f.keywords || [];
    if (kws.some(k => txt.includes(k.toLowerCase()))) return f;
  }
  return null;
}

function extractName(u: string) {
  const t = u.trim();
  if (t.length < 2) return null;
  if (/\b[a-z]+[ -'][a-z]+/i.test(t) || /\s/.test(t)) return t;
  return null;
}

function mentionsDebtTypes(u: string): boolean {
  return /\b(credit\s*cards?|loans?|overdraft|catalogue|payday|store\s*card|finance)\b/i.test(u);
}

function nextStepIndex(history: string[]) {
  let count = 0;
  for (const h of history) if (SCRIPT_STEPS.some(s => s.prompt === h)) count++;
  return Math.min(count, Math.max(0, SCRIPT_STEPS.length - 1));
}

async function logTelemetry(sessionId: string, type: string, payload: any) {
  try {
    if (!supabase) return;
    await supabase.from("chat_telemetry").insert({
      session_id: sessionId,
      event_type: type,
      payload
    });
  } catch {
    /* swallow */
  }
}

function okJson(res: NextApiResponse, payload: any) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(JSON.stringify(payload));
}

/* ---------- Handler ---------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = (req.body?.sessionId as string) || uuidv4();

    // Accept different field names from the UI
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
        totalSteps: SCRIPT_STEPS.length
      });
    }

    const stepIdx = nextStepIndex(history);
    let reply = "";
    let openPortal = false;
    let displayName: string | undefined;

    const faq = matchFAQ(userMessage);
    const empathy = pickEmpathy(userMessage);
    const sideNote = faq ? (empathy ? `${empathy} ${faq.a}` : faq.a) : "";

    if (stepIdx === 0) {
      const nm = extractName(userMessage);
      if (nm) {
        displayName = nm;
        reply = (sideNote ? sideNote + " " : "") + (SCRIPT_STEPS[1]?.prompt || "What’s your main concern right now?");
      } else {
        reply = (sideNote ? sideNote + " " : "") + "Got it — may I take your full name so I can personalise things?";
      }
    } else if (stepIdx === 1) {
      // Accept debt-type statements as valid answers (no FAQ hijack)
      if (mentionsDebtTypes(userMessage) || !isQuestion(userMessage)) {
        reply =
          (empathy ? empathy + " " : "") +
          (sideNote ? sideNote + " " : "") +
          (SCRIPT_STEPS[2]?.prompt || "I’ll set you up with a quick portal to gather details and documents. Ready to start?");
      } else {
        // If they asked a question, answer then progress
        reply =
          (sideNote ? sideNote + " " : "") +
          (SCRIPT_STEPS[2]?.prompt || "I’ll set you up with a quick portal to gather details and documents. Ready to start?");
      }
    } else if (stepIdx === 2) {
      // Ask to open portal; accept typos like "yesd", "yess", etc.
      const yesy = /\b(yes\w*|yeah|ok|okay|yep|sure|ready|start|go)\b/i.test(userMessage);
      if (yesy) {
        reply = (sideNote ? sideNote + " " : "") + (SCRIPT_STEPS[3]?.prompt || "Opening your secure portal now.");
        openPortal = true;
      } else {
        reply =
          (sideNote ? sideNote + " " : "") +
          "No problem — when you’re ready, I can open the secure portal to move things forward.";
      }
    } else {
      // Past the core steps — keep helpful, avoid loops. Do NOT show the “While you’re in the portal…” line here.
      reply =
        (empathy ? empathy + " " : "") +
        (sideNote ? sideNote + " " : "") +
        "If you’d like, I can open your portal so you can add details and upload documents.";
      if (/\b(portal|upload|register|sign ?in|log ?in)\b/i.test(userMessage)) openPortal = true;
    }

    // Fallback to short LLM steer if somehow empty
    if (!reply && openai) {
      try {
        const sys = "You are Mark, a UK debt advisor. Reply warmly in one sentence and avoid repetition.";
        const cmp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.5,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userMessage }
          ]
        });
        reply = cmp.choices[0]?.message?.content?.trim() || "Thanks — let’s keep going.";
      } catch {
        reply = "Thanks — let’s keep going.";
      }
    }

    await logTelemetry(sessionId, "chat", { language, stepIdx, openPortal });

    return okJson(res, {
      reply: reply || "Thanks — let’s continue.",
      sessionId,
      stepIndex: Math.min(stepIdx + 1, SCRIPT_STEPS.length - 1),
      totalSteps: SCRIPT_STEPS.length,
      openPortal,
      displayName
    });
  } catch {
    return okJson(res, {
      reply: "Sorry, something went wrong on my end. Please try again.",
      error: "handled"
    });
  }
}
