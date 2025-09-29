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

/* ----------------------- Portal Profile UI ----------------------- */
type MoneyRow = { id: string; label: string; amount: string };
type Profile = {
  full_name: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  postcode: string;
  incomes: MoneyRow[];
  expenses: MoneyRow[];
};

function currencyToNumber(v: string) {
  const n = parseFloat((v || "").replace(/[^\d.]/g, ""));
  return isNaN(n) ? 0 : n;
}
function sumRows(rows: MoneyRow[]) {
  return rows.reduce((acc, r) => acc + currencyToNumber(r.amount), 0);
}

/* ------------ Client Portal (FULL-SCREEN OVERLAY) ------------ */
function PortalPanel({
  sessionId, visible, onClose, onDisplayName
}: { sessionId: string; visible: boolean; onClose: () => void; onDisplayName: (name?: string)=>void; }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "profile">("register");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [notice, setNotice] = useState<string>("");

  // Profile state
  const [profile, setProfile] = useState<Profile>({
    full_name: "", phone: "", address1: "", address2: "", city: "", postcode: "",
    incomes: [
      { id: cryptoRandomId(), label: "Salary", amount: "" },
      { id: cryptoRandomId(), label: "Benefits", amount: "" }
    ],
    expenses: [
      { id: cryptoRandomId(), label: "Rent/Mortgage", amount: "" },
      { id: cryptoRandomId(), label: "Utilities", amount: "" },
      { id: cryptoRandomId(), label: "Food", amount: "" },
      { id: cryptoRandomId(), label: "Transport", amount: "" }
    ]
  });
  const totalIncome = sumRows(profile.incomes);
  const totalExpense = sumRows(profile.expenses);
  const surplus = totalIncome - totalExpense;

  // compute simple tasks
  const tasks = [
    { id:"name",    label:"Add your full name",                done: !!profile.full_name.trim() },
    { id:"phone",   label:"Add a contact phone",               done: !!profile.phone.trim() },
    { id:"addr",    label:"Add your address & postcode",       done: !!(profile.address1.trim() && profile.postcode.trim()) },
    { id:"income",  label:"Enter at least one income",         done: totalIncome > 0 },
    { id:"expense", label:"Enter at least one monthly expense",done: totalExpense > 0 },
  ];
  const tasksOutstanding = tasks.filter(t => !t.done).length;

  useEffect(() => {
    if (visible) {
      setNotice("");
      setMode("register");
      // prevent background scroll while portal is open
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [visible]);

  // allow Escape to close
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, onClose]);

  const validatePin = (p: string) => /^\d{4}$/.test(p);
  const normalizeEmail = (e: string) => (e || "").trim().toLowerCase();

  const handleRegister = async () => {
    const em = normalizeEmail(email);
    if (!validatePin(pin) || pin !== pin2) { setNotice("PIN must be 4 digits and match."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setNotice("Enter a valid email."); return; }
    try {
      const r = await fetch("/api/portal/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email: em, pin, sessionId})});
      const j = await r.json();
      if (j?.ok) {
        setNotice("Portal created — you are logged in.");
        onDisplayName(j?.displayName);
        await fetch("/api/portal/profile", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ email: em, sessionId, profile }) });
        setMode("profile");
        await loadProfile(em);
      } else {
        setNotice(j?.error || "Could not register.");
      }
    } catch { setNotice("Network error."); }
  };
  const handleLogin = async () => {
    const em = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || !validatePin(pin)) { setNotice("Check email and 4-digit PIN."); return; }
    try {
      const r = await fetch("/api/portal/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email: em, pin})});
      const j = await r.json();
      if (j?.ok) {
        setNotice("Logged in.");
        onDisplayName(j?.displayName || undefined);
        setMode("profile");
        await fetch("/api/portal/profile", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ email: em, sessionId, profile }) });
        await loadProfile(em);
      } else {
        setNotice(j?.error || "Login failed.");
      }
    } catch { setNotice("Network error."); }
  };
  const handleForgot = async () => {
    const em = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setNotice("Enter a valid email."); return; }
    try {
      const r = await fetch("/api/portal/request-reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email: em})});
      const j = await r.json();
      setNotice(j?.ok ? "Reset link sent to your email." : (j?.error || "Could not send reset link."));
    } catch { setNotice("Network error."); }
  };

  async function loadProfile(em: string) {
    try {
      const r = await fetch(`/api/portal/profile?email=${encodeURIComponent(em)}`);
      const j = await r.json();
      if (j?.ok && j.profile) {
        setProfile({
          full_name: j.profile.full_name || "",
          phone: j.profile.phone || "",
          address1: j.profile.address1 || "",
          address2: j.profile.address2 || "",
          city: j.profile.city || "",
          postcode: j.profile.postcode || "",
          incomes: Array.isArray(j.profile.incomes) ? j.profile.incomes : [],
          expenses: Array.isArray(j.profile.expenses) ? j.profile.expenses : []
        });
      }
    } catch { /* ignore */ }
  }

  async function saveProfile() {
    const em = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setNotice("Enter a valid email."); return; }
    try {
      const r = await fetch("/api/portal/profile", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ email: em, sessionId, profile })
      });
      const j = await r.json();
      setNotice(j?.ok ? "✅ Profile saved." : (j?.error || "Could not save profile."));
    } catch { setNotice("Network error while saving."); }
  }

  function updateRow(kind: "incomes"|"expenses", id: string, patch: Partial<MoneyRow>) {
    setProfile(p => ({
      ...p,
      [kind]: p[kind].map(r => r.id===id ? { ...r, ...patch } : r)
    }));
  }
  function addRow(kind: "incomes"|"expenses") {
    setProfile(p => ({
      ...p,
      [kind]: [...p[kind], { id: cryptoRandomId(), label: "", amount: "" }]
    }));
  }
  function removeRow(kind: "incomes"|"expenses", id: string) {
    setProfile(p => ({
      ...p,
      [kind]: p[kind].filter(r => r.id !== id)
    }));
  }

  // full-screen overlay container
  return (
    <div
      aria-hidden={!visible}
      style={{
        position:"fixed", inset:0, zIndex:60,
        pointerEvents: visible ? "auto" : "none",
        opacity: visible ? 1 : 0,
        transition:"opacity .25s ease",
        display:"grid",
        gridTemplateRows:"auto 1fr",
        background:"rgba(0,0,0,0.5)"
      }}
    >
      {/* top bar */}
      <div
        style={{
          backdropFilter:"blur(6px)",
          background:"linear-gradient(180deg, rgba(16,24,40,0.95), rgba(16,24,40,0.85))",
          borderBottom:"1px solid #1f2937",
          color:"#e5e7eb",
          display:"flex",
          alignItems:"center",
          justifyContent:"space-between",
          padding:"10px 14px"
        }}
      >
        <div style={{display:"flex", alignItems:"center", gap:10}}>
          <button onClick={onClose} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb", cursor:"pointer"}}>
            ← Back to Chat
          </button>
          <strong>Client Portal</strong>
        </div>
        {mode !== "profile" && (
          <div style={{fontSize:12, opacity:.85}}>Please set up your client portal so you can view and save your progress.</div>
        )}
      </div>

      {/* scrollable portal content */}
      <div style={{overflowY:"auto"}}>
        <div style={{
          maxWidth: 980, margin:"18px auto", padding:"16px",
          background:"linear-gradient(135deg,#0b1220,#111827)", color:"#e5e7eb",
          border:"1px solid #1f2937", borderRadius:16, boxShadow:"0 10px 30px rgba(0,0,0,0.45)"
        }}>
          {mode !== "profile" && (
            <>
              <div style={{display:"flex", gap:8, marginBottom:12}}>
                <button onClick={()=>setMode("register")} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="register"?"#1f2937":"transparent", color:"#e5e7eb"}}>Register</button>
                <button onClick={()=>setMode("login")} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="login"?"#1f2937":"transparent", color:"#e5e7eb"}}>Login</button>
                <button onClick={()=>setMode("forgot")} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="forgot"?"#1f2937":"transparent", color:"#e5e7eb"}}>Forgot PIN</button>
              </div>

              <div style={{display:"grid", gap:10, maxWidth:520}}>
                <input placeholder="Email address" value={email} onChange={e=>setEmail(e.target.value)}
                  style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />

                {(mode==="register" || mode==="login") && (
                  <input
                    placeholder={mode==="register"?"Create 4-digit PIN":"4-digit PIN"}
                    value={pin}
                    onChange={(e)=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))}
                    maxLength={4}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                    style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}}
                  />
                )}

                {mode==="register" && (
                  <input
                    placeholder="Confirm 4-digit PIN"
                    value={pin2}
                    onChange={(e)=>setPin2(e.target.value.replace(/\D/g,"").slice(0,4))}
                    maxLength={4}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                    style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}}
                  />
                )}

                {mode==="register" && <button onClick={handleRegister} style={{padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Create Portal</button>}
                {mode==="login" && <button onClick={handleLogin} style={{padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Log In</button>}
                {mode==="forgot" && <button onClick={handleForgot} style={{padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Send Reset Email</button>}

                {notice && <div style={{fontSize:12, color:"#a7f3d0"}}>{notice}</div>}
              </div>
            </>
          )}

          {mode === "profile" && (
            <div style={{display:"grid", gap:14}}>
              {/* Outstanding tasks */}
              <div style={{display:"flex", alignItems:"center", justifyContent:"space-between"}}>
                <div style={{fontWeight:700}}>Outstanding tasks</div>
                <div style={{
                  padding:"2px 8px", borderRadius:12,
                  background: tasksOutstanding ? "#f59e0b" : "#065f46",
                  color:"#fff", fontSize:12, fontWeight:700
                }}>
                  {tasksOutstanding ? `${tasksOutstanding} to do` : "All done"}
                </div>
              </div>
              <ul style={{listStyle:"none", padding:0, margin:0, display:"grid", gap:6}}>
                {tasks.map(t=>(
                  <li key={t.id} style={{
                    display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220"
                  }}>
                    <span style={{opacity: t.done ? .7 : 1}}>
                      {t.done ? "✅" : "⏳"} {t.label}
                    </span>
                  </li>
                ))}
              </ul>

              <hr style={{borderColor:"#1f2937"}} />

              <div style={{display:"grid", gap:10}}>
                <div style={{fontWeight:700, marginBottom:4}}>Your details</div>
                <div style={{display:"grid", gap:10, gridTemplateColumns:"1fr 1fr", maxWidth: "100%"}}>
                  <input placeholder="Full name" value={profile.full_name} onChange={e=>setProfile(p=>({...p, full_name:e.target.value}))}
                    style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb", gridColumn:"1 / span 2"}} />
                  <input placeholder="Phone" value={profile.phone} onChange={e=>setProfile(p=>({...p, phone:e.target.value}))}
                    style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                  <input placeholder="Postcode" value={profile.postcode} onChange={e=>setProfile(p=>({...p, postcode:e.target.value}))}
                    style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                  <input placeholder="Address line 1" value={profile.address1} onChange={e=>setProfile(p=>({...p, address1:e.target.value}))}
                    style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb", gridColumn:"1 / span 2"}} />
                  <input placeholder="Address line 2 (optional)" value={profile.address2} onChange={e=>setProfile(p=>({...p, address2:e.target.value}))}
                    style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb", gridColumn:"1 / span 2"}} />
                  <input placeholder="City" value={profile.city} onChange={e=>setProfile(p=>({...p, city:e.target.value}))}
                    style={{padding:"10px 12px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb", gridColumn:"1 / span 2"}} />
                </div>
              </div>

              {/* Income */}
              <div style={{display:"grid", gap:8, marginTop:8}}>
                <div style={{fontWeight:700}}>Income</div>
                {profile.incomes.map(row=>(
                  <div key={row.id} style={{display:"grid", gridTemplateColumns:"1fr 160px 40px", gap:8}}>
                    <input placeholder="Label" value={row.label} onChange={e=>updateRow("incomes", row.id, {label:e.target.value})}
                      style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                    <input placeholder="Amount / month" value={row.amount} onChange={e=>updateRow("incomes", row.id, {amount:e.target.value})}
                      inputMode="decimal" style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                    <button onClick={()=>removeRow("incomes", row.id)} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>✕</button>
                  </div>
                ))}
                <button onClick={()=>addRow("incomes")} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>+ Add income</button>
                <div style={{textAlign:"right", opacity:.9}}>Total income: £{totalIncome.toFixed(2)}</div>
              </div>

              {/* Expenditure */}
              <div style={{display:"grid", gap:8}}>
                <div style={{fontWeight:700}}>Expenditure</div>
                {profile.expenses.map(row=>(
                  <div key={row.id} style={{display:"grid", gridTemplateColumns:"1fr 160px 40px", gap:8}}>
                    <input placeholder="Label" value={row.label} onChange={e=>updateRow("expenses", row.id, {label:e.target.value})}
                      style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                    <input placeholder="Amount / month" value={row.amount} onChange={e=>updateRow("expenses", row.id, {amount:e.target.value})}
                      inputMode="decimal" style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                    <button onClick={()=>removeRow("expenses", row.id)} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>✕</button>
                  </div>
                ))}
                <button onClick={()=>addRow("expenses")} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>+ Add expense</button>
                <div style={{textAlign:"right", opacity:.9}}>Total expenses: £{totalExpense.toFixed(2)}</div>
              </div>

              {/* Surplus + Save */}
              <div style={{marginTop:4, textAlign:"right", fontWeight:700}}>
                Surplus: <span style={{color: surplus>=0 ? "#34d399" : "#f87171"}}>£{surplus.toFixed(2)}</span>
              </div>

              <button onClick={saveProfile} style={{marginTop:8, padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Save Profile</button>
              {notice && <div style={{fontSize:12, color:"#a7f3d0"}}>{notice}</div>}
            </div>
          )}
        </div>

        {/* bottom safe area for mobile */}
        <div style={{height:24}} />
      </div>
    </div>
  );
}

/* ------------------------- Helpers ------------------------- */
function cryptoRandomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return (crypto as any).randomUUID();
  return Math.random().toString(36).slice(2);
}

/* --------------------------- Page --------------------------- */
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

  // Chat footer upload state/handlers
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const [chatUploading, setChatUploading] = useState(false);

  const handleChatUploadClick = () => chatFileInputRef.current?.click();
  const handleChatFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setChatUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sessionId", sessionId);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await r.json();
      if (!data?.ok) {
        setMessages(prev => [...prev, { sender: "bot", text: "Upload failed — please try again." }]);
        return;
      }
      const cleanName = prettyFilename(data?.file?.filename || file.name);
      const link = data?.downloadUrl || "";
      const attachment: Attachment | undefined = link
        ? { filename: cleanName, url: link, mimeType: data?.file?.mimeType, size: data?.file?.size }
        : undefined;
      // Show a single tidy chip message (no duplicate text)
      setMessages(prev => [...prev, { sender: "bot", text: "", attachment }]);
    } catch {
      setMessages(prev => [...prev, { sender: "bot", text: "Upload failed — network error." }]);
    } finally {
      setChatUploading(false);
      if (chatFileInputRef.current) chatFileInputRef.current.value = "";
    }
  };

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
    const u = new SpeechSynthesisUtterance(last.text || "File uploaded.");
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
  const styles: any = {
    frame: { display:"grid", gridTemplateColumns:"1fr", gap:0, maxWidth: 1100, margin:"0 auto", padding: 16, fontFamily: "'Segoe UI', Arial, sans-serif", background: isDark?"#0b1220":"#f3f4f6", minHeight:"100vh", color: isDark?"#e5e7eb":"#111827" },
    card: { border: isDark?"1px solid #1f2937":"1px solid #e5e7eb", borderRadius: 16, background: isDark?"#111827":"#ffffff", boxShadow: isDark?"0 8px 24px rgba(0,0,0,0.45)":"0 8px 24px rgba(0,0,0,0.06)", overflow:"hidden", width: 720, margin:"0 auto" },
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
            <button type="button" style={styles.btn} onClick={()=>setShowPortal(true)} title="Open client portal">
              Open Portal
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
          {/* Chat footer upload */}
          <input type="file" hidden ref={chatFileInputRef} onChange={handleChatFileSelected} />
          <button type="button" onClick={handleChatUploadClick} disabled={chatUploading}
            style={{padding:"10px 12px", borderRadius:8, border: isDark?"1px solid #374151":"1px solid #d1d5db", background: isDark?"#111827":"#fff", color: isDark?"#e5e7eb":"#111827", cursor:"pointer"}}>
            📎 Upload {chatUploading ? "…" : ""}
          </button>
          <button type="button" onClick={handleSubmit} style={{padding:"10px 14px", borderRadius:8, border:"none", background:"#16a34a", color:"#fff", cursor:"pointer", fontWeight:600}}>Send</button>
        </div>
      </div>

      {/* Full-screen Portal Overlay */}
      <PortalPanel
        sessionId={sessionId}
        visible={showPortal}
        onClose={()=>setShowPortal(false)}
        onDisplayName={(name)=>setDisplayName(name)}
      />
    </main>
  );
}
