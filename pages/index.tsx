import { useEffect, useRef, useState } from "react";

const LANGUAGES = [
  "English",
  "Spanish",
  "Polish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Romanian",
];

export default function Home() {
  const [messages, setMessages] = useState<{ sender: "user" | "bot"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on message update
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // On first load, try to resume session
  useEffect(() => {
    const storedMessages = localStorage.getItem("chatMessages");
    const storedLang = localStorage.getItem("chatLang");

    if (storedMessages) {
      setMessages(JSON.parse(storedMessages));
    }

    if (storedLang) {
      setLanguage(storedLang);
    }
  }, []);

  // Save chat to localStorage
  useEffect(() => {
    localStorage.setItem("chatMessages", JSON.stringify(messages));
  }, [messages]);

  const sendMessage = async (text: string) => {
    const userMsg = { sender: "user" as const, text };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userMessage: text, sessionId: "user-123", history: messages.map(m => m.text) }),
      });

      const data = await response.json();
      const botMsg = { sender: "bot" as const, text: data.reply || "⚠️ No response from server." };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      setMessages((prev) => [...prev, { sender: "bot", text: "⚠️ Error connecting to chatbot." }]);
    }

    setInput("");
  };

  const handleLanguageSelect = (lang: string) => {
    setLanguage(lang);
    localStorage.setItem("chatLang", lang);
    sendMessage("👋 INITIATE");
  };

  const handleSubmit = () => {
    if (!input.trim()) return;
    sendMessage(input.trim());
  };

  const styles: { [key: string]: React.CSSProperties } = {
    container: { maxWidth: "600px", margin: "0 auto", padding: "20px", fontFamily: "Arial, sans-serif" },
    header: { textAlign: "center", marginBottom: "20px" },
    chatbox: {
      border: "1px solid #ccc", borderRadius: "8px", padding: "10px",
      height: "400px", overflowY: "auto", marginBottom: "10px",
      backgroundColor: "#f9f9f9", display: "flex", flexDirection: "column",
    },
    bubble: {
      padding: "10px", borderRadius: "10px", marginBottom: "10px", maxWidth: "80%",
    },
    userBubble: { backgroundColor: "#d4f0ff", alignSelf: "flex-end", textAlign: "right" },
    botBubble: { backgroundColor: "#f0f0f0", alignSelf: "flex-start", textAlign: "left" },
    inputRow: { display: "flex", gap: "10px" },
    input: { flex: 1, padding: "10px", borderRadius: "5px", border: "1px solid #ccc" },
    button: { padding: "10px 20px", borderRadius: "5px", border: "none", backgroundColor: "#0070f3", color: "#fff", cursor: "pointer" },
    langBtn: {
      margin: "5px", padding: "8px 16px", borderRadius: "5px", border: "1px solid #ccc",
      cursor: "pointer", backgroundColor: "#fff"
    },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>💬 AI Debt Advisor</h1>

      {!language ? (
        <>
          <p>
            Hello, my name’s Mark 👋 I’m here to help you explore your debt options.
            <br />
            To begin, please choose your preferred language:
          </p>
          <div>
            {LANGUAGES.map((lang) => (
              <button key={lang} style={styles.langBtn} onClick={() => handleLanguageSelect(lang)}>
                {lang}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div style={styles.chatbox}>
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  ...styles.bubble,
                  ...(msg.sender === "user" ? styles.userBubble : styles.botBubble),
                }}
              >
                {msg.text}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div style={styles.inputRow}>
            <input
              style={styles.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="Type your message..."
            />
            <button style={styles.button} onClick={handleSubmit}>
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}
