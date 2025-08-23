import { createClient } from "@supabase/supabase-js";
import { randomBytes, scryptSync } from "crypto";

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_ANON_KEY || "");

function hashPin(pin: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  const { email, pin, sessionId, displayName } = req.body || {};
  if (!email || !/^[^@]+@[^@]+$/.test(email) || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ ok:false, error:"Invalid email or PIN" });
  }
  try {
    const pin_hash = hashPin(pin);
    const { error } = await supabase
      .from("portal_users")
      .upsert({ email, pin_hash, session_id: sessionId || null, display_name: displayName || null });
    if (error) return res.status(400).json({ ok:false, error:error.message });
    return res.status(200).json({ ok:true });
  } catch (e:any) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
