import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState<{ sender: "user" | "bot"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [darkMode, setDarkMode] = useState(false);
  const [language, setLanguage] = useState("English");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const startMessage = async () => {
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "👋 INITIATE" }),
        });
        const data = await response.json();
        setMessages([{ sender: "bot", text: data.reply }]);
      } catch {
        setMessages([{ sender: "bot", text: "⚠️ Error connecting to chatbot." }]);
      }
    };
    startMessage();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async () => {
    if (!input.trim()) return;

    const userMessage = { sender: "user" as const, text: input };
    setMessages((prev) => [...prev, userMessage]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
      });

      const data = await response.json();
      const botMessage = { sender: "bot" as const, text: data.reply || "⚠️ Error: Empty reply from server." };
      setMessages((prev) => [...prev, botMessage]);
    } catch {
      setMessages((prev) => [...prev, { sender: "bot", text: "⚠️ Error connecting to chatbot." }]);
    }

    setInput("");
  };

  const styles: { [key: string]: React.CSSProperties } = {
    container: {
      maxWidth: "600px",
      margin: "0 auto",
      padding: "20px",
      fontFamily: "Arial, sans-serif",
      backgroundColor: darkMode ? "#1e1e1e" : "#fff",
      color: darkMode ? "#f0f0f0" : "#000",
      minHeight: "100vh"
    },
    header: {
      textAlign: "center",
      marginBottom: "20px",
    },
    controls: {
      display: "flex",
      justifyContent: "space-between",
      marginBottom: "10px",
    },
    select: {
      padding: "8px",
      borderRadius: "5px",
    },
    toggle: {
      padding: "8px 12px",
      borderRadius: "5px",
      backgroundColor: darkMode ? "#444" : "#ccc",
      color: darkMode ? "#fff" : "#000",
      cursor: "pointer",
    },
    chatbox: {
      border: "1px solid #ccc",
      borderRadius: "8px",
      padding: "10px",
      height: "400px",
      overflowY: "auto",
      marginBottom: "10px",
      backgroundColor: darkMode ? "#2e2e2e" : "#f9f9f9",
      display: "flex",
      flexDirection: "column" as const,
    },
    messageRow: {
      display: "flex",
      alignItems: "flex-end",
      gap: "10px",
    },
    avatar: {
      width: "32px",
      height: "32px",
      borderRadius: "50%",
      backgroundColor: "#0070f3",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#fff",
      fontWeight: "bold",
    },
    bubble: {
      padding: "12px",
      borderRadius: "12px",
      maxWidth: "80%",
      boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
    },
    userBubble: {
      backgroundColor: "#d4f0ff",
      alignSelf: "flex-end",
      textAlign: "right" as const,
    },
    botBubble: {
      backgroundColor: "#e0e0e0",
      alignSelf: "flex-start",
      textAlign: "left" as const,
    },
    inputRow: {
      display: "flex",
      gap: "10px",
    },
    input: {
      flex: 1,
      padding: "10px",
      borderRadius: "5px",
      border: "1px solid #ccc",
    },
    button: {
      padding: "10px 20px",
      borderRadius: "5px",
      border: "none",
      backgroundColor: "#0070f3",
      color: "#fff",
      cursor: "pointer",
    },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>💬 AI Debt Advisor</h1>
      <div style={styles.controls}>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} style={styles.select}>
          <option>English</option>
          <option>Spanish</option>
          <option>French</option>
          <option>German</option>
          <option>Polish</option>
          <option>Romanian</option>
          <option>Portuguese</option>
          <option>Italian</option>
        </select>
        <button style={styles.toggle} onClick={() => setDarkMode(!darkMode)}>
          {darkMode ? "🌞 Light Mode" : "🌙 Dark Mode"}
        </button>
      </div>
      <div style={styles.chatbox}>
        {messages.map((msg, i) => (
          <div key={i} style={{ ...styles.messageRow, justifyContent: msg.sender === "user" ? "flex-end" : "flex-start" }}>
            {msg.sender === "bot" && <div style={styles.avatar}>🤖</div>}
            <div
              style={{
                ...styles.bubble,
                ...(msg.sender === "user" ? styles.userBubble : styles.botBubble),
              }}
            >
              {msg.text}
            </div>
            {msg.sender === "user" && <div style={styles.avatar}>🧑</div>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={styles.inputRow}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          placeholder="Type your message..."
        />
        <button style={styles.button} onClick={handleSubmit}>
          Send
        </button>
      </div>
    </div>
  );
}