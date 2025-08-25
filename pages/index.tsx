import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import avatarPhoto from "../assets/advisor-avatar-human.png"; // bundled

type Sender = "user" | "bot";
type Attachment = { filename: string; url: string; mimeType?: string; size?: number };
type Message = { sender: Sender; text: string; attachment?: Attachment };

const LANGUAGES = ["English","Spanish","Polish","French","German","Portuguese","Italian","Romanian"];

function ensureSessionId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2);
  const key = "da_session_id";
  let sid = localStorage.getItem(key);
  if (!sid) { sid = Math.random().toString(36).slice(2); localStorage.setItem(key, sid); }
  return sid;
}
function formatBytes(n?: number) {
  if (typeof n !== "number") return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB","MB","GB"]; let i=-1; do { n/=1024; i++; } while (n>=1024 && i<units.length-1);
  return `${n.toFixed(1)} ${units[i]}`;
}
function fileEmoji(filename?: string, mimeType?: string) {
  const ext = (filename || "").toLowerCase().split(".").pop() || "";
  if (mimeType?.startsWith("image/") || ["png","jpg","jpeg","gif","webp","bmp","tiff","svg"].includes(ext)) return "🖼️";
  if (ext === "pdf" || mimeType === "application/pdf") return "📄";
  if (["doc","docx","odt","rtf","pages"].includes(ext)) return "📝";
  if (["xls","xlsx","ods","csv","tsv","numbers"].includes(ext)) return "📊";
  if (["ppt","pptx","key","odp"].includes(ext)) return "📽️";
  if (["zip","rar","7z","gz","tar"].includes(ext)) return "🗜️";
  return "📎";
}
function prettyFilename(name: string): string {
  try {
    if (!name) return "";
    const dot = name.lastIndexOf("."); let base = dot>0 ? name.slice(0,dot) : name; const ext = dot>-1? name.slice(dot).toLowerCase() : "";
    base = base.replace(/[_\-\.]+/g," ");
    base = base.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi," ");
    const tokens = base.split(/\s+/).filter(Boolean); const cleaned: string[] = [];
    for (const t of tokens) {
      const l=t.toLowerCase(); const isDigits=/^\d+$/.test(l); const isHex=/^[0-9a-f]+$/i.test(l); const len=l.length;
      if (isDigits && len<=3) { cleaned.push(t); continue; }
      if (isDigits && len===4) { const num=+l; if (num>=1900 && num<=2099) { cleaned.push(t); continue; } }
      if ((isHex||isDigits) && len>=4) continue;
      cleaned.push(t);
    }
    let title=(cleaned.join(" ").replace(/\s{2,}/g," ").trim())||base.trim();
    const small=new Set(["and","or","of","the","a","an","to","in","on","for","with","at","by","from"]);
    title = title.split(" ").map((w,i)=>{ const lo=w.toLowerCase(); return (i!==0 && small.has(lo)) ? lo : (w.charAt(0).toUpperCase()+lo.slice(1));}).join(" ");
    if (!title) title="Document";
    return `${title}${ext}`;
  } catch { return name; }
}

function pickUkMaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices?.length) return null;
  const preferred = ["Google UK English Male","Microsoft Ryan Online (Natural) - English (United Kingdom)","Daniel","UK English Male"];
  for (const name of preferred) { const v=voices.find(vv=>vv.name===name); if (v) return v; }
  const enGb=voices.find(v=>(v.lang||"").toLowerCase().startsWith("en-gb")); if (enGb) return enGb;
  const enAny=voices.find(v=>(v.lang||"").toLowerCase().startsWith("en-")); return enAny||null;
}

function Avatar({ size = 40 }: { size?: number }) {
  return (
    <Image src={avatarPhoto} alt="" width={size} height={size} priority
      style={{ width:size, height:size, display:"block", borderRadius:"999px", objectFit:"cover", background:"#e5e7eb", boxShadow:"0 1px 3px rgba(0,0,0,0.18)" }} />
  );
}

