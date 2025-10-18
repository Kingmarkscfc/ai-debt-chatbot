import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import rawScript from "../../utils/full_script_logic.json";

/** Types **/
type Step = {
  id: number;
  name?: string;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
  expects?: "name" | "concern" | "amounts" | "urgency" | "ack" | "portalInvite" | "docs" | "free";
};
type ScriptShape = { steps: Step[]; small_talk?: { greetings?: string[] } };
type Msg = { role: "user" | "assistant"; content: string; created_at?: string };

/** Supabase **/
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

/** Script & constants **/
const SCRIPT_IN: ScriptShape = rawScript as any;
const SCRIPT: Step[] = (SCRIPT_IN.steps || []).map((s) => s);
const GREETINGS = new Set(
  (SCRIPT_IN.small_talk?.greetings || ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"]).map(
    (s) => s.toLowerCase()
  )
);
const BOT_NAME = "Mark";
const OPENING = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
const STEP_TAG = (n: number) => `[[STEP:${n}]]`;
const STEP_RE = /\[\[STEP:(-?\d+)\]\]/;

/** Empathy lines (non-jumping, purely additive) **/
const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan."],
  [/miss(ed)?\s+payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council\s*tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/credit\s*card|loan|overdraft|catalogue|car\s*finance/i, "We’ll take this step by step and ease the pressure."]
];
const BRIDGES = ["Got it.", "Understood.", "Thanks for sharing.", "Appreciate that.", "Noted."];

/** DB helpers **/
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
    created_at: m.created_at || undefined
  }));
}
async function append(sessionId: string, role: "user" | "assistant", content: string) {
  await supabase.from("messages").insert({ session_id: sessionId, role, content });
}
async function telemetry(sessionId: string, event_type: string, payload: any) {
  try {
    await supabase.from("chat_telemetry").insert({ session_id: sessionId, event_type, payload });
  } catch {
    /* best effort */
  }
}

