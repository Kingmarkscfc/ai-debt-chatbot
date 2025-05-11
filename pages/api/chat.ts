
import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import chatFlow from '../../data/chat_flow.json';

// Example company-specific config (in production this would come from Supabase or a DB)
const companyConfig = {
  default: {
    name: "Debt Advisor",
    regNumber: "FCA #123456",
    trustpilot: "https://trustpilot.com/review/defaultcompany.com",
    portalUrl: "https://portal.defaultcompany.com"
  },
  "debthelpco.uk": {
    name: "Debt Help Co",
    regNumber: "FCA #7891011",
    trustpilot: "https://trustpilot.com/review/debthelpco.uk",
    portalUrl: "https://portal.debthelpco.uk"
  }
};

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
  const userMessage = req.body.message || '';
  const hostHeader = req.headers.host || '';
  const companyKey = Object.keys(companyConfig).find(key => hostHeader.includes(key)) || "default";
  const config = companyConfig[companyKey];
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
You are ${config.name}, a professional yet friendly UK-based AI assistant trained to help users resolve personal debt using IVA/DMP solutions.
Regulated by: ${config.regNumber}.

Always follow this logic:
1. Greet and ask about debt eligibility (>£6,000, 2+ unsecured creditors).
2. If YES → steer toward an IVA, but always confirm suitability.
3. If NO or not suitable → suggest a DMP.
4. Only mention DRO/Bankruptcy if user brings it up or has very low disposable income.
5. Encourage, explain, and keep it friendly throughout.
6. When ready, collect name, debts, income, expenses, and prompt document upload via: ${config.portalUrl}.

Also:
- Mention MoneyHelper once at the start.
- Add humor if user banters (e.g. "aliens stole my payslip").
- Close with encouragement.
- Reviews: ${config.trustpilot}

Sound like a caring human advisor — not an AI. Keep responses natural, supportive, and professional.
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
