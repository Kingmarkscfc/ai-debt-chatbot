import '../styles/globals.css';
import type { AppProps } from 'next/app';
import { useEffect } from 'react';

export default function App({ Component, pageProps }: AppProps) {
  // Optional: auto scroll to bottom on load
  useEffect(() => {
    const el = document.documentElement;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  return <Component {...pageProps} />;
}
