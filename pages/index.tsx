// pages/index.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import avatarPhoto from "../assets/advisor-avatar-human.png";

/* ====================== Types & helpers ====================== */
type Sender = "user" | "bot";
type Attachment = { filename: string; url: string; mimeType?: string; size?: number };
type Message = { sender: Sender; text: string; attachment?: Attachment };

type AddressEntry = { line1: string; line2: string; city: string; postcode: string; yearsAt: number };
type Income = { label: string; amount: number };
type Expense = { label: string; amount: number };

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

/* ====================== Shared UI bits ====================== */
function Avatar({ size = 40 }: { size?: number }) {
  return (
    <Image src={avatarPhoto} alt="" width={size} height={size} priority
      style={{ width:size, height:size, display:"block", borderRadius:"999px", objectFit:"cover", background:"#e5e7eb", boxShadow:"0 1px 3px rgba(0,0,0,0.18)" }} />
  );
}

/* ====================== Auth Screen (Register/Login/Forgot) ====================== */
function AuthScreen({
  visible, onClose, onAuthed
}: { visible: boolean; onClose: () => void; onAuthed: (email: string, displayName?: string) => void }) {
  const [mode, setMode] = useState<"register"|"login"|"forgot">("register");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(()=>{ if (visible) setNotice(""); },[visible]);

  const clampPin = (v: string) => v.replace(/\D/g,"").slice(0,4);

  const handleRegister = async () => {
    const p = clampPin(pin); const p2 = clampPin(pin2);
    if (!email.includes("@")) return setNotice("Enter a valid email.");
    if (!/^\d{4}$/.test(p)) return setNotice("PIN must be 4 digits.");
    if (p !== p2) return setNotice("PINs do not match.");
    try {
      const r = await fetch("/api/portal/register", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ email, pin:p, displayName: fullName })
      });
      const j = await r.json();
      if (!j?.ok) return setNotice(j?.error || "Could not register.");
      setNotice("Account created — signed in.");
      onAuthed(email, fullName || undefined);
    } catch { setNotice("Network error."); }
  };

  const handleLogin = async () => {
    const p = clampPin(pin);
    if (!email.includes("@")) return setNotice("Enter a valid email.");
    if (!/^\d{4}$/.test(p)) return setNotice("PIN must be 4 digits.");
    try {
      const r = await fetch("/api/portal/login", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ email, pin: p })
      });
      const j = await r.json();
      if (!j?.ok) return setNotice(j?.error || "Invalid email or PIN");
      setNotice("Logged in.");
      onAuthed(email, j?.displayName);
    } catch { setNotice("Network error."); }
  };

  const handleForgot = async () => {
    if (!email.includes("@")) return setNotice("Enter a valid email.");
    try {
      const r = await fetch("/api/portal/request-reset", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ email })
      });
      const j = await r.json();
      setNotice(j?.ok ? "Reset link sent to your email." : (j?.error || "Could not send reset link."));
    } catch { setNotice("Network error."); }
  };

  if (!visible) return null;

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:80,
      background:"rgba(0,0,0,.55)",
      display:"grid", placeItems:"center", padding:16
    }}>
      <div style={{
        width:"100%", maxWidth:520, borderRadius:16,
        background:"#fff", color:"#111827", boxShadow:"0 24px 64px rgba(0,0,0,.35)",
        overflow:"hidden", border:"1px solid #e5e7eb"
      }}>
        {/* Header */}
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"12px 16px", borderBottom:"1px solid #e5e7eb", background:"#fafafa"}}>
          <div style={{fontWeight:800}}>Client Portal</div>
          <button onClick={onClose}
            style={{padding:"6px 10px", borderRadius:8, border:"1px solid #d1d5db", background:"#fff", cursor:"pointer"}}>
            Back to Chat
          </button>
        </div>

        {/* Body */}
        <div style={{padding:16, display:"grid", gap:12}}>
          <div style={{fontSize:13, color:"#4b5563"}}>
            Please set up your client portal so you can view and save your progress.
          </div>

          <div style={{display:"flex", gap:8}}>
            <button onClick={()=>setMode("register")}
              style={{padding:"8px 12px", borderRadius:8, border:"1px solid #e5e7eb",
                background: mode==="register" ? "#111827":"#fff", color: mode==="register" ? "#fff":"#111827"}}>
              Register
            </button>
            <button onClick={()=>setMode("login")}
              style={{padding:"8px 12px", borderRadius:8, border:"1px solid #e5e7eb",
                background: mode==="login" ? "#111827":"#fff", color: mode==="login" ? "#fff":"#111827"}}>
              Login
            </button>
            <button onClick={()=>setMode("forgot")}
              style={{padding:"8px 12px", borderRadius:8, border:"1px solid #e5e7eb",
                background: mode==="forgot" ? "#111827":"#fff", color: mode==="forgot" ? "#fff":"#111827"}}>
              Forgot PIN
            </button>
          </div>

          <div style={{display:"grid", gap:10}}>
            {mode==="register" && (
              <label style={{display:"grid", gap:6}}>
                <span>Full name</span>
                <input value={fullName} onChange={e=>setFullName(e.target.value)}
                  style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
              </label>
            )}
            <label style={{display:"grid", gap:6}}>
              <span>Email</span>
              <input value={email} onChange={e=>setEmail(e.target.value)}
                style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
            </label>
            {(mode==="register" || mode==="login") && (
              <label style={{display:"grid", gap:6}}>
                <span>{mode==="register" ? "Create 4-digit PIN" : "4-digit PIN"}</span>
                <input value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))}
                  inputMode="numeric" maxLength={4}
                  style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
              </label>
            )}
            {mode==="register" && (
              <label style={{display:"grid", gap:6}}>
                <span>Confirm 4-digit PIN</span>
                <input value={pin2} onChange={e=>setPin2(e.target.value.replace(/\D/g,"").slice(0,4))}
                  inputMode="numeric" maxLength={4}
                  style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
              </label>
            )}

            {mode==="register" && (
              <button onClick={handleRegister}
                style={{padding:"10px 12px", borderRadius:8, border:"none", background:"#16a34a", color:"#fff", fontWeight:700, cursor:"pointer"}}>
                Create Portal
              </button>
            )}
            {mode==="login" && (
              <button onClick={handleLogin}
                style={{padding:"10px 12px", borderRadius:8, border:"none", background:"#16a34a", color:"#fff", fontWeight:700, cursor:"pointer"}}>
                Log In
              </button>
            )}
            {mode==="forgot" && (
              <button onClick={handleForgot}
                style={{padding:"10px 12px", borderRadius:8, border:"none", background:"#111827", color:"#fff", fontWeight:700, cursor:"pointer"}}>
                Send Reset Email
              </button>
            )}

            {notice && <div style={{fontSize:12, color: /error|invalid|fail/i.test(notice) ? "#b91c1c" : "#065f46"}}>{notice}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ====================== Fullscreen Portal (after login) ====================== */
function PortalScreen({
  visible, onClose, displayName, loggedEmail
}: { visible: boolean; onClose: () => void; displayName?: string; loggedEmail?: string }) {
  const [tab, setTab] = useState<"details"|"budget"|"debts"|"docs">("details");

  // Details
  const [fullName, setFullName] = useState(displayName || "");
  const [phone, setPhone] = useState("");
  const [addresses, setAddresses] = useState<AddressEntry[]>([
    { line1:"", line2:"", city:"", postcode:"", yearsAt: 0 }
  ]);

  // Budget
  const [incomes, setIncomes] = useState<Income[]>([
    { label:"Salary/Wages", amount:0 },
    { label:"Benefits", amount:0 }
  ]);
  const [expenses, setExpenses] = useState<Expense[]>([
    { label:"Rent/Mortgage", amount:0 },
    { label:"Utilities", amount:0 },
    { label:"Food", amount:0 },
    { label:"Transport", amount:0 }
  ]);
  const totalIncome = incomes.reduce((a,b)=>a+(+b.amount||0),0);
  const totalExpense = expenses.reduce((a,b)=>a+(+b.amount||0),0);
  const disposable = Math.max(0, totalIncome-totalExpense);

  // Debts (5 rows)
  type Debt = { creditor: string; amount: number; monthly: number; account: string };
  const [debts, setDebts] = useState<Debt[]>(
    Array.from({length:5}).map(()=>({ creditor:"", amount:0, monthly:0, account:"" }))
  );

  // Tasks
  type Task = { id: string; label: string; done: boolean };
  const [tasks, setTasks] = useState<Task[]>([
    { id:"id", label:"Provide ID", done:false },
    { id:"bank1m", label:"1 month bank statements", done:false },
    { id:"payslip1m", label:"1 month payslip", done:false },
    { id:"letters", label:"Upload creditor letters", done:false },
  ]);

  const [docsCount] = useState(0);
  const [notice, setNotice] = useState("");

  // Load profile (best-effort)
  useEffect(() => {
    if (!visible || !loggedEmail) return;
    (async ()=>{
      try {
        const r = await fetch(`/api/portal/profile?email=${encodeURIComponent(loggedEmail)}`);
        const j = await r.json();
        if (j?.ok && j.profile) {
          const p = j.profile;
          setFullName(p.full_name || displayName || "");
          setPhone(p.phone || "");
          const hist: AddressEntry[] = Array.isArray(p.address_history) && p.address_history.length
            ? p.address_history
            : [{
                line1: p.address1 || "", line2: p.address2 || "",
                city: p.city || "", postcode: p.postcode || "", yearsAt: 0
              }];
          setAddresses(hist.slice(0,3));
          setIncomes(Array.isArray(p.incomes) ? p.incomes : []);
          setExpenses(Array.isArray(p.expenses) ? p.expenses : []);
        }
      } catch {}
    })();
  }, [visible, loggedEmail, displayName]);

  const setAddr = (idx: number, patch: Partial<AddressEntry>) =>
    setAddresses(prev => prev.map((a,i)=> i===idx ? {...a, ...patch} : a));

  const sumYears = (arr: AddressEntry[]) => arr.reduce((a,b)=>a + (+b.yearsAt||0), 0);
  const canAddAddress = (arr: AddressEntry[]) => arr.length < 3 && sumYears(arr) < 6;
  const addAddress = () => setAddresses(prev => canAddAddress(prev) ? [...prev, { line1:"", line2:"", city:"", postcode:"", yearsAt:0 }] : prev);
  const removeAddress = (i: number) => setAddresses(prev => prev.length>1 ? prev.filter((_,idx)=>idx!==i) : prev);

  const saveProfile = async () => {
    try {
      const email = loggedEmail || "";
      if (!email) { setNotice("You’re not logged in."); return; }
      const payload = {
        email,
        profile: {
          full_name: fullName,
          phone,
          address1: addresses[0]?.line1 || "",
          address2: addresses[0]?.line2 || "",
          city: addresses[0]?.city || "",
          postcode: addresses[0]?.postcode || "",
          address_history: addresses.map(a => ({
            line1:a.line1, line2:a.line2, city:a.city, postcode:a.postcode, yearsAt:+a.yearsAt||0
          })),
          incomes, expenses
        }
      };
      const r = await fetch("/api/portal/profile", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
      const j = await r.json();
      setNotice(j?.ok ? "Saved." : (j?.error || "Save failed."));
    } catch { setNotice("Save failed (network)."); }
  };

  const toggleTask = (id: string) => setTasks(prev => prev.map(t => t.id===id ? {...t, done:!t.done} : t));
  const totalOutstanding = tasks.filter(t=>!t.done).length;

  if (!visible) return null;

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:70, background:"#fff", color:"#111827",
      display:"grid", gridTemplateRows:"auto 1fr"
    }}>
      {/* Top bar */}
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"12px 16px", borderBottom:"1px solid #e5e7eb", background:"#fff"
      }}>
        <div style={{display:"flex", alignItems:"center", gap:10, fontWeight:800}}>
          <span>Client Portal</span>
          {loggedEmail ? <span style={{fontWeight:400, color:"#6b7280"}}>— {displayName || "Client"}</span> : null}
        </div>
        <div style={{display:"flex", gap:8}}>
          <button onClick={onClose}
            style={{padding:"8px 12px", borderRadius:8, border:"1px solid #d1d5db", background:"#fff", cursor:"pointer"}}>
            Back to Chat
          </button>
          <button onClick={saveProfile}
            style={{padding:"8px 12px", borderRadius:8, border:"none", background:"#16a34a", color:"#fff", fontWeight:700, cursor:"pointer"}}>
            Save
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{display:"grid", gridTemplateRows:"auto auto 1fr", gap:12, padding:"12px 16px", background:"#f8fafc"}}>
        {/* Tabs */}
        <div style={{display:"flex", gap:8}}>
          {["details","budget","debts","docs"].map(t=>(
            <button key={t} onClick={()=>setTab(t as any)}
              style={{
                padding:"8px 12px", borderRadius:8, border:"1px solid #e5e7eb",
                background: tab===t ? "#111827" : "#fff",
                color: tab===t ? "#fff" : "#111827", cursor:"pointer"
              }}>
              {{
                details: "Your Details",
                budget: "Income / Expenditure",
                debts: "Debts",
                docs: "Documents"
              }[t as "details"]}
            </button>
          ))}
        </div>

        {/* Tasks */}
        <div style={{display:"flex", alignItems:"center", gap:12, padding:"10px 12px",
          border:"1px solid #e5e7eb", borderRadius:12, background:"#fff"}}>
          <strong>Outstanding tasks:</strong>
          <span>{totalOutstanding} to do</span>
          <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
            {tasks.map(t=>(
              <button key={t.id} onClick={()=>toggleTask(t.id)} title={t.done?"Undo":"Mark done"}
                style={{padding:"6px 10px", borderRadius:999, border:"1px solid #e5e7eb",
                  background: t.done ? "#d1fae5":"#fff", color:"#111827", cursor:"pointer"}}>
                {t.done ? "✅" : "⬜"} {t.label}{t.done ? " - Completed" : ""}
              </button>
            ))}
          </div>
        </div>

        {/* Main area */}
        <div style={{border:"1px solid #e5e7eb", borderRadius:12, background:"#fff", overflow:"auto", padding:16}}>
          {tab==="details" && (
            <div style={{display:"grid", gap:12}}>
              <div style={{display:"grid", gap:10, gridTemplateColumns:"1fr 1fr"}}>
                <label style={{display:"grid", gap:6}}>
                  <span>Full name</span>
                  <input value={fullName} onChange={e=>setFullName(e.target.value)}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                </label>
                <label style={{display:"grid", gap:6}}>
                  <span>Phone</span>
                  <input value={phone} onChange={e=>setPhone(e.target.value)}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                </label>
              </div>

              {addresses.map((a, idx)=>(
                <div key={idx} style={{border:"1px solid #e5e7eb", borderRadius:12, background:"#fafafa", padding:12}}>
                  <div style={{fontWeight:700, marginBottom:8}}>
                    {idx===0 ? "Current address" : `Previous address ${idx}`}
                  </div>
                  <div style={{display:"grid", gap:10, gridTemplateColumns:"1fr 1fr"}}>
                    <label style={{display:"grid", gap:6}}>
                      <span>Address line 1</span>
                      <input value={a.line1} onChange={e=>setAddr(idx,{line1:e.target.value})}
                             style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                    </label>
                    <label style={{display:"grid", gap:6}}>
                      <span>Address line 2</span>
                      <input value={a.line2} onChange={e=>setAddr(idx,{line2:e.target.value})}
                             style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                    </label>
                    <label style={{display:"grid", gap:6}}>
                      <span>City</span>
                      <input value={a.city} onChange={e=>setAddr(idx,{city:e.target.value})}
                             style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                    </label>
                    <label style={{display:"grid", gap:6}}>
                      <span>Postcode</span>
                      <input value={a.postcode} onChange={e=>setAddr(idx,{postcode:e.target.value.toUpperCase()})}
                             placeholder="e.g. SW1A 1AA"
                             style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                    </label>
                    <label style={{display:"grid", gap:6}}>
                      <span>Years at address</span>
                      <input type="number" min={0} max={99} value={a.yearsAt}
                             onChange={e=>setAddr(idx,{yearsAt: Math.max(0, Math.min(99, Number(e.target.value||0)))})}
                             style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                    </label>
                  </div>
                  {idx>0 && (
                    <div style={{marginTop:10}}>
                      <button onClick={()=>removeAddress(idx)}
                              style={{padding:"8px 12px", borderRadius:8, border:"1px solid #d1d5db", background:"#fff", cursor:"pointer"}}>
                        Remove this address
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {addresses.length<3 && sumYears(addresses)<6 && (
                <div>
                  <button onClick={addAddress}
                          style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db", background:"#fff", cursor:"pointer"}}>
                    + Add previous address
                  </button>
                  <div style={{fontSize:12, marginTop:6, color:"#6b7280"}}>Provide up to 6 years of address history (max 3 addresses).</div>
                </div>
              )}

              {notice && <div style={{fontSize:12, color:"#065f46"}}>{notice}</div>}
            </div>
          )}

          {tab==="budget" && (
            <div style={{display:"grid", gap:16}}>
              <div style={{fontWeight:800}}>Income</div>
              {incomes.map((r, i)=>(
                <div key={i} style={{display:"grid", gridTemplateColumns:"1fr 160px", gap:10}}>
                  <input value={r.label} onChange={e=>setIncomes(prev=>prev.map((x,idx)=>idx===i?{...x,label:e.target.value}:x))}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                  <input type="number" value={r.amount} onChange={e=>setIncomes(prev=>prev.map((x,idx)=>idx===i?{...x,amount:Number(e.target.value||0)}:x))}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                </div>
              ))}
              <button onClick={()=>setIncomes(p=>[...p,{label:"Other",amount:0}])}
                      style={{padding:"8px 12px", borderRadius:8, border:"1px solid #d1d5db", background:"#fff", cursor:"pointer"}}>+ Add income</button>

              <div style={{fontWeight:800, marginTop:8}}>Expenditure</div>
              {expenses.map((r, i)=>(
                <div key={i} style={{display:"grid", gridTemplateColumns:"1fr 160px", gap:10}}>
                  <input value={r.label} onChange={e=>setExpenses(prev=>prev.map((x,idx)=>idx===i?{...x,label:e.target.value}:x))}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                  <input type="number" value={r.amount} onChange={e=>setExpenses(prev=>prev.map((x,idx)=>idx===i?{...x,amount:Number(e.target.value||0)}:x))}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                </div>
              ))}
              <button onClick={()=>setExpenses(p=>[...p,{label:"Other",amount:0}])}
                      style={{padding:"8px 12px", borderRadius:8, border:"1px solid #d1d5db", background:"#fff", cursor:"pointer"}}>+ Add expense</button>

              <div style={{display:"flex", gap:16, marginTop:8}}>
                <div><strong>Total income:</strong> £{totalIncome.toFixed(2)}</div>
                <div><strong>Total expenditure:</strong> £{totalExpense.toFixed(2)}</div>
                <div><strong>Disposable income:</strong> £{disposable.toFixed(2)}</div>
              </div>
            </div>
          )}

          {tab==="debts" && (
            <div style={{display:"grid", gap:12}}>
              <div style={{display:"grid", gridTemplateColumns:"1fr 140px 160px 200px", gap:10, fontWeight:800}}>
                <div>Creditor</div>
                <div>Amount (£)</div>
                <div>Monthly Payment (£)</div>
                <div>Account / Reference</div>
              </div>
              {debts.map((d, i)=>(
                <div key={i} style={{display:"grid", gridTemplateColumns:"1fr 140px 160px 200px", gap:10}}>
                  <input value={d.creditor} onChange={e=>setDebts(prev=>prev.map((x,idx)=>idx===i?{...x,creditor:e.target.value}:x))}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                  <input type="number" value={d.amount} onChange={e=>setDebts(prev=>prev.map((x,idx)=>idx===i?{...x,amount:Number(e.target.value||0)}:x))}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                  <input type="number" value={d.monthly} onChange={e=>setDebts(prev=>prev.map((x,idx)=>idx===i?{...x,monthly:Number(e.target.value||0)}:x))}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                  <input value={d.account} onChange={e=>setDebts(prev=>prev.map((x,idx)=>idx===i?{...x,account:e.target.value}:x))}
                         style={{padding:"10px 12px", borderRadius:8, border:"1px solid #d1d5db"}} />
                </div>
              ))}
              <div style={{marginTop:6, color:"#6b7280", fontSize:12}}>
                You can add more later. Upload creditor letters via the chat uploader (📎).
              </div>
            </div>
          )}

          {tab==="docs" && (
            <div style={{display:"grid", gap:10}}>
              <div><strong>Documents</strong></div>
              <div style={{color:"#6b7280"}}>{docsCount>0 ? `${docsCount} documents uploaded.` : "No documents uploaded."}</div>
              <div style={{fontSize:12, color:"#6b7280"}}>Use the 📎 Upload docs button in the chat to attach files.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ====================== Chat UI (unchanged look) ====================== */
export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState<string>("English");
  const [voiceOn, setVoiceOn] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Portal state
  const [showAuth, setShowAuth] = useState(false);
  const [showPortal, setShowPortal] = useState(false);
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [loggedEmail, setLoggedEmail] = useState<string | undefined>(undefined);

  const sessionId = useMemo(() => ensureSessionId(), []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chosenVoice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    const savedTheme = typeof window === "undefined" ? null : localStorage.getItem("da_theme");
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme as any);
    setMessages([
      { sender: "bot", text: "Hello! My name’s Mark. What prompted you to seek help with your debts today?" },
      { sender: "bot", text: "🌍 You can change languages any time using the dropdown above." }
    ]);
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [messages]);

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
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ sessionId, userMessage: text, history: hist.map(m=>m.text), language })
    });
    return r.json();
  };

  const handleSubmit = async () => {
    const text = input.trim(); if (!text) return;
    setInput("");
    const userMsg: Message = { sender:"user", text };
    const nextHist = [...messages, userMsg];
    setMessages(nextHist);
    try {
      const data = await sendToApi(text, nextHist);
      const reply = (data?.reply as string) || "Thanks — let’s continue.";
      if (data?.displayName) setDisplayName(data.displayName);
      setMessages(prev => [...prev, { sender:"bot", text: reply }]);
      if (data?.openPortal) {
        setShowAuth(true); // gate by auth, then portal
      }
    } catch {
      setMessages(prev => [...prev, { sender:"bot", text:"⚠️ I couldn’t reach the server just now." }]);
    }
  };

  const toggleTheme = () => {
    setTheme(t => { const next = t==="dark" ? "light":"dark"; if (typeof window!=="undefined") localStorage.setItem("da_theme", next); return next; });
  };

  const isDark = theme === "dark";
  const styles: { [k: string]: React.CSSProperties } = {
    frame: { display:"grid", gridTemplateColumns:"1fr auto", gap:0, maxWidth:1100, margin:"0 auto", padding:16, fontFamily:"'Segoe UI', Arial, sans-serif", background: isDark?"#0b1220":"#f3f4f6", minHeight:"100vh", color: isDark?"#e5e7eb":"#111827" },
    card: { border: isDark?"1px solid #1f2937":"1px solid #e5e7eb", borderRadius:16, background: isDark?"#111827":"#ffffff", boxShadow: isDark?"0 8px 24px rgba(0,0,0,0.45)":"0 8px 24px rgba(0,0,0,0.06)", overflow:"hidden", width:720, transition:"width .3s ease" },
    header: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom: isDark?"1px solid #1f2937":"1px solid #e5e7eb", background: isDark?"#0f172a":"#fafafa" },
    brand: { display:"flex", alignItems:"center", gap:10, fontWeight:700 },
    onlineDot: { marginLeft:8, fontSize:12, color:"#10b981", fontWeight:600 },
    tools: { display:"flex", alignItems:"center", gap:8 },
    select: { padding:"6px 10px", borderRadius:8, border: isDark?"1px solid #374151":"1px solid #d1d5db", background: isDark?"#111827":"#fff", color: isDark?"#e5e7eb":"#111827" },
    btn: { padding:"6px 10px", borderRadius:8, border: isDark?"1px solid #374151":"1px solid #d1d5db", background: isDark?"#111827":"#fff", color: isDark?"#e5e7eb":"#111827", cursor:"pointer" },
    chat: { height:520, overflowY:"auto", padding:16, background: isDark?"linear-gradient(#0b1220,#0f172a)":"linear-gradient(#ffffff,#fafafa)", display:"flex", flexDirection:"column", gap:12 },
    row: { display:"flex", alignItems:"flex-start", gap:10 },
    rowUser: { justifyContent:"flex-end" },
    avatarWrap: { width:40, height:40, borderRadius:"50%", overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center" },
    bubble: { padding:"10px 14px", borderRadius:14, maxWidth:"70%", lineHeight:1.45, boxShadow: isDark?"0 2px 10px rgba(0,0,0,0.5)":"0 2px 10px rgba(0,0,0,0.06)" },
    bubbleBot: { background: isDark?"#1f2937":"#f3f4f6", color: isDark?"#e5e7eb":"#111827", borderTopLeftRadius:6 },
    bubbleUser: { background: isDark?"#1d4ed8":"#dbeafe", color: isDark?"#e5e7eb":"#0f172a", borderTopRightRadius:6 },
    attach: { marginTop:8 },
    chip: { display:"inline-flex", alignItems:"center", gap:8, fontSize:12, padding:"6px 10px", background: isDark?"#0b1220":"#fff", border: isDark?"1px solid #374151":"1px solid #e5e7eb", borderRadius:999 },
    footer: { display:"flex", alignItems:"center", gap:8, padding:12, borderTop: isDark?"1px solid #1f2937":"1px solid #e5e7eb", background: isDark?"#0f172a":"#fafafa" }
  };

  return (
    <>
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
              {loggedEmail ? (
                <button type="button" style={styles.btn} onClick={()=>{ setLoggedEmail(undefined); setDisplayName(undefined); setShowPortal(false); }} title="Log out">
                  Logout
                </button>
              ) : (
                <button type="button" style={styles.btn} onClick={()=>setShowAuth(true)} title="Open client portal">
                  Open Portal
                </button>
              )}
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
            <button type="button" onClick={handleSubmit}
              style={{padding:"10px 14px", borderRadius:8, border:"none", background:"#16a34a", color:"#fff", cursor:"pointer", fontWeight:600}}>
              Send
            </button>
          </div>
        </div>
      </main>

      {/* Auth gate (first) */}
      <AuthScreen
        visible={showAuth && !loggedEmail}
        onClose={()=>setShowAuth(false)}
        onAuthed={(email, name) => {
          setLoggedEmail(email);
          if (name) setDisplayName(name);
          setShowAuth(false);
          setShowPortal(true);
        }}
      />

      {/* Fullscreen portal only after auth */}
      <PortalScreen
        visible={showPortal && !!loggedEmail}
        onClose={()=>setShowPortal(false)}
        displayName={displayName}
        loggedEmail={loggedEmail}
      />
    </>
  );
}
