import { useEffect, useRef, useState } from "react";
import Head from "next/head";

export default function Home() {
  const [messages, setMessages] = useState<{ sender: string; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [isBotTyping, setIsBotTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [language, setLanguage] = useState("English");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage = { sender: "user", text: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setIsBotTyping(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input.trim(), sessionId }),
      });

      const data = await response.json();

      if (!sessionId) setSessionId(data.sessionId);
      setMessages((prev) => [...prev, { sender: "bot", text: data.reply }]);
    } catch (err) {
      console.error("Chat error:", err);
      setMessages((prev) => [
        ...prev,
        { sender: "bot", text: "⚠️ Error: Unable to connect." },
      ]);
    } finally {
      setIsBotTyping(false);
      setInput("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className={`${
        isDarkMode ? "bg-gray-900 text-white" : "bg-gray-100 text-black"
      } min-h-screen flex items-center justify-center transition-colors duration-300`}
    >
      <Head>
        <title>Debt Advisor Chat</title>
      </Head>

      <div className="w-full max-w-3xl p-4">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Debt Advisor</h1>
          <div className="flex space-x-2">
            <select
              className="p-1 border rounded dark:bg-gray-800 dark:text-white"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option>English</option>
              <option>Spanish</option>
              <option>Polish</option>
              <option>French</option>
              <option>German</option>
              <option>Portuguese</option>
              <option>Italian</option>
              <option>Romanian</option>
            </select>
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="px-3 py-1 border rounded text-sm"
            >
              Toggle {isDarkMode ? "Light" : "Dark"} Mode
            </button>
          </div>
        </div>

        <div className="h-[65vh] overflow-y-auto border rounded-lg p-4 space-y-4 bg-white dark:bg-gray-800">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-xs md:max-w-md px-4 py-2 rounded-2xl shadow
                  ${msg.sender === "user"
                    ? "bg-blue-600 text-white rounded-br-none"
                    : "bg-gray-300 text-black dark:bg-gray-700 dark:text-white rounded-bl-none"}`}
              >
                {msg.text}
              </div>
            </div>
          ))}
          {isBotTyping && (
            <div className="flex justify-start">
              <div className="bg-gray-300 dark:bg-gray-700 text-black dark:text-white px-4 py-2 rounded-2xl shadow">
                Typing...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="mt-4 flex items-center space-x-2">
          <input
            type="text"
            className="flex-1 p-2 border rounded focus:outline-none dark:bg-gray-800 dark:text-white"
            placeholder="Type your message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="bg-blue-600 text-white px-4 py-2 rounded"
            onClick={handleSend}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
