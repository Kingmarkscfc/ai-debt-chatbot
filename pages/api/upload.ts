import type { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: {
    bodyParser: false, // we'll read FormData manually
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  // Minimal read of multipart form; we don’t persist to disk here
  try {
    // Just acknowledge (we could parse with busboy/formidable if needed)
    return res.status(200).json({ ok: true, note: "Upload acknowledged" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Upload failed" });
  }
}
