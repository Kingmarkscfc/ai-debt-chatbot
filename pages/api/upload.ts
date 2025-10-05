// pages/api/upload.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

type FileInfo = { filename: string; mimeType: string; encoding: string };

function parseMultipart(req: NextApiRequest): Promise<{
  buffer: Buffer;
  filename: string;
  mimeType: string;
  sessionId?: string;
  category?: string;
  creditor?: string;
  debt_ref?: string;
}> {
  return new Promise(async (resolve, reject) => {
    const { default: Busboy } = await import("busboy");
    const bb = Busboy({ headers: req.headers });

    const chunks: Buffer[] = [];
    let filename = "upload.bin";
    let mimeType = "application/octet-stream";
    let sessionId: string | undefined;
    let category: string | undefined;
    let creditor: string | undefined;
    let debt_ref: string | undefined;

    bb.on("file", (_name: string, file: NodeJS.ReadableStream, info: FileInfo) => {
      filename = info?.filename || filename;
      mimeType = info?.mimeType || mimeType;
      file.on("data", (d: Buffer) => chunks.push(d));
      file.on("error", (err: unknown) => reject(err));
    });

    bb.on("field", (name: string, val: string) => {
      if (name === "sessionId") sessionId = val;
      if (name === "category") category = val;
      if (name === "creditor") creditor = val;
      if (name === "debt_ref") debt_ref = val;
    });

    bb.on("error", (err: unknown) => reject(err));
    bb.on("finish", () => {
      const buffer = Buffer.concat(chunks);
      resolve({ buffer, filename, mimeType, sessionId, category, creditor, debt_ref });
    });

    req.pipe(bb);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { buffer, filename, mimeType, sessionId, category, creditor, debt_ref } = await parseMultipart(req);
    if (!buffer?.length) return res.status(400).json({ ok:false, error:"No file received" });

    const safeSession = sessionId || "unknown";
    const ts = Date.now();
    const path = `sessions/${safeSession}/${ts}-${filename}`;

    const { error: uploadErr } = await supabase.storage
      .from("uploads")
      .upload(path, buffer, { contentType: mimeType, upsert: false });

    if (uploadErr) {
      console.error("Supabase upload error:", uploadErr);
      return res.status(500).json({ ok:false, error:"Upload failed", details: uploadErr.message });
    }

    const { data: pub } = supabase.storage.from("uploads").getPublicUrl(path);
    const downloadUrl = pub?.publicUrl || null;

    // record in DB (for Documents tab & tasks)
    if (downloadUrl) {
      const row: any = {
        session_id: safeSession,
        file_name: filename,
        file_url: downloadUrl,
      };
      if (category) row.category = category;
      if (creditor) row.creditor = creditor;
      if (debt_ref) row.debt_ref = debt_ref;

      await supabase.from("documents").insert([row]);
    }

    return res.status(200).json({
      ok: true,
      file: { filename, mimeType, size: buffer.length },
      path,
      downloadUrl,
      message: downloadUrl ? "Upload completed." : "Upload completed, but link unavailable."
    });
  } catch (err: any) {
    console.error("Upload API error:", err?.message || err);
    return res.status(500).json({ ok:false, error:"Unexpected error", details:String(err?.message || err) });
  }
}
