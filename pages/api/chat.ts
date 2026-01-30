import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

type Step = {
  id: number;
  name: string;
  expects: string;
  prompt: string;
  keywords?: string[];
  openPortal?: boolean;
};

type Script = {
  small_talk?: { greetings?: string[] };
  steps: Step[];
};

type ApiReq = {
  sessionId?: string;
  userMessage?: string;
  history?: string[]; // array of text strings (bot+user)
  language?: string;
};

type ApiRes = {
  reply: string;
  openPortal?: boolean;
  displayName?: string;
};

function loadScript(): Script {
  const p = path.join(process.cwd(), "data", "full_script_logic.json");
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as Script;
}

const FILLER_ONLY = new Set([
  "ok",
  "okay",
  "k",
  "kk",
  "yes",
  "yep",
  "yeah",
  "ya",
  "sure",
  "alright",
  "fine",
  "cool",
  "thanks",
  "thank you",
  "thx",
  "np",
  "no problem",
  "soz",
  "sorry",
  "lol",
  "haha",
  "hahaha",
  "idk",
  "dont know",
  "don't know",
  "maybe",
  "so",
  "and",
  "&",
]);

const LEADING_FILLER = [
  "yes",
  "yeah",
  "yep",
  "ok",
  "okay",
  "alright",
  "so",
  "and",
  "well",
  "erm",
  "um",
  "uh",
  "right",
];

const NOT_A_NAME = new Set([
  ...LEADING_FILLER,
  "i",
  "im",
  "i'm",
  "me",
  "my",
  "name",
  "is",
  "its",
  "it's",
  "call",
  "called",
  "mr",
  "mrs",
  "ms",
  "miss",
  "mate",
  "bro",
  "bruv",
  "sir",
  "madam",
  "hello",
  "hi",
  "hey",
  "good",
  "morning",
  "afternoon",
  "evening",
]);

function cleanText(s: string) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function isFillerOnly(inputRaw: string) {
  const t = cleanText(inputRaw).toLowerCase();
  if (!t) return true;
  // allow very short but meaningful things like "£200"
  if (/^£?\d+(\.\d+)?$/.test(t)) return false;
  // remove punctuation
  const stripped = t.replace(/[^\w\s£]/g, "").trim();
  if (!stripped) return true;
  if (FILLER_ONLY.has(stripped)) return true;
  // very short generic replies
  if (stripped.length <= 2 && !/^\d+$/.test(stripped)) return true;
  return false;
}

