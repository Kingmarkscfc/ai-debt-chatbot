import type { NextApiRequest, NextApiResponse } from "next";
import Busboy from "busboy";
import { supabaseAdmin } from "../../../utils/supabaseAdmin";

type UploadResp =
  | { ok: true; url: string; filename: string; mimeType?: string; size?: number }
  | { ok: false; error: string };

export const config = {
  api: {
    bodyParser: false, // we'll handle multipart manually
  },
};

function sanitizeFilename(name: string) {
  const trimmed = name?.trim() || "file";
  const safe = trimmed.replace(/[^\w.\-()+\[\] ]+/g, "_");
  return safe.length > 120 ? safe.slice(-120) : safe;
}

function readMultipart(req: NextApiRequest): Promise<{
  fields: Record<string, string>;
  file?: { buffer: Buffer; filename: string; mimeType?: string; size: number };
}> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields: Record<string, string> = {};
    let fileBufs: Buffer[] = [];
    let fileInfo:
      | { filename: string; mimeType?: string; size: number }
      | undefined;

    bb.on("field", (name, val) => {
      fields[name] = val;
    });

    bb.on("file", (_name, stream, info) => {
      const { filename, mimeType } = info;
      fileInfo = { filename: filename || "upload", mimeType, size: 0 };
      stream.on("data", (chunk: Buffer) => {
        fileBufs.push(chunk);
        fileInfo!.size += chunk.length;
      });
      stream.on("limit", () => {
        // optional: enforce a limit in Busboy options if you want
      });
      stream.on("end", () => {});
    });

    bb.on("error", (err) => reject(err));
    bb.on("close", () => {
      const buffer = fileBufs.length ? Buffer.concat(fileBufs) : undefined;
      if (buffer && fileInfo) {
        resolve({
          fields,
          file: { buffer, ...fileInfo },
        });
      } else {
        resolve({ fields });
      }
    });

    req.pipe(bb);
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<UploadResp>
) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const { fields, file } = await readMultipart(req);
    const sessionId = (fields.sessionId || "").trim();
    const email = (fields.email || "").trim().toLowerCase();

    if (!sessionId) {
      res.status(400).json({ ok: false, error: "Missing sessionId" });
      return;
    }
    if (!file) {
      res.status(400).json({ ok: false, error: "No file received" });
      return;
    }

    const bucket = "client-uploads";
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const safeName = sanitizeFilename(file.filename);
    const objectPath = `${sessionId}/${stamp}_${safeName}`;

    // 1) Upload to Supabase Storage
    const { error: upErr } = await supabaseAdmin.storage
      .from(bucket)
      .upload(objectPath, file.buffer, {
        contentType: file.mimeType || "application/octet-stream",
        upsert: false,
      });

    if (upErr) {
      res.status(500).json({ ok: false, error: `Upload failed: ${upErr.message}` });
      return;
    }

    // 2) Get a public URL (no error prop in v2 types)
    const { data: pub } = supabaseAdmin.storage.from(bucket).getPublicUrl(objectPath);
    const publicUrl = pub?.publicUrl || "";

    // 3) Record in DB (optional but recommended)
    // Table: portal_documents(email text, session_id text, client_ref text, filename text, url text, mime_type text, size int, created_at timestamptz default now())
    // If you don’t have client_ref yet, you can look it up later from link-session.
    await supabaseAdmin
      .from("portal_documents")
      .insert({
        email: email || null,
        session_id: sessionId,
        client_ref: null,
        filename: safeName,
        url: publicUrl,
        mime_type: file.mimeType || null,
        size: file.size || null,
      });

    res.status(200).json({
      ok: true,
      url: publicUrl,
      filename: safeName,
      mimeType: file.mimeType,
      size: file.size,
    });
  } catch (e: any) {
    res.status(500).json({
      ok: false,
      error: e?.message || "Upload error",
    });
  }
}
