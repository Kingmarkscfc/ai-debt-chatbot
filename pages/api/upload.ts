import type { NextApiRequest, NextApiResponse } from "next";
import Busboy from "busboy";
import { createClient } from "@supabase/supabase-js";

type UploadResp =
  | { ok: true; url: string; filename: string; mimeType?: string; size?: number }
  | { ok: false; error: string };

export const config = {
  api: {
    bodyParser: false, // we stream with Busboy
  },
};

function bufferFromChunks(chunks: Buffer[]) {
  return Buffer.concat(chunks);
}

function extFromFilename(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function safeBaseName(name: string) {
  const dot = name.lastIndexOf(".");
  const base = dot >= 0 ? name.slice(0, dot) : name;
  return base.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 80) || "upload";
}

function uniqueKey(opts: {
  sessionId?: string;
  origName: string;
}) {
  const { sessionId, origName } = opts;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const ext = extFromFilename(origName);
  const base = safeBaseName(origName);
  const sid = sessionId?.replace(/[^a-zA-Z0-9_\-\.]/g, "") || "anon";
  return `sessions/${sid}/${base}__${stamp}__${rand}${ext || ""}`;
}

function makePublicUrl(bucket: string, key: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${bucket}/${encodeURI(key)}`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<UploadResp>
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({
      ok: false,
      error: "Supabase environment not configured on server.",
    });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  try {
    const busboy = Busboy({ headers: req.headers });
    let fileReceived = false;
    let fileBuffer: Buffer | null = null;
    let fileInfo: { filename: string; mimeType?: string; size?: number } = {
      filename: "",
    };
    let sessionId: string | undefined;

    busboy.on("field", (name, val) => {
      if (name === "sessionId") sessionId = String(val || "").slice(0, 200);
    });

    busboy.on("file", (_name, file, info) => {
      const { filename, mimeType } = info;
      fileReceived = true;

      const chunks: Buffer[] = [];
      let size = 0;

      file.on("data", (d: Buffer) => {
        chunks.push(d);
        size += d.length;
      });

      file.on("end", () => {
        fileBuffer = bufferFromChunks(chunks);
        fileInfo = { filename, mimeType, size };
      });
    });

    busboy.on("finish", async () => {
      if (!fileReceived || !fileBuffer || !fileInfo.filename) {
        return res.status(400).json({ ok: false, error: "No file received." });
      }

      const bucket = "uploads"; // <- ensure this bucket exists & is public
      const objectKey = uniqueKey({
        sessionId,
        origName: fileInfo.filename,
      });

      // Upload to Supabase Storage
      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(objectKey, fileBuffer as Buffer, {
          contentType: fileInfo.mimeType || "application/octet-stream",
          upsert: false,
        });

      if (upErr) {
        return res.status(500).json({ ok: false, error: upErr.message });
      }

      // Ensure bucket is public or use signed URL; here we assume **public** bucket.
      const url = makePublicUrl(bucket, objectKey);

      return res.status(200).json({
        ok: true,
        url,
        filename: fileInfo.filename,
        mimeType: fileInfo.mimeType,
        size: fileInfo.size,
      });
    });

    req.pipe(busboy);
  } catch (e: any) {
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "Upload failed." });
  }
}
