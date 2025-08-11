import Head from "next/head";
import { useEffect, useRef, useState } from "react";

// Tiny helper so the same session is reused every visit
function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "";
  let sid = localStorage.getItem("da_session_id");
  if (!sid) {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      sid = (crypto as any).randomUUID();
    } else {
      sid = Math.random().toString(36).slice(2);
    }
    localStorage.setItem("da_session_id", sid);
  }
  return sid;
}

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Persisted session + first INIT call (only once per session)
  useEffect(() => {
    const sid = getOrCreateSessionId();
    setSessionId(sid);

    const startedKey = `da_started_${sid}`;
    const alreadyStarted = localStorage.getItem(startedKey);

    if (!alreadyStarted) {
      // call API to start script at step 0
      (async () => {
        setIsTyping(true);
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "INIT", sessionId: sid }),
          });
          const data = await res.json();
          setMessages([{ role: "assistant", content: data.reply || "Hello! Let’s get started." }]);
          localStorage.setItem(startedKey, "1");
        } catch {
          setMessages([{ role: "assistant", content: "Sorry, I couldn’t start the chat. Please refresh." }]);
        } finally {
          setIsTyping(false);
        }
      })();
    }
  }, []);

  // Auto scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  const handleSend = async () => {
    if (!input.trim() || !sessionId) return;
    const userText = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, sessionId }),
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, something went wrong sending that. Please try again." },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
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
        } min-h-screen w-full flex items-center justify-center p-4 transition-colors duration-300`}
      >
        <div className="w-full max-w-2xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-xl font-semibold">Debt Advisor</h1>
            <div className="flex items-center gap-2">
              <select className="p-2 border rounded text-sm">
                <option>English</option>
              </select>
              <button
                onClick={toggleTheme}
                className="px-3 py-2 rounded bg-blue-600 text-white text-sm"
              >
                {theme === "light" ? "Dark" : "Light"} Mode
              </button>
            </div>
          </div>

          {/* Chat window */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 h-[60vh] overflow-y-auto">
            {messages.map((m, i) => (
              <div key={i} className={`mb-2 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`px-4 py-2 rounded-lg max-w-[80%] text-sm ${
                    m.role === "user"
                      ? "bg-green-600 text-white"
                      : "bg-gray-100 text-black dark:bg-gray-700 dark:text-white"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {isTyping && <div className="text-xs text-gray-500 italic">Mark is typing…</div>}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="mt-3 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              type="text"
              placeholder="Type your message…"
              className="flex-1 p-2 border rounded"
            />
            <button onClick={handleSend} className="px-4 py-2 rounded bg-green-600 text-white">
              Send
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
