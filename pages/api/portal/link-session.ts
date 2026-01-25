import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "../../../utils/supabaseAdmin";

type Resp =
  | { ok: true; clientRef: string }
  | { ok: false; error: string };

function makeClientRef() {
  // e.g., BEE-2026-7F3K9C
  const y = new Date().getFullYear();
  const rand = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 8);
  return `BEE-${y}-${rand}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  try {
    const { sessionId, email } = req.body || {};
    if (!sessionId || !email) {
      res.status(400).json({ ok: false, error: "Missing sessionId or email" });
      return;
    }
    const normEmail = String(email).toLowerCase();

    // Ensure a user row exists
    await supabaseAdmin
      .from("portal_users")
      .upsert({ email: normEmail }, { onConflict: "email" });

    // Ensure a profile exists with a client_ref
    const { data: prof } = await supabaseAdmin
      .from("portal_profiles")
      .select("email, client_ref")
      .eq("email", normEmail)
      .maybeSingle();

    let clientRef = prof?.client_ref;
    if (!clientRef) {
      clientRef = makeClientRef();
      await supabaseAdmin
        .from("portal_profiles")
        .upsert({ email: normEmail, client_ref: clientRef }, { onConflict: "email" });
    }

    // Link any session documents to this email/ref
    await supabaseAdmin
      .from("portal_documents")
      .update({ email: normEmail, client_ref: clientRef })
      .eq("session_id", sessionId)
      .is("email", null);

    res.status(200).json({ ok: true, clientRef });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "Link error" });
  }
}
