import Head from "next/head";
import { useState } from "react";

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [language, setLanguage] = useState("English");

  const toggleTheme = () => {
    setTheme(theme === "light" ? "dark" : "light");
  };

  return (
    <div className={`${theme === "dark" ? "bg-gray-900 text-white" : "bg-gray-100 text-black"} min-h-screen flex items-center justify-center px-4`}>
      <Head>
        <title>Debt Advisor Chat</title>
      </Head>
      <div className="w-full max-w-xl border rounded-2xl shadow-lg p-6 bg-white dark:bg-gray-800">
        <h1 className="text-2xl font-bold mb-4">Debt Advisor</h1>

        <div className="flex justify-between items-center mb-4">
          <div>
            <label className="mr-2">🌍</label>
            <select
              className="border rounded px-2 py-1 text-sm bg-white text-black"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option>English</option>
              <option>Spanish</option>
              <option>Polish</option>
              <option>French</option>
              <option>German</option>
              <option>Portuguese</option>
              <option>Italian</option>
              <option>Romanian</option>
            </select>
          </div>

          <button
            onClick={toggleTheme}
            className="text-sm px-3 py-1 border rounded bg-gray-200 dark:bg-gray-700 dark:text-white"
          >
            Toggle {the
