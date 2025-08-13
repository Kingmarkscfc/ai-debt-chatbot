import Head from "next/head";
import { useState, useEffect, useRef } from "react";

type Msg =
  | { role: "assistant" | "user"; content: string; type?: "text" }
  | { role: "user" | "assistant"; content: string; type: "file"; fileName: string; fileUrl: string };

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?", type: "text" },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleTheme = () => setTheme((prev) => (prev === "light" ? "dark" : "light"));

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage = input.trim();
    setMessages((prev) => [...prev, { role: "user", content: userMessage, type: "text" }]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, sessionId }),
      });
      const data = await res.json();
      setSessionId(data.sessionId || sessionId);
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply, type: "text" }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I hit a snag sending that. Please try again.", type: "text" },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const objectUrl = URL.createObjectURL(file);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: "Document uploaded", type: "file", fileName: file.name, fileUrl: objectUrl },
    ]);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("sessionId", sessionId || "");
      await fetch("/api/upload", { method: "POST", body: form });

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Thanks — I’ve received your document. You can download it from above anytime during this session.",
          type: "text",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Upload noted locally. If you see any issues, please try again.", type: "text" },
      ]);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
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

      {/* Hard-center everything, always */}
      <div
        className={`${
          theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black"
        } min-h-screen grid place-items-center transition-colors duration-300`}
      >
        {/* Card container – centered, max width, keeps spacing tight */}
        <main className="w-full max-w-2xl mx-auto px-4 py-6">
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold">Debt Advisor</h1>
              <span
                className="text-green-400 text-sm font-semibold"
                style={{ textShadow: "0 0 6px rgba(34,197,94,0.9), 0 0 12px rgba(34,197,94,0.6)" }}
                aria-label="Online"
                title="Online"
              >
                ● Online
              </span>
            </div>
            <div className="flex items-center gap-2">
              <select className="p-1 border rounded text-sm bg-white dark:bg-gray-900">
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
          <div className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-3 min-h-[380px] max-h-[560px] overflow-y-auto">
            {messages.map((msg, i) => {
              const isUser = msg.role === "user";
              const baseBubble = isUser
                ? "bg-green-500 text-white"
                : "bg-gray-200 dark:bg-gray-700 text-black dark:text-white";

              return (
                <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div className={`${baseBubble} px-4 py-2 rounded-lg max-w-[75%] text-sm break-words`}>
                    {msg.type === "file" ? (
                      <div className="flex flex-col gap-1">
                        <div className="font-semibold">📎 {msg.fileName}</div>
                        <a href={(msg as any).fileUrl} download={(msg as any).fileName} className="underline">
                          Download
                        </a>
                      </div>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              );
            })}
            {isTyping && <div className="text-sm text-gray-500 italic">Mark is typing...</div>}
            <div ref={bottomRef} />
          </div>

          {/* Input row */}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={handleUploadClick}
              className="px-3 py-2 rounded border border-dashed border-gray-400 dark:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700"
              title="Upload documents"
            >
              📎 <span className="font-medium">Upload docs</span>
            </button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />

            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message…"
              className="flex-grow p-2 border rounded bg-white dark:bg-gray-900"
            />

            <button onClick={handleSend} className="p-2 px-4 bg-green-600 text-white rounded">
              Send
            </button>
          </div>
        </main>
      </div>
    </>
  );
}
