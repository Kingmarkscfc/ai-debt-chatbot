import Head from "next/head";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

function getOrCreateSessionId(): string {
  // Guard for SSR
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  let sid = window.localStorage.getItem("da_session_id");
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    window.localStorage.setItem("da_session_id", sid);
  }
  return sid;
}

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Init session + first assistant message
  useEffect(() => {
    const sid = getOrCreateSessionId();
    setSessionId(sid);

    // If brand new chat window, show the first prompt locally
    setMessages([
      {
        role: "assistant",
        content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?",
      },
    ]);
  }, []);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const toggleTheme = () => setTheme((prev) => (prev === "light" ? "dark" : "light"));

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
        body: JSON.stringify({ message: text, sessionId }),
      });
      const data = await res.json();
      if (data?.sessionId && data.sessionId !== sessionId) setSessionId(data.sessionId);

      const reply: string =
        typeof data?.reply === "string"
          ? data.reply
          : "Sorry, something went wrong—please try again.";

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Network hiccup—mind trying that again?" },
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

      <main
        className={`${
          theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black"
        } min-h-screen w-full flex items-center justify-center transition-colors duration-300 px-4 py-6`}
      >
        <div className="w-full max-w-2xl space-y-4">
          {/* Header */}
          <div className="flex justify-between items-center">
            <h1 className="text-xl font-bold">Debt Advisor</h1>
            <div className="flex gap-2">
              <select className="p-1 border rounded text-sm">
                <option>English</option>
                <option>Español</option>
                <option>Français</option>
                <option>Deutsch</option>
              </select>
              <button
                onClick={toggleTheme}
                className="px-3 py-1 rounded bg-blue-600 text-white text-sm"
              >
                {theme === "light" ? "Dark" : "Light"} Mode
              </button>
            </div>
          </div>

          {/* Chat window */}
          <div className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-2 min-h-[320px] max-h-[520px] overflow-y-auto">
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
              <div className="text-sm text-gray-500 italic">
                Mark is typing…
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message…"
              className="flex-grow p-2 border rounded"
            />
            <button onClick={handleSend} className="p-2 px-4 bg-green-600 text-white rounded">
              Send
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
