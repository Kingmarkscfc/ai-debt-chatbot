import { useState } from "react";

export default function Home() {
  const [theme, setTheme] = useState("light");
  const [inputValue, setInputValue] = useState("");

  const handleSend = () => {
    if (inputValue.trim()) {
      console.log("Sending message:", inputValue);
      // TODO: Connect this to fetch POST /api/chat
      setInputValue("");
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  return (
    // ...rest of your layout
    <div className="flex items-center space-x-2">
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyPress}
        placeholder="Type your message..."
        className="flex-grow p-2 border rounded"
      />
      <button
        onClick={handleSend}
        className="p-2 bg-green-600 text-white rounded"
      >
        Send
      </button>
    </div>
  );
}
