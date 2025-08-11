import Head from "next/head";
import { useEffect, useRef, useState } from "react";
import "../styles/globals.css";
import { ui } from "@/utils/i18n";

type Msg = { role: "user" | "assistant"; content: string };
type Lang = "en" | "es" | "fr";

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  let sid = localStorage.getItem("da_session_id");
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    localStorage.setItem("da_session_id", sid);
  }
  return sid;
}

const EMOJIS = ["🙂","👍","🙏","💪","✅","📝","📎","📄","📤","💬","🎯","✨"];

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [lang, setLang] = useState<Lang>("en");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
  const [uploads, setUploads] = useState<{name:string; url:string}[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sid = getOrCreateSessionId();
    setSessionId(sid);
    (async () => {
      setIsTyping(true);
      const res = await fetch("/api/chat",{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ init:true, sessionId:sid, lang })
      });
      const data = await res.json();
      setMessages([{ role:"assistant", content:data.reply }]);
      setIsTyping(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:"smooth"}); }, [messages]);

  const toggleTheme = () => setTheme(t=>t==="light"?"dark":"light");

  const handleSend = async () => {
    const userText = input.trim();
    if (!userText) return;

    setMessages(m=>[...m,{role:"user",content:userText}]);
    setInput("");
    setIsTyping(true);
    const res = await fetch("/api/chat",{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ message:userText, sessionId, lang })
    });
    const data = await res.json();
    setMessages(m=>[...m,{role:"assistant",content:data.reply}]);
    setIsTyping(false);
  };

  const handleLang = async (next:Lang) => {
    setLang(next);
    // gently re-prompt current step in new language
    setIsTyping(true);
    const res = await fetch("/api/chat",{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ message:"", sessionId, lang:next })
    });
    const data = await res.json();
    setMessages(m=>[...m,{role:"assistant",content:data.reply}]);
    setIsTyping(false);
  };

  const pickEmoji = (e: string) => setInput(v => v + e);

  const onUpload = async (file: File) => {
    if (!file) return;
    const okTypes = ["application/pdf","image/png","image/jpeg"];
    if (!okTypes.includes(file.type)) {
      alert("Please upload PDF / PNG / JPG");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(",")[1];
      const res = await fetch("/api/upload",{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ name:file.name, contentBase64: base64, sessionId })
      });
      const data = await res.json();
      if (data.ok) {
        setUploads(u=>[...u,{name:file.name, url:data.url}]);
        setMessages(m=>[...m,{role:"assistant",content:"Thanks — I’ve received your document."}]);
      } else {
        alert("Upload failed: " + (data.error||""));
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <Head>
        <title>Debt Advisor Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className={`main ${theme==="dark"?"dark":""}`}>
        <div className="card">
          {/* Top bar */}
          <div className="topbar">
            <h1>{ui.title[lang]}</h1>
            <div className="row">
              <label className="small">{ui.language[lang]}</label>
              <select className="select" value={lang} onChange={(e)=>handleLang(e.target.value as Lang)}>
                <option value="en">English</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
              </select>
              <button className="btn" onClick={toggleTheme}>
                {theme==="light"?ui.dark[lang]:ui.light[lang]} Mode
              </button>
            </div>
          </div>

          {/* Chat window */}
          <div className="chat">
            {messages.map((m,i)=>(
              <div key={i} className={`msg ${m.role}`}>
                <div className="bubble">{m.content}</div>
              </div>
            ))}
            {isTyping && <div className="small">Mark is typing…</div>}
            <div ref={bottomRef}/>
          </div>

          {/* Upload bar */}
          <div className="uploadbar">
            <label className="small">{ui.uploadLabel[lang]}</label>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={(e)=> e.target.files && onUpload(e.target.files[0])}
            />
            {uploads.map((f,i)=>(
              <a key={i} href={f.url} target="_blank" rel="noreferrer" className="filepill">{f.name}</a>
            ))}
          </div>

          {/* Input row */}
          <div className="inputbar">
            <button className="emojiBtn" title="Emoji">
              <span style={{display:"flex", gap:6}}>
                {EMOJIS.slice(0,6).map(e => (
                  <span key={e} style={{cursor:"pointer"}} onClick={()=>pickEmoji(e)}>{e}</span>
                ))}
              </span>
            </button>
            <input
              className="input"
              placeholder={ui.prompt[lang]}
              value={input}
              onChange={(e)=>setInput(e.target.value)}
              onKeyDown={(e)=> e.key==="Enter" && handleSend()}
              style={{flex:1}}
            />
            <button className="btn" onClick={handleSend}>{ui.send[lang]}</button>
          </div>
        </div>
      </div>
    </>
  );
}
