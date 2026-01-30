import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

type Msg = { role: "user" | "bot"; text: string; ts?: string };

type ChatState = {
  step: number;
  name?: string | null;

  askedNameTries?: number;
  lastBotPrompt?: string;

  paying?: number | null;
  affordable?: number | null;

  portalOpened?: boolean;
};

type ScriptStep = {
  id: number;
  name?: string;
  expects?: string;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
};

type ScriptFile = {
  steps: ScriptStep[];
  small_talk?: Record<string, string[]>;
};

type FAQ = { q: string; a: string; keywords?: string[] };
type FAQFile = { faqs: FAQ[] } | FAQ[];

let SCRIPT_CACHE: ScriptFile | null = null;
let FAQ_CACHE: FAQ[] | null = null;

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadScript(): ScriptFile {
  if (SCRIPT_CACHE) return SCRIPT_CACHE;

  const candidates = [
    path.join(process.cwd(), "full_script_logic.json"),
    path.join(process.cwd(), "utils", "full_script_logic.json"),
    path.join(process.cwd(), "data", "full_script_logic.json"),
  ];

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("full_script_logic.json not found in root/utils/data");

  SCRIPT_CACHE = readJson<ScriptFile>(found);
  return SCRIPT_CACHE!;
}

function loadFaqs(): FAQ[] {
  if (FAQ_CACHE) return FAQ_CACHE;

  const candidates = [
    path.join(process.cwd(), "faqs.json"),
    path.join(process.cwd(), "utils", "faqs.json"),
    path.join(process.cwd(), "data", "faqs.json"),
  ];

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    FAQ_CACHE = [];
    return FAQ_CACHE;
  }

  const raw = readJson<FAQFile>(found);
  FAQ_CACHE = Array.isArray(raw) ? raw : raw.faqs || [];
  return FAQ_CACHE!;
}

