import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import fullScript from "../../utils/full_script_logic.json";
import faqs from "../../utils/faqs.json";

/* -------------------- Supabase -------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "")
);

/* -------------------- Script Types -------------------- */
type Step = { id: number; name?: string; prompt: string; keywords?: string[]; openPortal?: boolean };
type ScriptShape = { steps: Step[]; small_talk?: { greetings?: string[] } };
const SCRIPT = (fullScript as ScriptShape).steps;

const GREETINGS = new Set(
  ((fullScript as ScriptShape).small_talk?.greetings || ["hi","hello","hey","good morning","good afternoon","good evening"])
    .map(s => s.toLowerCase())
);

const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan."],
  [/miss(ed)?\s+payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council\s*tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/credit\s*card|loan|overdraft|catalogue|car\s*finance/i, "We’ll take this step by step and ease the pressure."],
];

const STEP_TAG = (n: number) => `[[STEP:${n}]]`;
const STEP_RE = /\[\[STEP:(-?\d+)\]\]/;
const OPENING = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
const MIN_PORTAL_INVITE_INDEX = 4;

/* -------------------- DB helpers -------------------- */
async function loadMessages(sessionId: string) {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(300);

  return (data || []).map(m => ({ role: m.role as "user" | "assistant", content: String(m.content || "") }));
}

async function appendMessage(sessionId: string, role: "user" | "assistant", content: string) {
  await supabase.from("messages").insert({ session_id: sessionId, role, content });
}

/* -------------------- Utilities -------------------- */
const norm = (s: string) => (s || "").toLowerCase().trim();

function lastAssistantStep(history: Array<{ role: "user"|"assistant"; content: string }>) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant") {
      const mt = m.content.match(STEP_RE);
      if (mt) return { idx: i, step: Number(mt[1]) };
    }
  }
  return { idx: -1, step: -1 };
}

function lastUserIndex(history: Array<{ role: "user"|"assistant"; content: string }>) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "user") return i;
  return -1;
}

function empathyLine(user: string): string | null {
  for (const [re, line] of EMPATHY) if (re.test(user)) return line;
  return null;
}

function faqHit(user: string) {
  const u = norm(user);
  let best: { a: string; score: number } | null = null;
  for (const f of faqs as Array<{ q: string; a: string; keywords?: string[] }>) {
    const kws = (f.keywords || []).map(k => k.toLowerCase());
    let score = 0;
    for (const k of kws) if (u.includes(k)) score += 1;
    if (u.endsWith("?")) score += 0.5;
    if (score > 1 && (!best || score > best.score)) best = { a: f.a, score };
  }
  return best?.a || null;
}

function isGreeting(s: string) {
  const u = norm(s);
  if (GREETINGS.has(u)) return true;
  return /^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(u);
}

function isAffirmative(s: string) {
  return /(yes|ok|okay|sure|go ahead|open|start|set up|yep|yeah|please|do it)\b/i.test(s);
}

/* ---- step validators ---- */
function stepAnswered(step: Step, user: string): boolean {
  // If step provides keywords, require at least one match.
  if (step.keywords && step.keywords.length > 0) {
    const u = norm(user);
    return step.keywords.some(k => u.includes(k.toLowerCase()));
  }
  // If no keywords, DO NOT auto-advance — we’ll treat it as custom per-step (e.g. step 0 name).
  return false;
}

