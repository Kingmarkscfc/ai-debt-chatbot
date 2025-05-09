// pages/index.tsx

import { useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState([
    { text: "👋 Hello! I'm your AI Debt Advisor. How can I help today?", sender: "bot" },
  ]);
  const [input, setInput] = useState("");

  const user_id = "demo-user-1234"; // 🔐 You can replace this with real UUID later

  const sendMessage = async () => {
    if (!input.trim()) return;

    const userMessage = { text: input, sender: "user" };
    setMessages((prev) => [...prev, userMessage]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id, message: input }),
      });

      const data = await response.json();
      const botMessage = { text: data.reply, sender: "bot" };
      setMessages((prev) => [...prev, botMessage]);
    } catch (err) {
      setMessages((prev) => [...prev, { text: "⚠️ Error connecting to bot.", sender: "bot" }]);
    }

    setInput("");
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>💬 AI Debt Advisor</h1>
      <div style={styles.chatbox}>
        {messages.map((msg, i) => (
          <div key={i} style={msg.sender === "user" ? styles.userBubble : styles.botBubble}>
            {msg.text}
          </div>
        ))}
      </div>
      <div style={styles.inputRow}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={styles.input}
          placeholder="Type your message..."
        />
        <button onClick={sendMessage} style={styles.button}>Send</button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    maxWidth: "600px",
    margin: "40px auto",
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
    overflowY: "auto",
    marginBottom: "10px",
    backgroundColor: "#f9f9f9",
  },
  userBubble: {
    background: "#dcf8c6",
    padding: "10px",
    borderRadius: "15px",
    margin: "10px 0",
    alignSelf: "flex-end",
    textAlign: "right",
  },
  botBubble: {
    background: "#eee",
    padding: "10px",
    borderRadius: "15px",
    margin: "10px 0",
    alignSelf: "flex-start",
  },
  inputRow: {
    display: "flex",
    gap: "10px",
  },
  input: {
    flexGrow: 1,
    padding: "10px",
    fontSize: "16px",
    borderRadius: "5px",
    border: "1px solid #ccc",
  },
  button: {
    padding: "10px 15px",
    fontSize: "16px",
    backgroundColor: "#0070f3",
    color: "white",
    border: "none",
    borderRadius: "5px",
    cursor: "pointer",
  },
};
