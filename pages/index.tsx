iimport Head from "next/head";
import { useEffect, useRef, useState } from "react";

type Msg =
  | { role: "assistant" | "user"; content: string }
  | { role: "system"; content: string }
  | { role: "file"; fileName: string; fileUrl: string; from: "user" | "assistant" };

const EMOJIS = ["🙂", "😟", "👍", "👎", "✅", "❌"];

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [voiceOn, setVoiceOn] = useState(false);
  const [lang, setLang] = useState("English");
  const [journey, setJourney] = useState(8);
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let sid = localStorage.getItem("da_session_id");
    if (!sid) {
      sid = Math.random().toString(36).slice(2);
      localStorage.setItem("da_session_id", sid);
    }
    setSessionId(sid);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  useEffect(() => {
    if (!voiceOn) return;
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last || !("content" in last!)) return;
    const utter = new SpeechSynthesisUtterance((last as any).content);
    utter.lang = "en-GB";
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
  }, [messages, voiceOn]);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  const toggleVoice = () => setVoiceOn((v) => !v);

  async function sendMessage(text: string) {
    const userMessage = text.trim();
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
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply || "…" }]);
      setIsTyping(false);
      if (typeof data.progress === "number") setJourney(data.progress);
      if (data.sessionId && data.sessionId !== sessionId) setSessionId(data.sessionId);
    } catch {
      setIsTyping(false);
      setMessages((prev) => [
        ...prev,
        { role: "system", content: "Sorry, something went wrong. Please try again." },
      ]);
    }
  }

  const handleSend = () => sendMessage(input);
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && handleSend();
  const handleQuick = (txt: string) => sendMessage(txt);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setMessages((prev) => [...prev, { role: "file", fileName: file.name, fileUrl: "", from: "user" }]);

    const form = new FormData();
    form.append("file", file);
    form.append("sessionId", sessionId);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      setMessages((prev) => {
        const cloned = [...prev];
        for (let i = cloned.length - 1; i >= 0; i--) {
          const m = cloned[i] as any;
          if (m?.fileName === file.name && m?.from === "user" && !m?.fileUrl) {
            cloned[i] = { ...m, fileUrl: data.url || "" };
            break;
          }
        }
        return cloned;
      });
    } catch {
      setMessages((prev) => [...prev, { role: "system", content: "Upload failed. Please try again." }]);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const rootBg = theme === "dark" ? "bg-gray-900" : "bg-slate-200";
  const cardBg = theme === "dark" ? "bg-gray-800" : "bg-white";
  const textCol = theme === "dark" ? "text-white" : "text-gray-900";
  const subText = theme === "dark" ? "text-gray-300" : "text-gray-600";
  const msgUser = "bg-blue-600 text-white";
  const msgBot = theme === "dark" ? "bg-gray-700 text-white" : "bg-gray-100 text-gray-900";
  const inputBg = theme === "dark" ? "bg-gray-700 text-white" : "bg-gray-100 text-gray-900";
  const divider = theme === "dark" ? "border-gray-700" : "border-gray-200";
  const chip = theme === "dark" ? "bg-indigo-900/40 text-indigo-100" : "bg-indigo-100 text-indigo-800";

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* CENTERED BACKDROP */}
      <div className={`${rootBg} min-h-screen w-full chat-shell`}>
        <div className="chat-card-outer">
          {/* MAKE THIS A FLEX COLUMN SO CONTENT FILLS THE CARD */}
          <div className={`chat-card-inner flex flex-col ${cardBg} ${textCol}`}>
            {/* HEADER */}
            <div className={`flex items-center justify-between px-5 py-3 border-b ${divider}`}>
              <div className="flex items-center gap-3">
                <div className="font-semibold text-lg">Debt Advisor</div>
                <div className="flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.8)]"></span>
                  <span className="text-emerald-400 text-sm font-semibold">Online</span>
                </div>
              </div>
              <div className={`text-sm ${subText}`}>Journey {journey}%</div>
            </div>

            {/* CONTROLS */}
            <div className={`flex items-center gap-2 px-5 py-2 border-b ${divider}`}>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className={`px-2 py-1 text-sm rounded border ${divider} ${theme === "dark" ? "bg-gray-800 text-white" : "bg-white text-gray-900"}`}
              >
                <option>English</option>
                <option>Español</option>
                <option>Français</option>
                <option>Deutsch</option>
                <option>Polski</option>
                <option>Română</option>
              </select>

              <button onClick={toggleVoice} className={`px-2 py-1 text-sm rounded border ${divider}`}>
                {voiceOn ? "🔈 Voice On" : "🔈 Voice Off"}
              </button>

              <button onClick={toggleTheme} className={`ml-auto px-2 py-1 text-sm rounded border ${divider}`}>
                {theme === "light" ? "🌙 Dark" : "☀️ Light"}
              </button>
            </div>

            {/* MESSAGES AREA (FLEX-1 SO IT TAKES SPACE) */}
            <div className={`flex-1 overflow-y-auto px-5 py-4 space-y-3`}>
              {messages.map((m, i) => {
                if ("fileName" in m) {
                  const mine = m.from === "user";
                  return (
                    <div key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`p-3 rounded-xl max-w-[80%] ${mine ? msgUser : msgBot}`}>
                        <div className="font-semibold mb-1">📎 {m.fileName}</div>
                        {m.fileUrl ? (
                          <a href={m.fileUrl} target="_blank" rel="noreferrer" className="underline">
                            Download
                          </a>
                        ) : (
                          <span className="opacity-80">Uploading…</span>
                        )}
                      </div>
                    </div>
                  );
                }
                if (m.role === "system") {
                  return (
                    <div key={i} className={`text-center text-xs ${subText}`}>
                      {m.content}
                    </div>
                  );
                }
                const mine = m.role === "user";
                return (
                  <div key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div className={`p-3 rounded-xl max-w-[80%] ${mine ? msgUser : msgBot}`}>
                      {m.content}
                    </div>
                  </div>
                );
              })}
              {isTyping && (
                <div className="flex justify-start">
                  <div className={`p-3 rounded-xl ${msgBot}`}>Mark is typing…</div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* QUICK REPLIES */}
            <div className={`px-5 py-2 border-t ${divider} flex flex-wrap gap-2`}>
              {["I have credit card debts", "Bailiffs worry me", "Court action", "Missed payments"].map((q) => (
                <button key={q} onClick={() => handleQuick(q)} className={`px-3 py-1 text-sm rounded-full ${chip} hover:opacity-90`}>
                  {q}
                </button>
              ))}
            </div>

            {/* UPLOAD + EMOJIS */}
            <div className={`px-5 py-2 border-t ${divider}`}>
              <div className="flex items-center gap-3 flex-wrap">
                <input ref={fileInputRef} type="file" onChange={handleFile} className="hidden" id="fileUpload" />
                <label htmlFor="fileUpload" className="cursor-pointer inline-flex items-center gap-2 font-semibold text-blue-500 hover:text-blue-600">
                  <span className="text-xl">📎</span>
                  <span>Upload docs</span>
                </label>

                <div className="ml-auto flex items-center gap-2 text-2xl">
                  {EMOJIS.map((e) => (
                    <button
                      key={e}
                      className="hover:scale-110 transition"
                      onClick={() => setInput((prev) => (prev ? `${prev} ${e}` : e))}
                      aria-label={`emoji ${e}`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* INPUT */}
            <div className={`flex items-center gap-2 px-5 py-3 border-t ${divider}`}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Type your message…"
                className={`flex-1 rounded-xl px-3 py-2 text-sm focus:outline-none ${inputBg}`}
              />
              <button onClick={handleSend} className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700">
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

