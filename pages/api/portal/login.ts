// pages/api/portal/login.ts
import { createClient } from "@supabase/supabase-js";
import { scryptSync, timingSafeEqual } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

function verifyPin(pin: string, stored: string, email: string) {
  const [algo, salt, hex] = (stored || "").split("$");
  if (algo !== "scrypt" || !salt || !hex) return false;
  const hash = scryptSync(`${pin}|${email.toLowerCase().trim()}`, salt, 32).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  const { email, pin } = req.body || {};
  const normEmail = (email || "").toLowerCase().trim();

  if (!normEmail || !pin) return res.status(400).json({ ok: false, error: "Missing credentials" });

  try {
    const { data: u, error } = await supabase
      .from("portal_users")
      .select("email, pin_hash, display_name, client_ref")
      .eq("email", normEmail)
      .maybeSingle();

    if (error) throw error;
    if (!u || !u.pin_hash) return res.status(401).json({ ok: false, error: "Invalid email or PIN" });
    if (!verifyPin(pin, u.pin_hash, normEmail)) return res.status(401).json({ ok: false, error: "Invalid email or PIN" });

    return res.status(200).json({
      ok: true,
      displayName: u.display_name || null,
      clientRef: u.client_ref || null,
    });
  } catch (e: any) {
    console.error("login error:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
