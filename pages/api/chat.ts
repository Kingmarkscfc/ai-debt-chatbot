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
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are Debt Advisor, a smart and supportive assistant that helps users in the UK deal with personal debt. Follow a structured script, starting by understanding their situation, checking eligibility for solutions like IVA, DMP, etc., and reassuring them through each step. Be friendly, informative, and keep answers focused on the user’s debt journey.",
        },
        { role: "user", content: message },
      ],
    });

    console.log("🧠 OpenAI raw response:", JSON.stringify(chat, null, 2));
    const reply = chat?.choices?.[0]?.message?.content ?? "⚠️ No response or format issue.";
    res.status(200).json({ reply });
  } catch (error: any) {
    console.error("OpenAI API error:", error);
    res.status(500).json({ error: "Failed to get response from OpenAI" });
  }
}
