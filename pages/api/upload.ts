// pages/api/upload.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// Make sure you have a public Storage bucket named "documents" in Supabase.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { sessionId, fileName, contentBase64, contentType } = req.body || {};
    if (!sessionId || !fileName || !contentBase64) {
      return res.status(400).json({ error: "Missing sessionId, fileName or contentBase64" });
    }

    // Decode base64 to Uint8Array
    const base64 = contentBase64.split(",").pop() || contentBase64;
    const buffer = Buffer.from(base64, "base64");
    const path = `${sessionId}/${uuidv4()}-${fileName}`;

    const { error: uploadErr } = await supabase
      .storage
      .from("documents")
      .upload(path, buffer, {
        contentType: contentType || "application/octet-stream",
        upsert: false
      });

    if (uploadErr) {
      console.error("Supabase upload error:", uploadErr);
      return res.status(500).json({ error: "Upload failed" });
    }

    const { data: publicUrl } = supabase
      .storage
      .from("documents")
      .getPublicUrl(path);

    return res.status(200).json({
      ok: true,
      url: publicUrl.publicUrl,
      path
    });
  } catch (e: any) {
    console.error("Upload API error:", e?.message || e);
    return res.status(500).json({ error: "Server error" });
  }
}
