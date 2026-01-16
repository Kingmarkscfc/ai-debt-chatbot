import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import rawScript from "../../utils/full_script_logic.json";
import faqs from "../../utils/faqs.json";

/** Types **/
type Step = {
  id: number;
  name?: string;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
  // Optional: we infer if missing
  expects?: "name" | "concern" | "amounts" | "urgency" | "ack" | "portalInvite" | "docs" | "free";
};
type ScriptShape = { steps: Step[] };
type Msg = { role: "user" | "assistant"; content: string; created_at?: string };

/** Supabase **/
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

/** Load & normalize script **/
const SCRIPT_IN: ScriptShape = rawScript as any;
const SCRIPT: Step[] = (SCRIPT_IN.steps || []).map((s) => ({ ...s }));

// Heuristic: infer expects if not set
for (const s of SCRIPT) {
  const p = (s.prompt || "").toLowerCase();
  if (!s.expects) {
    if (/what.*name|who.*speaking/.test(p)) s.expects = "name";
    else if (/main concern|biggest worry|point you in the right direction/.test(p)) s.expects = "concern";
    else if (/how much.*pay.*each month.*affordable|roughly.*pay.*affordable/.test(p)) s.expects = "amounts";
    else if (/anything urgent|enforcement|bailiff|court|default|missed priority/i.test(p)) s.expects = "urgency";
    else if (/moneyhelper|no obligation|shall we carry on/.test(p)) s.expects = "ack";
    else if (/set up.*portal|open it now|shall i open it/.test(p)) s.expects = "portalInvite";
    else if (/upload documents|upload docs|statements|payslips|letters/.test(p)) s.expects = "docs";
    else s.expects = "free";
  }
}

// Explicit portal invite anchor (move if your script changes)
const PORTAL_INVITE_ID = 4;

/** Opening line (no globe) **/
const OPENING = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
const STEP_TAG = (n: number) => `[[STEP:${n}]]`;
const STEP_RE = /\[\[STEP:(-?\d+)\]\]/;

/** Light empathy + bridges **/
const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan."],
  [/miss(ed)?\s+payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council\s*tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/credit\s*card|loan|overdraft|catalogue|car\s*finance/i, "We’ll take this step by step and ease the pressure."]
];
const BRIDGES = ["Got it.", "Understood.", "Thanks for sharing.", "I appreciate the context."];

/** FAQ **/
type FAQ = { q: string; a: string; keywords?: string[] };
const FAQS: FAQ[] = (faqs as unknown as FAQ[]) || [];
function faqAnswer(u: string): string | null {
  const txt = u.toLowerCase();
  let best: { a: string; score: number } | null = null;
  for (const f of FAQS) {
    const kws = (f.keywords || []).map((k) => k.toLowerCase());
    const hits = kws.filter((k) => txt.includes(k)).length;
    if (hits > 0) {
      const score = hits * 10 + (txt.includes(f.q.toLowerCase()) ? 5 : 0);
      if (!best || score > best.score) best = { a: f.a, score };
    }
  }
  return best?.a || null;
}

/** DB helpers **/
async function loadHistory(sessionId: string): Promise<Msg[]> {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(800);
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
  try { await supabase.from("chat_telemetry").insert({ session_id: sessionId, event_type, payload }); } catch {}
}

