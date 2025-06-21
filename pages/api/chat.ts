import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { history = [], userMessage }: { history: string[]; userMessage: string } = req.body;

  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const contextMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You are a helpful debt advisor named Mark.' },
    ...history.map((step, i): ChatCompletionMessageParam =>
      i % 2 === 0
        ? { role: 'user', content: step }
        : { role: 'assistant', content: step }
    ),
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: process.env.ADVANCED_MODEL || 'gpt-4o',
      messages: contextMessages
    });

    const reply = response.choices?.[0]?.message?.content ?? '⚠️ No reply generated.';
    return res.status(200).json({ reply });
  } catch (error: any) {
    console.error('❌ OpenAI API Error:', error.message || error);
    return res.status(500).json({ error: 'Failed to get response from OpenAI' });
  }
}
