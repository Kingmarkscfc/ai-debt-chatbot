import { useEffect, useMemo, useRef, useState } from "react";

type Sender = "user" | "bot";
type Attachment = { filename: string; url: string; mimeType?: string; size?: number };
type Message = { sender: Sender; text: string; attachment?: Attachment };

function ensureSessionId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  const key = "da_session_id";
  let sid = localStorage.getItem(key);
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    localStorage.setItem(key, sid);
  }
  return sid;
}

function formatBytes(n?: number) {
  if (typeof n !== "number") return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let i = -1;
  do { n = n / 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

// Pick a UK male voice if possible, else any en-GB/en-*.
function pickUkMaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices?.length) return null;
  const preferred = [
    "Google UK English Male",
    "Microsoft Ryan Online (Natural) - English (United Kingdom)",
    "Daniel",
    "UK English Male",
  ];
  for (const name of preferred) {
    const v = voices.find((vv) => vv.name === name);
    if (v) return v;
  }
  const enGb = voices.find((v) => (v.lang || "").toLowerCase().startsWith("en-gb"));
  if (enGb) return enGb;
  const enAny = voices.find((v) => (v.lang || "").toLowerCase().startsWith("en-"));
  return enAny || null;
}

const LANGUAGES = [
  "English",
  "Spanish",
  "Polish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Romanian",
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState<string>("English");
  const [uploading, setUploading] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);

  const sessionId = useMemo(() => ensureSessionId(), []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chosenVoice = useRef<SpeechSynthesisVoice | null>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Init: greet + tip about language dropdown
  useEffect(() => {
    const start = async () => {
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, userMessage: "👋 INITIATE", history: [] }),
        });
        const data = await res.json();
        const greeting = (data?.reply as string) || "Hello! My name’s Mark. How can I help today?";
        setMessages([
          { sender: "bot", text: greeting },
          { sender: "bot", text: "🌍 You can change languages any time using the dropdown above." },
        ]);
      } catch {
        setMessages([{ sender: "bot", text: "⚠️ Error connecting to chatbot." }]);
      }
    };
    start();
  }, [sessionId]);

  // Prepare speech voice (UK male if available)
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const assignVoice = () => {
      const vs = window.speechSynthesis.getVoices();
      chosenVoice.current = pickUkMaleVoice(vs);
    };
    const vs = window.speechSynthesis.getVoices();
    if (vs?.length) assignVoice();
    else window.speechSynthesis.onvoiceschanged = assignVoice;
  }, []);

  // Speak assistant replies
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

  const send = async (text: string) => {
    const userMsg: Message = { sender: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          userMessage: text,
          history: messages.map((m) => m.text),
        }),
      });
      const data = await res.json();
      const botText = (data?.reply as string) || "⚠️ No response from server.";
      setMessages((prev) => [...prev, { sender: "bot", text: botText }]);
    } catch {
      setMessages((prev) => [...prev, { sender: "bot", text: "⚠️ Error connecting to chatbot." }]);
    }
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await send(text);
  };

  // Language change: tell backend
  const handleLanguageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = e.target.value;
    setLanguage(selected);
    await send(`Language: ${selected}`);
  };

  // Upload handling
  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sessionId", sessionId);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await r.json();
      if (!data?.ok) {
        setMessages((prev) => [...prev, { sender: "bot", text: "Upload failed — please try again." }]);
      } else {
        const cleanName = data?.file?.filename || file.name;
        const link = data?.downloadUrl || data?.url || "";
        const msg: Message = {
          sender: "bot",
          text: link ? `📎 Uploaded: ${cleanName}` : `📎 Uploaded your file (${cleanName}).`,
          attachment: link ? { filename: cleanName, url: link, mimeType: data?.file?.mimeType, size: data?.file?.size } : undefined,
        };
        setMessages((prev) => [...prev, msg]);
      }
    } catch {
      setMessages((prev) => [...prev, { sender: "bot", text: "Upload failed — network error." }]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // --- Styles (kept simple + professional, no libs) ---
  const styles: { [k: string]: React.CSSProperties } = {
    frame: { maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "'Segoe UI', Arial, sans-serif" },
    card: {
      border: "1px solid #e5e7eb",
      borderRadius: 16,
      background: "#ffffff",
      boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
      overflow: "hidden",
    },
    header: {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "12px 16px", borderBottom: "1px solid #e5e7eb", background: "#fafafa",
    },
    brand: { display: "flex", alignItems: "center", gap: 8, fontWeight: 700 },
    tools: { display: "flex", alignItems: "center", gap: 8 },
    select: { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff" },
    voiceBtn: { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" },
    chat: {
      height: 520, overflowY: "auto", padding: 16,
      background: "linear-gradient(#ffffff, #fafafa)",
      display: "flex", flexDirection: "column", gap: 12,
    },
    row: { display: "flex", alignItems: "flex-start", gap: 10 },
    rowUser: { justifyContent: "flex-end" },
    avatar: {
      width: 36, height: 36, borderRadius: "50%", display: "flex", alignItems: "center",
      justifyContent: "center", fontSize: 20, boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
    },
    bubble: { padding: "10px 14px", borderRadius: 14, maxWidth: "70%", lineHeight: 1.45, boxShadow: "0 2px 10px rgba(0,0,0,0.06)" },
    bubbleBot: { background: "#f3f4f6", color: "#111827", borderTopLeftRadius: 6 },
    bubbleUser: { background: "#dbeafe", color: "#0f172a", borderTopRightRadius: 6 },
    attach: { marginTop: 8 },
    chip: {
      display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, padding: "6px 10px",
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 999,
    },
    footer: { display: "flex", alignItems: "center", gap: 8, padding: 12, borderTop: "1px solid #e5e7eb", background: "#fafafa" },
    fileBtn: { padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" },
    input: { flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 16 },
    sendBtn: { padding: "10px 14px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontWeight: 600 },
  };

  return (
    <main style={styles.frame}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.brand}>
            <span>🤖</span>
            <span>Debt Advisor</span>
            <span style={{ marginLeft: 8, fontSize: 12, color: "#10b981", fontWeight: 600 }}>● Online</span>
          </div>
          <div style={styles.tools}>
            <select style={styles.select} value={language} onChange={handleLanguageChange} title="Change language">
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            <button style={styles.voiceBtn} onClick={() => setVoiceOn(v => !v)} title="Toggle voice">
              {voiceOn ? "🔈 Voice On" : "🔇 Voice Off"}
            </button>
          </div>
        </div>

        {/* Messages */}
        <div style={styles.chat}>
          {messages.map((m, i) => {
            const isUser = m.sender === "user";
            return (
              <div key={i} style={{ ...styles.row, ...(isUser ? styles.rowUser : {}) }}>
                {!isUser && <div style={{ ...styles.avatar, background: "#e5e7eb" }}>🤖</div>}
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
                {isUser && <div style={{ ...styles.avatar, background: "#3b82f6", color: "#fff" }}>🧑</div>}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <input ref={fileInputRef} type="file" hidden onChange={handleFileSelected} />
          <button style={styles.fileBtn} onClick={handleUploadClick} disabled={uploading}>
            📎 Upload docs {uploading ? "…" : ""}
          </button>
          <input
            style={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="Type your message…"
          />
          <button style={styles.sendBtn} onClick={handleSubmit}>Send</button>
        </div>
      </div>
    </main>
  );
}
