import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE || "" // server-side only
);

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { name, contentBase64, sessionId } = req.body || {};
    if (!name || !contentBase64) {
      return res.status(400).json({ ok: false, error: "Missing file" });
    }

    const arrayBuffer = Buffer.from(contentBase64, "base64");
    const path = `${sessionId || "anon"}/${Date.now()}-${name}`;

    const { error } = await supabase.storage.from("uploads").upload(path, arrayBuffer, {
      contentType: guessMime(name),
      upsert: false,
    });
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const { data: pub } = supabase.storage.from("uploads").getPublicUrl(path);
    return res.status(200).json({ ok: true, url: pub.publicUrl });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Upload failed" });
  }
}

function guessMime(filename: string) {
  const f = filename.toLowerCase();
  if (f.endsWith(".pdf")) return "application/pdf";
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}
