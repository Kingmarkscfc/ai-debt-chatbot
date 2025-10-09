import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

// ---------- Supabase (service role if available) ----------
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "") as string
);

// ---------- Types ----------
type Step = { id: number; name: string; prompt: string; expects: string; keywords?: string[]; openPortal?: boolean };
type Script = {
  steps: Step[];
  greetings: string[];
  empathy: { re: string; reply: string }[];
  faqHints: { kw: string[]; a: string }[];
};

type MsgRow = { role: "user" | "assistant"; content: string };

// Import script JSON
import scriptJson from "../../utils/full_script_logic.json";
const script = scriptJson as unknown as Script;

// ---------- Helpers ----------
function isGreeting(s: string) {
  const t = s.trim().toLowerCase();
  return script.greetings.some((g) => t.startsWith(g));
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
    if (f.kw.some((k) => t.includes(k))) return f.a;
  }
  return null;
}
function anyKeywordHit(s: string, kws: string[] = []) {
  if (!kws?.length) return true;
  const t = s.toLowerCase();
  return kws.some((k) => t.includes(k.toLowerCase()));
}
function cap(x: string) {
  return x
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}
function extractName(s: string): string | null {
  // “my name is … / i’m … / im … / it’s … / call me …”
  const m = s.match(/\b(my name is|i am|i'm|im|it'?s|call me)\s+([a-z][a-z'\- ]{1,60})/i);
  if (m) return cap(m[2].trim());
  const single = s.trim();
  if (/^[a-z][a-z'\- ]{1,60}$/i.test(single) && single.split(" ").length <= 3) return cap(single);
  return null;
}

// Infer which step we last asked by looking for the last assistant message
// that contains a step prompt (exact substring match).
function inferStepIndex(history: MsgRow[]): number {
  let last = -1;
  for (const m of history) {
    if (m.role !== "assistant") continue;
    for (const st of script.steps) {
      if (m.content.includes(st.prompt)) {
        if (st.id > last) last = st.id;
      }
    }
  }
  return last;
}

// ---------- Persistence using your existing `messages` table ----------
async function fetchHistory(sessionId: string): Promise<MsgRow[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("fetchHistory error:", error);
    return [];
  }
  return (data as any[])?.map((r) => ({ role: r.role, content: r.content })) || [];
}
async function pushMessage(sessionId: string, role: "user" | "assistant", content: string) {
  const { error } = await supabase.from("messages").insert({ session_id: sessionId, role, content });
  if (error) console.error("pushMessage error:", error);
}

// ---------- Main handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const sessionId = ((req.body.sessionId as string) || uuidv4()).toString();
    const userMessage = ((req.body.userMessage as string) || "").toString().trim();
    const language = (req.body.language as string) || "English";

    // Load conversation so far
    let history = await fetchHistory(sessionId);

    // First-time: send ONE intro and store it; no “globe” line so TTS doesn’t read weird things
    if (history.length === 0) {
      const intro = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
      await pushMessage(sessionId, "assistant", intro);
      return res.status(200).json({ reply: intro, sessionId, openPortal: false, language });
    }

    // Append user input
    if (userMessage) await pushMessage(sessionId, "user", userMessage);
    history = await fetchHistory(sessionId); // refresh

    // Figure out where we are in the script
    let stepIdx = inferStepIndex(history); // -1 means we haven't asked step 0 yet

    // If we haven’t asked step 0 yet, do greeting/emp, then ask step 0 once.
    if (stepIdx < 0) {
      let pre = "";
      if (isGreeting(userMessage)) {
        const greet =
          /good morning/i.test(userMessage) ? "Good morning!" :
          /good afternoon/i.test(userMessage) ? "Good afternoon!" :
          /good evening/i.test(userMessage) ? "Good evening!" : "Hi!";
        pre = `${greet} That sounds tough — we’ll take this step by step and ease the pressure. `;
      } else {
        const emp = empathyLine(userMessage);
        if (emp) pre = emp + " ";
      }
      const step0 = script.steps[0];
      const reply = pre + step0.prompt;
      await pushMessage(sessionId, "assistant", reply);
      return res.status(200).json({ reply, sessionId, openPortal: false, language });
    }

    // We already asked a step; route by the last asked step
    const current = script.steps.find((s) => s.id === stepIdx) || script.steps[script.steps.length - 1];

    // Special case: name capture at step 0
    if (current.id === 0) {
      const name = extractName(userMessage);
      const hit = anyKeywordHit(userMessage, current.keywords || []) || !!name;
      if (!hit) {
        const steer = "No problem — could I take your name so I can address you properly?";
        await pushMessage(sessionId, "assistant", steer);
        return res.status(200).json({ reply: steer, sessionId, openPortal: false, language });
      }
      const displayName = name || cap(userMessage);
      const next = script.steps[stepIdx + 1];
      const reply = `Nice to meet you, ${displayName}. ${next.prompt}`;
      await pushMessage(sessionId, "assistant", reply);
      return res.status(200).json({ reply, sessionId, displayName, openPortal: false, language });
    }

    // If the user tries to “open portal” too early, deflect until after regulatory (id 4)
    if (/open( the)? portal|start portal|set ?up portal/i.test(userMessage) && stepIdx < 5) {
      const wait = "We’ll open your secure portal right after the regulatory bit — just a moment.";
      await pushMessage(sessionId, "assistant", wait);
      return res.status(200).json({ reply: wait, sessionId, openPortal: false, language });
    }

    // FAQ nudge (short), only as a prefix
    let prefix = "";
    const hint = faqHint(userMessage);
    if (hint && current.name !== "wrap_up") prefix = hint + " ";

    // Progression check for general steps
    const matched = anyKeywordHit(userMessage, current.keywords || []);

    // Offer-portal step (id 5): DO NOT open unless explicit yes
    if (current.name === "offer_portal") {
      const yes = /^(y(es)?|ok(ay)?|sure|go ahead|open|start|portal|set ?up)\b/i.test(userMessage);
      if (!yes) {
        const nudge = "No worries — we can continue questions first. When you’re ready just say “open the portal”.";
        await pushMessage(sessionId, "assistant", nudge);
        return res.status(200).json({ reply: nudge, sessionId, openPortal: false, language });
      }
      // Explicit consent → move to next step AND open the portal
      const next = script.steps[stepIdx + 1];
      const reply = next ? next.prompt : "Opening your portal now.";
      await pushMessage(sessionId, "assistant", reply);
      return res.status(200).json({ reply, sessionId, openPortal: true, language });
    }

    // If current answer doesn’t match, empathise + restate current prompt (no loop advancement)
    if (!matched) {
      const emp = empathyLine(userMessage);
      const steer = (emp ? emp + " " : "") + current.prompt;
      await pushMessage(sessionId, "assistant", steer);
      return res.status(200).json({ reply: steer, sessionId, openPortal: false, language });
    }

    // Otherwise, advance to next step
    const next = script.steps[stepIdx + 1];
    if (!next) {
      const done = "Thanks — that’s everything from me for now.";
      await pushMessage(sessionId, "assistant", done);
      return res.status(200).json({ reply: done, sessionId, openPortal: false, language });
    }

    const emp = empathyLine(userMessage);
    const reply = `${prefix}${emp ? emp + " " : ""}${next.prompt}`;
    await pushMessage(sessionId, "assistant", reply);
    return res.status(200).json({ reply, sessionId, openPortal: false, language });
  } catch (e: any) {
    console.error("chat.ts error:", e);
    return res.status(200).json({ reply: "⚠️ I couldn’t reach the server just now.", openPortal: false });
  }
}
