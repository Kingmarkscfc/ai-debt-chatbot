import "../styles/globals.css";
import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <main className="min-h-screen w-full bg-gray-100 text-black dark:bg-gray-900 dark:text-white transition-colors duration-300">
      <Component {...pageProps} />
    </main>
  );
}

