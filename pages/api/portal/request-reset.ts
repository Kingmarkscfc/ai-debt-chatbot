// pages/api/portal/request-reset.ts
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

function normEmail(email: string) {
  return (email || "").trim().toLowerCase();
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

  try {
    if (!process.env.SUPABASE_URL) throw new Error("Missing SUPABASE_URL");

    const email = normEmail(req.body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok:false, error:"Invalid email" });
    }

    const token = uuidv4();
    const expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // +30 mins

    const { error } = await supabase
      .from("portal_resets")
      .insert([{ email, token, expires_at }]);

    if (error) {
      console.error("reset insert error:", error);
      return res.status(500).json({ ok:false, error:"Could not create reset token" });
    }

    // (You can email `token` via your email service; we just return ok here)
    return res.status(200).json({ ok:true });
  } catch (e: any) {
    console.error("reset crash:", e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
