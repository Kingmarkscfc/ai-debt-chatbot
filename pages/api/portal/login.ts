import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { scryptSync, timingSafeEqual } from "crypto";

import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { scryptSync, timingSafeEqual } from "crypto";

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_ANON_KEY || "");

function verify(pin: string, stored: string) {
  const [algo, salt, hex] = stored.split("$");
  if (algo !== "scrypt") return false;
  const hash = scryptSync(pin, salt, 32).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const { email, pin } = req.body || {};
  if (!email || !pin) return res.status(400).json({ ok:false, error:"Missing credentials" });

  const { data, error } = await supabase
    .from("portal_users")
    .select("pin_hash")
    .eq("email", email)
    .single();

  if (error || !data?.pin_hash) return res.status(400).json({ ok:false, error:"Account not found" });
  if (!verify(pin, data.pin_hash)) return res.status(401).json({ ok:false, error:"Incorrect PIN" });

  return res.status(200).json({ ok:true });
}
