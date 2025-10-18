import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import scriptJson from "../../utils/full_script_logic.json";

type Step = {
  id: number;
  name?: string;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
  expects?:
    | "name"
    | "concern"
    | "amounts"
    | "urgency"
    | "ack"
    | "portalInvite"
    | "free";
};
type ScriptShape = { steps: Step[]; small_talk?: { greetings?: string[] } };

// ---- Supabase (use service-role if present) ----
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

// ---- Script / Constants ----
const SCRIPT = (scriptJson as ScriptShape).steps;
const GREETINGS = new Set(
  (
    (scriptJson as ScriptShape).small_talk?.greetings || [
      "hi",
      "hello",
      "hey",
      "good morning",
      "good afternoon",
      "good evening",
    ]
  ).map((s) => s.toLowerCase())
);

const BOT_NAME = "Mark";
const OPENING =
  "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
const STEP_TAG = (n: number) => `[[STEP:${n}]]`;
const STEP_RE = /\[\[STEP:(-?\d+)\]\]/;
const PORTAL_MIN_INDEX = 5; // never open portal before this index

// ---- DB helpers ----
async function loadHistory(sessionId: string) {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(500);
  return (data || []).map((m) => ({
    role: m.role as "user" | "assistant",
    content: String(m.content || ""),
  }));
}
async function append(
  sessionId: string,
  role: "user" | "assistant",
  content: string
) {
  await supabase.from("messages").insert({ session_id: sessionId, role, content });
}

// ---- Utils ----
const norm = (s: string) => (s || "").toLowerCase().trim();

function assistantSteps(history: Array<{ role: "user" | "assistant"; content: string }>): number[] {
  const ids: number[] = [];
  for (const h of history) {
    if (h.role !== "assistant") continue;
    const m = h.content.match(STEP_RE);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}
function lastAssistantStep(history: Array<{ role: "user" | "assistant"; content: string }>) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      const m = history[i].content.match(STEP_RE);
      if (m) return { idx: i, step: Number(m[1]) };
    }
  }
  return { idx: -1, step: -1 };
}
function lastUserIdx(history: Array<{ role: "user" | "assistant"; content: string }>) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "user") return i;
  return -1;
}
function earliestMissingStep(seen: number[]): number {
  const maxId = Math.max(...SCRIPT.map((s) => s.id));
  const set = new Set(seen);
  for (let i = 0; i <= maxId; i++) if (!set.has(i)) return i;
  return Math.min(maxId, Math.max(...seen, -1) + 1);
}

// Friendly bridge phrases (avoids “Thanks — that helps” spam)
const BRIDGES = [
  "Got it.",
  "Understood.",
  "Appreciate you sharing that.",
  "That’s useful.",
  "Thanks for being clear.",
  "Noted.",
];

function pickBridge(seed: number) {
  return BRIDGES[seed % BRIDGES.length];
}

function extractName(s: string): string | null {
  // common patterns
  const rx = /(my name is|i am|i'm|im|it's|its|call me)\s+([a-z][a-z\s'’-]{1,60})/i;
  const m = s.match(rx);
  if (m?.[2]) return tidyName(m[2]);

  // “my name is also …” / “I’m also Mark”
  const rxAlso = /(also\s+)?(my name is|i am|i'm|im)\s+([a-z][a-z\s'’-]{1,60})/i;
  const m2 = s.match(rxAlso);
  if (m2?.[3]) return tidyName(m2[3]);

  // single/double capitalised
  const m3 = s.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  return m3?.[1] ? tidyName(m3[1]) : null;
}
function tidyName(raw: string) {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}

function amountsAnswered(s: string) {
  const nums =
    s.match(/£?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)?.map((x) =>
      Number(x.replace(/[^0-9.]/g, ""))
    ) || [];
  return nums.length >= 2; // current + affordable
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
  return step.keywords.some((k) => u.includes(k.toLowerCase()));
}

const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan."],
  [/miss(ed)?\s+payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council\s*tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/credit\s*card|loan|overdraft|catalogue|car\s*finance/i, "We’ll take this step by step and ease the pressure."],
];
function empathy(s: string) {
  for (const [re, line] of EMPATHY) if (re.test(s)) return line;
  return null;
}
function isHowAreYou(s: string) {
  return /\b(how (are|r) (you|u)|you ok\??|how’s things|hows things)\b/i.test(s);
}

