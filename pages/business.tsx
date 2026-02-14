import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";

type ClientRow = {
  session_id: string | null;
  client_ref: number | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  created_at: string | null;
};

export default function BusinessPortal() {
  const [pin, setPin] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    const ok = localStorage.getItem("business_portal_ok") === "1";
    if (ok) setAuthed(true);
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return clients;
    return clients.filter((c) => {
      const hay = `${c.client_ref ?? ""} ${c.full_name ?? ""} ${c.email ?? ""} ${c.phone ?? ""} ${c.postcode ?? ""}`.toLowerCase();
      return hay.includes(s);
    });
  }, [clients, q]);

  const fetchClients = async (pinValue: string) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/portal/clients", {
        headers: {
          "x-portal-scope": "business",
          "x-portal-pin": pinValue,
        },
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "Failed");
      setClients(j.clients || []);
      setAuthed(true);
      localStorage.setItem("business_portal_ok", "1");
    } catch (e: any) {
      setErr(e?.message || "Login failed");
      setAuthed(false);
      localStorage.removeItem("business_portal_ok");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Business Portal</title>
      </Head>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>Business Portal</h1>

        {!authed ? (
          <div style={{ border: "1px solid rgba(0,0,0,0.12)", borderRadius: 14, padding: 16, maxWidth: 420 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Enter PIN</div>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="PIN"
              type="password"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.18)" }}
            />
            <button
              onClick={() => fetchClients(pin)}
              disabled={loading || !pin.trim()}
              style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, border: "none", fontWeight: 800, cursor: "pointer" }}
            >
              {loading ? "Checking…" : "Enter"}
            </button>
            {err ? <div style={{ marginTop: 10, color: "#b91c1c", fontWeight: 700 }}>{err}</div> : null}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by ref, name, email, phone, postcode…"
                style={{ flex: 1, minWidth: 260, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.18)" }}
              />
              <button
                onClick={() => fetchClients(pin || (localStorage.getItem("business_portal_pin") || ""))}
                style={{ padding: "10px 12px", borderRadius: 10, border: "none", fontWeight: 800, cursor: "pointer" }}
              >
                Refresh
              </button>
              <button
                onClick={() => {
                  localStorage.removeItem("business_portal_ok");
                  setAuthed(false);
                }}
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.18)", fontWeight: 800, cursor: "pointer" }}
              >
                Lock
              </button>
            </div>

            <div style={{ border: "1px solid rgba(0,0,0,0.12)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "120px 220px 240px 160px 120px 1fr", gap: 0, padding: 10, fontWeight: 800, background: "rgba(0,0,0,0.04)" }}>
                <div>Client Ref</div>
                <div>Name</div>
                <div>Email</div>
                <div>Phone</div>
                <div>Postcode</div>
                <div>Session</div>
              </div>

              {filtered.map((c, idx) => (
                <div
                  key={`${c.session_id || "no"}-${idx}`}
                  style={{ display: "grid", gridTemplateColumns: "120px 220px 240px 160px 120px 1fr", gap: 0, padding: 10, borderTop: "1px solid rgba(0,0,0,0.08)" }}
                >
                  <div style={{ fontWeight: 900 }}>{c.client_ref ?? "—"}</div>
                  <div>{c.full_name ?? "—"}</div>
                  <div style={{ wordBreak: "break-word" }}>{c.email ?? "—"}</div>
                  <div>{c.phone ?? "—"}</div>
                  <div>{c.postcode ?? "—"}</div>
                  <div style={{ opacity: 0.8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{c.session_id ?? "—"}</div>
                </div>
              ))}

              {!filtered.length ? <div style={{ padding: 14, opacity: 0.8 }}>No clients yet.</div> : null}
            </div>
          </>
        )}
      </div>
    </>
  );
}
