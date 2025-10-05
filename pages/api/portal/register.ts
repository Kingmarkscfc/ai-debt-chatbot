// pages/api/portal/register.ts
// Untyped req/res to avoid duplicate Next types in some Vercel builds
import { createClient } from "@supabase/supabase-js";
import { randomBytes, scryptSync } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

// scrypt hash of "pin|email" with salt for basic credentialing
function hashPin(pin: string, email: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(`${pin}|${email.toLowerCase().trim()}`, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/**
 * Try to find the current max client_ref and return the next reference.
 * If the column doesn't exist yet, we mark `supported=false` so the handler can
 * insert without the column (no 500s) while you add it via SQL.
 */
async function nextClientRef(): Promise<{ next: number; supported: boolean }> {
  const { data, error } = await supabase
    .from("portal_users")
    .select("client_ref")
    .not("client_ref", "is", null)
    .order("client_ref", { ascending: false })
    .limit(1);

  if (error) {
    // Likely "column client_ref does not exist" — allow fallback
    return { next: 100000, supported: false };
  }
  const max = data?.[0]?.client_ref ?? 0;
  const next = Math.max(100000, Number(max || 0) + 1);
  return { next, supported: true };
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { email, pin, sessionId, displayName } = req.body || {};
    const normEmail = (email || "").toLowerCase().trim();

    if (!normEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }
    if (!/^\d{4}$/.test(pin || "")) {
      return res.status(400).json({ ok: false, error: "PIN must be 4 digits" });
    }

    // If already registered, just return existing info
    const { data: existing, error: selErr } = await supabase
      .from("portal_users")
      .select("email, client_ref, display_name")
      .eq("email", normEmail)
      .maybeSingle();

    if (selErr) throw selErr;

    if (existing) {
      return res.status(200).json({
        ok: true,
        message: "User already registered",
        clientRef: existing.client_ref ?? null,
        displayName: existing.display_name ?? displayName ?? null,
      });
    }

    const { next, supported } = await nextClientRef();
    const pin_hash = hashPin(pin, normEmail);

    // First try inserting with client_ref (if we think it's supported)
    if (supported) {
      const { error: insErr } = await supabase.from("portal_users").insert({
        email: normEmail,
        pin_hash,
        session_id: sessionId || null,
        display_name: displayName || null,
        client_ref: next,
      });

      if (!insErr) {
        return res.status(200).json({
          ok: true,
          clientRef: next,
          displayName: displayName || null,
          message: "Portal created",
        });
      }

      // If the error indicates the column doesn't exist, fall back to insert without it
      if ((insErr as any)?.message?.toLowerCase?.().includes("client_ref")) {
        const { error: ins2 } = await supabase.from("portal_users").insert({
          email: normEmail,
          pin_hash,
          session_id: sessionId || null,
          display_name: displayName || null,
        });
        if (ins2) throw ins2;
        return res.status(200).json({
          ok: true,
          clientRef: null, // will be available after you add the column
          displayName: displayName || null,
          message: "Portal created (client reference pending column setup).",
        });
      }

      // Other insert error
      throw insErr;
    }

    // Column not supported yet → insert without client_ref to avoid 500s
    const { error: insNoRef } = await supabase.from("portal_users").insert({
      email: normEmail,
      pin_hash,
      session_id: sessionId || null,
      display_name: displayName || null,
    });
    if (insNoRef) throw insNoRef;

    return res.status(200).json({
      ok: true,
      clientRef: null,
      displayName: displayName || null,
      message: "Portal created (client reference pending column setup).",
    });
  } catch (e: any) {
    console.error("register error:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
