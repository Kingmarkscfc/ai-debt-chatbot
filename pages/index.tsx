import Head from "next/head";
import { useState, useEffect, useRef } from "react";

type Msg = { role: "assistant" | "user"; content: string };

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" }
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  async function send(message: string) {
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setIsTyping(true);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId })
    });

    const data = await res.json();
    if (data.sessionId && !sessionId) setSessionId(data.sessionId);
    setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    setIsTyping(false);
  }

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    send(text);
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
        } min-h-screen w-full flex items-center justify-center transition-colors duration-300 px-4 py-6`}
      >
        <div className="w-full max-w-2xl">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-xl font-bold">Debt Advisor</h1>
            <div className="flex gap-2">
              <select className="p-2 border rounded text-sm">
                <option>English</option>
                <option>Español</option>
                <option>Français</option>
                <option>Deutsch</option>
              </select>
              <button
                onClick={toggleTheme}
                className="px-3 py-2 rounded bg-blue-600 text-white text-sm"
              >
                {theme === "light" ? "Dark" : "Light"} Mode
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-3 min-h-[360px] max-h-[520px] overflow-y-auto">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`${
                    m.role === "user"
                      ? "bg-green-600 text-white"
                      : "bg-gray-200 dark:bg-gray-700 text-black dark:text-white"
                  } px-4 py-2 rounded-lg max-w-[75%] text-sm`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {isTyping && <div className="text-sm text-gray-500 italic">Mark is typing…</div>}
            <div ref={bottomRef} />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message…"
              className="flex-1 p-2 border rounded"
            />
            <button onClick={handleSend} className="px-4 py-2 bg-green-600 text-white rounded">
              Send
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
