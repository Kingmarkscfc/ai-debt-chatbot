// pages/api/portal/login.ts
import { createClient } from "@supabase/supabase-js";
import { scryptSync, timingSafeEqual } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

function normEmail(email: string) {
  return (email || "").trim().toLowerCase();
}

function verifyPin(pin: string, stored: string) {
  try {
    const [algo, salt, hex] = String(stored || "").split("$");
    if (algo !== "scrypt" || !salt || !hex) return false;
    const hash = scryptSync(pin, salt, 32).toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(hex, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

  try {
    if (!process.env.SUPABASE_URL) throw new Error("Missing SUPABASE_URL");

    const email = normEmail(req.body?.email);
    const pin = String(req.body?.pin || "");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok:false, error:"Invalid email" });
    }
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ ok:false, error:"PIN must be exactly 4 digits" });
    }

    const { data, error } = await supabase
      .from("portal_users")
      .select("pin_hash, display_name")
      .eq("email", email)
      .maybeSingle();

    if (error) {
      console.error("login select error:", error);
      return res.status(500).json({ ok:false, error:"Login failed" });
    }
    if (!data) {
      return res.status(404).json({ ok:false, error:"User not found" });
    }
    if (!verifyPin(pin, data.pin_hash)) {
      return res.status(401).json({ ok:false, error:"Invalid PIN" });
    }

    return res.status(200).json({ ok:true, displayName: data.display_name || email.split("@")[0] });
  } catch (e: any) {
    console.error("login crash:", e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
