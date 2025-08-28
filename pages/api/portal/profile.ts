import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

function normEmail(email: string) {
  return (email || "").trim().toLowerCase();
}

export default async function handler(req: any, res: any) {
  if (!process.env.SUPABASE_URL) {
    return res.status(500).json({ ok: false, error: "Server not configured (SUPABASE_URL)" });
  }

  if (req.method === "GET") {
    const email = normEmail(req.query?.email as string);
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

    const { data, error } = await supabase
      .from("client_profiles")
      .select(
        "email, session_id, full_name, phone, address1, address2, city, postcode, incomes, expenses"
      )
      .eq("email", email)
      .maybeSingle();

    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, profile: data || null });
  }

  if (req.method === "POST") {
    const email = normEmail(req.body?.email);
    const session_id = (req.body?.sessionId || "").toString().trim() || null;
    const profile = req.body?.profile || {};

    if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

    const payload = {
      email,
      session_id,
      full_name: String(profile.full_name || ""),
      phone: String(profile.phone || ""),
      address1: String(profile.address1 || ""),
      address2: String(profile.address2 || ""),
      city: String(profile.city || ""),
      postcode: String(profile.postcode || ""),
      incomes: Array.isArray(profile.incomes) ? profile.incomes : [],
      expenses: Array.isArray(profile.expenses) ? profile.expenses : []
    };

    const { error } = await supabase
      .from("client_profiles")
      .upsert(payload, { onConflict: "email" });

    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
