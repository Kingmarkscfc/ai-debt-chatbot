import { useEffect, useMemo, useRef, useState } from "react";

type ChatState = {
  step: number;
  name?: string | null;
  askedNameTries?: number;
  lastBotPrompt?: string;

  paying?: number | null;
  affordable?: number | null;

  portalOpened?: boolean;
};

type Msg = {
  id: string;
  role: "user" | "bot";
  text: string;
  ts: string;
  kind?: "text" | "upload";
  meta?: { url?: string; filename?: string };
};

function nowStamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function uid() {
  return Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}

const EMOJIS = [
  "😀","😄","😁","😅","😂","🙂","😉","😍","😘","😎","🤝","🙏",
  "👍","👏","🔥","💪","💡","✅","⚠️","❓","💬","📎","📄",
  "💷","💳","🏠","📅","🧠","✨","😬","😴","❤️"
];

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const [sessionId, setSessionId] = useState<string>("");
  const [chatState, setChatState] = useState<ChatState>({
    step: 0,
    name: null,
    askedNameTries: 0,
    lastBotPrompt: "",
    paying: null,
    affordable: null,
    portalOpened: false,
  });

  // UI toggles in your top bar
  const [language, setLanguage] = useState<string>("English");
  const [voiceOn, setVoiceOn] = useState<boolean>(false);
  const [dark, setDark] = useState<boolean>(false);

  // emoji + file upload
  const [showEmoji, setShowEmoji] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);

  // persist toggles
  useEffect(() => {
    const d = localStorage.getItem("da_dark");
    const v = localStorage.getItem("da_voice");
    const l = localStorage.getItem("da_lang");
    if (d) setDark(d === "1");
    if (v) setVoiceOn(v === "1");
    if (l) setLanguage(l);
  }, []);

  useEffect(() => {
    localStorage.setItem("da_dark", dark ? "1" : "0");
    localStorage.setItem("da_voice", voiceOn ? "1" : "0");
    localStorage.setItem("da_lang", language);
  }, [dark, voiceOn, language]);

  // session + persistence
  useEffect(() => {
    const existing = localStorage.getItem("da_sessionId");
    const sid = existing || "sess_" + uid();
    if (!existing) localStorage.setItem("da_sessionId", sid);
    setSessionId(sid);

    const storedMsgs = localStorage.getItem(`da_msgs_${sid}`);
    const storedState = localStorage.getItem(`da_state_${sid}`);
    if (storedMsgs) setMessages(JSON.parse(storedMsgs));
    if (storedState) setChatState(JSON.parse(storedState));
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    localStorage.setItem(`da_msgs_${sessionId}`, JSON.stringify(messages));
  }, [messages, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    localStorage.setItem(`da_state_${sessionId}`, JSON.stringify(chatState));
  }, [chatState, sessionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending, showEmoji]);

  const headerTitle = useMemo(() => "Debt Advisor", []);

  // Theme tokens (THIS fixes the readability issue)
  const theme = useMemo(() => {
    if (dark) {
      return {
        pageBg: "#0b1220",
        panelBg: "#0f1b33",
        border: "rgba(255,255,255,0.10)",
        text: "rgba(255,255,255,0.92)",
        subtext: "rgba(255,255,255,0.70)",
        bubbleBotBg: "#131f3a",
        bubbleBotText: "rgba(255,255,255,0.92)",
        bubbleUserBg: "#2a5bd7",
        bubbleUserText: "rgba(255,255,255,0.96)",
        inputBg: "#0f1b33",
        inputText: "rgba(255,255,255,0.92)",
        btnBg: "#17264a",
        btnText: "rgba(255,255,255,0.92)",
        chipBg: "rgba(255,255,255,0.08)",
      };
    }
    return {
      pageBg: "#f6f7fb",
      panelBg: "#ffffff",
      border: "rgba(0,0,0,0.10)",
      text: "rgba(0,0,0,0.88)",
      subtext: "rgba(0,0,0,0.62)",
      bubbleBotBg: "#ffffff",
      bubbleBotText: "rgba(0,0,0,0.88)",
      bubbleUserBg: "#e7eefc",
      bubbleUserText: "rgba(0,0,0,0.88)",
      inputBg: "#ffffff",
      inputText: "rgba(0,0,0,0.88)",
      btnBg: "#ffffff",
      btnText: "rgba(0,0,0,0.88)",
      chipBg: "rgba(0,0,0,0.06)",
    };
  }, [dark]);

  async function safeJson(r: Response) {
    try {
      return await r.json();
    } catch {
      return null;
    }
  }

  async function speakIfEnabled(text: string) {
    if (!voiceOn) return;
    try {
      // super simple browser TTS
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1;
      u.pitch = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      // ignore
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setShowEmoji(false);
    setSending(true);
    setInput("");

    const userMsg: Msg = { id: uid(), role: "user", text: trimmed, ts: nowStamp(), kind: "text" };
    setMessages((m) => [...m, userMsg]);

    const attempt = async () => {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          sessionId,
          state: chatState,
          language,
          recent: messages.slice(-10),
        }),
      });
      const data = await safeJson(r);
      return { ok: r.ok, data };
    };

    try {
      let res = await attempt();
      if (!res.ok) res = await attempt(); // 1 retry

      if (!res.ok || !res.data?.reply) throw new Error("No reply");

      const botMsg: Msg = { id: uid(), role: "bot", text: res.data.reply, ts: nowStamp(), kind: "text" };
      setMessages((m) => [...m, botMsg]);

      if (res.data?.state) setChatState(res.data.state);

      speakIfEnabled(res.data.reply);
    } catch {
      const botMsg: Msg = {
        id: uid(),
        role: "bot",
        text: "⚠️ I couldn’t reach the server just now. Please try again.",
        ts: nowStamp(),
        kind: "text",
      };
      setMessages((m) => [...m, botMsg]);
    } finally {
      setSending(false);
    }
  }

  async function uploadFile(file: File) {
    if (!sessionId) return;

    setShowEmoji(false);
    setSending(true);

    const uploadingId = uid();
    setMessages((m) => [
      ...m,
      { id: uploadingId, role: "bot", text: `Uploading ${file.name}…`, ts: nowStamp(), kind: "text" },
    ]);

    try {
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      fd.append("file", file);

      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await safeJson(r);

      if (!r.ok || !data?.ok || !data?.url) throw new Error("Upload failed");

      setMessages((m) =>
        m.map((msg) =>
          msg.id === uploadingId
            ? { ...msg, text: `Uploaded: ${file.name}`, kind: "upload", meta: { url: data.url, filename: file.name } }
            : msg
        )
      );

      // Nudge the bot so it can acknowledge + continue
      await sendMessage(`(Uploaded: ${file.name})`);
    } catch {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === uploadingId ? { ...msg, text: `⚠️ Upload failed for ${file.name}. Please try again.`, kind: "text" } : msg
        )
      );
    } finally {
      setSending(false);
    }
  }

  function openPortal() {
    // You already have a portal button. For now we just send a hint.
    // Later we’ll wire this to session->clientRef linking API.
    sendMessage("open portal");
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.pageBg,
        display: "flex",
        justifyContent: "center",
        padding: 18,
      }}
    >
      <div style={{ width: "100%", maxWidth: 980, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Top Bar (matches your screenshot layout) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 16,
            background: theme.panelBg,
            border: `1px solid ${theme.border}`,
            boxShadow: dark ? "0 10px 30px rgba(0,0,0,0.35)" : "0 10px 30px rgba(0,0,0,0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 220 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                background: theme.chipBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                border: `1px solid ${theme.border}`,
              }}
              title="Advisor"
            >
              {/* placeholder avatar circle */}
              <span style={{ fontWeight: 800, color: theme.text }}>M</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
              <div style={{ fontWeight: 800, color: theme.text }}>{headerTitle}</div>
              <div style={{ fontSize: 12, color: theme.subtext, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: "#22c55e", display: "inline-block" }} />
                Online
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              style={{
                height: 38,
                borderRadius: 12,
                border: `1px solid ${theme.border}`,
                background: theme.btnBg,
                color: theme.btnText,
                padding: "0 10px",
                fontWeight: 600,
                outline: "none",
              }}
              aria-label="Language"
            >
              <option>English</option>
              <option>Spanish</option>
              <option>Polish</option>
              <option>French</option>
              <option>German</option>
              <option>Portuguese</option>
              <option>Italian</option>
              <option>Romanian</option>
            </select>

            <button
              type="button"
              onClick={() => setVoiceOn((v) => !v)}
              style={{
                height: 38,
                borderRadius: 12,
                border: `1px solid ${theme.border}`,
                background: theme.btnBg,
                color: theme.btnText,
                padding: "0 12px",
                fontWeight: 700,
                cursor: "pointer",
              }}
              aria-label="Voice"
              title="Voice"
            >
              {voiceOn ? "🔊 Voice On" : "🔇 Voice Off"}
            </button>

            <button
              type="button"
              onClick={() => setDark((d) => !d)}
              style={{
                height: 38,
                borderRadius: 12,
                border: `1px solid ${theme.border}`,
                background: theme.btnBg,
                color: theme.btnText,
                padding: "0 12px",
                fontWeight: 700,
                cursor: "pointer",
              }}
              aria-label="Theme"
              title="Theme"
            >
              {dark ? "🌙 Dark" : "☀️ Light"}
            </button>

            <button
              type="button"
              onClick={openPortal}
              style={{
                height: 38,
                borderRadius: 12,
                border: `1px solid ${theme.border}`,
                background: dark ? "#2451cc" : "#2451cc",
                color: "white",
                padding: "0 14px",
                fontWeight: 800,
                cursor: "pointer",
              }}
              aria-label="Open Portal"
              title="Open Portal"
            >
              Open Portal
            </button>
          </div>
        </div>

        {/* Script intro bubble */}
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 16,
            background: theme.panelBg,
            border: `1px solid ${theme.border}`,
            color: theme.subtext,
          }}
        >
          Hello! My name’s Mark. What prompted you to seek help with your debts today?
        </div>

        {/* Chat window */}
        <div
          ref={listRef}
          onClick={() => setShowEmoji(false)}
          style={{
            flex: 1,
            borderRadius: 18,
            border: `1px solid ${theme.border}`,
            padding: 14,
            overflowY: "auto",
            minHeight: 520,
            background: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
          }}
        >
          {messages.map((m) => {
            const isUser = m.role === "user";
            const bubbleBg = isUser ? theme.bubbleUserBg : theme.bubbleBotBg;
            const bubbleText = isUser ? theme.bubbleUserText : theme.bubbleBotText;

            return (
              <div key={m.id} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 12 }}>
                <div
                  style={{
                    maxWidth: "78%",
                    padding: "12px 14px",
                    borderRadius: 18,
                    background: bubbleBg,
                    color: bubbleText,
                    border: `1px solid ${theme.border}`,
                    boxShadow: dark ? "0 10px 20px rgba(0,0,0,0.28)" : "0 10px 20px rgba(0,0,0,0.06)",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.45,
                    fontSize: 15,
                  }}
                >
                  {m.kind === "upload" && m.meta?.url ? (
                    <>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>📎 Document uploaded</div>
                      <a href={m.meta.url} target="_blank" rel="noreferrer" style={{ textDecoration: "underline", color: bubbleText }}>
                        {m.meta.filename || "Open file"}
                      </a>
                    </>
                  ) : (
                    m.text
                  )}

                  <div style={{ marginTop: 8, fontSize: 11, opacity: 0.78, textAlign: "right" }}>{m.ts}</div>
                </div>
              </div>
            );
          })}

          {sending && (
            <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}>
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: 18,
                  background: theme.bubbleBotBg,
                  color: theme.bubbleBotText,
                  border: `1px solid ${theme.border}`,
                  opacity: 0.9,
                  fontWeight: 600,
                }}
              >
                Typing…
              </div>
            </div>
          )}
        </div>

        {/* Emoji picker */}
        {showEmoji && (
          <div
            style={{
              background: theme.panelBg,
              border: `1px solid ${theme.border}`,
              borderRadius: 16,
              padding: 10,
              boxShadow: dark ? "0 20px 40px rgba(0,0,0,0.35)" : "0 18px 36px rgba(0,0,0,0.10)",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setInput((v) => v + e)}
                  style={{
                    borderRadius: 12,
                    border: `1px solid ${theme.border}`,
                    background: theme.btnBg,
                    color: theme.btnText,
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: 18,
                  }}
                  title={e}
                  aria-label={`emoji-${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage(input);
          }}
          style={{ display: "flex", gap: 10, alignItems: "center" }}
        >
          <button
            type="button"
            onClick={() => setShowEmoji((s) => !s)}
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              border: `1px solid ${theme.border}`,
              background: theme.btnBg,
              color: theme.btnText,
              cursor: "pointer",
              fontSize: 18,
              fontWeight: 800,
            }}
            title="Emoji"
            aria-label="Emoji"
          >
            🙂
          </button>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              border: `1px solid ${theme.border}`,
              background: theme.btnBg,
              color: theme.btnText,
              cursor: "pointer",
              fontSize: 18,
              fontWeight: 800,
            }}
            title="Upload"
            aria-label="Upload"
          >
            📎
          </button>

          <input
            ref={fileRef}
            type="file"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile(f);
              e.currentTarget.value = "";
            }}
          />

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message…"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 999,
              border: `1px solid ${theme.border}`,
              padding: "0 14px",
              outline: "none",
              fontSize: 14,
              background: theme.inputBg,
              color: theme.inputText,
            }}
          />

          <button
            type="submit"
            disabled={sending}
            style={{
              height: 44,
              borderRadius: 999,
              padding: "0 18px",
              border: `1px solid ${theme.border}`,
              background: dark ? "#1a2a52" : "#ffffff",
              color: theme.btnText,
              cursor: sending ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            Send
          </button>
        </form>

        <div style={{ fontSize: 12, color: theme.subtext }}>
          Tip (testing only): type <b>reset</b> to restart the script.
        </div>
      </div>
    </div>
  );
}
