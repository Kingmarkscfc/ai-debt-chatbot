import Head from "next/head";
import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [messages, setMessages] = useState<{ role: "assistant" | "user"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [ready, setReady] = useState(false);

  // keep a stable session id across all requests (persist to localStorage)
  const sessionIdRef = useRef<string | null>(null);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  // Ensure stable session id
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("chat_session_id") : null;
    if (saved) {
      sessionIdRef.current = saved;
    } else {
      const id = Math.random().toString(36).slice(2);
      sessionIdRef.current = id;
      if (typeof window !== "undefined") window.localStorage.setItem("chat_session_id", id);
    }
    setReady(true);
  }, []);

  // Fire INITIATE once when ready
  useEffect(() => {
    const doInit = async () => {
      if (!ready || !sessionIdRef.current) return;
      setIsTyping(true);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "👋 INITIATE", sessionId: sessionIdRef.current }),
      });
      const data = await res.json();
      // server may send its own sessionId—prefer that going forward
      if (data.sessionId && data.sessionId !== sessionIdRef.current) {
        sessionIdRef.current = data.sessionId;
        window.localStorage.setItem("chat_session_id", data.sessionId);
      }
      setMessages([{ role: "assistant", content: data.reply }]);
      setIsTyping(false);
    };
    doInit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const handleSend = async () => {
    if (!input.trim() || !sessionIdRef.current) return;
    const userMessage = input.trim();
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setInput("");
    setIsTyping(true);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage, sessionId: sessionIdRef.current }),
    });
    const data = await res.json();
    if (data.sessionId && data.sessionId !== sessionIdRef.current) {
      sessionIdRef.current = data.sessionId;
      window.localStorage.setItem("chat_session_id", data.sessionId);
    }
    setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    setIsTyping(false);
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

      <main
        className={`${
          theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black"
        } min-h-screen w-full flex items-center justify-center transition-colors duration-300 p-4`}
      >
        <div className="w-full max-w-2xl space-y-4">
          {/* Header */}
          <div className="flex justify-between items-center">
            <h1 className="text-xl font-bold">Debt Advisor</h1>
            <div className="flex items-center gap-2">
              <select className="p-1 border rounded text-sm">
                <option>English</option>
              </select>
              <button
                onClick={toggleTheme}
                className="px-3 py-1 rounded bg-blue-600 text-white text-sm"
              >
                {theme === "light" ? "Dark" : "Light"} Mode
              </button>
            </div>
          </div>

          {/* Chat Window */}
          <div className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-2 min-h-[360px] max-h-[520px] overflow-y-auto">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`${
                    m.role === "user"
                      ? "bg-green-600 text-white"
                      : "bg-gray-200 dark:bg-gray-700 text-black dark:text-white"
                  } px-4 py-2 rounded-lg max-w-xs text-sm`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="text-sm text-gray-500 italic">Mark is typing…</div>
            )}
          </div>

          {/* Input */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Type your message…"
              className="flex-grow p-2 border rounded"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!ready}
            />
            <button
              className="p-2 px-4 bg-green-600 text-white rounded disabled:opacity-60"
              onClick={handleSend}
              disabled={!ready}
            >
              Send
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
