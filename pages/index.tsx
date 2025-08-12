// pages/index.tsx
import Head from "next/head";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string; isAttachment?: boolean };

function getOrCreateSessionId(): string {
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
  const [lang, setLang] = useState("English");
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSessionId(getOrCreateSessionId()), []);
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  async function handleSend() {
    const userMessage = input.trim();
    if (!userMessage) return;

    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, sessionId, lang }),
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, something went wrong. Please try again." },
      ]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  async function handleFileChosen(file: File) {
    if (!file) return;

    // Show a “user uploaded” chip immediately
    setMessages((prev) => [
      ...prev,
      { role: "user", content: `📎 Uploading: ${file.name}`, isAttachment: true },
    ]);

    // Read file as base64 and POST to /api/upload
    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          fileName: file.name,
          contentBase64,
          contentType: file.type || "application/octet-stream",
        }),
      });

      const data = await res.json();
      if (data?.ok && data.url) {
        // Show assistant confirmation + download link
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `✅ Got your document: **${file.name}**\n\n[Download file](${data.url})`,
            isAttachment: true,
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "Sorry, upload failed. Please try again." },
        ]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, upload failed. Please try again." },
      ]);
    }
  }

  const containerBg = theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black";
  const panelBg = theme === "dark" ? "bg-gray-800" : "bg-white";
  const assistantBubble = theme === "dark" ? "bg-gray-700 text-white" : "bg-gray-200 text-black";

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main
        className={`${containerBg} min-h-screen w-full flex items-center justify-center transition-colors duration-300 p-4`}
      >
        <div className="w-full max-w-2xl space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold">Debt Advisor</h1>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-300">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                Online
              </span>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="px-2 py-1 rounded border text-sm"
              >
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

          {/* Chat panel */}
          <div className={`${panelBg} rounded-lg shadow p-4 space-y-3 min-h-[420px] max-h-[540px] overflow-y-auto`}>
            {messages.map((m, i) => {
              const isUser = m.role === "user";
              const bubbleClass = isUser
                ? "bg-green-600 text-white"
                : assistantBubble;

              // Render basic markdown link for downloads
              const content = m.content.replace(
                /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                (_match, text, url) => `<a href="${url}" target="_blank" rel="noreferrer" class="underline">${text}</a>`
              );

              return (
                <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`${bubbleClass} px-4 py-2 rounded-lg max-w-[80%] text-sm leading-relaxed`}
                    dangerouslySetInnerHTML={{ __html: content }}
                  />
                </div>
              );
            })}
            {isTyping && (
              <div className="flex justify-start">
                <div className={`${assistantBubble} px-4 py-2 rounded-lg text-sm italic`}>
                  Mark is typing…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Composer */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message…"
              className="flex-grow p-2 border rounded"
            />
            {/* Upload button */}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFileChosen(e.target.files[0])}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 rounded border font-medium flex items-center gap-2"
              title="Upload documents"
            >
              📎 Upload docs
            </button>

            <button
              onClick={handleSend}
              className="px-4 py-2 rounded bg-green-600 text-white font-semibold"
            >
              Send
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
