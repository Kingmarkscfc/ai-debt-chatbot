import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { useEffect, useState } from "react";

export default function App({ Component, pageProps }: AppProps) {
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(theme);
  }, [theme]);

  return (
    <div className={theme === "dark" ? "dark" : ""}>
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-black dark:text-white transition-colors duration-300">
        <button
          className="fixed top-4 right-4 bg-gray-300 dark:bg-gray-700 text-black dark:text-white py-1 px-3 rounded"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          Toggle {theme === "dark" ? "Light" : "Dark"} Mode
        </button>
        <Component {...pageProps} />
      </div>
    </div>
  );
}
