import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import scriptJson from "../../utils/full_script_logic.json";

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "")
);

// Types
type Step = {
  id: number;
  name?: string;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
  expects?: "name"|"concern"|"amounts"|"urgency"|"ack"|"portalInvite"|"free";
};
type ScriptShape = { steps: Step[]; small_talk?: { greetings?: string[] } };
const SCRIPT = (scriptJson as ScriptShape).steps;
const GREETINGS = new Set(
  ((scriptJson as ScriptShape).small_talk?.greetings || ["hi","hello","hey","good morning","good afternoon","good evening"])
    .map(s => s.toLowerCase())
);

// Constants
const STEP_TAG = (n: number) => `[[STEP:${n}]]`;
const STEP_RE = /\[\[STEP:(-?\d+)\]\]/;
const OPENING = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
const PORTAL_MIN_INDEX = 5; // explicit: portal step is 5

// DB helpers
async function loadHistory(sessionId: string) {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(300);
  return (data || []).map(m => ({ role: m.role as "user" | "assistant", content: String(m.content || "") }));
}
async function append(sessionId: string, role: "user"|"assistant", content: string) {
  await supabase.from("messages").insert({ session_id: sessionId, role, content });
}

// Utils
const norm = (s: string) => (s || "").toLowerCase().trim();

function lastAssistantStep(history: Array<{role:"user"|"assistant"; content:string}>) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      const m = history[i].content.match(STEP_RE);
      if (m) return { idx: i, step: Number(m[1]) };
    }
  }
  return { idx: -1, step: -1 };
}
function lastUserIdx(history: Array<{role:"user"|"assistant"; content:string}>) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "user") return i;
  return -1;
}

