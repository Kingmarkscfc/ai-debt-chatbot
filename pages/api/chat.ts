// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import script from "../../utils/full_script_logic.json";

type Role = "user" | "assistant";
type ChatMsg = { role: Role; content: string };
type Step = { id: string; prompt: string; keywords?: string[]; next?: string | null; yesNext?: string | null; noNext?: string | null; };
type Script = { steps: Step[]; endId: string };

const BOT_NAME = "Mark";
const INTRO_ID = "intro";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_ANON_KEY || "");

function norm(s: string) { return (s || "").toLowerCase().trim(); }
function stepMap(s: Script) { const m = new Map<string, Step>(); s.steps.forEach(st => m.set(st.id, st)); return m; }
function lastAskedStepId(history: ChatMsg[], s: Script): string | null {
  const prompts = new Map(s.steps.map(st => [st.prompt, st.id]));
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant" && typeof m.content === "string") {
      const id = prompts.get(m.content);
      if (id) return id;
    }
  }
  return null;
}
function matchedKeywords(user: string, expected: string[] = []) {
  if (!expected?.length) return true;
  const u = norm(user);
  return expected.some(k => u.includes(k.toLowerCase()));
}
function isEmojiOnly(msg: string) {
  const t = msg.trim();
  return /^([🙂🙁✅❌]|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|👍)$/.test(t);
}
function quickEmojiReply(msg: string) {
  switch (msg.trim()) {
    case "🙂": return "Noted — shall we continue?";
    case "🙁": return "I hear you — we’ll take it step by step.";
    case "✅": return "Great — marking that as done.";
    case "❌": return "No problem — we can revisit that later.";
    default: if (/^👍/.test(msg)) return "👍 Thanks — moving on."; return "Got it.";
  }
}
function extractName(s: string) {
  const t = s.trim();
  const m = t.match(/^([A-Za-z][A-Za-z' -]{1,30})/);
  return m ? m[1].trim() : t.split(" ")[0]?.trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const sessionId = (req.body.sessionId || "").toString() || uuidv4();
  const userMessage = (req.body.userMessage || req.body.message || "").toString().trim();
  const s = script as Script;
  const map = stepMap(s);

  try {
    const { data: row } = await supabase
      .from("chat_history")
      .select("messages, display_name, profile")
      .eq("session_id", sessionId)
      .single();

    let history: ChatMsg[] = (row?.messages as ChatMsg[]) || [];
    let displayName: string | undefined = row?.display_name || undefined;
    let profile: any = row?.profile || {}; // we’ll store { employment: "employed" | "self" | "benefits" }

    // New session → emit intro
    if (!history.length) {
      const intro = map.get(INTRO_ID)?.prompt || `Hello! My name’s ${BOT_NAME}. What prompted you to seek help with your debts today?`;
      history = [{ role: "assistant", content: intro }];
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history, display_name: displayName, profile });
      return res.status(200).json({ ok: true, reply: intro, sessionId, stepId: INTRO_ID });
    }

    if (!userMessage) return res.status(400).json({ ok: false, reply: "Invalid message." });

    history.push({ role: "user", content: userMessage });

    // Emoji fast-path
    if (isEmojiOnly(userMessage)) {
      const r = quickEmojiReply(userMessage);
      history.push({ role: "assistant", content: r });
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history, display_name: displayName, profile });
      return res.status(200).json({ ok: true, reply: r, sessionId });
    }

    // Capture name after ask_name
    const lastId = lastAskedStepId(history, s) || INTRO_ID;
    if (lastId === "ask_name" && !displayName) {
      const name = extractName(userMessage);
      if (name) displayName = name;
    }

    // Simple yes/no intent
    const u = norm(userMessage);
    const saidYes = /\b(yes|yeah|yep|ok|sure|correct|continue|proceed)\b/.test(u);
    const saidNo = /\b(no|nope|nah|stop|don\'t|do not)\b/.test(u);

    // Capture employment on that step
    if (lastId === "employment_status") {
      if (/\bself\b|\bself-?employ/.test(u)) profile.employment = "self";
      else if (/\bemploy/.test(u)) profile.employment = "employed";
      else if (/\bbenefit|\bunemploy|\bpension|\bretired|\bmixed|\bboth/.test(u)) profile.employment = "benefits";
      else profile.employment = "other";
    }

    // Decide next step (includes keyword matches)
    const current = map.get(lastId) || map.get(INTRO_ID)!;
    let nextId: string | null = null;

    if (saidYes && current.yesNext) nextId = current.yesNext;
    else if (saidNo && current.noNext) nextId = current.noNext;
    else if (lastId === "docs_router") {
      // Route based on profile.employment
      const emp = profile.employment || "employed";
      nextId = emp === "self" ? "docs_self"
        : emp === "benefits" ? "docs_benefits_or_other"
        : "docs_employed";
    } else if (matchedKeywords(userMessage, current.keywords)) {
      nextId = current.next || s.endId;
    } else if (/\b(continue|next)\b/.test(u)) {
      nextId = current.next || s.endId;
    }

    if (!nextId) {
      // brief nudge (no loops)
      const sys = `You are ${BOT_NAME}, a professional UK debt advisor. Gently steer back to the current question in one short British English sentence.`;
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: `Current question: "${current.prompt}". User said: "${userMessage}". Reply briefly and steer back.` }
          ]
        });
        const r = completion.choices[0]?.message?.content?.trim()
          || "All good — could you answer that last question so I can advise properly?";
        history.push({ role: "assistant", content: r });
        await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history, display_name: displayName, profile });
        return res.status(200).json({ ok: true, reply: r, sessionId });
      } catch {
        const r = "No worries — could you answer that last question so I can advise properly?";
        history.push({ role: "assistant", content: r });
        await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history, display_name: displayName, profile });
        return res.status(200).json({ ok: true, reply: r, sessionId });
      }
    }

    if (nextId === s.endId) {
      const r = map.get(s.endId)?.prompt || "Thanks — that’s everything I need for now.";
      history.push({ role: "assistant", content: r });
      await supabase.from("chat_history").upsert({ session_id: sessionId, messages: history, display_name: displayName, profile });
      return res.status(200).json({ ok: true, reply: r, sessionId, done: true });
    }

    // personalise {name}
    let nextPrompt = (map.get(nextId)?.prompt || "").replace("{name}", displayName || "there");
    if (!nextPrompt) nextPrompt = map.get(INTRO_ID)?.prompt || "";

    // open portal only when we hit portal_login
    const openPortal = (nextId === "portal_login");

    // avoid repeating the same assistant line
    const lastA = [...history].reverse().find(m => m.role === "assistant");
    if (!lastA || lastA.content !== nextPrompt) history.push({ role: "assistant", content: nextPrompt });

    await supabase.from("chat_history").upsert({
      session_id: sessionId,
      messages: history,
      display_name: displayName,
      profile
    });

    return res.status(200).json({ ok: true, reply: nextPrompt, sessionId, stepId: nextId, openPortal, displayName });
  } catch (err: any) {
    console.error("❌ chat.ts error:", err?.message || err);
    return res.status(500).json({ ok: false, reply: "Sorry, something went wrong on my end. Please try again." });
  }
}
