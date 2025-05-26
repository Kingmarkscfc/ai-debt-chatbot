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

You must follow this strict sequence. Internally mark each question as “✅ complete” once answered, and never return to it unless the user directly asks to.

FLOW:
1. Ask: “What prompted you to seek help with your debts today?”
2. Then: “What would you say is your main concern with the debts?” (e.g., bailiffs, interest, court)
3. Then: “Are any debts joint or are you a guarantor for someone else?”
4. Then present options in strict order:
   a. Self-help
   b. Loan consolidation
   c. DRO
   d. Bankruptcy
   e. DMP
   f. IVA (only after all others)

Rules:
- Never repeat a completed question.
- Accept emotional or indirect answers as valid.
- If the user says “not sure” or “you tell me,” proceed to the next step.
- Respond like a supportive, empathetic human advisor.
- Add humour if they go off-topic (e.g. “aliens stole my payslip”).
- Mention MoneyHelper only once.
- IVA must be the last option explored.
- Prepare user for CRM transfer and document upload at the end.

Do not freelance or break the order. Stick to the script flow.
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

