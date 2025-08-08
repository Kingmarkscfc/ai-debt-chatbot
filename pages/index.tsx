// /pages/index.tsx
import Head from "next/head";
import { useState, useEffect, useRef } from "react";

type Msg = { role: "user" | "assistant"; content: string };

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasInitiatedRef = useRef(false);

  const toggleTheme = () => setTheme(prev => (prev === "light" ? "dark" : "light"));

  // Auto-init the scripted flow on first mount
  useEffect(() => {
    const init = async () => {
      if (hasInitiatedRef.current) return;
      hasInitiatedRef.current = true;

      setIsTyping(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "👋 INITIATE", sessionId: null }),
        });
        const data = await res.json();
        if (data.sessionId) setSessionId(data.sessionId);

        setMessages([{ role: "assistant", content: data.reply }]);
      } catch (e) {
        setMessages([{ role: "assistant", content: "⚠️ Failed to start the chat. Please refresh." }]);
      } finally {
        setIsTyping(false);
      }
    };
    init();
  }, []);

  const handleSend = async () => {
    if (!input.trim()) return;
    const userMessage = input.trim();

    setMessages(prev => [...prev, { role: "user", content: userMessage }]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, sessionId }),
      });

      const data = await res.json();
      if (data.sessionId && data.sessionId !== sessionId) setSessionId(data.sessionId);

      setMessages(prev => [...prev, { role: "assistant", content: data.reply }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", content: "⚠️ Error: Unable to connect." }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main
        className={`${
          theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black"
        } min-h-screen w-full flex items-center justify-center transition-colors duration-300`}
      >
        <div className="w-full max-w-2xl px-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-xl font-bold">Debt Advisor</h1>
            <div className="flex items-center gap-2">
              <select className="p-2 border rounded text-sm bg-white dark:bg-gray-800 dark:border-gray-700">
                <option>English</option>
                <option>Español</option>
                <option>Français</option>
                <option>Deutsch</option>
                <option>Polski</option>
                <option>Română</option>
              </select>
              <button
                onClick={toggleTheme}
                className="px-3 py-2 rounded text-sm bg-blue-600 text-white hover:opacity-90"
              >
                {theme === "light" ? "Dark" : "Light"} Mode
              </button>
            </div>
          </div>

          {/* Chat Panel */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow p-4 min-h-[360px] max-h-[520px] overflow-y-auto space-y-2">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`px-4 py-2 rounded-2xl max-w-[80%] text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-green-600 text-white rounded-br-none"
                      : "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white rounded-bl-none"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="text-sm text-gray-500 dark:text-gray-400 italic">Mark is typing…</div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input Row */}
          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message…"
              className="flex-1 p-3 border rounded-lg bg-white dark:bg-gray-800 dark:text-white dark:border-gray-700"
            />
            <button
              onClick={handleSend}
              className="px-5 py-3 rounded-lg bg-green-600 text-white font-medium hover:opacity-90"
            >
              Send
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
