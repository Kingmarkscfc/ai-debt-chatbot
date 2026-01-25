import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "../../../utils/supabaseAdmin";

type Resp =
  | { ok: true; items: Array<{ id: string; filename: string; url: string; size: number | null; mime_type: string | null; created_at: string }> }
  | { ok: false; error: string };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const email = String(req.query.email || "").toLowerCase();
  const sessionId = String(req.query.sessionId || "");

  if (!email && !sessionId) {
    res.status(400).json({ ok: false, error: "Provide email or sessionId" });
    return;
  }

  try {
    let q = supabaseAdmin
      .from("portal_documents")
      .select("id, filename, url, size, mime_type, created_at")
      .order("created_at", { ascending: false });

    if (email) q = q.eq("email", email);
    else q = q.eq("session_id", sessionId);

    const { data, error } = await q;
    if (error) throw error;

    res.status(200).json({ ok: true, items: data || [] });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "Documents error" });
  }
}
