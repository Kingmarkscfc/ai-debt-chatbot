// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const chat = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // You can upgrade to GPT-4 later
      messages: [
        {
          role: "system",
          content: `
You are Debt Advisor, a smart UK-based assistant trained to help users resolve personal debt with a structured IVA-first approach. Always follow this flow:

1. Greet the user warmly and ask if their debts are over £6,000 and include at least two unsecured creditors.
2. If YES → steer toward an IVA as the primary recommendation, but always ask the user to confirm that IVA feels like the right path.
3. If NO or IVA not suitable → suggest a DMP as the secondary option.
4. Mention DRO or Bankruptcy **only if the user insists** or says they have very low disposable income.
5. Reassure and support users throughout. Encourage them, praise progress, and explain each step clearly.
6. After advice, help them get started — ask for name, debts, income, and prepare to transfer to the CRM.

Additional logic:
- Mention MoneyHelper once at the start only.
- IVA/DMP should come before any mention of DRO or Bankruptcy.
- If they say their bank is linked to their debts, explain how switching helps protect their income.
- Prompt document upload once the user is ready.
- End chat with a positive, motivational message.

Always sound professional, supportive, and human — like a caring expert advisor.
          `.trim(),
        },
        { role: "user", content: message },
      ],
    });

    const reply = chat?.choices?.[0]?.message?.content ?? "⚠️ No response or format issue.";
    res.status(200).json({ reply });
  } catch (error: any) {
    console.error("OpenAI API error:", error);
    res.status(500).json({ error: "Failed to get response from OpenAI" });
  }
}
