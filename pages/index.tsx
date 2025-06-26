import Head from "next/head";
import { useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState<string[]>([]);
  const [input, setInput] = useState("");

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages((prev) => [...prev, input]);
    setInput("");
  };

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
      </Head>
      <main className="flex flex-col items-center justify-center w-full min-h-screen px-4 py-8">
        <div className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6">
          <h1 className="text-2xl font-bold mb-4 text-center">Debt Advisor</h1>

          <div className="h-96 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded-md p-4 space-y-2 bg-gray-50 dark:bg-gray-700 mb-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className="bg-blue-100 dark:bg-blue-700 text-black dark:text-white rounded-xl px-4 py-2 w-fit max-w-[75%]"
              >
                {msg}
              </div>
            ))}
          </div>

          <div className="flex items-center space-x-2">
            <input
              className="flex-grow px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 text-black dark:text-white"
              type="text"
              placeholder="Type your message..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
            />
            <button
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg"
              onClick={handleSend}
            >
              Send
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
