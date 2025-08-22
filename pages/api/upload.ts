// pages/api/upload.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: false }, // required for multipart/form-data
};

// Use the SERVICE-ROLE key on the server so we can create buckets if missing
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "") // fallback if you haven't set service key yet
);

const BUCKET = process.env.NEXT_PUBLIC_UPLOADS_BUCKET || "uploads";

type FileInfo = {
  filename: string;
  mimeType: string;
  encoding: string;
};

function sanitizeFilename(name: string) {
  const trimmed = name.trim().replace(/[/\\]+/g, "_");
  return trimmed.replace(/[^a-zA-Z0-9.\-_]/g, "_").slice(0, 180) || "upload.bin";
}

async function ensureBucket() {
  // Try to get; if missing, create public bucket
  const { data, error } = await supabase.storage.getBucket(BUCKET);
  if (!data || error) {
    const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: "50MB",
    });
    if (createErr) throw new Error(`Failed to create bucket "${BUCKET}": ${createErr.message}`);
  }
}

function parseMultipart(
  req: NextApiRequest
): Promise<{ buffer: Buffer; filename: string; mimeType: string; sessionId?: string }> {
  return new Promise(async (resolve, reject) => {
    try {
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
    } catch (err) {
      reject(err);
    }
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { buffer, filename, mimeType, sessionId } = await parseMultipart(req);

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ ok: false, error: "No file received" });
    }

    await ensureBucket();

    const safeSession = (sessionId || "unknown").slice(0, 64);
    const ts = Date.now();
    const cleanName = sanitizeFilename(filename);
    const path = `sessions/${safeSession}/${ts}-${cleanName}`;

    // Upload
    const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(path, buffer, {
      contentType: mimeType || "application/octet-stream",
      upsert: false,
      cacheControl: "3600",
    });

    if (uploadErr) {
      console.error("Supabase upload error:", uploadErr);
      return res.status(500).json({ ok: false, error: "Upload failed", details: uploadErr.message });
    }

    // Build a download URL
    // If bucket is public, getPublicUrl will be a clean, permanent link.
    // If it's private, we’ll sign a 7-day URL.
    let downloadUrl: string | null = null;

    const pub = await supabase.storage.from(BUCKET).getPublicUrl(path);
    if (pub?.data?.publicUrl) {
      downloadUrl = pub.data.publicUrl;
    } else {
      const { data: signed, error: signErr } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(path, 60 * 60 * 24 * 7); // 7 days

      if (signErr) {
        console.warn("Could not sign URL:", signErr.message);
      } else {
        downloadUrl = signed?.signedUrl || null;
      }
    }

    return res.status(200).json({
      ok: true,
      file: { filename: cleanName, mimeType, size: buffer.length },
      bucket: BUCKET,
      path,
      downloadUrl,
      message: downloadUrl ? "Upload completed." : "Upload completed (no public URL).",
    });
  } catch (err: any) {
    console.error("Upload API error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Unexpected error", details: String(err?.message || err) });
  }
}
