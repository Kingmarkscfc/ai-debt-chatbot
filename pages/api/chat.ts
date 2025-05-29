import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import chatFlow from '../../data/chat_flow.json';

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

  // 👋 Auto-greet logic
  if (userMessage === "👋 INITIATE") {
    return res.status(200).json({
      reply: "Hello! My name’s Mark. What prompted you to seek help with your debts today?",
    });
  }

  // 💬 Humor triggers
  if (HUMOR_TRIGGERS.some(trigger => lowerCaseMessage.includes(trigger))) {
    const cheekyReply = chatFlow.humor_fallbacks[
      Math.floor(Math.random() * chatFlow.humor_fallbacks.length)
    ];
    return res.status(200).json({ reply: cheekyReply });
  }

  // 🤖 Choose model
  const selectedModel =
    userMessage.length < 40
      ? process.env.SIMPLE_MODEL || 'gpt-3.5-turbo'
      : process.env.ADVANCED_MODEL || 'gpt-4o';

  const systemPrompt = `
You are a friendly, knowledgeable debt advisor bot named Mark. Follow this script in strict order:

1. Ask: “What prompted you to seek help with your debts today?”
2. Then ask: “What would you say is your main concern with the debts?” (e.g. bailiffs, interest, court)
3. Then: “Are any debts joint or are you a guarantor for someone else?”
4. Then go through these options in this **exact** order:
   a. Self-help
   b. Loan consolidation
   c. DRO
   d. Bankruptcy
   e. DMP
   f. IVA (only after all others)

Rules:
- Do **not** repeat a step once answered.
- Do **not** go off-script or offer unscripted advice.
- Use friendly tone. Add humor **only** if user goes off-topic.
- Explain each debt solution clearly before moving to the next.
- Only mention IVA **after** all others are fully explained.
- Mention MoneyHelper **only once**.
- After all options, help them prepare documents and upload via CRM.
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
