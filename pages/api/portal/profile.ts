import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "../../../utils/supabaseAdmin";

type Resp =
  | { ok: true; profile?: any; clientRef?: string }
  | { ok: false; error: string };

function makeClientRef() {
  // e.g. DA-260214-482193 (YYMMDD + 6 random digits)
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const rand = String(Math.floor(Math.random() * 900000) + 100000);
  return `DA-${yy}${mm}${dd}-${rand}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  const emailRaw = String(req.query.email || req.body?.email || "").toLowerCase().trim();
  const sessionId = String(req.query.sessionId || req.body?.sessionId || "").trim();

  // Allow GET by email only (or by sessionId if your table includes session_id)
  try {
    if (req.method === "GET") {
      if (!emailRaw && !sessionId) {
        res.status(400).json({ ok: false, error: "Missing email" });
        return;
      }

      // Prefer email lookups (stable)
      if (emailRaw) {
        const { data, error } = await supabaseAdmin
          .from("portal_profiles")
          .select("*")
          .eq("email", emailRaw)
          .maybeSingle();
        if (error) throw error;
        res.status(200).json({ ok: true, profile: data || null, clientRef: data?.client_ref || data?.clientRef || undefined });
        return;
      }

      // Optional: sessionId lookup (only if your table supports it)
      const { data, error } = await supabaseAdmin
        .from("portal_profiles")
        .select("*")
        .eq("session_id", sessionId)
        .maybeSingle();

      // If the column doesn't exist, Supabase will error — return a clear message.
      if (error) throw error;

      res.status(200).json({ ok: true, profile: data || null, clientRef: data?.client_ref || data?.clientRef || undefined });
      return;
    }

    if (req.method === "POST") {
      const payloadIn = (req.body?.profile || {}) as any;
      const email = String(payloadIn?.email || emailRaw || "").toLowerCase().trim();

      if (!email) {
        res.status(400).json({ ok: false, error: "Missing email" });
        return;
      }

      // Pull current profile (to preserve existing client_ref and merge updates)
      const { data: existing, error: readErr } = await supabaseAdmin
        .from("portal_profiles")
        .select("*")
        .eq("email", email)
        .maybeSingle();
      if (readErr) throw readErr;

      let clientRef = existing?.client_ref || existing?.clientRef || null;

      // Generate client ref if missing
      if (!clientRef) {
        // Try a few times to avoid collisions
        for (let i = 0; i < 6; i++) {
          const ref = makeClientRef();
          const { data: clash, error: clashErr } = await supabaseAdmin
            .from("portal_profiles")
            .select("email")
            .eq("client_ref", ref)
            .maybeSingle();
          if (clashErr) {
            // If the column doesn't exist, we'll just use the ref (but you should add client_ref column).
            clientRef = ref;
            break;
          }
          if (!clash) {
            clientRef = ref;
            break;
          }
        }
      }

      const payload = {
        ...(existing || {}),
        ...payloadIn,
        email,
        session_id: sessionId || payloadIn?.session_id || existing?.session_id || null,
        client_ref: clientRef,
        updated_at: new Date().toISOString(),
      };

      const { data: up, error: upErr } = await supabaseAdmin
        .from("portal_profiles")
        .upsert(payload, { onConflict: "email" })
        .select("*")
        .maybeSingle();

      if (upErr) throw upErr;

      res.status(200).json({ ok: true, profile: up || payload, clientRef: clientRef || undefined });
      return;
    }

    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    // Common gotcha: portal_profiles table missing client_ref/session_id columns.
    // We keep the message concise so you can see it in the UI quickly.
    res.status(500).json({ ok: false, error: e?.message || "Profile error" });
  }
}
