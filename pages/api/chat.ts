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
  expects?: "name" | "concern" | "amounts" | "urgency" | "ack" | "portalInvite" | "docs" | "free";
};
type ScriptShape = { steps: Step[]; small_talk?: { greetings?: string[] } };
type Msg = { role: "user" | "assistant"; content: string; created_at?: string };

/** Supabase **/
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

/** Script **/
const SCRIPT_IN: ScriptShape = rawScript as any;
const SCRIPT: Step[] = (SCRIPT_IN.steps || []).map((s) => s);

// Make sure the portal invite step is explicitly at id 4 (as requested)
const PORTAL_INVITE_ID = 4;

/** Opening line (no globe text) **/
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
const BRIDGES = [
  "Got it.",
  "Understood.",
  "Thanks for sharing.",
  "I appreciate the context."
];

/** FAQ (keyword) **/
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
  try {
    await supabase.from("chat_telemetry").insert({ session_id: sessionId, event_type, payload });
  } catch {
    /* best effort */
  }
}

/** Utils **/
const norm = (s: string) => (s || "").toLowerCase().trim();
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
  // bare short name (“Mark”, “Mark Hughes”)
  const simple = s.trim();
  if (/^[a-z][a-z\s'’-]{1,60}$/i.test(simple) && simple.split(/\s+/).length <= 3) {
    return tidyName(simple);
  }
  return null;
}
function amountsAnswered(s: string) {
  const nums = s.match(/£?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)?.map((x) => Number(x.replace(/[^0-9.]/g, ""))) || [];
  return nums.length >= 2;
}
function urgencyAnswered(s: string) {
  const u = norm(s);
  if (/\b(no|none|nothing|not really|all good|fine)\b/.test(u)) return true;
  if (/(bailiff|enforcement|ccj|default|court|missed|rent|council\s*tax|gas|electric|water)/i.test(u)) return true;
  return false;
}
const isHowAreYou = (s: string) => /\b(how (are|r) (you|u)|you ok\??|how’s things|hows things)\b/i.test(s);
const isQuestion = (s: string) => s.includes("?");
const ackYes = (s: string) => /\b(yes|ok|okay|sure|carry on|continue|proceed|yep|yeah|go ahead)\b/i.test(s);
const affirmative = (s: string) => /\b(yes|ok|okay|sure|go ahead|open|start|set up|yep|yeah|please)\b/i.test(s);

/** Intent detection **/
type Intents = {
  greet: boolean;
  howAreYou: boolean;
  provideName: string | null;
  amounts: boolean;
  urgency: boolean;
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
    amounts: amountsAnswered(u),
    urgency: urgencyAnswered(u),
    question: isQuestion(u),
    yes: ackYes(u),
    no: /\b(no|nope|nah|not now)\b/i.test(l)
  };
}

/** History helpers **/
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
function validate(stepId: number, txt: string): boolean {
  const s = SCRIPT.find((x) => x.id === stepId);
  if (!s) return false;
  switch (s.expects) {
    case "name": return !!extractName(txt);
    case "concern": return txt.trim().length > 0;
    case "amounts": return amountsAnswered(txt);
    case "urgency": return urgencyAnswered(txt);
    case "ack": return ackYes(txt);
    case "portalInvite": return affirmative(txt); // only “yes” counts
    case "docs": return txt.trim().length > 0;
    default: return txt.trim().length > 0;
  }
}

/** Compute next required step strictly by validation */
function nextRequiredStep(history: Msg[]): number {
  const askedSteps = iterAssistantSteps(history).filter((s) => s.step >= 0);
  for (let id = 0; id < SCRIPT.length; id++) {
    const asked = askedSteps.find((x) => x.step === id);
    if (!asked) return id;
    const ua = userAfter(history, asked.idx);
    if (!ua || !validate(id, ua.text)) return id;
  }
  return Math.min(SCRIPT.length - 1, SCRIPT.length); // safety
}

