// pages/api/portal/login.ts
// Use service role on server (never expose this in client code)
import { createClient } from "@supabase/supabase-js";
import { scryptSync, timingSafeEqual } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

function verify(pin: string, stored: string) {
  const parts = (stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hex] = parts;
  const hash = scryptSync(pin, salt, 32).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeEmail(email: string) {
  return (email || "").trim().toLowerCase();
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.SUPABASE_URL) return res.status(500).json({ ok:false, error:"Server not configured (URL)" });

  const email = normalizeEmail(req.body?.email);
  const pin = (req.body?.pin || "").toString().trim();

  if (!email || !pin) return res.status(400).json({ ok:false, error:"Missing credentials" });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok:false, error:"PIN must be 4 digits" });

  const { data, error } = await supabase
    .from("portal_users")
    .select("pin_hash, display_name, session_id")
    .eq("email", email)
    .single();

  if (error || !data?.pin_hash) return res.status(400).json({ ok:false, error:"Account not found" });
  if (!verify(pin, data.pin_hash)) return res.status(401).json({ ok:false, error:"Incorrect PIN" });

  return res.status(200).json({
    ok:true,
    displayName: data.display_name || null,
    sessionId: data.session_id || null
  });
}
