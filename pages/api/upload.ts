import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

export const config = {
  api: {
    bodyParser: false, // we'll read the stream via formidable-like approach (FormData from client)
  },
};

async function readFormData(req: NextApiRequest): Promise<{ file: Buffer; filename: string; sessionId?: string } | null> {
  // Next.js API routes don't parse multipart; but fetch with FormData sends
  // a stream we can read using 'busboy' or a minimal manual approach. To keep
  // this self-contained, we'll use a tiny dynamic import of 'busboy'.
  const { default: Busboy } = await import("busboy");
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let chunks: Buffer[] = [];
    let filename = "upload.bin";
    let sessionId: string | undefined;

    bb.on("file", (_name, file, info) => {
      filename = info.filename || filename;
      file.on("data", (d: Buffer) => chunks.push(d));
    });

    bb.on("field", (name, val) => {
      if (name === "sessionId") sessionId = val;
    });

    bb.on("close", () => {
      const buf = Buffer.concat(chunks);
      resolve({ file: buf, filename, sessionId });
    });

    bb.on("error", reject);
    req.pipe(bb);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const parsed = await readFormData(req);
    if (!parsed) return res.status(400).json({ error: "No file" });

    const { file, filename, sessionId } = parsed;

    const path = `${sessionId || "anonymous"}/${Date.now()}_${filename}`;
    const { error: upErr } = await supabase.storage.from("documents").upload(path, file, {
      contentType: "application/octet-stream",
      upsert: false,
    });
    if (upErr) {
      return res.status(500).json({ error: "Upload failed", details: upErr.message });
    }

    const { data: pub } = supabase.storage.from("documents").getPublicUrl(path);
    const url = pub?.publicUrl;

    return res.status(200).json({
      ok: true,
      fileName: filename,
      url: url || null,
      path,
    });
  } catch (e: any) {
    return res.status(500).json({ error: "Unexpected error", details: e?.message || String(e) });
  }
}
