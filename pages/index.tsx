import Head from "next/head";
import { useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "assistant";
type Attachment = { filename: string; url: string; mimeType: string; size?: number };
type Msg = { role: Role; content: string; attachment?: Attachment };

const formatBytes = (n?: number) => {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let i = -1;
  do {
    n = n / 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
};

// --- Local persistent session id (stable, string not null)
function ensureSessionId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  let sid = localStorage.getItem("da_session_id");
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    localStorage.setItem("da_session_id", sid);
  }
  return sid;
}

// --- Web Speech helpers (pick UK male if available)
function pickUkMaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices || voices.length === 0) return null;

  // Strong name preferences by browser/vendor
  const preferredNames = [
    "Google UK English Male", // Chrome
    "Microsoft Ryan Online (Natural) - English (United Kingdom)", // Edge
    "Daniel", // Safari macOS
    "UK English Male",
  ];

  for (const name of preferredNames) {
    const v = voices.find((vv) => vv.name === name);
    if (v) return v;
  }

  // Next-best: any en-GB voice
  const enGb = voices.find((v) => (v.lang || "").toLowerCase().startsWith("en-gb"));
  if (enGb) return enGb;

  // Fallback: any English voice
  const enAny = voices.find((v) => (v.lang || "").toLowerCase().startsWith("en-"));
  return enAny || null;
}

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [uploading, setUploading] = useState(false);

  const sessionId = useMemo(() => ensureSessionId(), []);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // Speak assistant messages when voiceOn
  useEffect(() => {
    if (!voiceOn) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;

    const speakNow = () => {
      const voices = window.speechSynthesis.getVoices();
      const picked = pickUkMaleVoice(voices);
      const u = new SpeechSynthesisUtterance(last.content);
      if (picked) u.voice = picked;
      u.rate = 1; // natural
      u.pitch = 1; // natural
      u.volume = 1;

      // Cancel any queued speech and speak latest
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    };

    // Chrome loads voices async; handle both
    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
      speakNow();
    } else {
      const onVoices = () => {
        speakNow();
        window.speechSynthesis.onvoiceschanged = null;
      };
      window.speechSynthesis.onvoiceschanged = onVoices;
    }
  }, [messages, voiceOn]);

  const toggleTheme = () => setTheme((p) => (p === "light" ? "dark" : "light"));

  const sendToApi = async (text: string) => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, sessionId }),
    });
    return res.json();
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setIsTyping(true);

    try {
      const data = await sendToApi(text);
      const reply = (data?.reply as string) || "Thanks — let's continue.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry — I couldn’t reach the server just now." },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  // Upload handler — posts file + sessionId to /api/upload, shows a tidy file chip w/ Download
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);

    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sessionId", sessionId);

      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await r.json();

      if (!data?.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "Upload failed — please try again in a moment." },
        ]);
        return;
      }

      // Clean filename: show the original only
      const cleanName = data?.file?.filename || file.name;
      const link = data?.downloadUrl || "";

      // Show a tidy file chip message with Download
      const niceMsg =
        link && cleanName
          ? `📎 Uploaded: ${cleanName}`
          : `📎 Uploaded your file${cleanName ? ` (${cleanName})` : ""}.`;

      const attachment: Attachment | undefined = link
        ? { filename: cleanName, url: link, mimeType: data?.file?.mimeType, size: data?.file?.size }
        : undefined;

      setMessages((prev) => [...prev, { role: "assistant", content: niceMsg, attachment }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Upload failed — network error." },
      ]);
    } finally {
      setUploading(false);
      // reset input so same-named file can be reselected
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

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
        <div className="w-full max-w-3xl">
          {/* Chat Card */}
          <div className="rounded-2xl border shadow-xl bg-white/90 dark:bg-gray-800/90 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b dark:border-gray-700">
              <div className="flex items-center gap-2">
                <div className="text-lg font-semibold">Debt Advisor</div>
                <span className="ml-2 inline-flex items-center gap-1 text-sm">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_6px_2px_rgba(34,197,94,0.7)]" />
                  <span className="text-green-500 font-medium">Online</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="text-sm px-2 py-1 rounded border dark:border-gray-600 bg-white dark:bg-gray-700"
                  value={"English"}
                  onChange={() => {}}
                >
                  <option>English</option>
                </select>
                <button
                  onClick={() => setVoiceOn((v) => !v)}
                  className="text-sm px-2 py-1 rounded border dark:border-gray-600 bg-white dark:bg-gray-700"
                  title="Toggle voice"
                >
                  {voiceOn ? "🔈 Voice On" : "🔇 Voice Off"}
                </button>
                <button
                  onClick={toggleTheme}
                  className="text-sm px-2 py-1 rounded border dark:border-gray-600 bg-white dark:bg-gray-700"
                  title="Toggle theme"
                >
                  {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
                </button>
              </div>
            </div>

            {/* Messages Area */}
            <div className="flex flex-col max-h-[65vh] min-h-[50vh] overflow-y-auto px-4 sm:px-6 py-4 gap-3 bg-gradient-to-b from-white to-gray-50 dark:from-gray-800 dark:to-gray-900">
              {messages.map((m, i) => {
                const isUser = m.role === "user";
                return (
                  <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`px-4 py-2 rounded-2xl max-w-[80%] text-sm leading-relaxed ${
                        isUser
                          ? "bg-green-600 text-white"
                          : "bg-gray-200 text-black dark:bg-gray-700 dark:text-white"
                      }`}
                    >
                      <div>{m.content}</div>
                      {m.attachment && (
                        <div className="mt-2">
                          <a
                            className="inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full border border-transparent bg-white/70 hover:bg-white text-gray-800 dark:text-gray-900"
                            href={m.attachment.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span>📄</span>
                            <span className="font-medium">{m.attachment.filename}</span>
                            {typeof m.attachment.size === "number" && (
                              <span className="opacity-70">({formatBytes(m.attachment.size)})</span>
                            )}
                            <span className="underline">Download</span>
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {isTyping && (
                <div className="flex justify-start">
                  <div className="px-4 py-2 rounded-2xl text-sm bg-gray-200 dark:bg-gray-700 dark:text-white">
                    Mark is typing…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Footer: Upload + Input */}
            <div className="px-4 sm:px-6 py-4 border-t dark:border-gray-700 flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                hidden
                onChange={handleFileSelected}
              />
              <button
                onClick={handleUploadClick}
                disabled={uploading}
                className="flex items-center gap-2 text-sm px-3 py-2 rounded-md border dark:border-gray-600 bg-white dark:bg-gray-700 hover:bg-gray-50 disabled:opacity-60"
                title="Upload documents"
              >
                📎 Upload docs {uploading && "…"}
              </button>

              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your message…"
                className="flex-1 px-3 py-2 rounded-md border dark:border-gray-600 bg-white dark:bg-gray-700 focus:outline-none"
              />
              <button
                onClick={handleSend}
                className="px-4 py-2 rounded-md bg-green-600 text-white hover:bg-green-700"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
