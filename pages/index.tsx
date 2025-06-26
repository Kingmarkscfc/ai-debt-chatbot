import Head from "next/head";
import { useState } from "react";
import "@/styles/globals.css";

export default function Home() {
  const [theme, setTheme] = useState("light");
  const toggleTheme = () => {
    setTheme(theme === "light" ? "dark" : "light");
  };

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div
        className={`${
          theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black"
        } min-h-screen flex flex-col items-center justify-center p-4`}
        style={{ minHeight: "100vh" }}
      >
        <div className="w-full max-w-xl space-y-4">
          <h1 className="text-2xl font-semibold text-center">Debt Advisor</h1>
          <div className="flex justify-between items-center">
            <select className="p-2 border rounded">
              <option>English</option>
              <option>Español</option>
              <option>Français</option>
            </select>
            <button
              className="p-2 rounded bg-blue-500 text-white"
              onClick={toggleTheme}
            >
              Toggle {theme === "light" ? "Dark" : "Light"} Mode
            </button>
          </div>
          <div className="bg-white dark:bg-gray-800 p-4 rounded shadow min-h-[300px]">
            <p>Hello! My name’s Mark. What prompted you to seek help with your debts today?</p>
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              placeholder="Type your message..."
              className="flex-grow p-2 border rounded"
            />
            <button className="p-2 bg-green-600 text-white rounded">Send</button>
          </div>
        </div>
      </div>
    </>
  );
}
