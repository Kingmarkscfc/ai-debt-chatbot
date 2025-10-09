import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

// --- Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  // use service role in server env if present (works on Vercel)
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "") as string
);

// --- Script + helpers ---
type Step = { id: number; name: string; prompt: string; expects: string; keywords?: string[]; openPortal?: boolean };
type Script = {
  steps: Step[];
  greetings: string[];
  empathy: { re: string; reply: string }[];
  faqHints: { kw: string[]; a: string }[];
};

import scriptJson from "../../utils/full_script_logic.json";

const script = scriptJson as unknown as Script;

// Simple state shape we persist inside chat_history row
type ChatState = {
  session_id: string;
  messages: { role: "user" | "assistant"; content: string }[];
  stepIndex: number;                 // which step prompt we last SENT
  displayName?: string;              // captured name
  portalAsked?: boolean;             // we asked "shall I open it?"
  portalOpened?: boolean;            // we opened portal after explicit consent
};

function isGreeting(s: string) {
  const t = s.trim().toLowerCase();
  return script.greetings.some(g => t.startsWith(g));
}

function extractName(s: string): string | null {
  // Very light heuristic: pick up after “my name is … / i’m … / im … / it’s … / call me …”
  const m = s.match(/\b(my name is|i am|i'm|im|it'?s|call me)\s+([a-z][a-z'\- ]{1,60})/i);
  if (m) return cap(m[2].trim());
  // or single token name fallback if user sent just "Mark"
  const single = s.trim();
  if (/^[a-z][a-z'\- ]{1,60}$/i.test(single) && single.split(" ").length <= 3) return cap(single);
  return null;
}
function cap(x: string) {
  return x.split(" ").map(w => w ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : w).join(" ");
}

function anyKeywordHit(s: string, kws: string[] = []) {
  if (!kws?.length) return true;
  const t = s.toLowerCase();
  return kws.some(k => t.includes(k.toLowerCase()));
}

function empathyLine(user: string): string | null {
  for (const e of script.empathy) {
    try {
      const re = new RegExp(e.re, "i");
      if (re.test(user)) return e.reply;
    } catch {}
  }
  return null;
}

function faqHint(user: string): string | null {
  const t = user.toLowerCase();
  for (const f of script.faqHints) {
    if (f.kw.some(k => t.includes(k))) return f.a;
  }
  return null;
}

// get or init state
async function loadState(session_id: string): Promise<ChatState> {
  const { data } = await supabase
    .from("chat_history")
    .select("messages")
    .eq("session_id", session_id)
    .single();

  const messages = (data?.messages as ChatState["messages"]) || [];
  // Step index = how many times we *prompted a scripted question*
  // We’ll explicitly write stepIndex whenever we send a scripted prompt, so default to -1 means nothing sent yet.
  const lastAssistant = messages.filter(m => m.role === "assistant").length;
  // backward compatibility: if we never wrote stepIndex, assume we haven’t asked the first scripted question yet.
  const stepIndex = -1;

  return { session_id, messages, stepIndex };
}

async function saveState(state: ChatState) {
  await supabase.from("chat_history").upsert({
    session_id: state.session_id,
    messages: state.messages
  });
}

// send one assistant message & bump step index
function pushAssistant(state: ChatState, text: string, nextStep?: number) {
  state.messages.push({ role: "assistant", content: text });
  if (typeof nextStep === "number") state.stepIndex = nextStep;
}

// --- Handler ---
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const userMessage = (req.body.userMessage || req.body.message || "").toString().trim();
    const sessionId = (req.body.sessionId || uuidv4()).toString();

    let state = await loadState(sessionId);

    // brand-new session: send ONE intro (no globe/emoji line so voice doesn’t read it weirdly)
    if (state.messages.length === 0) {
      const intro = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      pushAssistant(state, intro, -1); // no step asked yet
      await saveState(state);
      return res.status(200).json({ reply: intro, sessionId, openPortal: false });
    }

    // append user
    if (userMessage) state.messages.push({ role: "user", content: userMessage });

    // -------- Conversation brain  --------
    // If we haven’t asked step 0 yet, handle greetings & ask step 0.
    if (state.stepIndex < 0) {
      let pre = "";
      if (isGreeting(userMessage)) {
        const greet = /good morning/i.test(userMessage) ? "Good morning!" :
                      /good afternoon/i.test(userMessage) ? "Good afternoon!" :
                      /good evening/i.test(userMessage) ? "Good evening!" :
                      "Hi!";
        pre = `${greet} That sounds tough — we’ll take this step by step and ease the pressure. `;
      } else {
        const emp = empathyLine(userMessage);
        if (emp) pre = emp + " ";
      }
      const step0 = script.steps[0];
      const reply = pre + step0.prompt;
      pushAssistant(state, reply, 0);
      await saveState(state);
      return res.status(200).json({ reply, sessionId, openPortal: false });
    }

    // we already asked a step; decide progression using the last asked stepIndex
    let idx = state.stepIndex;
    const current = script.steps[idx] || script.steps[script.steps.length - 1];
    const user = userMessage.toLowerCase();

    // Special handling for name capture at step 0
    if (current.id === 0) {
      const name = extractName(userMessage);
      const hit = anyKeywordHit(user, current.keywords || []) || !!name;
      if (!hit) {
        // gentle steer without moving step
        const steer = "No problem — could I take your name so I can address you properly?";
        pushAssistant(state, steer, idx);
        await saveState(state);
        return res.status(200).json({ reply: steer, sessionId, openPortal: false });
      }
      const displayName = name || cap(userMessage);
      state.displayName = displayName;
      const next = script.steps[idx + 1];
      const reply = `Nice to meet you, ${displayName}. ${next.prompt}`;
      pushAssistant(state, reply, idx + 1);
      await saveState(state);
      return res.status(200).json({ reply, sessionId, displayName, openPortal: false });
    }

    // General step handling: require keyword match (loosely) to progress
    const matched = anyKeywordHit(user, current.keywords || []);

    // Portal consent step: ask but DO NOT open unless explicit yes
    if (current.name === "offer_portal") {
      const yes = /^(y(es)?|ok(ay)?|sure|go ahead|open|start|portal|set up)\b/i.test(userMessage);
      if (!yes) {
        const nudge = "No worries — we can continue questions first. When you’re ready just say “open the portal”.";
        pushAssistant(state, nudge, idx);
        await saveState(state);
        return res.status(200).json({ reply: nudge, sessionId, openPortal: false });
      }
      // explicit consent -> next step prompt AND openPortal=true
      const next = script.steps[idx + 1];
      const reply = next.prompt;
      pushAssistant(state, reply, idx + 1);
      await saveState(state);
      return res.status(200).json({ reply, sessionId, openPortal: true });
    }

    // If user typed "open portal" early, deflect until regulatory done
    if (/open( the)? portal|start portal|set ?up portal/i.test(userMessage) && current.id < 5) {
      const wait = "We’ll open your secure portal right after the regulatory bit — just a moment.";
      pushAssistant(state, wait, idx);
      await saveState(state);
      return res.status(200).json({ reply: wait, sessionId, openPortal: false });
    }

    // If FAQ hint fits and we are NOT at a terminal step, prepend it once but still keep flow forward.
    let prefix = "";
    const hint = faqHint(userMessage);
    if (hint && current.name !== "wrap_up") {
      prefix = hint + " ";
    }

    if (!matched) {
      // empathy steer back to current prompt
      const emp = empathyLine(userMessage);
      const steer = (emp ? emp + " " : "") + current.prompt;
      pushAssistant(state, steer, idx);
      await saveState(state);
      return res.status(200).json({ reply: steer, sessionId, openPortal: false });
    }

    // Progress to next step
    const next = script.steps[idx + 1];
    if (!next) {
      const done = "Thanks — that’s everything from me for now.";
      pushAssistant(state, done, idx);
      await saveState(state);
      return res.status(200).json({ reply: done, sessionId, openPortal: false });
    }

    // Build next reply with empathy (where helpful)
    const emp = empathyLine(userMessage);
    const reply = `${prefix}${emp ? emp + " " : ""}${next.prompt}`;
    pushAssistant(state, reply, idx + 1);
    await saveState(state);

    // Only open portal when we’ve *already* asked offer_portal (id 5) and the user said yes (handled above).
    return res.status(200).json({ reply, sessionId, openPortal: false });

  } catch (e: any) {
    console.error("chat.ts error:", e);
    return res.status(200).json({ reply: "⚠️ I couldn’t reach the server just now.", openPortal: false });
  }
}
