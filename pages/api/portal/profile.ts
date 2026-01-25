import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "../../../utils/supabaseAdmin";

type Profile = {
  full_name?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  postcode?: string;
  address_history?: Array<{ line1: string; line2: string; city: string; postcode: string; yearsAt: number }>;
  incomes?: Array<{ label: string; amount: number }>;
  expenses?: Array<{ label: string; amount: number }>;
};

type Resp =
  | { ok: true; profile?: any }
  | { ok: false; error: string };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  try {
    if (req.method === "GET") {
      const email = String(req.query.email || "");
      if (!email) return res.status(400).json({ ok: false, error: "email required" });

      const { data, error } = await supabaseAdmin
        .from("portal_profiles")
        .select("*")
        .eq("email", email)
        .single();

      if (error && error.code !== "PGRST116") {
        return res.status(500).json({ ok: false, error: error.message });
      }
      return res.json({ ok: true, profile: data || null });
    }

    if (req.method === "POST") {
      const { email, profile } = req.body || {};
      if (!email || !profile) return res.status(400).json({ ok: false, error: "email and profile required" });

      const payload: Profile = {
        full_name: profile.full_name ?? null,
        phone: profile.phone ?? null,
        address1: profile.address1 ?? null,
        address2: profile.address2 ?? null,
        city: profile.city ?? null,
        postcode: profile.postcode ?? null,
        address_history: Array.isArray(profile.address_history) ? profile.address_history : [],
        incomes: Array.isArray(profile.incomes) ? profile.incomes : [],
        expenses: Array.isArray(profile.expenses) ? profile.expenses : [],
      };

      const { error } = await supabaseAdmin
        .from("portal_profiles")
        .upsert({ email, ...payload });

      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.json({ ok: true });
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Unexpected error" });
  }
}
