import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_ANON_KEY || "");

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok:false, error:"Missing email" });

  const token = uuidv4();
  const expires_at = new Date(Date.now() + 1000 * 60 * 30).toISOString(); // 30 mins

  const { error } = await supabase
    .from("portal_resets")
    .insert({ email, token, expires_at });

  if (error) return res.status(400).json({ ok:false, error:error.message });

  // TODO: integrate email provider — for now, log to server
  console.log(`[RESET LINK] https://your-domain/reset?token=${token}&email=${encodeURIComponent(email)}`);
  return res.status(200).json({ ok:true });
}
