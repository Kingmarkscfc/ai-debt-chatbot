import { useEffect, useMemo, useRef, useState } from "react";

type Sender = "user" | "bot";
type Attachment = { filename: string; url: string; mimeType?: string; size?: number };
type Message = { sender: Sender; text: string; attachment?: Attachment };

const LANGUAGES = ["English","Spanish","Polish","French","German","Portuguese","Italian","Romanian"];

// cache-bust v=2 so browsers fetch the new file
const AVATAR_SRC = "/advisor-avatar-human.png?v=2";

function ensureSessionId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  const key = "da_session_id";
  let sid = localStorage.getItem(key);
  if (!sid) { sid = Math.random().toString(36).slice(2); localStorage.setItem(key, sid); }
  return sid;
}

function formatBytes(n?: number) {
  if (typeof n !== "number") return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB","MB","GB"]; let i=-1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

function pickUkMaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices?.length) return null;
  const preferred = [
    "Google UK English Male",
    "Microsoft Ryan Online (Natural) - English (United Kingdom)",
    "Daniel",
    "UK English Male",
  ];
  for (const name of preferred) { const v = voices.find((vv) => vv.name === name); if (v) return v; }
  const enGb = voices.find((v) => (v.lang || "").toLowerCase().startsWith("en-gb")); if (enGb) return enGb;
  const enAny = voices.find((v) => (v.lang || "").toLowerCase().startsWith("en-")); return enAny || null;
}