function extractName(userRaw: string): string | null {
  const raw = cleanText(userRaw);
  if (!raw) return null;

  const lower = raw.toLowerCase();

  // Common patterns: "my name is Mark", "I'm Mark", "im Mark", "call me Mark"
  const m =
    raw.match(/(?:my name is|i am|i'm|im|call me|it’s|it's)\s+([A-Za-z][A-Za-z'\-]{1,24})/i) ||
    raw.match(/^([A-Za-z][A-Za-z'\-]{1,24})$/i);

  let candidate: string | null = m ? m[1] : null;

  if (!candidate) {
    // Tokenize and skip leading filler
    const tokens = raw
      .replace(/[^\w\s'\-]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    let i = 0;
    while (i < tokens.length && LEADING_FILLER.includes(tokens[i].toLowerCase())) i++;

    // pick first plausible token
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      const tl = t.toLowerCase();
      if (NOT_A_NAME.has(tl)) continue;
      if (!/^[A-Za-z][A-Za-z'\-]{1,24}$/.test(t)) continue;
      candidate = t;
      break;
    }
  }

  if (!candidate) return null;

  const c = candidate.trim();
  if (!c) return null;
  const cl = c.toLowerCase();
  if (NOT_A_NAME.has(cl)) return null;
  if (c.length < 2) return null;

  // Title-case
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
}

function findLastBotPrompt(history: string[], steps: Step[]) {
  // We can’t see roles here, but your bot prompts are unique.
  // Find the most recent step.prompt present in history.
  const joined = history.join("\n");
  let last: Step | null = null;

  for (const st of steps) {
    if (joined.includes(st.prompt)) last = st;
  }
  return last;
}

function findCapturedName(history: string[]): string | null {
  // Try to find a user-provided name anywhere in history.
  // We scan from newest to oldest.
  for (let i = history.length - 1; i >= 0; i--) {
    const maybe = extractName(history[i]);
    if (maybe) return maybe;
  }
  return null;
}

function isGreeting(msg: string, script: Script) {
  const t = cleanText(msg).toLowerCase();
  const gs = script.small_talk?.greetings || ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"];
  return gs.some((g) => t === g || t.startsWith(g + " "));
}

export default function handler(req: NextApiRequest, res: NextApiResponse<ApiRes>) {
  if (req.method !== "POST") return res.status(405).json({ reply: "Method not allowed." });

  const script = loadScript();
  const body = req.body as ApiReq;

  const userMessage = cleanText(body.userMessage || "");
  const history = Array.isArray(body.history) ? body.history.map((x) => String(x || "")) : [];

  // Hard reset (useful for testing)
  if (userMessage.toLowerCase() === "reset") {
    return res.status(200).json({
      reply: "Reset done. Hello! My name’s Mark. What prompted you to seek help with your debts today?",
    });
  }

  // If we have almost no context, start with Step 2 style: empathy + ask name
  // (Your UI already shows the Step 1 greeting on load.)
  const capturedName = findCapturedName(history.concat(userMessage));
  const hasName = !!capturedName;

  // If user is greeting, answer politely but keep flow moving
  if (isGreeting(userMessage, script) && !hasName) {
    return res.status(200).json({
      reply: "Good to hear from you. I’m doing well, thanks — how are you feeling today? Can you tell me your first name?",
    });
  }

  // === Step control (stateless, derived from prompts + captured fields) ===
  const steps = script.steps || [];
  const lastPromptStep = findLastBotPrompt(history, steps);

  // 1) If we still don’t have a name, we’re in the “name capture” gate.
  if (!hasName) {
    // If user gave filler-only reply, re-ask name clearly with example.
    if (isFillerOnly(userMessage)) {
      return res.status(200).json({
        reply: "No worries — just a first name is perfect (for example: “Mark”). What should I call you?",
      });
    }

    const maybeName = extractName(userMessage);
    if (!maybeName) {
      return res.status(200).json({
        reply: "Thanks — just so I can keep this personal, what first name should I call you?",
      });
    }

    return res.status(200).json({
      reply: `Nice to meet you, ${maybeName}. Just so I can help find you the right solution, what would you say your main concern is with the debts?`,
      displayName: maybeName,
    });
  }

  // 2) We have a name. Prevent filler-only replies from advancing the script.
  if (isFillerOnly(userMessage)) {
    // Decide what to repeat based on last step prompt (best-effort)
    if (lastPromptStep?.prompt) {
      return res.status(200).json({
        reply: `No problem, ${capturedName}. ${lastPromptStep.prompt}`,
        displayName: capturedName || undefined,
      });
    }
    // Default: keep moving forward with “main concern”
    const concernStep = steps.find((s) => s.name === "concern") || steps[1];
    return res.status(200).json({
      reply: `No problem, ${capturedName}. ${concernStep?.prompt || "What would you say your main concern is with the debts?"}`,
      displayName: capturedName || undefined,
    });
  }

  // 3) Progression through your current JSON steps (0..)
  // Map by step name because your UI has Step 1 greeting separately.
  // If we haven’t asked concern yet, do it now.
  const concernPrompt = steps.find((s) => s.name === "concern")?.prompt;
  const hasConcernPrompt = concernPrompt ? history.join("\n").includes(concernPrompt) : false;

  if (!hasConcernPrompt) {
    return res.status(200).json({
      reply: `Thanks, ${capturedName}. ${concernPrompt || "What would you say your main concern is with the debts?"}`,
      displayName: capturedName || undefined,
    });
  }

  // Next: amounts
  const amountsStep = steps.find((s) => s.name === "amounts");
  const hasAmountsPrompt = amountsStep?.prompt ? history.join("\n").includes(amountsStep.prompt) : false;
  if (!hasAmountsPrompt) {
    return res.status(200).json({
      reply: amountsStep?.prompt
        ? `Thanks, ${capturedName}. ${amountsStep.prompt}`
        : `Thanks, ${capturedName}. Roughly how much do you pay towards all debts each month, and what would feel affordable for you?`,
      displayName: capturedName || undefined,
    });
  }

  // Next: urgency
  const urgencyStep = steps.find((s) => s.name === "urgency");
  const hasUrgencyPrompt = urgencyStep?.prompt ? history.join("\n").includes(urgencyStep.prompt) : false;
  if (!hasUrgencyPrompt) {
    return res.status(200).json({
      reply: urgencyStep?.prompt
        ? `Understood, ${capturedName}. ${urgencyStep.prompt}`
        : `Understood, ${capturedName}. Is there anything urgent like enforcement or court letters we should know about?`,
      displayName: capturedName || undefined,
    });
  }

  // Next: acknowledgement / MoneyHelper
  const ackStep = steps.find((s) => s.name === "acknowledgement");
  const hasAckPrompt = ackStep?.prompt ? history.join("\n").includes(ackStep.prompt) : false;
  if (!hasAckPrompt) {
    return res.status(200).json({
      reply: ackStep?.prompt
        ? ackStep.prompt
        : `Before we proceed, there’s no obligation to act on any advice today, and there are free sources of debt advice available at MoneyHelper. Shall we carry on?`,
      displayName: capturedName || undefined,
    });
  }

  // Next: portal invite
  const portalStep = steps.find((s) => s.name === "portal_invite");
  const hasPortalPrompt = portalStep?.prompt ? history.join("\n").includes(portalStep.prompt) : false;
  if (!hasPortalPrompt) {
    return res.status(200).json({
      reply: portalStep?.prompt
        ? portalStep.prompt
        : `Let’s set up your secure Client Portal so you can add details, upload documents, and check progress. Shall I open it now?`,
      openPortal: true,
      displayName: capturedName || undefined,
    });
  }

  // After portal: followup
  const followStep = steps.find((s) => s.name === "portal_followup");
  const hasFollowPrompt = followStep?.prompt ? history.join("\n").includes(followStep.prompt) : false;
  if (!hasFollowPrompt) {
    return res.status(200).json({
      reply: followStep?.prompt
        ? followStep.prompt
        : `While you’re in the portal, I’ll stay here to guide you. Once you’ve saved your details, say “done” and we’ll continue.`,
      displayName: capturedName || undefined,
    });
  }

  // Docs prompt
  const docsStep = steps.find((s) => s.name === "docs_prompt");
  const hasDocsPrompt = docsStep?.prompt ? history.join("\n").includes(docsStep.prompt) : false;
  if (!hasDocsPrompt) {
    return res.status(200).json({
      reply: docsStep?.prompt
        ? docsStep.prompt
        : `To assess the best solution and save you money each month, please upload your key documents (ID, bank statements, payslips if employed, etc.).`,
      displayName: capturedName || undefined,
    });
  }

  // Wrap up
  const wrapStep = steps.find((s) => s.name === "wrap_up") || steps[steps.length - 1];
  return res.status(200).json({
    reply: wrapStep?.prompt || "Is there anything else you’d like to ask before we wrap up?",
    displayName: capturedName || undefined,
  });
}

