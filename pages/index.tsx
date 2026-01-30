import { useEffect, useMemo, useRef, useState } from "react";

type ChatState = {
  step: number;
  name?: string | null;

  // loop guards / UX
  askedNameTries?: number;
  lastBotPrompt?: string;

  // optional structured captures
  paying?: number | null;
  affordable?: number | null;

  // portal gating
  portalOpened?: boolean;
};

type Msg = {
  id: string;
  role: "user" | "bot";
  text: string;
  ts: string; // display timestamp
  kind?: "text" | "upload";
  meta?: {
    url?: string;
    filename?: string;
  };
};

function nowStamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function uid() {
  return Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}

const EMOJIS = [
  "😀","😄","😁","😅","😂","🙂","😉","😍","😘","😎","🤝","🙏",
  "👍","👎","👏","🔥","💪","💡","✅","⚠️","❓","💬","📎","📄",
  "💷","💳","🏠","📅","🧠","✨","😬","😴","🤦‍♂️","🤦‍♀️","❤️"
];

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Session + state persistence (prevents loops)
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

  const [showEmoji, setShowEmoji] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const existing = localStorage.getItem("da_sessionId");
    const sid = existing || "sess_" + uid();
    if (!existing) localStorage.setItem("da_sessionId", sid);
    setSessionId(sid);

    // load stored chat + state
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
    // auto-scroll
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending, showEmoji]);

  async function safeJson(r: Response) {
    try {
      return await r.json();
    } catch {
      return null;
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

    // 1 retry only (fixes flaky “couldn’t reach server” moments)
    const attempt = async () => {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          sessionId,
          state: chatState,
          // send a small slice of recent messages for better “human” continuity
          recent: messages.slice(-10),
        }),
      });
      const data = await safeJson(r);
      return { ok: r.ok, data };
    };

    try {
      let res = await attempt();
      if (!res.ok) res = await attempt();

      if (!res.ok || !res.data?.reply) {
        throw new Error("No reply");
      }

      const botMsg: Msg = { id: uid(), role: "bot", text: res.data.reply, ts: nowStamp(), kind: "text" };
      setMessages((m) => [...m, botMsg]);

      if (res.data?.state) setChatState(res.data.state);
    } catch {
      const botMsg: Msg = { id: uid(), role: "bot", text: "⚠️ I couldn’t reach the server just now. Please try again.", ts: nowStamp(), kind: "text" };
      setMessages((m) => [...m, botMsg]);
    } finally {
      setSending(false);
    }
  }

  async function uploadFile(file: File) {
    if (!sessionId) return;

    setShowEmoji(false);
    setSending(true);

    // show an immediate “uploading” bubble
    const uploadingId = uid();
    setMessages((m) => [
      ...m,
      { id: uploadingId, role: "bot", text: `Uploading **${file.name}**…`, ts: nowStamp(), kind: "text" },
    ]);

    try {
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      fd.append("file", file);

      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await safeJson(r);

      if (!r.ok || !data?.ok || !data?.url) throw new Error("Upload failed");

      // replace the uploading bubble with a success bubble
      setMessages((m) =>
        m.map((msg) =>
          msg.id === uploadingId
            ? {
                ...msg,
                text: `Uploaded: ${file.name}`,
                kind: "upload",
                meta: { url: data.url, filename: file.name },
              }
            : msg
        )
      );

      // optionally nudge the bot (so it can confirm / continue)
      await sendMessage(`(Uploaded: ${file.name})`);
    } catch {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === uploadingId
            ? { ...msg, text: `⚠️ Upload failed for ${file.name}. Please try again.`, kind: "text" }
            : msg
        )
      );
    } finally {
      setSending(false);
    }
  }

  const headerTitle = useMemo(() => "Debt Advisor", []);

  return (
    <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 820, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            padding: "14px 14px",
            borderRadius: 16,
            border: "1px solid rgba(0,0,0,0.10)",
            marginBottom: 12,
            background: "white",
            boxShadow: "0 6px 22px rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 16 }}>{headerTitle}</div>
          <div style={{ fontSize: 13, opacity: 0.78, marginTop: 4 }}>
            Hello! My name’s Mark. What prompted you to seek help with your debts today?
          </div>
        </div>

        <div
          ref={listRef}
          style={{
            flex: 1,
            borderRadius: 18,
            border: "1px solid rgba(0,0,0,0.10)",
            padding: 12,
            overflowY: "auto",
            background: "linear-gradient(180deg, rgba(0,0,0,0.02), rgba(0,0,0,0.01))",
            minHeight: 460,
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
          }}
          onClick={() => setShowEmoji(false)}
        >
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                display: "flex",
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  maxWidth: "80%",
                  padding: "10px 12px",
                  borderRadius: 16,
                  background: m.role === "user" ? "rgba(0,0,0,0.08)" : "white",
                  border: "1px solid rgba(0,0,0,0.08)",
                }}
              >
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
                  {m.kind === "upload" && m.meta?.url ? (
                    <>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>📎 Document uploaded</div>
                      <a href={m.meta.url} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                        {m.meta.filename || "Open file"}
                      </a>
                    </>
                  ) : (
                    m.text
                  )}
                </div>
                <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6, textAlign: "right" }}>{m.ts}</div>
              </div>
            </div>
          ))}

          {sending && (
            <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 10 }}>
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 16,
                  background: "white",
                  border: "1px solid rgba(0,0,0,0.08)",
                  opacity: 0.85,
                }}
              >
                Typing…
              </div>
            </div>
          )}
        </div>

        <div style={{ position: "relative", marginTop: 12 }}>
          {showEmoji && (
            <div
              style={{
                position: "absolute",
                bottom: 54,
                left: 0,
                right: 0,
                background: "white",
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: 14,
                padding: 10,
                boxShadow: "0 12px 30px rgba(0,0,0,0.10)",
                zIndex: 5,
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setInput((v) => v + e)}
                    style={{
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "white",
                      padding: "6px 8px",
                      cursor: "pointer",
                      fontSize: 18,
                      lineHeight: "18px",
                    }}
                    aria-label={`emoji-${e}`}
                    title={e}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
            style={{ display: "flex", gap: 10 }}
          >
            <button
              type="button"
              onClick={() => setShowEmoji((s) => !s)}
              style={{
                width: 44,
                borderRadius: 999,
                border: "1px solid rgba(0,0,0,0.15)",
                background: "white",
                cursor: "pointer",
                fontWeight: 700,
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
                borderRadius: 999,
                border: "1px solid rgba(0,0,0,0.15)",
                background: "white",
                cursor: "pointer",
                fontWeight: 700,
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
                // reset input so selecting same file again triggers onChange
                e.currentTarget.value = "";
              }}
            />

            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message…"
              style={{
                flex: 1,
                borderRadius: 999,
                border: "1px solid rgba(0,0,0,0.15)",
                padding: "12px 14px",
                outline: "none",
                fontSize: 14,
                background: "white",
              }}
            />

            <button
              type="submit"
              disabled={sending}
              style={{
                borderRadius: 999,
                padding: "12px 16px",
                border: "1px solid rgba(0,0,0,0.15)",
                background: "white",
                cursor: sending ? "not-allowed" : "pointer",
                fontWeight: 700,
              }}
            >
              Send
            </button>
          </form>
        </div>

        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.65 }}>
          Tip (testing only): type <b>reset</b> to restart the script.
        </div>
      </div>
    </div>
  );
}
