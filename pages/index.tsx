import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState<{ sender: "user" | "bot"; text: string }[]>([]);
  const [input, setInput] = useState("");
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
      const botMessage = { sender: "bot" as const, text: data.reply || "⚠️ Empty reply." };
      setMessages((prev) => [...prev, botMessage]);
    } catch {
      setMessages((prev) => [...prev, { sender: "bot", text: "⚠️ Connection error." }]);
    }

    setInput("");
  };

  const styles: { [key: string]: React.CSSProperties } = {
    container: {
      maxWidth: "600px",
      margin: "0 auto",
      padding: "20px",
      fontFamily: "'Segoe UI', sans-serif",
    },
    header: {
      textAlign: "center",
      marginBottom: "20px",
      fontSize: "1.8rem",
    },
    chatbox: {
      border: "1px solid #ddd",
      borderRadius: "12px",
      padding: "15px",
      height: "450px",
      overflowY: "auto",
      backgroundColor: "#fdfdfd",
      display: "flex",
      flexDirection: "column" as const,
      boxShadow: "0 4px 8px rgba(0,0,0,0.05)",
    },
    messageRow: {
      display: "flex",
      alignItems: "flex-start",
      gap: "10px",
      marginBottom: "12px",
    },
    avatar: {
      width: "36px",
      height: "36px",
      borderRadius: "50%",
      fontSize: "20px",
      textAlign: "center",
      lineHeight: "36px",
    },
    bubble: {
      padding: "10px 14px",
      borderRadius: "14px",
      maxWidth: "75%",
      fontSize: "1rem",
      lineHeight: "1.4",
    },
    userBubble: {
      backgroundColor: "#d4f0ff",
      alignSelf: "flex-end",
    },
    botBubble: {
      backgroundColor: "#e6e6e6",
      alignSelf: "flex-start",
    },
    inputRow: {
      display: "flex",
      marginTop: "12px",
      gap: "10px",
    },
    input: {
      flex: 1,
      padding: "10px",
      borderRadius: "6px",
      border: "1px solid #ccc",
      fontSize: "1rem",
    },
    button: {
      padding: "10px 20px",
      borderRadius: "6px",
      border: "none",
      backgroundColor: "#0070f3",
      color: "#fff",
      fontSize: "1rem",
      cursor: "pointer",
    },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>💬 AI Debt Advisor</h1>
      <div style={styles.chatbox}>
        {messages.map((msg, i) => (
          <div key={i} style={styles.messageRow}>
            <div style={{ ...styles.avatar, backgroundColor: msg.sender === "bot" ? "#ccc" : "#0070f3", color: msg.sender === "bot" ? "#000" : "#fff" }}>
              {msg.sender === "bot" ? "🤖" : "🧑"}
            </div>
            <div style={{ ...styles.bubble, ...(msg.sender === "bot" ? styles.botBubble : styles.userBubble) }}>
              {msg.text}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={styles.inputRow}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          placeholder="Type your message..."
        />
        <button style={styles.button} onClick={handleSubmit}>Send</button>
      </div>
    </div>
  );
}
