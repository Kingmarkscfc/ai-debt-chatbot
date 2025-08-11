import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

// Init Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_ANON_KEY as string
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { session_id, event_type, payload } = req.body;

    if (!session_id || !event_type) {
      return res.status(400).json({ error: "Missing session_id or event_type" });
    }

    const { error } = await supabase
      .from("chat_telemetry")
      .insert([{ session_id, event_type, payload }]);

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ error: "Database insert failed" });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Telemetry API error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
