import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "../../utils/supabaseAdmin";

type ClientRow = {
  session_id: string | null;
  client_ref: number | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  created_at: string | null;
};

type Resp =
  | { ok: true; clients: ClientRow[] }
  | { ok: false; error: string };

function getPins() {
  return {
    business: (process.env.BUSINESS_PORTAL_PIN || "").trim(),
    overseer: (process.env.OVERSEER_PORTAL_PIN || "").trim(),
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const scope = String(req.headers["x-portal-scope"] || "").toLowerCase();
    const pin = String(req.headers["x-portal-pin"] || "").trim();
    const pins = getPins();

    if (scope !== "business" && scope !== "overseer") {
      return res.status(400).json({ ok: false, error: "Missing scope" });
    }
    const expected = (pins as any)[scope] || "";
    if (!expected || pin !== expected) {
      return res.status(401).json({ ok: false, error: "Invalid PIN" });
    }

    // NOTE: Requires clients.client_ref column (recommended SQL in profile API)
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("session_id, client_ref, full_name, email, phone, postcode, created_at")
      .order("created_at", { ascending: false })
      .limit(2000);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.status(200).json({ ok: true, clients: (data || []) as any });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
