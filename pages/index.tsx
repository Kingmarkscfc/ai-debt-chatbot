import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState<{ sender: "user" | "bot"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [tableData, setTableData] = useState<{ [key: string]: number }>({});
  const [showTable, setShowTable] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const startMessage = async () => {
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "\uD83D\uDC4B INITIATE" }),
        });
        const data = await response.json();
        handleBotReply(data.reply);
      } catch {
        setMessages([{ sender: "bot", text: "⚠️ Error connecting to chatbot." }]);
      }
    };
    startMessage();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, showTable]);

  const handleBotReply = (reply: string) => {
    if (reply.startsWith("#INCOME_EXPENSES_TABLE")) {
      setShowTable(true);
    } else {
      setMessages((prev) => [...prev, { sender: "bot", text: reply }]);
    }
  };

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
      handleBotReply(data.reply);
    } catch {
      setMessages((prev) => [...prev, { sender: "bot", text: "⚠️ Error connecting to chatbot." }]);
    }

    setInput("");
  };

  const handleTableInput = (field: string, value: string) => {
    setTableData((prev) => ({ ...prev, [field]: Number(value) }));
  };

  const handleSubmitTable = async () => {
    const response = await fetch("/api/income-expense", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "demo-session", tableData }),
    });
    const data = await response.json();
    setShowTable(false);
    setMessages((prev) => [...prev, { sender: "bot", text: data.reply }]);
  };

  const styles: { [key: string]: React.CSSProperties } = {
    container: { maxWidth: "600px", margin: "0 auto", padding: "20px", fontFamily: "Arial, sans-serif" },
    header: { textAlign: "center", marginBottom: "20px" },
    chatbox: {
      border: "1px solid #ccc",
      borderRadius: "8px",
      padding: "10px",
      height: "400px",
      overflowY: "auto",
      marginBottom: "10px",
      backgroundColor: "#f9f9f9",
      display: "flex",
      flexDirection: "column" as const,
    },
    bubble: { padding: "10px", borderRadius: "10px", marginBottom: "10px", maxWidth: "80%" },
    userBubble: { backgroundColor: "#d4f0ff", alignSelf: "flex-end", textAlign: "right" as const },
    botBubble: { backgroundColor: "#f0f0f0", alignSelf: "flex-start", textAlign: "left" as const },
    inputRow: { display: "flex", gap: "10px" },
    input: { flex: 1, padding: "10px", borderRadius: "5px", border: "1px solid #ccc" },
    button: { padding: "10px 20px", borderRadius: "5px", border: "none", backgroundColor: "#0070f3", color: "#fff", cursor: "pointer" },
    tableContainer: { padding: "10px", background: "#fff", borderRadius: "8px", border: "1px solid #ccc" },
    table: { width: "100%", borderCollapse: "collapse" },
    tableCell: { border: "1px solid #ddd", padding: "8px" },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>💬 AI Debt Advisor</h1>
      <div style={styles.chatbox}>
        {messages.map((msg, i) => (
          <div key={i} style={{ ...styles.bubble, ...(msg.sender === "user" ? styles.userBubble : styles.botBubble) }}>
            {msg.text}
          </div>
        ))}

        {showTable && (
          <div style={styles.tableContainer}>
            <table style={styles.table}>
              <thead>
                <tr><th>Category</th><th>Amount (£)</th></tr>
              </thead>
              <tbody>
                {["Wages", "Benefits", "Rent", "Utilities", "Food", "Transport", "Other"].map((item, i) => (
                  <tr key={i}>
                    <td style={styles.tableCell}>{item}</td>
                    <td style={styles.tableCell}>
                      <input type="number" name={item} onChange={(e) => handleTableInput(item, e.target.value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button onClick={handleSubmitTable} style={{ ...styles.button, marginTop: "10px" }}>Submit</button>
          </div>
        )}
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