/** Utils **/
const norm = (s: string) => (s || "").toLowerCase().trim();
function tidyName(raw: string) {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return cleaned.split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}
function extractName(s: string): string | null {
  const rx = /(my name is|i am|i'm|im|it's|its|call me)\s+([a-z][a-z\s'’-]{1,60})/i;
  const m = s.match(rx);
  if (m?.[2]) return tidyName(m[2]);
  const simple = s.trim();
  if (/^[a-z][a-z\s'’-]{1,60}$/i.test(simple) && simple.split(/\s+/).length <= 3) return tidyName(simple);
  return null;
}
const isHowAreYou = (s: string) => /\b(how (are|r) (you|u)|you ok\??|how’s things|hows things)\b/i.test(s);
const isQuestion = (s: string) => s.includes("?");
const ackYes = (s: string) => /\b(yes|ok|okay|sure|carry on|continue|proceed|yep|yeah|go ahead)\b/i.test(s);
const affirmative = (s: string) => /\b(yes|ok|okay|sure|go ahead|open|start|set up|yep|yeah|please)\b/i.test(s);

/** Amount parsing & windowing **/
function numbersIn(text: string): number[] {
  return text.match(/£?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)?.map((x) => Number(x.replace(/[^0-9.]/g, ""))) || [];
}
function lastAssistantStepIdx(history: Msg[], stepId: number): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      const m = history[i].content.match(STEP_RE);
      if (m && Number(m[1]) === stepId) return i;
    }
  }
  return -1;
}
function collectUserSince(history: Msg[], startIdx: number): string[] {
  const out: string[] = [];
  for (let i = startIdx + 1; i < history.length; i++) {
    const h = history[i];
    if (h.role === "assistant") break; // stop at next assistant prompt
    if (h.role === "user") out.push(h.content);
  }
  return out;
}
function findStepByExpect(ex: Step["expects"]): Step | undefined {
  return SCRIPT.find((s) => s.expects === ex);
}

/** Intent detection **/
type Intents = {
  greet: boolean;
  howAreYou: boolean;
  provideName: string | null;
  question: boolean;
  yes: boolean;
  no: boolean;
};
function detectIntents(s: string): Intents {
  const u = s.trim();
  const l = norm(u);
  const provideName = extractName(u);
  return {
    greet: /\b(hi|hello|hey|good (morning|afternoon|evening)|greetings)\b/i.test(u),
    howAreYou: isHowAreYou(u),
    provideName,
    question: isQuestion(u),
    yes: ackYes(u),
    no: /\b(no|nope|nah|not now)\b/i.test(l)
  };
}

/** Step helpers **/
function iterAssistantSteps(history: Msg[]) {
  const out: Array<{ step: number; idx: number }> = [];
  history.forEach((h, idx) => {
    if (h.role !== "assistant") return;
    const m = h.content.match(STEP_RE);
    if (m) out.push({ step: Number(m[1]), idx });
  });
  return out;
}
function userAfter(history: Msg[], idx: number): { idx: number; text: string } | null {
  for (let i = idx + 1; i < history.length; i++) {
    if (history[i].role === "user") return { idx: i, text: history[i].content };
  }
  return null;
}

/** Validation **/
function amountsAnsweredWindow(history: Msg[], stepId: number): { have: number[]; ok: boolean } {
  const startIdx = lastAssistantStepIdx(history, stepId);
  if (startIdx === -1) return { have: [], ok: false };
  const texts = collectUserSince(history, startIdx);
  const nums: number[] = [];
  texts.forEach((t) => nums.push(...numbersIn(t)));
  // Two distinct numbers = current + affordable captured
  return { have: nums.slice(0, 3), ok: nums.filter((n) => !Number.isNaN(n)).length >= 2 };
}
function urgencyAnswered(s: string) {
  const u = norm(s);
  if (/\b(no|none|nothing|not really|all good|fine)\b/.test(u)) return true;
  if (/(bailiff|enforcement|ccj|default|court|missed|rent|council\s*tax|gas|electric|water)/i.test(u)) return true;
  return false;
}
function validate(stepId: number, txt: string, history: Msg[]): boolean {
  const s = SCRIPT.find((x) => x.id === stepId);
  if (!s) return false;
  switch (s.expects) {
    case "name": return !!extractName(txt);
    case "concern": return txt.trim().length > 0;
    case "amounts": return amountsAnsweredWindow(history, stepId).ok;
    case "urgency": return urgencyAnswered(txt);
    case "ack": return ackYes(txt);
    case "portalInvite": return affirmative(txt);
    case "docs": return txt.trim().length > 0;
    default: return txt.trim().length > 0;
  }
}

/** Next required step (strict) */
function nextRequiredStep(history: Msg[]): number {
  const askedSteps = iterAssistantSteps(history).filter((s) => s.step >= 0);
  for (let id = 0; id < SCRIPT.length; id++) {
    const asked = askedSteps.find((x) => x.step === id);
    if (!asked) return id;
    const ua = userAfter(history, asked.idx);
    if (!ua || !validate(id, ua.text, history)) return id;
  }
  return Math.min(SCRIPT.length - 1, SCRIPT.length);
}

/** Small talk/FAQ blend that DOESN’T advance */
function sideAnswerThen(stepPrompt: string, user: string, displayName?: string): string {
  const chunks: string[] = [];
  if (isHowAreYou(user)) chunks.push("I’m good thanks — more importantly, I’m here to help you today.");
  const emp = EMPATHY.find(([re]) => re.test(user));
  if (emp) chunks.push(emp[1]);
  const faq = faqAnswer(user);
  if (faq) chunks.push(faq);
  if (chunks.length === 0 && isQuestion(user)) {
    chunks.push("Good question — short answer: we’ll tailor a plan to lower payments and steady things.");
  }
  const bridge = BRIDGES[Math.floor(Math.random() * BRIDGES.length)];
  const nameTail = displayName ? `, ${displayName}` : "";
  chunks.push(`${bridge} ${stepPrompt.replace("who I’m speaking to?", `who I’m speaking to${nameTail}?`)}`);
  return chunks.join(" ");
}

/** Persist light profile fields (best-effort) */
async function saveNameIfNew(sessionId: string, email: string | undefined, displayName: string) {
  try {
    await supabase.from("chat_telemetry").insert({ session_id: sessionId, event_type: "set_name", payload: { displayName } });
    await supabase.from("clients").upsert({ session_id: sessionId, full_name: displayName }, { onConflict: "session_id" as any });
    if (email) await supabase.from("client_profiles").upsert({ email, full_name: displayName }, { onConflict: "email" as any });
  } catch { /* ignore */ }
}

/** Core handler **/
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    const providedDisplayName = String(req.body.displayName || "").trim() || undefined;
    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // reset
    if (/^(reset|restart|start again)$/i.test(userMessage)) {
      await supabase.from("messages").delete().eq("session_id", sessionId);
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "reset", {});
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // load or start
    let history = await loadHistory(sessionId);
    if (history.length === 0) {
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "start", {});
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // append user
    if (userMessage) {
      await append(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    const intents = detectIntents(userMessage);

    // capture name anywhere (without advancing)
    let displayName = providedDisplayName;
    if (!displayName && intents.provideName) {
      displayName = intents.provideName;
      await saveNameIfNew(sessionId, undefined, displayName);
    }

    // decide which step is required
    const needId = nextRequiredStep(history);
    const needStep = SCRIPT.find((s) => s.id === needId) || SCRIPT[0];

    // Special handling for AMOUNTS (prevent loop by asking only what's missing)
    if (needStep.expects === "amounts") {
      const window = amountsAnsweredWindow(history, needStep.id);
      if (window.have.length === 0) {
        const out = needStep.prompt; // original combined prompt
        await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${out}`);
        await telemetry(sessionId, "step_shown", { step: needStep.id, mode: "amounts-none" });
        return res.status(200).json({ reply: out, displayName, openPortal: false });
      }
      if (window.have.length === 1) {
        // Ask only for the missing piece
        const single = window.have[0];
        // Heuristic: if user said "I pay X", next we want "what would feel affordable?"
        // If they said "I can afford X", next we want "what do you currently pay?"
        const lastChunk = history[history.length - 1]?.content.toLowerCase() || "";
        const asked =
          /afford|affordable|want to pay|can pay|could pay/.test(lastChunk)
            ? "Thanks — and roughly how much do you pay across all debts each month right now?"
            : "Thanks — and what would feel affordable for you each month?";
        await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${asked}`);
        await telemetry(sessionId, "step_shown", { step: needStep.id, mode: "amounts-partial", have: single });
        return res.status(200).json({ reply: asked, displayName, openPortal: false });
      }
      // have >= 2 → proceed (fall through to normal prompt of next step by tricking validator)
    }

    // Side Q&A that shouldn't advance: how-are-you / FAQ / arbitrary questions mid-step
    const lastUser = history.slice(-1)[0];
    const userTxt = lastUser?.role === "user" ? lastUser.content : "";
    const looksSide =
      intents.howAreYou ||
      (intents.question && needStep.expects !== "ack" && needStep.expects !== "portalInvite");

    if (looksSide) {
      let prefix = "";
      if (intents.provideName) prefix = `Nice to meet you, ${displayName || intents.provideName}. `;
      const blended = prefix + sideAnswerThen(needStep.prompt, userTxt, displayName);
      await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${blended}`);
      await telemetry(sessionId, "side_qa", { at_step: needStep.id, nameSet: !!intents.provideName });
      return res.status(200).json({ reply: blended, displayName, openPortal: false });
    }

    // Portal invite step: open only on explicit yes
    if (needStep.id === PORTAL_INVITE_ID || needStep.expects === "portalInvite") {
      if (affirmative(userTxt)) {
        const follow = SCRIPT.find((s) => s.name === "portal_followup") || SCRIPT.find((s) => s.id === PORTAL_INVITE_ID + 1);
        const out =
          follow?.prompt ||
          "While you’re in the portal, I’ll stay here to guide you. You can come back to the chat anytime using the button in the top-right corner. Please follow the outstanding tasks so we can better understand your situation. Once you’ve saved your details, say “done” and we’ll continue.";
        await append(sessionId, "assistant", `${STEP_TAG(follow ? follow.id : needStep.id)} ${out}`);
        await telemetry(sessionId, "portal_opened", { at_step: needStep.id });
        return res.status(200).json({ reply: out, displayName, openPortal: true });
      }
      await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${needStep.prompt}`);
      await telemetry(sessionId, "step_shown", { step: needStep.id, mode: "invite" });
      return res.status(200).json({ reply: needStep.prompt, displayName, openPortal: false });
    }

    // Normal: ask required step
    const out = needStep.prompt;
    await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${out}`);
    await telemetry(sessionId, "step_shown", { step: needStep.id });
    return res.status(200).json({ reply: out, displayName, openPortal: false });
  } catch (e: any) {
    console.error("chat api error:", e?.message || e);
    return res
      .status(200)
      .json({ reply: "Sorry — something went wrong on my end. Let’s continue from here.", openPortal: false });
  }
}
