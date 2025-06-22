import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState<{ sender: "user" | "bot"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState("English");
  const bottomRef = useRef<HTMLDivElement>(null);

  // 👋 Auto-start with INITIATE and language message
  useEffect(() => {
    const startMessage = async () => {
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "👋 INITIATE" }),
        });
        const data = await response.json();
        setMessages([
          { sender: "bot", text: data.reply },
          { sender: "bot", text: "🌍 You can change languages anytime using the dropdown above." },
        ]);
      } catch {
        setMessages([{ sender: "bot", text: "⚠️ Error connecting to chatbot." }]);
      }
    };
    startMessage();
  }, []);

  // 🔽 Scroll to bottom on update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleLanguageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = e.target.value;
    setLanguage(selected);
    const systemMessage = `Language: ${selected}`;
    setMessages((prev) => [...prev, { sender: "user", text: systemMessage }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: systemMessage }),
      });
      const data = await response.json();
      setMessages((prev) => [...prev, { sender: "bot", text: data.reply }]);
    } catch {
      setMessages((prev) => [...prev, { sender: "bot", text: "⚠️ Error updating language." }]);
    }
  };

  const handleSubmit = async () => {
    if (!input.trim()) return;

    setMessages((prev) => [...prev, { sender: "user", text: input }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
      });

      const data = await response.json();
      const botMessage = {
        sender: "bot" as const,
        text: data.reply || "⚠️ Error: Empty reply from server.",
      };

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
    },
    headerRow: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "10px",
    },
    title: {
      fontSize: "20px",
      fontWeight: "bold",
    },
    select: {
      padding: "6px",
      borderRadius: "5px",
      border: "1px solid #ccc",
    },
    chatbox: {
      border: "1px solid #ccc",
      borderRadius: "8px",
      padding: "10px",
      height: "400px",
      overflowY: "auto",
      backgroundColor: "#f9f9f9",
      display: "flex",
      flexDirection: "column" as const,
      marginBottom: "10px",
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
      <div style={styles.headerRow}>
        <span style={styles.title}>💬 AI Debt Advisor</span>
        <select style={styles.select} value={language} onChange={handleLanguageChange}>
          <option value="English">🌐 English</option>
          <option value="Spanish">🇪🇸 Spanish</option>
          <option value="Polish">🇵🇱 Polish</option>
          <option value="French">🇫🇷 French</option>
          <option value="German">🇩🇪 German</option>
          <option value="Portuguese">🇵🇹 Portuguese</option>
          <option value="Italian">🇮🇹 Italian</option>
          <option value="Romanian">🇷🇴 Romanian</option>
        </select>
      </div>

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
