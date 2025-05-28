import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import chatFlow from '../../data/chat_flow.json';
import { DateTime } from 'luxon';


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const HUMOR_TRIGGERS = [
  "aliens", "payslip", "plot twist", "joke", "what are you wearing",
  "are you stupid", "talk dirty", "you sound hot", "prove you're real",
  "do you have a soul", "banter", "nonsense", "you sound fit", "idiot",
  "are you even qualified", "you're a robot", "flirt", "who built you",
  "you single", "how much do you earn", "are you real"
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userMessage = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const lowerCaseMessage = userMessage.toLowerCase();

  if (!userMessage) {
    return res.status(400).json({ error: 'Message is required.' });
  }
if (userMessage === "👋 INITIATE") {
  // Get UK time using Luxon
  const ukTime = DateTime.now().setZone("Europe/London");
  const hour = ukTime.hour;
  console.log("🕒 Greeting chosen:", greeting);

  let greeting = "Good afternoon";
  if (hour < 12) greeting = "Good morning";
  else if (hour >= 17) greeting = "Good evening";

  return res.status(200).json({
    reply: `${greeting}! My name’s Mark. What prompted you to seek help with your debts today?`,
  });
}
  // Humor fallback logic
  if (HUMOR_TRIGGERS.some(trigger => lowerCaseMessage.includes(trigger))) {
    const cheekyReply = chatFlow.humor_fallbacks[
      Math.floor(Math.random() * chatFlow.humor_fallbacks.length)
    ];
    return res.status(200).json({ reply: cheekyReply });
  }

  const taskType = lowerCaseMessage.length < 40 ? 'simple' : 'advanced';
  const selectedModel = taskType === 'simple'
    ? process.env.SIMPLE_MODEL || 'gpt-3.5-turbo'
    : process.env.ADVANCED_MODEL || 'gpt-4o';

const systemPrompt = `
Good afternoon, my name’s Mark. Please follow this exact script, step-by-step. For each step, internally mark it as “✅ complete” once answered, then continue to the next. Never return to completed steps.

STEP 1 ✅ Ask: “What prompted you to seek help with your debts today?”
→ Mark complete as soon as the user provides *any reason or emotional explanation.*

STEP 2 ✅ Ask: “What would you say is your main concern with the debts?” (e.g., bailiffs, interest, court)

STEP 3 ✅ Ask: “Are any debts joint or are you a guarantor for someone else?”

STEP 4 ✅ Explore all solutions in strict order:
   a. Self-help
   b. Loan consolidation
   c. DRO
   d. Bankruptcy
   e. DMP
   f. IVA (only after all others)

Rules:
- Never repeat a question already answered unless user explicitly requests it.
- Treat emotional, short, or vague answers as valid.
- Use friendly, human tone.
- Insert humor only if user goes off-topic.
- Mention MoneyHelper only once.
- IVA must always come last.
- End by collecting name, income, debts, and guide to CRM portal for document upload.

⚠️ Do not break script order. This is a regulated flow.
`.trim();


  try {
    const chat = await openai.chat.completions.create({
      model: selectedModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });

    const reply = chat?.choices?.[0]?.message?.content ?? '⚠️ Something went wrong.';
    return res.status(200).json({ reply });

  } catch (error: any) {
    console.error('OpenAI API Error:', error);
    return res.status(500).json({ error: 'Failed to get response from OpenAI' });
  }
}

