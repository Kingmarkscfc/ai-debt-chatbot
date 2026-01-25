import type { NextApiRequest, NextApiResponse } from "next";
import Busboy from "busboy";
import { supabaseAdmin } from "../../utils/supabaseAdmin";

// Expected storage bucket: "uploads"
// Expected table: "portal_documents"
//   columns: id (uuid, pk), email (text, nullable), session_id (text),
//            client_ref (text, nullable), url (text), filename (text),
//            mime_type (text), size (int8), created_at (timestamptz default now())

type UploadResp =
  | { ok: true; url: string; filename: string; mimeType?: string; size?: number }
  | { ok: false; error: string };

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<UploadResp>) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const { fields, file } = await readMultipart(req);
    const sessionId = (fields.sessionId || "").toString().trim();
    const email = (fields.email || "").toString().trim() || null;

    if (!sessionId) {
      res.status(400).json({ ok: false, error: "Missing sessionId" });
      return;
    }
    if (!file) {
      res.status(400).json({ ok: false, error: "Missing file" });
      return;
    }

    // Put into Storage
    const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
    const cleanName = file.filename.replace(/[^\w.\- ]+/g, "_");
    const storagePath = `${sessionId}/${nowIso}__${cleanName}`;

    const { data: putData, error: putErr } = await supabaseAdmin.storage
      .from("uploads")
      .upload(storagePath, file.buffer, {
        contentType: file.mimeType || "application/octet-stream",
        upsert: false,
      });

    if (putErr || !putData?.path) {
      res.status(500).json({ ok: false, error: "Upload failed" });
      return;
    }

    const { data: pub, error: pubErr } = supabaseAdmin.storage
      .from("uploads")
      .getPublicUrl(putData.path);
    if (pubErr) {
      res.status(500).json({ ok: false, error: "Get public URL failed" });
      return;
    }
    const publicUrl = pub.publicUrl;

    // Insert doc row
    await supabaseAdmin.from("portal_documents").insert({
      email,
      session_id: sessionId,
      client_ref: null,
      url: publicUrl,
      filename: file.filename,
      mime_type: file.mimeType,
      size: file.size ?? null,
    });

    res.status(200).json({
      ok: true,
      url: publicUrl,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "Upload error" });
  }
}

function readMultipart(req: NextApiRequest): Promise<{
  fields: Record<string, string | Buffer>;
  file?: { filename: string; mimeType?: string; buffer: Buffer; size?: number };
}> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers as any });
    const fields: Record<string, string | Buffer> = {};
    let theFile:
      | { filename: string; mimeType?: string; buffer: Buffer; size?: number }
      | undefined;

    bb.on("field", (name, val) => {
      fields[name] = val;
    });

    bb.on("file", (_name, stream, info) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (c: Buffer) => {
        chunks.push(c);
        size += c.length;
      });
      stream.on("end", () => {
        theFile = {
          filename: info.filename || "upload.bin",
          mimeType: info.mimeType || "application/octet-stream",
          buffer: Buffer.concat(chunks),
          size,
        };
      });
    });

    bb.on("error", reject);
    bb.on("close", () => resolve({ fields, file: theFile }));
    req.pipe(bb);
  });
}
