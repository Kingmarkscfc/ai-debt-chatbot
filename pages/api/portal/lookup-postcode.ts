// pages/api/portal/lookup-postcode.ts
import { createClient } from "@supabase/supabase-js"; // not used, but kept consistent for future auditing
const GETADDRESS_API_KEY = process.env.GETADDRESS_API_KEY || "";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { postcode } = req.body || {};
    const pc = String(postcode || "").trim();

    if (!pc) return res.status(400).json({ ok: false, error: "Missing postcode" });
    if (!GETADDRESS_API_KEY) {
      return res.status(400).json({
        ok: false,
        error: "Address lookup is not configured. Set GETADDRESS_API_KEY in Vercel.",
      });
    }

    // getAddress.io
    const url = `https://api.getaddress.io/find/${encodeURIComponent(pc)}?expand=true&api-key=${GETADDRESS_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ ok: false, error: `Lookup failed: ${txt}` });
    }
    const j = await r.json();

    // Shape addresses into a small list of suggestions for the UI
    const suggestions =
      (j?.addresses || []).map((a: any) => {
        // expand=true yields { line_1,line_2,line_3,town_or_city,county,postcode }
        const line1 = a?.line_1 || "";
        const line2 = a?.line_2 || a?.line_3 || "";
        const city = a?.town_or_city || "";
        const label = [line1, line2, city, j?.postcode || a?.postcode || pc].filter(Boolean).join(", ");
        return {
          label,
          line1,
          line2,
          city,
          postcode: j?.postcode || a?.postcode || pc,
        };
      }) || [];

    return res.status(200).json({ ok: true, suggestions });
  } catch (e: any) {
    console.error("lookup-postcode error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Server error during postcode lookup" });
  }
}