// Minimal avatar that ONLY uses the PNG; on error shows a "Missing" badge
function Avatar({ size = 40 }: { size?: number }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <div
        style={{
          width: size, height: size, borderRadius: "50%", background: "#eee",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#555", fontSize: 10, border: "1px solid #ddd"
        }}
        title="Missing avatar"
      >
        Missing
      </div>
    );
  }
  return (
    <img
      src={AVATAR_SRC}
      alt=""
      onError={() => setErr(true)}
      decoding="async"
      loading="eager"
      style={{
        width: size,
        height: size,
        display: "block",
        borderRadius: "999px",
        objectFit: "cover",
        background: "#e5e7eb",
        boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
      }}
    />
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState<string>("English");
  const [uploading, setUploading] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const sessionId = useMemo(() => ensureSessionId(), []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chosenVoice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    const savedTheme = typeof window !== "undefined" ? localStorage.getItem("da_theme") : null;
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme as "light" | "dark");
    setMessages([
      { sender: "bot", text: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
      { sender: "bot", text: "🌍 You can change languages any time using the dropdown above." },
    ]);
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const assign = () => { chosenVoice.current = pickUkMaleVoice(window.speechSynthesis.getVoices()); };
    const vs = window.speechSynthesis.getVoices();
    if (vs?.length) assign(); else window.speechSynthesis.onvoiceschanged = assign;
  }, []);

  useEffect(() => {
    if (!voiceOn) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const last = messages[messages.length - 1];
    if (!last || last.sender !== "bot") return;
    const u = new SpeechSynthesisUtterance(last.text);
    if (chosenVoice.current) u.voice = chosenVoice.current;
    u.rate = 1; u.pitch = 1; u.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, [messages, voiceOn]);

  const sendToApi = async (text: string, hist: Message[]) => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, userMessage: text, history: hist.map(m => m.text), language }),
    });
    return res.json();
  };

  const handleSubmit = async () => {
    const text = input.trim(); if (!text) return;
    setInput("");
    const userMsg: Message = { sender: "user", text };
    const nextHist = [...messages, userMsg];
    setMessages(nextHist);
    try {
      const data = await sendToApi(text, nextHist);
      const reply = (data?.reply as string) || "Thanks — let’s continue.";
      setMessages(prev => [...prev, { sender: "bot", text: reply }]);
    } catch {
      setMessages(prev => [...prev, { sender: "bot", text: "⚠️ I couldn’t reach the server just now." }]);
    }
  };

  const handleLanguageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = e.target.value;
    setLanguage(selected);
    const msg = `Language: ${selected}`;
    const userMsg: Message = { sender: "user", text: msg };
    const nextHist = [...messages, userMsg];
    setMessages(nextHist);
    try { await sendToApi(msg, nextHist); } catch {}
  };

  const handleUploadClick = () => fileInputRef.current?.click();
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("sessionId", sessionId);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await r.json();
      if (!data?.ok) {
        const msg = `Upload failed — ${data?.details || data?.error || "please try again."}`;
        setMessages(prev => [...prev, { sender: "bot", text: msg }]); return;
      }
      const cleanName = data?.file?.filename || file.name;
      const link = data?.downloadUrl || data?.url || "";
      const attach: Attachment | undefined = link ? { filename: cleanName, url: link, mimeType: data?.file?.mimeType, size: data?.file?.size } : undefined;
      setMessages(prev => [...prev, { sender: "bot", text: link ? `📎 Uploaded: ${cleanName}` : `📎 Uploaded your file (${cleanName}).`, attachment: attach }]);
    } catch {
      setMessages(prev => [...prev, { sender: "bot", text: "Upload failed — network error." }]);
    } finally {
      setUploading(false); if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const toggleTheme = () => {
    setTheme(t => { const next = t === "dark" ? "light" : "dark"; if (typeof window !== "undefined") localStorage.setItem("da_theme", next); return next; });
  };

  const isDark = theme === "dark";
  const styles: { [k: string]: React.CSSProperties } = {
    frame: { maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "'Segoe UI', Arial, sans-serif", background: isDark ? "#0b1220" : "#f3f4f6", minHeight: "100vh", color: isDark ? "#e5e7eb" : "#111827" },
    card: { border: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb", borderRadius: 16, background: isDark ? "#111827" : "#ffffff", boxShadow: isDark ? "0 8px 24px rgba(0,0,0,0.45)" : "0 8px 24px rgba(0,0,0,0.06)", overflow: "hidden" },
    header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb", background: isDark ? "#0f172a" : "#fafafa" },
    brand: { display: "flex", alignItems: "center", gap: 10, fontWeight: 700 },
    onlineDot: { marginLeft: 8, fontSize: 12, color: "#10b981", fontWeight: 600 },
    tools: { display: "flex", alignItems: "center", gap: 8 },
    select: { padding: "6px 10px", borderRadius: 8, border: isDark ? "1px solid #374151" : "1px solid #d1d5db", background: isDark ? "#111827" : "#fff", color: isDark ? "#e5e7eb" : "#111827" },
    btn: { padding: "6px 10px", borderRadius: 8, border: isDark ? "1px solid #374151" : "1px solid #d1d5db", background: isDark ? "#111827" : "#fff", color: isDark ? "#e5e7eb" : "#111827", cursor: "pointer" },
    chat: { height: 520, overflowY: "auto", padding: 16, background: isDark ? "linear-gradient(#0b1220, #0f172a)" : "linear-gradient(#ffffff, #fafafa)", display: "flex", flexDirection: "column", gap: 12 },
    row: { display: "flex", alignItems: "flex-start", gap: 10 },
    rowUser: { justifyContent: "flex-end" },
    avatarWrap: { width: 40, height: 40, borderRadius: "50%", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" },
    bubble: { padding: "10px 14px", borderRadius: 14, maxWidth: "70%", lineHeight: 1.45, boxShadow: isDark ? "0 2px 10px rgba(0,0,0,0.5)" : "0 2px 10px rgba(0,0,0,0.06)" },
    bubbleBot: { background: isDark ? "#1f2937" : "#f3f4f6", color: isDark ? "#e5e7eb" : "#111827", borderTopLeftRadius: 6 },
    bubbleUser: { background: isDark ? "#1d4ed8" : "#dbeafe", color: isDark ? "#e5e7eb" : "#0f172a", borderTopRightRadius: 6 },
    attach: { marginTop: 8 },
    chip: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, padding: "6px 10px", background: isDark ? "#0b1220" : "#fff", border: isDark ? "1px solid #374151" : "1px solid #e5e7eb", borderRadius: 999 },
    footer: { display: "flex", alignItems: "center", gap: 8, padding: 12, borderTop: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb", background: isDark ? "#0f172a" : "#fafafa" },
    fileBtn: { padding: "8px 12px", borderRadius: 8, border: isDark ? "1px solid #374151" : "1px solid #d1d5db", background: isDark ? "#111827" : "#fff", color: isDark ? "#e5e7eb" : "#111827", cursor: "pointer" },
    input: { flex: 1, padding: "10px 12px", borderRadius: 8, border: isDark ? "1px solid #374151" : "1px solid #d1d5db", fontSize: 16, background: isDark ? "#111827" : "#fff", color: isDark ? "#e5e7eb" : "#111827" },
    sendBtn: { padding: "10px 14px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontWeight: 600 },
  };

  return (
    <main style={styles.frame}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.brand}>
            {/* key forces remount when AVATAR_SRC changes */}
            <div style={styles.avatarWrap}><Avatar key={AVATAR_SRC} /></div>
            <span>Debt Advisor</span>
            <span style={styles.onlineDot}>● Online</span>
          </div>
          <div style={styles.tools}>
            <select style={styles.select} value={language} onChange={handleLanguageChange} title="Change language">
              {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <button type="button" style={styles.btn} onClick={() => setVoiceOn(v => !v)} title="Toggle voice">
              {voiceOn ? "🔈 Voice On" : "🔇 Voice Off"}
            </button>
            <button type="button" style={styles.btn} onClick={toggleTheme} title="Toggle theme">
              {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
            </button>
          </div>
        </div>

        {/* Messages */}
        <div style={styles.chat}>
          {messages.map((m, i) => {
            const isUser = m.sender === "user";
            return (
              <div key={i} style={{ ...styles.row, ...(isUser ? styles.rowUser : {}) }}>
                {!isUser && <div style={styles.avatarWrap}><Avatar key={`bot-${AVATAR_SRC}`} /></div>}
                <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleBot) }}>
                  <div>{m.text}</div>
                  {m.attachment && (
                    <div style={styles.attach}>
                      <a href={m.attachment.url} target="_blank" rel="noreferrer" style={styles.chip}>
                        <span>📄</span>
                        <span style={{ fontWeight: 600 }}>{m.attachment.filename}</span>
                        {typeof m.attachment.size === "number" && <span style={{ opacity: 0.7 }}>({formatBytes(m.attachment.size)})</span>}
                        <span style={{ textDecoration: "underline" }}>Download</span>
                      </a>
                    </div>
                  )}
                </div>
                {isUser && <div style={styles.avatarWrap}><Avatar key={`user-${AVATAR_SRC}`} /></div>}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <input ref={fileInputRef} type="file" hidden onChange={handleFileSelected} />
          <button type="button" style={styles.fileBtn} onClick={handleUploadClick} disabled={uploading}>
            📎 Upload docs {uploading ? "…" : ""}
          </button>
          <input
            style={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="Type your message…"
          />
          <button type="button" style={styles.sendBtn} onClick={handleSubmit}>Send</button>
        </div>
      </div>
    </main>
  );
}
