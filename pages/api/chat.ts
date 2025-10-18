import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import rawScript from "../../utils/full_script_logic.json";

// ---------- Types ----------
type Step = {
  id: number;
  name?: string;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
  expects?: "name" | "concern" | "amounts" | "urgency" | "ack" | "portalInvite" | "free";
};
type ScriptShape = { steps: Step[]; small_talk?: { greetings?: string[] } };
type Msg = { role: "user" | "assistant"; content: string; created_at?: string };

// ---------- Supabase (service role if available) ----------
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

// ---------- Script + expectations ----------
const SCRIPT_IN: ScriptShape = rawScript as any;

// If expects are missing in JSON, add sensible defaults by id
// 0: name, 1: concern, 2: amounts, 3: urgency, 4: ack, 5: portalInvite, 6+: free
const SCRIPT: Step[] = (SCRIPT_IN.steps || []).map((s) => {
  if (typeof s.expects === "string") return s;
  const map: Record<number, Step["expects"]> = {
    0: "name",
    1: "concern",
    2: "amounts",
    3: "urgency",
    4: "ack",
    5: "portalInvite",
  };
  return { ...s, expects: map[s.id] || "free" };
});

// Hard guard: never allow the portal step before index 5
const PORTAL_MIN_INDEX = 5;

// small talk greetings
const GREETINGS = new Set(
  (SCRIPT_IN.small_talk?.greetings || [
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
  ]).map((s) => s.toLowerCase())
);

const BOT_NAME = "Mark";
const OPENING = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
const STEP_TAG = (n: number) => `[[STEP:${n}]]`;
const STEP_RE = /\[\[STEP:(-?\d+)\]\]/;

// ---------- Empathy + bridges (varied, for learning) ----------
const EMPATHY: Array<[RegExp, string, string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly.", "bailiff"],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan.", "court"],
  [/miss(ed)?\s+payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now.", "missed"],
  [/rent|council\s*tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised.", "priority"],
  [/credit\s*card|loan|overdraft|catalogue|car\s*finance/i, "We’ll take this step by step and ease the pressure.", "consumer"],
];
const BRIDGES = [
  "Got it.",
  "Understood.",
  "Appreciate you sharing that.",
  "That’s useful.",
  "Thanks for being clear.",
  "Noted.",
];

// ---------- DB helpers ----------
async function loadHistory(sessionId: string): Promise<Msg[]> {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(500);
  return (data || []).map((m) => ({ role: m.role as any, content: String(m.content || ""), created_at: m.created_at || undefined }));
}
async function append(sessionId: string, role: "user" | "assistant", content: string) {
  await supabase.from("messages").insert({ session_id: sessionId, role, content });
}
async function telemetry(sessionId: string, event_type: string, payload: any) {
  try {
    await supabase.from("chat_telemetry").insert({
      session_id: sessionId,
      event_type,
      payload,
    });
  } catch {
    // best-effort only
  }
}

// ---------- Utility ----------
const norm = (s: string) => (s || "").toLowerCase().trim();

function assistantSteps(history: Msg[]): number[] {
  const ids: number[] = [];
  for (const h of history) {
    if (h.role !== "assistant") continue;
    const m = h.content.match(STEP_RE);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}
function lastAssistantStep(history: Msg[]) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== "assistant") continue;
    const m = h.content.match(STEP_RE);
    if (m) return { idx: i, step: Number(m[1]) };
  }
  return { idx: -1, step: -1 };
}
function lastUserIdx(history: Msg[]) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "user") return i;
  return -1;
}
function earliestMissingStep(seen: number[]): number {
  const allIds = SCRIPT.map((s) => s.id).sort((a, b) => a - b);
  const set = new Set(seen);
  for (const id of allIds) if (!set.has(id)) return id;
  // all asked — keep at last id (end)
  return allIds[allIds.length - 1] ?? 0;
}
function pickBridge(seed: number) {
  return BRIDGES[seed % BRIDGES.length];
}

