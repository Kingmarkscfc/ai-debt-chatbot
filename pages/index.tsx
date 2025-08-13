import Head from "next/head";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string; isUpload?: boolean; fileName?: string; fileUrl?: string };

const LANGS = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "pl", label: "Polski" },
  { code: "ro", label: "Română" },
];

const EMOJI_BASE = ["🙂", "👍", "👎", "✅", "❌", "😟", "😊", "🙏"];
const SKIN_TONES = ["🏻", "🏼", "🏽", "🏾", "🏿"]; // applied to 👍/👎 only

function getSessionId() {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  let sid = localStorage.getItem("da_session_id");
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    localStorage.setItem("da_session_id", sid);
  }
  return sid;
}

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [lang, setLang] = useState("en");
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [thumbTone, setThumbTone] = useState(0); // 0..4 skin tone index
  const [sessionId, setSessionId] = useState<string>(getSessionId());
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // center-safe theme class on <html> for dark styles if you need global theming
  useEffect(() => {
    if (typeof document !== "undefined") {
      const html = document.documentElement;
      if (theme === "dark") html.classList.add("dark");
      else html.classList.remove("dark");
    }
  }, [theme]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isTyping]);

  const sendMessage = async (text: string) => {
    if (!text.trim()) return;
    const userMessage: Msg = { role: "user", content: text.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text.trim(), sessionId, lang }),
      });

      const data = await res.json();
      if (data.sessionId && data.sessionId !== sessionId) setSessionId(data.sessionId);

      const botMsg: Msg = { role: "assistant", content: data.reply || "…" };
      setMessages((prev) => [...prev, botMsg]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ Sorry—couldn’t reach the server. Please try again." },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSend = () => sendMessage(input);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleUploadClick = () => fileRef.current?.click();

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("sessionId", sessionId);

      const resp = await fetch("/api/upload", {
        method: "POST",
        body: form,
      });

      const data = await resp.json();
      if (data.url) {
        // show a download card in chat
        setMessages((prev) => [
          ...prev,
          {
            role: "user",
            content: `Uploaded: ${file.name}`,
            isUpload: true,
            fileName: file.name,
            fileUrl: data.url,
          },
        ]);
        // optionally, notify the bot
        await sendMessage(`I've uploaded ${file.name}.`);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "⚠️ Upload failed. Please try again." },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ Upload failed. Please try again." },
      ]);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const renderedEmojis = EMOJI_BASE.map((e) => {
    if (e === "👍" || e === "👎") {
      return e + (thumbTone > 0 ? SKIN_TONES[thumbTone - 1] : "");
    }
    return e;
  });

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* Page wrapper (keeps everything dead-center and safe) */}
      <main
        className={`${
          theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black"
        } min-h-screen w-full flex items-center justify-center px-4 py-8 transition-colors`}
      >
        <div className="w-full max-w-2xl">
          {/* Chat Card */}
          <div className="rounded-2xl border border-gray-200 dark:border-gray-700 shadow-xl overflow-hidden bg-white dark:bg-gray-900">
            {/* Header / Title bar */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">Debt Advisor</h1>
                <span className="flex items-center gap-1 text-xs font-semibold text-green-400">
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-green-400"
                    style={{ boxShadow: "0 0 8px #22c55e, 0 0 16px #22c55e" }}
                    aria-hidden
                  />
                  Online
                </span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
                >
                  {LANGS.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
                  className="px-3 py-1 rounded bg-blue-600 text-white text-sm"
                >
                  {theme === "light" ? "Dark" : "Light"} Mode
                </button>
              </div>
            </div>

            {/* Messages */}
            <div
              ref={scrollRef}
              className="h-[460px] overflow-y-auto p-4 space-y-3 bg-gray-50 dark:bg-gray-800"
            >
              {messages.map((m, i) => {
                const isUser = m.role === "user";
                return (
                  <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm shadow ${
                        isUser
                          ? "bg-blue-600 text-white rounded-br-sm"
                          : "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-50 rounded-bl-sm border border-gray-200 dark:border-gray-600"
                      }`}
                    >
                      {m.isUpload && m.fileUrl ? (
                        <div className="flex flex-col gap-1">
                          <div className="font-medium">📄 {m.fileName}</div>
                          <a
                            className="underline text-white/90 dark:text-blue-200"
                            href={m.fileUrl}
                            target="_blank"
                            rel="noreferrer"
                            download
                          >
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
              {isTyping && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-2xl px-4 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-50 border border-gray-200 dark:border-gray-600 shadow">
                    Mark is typing…
                  </div>
                </div>
              )}
            </div>

            {/* Footer / Composer */}
            <div className="border-t border-gray-200 dark:border-gray-700 p-3 space-y-2">
              {/* Tools row */}
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={handleUpload}
                />
                <button
                  onClick={handleUploadClick}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 text-sm hover:bg-gray-200 dark:hover:bg-gray-600"
                >
                  <span style={{ fontSize: 18 }}>📎</span>
                  <span className="font-medium">Upload docs</span>
                </button>

                <div className="relative">
                  <button
                    onClick={() => setShowEmoji((v) => !v)}
                    className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 text-sm hover:bg-gray-200 dark:hover:bg-gray-600"
                    aria-expanded={showEmoji}
                  >
                    😊 Emoji
                  </button>
                  {showEmoji && (
                    <div className="absolute z-10 mt-2 p-2 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Quick emoji</span>
                        <div className="flex items-center gap-1">
                          {/* Skin tone picker applies to 👍/👎 */}
                          <button
                            className={`w-5 h-5 rounded-full border text-xs ${
                              thumbTone === 0 ? "ring-2 ring-blue-500" : ""
                            }`}
                            onClick={() => setThumbTone(0)}
                          >
                            ✋
                          </button>
                          {SKIN_TONES.map((t, idx) => (
                            <button
                              key={t}
                              className={`w-5 h-5 rounded-full border text-xs ${
                                thumbTone === idx + 1 ? "ring-2 ring-blue-500" : ""
                              }`}
                              onClick={() => setThumbTone(idx + 1)}
                              title={`Skin tone ${idx + 1}`}
                            >
                              ✋
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="grid grid-cols-8 gap-1">
                        {renderedEmojis.map((e) => (
                          <button
                            key={e}
                            onClick={() => {
                              setInput((prev) => (prev ? prev + " " + e : e));
                              setShowEmoji(false);
                            }}
                            className="px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Input row */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your message…"
                  className="flex-1 px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className={`px-4 py-2 rounded text-white ${
                    input.trim()
                      ? "bg-green-600 hover:bg-green-700"
                      : "bg-green-900/40 cursor-not-allowed"
                  }`}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
          {/* /Chat Card */}
        </div>
      </main>
    </>
  );
}