/** Build side answer and then restate current step (no advance) */
function sideAnswerThen(stepPrompt: string, user: string, displayName?: string): string {
  const parts: string[] = [];

  if (isHowAreYou(user)) {
    parts.push("I’m good thanks — more importantly, I’m here to help you today.");
  }

  const emp = EMPATHY.find(([re]) => re.test(user));
  if (emp) parts.push(emp[1]);

  const faq = faqAnswer(user);
  if (faq) parts.push(faq);

  if (parts.length === 0 && isQuestion(user)) {
    parts.push("Good question — short answer: we’ll tailor a plan to lower payments and steady things.");
  }

  const greetName = displayName ? ` ${displayName}` : "";
  parts.push(`${BRIDGES[Math.floor(Math.random()*BRIDGES.length)]} ${stepPrompt.replace("Can you let me know who I’m speaking to?", `Can you let me know who I’m speaking to${greetName ? ","+greetName : ""}?`)}`);

  return parts.join(" ");
}

/** Persist light profile fields (best-effort) */
async function saveNameIfNew(sessionId: string, email: string | undefined, displayName: string) {
  try {
    // store in chat_telemetry + clients table (best-effort; ignore errors)
    await supabase.from("chat_telemetry").insert({
      session_id: sessionId,
      event_type: "set_name",
      payload: { displayName }
    });
    await supabase
      .from("clients")
      .upsert(
        { session_id: sessionId, full_name: displayName },
        { onConflict: "session_id" as any }
      );
    if (email) {
      await supabase
        .from("client_profiles")
        .upsert({ email, full_name: displayName }, { onConflict: "email" as any });
    }
  } catch {
    /* ignore */
  }
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

    // load history or start
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

    // detect intents
    const intents = detectIntents(userMessage);

    // capture name anywhere (without advancing)
    let displayName = providedDisplayName;
    if (!displayName && intents.provideName) {
      displayName = intents.provideName;
      await saveNameIfNew(sessionId, undefined, displayName);
    }

    // compute required step
    const needId = nextRequiredStep(history);
    const needStep = SCRIPT.find((s) => s.id === needId) || SCRIPT[0];

    // If user asked side question / said how-are-you / provided name while step expects something else:
    const lastUser = history.slice(-1)[0];
    const userTxt = lastUser?.role === "user" ? lastUser.content : "";
    const looksLikeSideQA =
      intents.howAreYou ||
      intents.question ||
      (!!faqAnswer(userTxt) && !validate(needId, userTxt)) ||
      (!!intents.provideName && needStep.expects !== "name");

    if (looksLikeSideQA) {
      let prefix = "";
      if (intents.provideName) {
        prefix = `Nice to meet you, ${displayName || intents.provideName}. `;
      }
      const blended = prefix + sideAnswerThen(needStep.prompt, userTxt, displayName);
      await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${blended}`);
      await telemetry(sessionId, "side_qa", { at_step: needStep.id, nameSet: !!intents.provideName });
      return res.status(200).json({ reply: blended, displayName, openPortal: false });
    }

    // Portal invite handling: only open on explicit yes; otherwise ask the invite step
    if (needStep.id === PORTAL_INVITE_ID || needStep.expects === "portalInvite") {
      if (affirmative(userTxt)) {
        // Send follow-up step after portal is opened (do not skip steps)
        const follow = SCRIPT.find((s) => s.name === "portal_followup") || SCRIPT.find((s) => s.id === PORTAL_INVITE_ID + 1);
        const out = follow ? follow.prompt : "While you’re in the portal, I’ll stay here to guide you. Once you’ve saved your details, just say “done” and we’ll continue. You can come back to the chat anytime using the button in the top-right corner. Please follow the outstanding tasks so we can better understand your situation.";
        await append(sessionId, "assistant", `${STEP_TAG(follow ? follow.id : needStep.id)} ${out}`);
        await telemetry(sessionId, "portal_opened", { at_step: needStep.id });
        return res.status(200).json({ reply: out, displayName, openPortal: true });
      }
      // Not affirmative → ask the invite step (don’t open)
      await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${needStep.prompt}`);
      await telemetry(sessionId, "step_shown", { step: needStep.id });
      return res.status(200).json({ reply: needStep.prompt, displayName, openPortal: false });
    }

    // Normal case: ask the required step prompt (varied bridge if we just confirmed something)
    const promptOut = needStep.prompt;
    await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${promptOut}`);
    await telemetry(sessionId, "step_shown", { step: needStep.id });
    return res.status(200).json({ reply: promptOut, displayName, openPortal: false });
  } catch (e: any) {
    console.error("chat api error:", e?.message || e);
    return res
      .status(200)
      .json({ reply: "Sorry — something went wrong on my end. Let’s continue from here.", openPortal: false });
  }
}
