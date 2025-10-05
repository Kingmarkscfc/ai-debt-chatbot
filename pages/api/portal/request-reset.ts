// pages/api/portal/request-reset.ts
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { email } = req.body || {};
    const normEmail = (email || "").toLowerCase().trim();
    if (!normEmail) return res.status(400).json({ ok: false, error: "Missing email" });

    const token = uuidv4();
    const expires_at = new Date(Date.now() + 1000 * 60 * 30).toISOString(); // 30 mins

    const { error } = await supabase
      .from("portal_resets")
      .insert({ email: normEmail, token, expires_at });

    if (error) return res.status(400).json({ ok: false, error: error.message });

    // Email sending is out-of-scope here; hand token back for now (dev visibility)
    return res.status(200).json({
      ok: true,
      message: "Reset created",
      token, // remove in prod
      expires_at,
    });
  } catch (e: any) {
    console.error("request-reset error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Server error during reset" });
  }
}
