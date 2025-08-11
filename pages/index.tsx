import Head from "next/head";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

function getSessionId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  let sid = window.localStorage.getItem("da_session_id");
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    window.localStorage.setItem("da_session_id", sid);
  }
  return sid;
}

function getStepIndex(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem("da_step_index");
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

function setStepIndex(n: number) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem("da_step_index", String(n));
  }
}

export default function Home() {
  const [sessionId, setSessionId] = useState<string>("");
  const [stepIndex, setStepIdx] = useState<number>(0);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [dark, setDark] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // init
  useEffect(() => {
    const sid = getSessionId();
    const idx = getStepIndex();
    setSessionId(sid);
    setStepIdx(idx);

    // Show the intro only once (if first load)
    const intro =
      "Hello! My name’s Mark. What prompted you to seek help with your debts today?";
    setMessages([{ role: "assistant", content: intro }]);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId, stepIndex }),
      });
      const data = await res.json();

      if (data?.sessionId && data.sessionId !== sessionId) setSessionId(data.sessionId);

      const reply =
        typeof data?.reply === "string"
          ? data.reply
          : "Sorry, something went wrong — please try again.";

      // update local step index from server result
      const nextIdx =
        typeof data?.nextStepIndex === "number" ? data.nextStepIndex : stepIndex;

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      setStepIdx(nextIdx);
      setStepIndex(nextIdx); // persist in localStorage
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Network hiccup — please try again." },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className={`app ${dark ? "dark" : ""}`}>
        <main className="viewport">
          <div className="card">
            {/* Header */}
            <div className="topbar">
              <div className="brand">
                <span className="dot" />
                <h1>Debt Advisor</h1>
              </div>
              <div className="actions">
                <select defaultValue="English" aria-label="Language">
                  <option>English</option>
                  <option>Español</option>
                  <option>Français</option>
                  <option>Deutsch</option>
                </select>
                <button onClick={() => setDark((d) => !d)}>
                  {dark ? "Light" : "Dark"} Mode
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="messages">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`row ${m.role === "user" ? "right" : "left"}`}
                >
                  <div className={`bubble ${m.role}`}>{m.content}</div>
                </div>
              ))}
              {isTyping && (
                <div className="typing">Mark is typing…</div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="inputbar">
              <input
                type="text"
                placeholder="Type your message…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button onClick={handleSend}>Send</button>
            </div>
          </div>
        </main>
      </div>

      {/* styled-jsx so you don't need Tailwind or external CSS */}
      <style jsx>{`
        .app {
          background: #f3f4f6;
          color: #111827;
          min-height: 100vh;
        }
        .app.dark {
          background: #111827;
          color: #f9fafb;
        }
        .viewport {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .card {
          width: 100%;
          max-width: 720px;
          border-radius: 16px;
          background: #ffffff;
          border: 1px solid #e5e7eb;
          overflow: hidden;
          box-shadow: 0 8px 24px rgba(0,0,0,0.06);
        }
        .app.dark .card {
          background: #1f2937;
          border-color: #374151;
        }
        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
        }
        .app.dark .topbar {
          border-bottom-color: #374151;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .brand h1 {
          font-size: 16px;
          margin: 0;
          font-weight: 600;
        }
        .dot {
          width: 10px;
          height: 10px;
          background: #10b981;
          border-radius: 999px;
          display: inline-block;
        }
        .actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        select, .actions button {
          font-size: 14px;
          border-radius: 6px;
          border: 1px solid #d1d5db;
          background: transparent;
          color: inherit;
          padding: 6px 10px;
        }
        .app.dark select, .app.dark .actions button {
          border-color: #4b5563;
        }
        .actions button {
          background: #2563eb;
          color: #fff;
          border: none;
        }
        .messages {
          max-height: 65vh;
          min-height: 40vh;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .row {
          display: flex;
        }
        .row.left {
          justify-content: flex-start;
        }
        .row.right {
          justify-content: flex-end;
        }
        .bubble {
          max-width: 80%;
          padding: 10px 12px;
          border-radius: 16px;
          font-size: 14px;
          line-height: 1.4;
          word-break: break-word;
        }
        .bubble.assistant {
          background: #e5e7eb;
          color: #111827;
        }
        .app.dark .bubble.assistant {
          background: #374151;
          color: #f9fafb;
        }
        .bubble.user {
          background: #16a34a;
          color: white;
        }
        .typing {
          font-size: 13px;
          color: #6b7280;
          font-style: italic;
          padding: 0 4px;
        }
        .app.dark .typing {
          color: #9ca3af;
        }
        .inputbar {
          display: flex;
          gap: 8px;
          padding: 12px;
          border-top: 1px solid #e5e7eb;
        }
        .app.dark .inputbar {
          border-top-color: #374151;
        }
        .inputbar input {
          flex: 1;
          padding: 10px;
          border-radius: 8px;
          border: 1px solid #d1d5db;
          background: transparent;
          color: inherit;
        }
        .app.dark .inputbar input {
          border-color: #4b5563;
        }
        .inputbar button {
          padding: 10px 16px;
          background: #16a34a;
          color: #fff;
          border: none;
          border-radius: 8px;
          cursor: pointer;
        }
      `}</style>
    </>
  );
}