// Extractors/validators
function extractName(s: string): string | null {
  const rx = /(my name is|i am|i'm|im|it's|its|call me)\s+([a-z][a-z\s'’-]{1,60})/i;
  const m = s.match(rx);
  if (m?.[2]) {
    const raw = m[2].replace(/\s+/g," ").trim();
    return raw.split(" ").map(w => w ? w[0].toUpperCase()+w.slice(1).toLowerCase() : "").join(" ");
  }
  const m2 = s.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  return m2?.[1] || null;
}
function amountsAnswered(s: string) {
  // Find two numbers: current monthly and target affordable
  const nums = (s.match(/£?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi) || []).map(x => Number(x.replace(/[^0-9.]/g,"")));
  return nums.length >= 2;
}
function urgencyAnswered(s: string) {
  const u = norm(s);
  if (/\b(no|none|nothing|not really|all good)\b/.test(u)) return true;
  if (/(bailiff|enforcement|ccj|default|court|missed|rent|council\s*tax|gas|electric|water)/i.test(u)) return true;
  return false;
}
function ackYes(s: string) {
  return /\b(yes|ok|okay|sure|carry on|continue|proceed|yep|yeah)\b/i.test(s);
}
function affirmative(s: string) {
  return /\b(yes|ok|okay|sure|go ahead|open|start|set up|yep|yeah|please)\b/i.test(s);
}
function keywordsHit(step: Step, s: string) {
  if (!step.keywords || step.keywords.length === 0) return s.trim().length > 0;
  const u = norm(s);
  return step.keywords.some(k => u.includes(k.toLowerCase()));
}

// Empathy (optional line; never drives step)
const EMPATHY: Array<[RegExp,string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan."],
  [/miss(ed)?\s+payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council\s*tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/credit\s*card|loan|overdraft|catalogue|car\s*finance/i, "We’ll take this step by step and ease the pressure."]
];
function empathy(s: string) {
  for (const [re, line] of EMPATHY) if (re.test(s)) return line;
  return null;
}

// Handler
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // Load
    let history = await loadHistory(sessionId);

    // If empty, send opener once
    if (history.length === 0) {
      await append(sessionId, "assistant", `${STEP_TAG(-1)} ${OPENING}`);
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // Record user message
    if (userMessage) {
      await append(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    // Determine last asked step
    const { idx: lastAIdx, step: lastAsked } = lastAssistantStep(history);
    const uIdx = lastUserIdx(history);
    const latestUser = uIdx >= 0 ? history[uIdx].content : "";

    // If only opener asked
    if (lastAsked < 0) {
      // reply to greeting if they greeted
      const greet = GREETINGS.has(norm(latestUser)) ? "Hi — you’re in the right place." : "Thanks for telling me.";
      const step0 = SCRIPT[0];
      const out = `${greet} ${step0.prompt}`;
      await append(sessionId, "assistant", `${STEP_TAG(step0.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Only evaluate if the user spoke after the last assistant step
    if (uIdx > lastAIdx) {
      const askedStep = SCRIPT.find(s => s.id === lastAsked) || SCRIPT[0];
      let moveNext = false;
      let openPortal = false;
      let replyParts: string[] = [];

      // Empathy (optional)
      const em = empathy(latestUser);
      if (em) replyParts.push(em);

      // Validate depending on expected type
      switch (askedStep.expects) {
        case "name": {
          const name = extractName(latestUser);
          if (name) {
            replyParts.push(`Nice to meet you, ${name}.`);
            moveNext = true;
          } else {
            replyParts.push("Got it — just so I can address you properly, what’s your name?");
          }
          break;
        }
        case "concern": {
          moveNext = keywordsHit(askedStep, latestUser);
          if (!moveNext) replyParts.push("Thanks — to help me tailor this properly:", askedStep.prompt);
          break;
        }
        case "amounts": {
          moveNext = amountsAnswered(latestUser);
          if (!moveNext) replyParts.push("No problem — roughly how much do you pay monthly across all debts, and what would feel affordable?");
          break;
        }
        case "urgency": {
          moveNext = urgencyAnswered(latestUser);
          if (!moveNext) replyParts.push("Is anything urgent like enforcement, court/default notices, or missed priority bills?");
          break;
        }
        case "ack": {
          moveNext = ackYes(latestUser);
          if (!moveNext) replyParts.push("Totally fine — shall we carry on?");
          break;
        }
        case "portalInvite": {
          if (affirmative(latestUser)) { openPortal = true; moveNext = true; }
          else { moveNext = true; replyParts.push("No worries — we can open it later when you’re ready."); }
          break;
        }
        case "free":
        default: {
          moveNext = latestUser.trim().length > 0;
          if (!moveNext) replyParts.push(askedStep.prompt);
          break;
        }
      }

      // Work out next step index
      const askedIdx = SCRIPT.findIndex(s => s.id === askedStep.id);
      let nextIdx = Math.min(askedIdx + (moveNext ? 1 : 0), SCRIPT.length - 1);
      let nextStep = SCRIPT[nextIdx];

      // Enforce portal ordering
      if (nextStep.openPortal && nextIdx < PORTAL_MIN_INDEX) {
        nextIdx = PORTAL_MIN_INDEX;
        nextStep = SCRIPT[nextIdx] || nextStep;
      }

      // If the just-answered step was the portal invite and user said yes: open + followup
      if (askedStep.expects === "portalInvite" && openPortal) {
        const follow = SCRIPT.find(s => s.name === "portal_followup") || nextStep;
        replyParts.push(follow.prompt);
        const out = replyParts.join(" ");
        await append(sessionId, "assistant", `${STEP_TAG(follow.id)} ${out}`);
        return res.status(200).json({ reply: out, openPortal: true });
      }

      // Normal progression
      replyParts.push(nextStep.prompt);
      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(nextStep.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // If the user hasn’t replied since last step, gently repeat that step
    const current = SCRIPT.find(s => s.id === lastAsked) || SCRIPT[0];
    const out = `${current.prompt}`;
    await append(sessionId, "assistant", `${STEP_TAG(current.id)} ${out}`);
    return res.status(200).json({ reply: out, openPortal: false });

  } catch (e: any) {
    console.error("chat api error:", e?.message || e);
    return res.status(200).json({ reply: "Sorry — something went wrong on my end. Let’s try again.", openPortal: false });
  }
}
