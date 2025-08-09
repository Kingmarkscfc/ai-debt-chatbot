// /pages/index.tsx
import Head from "next/head";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-initiate the scripted flow on first load
  useEffect(() => {
    const started = sessionStorage.getItem("started");
    if (!started) {
      sessionStorage.setItem("started", "1");
      // Simulate assistant’s first message immediately (nice UX)
      setMessages([{ role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" }]);
      // Also tell the API to initiate the session
      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "👋 INITIATE", sessionId: null }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data?.sessionId) setSessionId(data.sessionId);
          // If the API returns a different opening line, append it only if it’s not a duplicate
          if (data?.reply && data.reply !== messages[0]?.content) {
            setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
          }
        })
        .catch(() => {
          // Silent fail – keep the local opening line so UI still works
        });
    }
  }, []); // eslint-disable-line

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  const scrollToBottom = () => bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  useEffect(scrollToBottom, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || isSending) return;

    setIsSending(true);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });
      const data = await res.json();
      if (data?.sessionId && !sessionId) setSessionId(data.sessionId);

      const reply = typeof data?.reply === "string" ? data.reply : "Sorry, I didn’t catch that. Let’s keep going.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Oops — temporary hiccup on my end. Please try again." },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") send();
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
        } min-h-screen w-full flex items-center justify-center transition-colors duration-300 px-4 py-8`}
      >
        <div className="w-full max-w-3xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-semibold">Debt Advisor</h1>
            <div className="flex gap-2">
              <select className="px-2 py-1 border rounded text-sm bg-white/80 dark:bg-gray-800/80">
                <option>English</option>
                <option>Español</option>
                <option>Français</option>
                <option>Deutsch</option>
                <option>Polski</option>
                <option>Română</option>
              </select>
              <button
                onClick={toggleTheme}
                className="px-3 py-1 rounded text-sm bg-blue-600 hover:bg-blue-700 text-white"
              >
                {theme === "light" ? "Dark" : "Light"} Mode
              </button>
            </div>
          </div>

          {/* Chat window */}
          <div
            className={`${
              theme === "dark" ? "bg-gray-800" : "bg-white"
            } border rounded-lg shadow-sm p-4 h-[60vh] min-h-[420px] overflow-y-auto`}
          >
            {messages.map((m, i) => {
              const isUser = m.role === "user";
              return (
                <div key={i} className={`mb-3 flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] rounded-lg px-4 py-2 text-sm leading-relaxed ${
                      isUser
                        ? "bg-green-600 text-white"
                        : theme === "dark"
                        ? "bg-gray-700 text-white border border-gray-600"
                        : "bg-gray-50 text-black border border-gray-200"
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type your message…"
              className="flex-1 rounded border px-3 py-2 outline-none focus:ring focus:ring-blue-300 bg-white dark:bg-gray-800"
              disabled={isSending}
            />
            <button
              onClick={send}
              disabled={isSending}
              className={`px-4 py-2 rounded text-white ${
                isSending ? "bg-green-400 cursor-not-allowed" : "bg-green-600 hover:bg-green-700"
              }`}
            >
              {isSending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
