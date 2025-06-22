import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';
import fullScriptLogic from '../../data/full_script_logic.json';
import chatFlow from '../../data/chat_flow.json';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const HUMOR_TRIGGERS = [
  "aliens", "payslip", "plot twist", "joke", "what are you wearing",
  "are you stupid", "talk dirty", "you sound hot", "prove you're real",
  "do you have a soul", "banter", "nonsense", "you sound fit", "idiot",
  "are you even qualified", "you're a robot", "flirt", "who built you",
  "you single", "how much do you earn", "are you real"
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { sessionId, userMessage = '', history = [] } = req.body;

  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const lowerCaseMessage = userMessage.toLowerCase();

  // 👋 INITIATE greeting
  if (userMessage === "👋 INITIATE") {
    await supabase
      .from('chat_sessions')
      .insert([{ session_id: sessionId, history: [] }]);

    return res.status(200).json({
      reply: "Hello! My name’s Mark. What prompted you to seek help with your debts today?",
      step: 'start'
    });
  }

  // 💬 Humor fallback
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

  // 🧠 Retrieve full script logic
  const currentScriptStep = fullScriptLogic[history.length] || fullScriptLogic[fullScriptLogic.length - 1];
  const currentPrompt = currentScriptStep?.prompt || 'Let’s keep going with your debt help...';
  const branchIfYes = currentScriptStep?.yes_step_index ?? null;
  const branchIfNo = currentScriptStep?.no_step_index ?? null;

  // Construct prompt with logic enforcement
  const assistantReply = `${currentPrompt}\n\n(Stay on script. ${
    branchIfYes !== null ? 'If the user says YES, move to step ' + branchIfYes + '.' : ''
  } ${
    branchIfNo !== null ? 'If they say NO, move to step ' + branchIfNo + '.' : ''
  })`;

  const contextMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You are a friendly, knowledgeable debt advisor bot named Mark. Follow the flow strictly. Never skip steps.' },
    ...history.map((step: string, i: number): ChatCompletionMessageParam =>
      i % 2 === 0
        ? { role: 'user', content: step }
        : { role: 'assistant', content: step }
    ),
    { role: 'user', content: userMessage },
    { role: 'assistant', content: assistantReply }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: selectedModel,
      messages: contextMessages
    });

    const reply = response.choices?.[0]?.message?.content ?? '⚠️ No response from OpenAI.';

    // Save updated chat session to Supabase
    const updatedHistory = [...history, userMessage, reply];
    await supabase
      .from('chat_sessions')
      .upsert({ session_id: sessionId, history: updatedHistory }, { onConflict: 'session_id' });

    return res.status(200).json({ reply, history: updatedHistory });
  } catch (error: any) {
    console.error('❌ OpenAI API Error:', error);
    return res.status(500).json({ error: 'Failed to get response from OpenAI' });
  }
}
