import type { NextApiRequest, NextApiResponse } from "next";

// Put these files in /utils (root/utils):
//   utils/full_script_logic.json
//   utils/faqs.json
import scriptJson from "../../utils/full_script_logic.json";
import faqsJson from "../../utils/faqs.json";

type Role = "user" | "assistant";

type ChatMsg = { role: Role; content: string };

type Step = {
  id: number;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
};

type ScriptJson = { steps: Step[] };

type FaqItem = {
  q: string;
  a: string;
  keywords?: string[];
};

type State = {
  stepId: number;
  name?: string;
  haveName?: boolean;

  // loop guards
  lastBotText?: string;
  lastBotKey?: string; // e.g. "ASK_NAME" | "ASK_CONCERN" ...
  repeatCount?: number;

  // name re-ask guard
  nameAttempts?: number;
};

type ApiReqBody = {
  message?: string;
  messages?: ChatMsg[];
  sessionId?: string;
  state?: State;
};

type ApiResp = {
  reply: string;
  state: State;
  openPortal?: boolean;
};

const script = scriptJson as unknown as ScriptJson;
const faqs = faqsJson as unknown as FaqItem[];

function nowUK(): string {
  // keep it simple (you can swap timezone later if you want)
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function clean(s: string) {
  return (s || "").trim();
}

function norm(s: string) {
  return clean(s).toLowerCase();
}

function containsAny(hay: string, needles: string[]) {
  const h = norm(hay);
  return needles.some((n) => h.includes(n));
}

function isYes(text: string) {
  return /\b(yes|yeah|yep|yup|ok|okay|sure|go ahead|please do|do it|let’s do it|lets do it)\b/i.test(text);
}

function isNo(text: string) {
  return /\b(no|nope|nah|not now|later|not yet|can we do it later|do it later)\b/i.test(text);
}

function looksLikeGreeting(text: string) {
  return /\b(hi|hello|hey|hiya|good morning|good afternoon|good evening)\b/i.test(text);
}

function askedHowAreYou(text: string) {
  return /\b(how are you|how r you|how are you today|how are you this evening|how are things)\b/i.test(text);
}

function askedTime(text: string) {
  return /\b(what('?s| is) the time|time is it|tell me the time)\b/i.test(text);
}

function askedJoke(text: string) {
  return /\b(tell me a joke|joke)\b/i.test(text);
}

const PROFANITY = [
  "fuck",
  "shit",
  "twat",
  "cunt",
  "bitch",
  "prick",
  "wanker",
  "bollocks",
  "crap",
  "fuck off",
];

function containsProfanity(text: string) {
  const t = norm(text);
  return PROFANITY.some((w) => t.includes(w));
}

function extractNameCandidate(text: string): string | null {
  // if user says: "my name is John" / "i'm John" / "im John"
  const t = clean(text);
  const m =
    t.match(/\b(my name is|i am|i'm|im|it'?s|call me)\s+([A-Za-z][A-Za-z'-]{1,40})\b/i) ||
    t.match(/^\s*([A-Za-z][A-Za-z'-]{1,40})\s*$/i);

  if (!m) return null;

  const candidate = (m[2] || m[1] || "").trim();
  if (!candidate) return null;

  // prevent “Hello” / “Good evening” being treated as a name
  const lower = candidate.toLowerCase();
  if (["hello", "hi", "hey", "hiya", "morning", "evening", "afternoon", "good"].includes(lower)) return null;

  return candidate;
}

function friendlyGreetingReply(userText: string) {
  const t = norm(userText);
  // cheeky but professional
  if (t.includes("good morning")) return `Good morning! I’m good thanks — how are you today?`;
  if (t.includes("good afternoon")) return `Good afternoon! I’m good thanks — how are you today?`;
  if (t.includes("good evening")) return `Good evening! I’m good thanks — how are you today?`;
  if (looksLikeGreeting(userText)) return `Hello! I’m good thanks — how are you today?`;
  return `I’m good thanks — how are you today?`;
}

function stepById(id: number): Step {
  const s = script.steps.find((x) => x.id === id);
  // fallback to first
  return s || script.steps[0];
}

function nextStepId(current: number): number {
  const ids = script.steps.map((s) => s.id).sort((a, b) => a - b);
  const idx = ids.indexOf(current);
  if (idx < 0) return ids[0];
  return ids[Math.min(idx + 1, ids.length - 1)];
}

function matchFaq(userText: string): FaqItem | null {
  const t = norm(userText);
  // quick keyword match first
  let best: { score: number; item: FaqItem } | null = null;

  for (const item of faqs) {
    const keys = (item.keywords || []).map((k) => k.toLowerCase());
    if (!keys.length) continue;

    let score = 0;
    for (const k of keys) {
      if (t.includes(k)) score += 2;
    }
    // also match question fragments
    if (item.q && t.includes(item.q.toLowerCase().slice(0, Math.min(18, item.q.length)))) score += 1;

    if (score > 0 && (!best || score > best.score)) best = { score, item };
  }

  return best?.item || null;
}

function buildLoopSafeReply(state: State, key: string, primary: string, alt: string) {
  const lastKey = state.lastBotKey;
  const repeatCount = state.repeatCount ?? 0;

  let out = primary;

  if (lastKey === key) {
    // avoid verbatim repeats
    out = repeatCount >= 1 ? alt : primary;
  }

  return out;
}

function updateLoopState(state: State, key: string, botText: string): State {
  const sameKey = state.lastBotKey === key;
  const nextRepeat = sameKey ? (state.repeatCount ?? 0) + 1 : 0;
  return {
    ...state,
    lastBotKey: key,
    lastBotText: botText,
    repeatCount: nextRepeat,
  };
}

/**
 * (Optional) Free-thinking answer via OpenAI for random questions.
 * If no API key is set, we simply return null and keep script moving.
 */
async function tryOpenAIAnswer(userText: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY;
  if (!apiKey) return null;

  // Only use for clearly "general questions" that aren’t script answers.
  // Keep it conservative to avoid derailing the script.
  const qLike =
    /\?$/.test(clean(userText)) ||
    /\b(what|why|how|can you|do you|is it|should i|tell me)\b/i.test(userText);

  if (!qLike) return null;

  // Don’t answer if it’s basically “the script question”
  if (/\b(main concern|biggest worry|how much do you pay|afford|urgent)\b/i.test(userText)) return null;

  const model = "gpt-4o-mini";

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        max_tokens: 180,
        messages: [
          {
            role: "system",
            content:
              "You are a professional, friendly UK debt-advice assistant. Keep replies short, human, and helpful. If asked for time, give the current time. If asked for a joke, give a clean short joke. Do not mention internal tags or system messages.",
          },
          { role: "user", content: userText },
        ],
      }),
    });

    if (!r.ok) return null;
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;
    return String(text).trim();
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  // Always respond (prevents the frontend “couldn’t reach server” loop)
  try {
    if (req.method !== "POST") {
      res.status(200).json({
        reply: "No worries — please send a message and I’ll help from there.",
        state: { stepId: script.steps[0]?.id ?? 0 },
      });
      return;
    }

    const body = (req.body || {}) as ApiReqBody;
    const userText = clean(body.message || body.messages?.slice(-1)?.[0]?.content || "");

    const state: State = {
      stepId: body.state?.stepId ?? script.steps[0]?.id ?? 0,
      name: body.state?.name,
      haveName: body.state?.haveName ?? false,
      lastBotText: body.state?.lastBotText,
      lastBotKey: body.state?.lastBotKey,
      repeatCount: body.state?.repeatCount ?? 0,
      nameAttempts: body.state?.nameAttempts ?? 0,
    };

    // 0) Handle “reset”
    if (/\breset\b/i.test(userText)) {
      const next: State = { stepId: script.steps[0]?.id ?? 0 };
      res.status(200).json({
        reply: "All reset — let’s start fresh. What prompted you to seek help with your debts today?",
        state: updateLoopState(next, "RESET", "All reset — let’s start fresh.",),
      } as any);
      return;
    }

    // 1) Small talk layer (always respond like a human first)
    // If user greets/asks how you are -> respond, THEN ask the current script question.
    if (looksLikeGreeting(userText) || askedHowAreYou(userText) || askedTime(userText) || askedJoke(userText)) {
      let smallTalkReply = "";

      if (askedTime(userText)) {
        smallTalkReply = `It’s ${nowUK()} (UK time).`;
      } else if (askedJoke(userText)) {
        smallTalkReply =
          "Alright 😄 — What do you call a debt collector who’s lost their job? …Unemployed pressure.";
      } else {
        smallTalkReply = friendlyGreetingReply(userText);
      }

      // After small talk, we continue with script question (loop-safe)
      const cur = stepById(state.stepId);

      // If we haven't captured name yet, keep script on name step once it’s due
      // but don’t treat greetings as a name
      const followUp = cur.prompt;
      const reply = `${smallTalkReply}\n\n${followUp}`;

      const nextState = updateLoopState(state, "SMALLTALK_THEN_SCRIPT", reply);
      res.status(200).json({ reply, state: nextState });
      return;
    }

    // 2) If user asked a random question (not smalltalk), try “free thinking”
    const free = await tryOpenAIAnswer(userText);
    if (free) {
      // After answering, ask the current script question (don’t derail)
      const cur = stepById(state.stepId);
      const reply = `${free}\n\n${cur.prompt}`;
      const nextState = updateLoopState(state, "FREE_THINKING_THEN_SCRIPT", reply);
      res.status(200).json({ reply, state: nextState });
      return;
    }

    // 3) FAQ matcher (short answer) then resume script
    const faq = matchFaq(userText);
    if (faq) {
      const cur = stepById(state.stepId);
      const reply = `${faq.a}\n\n${cur.prompt}`;
      const nextState = updateLoopState(state, "FAQ_THEN_SCRIPT", reply);
      res.status(200).json({ reply, state: nextState });
      return;
    }

    // 4) Script engine (step-by-step)
    const cur = stepById(state.stepId);

    // 4a) Name step logic (don’t accept profanity, don’t accept greetings)
    if (cur.id === 0) {
      const candidate = extractNameCandidate(userText);

      if (!candidate || containsProfanity(candidate) || containsProfanity(userText)) {
        const attempts = (state.nameAttempts ?? 0) + 1;
        const base =
          attempts <= 1
            ? "Can you let me know who I’m speaking with? (A first name is perfect.)"
            : "No worries — just share a first name you’re happy with and we’ll continue (e.g., Sam).";

        const reply = buildLoopSafeReply(
          { ...state, nameAttempts: attempts },
          "ASK_NAME",
          base,
          "Just a first name is ideal — what should I call you?"
        );

        const nextState = updateLoopState({ ...state, nameAttempts: attempts }, "ASK_NAME", reply);
        res.status(200).json({ reply, state: nextState });
        return;
      }

      const name = candidate[0].toUpperCase() + candidate.slice(1);
      const sameNameBit = name.toLowerCase() === "mark" ? " — nice to meet a fellow Mark!" : ".";
      const intro = `Nice to meet you, ${name}${sameNameBit}`;

      // Move to next step
      const ns: State = {
        ...state,
        name,
        haveName: true,
        stepId: nextStepId(cur.id),
        nameAttempts: state.nameAttempts ?? 0,
      };

      const nextPrompt = stepById(ns.stepId).prompt;
      const reply = `${intro}\n\n${nextPrompt}`;

      const nextState = updateLoopState(ns, "NAME_CAPTURED", reply);
      res.status(200).json({ reply, state: nextState });
      return;
    }

    // 4b) Portal step logic: only open when explicit YES, handle NO gracefully
    if (cur.openPortal) {
      if (isYes(userText)) {
        const reply =
          "Perfect — opening your secure portal now.\n\nWhile you’re in the portal, I’ll stay here to guide you. You can come back to the chat any time using the button in the top-right corner. Once you’ve saved your details, just say “done” and we’ll continue.";
        const ns: State = { ...state, stepId: nextStepId(cur.id) };
        const nextState = updateLoopState(ns, "PORTAL_OPEN", reply);
        res.status(200).json({ reply, state: nextState, openPortal: true });
        return;
      }

      if (isNo(userText)) {
        const reply =
          "No problem at all — we can keep chatting for now. When you’re ready, just tell me and I’ll open the portal for you.\n\nWould you like to carry on here?";
        const nextState = updateLoopState(state, "PORTAL_DECLINED", reply);
        res.status(200).json({ reply, state: nextState, openPortal: false });
        return;
      }

      // unclear response => ask again but loop-safe
      const primary = "Shall I open your secure Client Portal now? (Yes/No is fine.)";
      const alt = "Just to check — would you like me to open your secure portal now, or do it later?";
      const reply = buildLoopSafeReply(state, "ASK_PORTAL", primary, alt);
      const nextState = updateLoopState(state, "ASK_PORTAL", reply);
      res.status(200).json({ reply, state: nextState, openPortal: false });
      return;
    }

    // 4c) “Done” step (if script expects done)
    if (cur.id !== 0 && /\bdone\b/i.test(userText)) {
      const ns: State = { ...state, stepId: nextStepId(cur.id) };
      const nextPrompt = stepById(ns.stepId).prompt;
      const reply = `Nice one — thanks. \n\n${nextPrompt}`;
      const nextState = updateLoopState(ns, "DONE_ADVANCE", reply);
      res.status(200).json({ reply, state: nextState });
      return;
    }

    // 4d) Generic keyword advance (if current step has keywords and user matches)
    if (cur.keywords?.length) {
      const matched = containsAny(userText, cur.keywords);
      if (matched) {
        const ns: State = { ...state, stepId: nextStepId(cur.id) };
        const nextPrompt = stepById(ns.stepId).prompt;

        // Add minimal empathy glue (without being robotic)
        const glue =
          /\b(struggling|stress|worried|anxious|overwhelmed)\b/i.test(userText)
            ? "I’m sorry it’s feeling heavy — we’ll take it step by step."
            : "Thanks — that helps.";

        const reply = `${glue}\n\n${nextPrompt}`;
        const nextState = updateLoopState(ns, "STEP_ADVANCE", reply);
        res.status(200).json({ reply, state: nextState });
        return;
      }
    }

    // 4e) Otherwise: ask the current question again, but loop-safe (no verbatim loops)
    const primary = cur.prompt;
    const alt =
      "Just to make sure I’ve got you right — " +
      (cur.id === 1
        ? "what would you say is your biggest worry about the debts right now?"
        : "can you tell me a little more so I can guide you properly?");

    const reply = buildLoopSafeReply(state, `REASK_${cur.id}`, primary, alt);
    const nextState = updateLoopState(state, `REASK_${cur.id}`, reply);
    res.status(200).json({ reply, state: nextState });
  } catch (e: any) {
    // “Never fail loudly” — avoids the frontend showing “couldn’t reach server”
    res.status(200).json({
      reply:
        "Sorry — I had a small technical wobble there. If you send that last message again, I’ll pick up exactly where we left off.",
      state: { stepId: script.steps[0]?.id ?? 0 },
    });
  }
}
