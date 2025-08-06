// /pages/index.tsx

import Head from "next/head";
import { useState, useEffect, useRef } from "react";

export default function Home() {
  const [theme, setTheme] = useState("light");
  const [messages, setMessages] = useState([
    { role: "assistant", content: "👋 INITIATE" }, // Triggers structured script
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage = input.trim();
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setInput("");
    setIsTyping(true);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage, sessionId }),
    });

    const data = await res.json();
    setSessionId(data.sessionId);
    setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    setIsTyping(false);
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
        } min-h-screen w-full flex flex-col items-center justify-center transition-colors duration-300 px-4 py-6`}
      >
        <div className="w-full max-w-2xl space-y-4">
          {/* Header Bar */}
          <div className="flex justify-between items-center">
            <h1 className="text-xl font-bold">Debt Advisor</h1>
            <div className="flex space-x-2">
              <select className="p-1 border rounded text-sm">
                <option>English</option>
                <option>Español</option>
                <option>Français</option>
                <option>Deutsch</option>
                <option>Polski</option>
                <option>Română</option>
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
          <div className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-2 min-h-[300px] max-h-[500px] overflow-y-auto">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`${
                    msg.role === "user"
                      ? "bg-green-500 text-white"
                      : "bg-gray-200 dark:bg-gray-700 text-black dark:text-white"
                  } px-4 py-2 rounded-lg max-w-xs text-sm`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="text-sm text-gray-500 italic">Mark is typing...</div>
            )}
            <div ref={bottomRef}></div>
          </div>

          {/* Input Bar */}
          <div className="flex items-center space-x-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message..."
              className="flex-grow p-2 border rounded"
            />
            <button
              onClick={handleSend}
              className="p-2 px-4 bg-green-600 text-white rounded"
            >
              Send
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
