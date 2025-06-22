// pages/api/income-expense.ts

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const { sessionId, incomeData, expenseData } = req.body;

  // 🛡️ Basic validation
  if (!sessionId || !incomeData || !expenseData) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log('📥 Income & Expense Received:', { sessionId, incomeData, expenseData });

  // TODO: Save to Supabase or DB here if needed

  return res.status(200).json({ message: 'Data received successfully' });
}
