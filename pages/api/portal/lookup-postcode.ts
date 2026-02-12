// pages/api/address-lookup.ts
// Proxy endpoint for UK postcode address lookup (getAddress.io if configured)

export default async function handler(req: any, res: any) {
  try {
    if (req.method && !["GET","POST"].includes(String(req.method).toUpperCase())) {
      return res.status(405).json({ ok:false, error:"Method not allowed." });
    }

    const q = req.query || {};
    const b = (req.body && typeof req.body === "object") ? req.body : {};
    const raw = (q.postcode ?? q.pc ?? q.q ?? b.postcode ?? b.pc ?? b.q ?? "").toString();
    const pc = raw.trim().toUpperCase();

    const ukRe = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
    if (!pc || !ukRe.test(pc)) {
      return res.status(400).json({ ok:false, error:"Invalid UK postcode." });
    }

    const key = (
      process.env.GETADDRESS_API_KEY ||
      process.env.GETADDRESSIO_API_KEY ||
      process.env.GETADDRESS_IO_API_KEY ||
      process.env.GETADDRESS_APIKEY
    );
    if (!key) {
      return res.status(200).json({
        ok: false,
        error:
          "Address lookup not configured. Set GETADDRESS_API_KEY (getAddress.io) in .env.local and in Vercel environment variables.",
      });
    }

    // getAddress.io – https://getaddress.io
    const url = `https://api.getaddress.io/find/${encodeURIComponent(pc)}?expand=true&api-key=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text().catch(()=>String(r.status));
      return res.status(200).json({ ok:false, error:`Lookup failed (${r.status}): ${txt}` });
    }
    const data: any = await r.json();

    const addresses = Array.isArray(data?.addresses) ? data.addresses.map((a: any) => {
      // Normalise a few common fields
      const line1 = a?.line_1 || a?.thoroughfare || a?.building_number || "";
      const line2 = a?.line_2 || a?.sub_building_name || a?.dependent_locality || "";
      const city  = a?.town_or_city || a?.post_town || a?.locality || "";
      return { line1, line2, city, postcode: data?.postcode || pc };
    }) : [];

    return res.status(200).json({ ok:true, addresses });
  } catch (e: any) {
    return res.status(200).json({ ok:false, error:String(e?.message || e) });
  }
}
