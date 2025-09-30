// pages/api/portal/register.ts
import { createClient } from "@supabase/supabase-js";
import { randomBytes, scryptSync } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

function hashPin(pin: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function normEmail(email: string) {
  return (email || "").trim().toLowerCase();
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

  try {
    if (!process.env.SUPABASE_URL) throw new Error("Missing SUPABASE_URL");

    const email = normEmail(req.body?.email);
    const pin = String(req.body?.pin || "");
    const sessionId = (req.body?.sessionId || "").toString().trim() || null;
    const displayName = (req.body?.displayName || "").toString().trim() || null;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok:false, error:"Invalid email" });
    }
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ ok:false, error:"PIN must be exactly 4 digits" });
    }

    const pin_hash = hashPin(pin);

    const { error } = await supabase
      .from("portal_users")
      .insert([{ email, pin_hash, session_id: sessionId, display_name: displayName }]);

    if (error) {
      if ((error as any).code === "23505") {
        // Already exists → fetch client_ref to return
        const { data } = await supabase
          .from("portal_users")
          .select("client_ref, display_name")
          .eq("email", email)
          .maybeSingle();
        return res.status(409).json({ ok:false, error:"User already exists", clientRef: data?.client_ref || null });
      }
      console.error("register error:", error);
      return res.status(500).json({ ok:false, error:"Registration failed" });
    }

    const { data } = await supabase
      .from("portal_users")
      .select("client_ref, display_name")
      .eq("email", email)
      .maybeSingle();

    return res.status(200).json({
      ok:true,
      displayName: data?.display_name || displayName || email.split("@")[0],
      clientRef: data?.client_ref || null
    });
  } catch (e: any) {
    console.error("register crash:", e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