function extractName(s: string): string | null {
  const txt = s.trim();
  const rx = /(my name is|i am|i'm|im|it's|its|call me)\s+([a-z][a-z\s'’-]{1,60})/i;
  const m = txt.match(rx);
  if (m && m[2]) {
    const raw = m[2].replace(/\s+/g, " ").trim();
    return raw.split(" ").map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : "").join(" ");
  }
  // fallback: a single or double word starting with caps
  const m2 = txt.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  if (m2) return m2[1];
  return null;
}

/* -------------------- Handler -------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // Load history
    let history = await loadMessages(sessionId);

    // Bootstrap: if empty, post the opening once
    if (history.length === 0) {
      await appendMessage(sessionId, "assistant", `${STEP_TAG(-1)} ${OPENING}`);
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // Store new user message if provided
    if (userMessage) {
      await appendMessage(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    // Find last assistant step we actually asked
    const { idx: lastAssistIdx, step: lastAsked } = lastAssistantStep(history);
    const lastUserIdx = lastUserIndex(history);
    const latestUser = lastUserIdx >= 0 ? history[lastUserIdx].content : "";

    // If we only ever sent the opening (step -1), next we must ASK step 0 (don’t evaluate yet)
    if (lastAsked < 0) {
      const greet = isGreeting(latestUser) ? "Hi — you’re in the right place." : "Thanks for telling me.";
      const step0 = SCRIPT[0];
      const out = `${greet} ${step0.prompt}`;
      await appendMessage(sessionId, "assistant", `${STEP_TAG(step0.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // We have asked some step N (>=0). Only evaluate if the user spoke AFTER that assistant turn.
    if (lastUserIdx > lastAssistIdx) {
      const askedStep = SCRIPT.find(s => s.id === lastAsked) || SCRIPT[Math.max(0, Math.min(lastAsked, SCRIPT.length - 1))];
      let replyParts: string[] = [];
      let openPortal = false;

      // Empathy hint (non-blocking)
      const emp = empathyLine(latestUser);
      if (emp) replyParts.push(emp);

      // Contextual FAQs (non-blocking)
      if (/\?$/.test(latestUser) || /(what|how|can|will|do|is|are)\b/i.test(latestUser)) {
        const ans = faqHit(latestUser);
        if (ans) replyParts.push(ans);
      }

      // Step-specific validation
      let moveNext = false;

      if (askedStep.id === 0) {
        // NAME step
        const name = extractName(latestUser);
        if (name) {
          replyParts.push(`Nice to meet you, ${name}.`);
          moveNext = true;
        } else {
          // re-ask gently, do not advance
          replyParts.push("Got it — just so I can address you properly, what’s your name?");
          const out = `${replyParts.join(" ")}`;
          await appendMessage(sessionId, "assistant", `${STEP_TAG(askedStep.id)} ${out}`);
          return res.status(200).json({ reply: out, openPortal: false });
        }
      } else if (askedStep.openPortal) {
        // Portal invite — only open on explicit yes
        if (isAffirmative(latestUser)) {
          openPortal = true;
          moveNext = true;
        } else {
          replyParts.push("No worries — we can do that later when you’re ready.");
          moveNext = true; // continue the script
        }
      } else {
        // Generic step: if keywords exist, require a match; otherwise accept any non-empty
        if ((askedStep.keywords && askedStep.keywords.length > 0)) {
          if (stepAnswered(askedStep, latestUser)) moveNext = true;
          else {
            replyParts.push("Thanks — to help me tailor this properly:");
            replyParts.push(askedStep.prompt);
            const out = replyParts.join(" ");
            await appendMessage(sessionId, "assistant", `${STEP_TAG(askedStep.id)} ${out}`);
            return res.status(200).json({ reply: out, openPortal: false });
          }
        } else {
          // accept any reply for steps without keywords
          moveNext = latestUser.length > 0;
        }
      }

      // Advance
      let nextIndex = SCRIPT.findIndex(s => s.id === askedStep.id) + 1;
      if (nextIndex >= SCRIPT.length) nextIndex = SCRIPT.length - 1;
      let nextStep = SCRIPT[nextIndex];

      // Enforce portal minimum index
      if (nextStep.openPortal && nextIndex < MIN_PORTAL_INVITE_INDEX) {
        nextIndex = MIN_PORTAL_INVITE_INDEX;
        nextStep = SCRIPT[nextIndex] || nextStep;
      }

      // If the current step WAS the portal invite and user said yes, keep portal closed in UI until the client confirms
      if (askedStep.openPortal && isAffirmative(latestUser)) {
        // Say the follow-up and signal UI to open
        const pf = SCRIPT.find(s => s.name === "portal_followup") || nextStep;
        replyParts.push(pf.prompt);
        const out = replyParts.join(" ");
        await appendMessage(sessionId, "assistant", `${STEP_TAG(pf.id)} ${out}`);
        return res.status(200).json({ reply: out, openPortal: true });
      }

      // Normal progression
      if (moveNext) {
        replyParts.push(nextStep.prompt);
        const out = replyParts.join(" ");
        await appendMessage(sessionId, "assistant", `${STEP_TAG(nextStep.id)} ${out}`);
        return res.status(200).json({ reply: out, openPortal: false });
      }

      // If we got here, we didn’t moveNext (shouldn’t happen), re-ask
      replyParts.push(askedStep.prompt);
      const out = replyParts.join(" ");
      await appendMessage(sessionId, "assistant", `${STEP_TAG(askedStep.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // No new user turn since we last asked — just re-emit the same step prompt gently
    const current = SCRIPT.find(s => s.id === lastAsked) || SCRIPT[0];
    const out = `${current.prompt}`;
    await appendMessage(sessionId, "assistant", `${STEP_TAG(current.id)} ${out}`);
    return res.status(200).json({ reply: out, openPortal: false });

  } catch (e: any) {
    console.error("chat api error:", e?.message || e);
    return res.status(200).json({ reply: "Sorry — something went wrong on my end. Let’s try again.", openPortal: false });
  }
}
