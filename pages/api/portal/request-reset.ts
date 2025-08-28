// pages/api/portal/request-reset.ts
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

function normalizeEmail(email: string) {
  return (email || "").trim().toLowerCase();
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.SUPABASE_URL) return res.status(500).json({ ok:false, error:"Server not configured (URL)" });

  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ ok:false, error:"Missing email" });

  // Optional: ensure user exists (avoid leaking which emails are registered)
  const { data: user } = await supabase
    .from("portal_users")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  // Always respond ok to avoid enumeration, but only insert a token for real accounts
  if (user?.email) {
    const token = uuidv4();
    const expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    const { error } = await supabase
      .from("portal_resets")
      .insert({ email, token, expires_at });

    if (!error) {
      // TODO: send real email — for now, log server-side reset URL
      console.log(`[RESET LINK] https://your-domain/reset?token=${token}&email=${encodeURIComponent(email)}`);
    }
  }

  return res.status(200).json({ ok:true });
}
