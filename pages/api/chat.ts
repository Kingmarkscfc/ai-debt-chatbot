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

/** Script & constants **/
const SCRIPT_IN: ScriptShape = rawScript as any;
const SCRIPT: Step[] = (SCRIPT_IN.steps || []).map((s) => s);
const OPENING = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
const STEP_TAG = (n: number) => `[[STEP:${n}]]`;
const STEP_RE = /\[\[STEP:(-?\d+)\]\]/;

/** Empathy & bridges **/
const EMPATHY: Array<[RegExp, string]> = [
  [/bailiff|enforcement/i, "I know bailiff contact is stressful — we’ll get protections in place quickly."],
  [/ccj|county court|default/i, "Court or default letters can be worrying — we’ll address that in your plan."],
  [/miss(ed)?\s+payments?|arrears|late fees?/i, "Missed payments happen — we’ll focus on stabilising things now."],
  [/rent|council\s*tax|water|gas|electric/i, "We’ll make sure essentials like housing and utilities are prioritised."],
  [/credit\s*card|loan|overdraft|catalogue|car\s*finance/i, "We’ll take this step by step and ease the pressure."]
];
const BRIDGES = ["Got it.", "Understood.", "Thanks for sharing.", "Appreciate that."];

/** FAQ matcher (very light) **/
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
  const simple = s.trim();
  if (simple && simple.split(/\s+/).length <= 3) return tidyName(simple);
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
const ackYes = (s: string) => /\b(yes|ok|okay|sure|carry on|continue|proceed|yep|yeah|go ahead)\b/i.test(s);
const affirmative = (s: string) => /\b(yes|ok|okay|sure|go ahead|open|start|set up|yep|yeah|please)\b/i.test(s);
const isHowAreYou = (s: string) => /\b(how (are|r) (you|u)|you ok\??|how’s things|hows things)\b/i.test(s);
const isQuestion = (s: string) => s.includes("?");

/** History parsing helpers **/
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

/** Validate a user's reply for a particular step id */
function validate(stepId: number, txt: string): boolean {
  const s = SCRIPT.find((x) => x.id === stepId);
  if (!s) return false;
  switch (s.expects) {
    case "name": return !!extractName(txt);
    case "concern": return txt.trim().length > 0;
    case "amounts": return amountsAnswered(txt);
    case "urgency": return urgencyAnswered(txt);
    case "ack": return ackYes(txt);
    case "portalInvite": return affirmative(txt); // only true means “yes, open”
    case "docs": return txt.trim().length > 0;
    default: return txt.trim().length > 0;
  }
}

/** Compute the NEXT REQUIRED STEP (strict) by validating each step against the user's reply that followed it */
function nextRequiredStep(history: Msg[]): number {
  // find the opener; if none, we still start at step 0
  const aSteps = iterAssistantSteps(history).filter((s) => s.step >= 0);
  // validation pass: for steps 0..n, check whether they were asked and then answered acceptably
  let expect = 0;
  for (let id = 0; id < SCRIPT.length; id++) {
    const asked = aSteps.find((x) => x.step === id);
    if (!asked) return id; // never asked → we need to ask it
    const ua = userAfter(history, asked.idx);
    if (!ua || !validate(id, ua.text)) return id; // asked but not validly answered
    expect = id + 1;
  }
  return Math.min(expect, SCRIPT.length - 1);
}

/** Build a side answer for Q&A, then restate the current step (does not advance). */
function sideAnswerThen(stepPrompt: string, user: string): string {
  const parts: string[] = [];

  if (isHowAreYou(user)) {
    parts.push("I’m good thanks — more importantly, I’m here to help you today.");
  }

  const emp = EMPATHY.find(([re]) => re.test(user));
  if (emp) parts.push(emp[1]);

  const faq = faqAnswer(user);
  if (faq) parts.push(faq);

  if (parts.length === 0 && isQuestion(user)) {
    parts.push("Good question — here’s a quick answer: we’ll tailor a plan to lower payments and stop the spiral.");
  }

  // Always guide back to the script step prompt
  parts.push(stepPrompt);
  return parts.join(" ");
}

/** Core handler **/
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const sessionId = String(req.body.sessionId || "");
    const userMessage = String(req.body.userMessage || req.body.message || "").trim();
    if (!sessionId) return res.status(400).json({ reply: "Missing session.", openPortal: false });

    // reset command
    if (/^(reset|restart|start again)$/i.test(userMessage)) {
      await supabase.from("messages").delete().eq("session_id", sessionId);
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "reset", {});
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // load history
    let history = await loadHistory(sessionId);

    // first time → opener
    if (history.length === 0) {
      const opener = `${STEP_TAG(-1)} ${OPENING}`;
      await append(sessionId, "assistant", opener);
      await telemetry(sessionId, "start", {});
      return res.status(200).json({ reply: OPENING, openPortal: false });
    }

    // append user input to history
    if (userMessage) {
      await append(sessionId, "user", userMessage);
      history.push({ role: "user", content: userMessage });
    }

    // Compute which step is required *now*
    const needId = nextRequiredStep(history);
    const needStep = SCRIPT.find((s) => s.id === needId) || SCRIPT[0];

    // Did the user just ask a side question / small talk?
    const justAsked = iterAssistantSteps(history).slice(-1)[0]; // last assistant step asked
    const lastUser = history.slice(-1)[0];
    const userTxt = lastUser?.role === "user" ? lastUser.content : "";

    const looksLikeSideQA =
      isQuestion(userTxt) || isHowAreYou(userTxt) || (!!faqAnswer(userTxt) && !validate(needId, userTxt));

    if (looksLikeSideQA) {
      // Give a short answer, then restate the current step prompt (no advance)
      const blended = sideAnswerThen(needStep.prompt, userTxt);
      await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${blended}`);
      await telemetry(sessionId, "side_qa", { at_step: needStep.id });
      return res.status(200).json({ reply: blended, openPortal: false });
    }

    // If current step is the portal invite, only open when explicit yes/ok…
    if (needStep.expects === "portalInvite") {
      const yes = affirmative(userTxt);
      if (yes) {
        const follow = SCRIPT.find((s) => s.name === "portal_followup")!;
        const out = `${follow.prompt}`;
        await append(sessionId, "assistant", `${STEP_TAG(follow.id)} ${out}`);
        await telemetry(sessionId, "portal_opened", { at_step: needStep.id });
        return res.status(200).json({ reply: out, openPortal: true });
      }
      // Not affirmative → ask the invite step itself
      await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${needStep.prompt}`);
      await telemetry(sessionId, "step_shown", { step: needStep.id });
      return res.status(200).json({ reply: needStep.prompt, openPortal: false });
    }

    // Normal case: ask the required step prompt
    await append(sessionId, "assistant", `${STEP_TAG(needStep.id)} ${needStep.prompt}`);
    await telemetry(sessionId, "step_shown", { step: needStep.id });
    return res.status(200).json({ reply: needStep.prompt, openPortal: false });
  } catch (e: any) {
    console.error("chat api error:", e?.message || e);
    return res
      .status(200)
      .json({ reply: "Sorry — something went wrong on my end. Let’s continue from here.", openPortal: false });
  }
}

