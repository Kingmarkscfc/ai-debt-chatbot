// ✅ HYBRID chat.ts – FullScriptLogic control + GPT-3.5/4o model switching + humor + fallback

import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';
import fullScriptLogic from '../../data/full_script_logic.json';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const HUMOR_TRIGGERS = [
  'aliens', 'payslip', 'plot twist', 'joke', 'what are you wearing',
  'are you stupid', 'talk dirty', 'you sound hot', 'prove you\'re real',
  'do you have a soul', 'banter', 'nonsense', 'you sound fit', 'idiot',
  'are you even qualified', 'you\'re a robot', 'flirt', 'you single',
  'how much do you earn', 'are you real'
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { sessionId, userMessage = '', history = [] } = req.body;

  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const lowerCaseMessage = userMessage.toLowerCase();

  // INITIATE trigger
  if (userMessage === '👋 INITIATE') {
    await supabase.from('chat_sessions').upsert({ session_id: sessionId, history: [] }, { onConflict: 'session_id' });
    return res.status(200).json({ reply: fullScriptLogic[0].prompt, step: 0 });
  }

  // Humor fallback
  if (HUMOR_TRIGGERS.some(trigger => lowerCaseMessage.includes(trigger))) {
    const jokes = [
      "That’s a plot twist I didn’t see coming… but let’s get back to sorting your finances!",
      "I’m flattered you think I can do that, but let’s stick to helping you become debt-free, yeah?",
      "If the aliens return your payslip, just upload it when you can. Let’s keep going in the meantime."
    ];
    const joke = jokes[Math.floor(Math.random() * jokes.length)];
    return res.status(200).json({ reply: joke });
  }

  // Determine next script step
  const currentStepIndex = Math.floor(history.length / 2);
  const currentScriptStep = fullScriptLogic[currentStepIndex] || fullScriptLogic[fullScriptLogic.length - 1];
  const basePrompt = currentScriptStep?.prompt || 'Let’s keep going with your debt help...';
  const branchIfYes = currentScriptStep?.yes_step_index ?? null;
  const branchIfNo = currentScriptStep?.no_step_index ?? null;

  // Add logic instructions if branching exists
  const scriptInstruction = `${basePrompt}\n\n(Stay on script. ${
    branchIfYes !== null ? 'If YES, go to step ' + branchIfYes + '.' : ''
  } ${
    branchIfNo !== null ? 'If NO, go to step ' + branchIfNo + '.' : ''
  })`;

  const contextMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You are a friendly, structured debt advisor named Mark. You must follow the script flow precisely, asking only what is provided.' },
    ...history.map((msg: string, i: number) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: msg
    })),
    { role: 'user', content: userMessage },
    { role: 'assistant', content: scriptInstruction }
  ];

  const selectedModel = userMessage.length < 40 ? 'gpt-3.5-turbo' : 'gpt-4o';

  try {
    const response = await openai.chat.completions.create({
      model: selectedModel,
      messages: contextMessages
    });

    const reply = response.choices?.[0]?.message?.content ?? basePrompt;
    const updatedHistory = [...history, userMessage, reply];

    await supabase.from('chat_sessions')
      .upsert({ session_id: sessionId, history: updatedHistory }, { onConflict: 'session_id' });

    return res.status(200).json({ reply, history: updatedHistory });
  } catch (error: any) {
    console.error('❌ OpenAI API Error:', error);
    return res.status(500).json({ error: 'Failed to get response from OpenAI' });
  }
}
