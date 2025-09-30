// pages/api/portal/documents.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
);

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method not allowed" });
  try {
    const sessionId = String(req.query.sessionId || "");
    if (!sessionId) return res.status(400).json({ ok:false, error:"Missing sessionId" });

    const { data, error } = await supabase
      .from("documents")
      .select("id, file_name, file_url, uploaded_at")
      .eq("session_id", sessionId)
      .order("uploaded_at", { ascending: false });

    if (error) return res.status(500).json({ ok:false, error:error.message });
    return res.status(200).json({ ok:true, documents: data || [] });
  } catch (e: any) {
    console.error("documents crash:", e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
