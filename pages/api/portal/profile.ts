import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "../../../utils/supabaseAdmin";

type Resp =
  | { ok: true; profile?: any }
  | { ok: false; error: string };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  const email = String(req.query.email || req.body?.email || "").toLowerCase();
  if (!email) {
    res.status(400).json({ ok: false, error: "Missing email" });
    return;
  }

  try {
    if (req.method === "GET") {
      const { data, error } = await supabaseAdmin
        .from("portal_profiles")
        .select("*")
        .eq("email", email)
        .maybeSingle();
      if (error) throw error;
      res.status(200).json({ ok: true, profile: data || null });
      return;
    }

    if (req.method === "POST") {
      const payload = req.body?.profile || {};
      payload.email = email;

      const { error } = await supabaseAdmin
        .from("portal_profiles")
        .upsert(payload, { onConflict: "email" });

      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "Profile error" });
  }
}