// ---- Handler ----
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // Hard reset command
    if (/^(reset|restart|start again)$/i.test(userMessage)) {
      await supabase.from("messages").delete().eq("session_id", sessionId);
      await append(sessionId, "assistant", `${STEP_TAG(-1)} ${OPENING}`);
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // Load history
    let history = await loadHistory(sessionId);

    // First-time session → send opener
    if (history.length === 0) {
      await append(sessionId, "assistant", `${STEP_TAG(-1)} ${OPENING}`);
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // Record latest user message
    if (userMessage) {
      await append(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    const seenSteps = assistantSteps(history).filter((n) => n >= 0);
    const { idx: lastAIdx, step: lastAsked } = lastAssistantStep(history);
    const uIdx = lastUserIdx(history);
    const latestUser = uIdx >= 0 ? history[uIdx].content : "";
    const seed = history.length;

    // If only the opener was sent, move to step 0 with a friendly bridge (not repetitive)
    if (seenSteps.length === 0) {
      const greet = GREETINGS.has(norm(latestUser))
        ? "Hi — you’re in the right place."
        : pickBridge(seed);
      const step0 = SCRIPT[0];
      const out = `${greet} ${step0.prompt}`;
      await append(sessionId, "assistant", `${STEP_TAG(step0.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Anchoring: determine which step we should be on
    const expected = earliestMissingStep(seenSteps);

    // If last asked is not the expected step, ask expected (prevents jumps/loops)
    if (lastAsked !== expected) {
      const ask = SCRIPT.find((s) => s.id === expected) || SCRIPT[0];
      await append(sessionId, "assistant", `${STEP_TAG(ask.id)} ${ask.prompt}`);
      return res.status(200).json({ reply: ask.prompt, openPortal: false });
    }

    // If user hasn’t spoken since last assistant message, repeat that step
    if (uIdx <= lastAIdx) {
      const ask = SCRIPT.find((s) => s.id === lastAsked) || SCRIPT[0];
      await append(sessionId, "assistant", `${STEP_TAG(ask.id)} ${ask.prompt}`);
      return res.status(200).json({ reply: ask.prompt, openPortal: false });
    }

    // Validate the answer to the current step
    const askedStep = SCRIPT.find((s) => s.id === lastAsked) || SCRIPT[0];

    // Small talk: “how are you?”
    if (isHowAreYou(latestUser)) {
      const friendly = "I’m good thanks — more importantly, I’m here to help you today.";
      const out = `${friendly} ${askedStep.prompt}`;
      await append(sessionId, "assistant", `${STEP_TAG(askedStep.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    let moveNext = false;
    let openPortal = false;
    const replyParts: string[] = [];
    const em = empathy(latestUser);
    if (em) replyParts.push(em);

    switch (askedStep.expects) {
      case "name": {
        const name = extractName(latestUser) || (norm(latestUser).split(" ").length <= 3 ? tidyName(latestUser) : null);
        if (name) {
          // If they share the bot’s name (Mark), add a friendly aside
          if (name.toLowerCase().startsWith(BOT_NAME.toLowerCase())) {
            replyParts.push(`Nice — two ${BOT_NAME}s are better than one 😄`);
          }
          replyParts.push(`Nice to meet you, ${name}. How are you today?`);
          moveNext = true;
        } else {
          replyParts.push("Got it — just so I can address you properly, what’s your name?");
        }
        break;
      }

      case "concern": {
        // gentle, varied bridge; avoid “Thanks — that helps”
        replyParts.push(pickBridge(seed));
        moveNext = keywordsHit(askedStep, latestUser);
        if (!moveNext) {
          replyParts.push("What’s the main concern with the debts?");
        }
        break;
      }

      case "amounts": {
        moveNext = amountsAnswered(latestUser);
        if (!moveNext) {
          replyParts.push("Roughly how much do you pay monthly across all debts, and what would feel affordable?");
        }
        break;
      }

      case "urgency": {
        moveNext = urgencyAnswered(latestUser);
        if (!moveNext) {
          replyParts.push("Is anything urgent like enforcement, court/default notices, or missed priority bills?");
        }
        break;
      }

      case "ack": {
        moveNext = ackYes(latestUser);
        if (!moveNext) replyParts.push("Totally fine — shall we carry on?");
        break;
      }

      case "portalInvite": {
        // Only “yes” to THIS invite opens it
        if (affirmative(latestUser)) {
          openPortal = true;
          moveNext = true;
        } else if (GREETINGS.has(norm(latestUser)) || /\bhello\b|\?/.test(norm(latestUser))) {
          replyParts.push("When you’re ready, just say “yes” and I’ll open it.");
          moveNext = false;
        } else {
          moveNext = true;
          replyParts.push("No worries — we can open it later when you’re ready.");
        }
        break;
      }

      case "free":
      default: {
        moveNext = latestUser.trim().length > 0;
        if (!moveNext) replyParts.push(askedStep.prompt);
        break;
      }
    }

    const askedIdx = SCRIPT.findIndex((s) => s.id === askedStep.id);

    if (!moveNext) {
      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(askedStep.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Advance to next step (with portal ordering guard)
    let nextIdx = Math.min(askedIdx + 1, SCRIPT.length - 1);
    let nextStep = SCRIPT[nextIdx];

    if (nextStep.openPortal && nextIdx < PORTAL_MIN_INDEX) {
      nextIdx = PORTAL_MIN_INDEX;
      nextStep = SCRIPT[nextIdx] || nextStep;
    }

    // If we just accepted the portal invite
    if (askedStep.expects === "portalInvite" && openPortal) {
      const follow = SCRIPT.find((s) => s.name === "portal_followup") || nextStep;
      replyParts.push(
        follow.prompt ||
          "While you’re in the portal, I’ll stay here to guide you. You can come back to the chat any time using the button in the top-right corner."
      );
      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(follow.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: true });
    }

    // Normal progression
    replyParts.push(nextStep.prompt);
    const out = replyParts.join(" ");
    await append(sessionId, "assistant", `${STEP_TAG(nextStep.id)} ${out}`);
    return res.status(200).json({ reply: out, openPortal: false });
  } catch (e: any) {
    console.error("chat api error:", e?.message || e);
    return res.status(200).json({
      reply: "Sorry — something went wrong on my end. Let’s try again from here.",
      openPortal: false,
    });
  }
}
