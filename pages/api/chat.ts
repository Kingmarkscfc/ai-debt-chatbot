import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import fullScriptLogic from '../../data/full_script_logic.json';
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

  // 👋 INITIATE greeting
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

  try {
    const contextMessages = [
      { role: 'system', content: 'You are a friendly, knowledgeable debt advisor bot named Mark. Follow the predefined full script logic exactly, step-by-step. Never skip or repeat a question unless instructed.' },
      { role: 'user', content: userMessage }
    ];

    const response = await openai.chat.completions.create({
      model: selectedModel,
      messages: contextMessages
    });

    const reply = response?.choices?.[0]?.message?.content ?? '⚠️ Something went wrong.';
    return res.status(200).json({ reply });
  } catch (error: any) {
    console.error('❌ OpenAI API Error:', error);
    return res.status(500).json({ error: 'Failed to get response from OpenAI' });
  }
}