// pages/api/portal/docs.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

type Resp =
  | { ok: true; documents: { id: string; file_name: string; file_url: string; uploaded_at: string }[] }
  | { ok: true; linked: boolean }
  | { ok: false; error: string };

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  try {
    if (req.method === "POST") {
      // Link this sessionId to the portal user email (idempotent)
      const { email, sessionId, action } = req.body || {};
      if (action !== "attach-session") return res.status(400).json({ ok: false, error: "Invalid action." });
      if (!email || !sessionId) return res.status(400).json({ ok: false, error: "email and sessionId required." });

      // If portal_users.session_id is empty (or different), set it to this session
      const { data: userRow, error: selErr } = await supabase
        .from("portal_users")
        .select("id, session_id")
        .eq("email", email)
        .maybeSingle();

      if (selErr) return res.status(500).json({ ok: false, error: selErr.message });
      if (!userRow) return res.status(404).json({ ok: false, error: "Portal user not found." });

      if (!userRow.session_id) {
        const { error: updErr } = await supabase
          .from("portal_users")
          .update({ session_id: sessionId })
          .eq("id", userRow.id);
        if (updErr) return res.status(500).json({ ok: false, error: updErr.message });
        return res.status(200).json({ ok: true, linked: true });
      }

      // Already linked (we don't overwrite if present)
      return res.status(200).json({ ok: true, linked: false });
    }

    if (req.method === "GET") {
      const email = (req.query.email as string) || "";
      if (!email) return res.status(400).json({ ok: false, error: "email required." });

      // Find the user's session_id
      const { data: userRow, error: selErr } = await supabase
        .from("portal_users")
        .select("session_id")
        .eq("email", email)
        .maybeSingle();
      if (selErr) return res.status(500).json({ ok: false, error: selErr.message });
      const sessionId = userRow?.session_id || null;
      if (!sessionId) return res.status(200).json({ ok: true, documents: [] });

      // Return documents for that session
      const { data: docs, error: docErr } = await supabase
        .from("documents")
        .select("id, file_name, file_url, uploaded_at")
        .eq("session_id", sessionId)
        .order("uploaded_at", { ascending: false });

      if (docErr) return res.status(500).json({ ok: false, error: docErr.message });
      return res.status(200).json({ ok: true, documents: docs || [] });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
