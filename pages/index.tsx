import Head from "next/head";
import { useEffect, useMemo, useRef, useState } from "react";

type ChatMsg = { role: "user" | "assistant" | "system"; content: string };
type ChatResponse = {
  reply: string;
  sessionId: string;
  stepIndex?: number;
  totalSteps?: number;
  quickReplies?: string[];
};

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  let sid = localStorage.getItem("da_session_id");
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    localStorage.setItem("da_session_id", sid);
  }
  return sid;
}

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [lang, setLang] = useState<"en" | "es" | "fr" | "de" | "pl" | "ro">("en");
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [totalSteps, setTotalSteps] = useState<number>(12);
  const [speaking, setSpeaking] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Init session id once
  useEffect(() => {
    setSessionId(getOrCreateSessionId());
  }, []);

  // Auto scroll
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isTyping]);

  // Voice: speak last assistant message if enabled
  useEffect(() => {
    if (!speaking) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last) return;
    const utter = new SpeechSynthesisUtterance(last.content.replace(/<\/?mark>/g, ""));
    utter.rate = 1;
    utter.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }, [messages, speaking]);

  const progressPct = useMemo(() => {
    const total = totalSteps || 12;
    const i = stepIndex || 0;
    const pct = Math.max(0, Math.min(100, Math.round(((i + 1) / total) * 100)));
    return pct;
  }, [stepIndex, totalSteps]);

  const sendMessage = async (text: string) => {
    if (!text.trim()) return;
    const userMessage = text.trim();
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setInput("");
    setIsTyping(true);

    // call chat API
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage, sessionId, lang }),
    });
    const data: ChatResponse = await res.json();

    setIsTyping(false);
    if (data.sessionId) setSessionId(data.sessionId);
    if (typeof data.stepIndex === "number") setStepIndex(data.stepIndex);
    if (typeof data.totalSteps === "number") setTotalSteps(data.totalSteps);
    setQuickReplies(data.quickReplies || []);
    setMessages((prev) => [...prev, { role: "assistant", content: highlightKeywords(data.reply) }]);
  };

  const handleSend = () => sendMessage(input);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  const toggleVoice = () => setSpeaking((s) => !s);

  // Upload doc
  const handleUploadClick = () => fileInputRef.current?.click();
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // show a local preview as a message
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => {
        setMessages((prev) => [
          ...prev,
          { role: "user", content: `(uploaded image) ` + `<img src="${reader.result}" class="preview-img" alt="upload" />` },
        ]);
      };
      reader.readAsDataURL(file);
    } else {
      setMessages((prev) => [...prev, { role: "user", content: `📎 Uploaded: ${file.name}` }]);
    }

    const form = new FormData();
    form.append("file", file);
    const resp = await fetch("/api/upload", { method: "POST", body: form });
    const data = await resp.json();
    if (data.url) {
      setMessages((prev) => [...prev, { role: "assistant", content: `✅ Received your document. Stored as: ${data.url}` }]);
    } else {
      setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ Upload failed. Please try again.` }]);
    }
  };

  // Emoji reaction to last assistant msg — purely visual “wow factor”
  const reactToLast = (emoji: string) => {
    setMessages((prev) => {
      const idx = [...prev].map((m) => m.role).lastIndexOf("assistant");
      if (idx === -1) return prev;
      const clone = [...prev];
      clone[idx] = { ...clone[idx], content: `${clone[idx].content} <span class="emoji-react">${emoji}</span>` };
      return clone;
    });
  };

  // Keyword highlight for IVA/DMP etc.
  function highlightKeywords(s: string) {
    const terms = ["IVA", "DMP", "bankruptcy", "Debt Relief Order", "DRO", "bailiffs", "credit file"];
    let out = s;
    terms.forEach((t) => {
      const re = new RegExp(`\\b(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`, "gi");
      out = out.replace(re, "<mark>$1</mark>");
    });
    return out;
  }

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className={`app-shell ${theme === "dark" ? "theme-dark" : "theme-light"}`}>
        {/* Top bar */}
        <header className="topbar">
          <div className="brand">Debt Advisor</div>
          <div className="controls">
            <select
              className="lang"
              value={lang}
              onChange={(e) => setLang(e.target.value as any)}
              aria-label="Language"
              title="Language"
            >
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="pl">Polski</option>
              <option value="ro">Română</option>
            </select>
            <button className="btn" onClick={toggleVoice} title="Toggle voice">
              {speaking ? "🔊 Voice On" : "🔈 Voice Off"}
            </button>
            <button className="btn" onClick={toggleTheme} title="Toggle theme">
              {theme === "light" ? "🌙 Dark" : "☀️ Light"}
            </button>
          </div>
        </header>

        {/* Progress */}
        <div className="progress">
          <div className="progress-label">
            Journey progress: <strong>{progressPct}%</strong>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="badges">
            {progressPct >= 25 && <span className="badge">✅ Eligibility started</span>}
            {progressPct >= 50 && <span className="badge">🧭 Options reviewed</span>}
            {progressPct >= 75 && <span className="badge">📄 Docs stage</span>}
            {progressPct >= 95 && <span className="badge">🎉 Almost done</span>}
          </div>
        </div>

        {/* Chat window */}
        <section className="chat-card">
          <div className="chat-scroll" ref={chatScrollRef}>
            {messages.map((m, i) => (
              <div key={i} className={`row ${m.role}`}>
                <div
                  className={`bubble ${m.role}`}
                  dangerouslySetInnerHTML={{ __html: m.content }}
                />
              </div>
            ))}
            {isTyping && (
              <div className="row assistant">
                <div className="bubble assistant typing">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              </div>
            )}
          </div>

          {/* Quick replies */}
          {!!quickReplies.length && (
            <div className="chips">
              {quickReplies.slice(0, 6).map((q, i) => (
                <button key={i} className="chip" onClick={() => sendMessage(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Input + actions */}
          <div className="composer">
            <div className="left-actions">
              <button className="icon-btn" onClick={() => reactToLast("👍")} title="React thumbs up">👍</button>
              <button className="icon-btn" onClick={() => reactToLast("❤️")} title="React heart">❤️</button>
              <button className="icon-btn" onClick={() => reactToLast("😮")} title="React wow">😮</button>
              <button className="icon-btn" onClick={handleUploadClick} title="Upload document">📎</button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden-file"
                onChange={handleFileChange}
                accept="image/*,.pdf,.jpg,.jpeg,.png"
              />
            </div>

            <input
              className="composer-input"
              placeholder="Type your message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button className="send-btn" onClick={handleSend}>Send</button>
          </div>
        </section>
      </main>
    </>
  );
}