/* ------------ Client Portal Panel (register/login + uploads) ------------ */
function PortalPanel({
  sessionId, visible, onClose, displayName
}: { sessionId: string; visible: boolean; onClose: () => void; displayName?: string; }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">("register");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [notice, setNotice] = useState<string>("");

  useEffect(() => {
    if (!visible) return;
    setNotice(""); setMode("register");
  }, [visible]);

  const validatePin = (p: string) => /^\d{4}$/.test(p);

  const handleRegister = async () => {
    if (!validatePin(pin) || pin !== pin2) { setNotice("PIN must be 4 digits and match."); return; }
    if (!email.includes("@")) { setNotice("Enter a valid email."); return; }
    try {
      const r = await fetch("/api/portal/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,pin,sessionId,displayName})});
      const j = await r.json();
      setNotice(j?.ok ? "Portal created — you are logged in." : (j?.error || "Could not register."));
    } catch { setNotice("Network error."); }
  };
  const handleLogin = async () => {
    try {
      const r = await fetch("/api/portal/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,pin})});
      const j = await r.json();
      setNotice(j?.ok ? "Logged in." : (j?.error || "Login failed."));
    } catch { setNotice("Network error."); }
  };
  const handleForgot = async () => {
    try {
      const r = await fetch("/api/portal/request-reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})});
      const j = await r.json();
      setNotice(j?.ok ? "Reset link sent to your email." : (j?.error || "Could not send reset link."));
    } catch { setNotice("Network error."); }
  };

  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("sessionId", sessionId);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await r.json();
      if (!data?.ok) { setNotice(`Upload failed — ${data?.details || data?.error}`); return; }
      setNotice(`Uploaded: ${prettyFilename(data?.file?.filename || file.name)}`);
    } catch { setNotice("Upload failed — network error."); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value=""; }
  };

  const isVisible = visible ? 1 : 0;
  return (
    <div style={{
      position:"fixed", top:0, right:0, height:"100vh", width: isVisible? 420: 0, transition:"width .3s ease",
      background:"linear-gradient(135deg,#0b1220,#111827)", color:"#e5e7eb", boxShadow:"-12px 0 32px rgba(0,0,0,.45)", overflow:"hidden", zIndex:60
    }}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 16px", borderBottom:"1px solid #1f2937"}}>
        <div style={{fontWeight:700}}>Client Portal</div>
        <button onClick={onClose} style={{background:"transparent", border:"1px solid #374151", color:"#e5e7eb", borderRadius:8, padding:"6px 10px", cursor:"pointer"}}>Close</button>
      </div>

      <div style={{padding:16, display: isVisible? "block":"none"}}>
        <div style={{fontSize:12, opacity:.8, marginBottom:10}}>
          {displayName ? `Hi ${displayName}, ` : ""}set up your portal to add details & upload proofs. A 4-digit PIN keeps it quick.
        </div>

        <div style={{display:"flex", gap:8, marginBottom:12}}>
          <button onClick={()=>setMode("register")} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="register"?"#1f2937":"transparent", color:"#e5e7eb"}}>Register</button>
          <button onClick={()=>setMode("login")} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="login"?"#1f2937":"transparent", color:"#e5e7eb"}}>Login</button>
          <button onClick={()=>setMode("forgot")} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="forgot"?"#1f2937":"transparent", color:"#e5e7eb"}}>Forgot PIN</button>
        </div>

        <div style={{display:"grid", gap:10}}>
          <input placeholder="Email address" value={email} onChange={e=>setEmail(e.target.value)}
            style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
          {(mode==="register" || mode==="login") && (
            <input
              placeholder={mode==="register"?"Create 4-digit PIN":"4-digit PIN"}
              value={pin}
              onChange={(e)=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))}
              style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}}
            />
          )}
          {mode==="register" && (
            <input
              placeholder="Confirm 4-digit PIN"
              value={pin2}
              onChange={(e)=>setPin2(e.target.value.replace(/\D/g,"").slice(0,4))}
              style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}}
            />
          )}

          {mode==="register" && <button onClick={handleRegister} style={{padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Create Portal</button>}
          {mode==="login" && <button onClick={handleLogin} style={{padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Log In</button>}
          {mode==="forgot" && <button onClick={handleForgot} style={{padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Send Reset Email</button>}

          {notice && <div style={{fontSize:12, color:"#a7f3d0"}}>{notice}</div>}
        </div>

        <hr style={{borderColor:"#1f2937", margin:"16px 0"}} />
        <div style={{fontWeight:700, marginBottom:8}}>Upload documents</div>
        <input type="file" hidden ref={fileInputRef} onChange={handleFileSelected} />
        <button onClick={()=>fileInputRef.current?.click()} disabled={uploading}
          style={{padding:"8px 12px", borderRadius:8, border:"1px solid #374151", color:"#e5e7eb", background:"transparent", cursor:"pointer"}}>
          📎 Upload docs {uploading ? "…" : ""}
        </button>

        <div style={{marginTop:16, fontSize:12, opacity:.8}}>
          • ID • Bank Statements (3m) • Payslips (3m / 12w) or SA302 • UC statements • Car finance docs • Creditor letters.
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState<string>("English");
  const [voiceOn, setVoiceOn] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showPortal, setShowPortal] = useState(false);
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);

  const sessionId = useMemo(() => ensureSessionId(), []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chosenVoice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    const savedTheme = typeof window !== "undefined" ? localStorage.getItem("da_theme") : null;
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme as "light" | "dark");
    setMessages([
      { sender: "bot", text: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
      { sender: "bot", text: "🌍 You can change languages any time using the dropdown above." }
    ]);
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const assign = () => { chosenVoice.current = pickUkMaleVoice((window as any).speechSynthesis.getVoices()); };
    const vs = (window as any).speechSynthesis.getVoices();
    if (vs?.length) assign(); else (window as any).speechSynthesis.onvoiceschanged = assign;
  }, []);
  useEffect(() => {
    if (!voiceOn) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const last = messages[messages.length-1];
    if (!last || last.sender !== "bot") return;
    const u = new SpeechSynthesisUtterance(last.text);
    if (chosenVoice.current) u.voice = chosenVoice.current;
    u.rate = 1; u.pitch = 1; u.volume = 1;
    (window as any).speechSynthesis.cancel();
    (window as any).speechSynthesis.speak(u);
  }, [messages, voiceOn]);

  const sendToApi = async (text: string, hist: Message[]) => {
    const r = await fetch("/api/chat", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ sessionId, userMessage: text, history: hist.map(m=>m.text), language })
    });
    return r.json();
  };

  const handleSubmit = async () => {
    const text = input.trim(); if (!text) return;
    setInput("");
    const userMsg: Message = { sender: "user", text };
    const nextHist = [...messages, userMsg];
    setMessages(nextHist);
    try {
      const data = await sendToApi(text, nextHist);
      const reply = (data?.reply as string) || "Thanks — let’s continue.";
      if (data?.displayName) setDisplayName(data.displayName);
      setMessages(prev => [...prev, { sender: "bot", text: reply }]);
      if (data?.openPortal) setShowPortal(true);
    } catch {
      setMessages(prev => [...prev, { sender: "bot", text: "⚠️ I couldn’t reach the server just now." }]);
    }
  };

  const toggleTheme = () => {
    setTheme(t => { const next = t==="dark" ? "light" : "dark"; if (typeof window!=="undefined") localStorage.setItem("da_theme", next); return next; });
  };

  const isDark = theme === "dark";
  const styles: { [k: string]: React.CSSProperties } = {
    frame: { display:"grid", gridTemplateColumns:"1fr auto", gap:0, maxWidth: 1100, margin:"0 auto", padding: 16, fontFamily: "'Segoe UI', Arial, sans-serif", background: isDark?"#0b1220":"#f3f4f6", minHeight:"100vh", color: isDark?"#e5e7eb":"#111827" },
    card: { border: isDark?"1px solid #1f2937":"1px solid #e5e7eb", borderRadius: 16, background: isDark?"#111827":"#ffffff", boxShadow: isDark?"0 8px 24px rgba(0,0,0,0.45)":"0 8px 24px rgba(0,0,0,0.06)", overflow:"hidden", width: showPortal ? 640 : 720, transition:"width .3s ease" },
    header: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom: isDark?"1px solid #1f2937":"1px solid #e5e7eb", background: isDark?"#0f172a":"#fafafa" },
    brand: { display:"flex", alignItems:"center", gap:10, fontWeight:700 },
    onlineDot: { marginLeft:8, fontSize:12, color:"#10b981", fontWeight:600 },
    tools: { display:"flex", alignItems:"center", gap:8 },
    select: { padding:"6px 10px", borderRadius:8, border: isDark?"1px solid #374151":"1px solid #d1d5db", background: isDark?"#111827":"#fff", color: isDark?"#e5e7eb":"#111827" },
    btn: { padding:"6px 10px", borderRadius:8, border: isDark?"1px solid #374151":"1px solid #d1d5db", background: isDark?"#111827":"#fff", color: isDark?"#e5e7eb":"#111827", cursor:"pointer" },
    chat: { height: 520, overflowY:"auto", padding:16, background: isDark?"linear-gradient(#0b1220,#0f172a)":"linear-gradient(#ffffff,#fafafa)", display:"flex", flexDirection:"column", gap:12 },
    row: { display:"flex", alignItems:"flex-start", gap:10 },
    rowUser: { justifyContent:"flex-end" },
    avatarWrap: { width:40, height:40, borderRadius:"50%", overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center" },
    bubble: { padding:"10px 14px", borderRadius:14, maxWidth:"70%", lineHeight:1.45, boxShadow: isDark?"0 2px 10px rgba(0,0,0,0.5)":"0 2px 10px rgba(0,0,0,0.06)" },
    bubbleBot: { background: isDark?"#1f2937":"#f3f4f6", color: isDark?"#e5e7eb":"#111827", borderTopLeftRadius:6 },
    bubbleUser: { background: isDark?"#1d4ed8":"#dbeafe", color: isDark?"#e5e7eb":"#0f172a", borderTopRightRadius:6 },
    attach: { marginTop: 8 },
    chip: { display:"inline-flex", alignItems:"center", gap:8, fontSize:12, padding:"6px 10px", background: isDark?"#0b1220":"#fff", border: isDark?"1px solid #374151":"1px solid #e5e7eb", borderRadius:999 },
    footer: { display:"flex", alignItems:"center", gap:8, padding:12, borderTop: isDark?"1px solid #1f2937":"1px solid #e5e7eb", background: isDark?"#0f172a":"#fafafa" }
  };

  return (
    <main style={styles.frame}>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={styles.brand}>
            <div style={styles.avatarWrap}><Avatar /></div>
            <span>Debt Advisor</span>
            <span style={styles.onlineDot}>● Online</span>
          </div>
          <div style={styles.tools}>
            <select style={styles.select} value={language} onChange={(e)=>setLanguage(e.target.value)} title="Change language">
              {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <button type="button" style={styles.btn} onClick={()=>setVoiceOn(v=>!v)} title="Toggle voice">
              {voiceOn ? "🔈 Voice On" : "🔇 Voice Off"}
            </button>
            <button type="button" style={styles.btn} onClick={toggleTheme} title="Toggle theme">
              {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
            </button>
            <button type="button" style={styles.btn} onClick={()=>setShowPortal(v=>!v)} title="Open client portal">
              {showPortal ? "Close Portal" : "Open Portal"}
            </button>
          </div>
        </div>

        <div style={styles.chat}>
          {messages.map((m,i)=>{
            const isUser = m.sender==="user";
            const att = m.attachment;
            const pretty = att ? prettyFilename(att.filename) : "";
            const icon = att ? fileEmoji(att.filename, att.mimeType) : "";
            return (
              <div key={i} style={{...styles.row, ...(isUser?styles.rowUser:{})}}>
                {!isUser && <div style={styles.avatarWrap}><Avatar /></div>}
                <div style={{...styles.bubble, ...(isUser?styles.bubbleUser:styles.bubbleBot)}}>
                  {m.text ? <div>{m.text}</div> : null}
                  {att && (
                    <div style={styles.attach}>
                      <a href={att.url} target="_blank" rel="noreferrer" download={pretty||att.filename} style={styles.chip} title={pretty}>
                        <span>{icon}</span>
                        <span style={{fontWeight:600}}>{pretty}</span>
                        {typeof att.size==="number" && <span style={{opacity:.7}}>({formatBytes(att.size)})</span>}
                        <span style={{textDecoration:"underline"}}>Download ⬇️</span>
                      </a>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div style={styles.footer}>
          <input
            style={{flex:1, padding:"10px 12px", borderRadius:8, border: isDark?"1px solid #374151":"1px solid #d1d5db", fontSize:16, background: isDark?"#111827":"#fff", color: isDark?"#e5e7eb":"#111827"}}
            value={input} onChange={(e)=>setInput(e.target.value)} onKeyDown={(e)=>e.key==="Enter" && handleSubmit()}
            placeholder="Type your message…"
          />
          <button type="button" onClick={handleSubmit} style={{padding:"10px 14px", borderRadius:8, border:"none", background:"#16a34a", color:"#fff", cursor:"pointer", fontWeight:600}}>Send</button>
        </div>
      </div>

      {/* Slide-in Portal */}
      <PortalPanel sessionId={sessionId} visible={showPortal} onClose={()=>setShowPortal(false)} displayName={displayName}/>
    </main>
  );
}