/** Utils **/
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
function tidyName(raw: string) {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}
function extractName(s: string): string | null {
  const rx = /(my name is|i am|i'm|im|it's|its|call me)\s+([a-z][a-z\s'’-]{1,60})/i;
  const m = s.match(rx);
  if (m?.[2]) return tidyName(m[2]);
  const m2 = s.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  return m2?.[1] ? tidyName(m2[1]) : null;
}
function amountsAnswered(s: string) {
  const nums = s.match(/£?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)?.map((x) => Number(x.replace(/[^0-9.]/g, ""))) || [];
  return nums.length >= 2; // pays now + feels affordable
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
function empathyLine(s: string) {
  for (const [re, line] of EMPATHY) if (re.test(s)) return line;
  return null;
}
function isHowAreYou(s: string) {
  return /\b(how (are|r) (you|u)|you ok\??|how’s things|hows things)\b/i.test(s);
}

/** Core handler **/
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    const language = String(req.body.language || "English");
    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // reset
    if (/^(reset|restart|start again)$/i.test(userMessage)) {
      await supabase.from("messages").delete().eq("session_id", sessionId);
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "reset", { language });
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // history
    let history = await loadHistory(sessionId);

    // first time → opener
    if (history.length === 0) {
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "start", { language });
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // add user message
    if (userMessage) {
      await append(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    // Determine last asked step & contiguous sequence
    const seen = assistantSteps(history).filter((n) => n >= 0).sort((a, b) => a - b);
    let contiguous: number[] = [];
    for (let i = 0; i < seen.length; i++) {
      if (seen[i] === i) contiguous.push(i);
      else break;
    }

    const { idx: lastAIdx, step: lastAsked } = lastAssistantStep(history);
    const uIdx = lastUserIdx(history);
    const latestUser = uIdx >= 0 ? history[uIdx].content : "";
    const seed = history.length;

    // After the opener, always begin at step 0
    if (contiguous.length === 0) {
      const greet =
        GREETINGS.has(norm(latestUser)) || isHowAreYou(latestUser) ? "Hi — you’re in the right place." : BRIDGES[seed % BRIDGES.length];
      const step0 = SCRIPT.find((s) => s.id === 0) || SCRIPT[0];
      const out = `${greet} ${step0.prompt}`;
      await append(sessionId, "assistant", `${STEP_TAG(step0.id)} ${out}`);
      await telemetry(sessionId, "step_shown", { step: step0.id, reason: "post_opener" });
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // If user hasn't replied since last assistant → repeat same
    if (uIdx <= lastAIdx) {
      const ask = SCRIPT.find((s) => s.id === lastAsked) || SCRIPT[0];
      await append(sessionId, "assistant", `${STEP_TAG(ask.id)} ${ask.prompt}`);
      await telemetry(sessionId, "step_repeat", { step: ask.id, reason: "no_user_after_assistant" });
      return res.status(200).json({ reply: ask.prompt, openPortal: false });
    }

    const step = SCRIPT.find((s) => s.id === lastAsked) || SCRIPT[0];
    const replyParts: string[] = [];

    // conversational niceties
    if (isHowAreYou(latestUser)) replyParts.push("I’m good thanks — more importantly, I’m here to help you today.");

    // add empathy if relevant
    const emLine = empathyLine(latestUser);
    if (emLine) replyParts.push(emLine);

    // validate current step (NO jumping)
    let moveNext = false;
    let openPortal = false;

    switch (step.expects) {
      case "name": {
        const name = extractName(latestUser) || (norm(latestUser).split(" ").length <= 3 ? tidyName(latestUser) : null);
        if (name) {
          if (name.toLowerCase() === BOT_NAME.toLowerCase()) replyParts.push(`Two ${BOT_NAME}s — love it 😄`);
          replyParts.push(`Nice to meet you, ${name}.`);
          moveNext = true;
          await telemetry(sessionId, "step_completed", { step: step.id, signal: "name_captured", name });
        } else {
          replyParts.push("Just so I can address you properly, what’s your name?");
        }
        break;
      }

      case "concern": {
        // any non-empty answer counts, but we prefer matches
        moveNext = latestUser.trim().length > 0;
        if (!moveNext) replyParts.push("What’s the main concern with the debts?");
        break;
      }

      case "amounts": {
        moveNext = amountsAnswered(latestUser);
        if (!moveNext)
          replyParts.push(
            "Roughly how much do you pay each month across all debts, and what would feel affordable?"
          );
        break;
      }

      case "urgency": {
        moveNext = urgencyAnswered(latestUser);
        if (!moveNext)
          replyParts.push("Is anything urgent like enforcement, court/default letters, or missed priority bills?");
        break;
      }

      case "ack": {
        moveNext = ackYes(latestUser);
        if (!moveNext) replyParts.push("Totally fine — shall we carry on?");
        break;
      }

      case "portalInvite": {
        // Only after 0..4 are actually completed in order
        const preDone = [0, 1, 2, 3, 4].every((id) => contiguous.includes(id));
        if (!preDone) {
          // realign back to earliest missing
          const missing = [0, 1, 2, 3, 4].find((id) => !contiguous.includes(id))!;
          const back = SCRIPT.find((s) => s.id === missing)!;
          await append(sessionId, "assistant", `${STEP_TAG(back.id)} ${back.prompt}`);
          await telemetry(sessionId, "step_shown", { step: back.id, reason: "preportal_not_complete" });
          return res.status(200).json({ reply: back.prompt, openPortal: false });
        }
        if (affirmative(latestUser)) {
          openPortal = true;
          moveNext = true;
          await telemetry(sessionId, "portal_opened", { at_step: step.id });
        } else {
          replyParts.push("No worries — we can open it later when you’re ready.");
          moveNext = true; // still progress to follow-up
        }
        break;
      }

      case "docs": {
        // simple acks like "uploaded" or any text moves on
        moveNext = latestUser.trim().length > 0;
        break;
      }

      default: {
        moveNext = latestUser.trim().length > 0;
        if (!moveNext) replyParts.push(step.prompt);
        break;
      }
    }

    // If not satisfied, stay on this step
    if (!moveNext) {
      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(step.id)} ${out}`);
      await telemetry(sessionId, "step_repeat", { step: step.id, reason: "validation_failed" });
      return res.status(200).json({ reply: out, openPortal: false });
    }

    // Move strictly to the next step
    let nextIndex = SCRIPT.findIndex((s) => s.id === step.id) + 1;
    if (nextIndex >= SCRIPT.length) nextIndex = SCRIPT.length - 1;
    const nextStep = SCRIPT[nextIndex];

    // If we just accepted the portal invite
    if (step.expects === "portalInvite" && openPortal) {
      // show follow-up text (step 6)
      const follow = SCRIPT.find((s) => s.name === "portal_followup") || nextStep;
      replyParts.push(follow.prompt);
      const out = replyParts.join(" ");
      await append(sessionId, "assistant", `${STEP_TAG(follow.id)} ${out}`);
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