function extractName(s: string): string | null {
  // patterns with verbs
  const rx = /(my name is|i am|i'm|im|it's|its|call me)\s+([a-z][a-z\s'’-]{1,60})/i;
  const m = s.match(rx);
  if (m?.[2]) return tidyName(m[2]);

  // single/double capitalised word(s)
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
  if (/\b(no|none|nothing|not really|all good|fine)\b/.test(u)) return true;
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
function isHowAreYou(s: string) {
  return /\b(how (are|r) (you|u)|you ok\??|how’s things|hows things)\b/i.test(s);
}
function empathyLine(s: string) {
  for (const [re, line] of EMPATHY) if (re.test(s)) return line;
  return null;
}
function empathyKey(s: string) {
  for (const [re, _line, key] of EMPATHY) if (re.test(s)) return key;
  return "none";
}

// ---------- Main handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    const language = String(req.body.language || "English");
    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // Hard reset
    if (/^(reset|restart|start again)$/i.test(userMessage)) {
      await supabase.from("messages").delete().eq("session_id", sessionId);
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "reset", { language });
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // Load convo
    let history = await loadHistory(sessionId);

    // First time → send opener
    if (history.length === 0) {
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "start", { language });
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // Record user message
    if (userMessage) {
      await append(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    const seenSteps = assistantSteps(history).filter((n) => n >= 0);
    const { idx: lastAIdx, step: lastAsked } = lastAssistantStep(history);
    const uIdx = lastUserIdx(history);
    const latestUser = uIdx >= 0 ? history[uIdx].content : "";
    const seed = history.length;

    // If only the opener has been sent so far → move to step 0 with friendly bridge
    if (seenSteps.length === 0) {
      const greet =
        GREETINGS.has(norm(latestUser)) || isHowAreYou(latestUser)
          ? "Hi — you’re in the right place."
          : pickBridge(seed);
      const step0 = SCRIPT.find((s) => s.id === 0) || SCRIPT[0];
      const out = `${greet} ${step0.prompt}`;
      await append(sessionId, "assistant", `${STEP_TAG(step0.id)} ${out}`);
      await telemetry(sessionId, "step_shown", { step: step0.id });
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Enforce strict step order
    const expected = earliestMissingStep(seenSteps);

    // If we somehow asked the wrong one previously, realign to expected
    if (lastAsked !== expected) {
      const ask = SCRIPT.find((s) => s.id === expected) || SCRIPT[0];
      await append(sessionId, "assistant", `${STEP_TAG(ask.id)} ${ask.prompt}`);
      await telemetry(sessionId, "step_shown", { step: ask.id, reason: "realign" });
      return res.status(200).json({ reply: ask.prompt, openPortal: false });
    }

    // If user hasn’t spoken since last assistant message → repeat same step
    if (uIdx <= lastAIdx) {
      const ask = SCRIPT.find((s) => s.id === lastAsked) || SCRIPT[0];
      await append(sessionId, "assistant", `${STEP_TAG(ask.id)} ${ask.prompt}`);
      await telemetry(sessionId, "step_repeat", { step: ask.id, reason: "no_user_after_assistant" });
      return res.status(200).json({ reply: ask.prompt, openPortal: false });
    }

    // Validate the answer for the current step
    const step = SCRIPT.find((s) => s.id === lastAsked) || SCRIPT[0];
    const replyParts: string[] = [];

    // Humanness: answer "how are you?" briefly then continue the step
    if (isHowAreYou(latestUser)) {
      replyParts.push("I’m good thanks — more importantly, I’m here to help you today.");
    }

    // Add an empathy line if relevant
    const emKey = empathyKey(latestUser);
    const emLine = empathyLine(latestUser);
    if (emLine) {
      replyParts.push(emLine);
    }

    let moveNext = false;
    let openPortal = false;

    switch (step.expects) {
      case "name": {
        const name = extractName(latestUser) || (norm(latestUser).split(" ").length <= 3 ? tidyName(latestUser) : null);
        if (name) {
          if (name.toLowerCase().startsWith(BOT_NAME.toLowerCase())) {
            replyParts.push(`Two ${BOT_NAME}s — love it 😄`);
          }
          replyParts.push(`Nice to meet you, ${name}. How are you today?`);
          moveNext = true;
          await telemetry(sessionId, "step_completed", { step: step.id, signal: "name_captured", name });
        } else {
          replyParts.push("Just so I can address you properly, what’s your name?");
        }
        break;
      }

      case "concern": {
        // Don’t be repetitive — rotate bridges
        replyParts.push(pickBridge(seed));
        moveNext = keywordsHit(step, latestUser);
        await telemetry(sessionId, "user_answered", { step: step.id, ok: moveNext, empathy: emKey });
        if (!moveNext) replyParts.push("What’s the main concern with the debts?");
        break;
      }

      case "amounts": {
        moveNext = amountsAnswered(latestUser);
        await telemetry(sessionId, "user_answered", { step: step.id, ok: moveNext });
        if (!moveNext)
          replyParts.push("Roughly how much do you pay each month across all debts, and what would feel affordable?");
        break;
      }

      case "urgency": {
        moveNext = urgencyAnswered(latestUser);
        await telemetry(sessionId, "user_answered", { step: step.id, ok: moveNext, empathy: emKey });
        if (!moveNext)
          replyParts.push("Is anything urgent like enforcement, court/default letters, or missed priority bills?");
        break;
      }

      case "ack": {
        moveNext = ackYes(latestUser);
        await telemetry(sessionId, "user_answered", { step: step.id, ok: moveNext });
        if (!moveNext) replyParts.push("Totally fine — shall we carry on?");
        break;
      }

      case "portalInvite": {
        // Never open before hard minimum index
        if (affirmative(latestUser)) {
          openPortal = true;
          moveNext = true;
          await telemetry(sessionId, "portal_opened", { at_step: step.id });
        } else if (GREETINGS.has(norm(latestUser)) || /\bhello\b/.test(norm(latestUser))) {
          replyParts.push("When you’re ready, just say “yes” and I’ll open it.");
        } else {
          // Respect a no/hesitation but allow progression to follow-up text (no auto-open)
          replyParts.push("No worries — we can open it later when you’re ready.");
          moveNext = true;
        }
        break;
      }

      default: {
        moveNext = latestUser.trim().length > 0;
        if (!moveNext) replyParts.push(step.prompt);
        break;
      }
    }

    // If we didn’t satisfy the step yet → stay
    if (!moveNext) {
      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(step.id)} ${out}`);
      await telemetry(sessionId, "step_repeat", { step: step.id, reason: "validation_failed" });
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Move to next step (strict order)
    let nextIndex = SCRIPT.findIndex((s) => s.id === step.id) + 1;
    if (nextIndex >= SCRIPT.length) nextIndex = SCRIPT.length - 1;
    let nextStep = SCRIPT[nextIndex];

    // Guard: if the next step opens portal but comes too early, jump to PORTAL_MIN_INDEX
    if (nextStep.openPortal && nextIndex < PORTAL_MIN_INDEX) {
      nextIndex = PORTAL_MIN_INDEX;
      nextStep = SCRIPT[nextIndex] || nextStep;
    }

    // If we just accepted the portal invite
    if (step.expects === "portalInvite" && openPortal) {
      const follow =
        SCRIPT.find((s) => s.name === "portal_followup") ||
        SCRIPT[nextIndex] ||
        nextStep;

      // Friendly follow-up with guidance back to chat + tasks line
      replyParts.push(
        follow?.prompt ||
          "While you’re in the portal, I’ll stay here to guide you. You can come back to the chat any time using the button in the top-right corner. Please follow the Outstanding Tasks so we can understand your situation."
      );

      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(follow.id ?? step.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: true });
    }

    // Normal progression: say something human + ask next prompt
    replyParts.push(nextStep.prompt);
    const out = replyParts.join(" ");

    // If the next step *would* open the portal too early, ensure we don’t pass the flag
    const willOpen = !!nextStep.openPortal && nextIndex >= PORTAL_MIN_INDEX ? false : false;

    await append(sessionId, "assistant", `${STEP_TAG(nextStep.id)} ${out}`);
    await telemetry(sessionId, "step_shown", { step: nextStep.id, from: step.id });

    return res.status(200).json({ reply: out, openPortal: willOpen });
  } catch (e: any) {
    console.error("chat api error:", e?.message || e);
    return res
      .status(200)
      .json({ reply: "Sorry — something went wrong on my end. Let’s continue from here.", openPortal: false });
  }
}
