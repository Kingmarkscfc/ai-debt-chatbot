import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import avatarPhoto from "../assets/advisor-avatar-human.png"; // bundled

type Sender = "user" | "bot";
type Attachment = { filename: string; url: string; mimeType?: string; size?: number };
type Message = { sender: Sender; text: string; attachment?: Attachment };

type MoneyRow = { id: string; label: string; amount: string };
type DebtRow = { id: string; creditor: string; balance: string; accountRef: string };
type Profile = {
  full_name: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  postcode: string;
  incomes: MoneyRow[];
  expenses: MoneyRow[];
  debts: DebtRow[];
};

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

/* ------------------------- Helpers ------------------------- */
function cryptoRandomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return (crypto as any).randomUUID();
  return Math.random().toString(36).slice(2);
}
function currencyToNumber(v: string) {
  const n = parseFloat((v || "").replace(/[^\d.]/g, ""));
  return isNaN(n) ? 0 : n;
}
function sumMoney(rows: MoneyRow[]) {
  return rows.reduce((acc, r) => acc + currencyToNumber(r.amount), 0);
}

/* ------------ Client Portal (FULL-SCREEN OVERLAY) ------------ */
function PortalPanel({
  sessionId, visible, onClose, onDisplayName
}: { sessionId: string; visible: boolean; onClose: () => void; onDisplayName: (name?: string)=>void; }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "profile">("register");
  const [tab, setTab] = useState<"details"|"income"|"debts"|"docs">("details");

  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [notice, setNotice] = useState<string>("");

  const [clientRef, setClientRef] = useState<number | null>(null);
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
    ],
    debts: []
  });

  // docs list for this session
  const [docs, setDocs] = useState<{id:string;file_name:string;file_url:string;uploaded_at:string;category?:string;creditor?:string;debt_ref?:string}[]>([]);
  async function loadDocs() {
    try {
      const r = await fetch(`/api/portal/documents?sessionId=${encodeURIComponent(sessionId)}`);
      const j = await r.json();
      if (j?.ok) setDocs(j.documents || []);
    } catch { /* ignore */ }
  }

  // computed task checks
  const totalIncome = sumMoney(profile.incomes);
  const totalExpense = sumMoney(profile.expenses);
  const disposable = totalIncome - totalExpense;

  const hasBankStatement = docs.some(d => (d.category === "bank_statement") || /statement/i.test(d.file_name));
  const hasPayslip      = docs.some(d => (d.category === "payslip")       || /payslip|sa302/i.test(d.file_name));
  const hasCredLetter   = docs.some(d => (d.category === "creditor_letter")|| /creditor|letter/i.test(d.file_name));

  const tasks = [
    { id:"name",    label:"Add your full name",                  done: !!profile.full_name.trim() },
    { id:"phone",   label:"Add a contact phone",                 done: !!profile.phone.trim() },
    { id:"addr",    label:"Add your address & postcode",         done: !!(profile.address1.trim() && profile.postcode.trim()) },
    { id:"income",  label:"Enter at least one income",           done: totalIncome > 0 },
    { id:"expense", label:"Enter at least one monthly expense",  done: totalExpense > 0 },
    { id:"bank",    label:"Upload 1 month bank statements",      done: hasBankStatement },
    { id:"payslip", label:"Upload 1 month payslip",              done: hasPayslip },
    { id:"letters", label:"Upload creditor letters",             done: hasCredLetter },
  ];
  const tasksOutstanding = tasks.filter(t => !t.done).length;

  // prevent background scroll when visible + auto-load saved email profile
  useEffect(() => {
    if (!visible) return;
    setNotice("");
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const savedEmail = typeof window !== "undefined" ? localStorage.getItem("portal_email") : null;
    (async () => {
      if (savedEmail) {
        setEmail(savedEmail);
        // try load existing profile; if found, jump to profile
        try {
          const r = await fetch(`/api/portal/profile?email=${encodeURIComponent(savedEmail)}`);
          const j = await r.json();
          if (j?.ok) {
            setClientRef(j.clientRef || null);
            if (j.profile) {
              setProfile({
                full_name: j.profile.full_name || "",
                phone: j.profile.phone || "",
                address1: j.profile.address1 || "",
                address2: j.profile.address2 || "",
                city: j.profile.city || "",
                postcode: j.profile.postcode || "",
                incomes: Array.isArray(j.profile.incomes) ? j.profile.incomes : [],
                expenses: Array.isArray(j.profile.expenses) ? j.profile.expenses : [],
                debts: Array.isArray(j.profile.debts) ? j.profile.debts : []
              });
              if (j.profile.full_name) onDisplayName(j.profile.full_name);
              setMode("profile");
            } else {
              setMode("register");
            }
          }
        } catch { /* ignore */ }
        await loadDocs();
      } else {
        setMode("register");
      }
    })();

    return () => { document.body.style.overflow = prev; };
  }, [visible]); // eslint-disable-line

  // Esc to close
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, onClose]);

  const validatePin = (p: string) => /^\d{4}$/.test(p);
  const normalizeEmail = (e: string) => (e || "").trim().toLowerCase();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));

  const loadProfile = async (em: string) => {
    try {
      const r = await fetch(`/api/portal/profile?email=${encodeURIComponent(em)}`);
      const j = await r.json();
      if (j?.ok) {
        setClientRef(j.clientRef || null);
        if (j.profile) {
          setProfile({
            full_name: j.profile.full_name || "",
            phone: j.profile.phone || "",
            address1: j.profile.address1 || "",
            address2: j.profile.address2 || "",
            city: j.profile.city || "",
            postcode: j.profile.postcode || "",
            incomes: Array.isArray(j.profile.incomes) ? j.profile.incomes : [],
            expenses: Array.isArray(j.profile.expenses) ? j.profile.expenses : [],
            debts: Array.isArray(j.profile.debts) ? j.profile.debts : []
          });
          if (j.profile.full_name) onDisplayName(j.profile.full_name);
        }
        return !!j.clientRef;
      }
    } catch { /* ignore */ }
    return false;
  };

  const saveProfile = async (quiet = false) => {
    if (!emailValid) return;
    try {
      const r = await fetch("/api/portal/profile", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ email: normalizeEmail(email), sessionId, profile })
      });
      const j = await r.json();
      if (!quiet) setNotice(j?.ok ? "✅ Profile saved." : (j?.error || "Could not save profile."));
    } catch { if (!quiet) setNotice("Network error while saving."); }
  };

  // AUTOSAVE (debounced)
  const saveTimer = useRef<any>(null);
  const loadedRef = useRef(false);
  useEffect(() => { loadedRef.current = true; }, []); // after mount
  useEffect(() => {
    if (mode !== "profile" || !emailValid || !loadedRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveProfile(true), 900);
    return () => clearTimeout(saveTimer.current);
  }, [profile, mode, emailValid]); // eslint-disable-line

  const handleRegister = async () => {
    const em = normalizeEmail(email);
    if (!validatePin(pin) || pin !== pin2) { setNotice("PIN must be 4 digits and match."); return; }
    if (!emailValid) { setNotice("Enter a valid email."); return; }
    try {
      const r = await fetch("/api/portal/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email: em, pin, sessionId})});
      const j = await r.json();
      if (j?.ok) {
        setNotice("Portal created — you are logged in.");
        onDisplayName(j?.displayName);
        setClientRef(j?.clientRef || null);
        localStorage.setItem("portal_email", em);
        if (j?.clientRef) localStorage.setItem("portal_clientRef", String(j.clientRef));
        setMode("profile");
        await saveProfile(true);
        await loadProfile(em);
        await loadDocs();
      } else {
        setClientRef(j?.clientRef || null);
        setNotice(j?.error || "Could not register.");
      }
    } catch { setNotice("Network error."); }
  };
  const handleLogin = async () => {
    const em = normalizeEmail(email);
    if (!emailValid || !validatePin(pin)) { setNotice("Check email and 4-digit PIN."); return; }
    try {
      const r = await fetch("/api/portal/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email: em, pin})});
      const j = await r.json();
      if (j?.ok) {
        setNotice("Logged in.");
        onDisplayName(j?.displayName || undefined);
        setClientRef(j?.clientRef || null);
        localStorage.setItem("portal_email", em);
        if (j?.clientRef) localStorage.setItem("portal_clientRef", String(j.clientRef));
        setMode("profile");
        await loadProfile(em);
        await loadDocs();
      } else {
        setNotice(j?.error || "Login failed.");
      }
    } catch { setNotice("Network error."); }
  };
  const handleForgot = async () => {
    const em = normalizeEmail(email);
    if (!emailValid) { setNotice("Enter a valid email."); return; }
    try {
      const r = await fetch("/api/portal/request-reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email: em})});
      const j = await r.json();
      setNotice(j?.ok ? "Reset link sent to your email." : (j?.error || "Could not send reset link."));
    } catch { setNotice("Network error."); }
  };

  const doLogout = () => {
    setNotice("You’ve been logged out.");
    setMode("login");
    setClientRef(null);
    setTab("details");
    setPin(""); setPin2("");
    if (typeof window !== "undefined") {
      localStorage.removeItem("portal_email");
      localStorage.removeItem("portal_clientRef");
    }
  };

  // Docs tab: generic upload
  const docsInputRef = useRef<HTMLInputElement>(null);
  const [docsUploading, setDocsUploading] = useState(false);
  const handleDocsSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setDocsUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("sessionId", sessionId);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (!j?.ok) { setNotice(`Upload failed — ${j?.details || j?.error}`); }
      else { setNotice("Document uploaded."); await loadDocs(); }
    } catch { setNotice("Upload failed — network error."); }
    finally { setDocsUploading(false); if (docsInputRef.current) docsInputRef.current.value=""; }
  };

  // Debts tab: creditor letter upload (tagged)
  const creditorInputRef = useRef<HTMLInputElement>(null);
  const [pendingCreditorMeta, setPendingCreditorMeta] = useState<{creditor?:string; debtRef?:string} | null>(null);
  const handleCreditorUploadClick = (row: DebtRow) => {
    setPendingCreditorMeta({ creditor: row.creditor, debtRef: row.accountRef });
    creditorInputRef.current?.click();
  };
  const handleCreditorFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setDocsUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sessionId", sessionId);
      fd.append("category", "creditor_letter");
      if (pendingCreditorMeta?.creditor) fd.append("creditor", pendingCreditorMeta.creditor);
      if (pendingCreditorMeta?.debtRef)  fd.append("debt_ref", pendingCreditorMeta.debtRef);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (!j?.ok) setNotice(`Upload failed — ${j?.details || j?.error}`);
      else { setNotice("Creditor letter uploaded."); await loadDocs(); }
    } catch { setNotice("Upload failed — network error."); }
    finally {
      setDocsUploading(false);
      if (creditorInputRef.current) creditorInputRef.current.value="";
      setPendingCreditorMeta(null);
    }
  };

  const headerTitle = clientRef ? `Client Reference #${clientRef}${profile.full_name ? " — " + profile.full_name : ""}` : "Client Portal";

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
          <strong>{headerTitle}</strong>
        </div>

        {mode === "profile" ? (
          <div style={{display:"flex", gap:8}}>
            <button onClick={()=>setTab("details")} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: tab==="details"?"#1f2937":"transparent", color:"#e5e7eb"}}>Your Details</button>
            <button onClick={()=>setTab("income")}  style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: tab==="income" ?"#1f2937":"transparent", color:"#e5e7eb"}}>Income & Expenditure</button>
            <button onClick={()=>setTab("debts")}   style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: tab==="debts"  ?"#1f2937":"transparent", color:"#e5e7eb"}}>Debts</button>
            <button onClick={()=>setTab("docs")}    style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: tab==="docs"   ?"#1f2937":"transparent", color:"#e5e7eb"}}>Supporting Documents</button>
            <button onClick={doLogout}              style={{padding:"6px 10px", borderRadius:8, border:"1px solid #ef4444", background:"transparent", color:"#fecaca"}}>Logout</button>
          </div>
        ) : (
          <div style={{fontSize:12, opacity:.85}}>Please set up your client portal so you can view and save your progress.</div>
        )}
      </div>

      {/* content */}
      <div style={{overflowY:"auto"}}>
        <div style={{
          maxWidth: 1000, margin:"18px auto", padding:"16px",
          background:"linear-gradient(135deg,#0b1220,#111827)", color:"#e5e7eb",
          border:"1px solid #1f2937", borderRadius:16, boxShadow:"0 10px 30px rgba(0,0,0,0.45)"
        }}>
          {mode !== "profile" && (
            <>
              <div style={{display:"flex", gap:8, marginBottom:12}}>
                <button onClick={()=>setMode("register")} style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="register"?"#1f2937":"transparent", color:"#e5e7eb"}}>Register</button>
                <button onClick={()=>setMode("login")}    style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="login"   ?"#1f2937":"transparent", color:"#e5e7eb"}}>Login</button>
                <button onClick={()=>setMode("forgot")}   style={{padding:"6px 10px", borderRadius:8, border:"1px solid #374151", background: mode==="forgot"  ?"#1f2937":"transparent", color:"#e5e7eb"}}>Forgot PIN</button>
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
                {mode==="login"    && <button onClick={handleLogin}    style={{padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Log In</button>}
                {mode==="forgot"   && <button onClick={handleForgot}   style={{padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Send Reset Email</button>}

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
              <ul style={{listStyle:"none", margin:0, padding:0, display:"grid", gap:6}}>
                {tasks.map(t => (
                  <li key={t.id} style={{display:"flex", alignItems:"center", gap:8, opacity: t.done? .7 : 1}}>
                    <span>{t.done ? "✅" : "⬜"}</span>
                    <span>{t.label}</span>
                  </li>
                ))}
              </ul>

              {/* Tabs content */}
              {tab === "details" && (
                <div style={{display:"grid", gap:10}}>
                  <div style={{fontWeight:700, marginBottom:4}}>Your details</div>
                  <div style={{display:"grid", gap:10, gridTemplateColumns:"1fr 1fr", maxWidth:"100%"}}>
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
                  <button onClick={()=>saveProfile(false)} style={{marginTop:8, padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Save</button>
                  {notice && <div style={{fontSize:12, color:"#a7f3d0"}}>{notice}</div>}
                </div>
              )}

              {tab === "income" && (
                <div style={{display:"grid", gap:12}}>
                  <div style={{fontWeight:700}}>Income</div>
                  {profile.incomes.map(row=>(
                    <div key={row.id} style={{display:"grid", gridTemplateColumns:"1fr 160px 40px", gap:8}}>
                      <input placeholder="Label" value={row.label} onChange={e=>setProfile(p=>({...p, incomes:p.incomes.map(r=>r.id===row.id?{...r, label:e.target.value}:r)}))}
                        style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                      <input placeholder="Amount / month" value={row.amount} onChange={e=>setProfile(p=>({...p, incomes:p.incomes.map(r=>r.id===row.id?{...r, amount:e.target.value}:r)}))}
                        inputMode="decimal" style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                      <button onClick={()=>setProfile(p=>({...p, incomes:p.incomes.filter(r=>r.id!==row.id)}))} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>✕</button>
                    </div>
                  ))}
                  <button onClick={()=>setProfile(p=>({...p, incomes:[...p.incomes, {id:cryptoRandomId(), label:"", amount:""}]}))} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>+ Add income</button>
                  <div style={{textAlign:"right", opacity:.9}}>Total income: £{totalIncome.toFixed(2)}</div>

                  <hr style={{borderColor:"#1f2937"}} />

                  <div style={{fontWeight:700}}>Expenditure</div>
                  {profile.expenses.map(row=>(
                    <div key={row.id} style={{display:"grid", gridTemplateColumns:"1fr 160px 40px", gap:8}}>
                      <input placeholder="Label" value={row.label} onChange={e=>setProfile(p=>({...p, expenses:p.expenses.map(r=>r.id===row.id?{...r, label:e.target.value}:r)}))}
                        style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                      <input placeholder="Amount / month" value={row.amount} onChange={e=>setProfile(p=>({...p, expenses:p.expenses.map(r=>r.id===row.id?{...r, amount:e.target.value}:r)}))}
                        inputMode="decimal" style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                      <button onClick={()=>setProfile(p=>({...p, expenses:p.expenses.filter(r=>r.id!==row.id)}))} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>✕</button>
                    </div>
                  ))}
                  <button onClick={()=>setProfile(p=>({...p, expenses:[...p.expenses, {id:cryptoRandomId(), label:"", amount:""}]}))} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>+ Add expense</button>
                  <div style={{textAlign:"right", fontWeight:700}}>
                    Disposable income: <span style={{color: disposable>=0 ? "#34d399" : "#f87171"}}>£{disposable.toFixed(2)}</span>
                  </div>

                  <button onClick={()=>saveProfile(false)} style={{marginTop:8, padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Save</button>
                  {notice && <div style={{fontSize:12, color:"#a7f3d0"}}>{notice}</div>}
                </div>
              )}

              {tab === "debts" && (
                <div style={{display:"grid", gap:12}}>
                  <div style={{fontWeight:700}}>Debts</div>
                  <input
                    type="file"
                    hidden
                    ref={creditorInputRef}
                    onChange={handleCreditorFileSelected}
                  />
                  {profile.debts.map(row=>(
                    <div key={row.id} style={{display:"grid", gridTemplateColumns:"1fr 140px 1fr 100px 40px", gap:8}}>
                      <input placeholder="Creditor" value={row.creditor} onChange={e=>setProfile(p=>({...p, debts:p.debts.map(r=>r.id===row.id?{...r, creditor:e.target.value}:r)}))}
                        style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                      <input placeholder="Balance (£)" value={row.balance} onChange={e=>setProfile(p=>({...p, debts:p.debts.map(r=>r.id===row.id?{...r, balance:e.target.value}:r)}))}
                        inputMode="decimal" style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                      <input placeholder="Account / Ref" value={row.accountRef} onChange={e=>setProfile(p=>({...p, debts:p.debts.map(r=>r.id===row.id?{...r, accountRef:e.target.value}:r)}))}
                        style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb"}} />
                      <button onClick={()=>handleCreditorUploadClick(row)} disabled={docsUploading}
                        style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>📎 Letter</button>
                      <button onClick={()=>setProfile(p=>({...p, debts:p.debts.filter(r=>r.id!==row.id)}))} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>✕</button>
                    </div>
                  ))}
                  <button onClick={()=>setProfile(p=>({...p, debts:[...p.debts, {id:cryptoRandomId(), creditor:"", balance:"", accountRef:""}]}))} style={{padding:"8px 10px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>+ Add debt</button>
                  <button onClick={()=>saveProfile(false)} style={{marginTop:4, padding:"10px 12px", borderRadius:8, background:"#16a34a", color:"#fff", border:"none", cursor:"pointer"}}>Save Debts</button>
                  {notice && <div style={{fontSize:12, color:"#a7f3d0"}}>{notice}</div>}
                </div>
              )}

              {tab === "docs" && (
                <div style={{display:"grid", gap:12}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                    <div style={{fontWeight:700}}>Supporting Documents</div>
                    <div>
                      <input type="file" hidden ref={docsInputRef} onChange={handleDocsSelected} />
                      <button onClick={()=>docsInputRef.current?.click()} disabled={docsUploading}
                        style={{padding:"8px 12px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#e5e7eb"}}>
                        📎 Upload {docsUploading ? "…" : ""}
                      </button>
                    </div>
                  </div>
                  <div style={{fontSize:12, opacity:.8}}>
                    • ID • Bank Statements (1m) • Payslip (1m) or SA302 • UC statements • Car finance docs • Creditor letters.
                  </div>

                  <div style={{display:"grid", gap:8}}>
                    {docs.map(d => (
                      <a key={d.id} href={d.file_url} target="_blank" rel="noreferrer"
                        style={{display:"inline-flex", alignItems:"center", gap:8, padding:"6px 10px", borderRadius:999, border:"1px solid #374151", background:"#0b1220", color:"#e5e7eb", textDecoration:"none"}}>
                        <span>{fileEmoji(d.file_name)}</span>
                        <span style={{fontWeight:600}}>{prettyFilename(d.file_name)}</span>
                        {d.creditor && <span style={{opacity:.8}}>({d.creditor})</span>}
                        <span style={{opacity:.7}}>{new Date(d.uploaded_at).toLocaleString()}</span>
                        <span style={{textDecoration:"underline"}}>Download ⬇️</span>
                      </a>
                    ))}
                    {!docs.length && <div style={{opacity:.8}}>No documents yet for this session.</div>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{height:24}} />
      </div>
    </div>
  );
}

/* --------------------------- Page (chat UI) --------------------------- */
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

  // Chat footer upload
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
