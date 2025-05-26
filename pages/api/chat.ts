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
Good afternoon, my name’s Mark. I’m going to start by asking what prompted you to seek help with your debts today.

Here’s the exact flow you must follow step-by-step. After each user response, mark the step as “answered” and move on to the next. Never repeat a question already answered unless the user asks for clarification.

FLOW:

1. Ask what prompted the user to seek debt help.
2. Then: “What would you say is your main concern with the debts?” (e.g., bailiffs, interest, court)
3. Then: “Are any debts joint or are you a guarantor for someone else?”
4. Then explore options in this strict order:
   a. Self-help
   b. Loan consolidation
   c. DRO
   d. Bankruptcy
   e. DMP
   f. IVA (only after all others)

Rules:
- Never ask the same question twice unless unclear.
- Treat emotional or detailed responses as valid.
- After all options, help user prepare documents and upload them via CRM.
- Use friendly, encouraging tone. Add cheeky humor if user goes off-topic.
- Only mention MoneyHelper once.
- Only mention IVA when all other options have been explained.

Do not freelance. Follow the script above strictly.
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

