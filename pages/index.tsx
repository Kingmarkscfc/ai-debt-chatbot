import Head from "next/head";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "assistant" | "user" | "system"; content: string };

function getSessionId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  let sid = localStorage.getItem("da_session_id");
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    localStorage.setItem("da_session_id", sid);
  }
  return sid;
}

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [language, setLanguage] = useState("English");
  const [sessionId, setSessionId] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Voice
  const [voiceOn, setVoiceOn] = useState(true);
  const [gbVoice, setGbVoice] = useState<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    setSessionId(getSessionId());
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load UK/English voice
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      // Prefer British English
      const candidates = voices.filter(
        v =>
          /en-GB/i.test(v.lang) ||
          /english/i.test(v.name) && /UK|British|GB/i.test(v.name)
      );
      setGbVoice(candidates[0] || voices.find(v => /en-/.test(v.lang)) || null);
    };

    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }, []);

  const speakText = (text: string) => {
    if (!voiceOn || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    // Strip HTML tags from assistant (we add links for uploads)
    const plain = text.replace(/<[^>]+>/g, " ");
    const u = new SpeechSynthesisUtterance(plain);
    if (gbVoice) u.voice = gbVoice;
    u.lang = gbVoice?.lang || "en-GB";
    u.rate = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };

  const sendToChat = async (text: string) => {
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId, lang: language }),
      });
      const data = await res.json();
      const reply: string = data.reply ?? "Sorry, I didn’t catch that.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      speakText(reply);
    } catch {
      const err = "Sorry—something went wrong sending that. Please try again.";
      setMessages((prev) => [...prev, { role: "assistant", content: err }]);
      speakText(err);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSend = () => {
    if (!input.trim()) return;
    sendToChat(input.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  const handleEmoji = (emoji: string) => {
    setInput((v) => (v ? v + " " + emoji : emoji));
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("sessionId", sessionId);

    setMessages((prev) => [...prev, { role: "user", content: `📎 Uploaded: ${file.name}` }]);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (data?.url) {
        const msg = `✅ Document received: <a href="${data.url}" target="_blank" rel="noreferrer">${data.fileName ?? file.name}</a> — you can download it anytime.`;
        setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
        speakText("Document received. I’ve added a download link for you.");
      } else {
        const msg = "Upload completed, but I couldn’t fetch the download link. I’ll still store it.";
        setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
        speakText(msg);
      }
    } catch {
      const msg = "Sorry—upload failed. Please try again.";
      setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
      speakText(msg);
    } finally {
      (e.target as HTMLInputElement).value = "";
    }
  };

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="app-shell">
        <div className="chat-card">
          {/* Header */}
          <div className="chat-header">
            <div className="title-side">
              <h1 className="chat-title">Debt Advisor</h1>
              <span className="online-dot" aria-label="online status" />
              <span className="online-text">Online</span>
            </div>

            <div className="prefs">
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="select"
              >
                <option>English</option>
                <option>Español</option>
                <option>Français</option>
                <option>Deutsch</option>
                <option>Polski</option>
                <option>Română</option>
              </select>

              <button
                className="btn-ghost"
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                title="Toggle theme"
              >
                {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
              </button>

              <button
                className="btn-ghost"
                onClick={() => setVoiceOn(v => !v)}
                title="Toggle voice"
              >
                {voiceOn ? "🔊 Voice On" : "🔈 Voice Off"}
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="messages">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`bubble ${m.role === "user" ? "bubble-user" : "bubble-assistant"}`}
                dangerouslySetInnerHTML={{ __html: m.content }}
              />
            ))}
            {isTyping && <div className="typing">Mark is typing…</div>}
            <div ref={messagesEndRef} />
          </div>

          {/* Upload + Emojis (kept) */}
          <div className="aux-row">
            <label className="upload">
              <span className="upload-btn">📎 Upload docs</span>
              <input type="file" onChange={handleUpload} />
            </label>

            <div className="emojis">
              {["🙂", "😟", "👍", "👎", "✅", "❌"].map((e) => (
                <button key={e} className="emoji" onClick={() => handleEmoji(e)} aria-label="emoji">
                  {e}
                </button>
              ))}
            </div>
          </div>

          {/* Composer */}
          <div className="composer">
            <input
              className="input"
              placeholder="Type your message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button className="btn-send" onClick={handleSend}>
              Send
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
