// pages/api/portal/profile.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

export default async function handler(req: any, res: any) {
  try {
    if (req.method === "GET") {
      const email = String(req.query.email || "").trim().toLowerCase();
      if (!email) return res.status(400).json({ ok:false, error:"Missing email" });

      const [{ data: user }, { data: prof }] = await Promise.all([
        supabase.from("portal_users").select("client_ref").eq("email", email).maybeSingle(),
        supabase.from("client_profiles").select("*").eq("email", email).maybeSingle()
      ]);

      return res.status(200).json({
        ok:true,
        clientRef: user?.client_ref || null,
        profile: prof || null
      });
    }

    if (req.method === "POST") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const session_id = String(req.body?.sessionId || "").trim() || null;
      const profile = req.body?.profile || {};
      if (!email) return res.status(400).json({ ok:false, error:"Missing email" });

      const row = {
        email,
        session_id,
        full_name: profile.full_name || null,
        phone: profile.phone || null,
        address1: profile.address1 || null,
        address2: profile.address2 || null,
        city: profile.city || null,
        postcode: profile.postcode || null,
        incomes: Array.isArray(profile.incomes) ? profile.incomes : [],
        expenses: Array.isArray(profile.expenses) ? profile.expenses : [],
        debts: Array.isArray(profile.debts) ? profile.debts : [],
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from("client_profiles")
        .upsert(row, { onConflict: "email" });

      if (error) {
        console.error("profile upsert error:", error);
        return res.status(500).json({ ok:false, error:"Could not save profile" });
      }

      return res.status(200).json({ ok:true });
    }

    return res.status(405).json({ ok:false, error:"Method not allowed" });
  } catch (e: any) {
    console.error("profile crash:", e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
