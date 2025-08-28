// pages/api/portal/register.ts
import { createClient } from "@supabase/supabase-js";
import { randomBytes, scryptSync } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

function hashPin(pin: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function normalizeEmail(email: string) {
  return (email || "").trim().toLowerCase();
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.SUPABASE_URL) return res.status(500).json({ ok:false, error:"Server not configured (URL)" });

  const rawEmail = req.body?.email as string;
  const pin = (req.body?.pin || "").toString().trim();
  const sessionId = (req.body?.sessionId || "").toString().trim() || null;
  const displayName = (req.body?.displayName || "").toString().trim() || null;

  const email = normalizeEmail(rawEmail);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ ok:false, error:"Invalid email or PIN" });
  }

  const pin_hash = hashPin(pin);

  // Use insert (not upsert) so we don't overwrite existing accounts
  const { error } = await supabase
    .from("portal_users")
    .insert({ email, pin_hash, session_id: sessionId, display_name: displayName });

  if (error) {
    // Postgres unique violation (email unique)
    if ((error as any).code === "23505") {
      return res.status(409).json({ ok:false, error:"Email already registered. Please log in." });
    }
    return res.status(400).json({ ok:false, error: error.message || "Could not register." });
  }

  return res.status(200).json({ ok:true, displayName, sessionId });
}
