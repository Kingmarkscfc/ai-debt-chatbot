import Head from "next/head";
import { useState, useEffect, useRef } from "react";

type TextMsg = { role: "assistant" | "user"; type?: "text"; content: string };
type FileMsg = { role: "assistant" | "user"; type: "file"; fileName: string; fileUrl: string };
type Msg = TextMsg | FileMsg;

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", type: "text", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Always keep the chat scrolled to the last message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const toggleTheme = () => setTheme((p) => (p === "light" ? "dark" : "light"));

  async function handleSend() {
    const text = input.trim();
    if (!text) return;

    setMessages((prev) => [...prev, { role: "user", type: "text", content: text }]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });
      const data = await res.json();
      if (data?.sessionId && !sessionId) setSessionId(data.sessionId as string);
      setMessages((prev) => [...prev, { role: "assistant", type: "text", content: data?.reply ?? "…" }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", type: "text", content: "Sorry, I hit a snag sending that. Please try again." },
      ]);
    } finally {
      setIsTyping(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  function openUpload() {
    fileRef.current?.click();
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Show as a downloadable bubble immediately (Object URL)
    const url = URL.createObjectURL(file);
    setMessages((prev) => [
      ...prev,
      { role: "user", type: "file", fileName: file.name, fileUrl: url },
    ]);

    // Try server upload (optional)
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("sessionId", sessionId);
      await fetch("/api/upload", { method: "POST", body: form });

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          type: "text",
          content: "Thanks — I’ve received your document. You can download it from above anytime during this session.",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          type: "text",
          content: "Upload saved locally; if you see issues, please try again.",
        },
      ]);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const outerBg = theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black";
  const bubbleUser = "bg-green-600 text-white";
  const bubbleBot = "bg-gray-200 text-black dark:bg-gray-700 dark:text-white";

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* HARD-CENTER WRAPPER — inline styles guarantee centering even if classes break */}
      <div
        className={`${outerBg} min-h-screen transition-colors duration-300`}
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          margin: 0,
        }}
      >
        {/* Card container */}
        <main className="w-full max-w-2xl mx-auto px-4 py-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold">Debt Advisor</h1>
              <span
                className="text-green-400 text-sm font-semibold"
                style={{ textShadow: "0 0 6px rgba(34,197,94,0.9), 0 0 12px rgba(34,197,94,0.6)" }}
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
          <div className="bg-white dark:bg-gray-800 rounded shadow p-4 space-y-3 min-h-[420px] max-h-[600px] overflow-y-auto">
            {messages.map((m, i) => {
              const isUser = m.role === "user";
              const side = isUser ? "justify-end" : "justify-start";
              const bubble = isUser ? bubbleUser : bubbleBot;

              return (
                <div key={i} className={`flex ${side}`}>
                  <div className={`${bubble} px-4 py-2 rounded-lg max-w-[75%] text-sm break-words`}>
                    {m.type === "file" ? (
                      <div className="flex flex-col gap-1">
                        <div className="font-semibold">📎 {m.fileName}</div>
                        {/* Local download (Object URL) — server uploads also acknowledged above */}
                        <a className="underline" href={(m as FileMsg).fileUrl} download={(m as FileMsg).fileName}>
                          Download
                        </a>
                      </div>
                    ) : (
                      m.content
                    )}
                  </div>
                </div>
              );
            })}

            {isTyping && <div className="text-sm text-gray-500 italic">Mark is typing…</div>}
            <div ref={bottomRef} />
          </div>

          {/* Input row */}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={openUpload}
              className="px-3 py-2 rounded border border-dashed border-gray-400 dark:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700"
              title="Upload documents"
            >
              📎 <span className="font-medium ml-1">Upload docs</span>
            </button>
            <input ref={fileRef} type="file" className="hidden" onChange={onFileChange} />

            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
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
