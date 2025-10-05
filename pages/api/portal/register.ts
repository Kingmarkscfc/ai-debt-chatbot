// pages/api/portal/register.ts
// Note: untyped req/res to avoid duplicate Next types in some Vercel builds
import { createClient } from "@supabase/supabase-js";
import { randomBytes, scryptSync } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

// scrypt hash "pin|email" with random salt
function hashPin(pin: string, email: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(`${pin}|${email.toLowerCase().trim()}`, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

async function ensureClientRef(): Promise<number> {
  // Make sure the column exists (safe to re-run)
  await supabase.rpc("noop").catch(() => {}); // no-op to ensure connection
  await supabase
    .from("portal_users")
    .select("id", { count: "exact", head: true })
    .limit(1);

  // Add column if missing (best effort)
  await supabase
    .rpc("exec_sql", {
      sql: `
        do $$ begin
          alter table portal_users add column if not exists client_ref integer unique;
        exception when duplicate_column then null; end $$;
      `,
    })
    .catch(() => {});

  // Find current max client_ref
  const { data: maxRows, error } = await supabase
    .from("portal_users")
    .select("client_ref")
    .not("client_ref", "is", null)
    .order("client_ref", { ascending: false })
    .limit(1);

  if (error) return 100000;
  const max = (maxRows && maxRows[0]?.client_ref) || 0;
  return Math.max(100000, Number(max || 0) + 1);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  const { email, pin, sessionId, displayName } = req.body || {};
  const normEmail = (email || "").toLowerCase().trim();

  if (!normEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail))
    return res.status(400).json({ ok: false, error: "Invalid email" });
  if (!/^\d{4}$/.test(pin || "")) return res.status(400).json({ ok: false, error: "PIN must be 4 digits" });

  try {
    // If already exists, return their client_ref/display_name
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
        clientRef: existing.client_ref || null,
        displayName: existing.display_name || displayName || null,
      });
    }

    const clientRef = await ensureClientRef();
    const pin_hash = hashPin(pin, normEmail);

    const { error: insErr } = await supabase.from("portal_users").insert({
      email: normEmail,
      pin_hash,
      session_id: sessionId || null,
      display_name: displayName || null,
      client_ref: clientRef,
    });

    if (insErr) throw insErr;

    return res.status(200).json({
      ok: true,
      clientRef,
      displayName: displayName || null,
      message: "Portal created",
    });
  } catch (e: any) {
    console.error("register error:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
