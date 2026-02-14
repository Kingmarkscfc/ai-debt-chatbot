import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "../../../utils/supabaseAdmin";

type Resp =
  | { ok: true; profile?: any; clientRef?: string }
  | { ok: false; error: string };

/**
 * /api/portal/profile
 * GET  ?email=...   -> returns client profile + client ref (if known)
 * POST { email, sessionId, profile } -> upserts client_profiles + clients, generates client_ref in clients table
 *
 * Requires Supabase tables from your SQL:
 * - client_profiles (email PK)
 * - clients (session_id unique) WITH a client_ref column (see note below)
 *
 * Recommended SQL (run once):
 *   alter table clients add column if not exists client_ref int unique default nextval('client_ref_seq');
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  try {
    const emailRaw = String(req.query.email || req.body?.email || "").toLowerCase().trim();
    const sessionId = String(req.query.sessionId || req.body?.sessionId || "").trim();

    if (req.method === "GET") {
      if (!emailRaw) return res.status(400).json({ ok: false, error: "Missing email" });

      const { data: prof, error: profErr } = await supabaseAdmin
        .from("client_profiles")
        .select("*")
        .eq("email", emailRaw)
        .maybeSingle();

      if (profErr) return res.status(500).json({ ok: false, error: profErr.message });

      // Try resolve client ref from clients table (via session_id if present)
      let clientRef: string | undefined = undefined;
      if (prof?.session_id) {
        const { data: c } = await supabaseAdmin
          .from("clients")
          .select("client_ref")
          .eq("session_id", prof.session_id)
          .maybeSingle();
        if (c?.client_ref != null) clientRef = String(c.client_ref);
      }

      return res.status(200).json({ ok: true, profile: prof || null, clientRef });
    }

    if (req.method === "POST") {
      if (!emailRaw) return res.status(400).json({ ok: false, error: "Missing email" });

      const profile = req.body?.profile || {};
      const fullName = String(profile.fullName || profile.full_name || "").trim();
      const phone = String(profile.phone || "").trim();
      const postcode = String(profile.postcode || "").trim();
      const address = String(profile.address || "").trim();
      const dob = String(profile.dob || "").trim();

      // Upsert into client_profiles
      const upsertPayload: any = {
        email: emailRaw,
        session_id: sessionId || profile.session_id || null,
        full_name: fullName || null,
        phone: phone || null,
        postcode: postcode || null,
        address1: address || null,
        // Keep fields you don't yet capture as null-safe:
        address2: profile.address2 || null,
        city: profile.city || null,
        updated_at: new Date().toISOString(),
      };

      // If you later split address into line/city, update this mapping.
      const { data: upserted, error: upsertErr } = await supabaseAdmin
        .from("client_profiles")
        .upsert(upsertPayload, { onConflict: "email" })
        .select("*")
        .single();

      if (upsertErr) return res.status(500).json({ ok: false, error: upsertErr.message });

      // Mirror key fields into clients table (session scoped)
      // This is also where we get/generate client_ref (requires column exists)
      let clientRef: string | undefined = undefined;

      if (sessionId) {
        // ensure row exists
        const { data: existing } = await supabaseAdmin
          .from("clients")
          .select("client_ref")
          .eq("session_id", sessionId)
          .maybeSingle();

        if (existing?.client_ref != null) {
          clientRef = String(existing.client_ref);
          // still update lightweight fields
          await supabaseAdmin
            .from("clients")
            .update({
              full_name: fullName || null,
              email: emailRaw,
              phone: phone || null,
              postcode: postcode || null,
            })
            .eq("session_id", sessionId);
        } else {
          const { data: inserted, error: insErr } = await supabaseAdmin
            .from("clients")
            .insert({
              session_id: sessionId,
              full_name: fullName || null,
              email: emailRaw,
              phone: phone || null,
              postcode: postcode || null,
            })
            .select("client_ref")
            .single();

          if (!insErr && inserted?.client_ref != null) clientRef = String(inserted.client_ref);
        }
      }

      return res.status(200).json({ ok: true, profile: upserted, clientRef });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
