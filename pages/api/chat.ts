import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import rawScript from "../../utils/full_script_logic.json";

/* ---------------- Types ---------------- */
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

/* ---------------- Supabase ---------------- */
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

/* ---------------- Script + constants ---------------- */
const SCRIPT_IN: ScriptShape = rawScript as any;

// Normalize / backfill expected types by id if not provided in JSON
const SCRIPT: Step[] = (SCRIPT_IN.steps || []).map((s) => {
  if (s.expects) return s;
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

// Hard rule: portal invite must not appear before id >= 5 and only after 0..4 are completed
const PORTAL_MIN_ID = 5;
const PREPORTAL_IDS = new Set([0, 1, 2, 3, 4]);

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

/* ---------------- Empathy + bridges ---------------- */
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
  "That’s helpful.",
  "Thanks for being clear.",
  "Noted.",
];

/* ---------------- DB helpers ---------------- */
async function loadHistory(sessionId: string): Promise<Msg[]> {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(500);
  return (data || []).map((m) => ({
    role: m.role as any,
    content: String(m.content || ""),
    created_at: m.created_at || undefined,
  }));
}
async function append(sessionId: string, role: "user" | "assistant", content: string) {
  await supabase.from("messages").insert({ session_id: sessionId, role, content });
}
async function telemetry(sessionId: string, event_type: string, payload: any) {
  try {
    await supabase.from("chat_telemetry").insert({ session_id: sessionId, event_type, payload });
  } catch {
    // best effort
  }
}

/* ---------------- Utils ---------------- */
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
function isContiguousFromZero(ids: number[]) {
  // Keep only non-negative steps, sort unique
  const uniq = Array.from(new Set(ids.filter((n) => n >= 0))).sort((a, b) => a - b);
  for (let i = 0; i < uniq.length; i++) if (uniq[i] !== i) return false;
  return true;
}
function earliestMissingStep(seen: number[]): number {
  const allIds = SCRIPT.map((s) => s.id).sort((a, b) => a - b);
  const set = new Set(seen);
  for (const id of allIds) if (!set.has(id)) return id;
  return allIds[allIds.length - 1] ?? 0;
}
function completedPrePortal(seen: number[]) {
  return [0, 1, 2, 3, 4].every((id) => seen.includes(id));
}
function guardEarlyPortal(seen: number[], candidate: Step) {
  if (!candidate.openPortal) return candidate;
  if (!completedPrePortal(seen)) {
    // Force back to first missing pre-portal step
    const missing = [0, 1, 2, 3, 4].find((id) => !seen.includes(id))!;
    return SCRIPT.find((s) => s.id === missing) || candidate;
  }
  return candidate;
}
function pickBridge(seed: number) {
  return BRIDGES[seed % BRIDGES.length];
}
function extractName(s: string): string | null {
  const rx = /(my name is|i am|i'm|im|it's|its|call me)\s+([a-z][a-z\s'’-]{1,60})/i;
  const m = s.match(rx);
  if (m?.[2]) return tidyName(m[2]);
  const m2 = s.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  return m2?.[1] ? tidyName(m2[1]) : null;
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
    s.match(/£?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)?.map((x) => Number(x.replace(/[^0-9.]/g, ""))) || [];
  return nums.length >= 2;
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

/* ---------------- Handler ---------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    const language = String(req.body.language || "English");
    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // Reset
    if (/^(reset|restart|start again)$/i.test(userMessage)) {
      await supabase.from("messages").delete().eq("session_id", sessionId);
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "reset", { language });
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // History
    let history = await loadHistory(sessionId);

    // First time → opener
    if (history.length === 0) {
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "start", { language });
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // Add user message
    if (userMessage) {
      await append(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    const seenStepsRaw = assistantSteps(history).filter((n) => n >= 0);
    // Contiguity guard: if history contains step ids that aren't contiguous from 0 (e.g. jumped to 5),
    // trim to the largest contiguous prefix.
    let seenSteps = Array.from(new Set(seenStepsRaw)).sort((a, b) => a - b);
    if (!isContiguousFromZero(seenSteps)) {
      const contiguous: number[] = [];
      for (let i = 0; i < seenSteps.length; i++) {
        if (seenSteps[i] === i) contiguous.push(i);
        else break;
      }
      seenSteps = contiguous;
    }

    const { idx: lastAIdx, step: lastAsked } = lastAssistantStep(history);
    const uIdx = lastUserIdx(history);
    const latestUser = uIdx >= 0 ? history[uIdx].content : "";
    const seed = history.length;

    // After the opener, we always ask step 0
    if (seenSteps.length === 0) {
      const greet = GREETINGS.has(norm(latestUser)) || isHowAreYou(latestUser)
        ? "Hi — you’re in the right place."
        : pickBridge(seed);
      const step0 = SCRIPT.find((s) => s.id === 0) || SCRIPT[0];
      const out = `${greet} ${step0.prompt}`;
      await append(sessionId, "assistant", `${STEP_TAG(step0.id)} ${out}`);
      await telemetry(sessionId, "step_shown", { step: step0.id, reason: "post_opener" });
      return res.status(200).json({ reply: out, openPortal: false });
    }

    const expected = earliestMissingStep(seenSteps);

    // If the last asked step is not the expected one, realign
    if (lastAsked !== expected) {
      // Additionally, if the "expected" is portal but pre-portal not complete, force the earliest missing pre-portal
      const realTarget = guardEarlyPortal(seenSteps, SCRIPT.find((s) => s.id === expected) || SCRIPT[0]);
      const outPrompt = realTarget.prompt;
      await append(sessionId, "assistant", `${STEP_TAG(realTarget.id)} ${outPrompt}`);
      await telemetry(sessionId, "step_shown", { step: realTarget.id, reason: "realign" });
      return res.status(200).json({ reply: outPrompt, openPortal: false });
    }

    // If user hasn't replied since last assistant → repeat same step
    if (uIdx <= lastAIdx) {
      const ask = SCRIPT.find((s) => s.id === lastAsked) || SCRIPT[0];
      await append(sessionId, "assistant", `${STEP_TAG(ask.id)} ${ask.prompt}`);
      await telemetry(sessionId, "step_repeat", { step: ask.id, reason: "no_user_after_assistant" });
      return res.status(200).json({ reply: ask.prompt, openPortal: false });
    }

    // Validate current step
    const step = SCRIPT.find((s) => s.id === lastAsked) || SCRIPT[0];
    const replyParts: string[] = [];

    // Answer "how are you?"
    if (isHowAreYou(latestUser)) replyParts.push("I’m good thanks — more importantly, I’m here to help you today.");

    // Inject empathy line if relevant
    const emKey = empathyKey(latestUser);
    const emLine = empathyLine(latestUser);
    if (emLine) replyParts.push(emLine);

    let moveNext = false;
    let openPortal = false;

    switch (step.expects) {
      case "name": {
        const name =
          extractName(latestUser) ||
          (norm(latestUser).split(" ").length <= 3 ? tidyName(latestUser) : null);
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
        // Absolute guard: don't allow portal until 0..4 seen
        if (!completedPrePortal(seenSteps)) {
          const missing = [0, 1, 2, 3, 4].find((id) => !seenSteps.includes(id))!;
          const back = SCRIPT.find((s) => s.id === missing)!;
          replyParts.push(back.prompt);
          await append(sessionId, "assistant", `${STEP_TAG(back.id)} ${replyParts.join(" ")}`);
          await telemetry(sessionId, "step_shown", { step: back.id, reason: "preportal_not_complete" });
          return res.status(200).json({ reply: replyParts.join(" "), openPortal: false });
        }
        if (affirmative(latestUser)) {
          openPortal = true;
          moveNext = true;
          await telemetry(sessionId, "portal_opened", { at_step: step.id });
        } else {
          replyParts.push("No worries — we can open it later when you’re ready.");
          moveNext = true; // still progress to follow-up text
        }
        break;
      }

      default: {
        moveNext = latestUser.trim().length > 0;
        if (!moveNext) replyParts.push(step.prompt);
        break;
      }
    }

    // If we didn't satisfy the step → stay on it
    if (!moveNext) {
      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(step.id)} ${out}`);
      await telemetry(sessionId, "step_repeat", { step: step.id, reason: "validation_failed" });
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Move to next step (strict)
    let nextIndex = SCRIPT.findIndex((s) => s.id === step.id) + 1;
    if (nextIndex >= SCRIPT.length) nextIndex = SCRIPT.length - 1;
    let nextStep = SCRIPT[nextIndex];

    // Guard: if next would be portal and pre-portal not done, redirect to earliest missing pre-portal
    if (nextStep.openPortal && !completedPrePortal(seenSteps)) {
      const missing = [0, 1, 2, 3, 4].find((id) => !seenSteps.includes(id))!;
      nextStep = SCRIPT.find((s) => s.id === missing) || nextStep;
    }

    // If we just accepted the portal invite
    if (step.expects === "portalInvite" && openPortal) {
      const follow =
        SCRIPT.find((s) => s.name === "portal_followup") ||
        nextStep ||
        step;

      replyParts.push(
        follow?.prompt ||
          "While you’re in the portal, I’ll stay here to guide you. You can come back to the chat any time using the button in the top-right corner. Please follow the Outstanding Tasks so we can understand your situation."
      );

      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(follow.id ?? step.id)} ${out}`);
      return res.status(200).json({ reply: out, openPortal: true });
    }

    // Normal progression
    replyParts.push(nextStep.prompt);
    const out = replyParts.join(" ");
    await append(sessionId, "assistant", `${STEP_TAG(nextStep.id)} ${out}`);
    await telemetry(sessionId, "step_shown", { step: nextStep.id, from: step.id });
    return res.status(200).json({ reply: out, openPortal: false });
  } catch (e: any) {
    console.error("chat api error:", e?.message || e);
    return res
      .status(200)
      .json({ reply: "Sorry — something went wrong on my end. Let’s continue from here.", openPortal: false });
  }
}
