// pages/api/upload.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: false }, // important for multipart/form-data
};

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

type FileInfo = {
  filename: string;
  mimeType: string;
  encoding: string;
};

function parseMultipart(
  req: NextApiRequest
): Promise<{ buffer: Buffer; filename: string; mimeType: string; sessionId?: string }> {
  return new Promise(async (resolve, reject) => {
    const { default: Busboy } = await import("busboy");
    const bb = Busboy({ headers: req.headers });

    const chunks: Buffer[] = [];
    let filename = "upload.bin";
    let mimeType = "application/octet-stream";
    let sessionId: string | undefined;

    bb.on("file", (_name: string, file: NodeJS.ReadableStream, info: FileInfo) => {
      filename = info?.filename || filename;
      mimeType = info?.mimeType || mimeType;

      file.on("data", (d: Buffer) => chunks.push(d));
      file.on("error", (err: unknown) => reject(err));
    });

    bb.on("field", (name: string, val: string) => {
      if (name === "sessionId") sessionId = val;
    });

    bb.on("error", (err: unknown) => reject(err));

    bb.on("finish", () => {
      const buffer = Buffer.concat(chunks);
      resolve({ buffer, filename, mimeType, sessionId });
    });

    req.pipe(bb);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { buffer, filename, mimeType, sessionId } = await parseMultipart(req);

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ ok: false, error: "No file received" });
    }

    const safeSession = sessionId || "unknown";
    const ts = Date.now();
    const path = `sessions/${safeSession}/${ts}-${filename}`;

    // Upload to Supabase Storage
    const { error: uploadErr } = await supabase.storage
      .from("uploads")
      .upload(path, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadErr) {
      console.error("Supabase upload error:", uploadErr);
      return res.status(500).json({ ok: false, error: "Upload failed", details: uploadErr.message });
    }

    // Public URL (bucket must be public or have a public policy)
    const { data: pub } = supabase.storage.from("uploads").getPublicUrl(path);
    const downloadUrl = pub?.publicUrl || null;

    return res.status(200).json({
      ok: true,
      file: { filename, mimeType, size: buffer.length },
      path,
      downloadUrl,
      message: downloadUrl
        ? "Upload completed."
        : "Upload completed, but I couldn’t fetch the download link. I’ll still store it.",
    });
  } catch (err: any) {
    console.error("Upload API error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Unexpected error", details: String(err?.message || err) });
  }
}
