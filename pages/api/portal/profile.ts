import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "../../../utils/supabaseAdmin";

// Expects "portal_profiles" table (or merge into portal_users if you prefer):
//  email (text, pk), full_name (text), phone (text), address1 (text),
//  address2 (text), city (text), postcode (text),
//  address_history (jsonb), incomes (jsonb), expenses (jsonb)
// Documents are read from "portal_documents" by email or session_id fallback.

type Profile = {
  full_name?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  postcode?: string;
  address_history?: any[];
  incomes?: any[];
  expenses?: any[];
};

type Resp =
  | { ok: true; profile?: Profile; documents?: any[] }
  | { ok: false; error: string };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  if (req.method === "GET") {
    const email = (req.query.email || "").toString().trim();
    const sessionId = (req.query.sessionId || "").toString().trim();
    if (!email && !sessionId) {
      res.status(400).json({ ok: false, error: "email or sessionId required" });
      return;
    }

    try {
      let profile: Profile | undefined;
      if (email) {
        const { data, error } = await supabaseAdmin
          .from("portal_profiles")
          .select("*")
          .eq("email", email)
          .maybeSingle();
        if (error) throw error;
        profile = data || undefined;
      }

      // Docs: prefer email, otherwise by session
      let docs: any[] = [];
      if (email) {
        const { data, error } = await supabaseAdmin
          .from("portal_documents")
          .select("id, url, filename, mime_type, size, created_at")
          .eq("email", email)
          .order("created_at", { ascending: false });
        if (error) throw error;
        docs = data || [];
      } else if (sessionId) {
        const { data, error } = await supabaseAdmin
          .from("portal_documents")
          .select("id, url, filename, mime_type, size, created_at")
          .eq("session_id", sessionId)
          .order("created_at", { ascending: false });
        if (error) throw error;
        docs = data || [];
      }

      res.status(200).json({ ok: true, profile, documents: docs });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "Load error" });
    }
    return;
  }

  if (req.method === "POST") {
    const { email, profile } = req.body || {};
    if (!email || typeof profile !== "object") {
      res.status(400).json({ ok: false, error: "Invalid payload" });
      return;
    }
    try {
      const up = { email, ...profile };
      const { error } = await supabaseAdmin
        .from("portal_profiles")
        .upsert(up, { onConflict: "email" });
      if (error) throw error;
      res.status(200).json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "Save error" });
    }
    return;
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
}
