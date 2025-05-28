import { useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState<{ sender: "user" | "bot"; text: string }[]>([]);
  const [input, setInput] = useState("");

const handleSubmit = async () => {
  if (!input.trim()) return;

  const userMessage: { sender: "user" | "bot"; text: string } = {
    sender: "user",
    text: input,
  };

  setMessages((prev: { sender: "user" | "bot"; text: string }[]) => [
    ...prev,
    userMessage,
  ]);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input }),
    });

    const data = await response.json();

    const botMessage: { sender: "user" | "bot"; text: string } = {
      sender: "bot",
      text: data.reply || "⚠️ Error: Empty reply from server.",
    };

    setMessages((prev) => [...prev, botMessage]);
  } catch (err) {
    setMessages((prev) => [
      ...prev,
      { sender: "bot", text: "⚠️ Error connecting to chatbot." },
    ]);
  }
};

  const styles: { [key: string]: React.CSSProperties } = {
    container: {
      maxWidth: "600px",
      margin: "0 auto",
      padding: "20px",
      fontFamily: "Arial, sans-serif",
    },
    header: {
      textAlign: "center" as const,
      marginBottom: "20px",
    },
    chatbox: {
      border: "1px solid #ccc",
      borderRadius: "8px",
      padding: "10px",
      height: "400px",
      overflowY: "auto" as React.CSSProperties["overflowY"],
      marginBottom: "10px",
      backgroundColor: "#f9f9f9",
    },
    bubble: {
      padding: "10px",
      borderRadius: "10px",
      marginBottom: "10px",
      maxWidth: "80%",
    },
    userBubble: {
      backgroundColor: "#d4f0ff",
      alignSelf: "flex-end",
      textAlign: "right" as const,
    },
    botBubble: {
      backgroundColor: "#f0f0f0",
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
      </div>
      <div style={styles.inputRow}>
        <input
  style={styles.input}
  value={input}
  onChange={(e) => setInput(e.target.value)}
  onKeyDown={(e) => {
    if (e.key === 'Enter') handleSubmit();
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
