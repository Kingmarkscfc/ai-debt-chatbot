import { useEffect, useRef, useState } from "react";
import Head from "next/head";

const Chat = () => {
  const [messages, setMessages] = useState<{ sender: string; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [isBotTyping, setIsBotTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(true);
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
      setMessages((prev) => [...prev, { sender: "bot", text: "⚠️ Error: Unable to connect." }]);
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
    <div className={`${isDarkMode ? "bg-gray-900 text-white" : "bg-gray-100 text-black"} min-h-screen flex flex-col`}>
      <Head>
        <title>Debt Advisor</title>
      </Head>

      <div className="flex justify-between items-center p-4 border-b border-gray-700">
        <h1 className="text-xl font-semibold">Debt Advisor</h1>
        <button
          className="px-4 py-1 border rounded text-sm"
          onClick={() => setIsDarkMode(!isDarkMode)}
        >
          Toggle {isDarkMode ? "Light" : "Dark"} Mode
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 space-y-4">
        {messages.map((msg, index) => (
          <div key={index} className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[75%] px-4 py-2 rounded-2xl shadow whitespace-pre-line 
              ${msg.sender === "user"
                ? "bg-blue-600 text-white rounded-br-none"
                : "bg-gray-300 text-black dark:bg-gray-700 dark:text-white rounded-bl-none"}`}>
              {msg.text}
            </div>
          </div>
        ))}
        {isBotTyping && (
          <div className="flex justify-start">
            <div className="bg-gray-300 dark:bg-gray-700 px-4 py-2 rounded-2xl shadow">
              Typing...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t border-gray-700 flex items-center space-x-2">
        <input
          type="text"
          placeholder="Type your message..."
          className="flex-1 p-2 border rounded dark:bg-gray-800 dark:text-white"
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
  );
};

export default Chat;