function stripTags(s: string) {
  // removes accidental debug tags like §SOMETHING
  return (s || "").replace(/\s*§[A-Z0-9_]+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

function capFirst(s: string) {
  const t = (s || "").trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1);
}

function normaliseText(s: string) {
  return (s || "").trim().toLowerCase();
}

function isGreetingOnly(t: string) {
  const x = normaliseText(t);
  return /^(hi|hiya|hello|hey|good morning|good afternoon|good evening|morning|afternoon|evening)[!. ]*$/.test(x);
}

function isHowAreYou(t: string) {
  const x = normaliseText(t);
  return /(how are you|how r u|hru|how you doing|you alright|you ok|how's it going)/.test(x);
}

function isAskTime(t: string) {
  const x = normaliseText(t);
  return /(what('?s| is)? the time|time is it|current time)/.test(x);
}

function isAskJoke(t: string) {
  const x = normaliseText(t);
  return /(tell me a joke|joke|make me laugh|something funny)/.test(x);
}

function pickGreeting(userText: string) {
  // If user says "good morning" but it's afternoon/evening, we reply with actual time-of-day
  const hour = new Date().getHours();
  const tod = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const saidMorning = /good morning|morning/.test(normaliseText(userText));
  const saidAfternoon = /good afternoon|afternoon/.test(normaliseText(userText));
  const saidEvening = /good evening|evening/.test(normaliseText(userText));

  // If they said one that doesn't match, lightly correct
  if ((saidMorning && tod !== "morning") || (saidAfternoon && tod !== "afternoon") || (saidEvening && tod !== "evening")) {
    return `Good ${tod} 😄`;
  }
  // Otherwise mirror them
  if (saidMorning) return "Good morning";
  if (saidAfternoon) return "Good afternoon";
  if (saidEvening) return "Good evening";
  return "Hello";
}

function looksLikeNameCandidate(raw: string) {
  const t = raw.trim();
  if (!t) return false;
  if (t.length > 40) return false;
  if (/\d/.test(t)) return false;
  if (/[<>/\\{}[\]=+_*^%$#@]/.test(t)) return false;
  return true;
}

const BANNED_NAME_WORDS = new Set([
  "shit", "crap", "fuck", "twat", "cunt", "bitch", "asshole", "wanker", "prick", "bollocks", "dick",
  "fuckoff", "fuck off"
]);

function extractName(userText: string): string | null {
  const t = userText.trim();

  // common patterns
  const m =
    t.match(/\b(my name is|i am|i'm|im|call me|this is)\s+([a-zA-Z][a-zA-Z' -]{1,40})\b/i) ||
    t.match(/^\s*([a-zA-Z][a-zA-Z' -]{1,40})\s*$/);

  if (!m) return null;

  const candidate = (m[2] || m[1] || "").trim();
  if (!looksLikeNameCandidate(candidate)) return null;

  // If they gave full name, store first name for friendliness
  const first = candidate.split(/\s+/)[0].trim();
  if (!first) return null;

  const key = normaliseText(first.replace(/[^a-z]/g, ""));
  if (BANNED_NAME_WORDS.has(normaliseText(candidate)) || BANNED_NAME_WORDS.has(key)) return "__BANNED__";

  // allow names like Harshit (contains "shit" substring) by checking whole token only
  return capFirst(first);
}

function moneyFromText(t: string): number | null {
  const x = normaliseText(t).replace(/,/g, "");
  // find £1234 or 1234
  const pound = x.match(/£\s*([0-9]{1,6}(\.[0-9]{1,2})?)/);
  if (pound) return Number(pound[1]);

  const plain = x.match(/\b([0-9]{1,6})(\.[0-9]{1,2})?\b/);
  if (plain) return Number(plain[1]);

  return null;
}

function findFAQAnswer(userText: string): string | null {
  const faqs = loadFaqs();
  if (!faqs.length) return null;

  const x = normaliseText(userText);
  let best: { score: number; a: string } | null = null;

  for (const f of faqs) {
    const keys = (f.keywords || []).map((k) => normaliseText(k));
    let score = 0;

    // keyword scoring
    for (const k of keys) {
      if (k && x.includes(k)) score += 2;
    }

    // question phrase overlap (light)
    const qWords = normaliseText(f.q).split(/\s+/).filter(Boolean);
    for (const w of qWords.slice(0, 10)) {
      if (w.length >= 4 && x.includes(w)) score += 1;
    }

    if (!best || score > best.score) best = { score, a: f.a };
  }

  if (!best || best.score < 3) return null;
  return stripTags(best.a);
}

function rephraseIfRepeated(next: string, prev?: string) {
  const a = stripTags(next);
  const b = stripTags(prev || "");
  if (!b) return a;
  if (normaliseText(a) !== normaliseText(b)) return a;

  // If the exact same prompt would repeat, rephrase slightly
  if (a.toLowerCase().includes("who i’m speaking")) {
    return "Quick one so I can address you properly — what’s your first name?";
  }
  if (a.toLowerCase().includes("main concern")) {
    return "What’s the biggest worry with the debts right now — payments, interest, letters, or something else?";
  }
  if (a.toLowerCase().includes("how much do you pay")) {
    return "Roughly what do you pay in total each month, and what would feel manageable?";
  }
  if (a.toLowerCase().includes("urgent")) {
    return "Anything urgent we need to prioritise today — bailiffs, court letters, or priority bills like council tax?";
  }
  if (a.toLowerCase().includes("open it now")) {
    return "Want me to open your secure portal now, or would you rather keep chatting for a moment?";
  }
  return a;
}

function stepById(script: ScriptFile, id: number) {
  return script.steps.find((s) => s.id === id) || null;
}

function nextStepPrompt(state: ChatState, script: ScriptFile): { prompt: string; step: number } {
  const s = stepById(script, state.step);
  if (!s) {
    const last = script.steps[script.steps.length - 1];
    return { prompt: stripTags(last?.prompt || "How can I help?"), step: last?.id ?? 0 };
  }
  return { prompt: stripTags(s.prompt), step: s.id };
}

function progressStep(state: ChatState) {
  return { ...state, step: Math.min(state.step + 1, 999) };
}

function isYes(t: string) {
  const x = normaliseText(t);
  return /^(yes|yep|yeah|ok|okay|sure|go ahead|please do|do it|open|start|let’s do it|lets do it)\b/.test(x);
}

function isNo(t: string) {
  const x = normaliseText(t);
  return /^(no|nope|not now|later|can we do it later|maybe later|don’t|dont)\b/.test(x);
}

function personalise(text: string, name?: string | null) {
  const cleaned = stripTags(text);
  if (!name) return cleaned;
  // avoid overusing em dashes; keep simple
  return cleaned.replace(/\b(you)\b/i, "you").replace(/\bcan you\b/i, `can you`);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const script = loadScript();
    const { message, state, recent } = req.body as {
      message: string;
      sessionId?: string;
      state?: ChatState;
      recent?: Msg[];
    };

    const userText = (message || "").trim();
    let s: ChatState = {
      step: 0,
      name: null,
      askedNameTries: 0,
      lastBotPrompt: "",
      paying: null,
      affordable: null,
      portalOpened: false,
      ...(state || {}),
    };

    // reset (testing only)
    if (normaliseText(userText) === "reset") {
      const p = stripTags(script.steps[0]?.prompt || "Can you let me know who I’m speaking with?");
      return res.status(200).json({
        reply: p,
        state: { step: 0, name: null, askedNameTries: 0, lastBotPrompt: p, paying: null, affordable: null, portalOpened: false },
      });
    }

    // 1) Human small talk FIRST (do not advance the script on these)
    if (isAskTime(userText)) {
      const t = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      const reply = `It’s ${t}. 😊\n\nNow, so I can help properly — what prompted you to seek help with your debts today?`;
      return res.status(200).json({ reply: stripTags(reply), state: { ...s, lastBotPrompt: stripTags(reply) } });
    }

    if (isAskJoke(userText)) {
      const reply =
        "Quick one 😄\n\nWhy did the credit card break up with the wallet?\nBecause it needed a little more space.\n\nRight — what’s been going on with the debts?";
      return res.status(200).json({ reply: stripTags(reply), state: { ...s, lastBotPrompt: stripTags(reply) } });
    }

    if (isHowAreYou(userText) || isGreetingOnly(userText)) {
      const greet = pickGreeting(userText);
      const reply = `${greet}! I’m good thanks — how are you doing today?\n\nWhen you’re ready, tell me what’s been happening with your debts and we’ll take it step by step.`;
      return res.status(200).json({ reply: stripTags(reply), state: { ...s, lastBotPrompt: stripTags(reply) } });
    }

    // 2) FAQ router (answer, then gently return to script)
    const faq = findFAQAnswer(userText);
    if (faq) {
      // keep it human + continue flow
      const next = nextStepPrompt(s, script).prompt;
      const reply = `${faq}\n\nIf you’re happy, we’ll carry on. ${next}`;
      return res.status(200).json({
        reply: stripTags(reply),
        state: { ...s, lastBotPrompt: stripTags(reply) },
      });
    }

    // 3) Script engine (strict + non-loopy)

    // step 0: ask name
    if (s.step === 0) {
      const name = extractName(userText);

      // user gave a valid name
      if (name && name !== "__BANNED__") {
        s.name = name;
        s.askedNameTries = 0;

        // move to next step
        s = progressStep(s);
        const base = `Nice to meet you, ${name}.`;
        const next = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
        const reply = `${base} ${next}`;
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      // banned/profane “name”
      if (name === "__BANNED__") {
        const tries = (s.askedNameTries || 0) + 1;
        s.askedNameTries = tries;

        if (tries === 1) {
          const reply = "Let’s keep it respectful 🙂 What first name would you like me to use?";
          s.lastBotPrompt = stripTags(reply);
          return res.status(200).json({ reply: stripTags(reply), state: s });
        }

        if (tries === 2) {
          const reply = "No worries — just a first name is perfect (e.g., Sam). What should I call you?";
          s.lastBotPrompt = stripTags(reply);
          return res.status(200).json({ reply: stripTags(reply), state: s });
        }

        // stop looping: continue without a name
        s.name = null;
        s.askedNameTries = tries;
        s = progressStep(s);
        const next = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
        const reply = `No problem — we can carry on for now and you can tell me your name later. ${next}`;
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      // user didn’t give a name (avoid “misheard dinosaur language”)
      const tries = (s.askedNameTries || 0) + 1;
      s.askedNameTries = tries;

      const base =
        tries === 1
          ? "Quick one so I can address you properly — can you let me know your first name?"
          : tries === 2
          ? "Just your first name is perfect (for example: John). What should I call you?"
          : "No worries — when you’re ready, tell me your first name. For now, what’s your main concern with the debts?";

      if (tries >= 3) {
        // stop looping: move on
        s = progressStep(s);
        const reply = `${base}`;
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      s.lastBotPrompt = stripTags(base);
      return res.status(200).json({ reply: stripTags(base), state: s });
    }

    // step 1: concern
    if (s.step === 1) {
      // accept anything as “concern” and move on
      const empathy = "Thanks for sharing — that can feel heavy, but we’ll take it step by step.";
      s = progressStep(s);
      const next = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
      const reply = `${empathy} ${next}`;
      s.lastBotPrompt = stripTags(reply);
      return res.status(200).json({ reply: stripTags(reply), state: s });
    }

    // step 2: amounts (avoid loops by collecting missing piece only)
    if (s.step === 2) {
      const num = moneyFromText(userText);

      // Try to capture both if user wrote two numbers
      const allNums = (normaliseText(userText).replace(/£/g, "").match(/\b\d{1,6}\b/g) || []).map((n) => Number(n));
      if (allNums.length >= 2) {
        s.paying = allNums[0];
        s.affordable = allNums[1];
      } else if (num !== null) {
        // If we don't yet have paying, assume first number is paying, otherwise affordable
        if (!s.paying) s.paying = num;
        else if (!s.affordable) s.affordable = num;
      }

      const missingPaying = !s.paying;
      const missingAffordable = !s.affordable;

      if (missingPaying && missingAffordable) {
        const q = "Roughly what do you pay towards all debts each month, and what would feel affordable?";
        const reply = rephraseIfRepeated(q, s.lastBotPrompt);
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      if (missingAffordable) {
        const q = `Thanks — and what would feel affordable each month? (Example: “£200”)`;
        const reply = rephraseIfRepeated(q, s.lastBotPrompt);
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      // both captured -> move on
      s = progressStep(s);
      const next = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
      const reply = `Got it — thanks. ${next}`;
      s.lastBotPrompt = stripTags(reply);
      return res.status(200).json({ reply: stripTags(reply), state: s });
    }

    // step 3: urgency
    if (s.step === 3) {
      const ack =
        /council tax|rent|gas|electric|water|bailiff|enforcement|ccj|court|default/i.test(userText)
          ? "Thanks — we’ll prioritise anything urgent and protect the essentials first."
          : "Okay — that helps. We’ll keep things calm and structured.";

      s = progressStep(s);
      const next = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
      const reply = `${ack} ${next}`;
      s.lastBotPrompt = stripTags(reply);
      return res.status(200).json({ reply: stripTags(reply), state: s });
    }

    // step 4: acknowledgement (MoneyHelper carry on)
    if (s.step === 4) {
      if (!isYes(userText)) {
        const reply = "No problem — we can pause here. If you’d like to continue later, just message me when you’re ready.";
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }
      s = progressStep(s);
      const next = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
      const reply = `Perfect — let’s carry on. ${next}`;
      s.lastBotPrompt = stripTags(reply);
      return res.status(200).json({ reply: stripTags(reply), state: s });
    }

    // step 5: portal invite (ONLY open on explicit yes)
    if (s.step === 5) {
      if (isNo(userText)) {
        const reply =
          "No worries — we can keep chatting and do the portal later. When you’re ready, just say “open portal” and I’ll bring it up.";
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      if (isYes(userText) || /open portal/i.test(userText)) {
        s.portalOpened = true;
        s = progressStep(s);

        const follow = stepById(script, 6)?.prompt || "While you’re in the portal, I’ll stay here to guide you.";
        const reply =
          "Opening your portal now.\n\n" +
          stripTags(follow) +
          "\n\nYou can come back to the chat any time using the button in the top-right corner.";
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      const p = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
      s.lastBotPrompt = stripTags(p);
      return res.status(200).json({ reply: stripTags(p), state: s });
    }

    // step 6: portal followup (wait for done)
    if (s.step === 6) {
      if (/done|saved|submitted|uploaded|finished|complete/i.test(userText)) {
        s = progressStep(s);
        const next = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
        const reply = `Nice one — thanks. ${next}`;
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      const reply =
        "No rush. Take your time in the portal.\n\nWhen you’ve finished the outstanding tasks, just reply “done” and I’ll continue.";
      s.lastBotPrompt = stripTags(reply);
      return res.status(200).json({ reply: stripTags(reply), state: s });
    }

    // step 7: docs prompt (ack and move)
    if (s.step === 7) {
      // if user uploaded, progress. Otherwise keep them moving.
      if (/uploaded|attached|sent|done/i.test(normaliseText(userText))) {
        s = progressStep(s);
        const next = rephraseIfRepeated(nextStepPrompt(s, script).prompt, s.lastBotPrompt);
        const reply = `Perfect — thanks. ${next}`;
        s.lastBotPrompt = stripTags(reply);
        return res.status(200).json({ reply: stripTags(reply), state: s });
      }

      const reply =
        stripTags(nextStepPrompt(s, script).prompt) +
        "\n\nIf you don’t have everything right now, that’s okay — upload what you can, and we’ll pick up the rest later.";
      s.lastBotPrompt = stripTags(reply);
      return res.status(200).json({ reply: stripTags(reply), state: s });
    }

    // step 8+: wrap up
    const final = stripTags(nextStepPrompt(s, script).prompt);
    s.lastBotPrompt = final;
    return res.status(200).json({ reply: final, state: s });
  } catch (e: any) {
    return res.status(500).json({ error: "chat_failed", detail: e?.message || "unknown" });
  }
}
