// pages/api/portal/login.ts
import { createClient } from "@supabase/supabase-js";
import { scryptSync, timingSafeEqual } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

/**
 * Stored format: "scrypt$<salt>$<hex>"
 * We accept BOTH:
 *   - legacy: scrypt(pin, salt, 32)
 *   - new:    scrypt(`${pin}|${email}`, salt, 32)
 */
function verifyPin(pin: string, email: string, stored: string): boolean {
  try {
    const [algo, salt, hex] = (stored || "").split("$");
    if (algo !== "scrypt" || !salt || !hex) return false;

    const legacy = scryptSync(pin, salt, 32).toString("hex");
    const modern = scryptSync(`${pin}|${email.toLowerCase().trim()}`, salt, 32).toString("hex");

    const a = Buffer.from(hex, "hex");
    const b1 = Buffer.from(legacy, "hex");
    const b2 = Buffer.from(modern, "hex");

    const matchLegacy = a.length === b1.length && timingSafeEqual(a, b1);
    const matchModern = a.length === b2.length && timingSafeEqual(a, b2);

    return matchLegacy || matchModern;
  } catch {
    return false;
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { email, pin, sessionId } = req.body || {};
    const normEmail = (email || "").toLowerCase().trim();
    const normPin = (pin || "").trim();

    if (!normEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail) || !/^\d{4}$/.test(normPin)) {
      return res.status(400).json({ ok: false, error: "Invalid email or PIN" });
    }

    const { data: user, error } = await supabase
      .from("portal_users")
      .select("email, pin_hash, client_ref, display_name, session_id")
      .eq("email", normEmail)
      .maybeSingle();

    if (error) throw error;
    if (!user?.pin_hash) return res.status(401).json({ ok: false, error: "Invalid email or PIN" });

    const ok = verifyPin(normPin, normEmail, user.pin_hash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid email or PIN" });

    // Optionally persist/refresh session id
    if (sessionId && sessionId !== user.session_id) {
      await supabase.from("portal_users").update({ session_id: sessionId }).eq("email", normEmail);
    }

    return res.status(200).json({
      ok: true,
      message: "Logged in",
      clientRef: user.client_ref ?? null,
      displayName: user.display_name ?? null,
    });
  } catch (e: any) {
    console.error("login error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Server error during login" });
  }
}
