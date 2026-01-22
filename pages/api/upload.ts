// pages/api/upload.ts
import type { NextApiRequest, NextApiResponse } from "next";
import Busboy from "busboy";
import { createClient } from "@supabase/supabase-js";

type UploadResp =
  | { ok: true; url: string; filename: string; mimeType?: string; size?: number }
  | { ok: false; error: string };

export const config = {
  api: { bodyParser: false },
};

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing Supabase env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<UploadResp>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const supabase = getSupabase();

  try {
    const { fields, file } = await parseMultipart(req);
    if (!file) {
      return res.status(400).json({ ok: false, error: "No file received" });
    }

    const sessionId = (fields.sessionId as string) || "anon";
    const origName = (file.filename as string) || "upload.bin";
    const safeName = origName.replace(/[^\w.\-]+/g, "_");
    const ext = extFromFilename(safeName);
    const objectKey = `${sessionId}/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;

    const bucket = "uploads"; // make sure this exists and is public in Supabase

    const { error } = await supabase.storage.from(bucket).upload(objectKey, file.buffer, {
      contentType: file.mimeType || "application/octet-stream",
      upsert: false,
    });
    if (error) throw error;

    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(objectKey);
    const url = pub?.publicUrl || "";

    return res.status(200).json({
      ok: true,
      url,
      filename: safeName,
      mimeType: file.mimeType,
      size: file.size,
    });
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: e?.message || "Upload failed" });
  }
}

/* ---------------- helpers ---------------- */

function extFromFilename(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function parseMultipart(req: NextApiRequest): Promise<{
  fields: Record<string, unknown>;
  file: { filename: string; mimeType?: string; size: number; buffer: Buffer } | null;
}> {
  return new Promise((resolve, reject) => {
    try {
      const bb = Busboy({ headers: req.headers as Record<string, string> });
      const fields: Record<string, unknown> = {};
      const fileBufs: Buffer[] = [];
      let fileSize = 0;
      let fileMeta: { filename: string; mimeType?: string } | null = null;

      bb.on("field", (name, val) => {
        fields[name] = val;
      });

      bb.on("file", (_name, stream, info) => {
        fileMeta = { filename: info.filename, mimeType: info.mimeType };
        stream.on("data", (d: Buffer) => {
          fileBufs.push(d);
          fileSize += d.length;
        });
        stream.on("limit", () => {
          reject(new Error("File too large"));
          stream.resume();
        });
      });

      bb.on("error", (err) => reject(err));
      bb.on("finish", () => {
        const buffer = Buffer.concat(fileBufs);
        resolve({
          fields,
          file: fileMeta
            ? { filename: fileMeta.filename, mimeType: fileMeta.mimeType, size: buffer.length, buffer }
            : null,
        });
      });

      (req as any).pipe(bb);
    } catch (e) {
      reject(e);
    }
  });
}

