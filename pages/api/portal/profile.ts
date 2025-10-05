// pages/api/portal/profile.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

export default async function handler(req: any, res: any) {
  if (req.method === "GET") {
    try {
      const email = String(req.query.email || "").toLowerCase().trim();
      if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

      const { data, error } = await supabase
        .from("client_profiles")
        .select("*")
        .eq("email", email)
        .maybeSingle();
      if (error) throw error;

      return res.status(200).json({ ok: true, profile: data || null });
    } catch (e: any) {
      console.error("profile GET error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Server error while fetching profile" });
    }
  }

  if (req.method === "POST") {
    try {
      const { email, sessionId, profile } = req.body || {};
      const normEmail = (email || "").toLowerCase().trim();
      if (!normEmail) return res.status(400).json({ ok: false, error: "Missing email" });

      const toSave = {
        email: normEmail,
        session_id: sessionId || null,
        full_name: profile?.full_name || null,
        phone: profile?.phone || null,
        address1: profile?.address1 || null, // kept for backwards compatibility
        address2: profile?.address2 || null,
        city: profile?.city || null,
        postcode: profile?.postcode || null,
        // new: address_history array with yearsAt
        address_history: Array.isArray(profile?.address_history) ? profile.address_history : [],
        incomes: Array.isArray(profile?.incomes) ? profile.incomes : [],
        expenses: Array.isArray(profile?.expenses) ? profile.expenses : [],
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("client_profiles")
        .upsert(toSave, { onConflict: "email" });
      if (error) throw error;

      // Optional mirror to clients table (lightweight)
      await supabase
        .from("clients")
        .upsert({
          session_id: sessionId || null,
          email: normEmail,
          full_name: toSave.full_name,
          postcode: toSave.postcode || null,
        }, { onConflict: "session_id" });

      return res.status(200).json({ ok: true });
    } catch (e: any) {
      console.error("profile POST error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Server error while saving profile" });
    }
  }

  return res.status(405).end();
}
