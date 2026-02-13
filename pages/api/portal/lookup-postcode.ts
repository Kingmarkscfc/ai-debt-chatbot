// pages/api/portal/lookup-postcode.ts
// Proxy endpoint for UK postcode address lookup using Ideal Postcodes (https://ideal-postcodes.co.uk)
//
// Frontend expects: { ok: true, addresses: string[] } on success
// And: { ok: false, error: string, suggestions?: string[] } on failure

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, error: "Method not allowed." });
    }

    // Accept postcode from query or JSON body (supports a few alias keys)
    const qp = req.query || {};
    const bp = req.body || {};
    const raw =
      qp.postcode ??
      qp.pc ??
      qp.q ??
      bp.postcode ??
      bp.pc ??
      bp.q ??
      "";

    const pc = String(raw || "").trim().toUpperCase();
    const ukRe = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

    if (!pc || !ukRe.test(pc)) {
      return res.status(400).json({ ok: false, error: "Invalid UK postcode." });
    }

    // Ideal Postcodes authenticates via api_key query param
    const apiKey =
      process.env.GETADDRESS_API_KEY ||
      process.env.IDEAL_POSTCODES_API_KEY ||
      process.env.IDEALPOSTCODES_API_KEY;

    if (!apiKey) {
      return res.status(200).json({
        ok: false,
        error:
          "Address lookup not configured. Set GETADDRESS_API_KEY (Ideal Postcodes) in .env.local and in Vercel environment variables.",
      });
    }

    // Ideal Postcodes Postcode Lookup API
    // Docs: https://docs.ideal-postcodes.co.uk/docs/api/postcodes
    const url = `https://api.ideal-postcodes.co.uk/v1/postcodes/${encodeURIComponent(
      pc
    )}?api_key=${encodeURIComponent(apiKey)}`;

    const r = await fetch(url, { method: "GET" });

    // Ideal Postcodes returns 404 with JSON body containing `suggestions`
    if (!r.ok) {
      let j: any = null;
      try {
        j = await r.json();
      } catch {
        j = null;
      }

      const suggestions = Array.isArray(j?.suggestions) ? j.suggestions : [];
      const msg =
        j?.message ||
        j?.error ||
        (r.status === 404 ? "Postcode not found." : `Lookup failed (${r.status}).`);

      return res.status(200).json({ ok: false, error: msg, suggestions });
    }

    const data: any = await r.json();
    const results: any[] = Array.isArray(data?.result) ? data.result : [];

    // Format for dropdown display
    const addresses: string[] = results.map((a: any) => {
      const line1 = (a?.line_1 || "").trim();
      const line2 = (a?.line_2 || "").trim();
      const line3 = (a?.line_3 || "").trim();
      const town = (a?.post_town || "").trim();
      const postcode = (a?.postcode || pc).trim();

      const parts = [line1, line2, line3, town].filter(Boolean);
      return `${parts.join(", ")}, ${postcode}`;
    });

    return res.status(200).json({ ok: true, addresses });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
