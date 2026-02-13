import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Image from "next/image";
import avatarPhoto from "../assets/advisor-avatar-human.png";

/* =============== Types & helpers =============== */
type Sender = "user" | "bot";
type Attachment = { filename: string; url: string; mimeType?: string; size?: number };
type Message = { id: string; sender: Sender; text: string; attachment?: Attachment; at?: string; kind?: 'popup'; popupKind?: string; hidden?: boolean };

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseInlineTrigger(reply: string): { clean: string; popupKind?: string } {
  const raw = String(reply ?? "");
  const m = raw.match(/\[TRIGGER:\s*([A-Z0-9_]+)\s*\]/i);
  if (!m) return { clean: raw };
  const trig = (m[1] || "").toUpperCase();
  const clean = raw.replace(/\s*\[TRIGGER:[^\]]*\]\s*/gi, " ").replace(/\s{2,}/g, " ").trim();
  // Map triggers to popup kinds (expand as needed)
  if (trig === "OPEN_FACT_FIND_POPUP") return { clean, popupKind: "FACT_FIND" };
  if (trig === "OPEN_INCOME_EXPENSE_POPUP") return { clean, popupKind: "INCOME_EXPENSE" };
  if (trig === "OPEN_ADDRESS_POPUP") return { clean, popupKind: "ADDRESS" };
  if (trig === "OPEN_DOCUMENTS_POPUP") return { clean, popupKind: "DOCUMENTS" };
  return { clean, popupKind: trig };
}

type AddressEntry = { line1: string; line2: string; city: string; postcode: string; yearsAt: number };

type PortalDoc = {
  id: string;
  filename: string;
  url: string;
  uploadedAt?: string;
  category?: string;
};

const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const prettyFilename = (s: string) => (s || "").split("/").pop() || s;

const ensureSessionId = () => {
  if (typeof window === "undefined") return "server";
  const key = "da_session_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(key, id);
  return id;
};

function pickUkMaleVoice(voices: SpeechSynthesisVoice[]) {
  const preferred = [
    (v: SpeechSynthesisVoice) => /en-GB/i.test(v.lang) && /male/i.test(v.name),
    (v: SpeechSynthesisVoice) => /en-GB/i.test(v.lang),
    (v: SpeechSynthesisVoice) => /english/i.test(v.lang) && /GB|UK/i.test(v.name),
  ];
  for (const rule of preferred) {
    const match = voices.find(rule);
    if (match) return match;
  }
  return voices[0] || null;
}

/* =============== Component =============== */
export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
    const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [pinToTopId, setPinToTopId] = useState<string | null>(null);
// ✅ Persist server-side controller state so script steps advance correctly
  const [chatState, setChatState] = useState<any>({ step: 0, askedNameTries: 0, name: null });

  const [input, setInput] = useState("");
  const [language, setLanguage] = useState<string>("English");
  const [voiceOn, setVoiceOn] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Portal state
  const [showAuth, setShowAuth] = useState(false);
  const [showPortal, setShowPortal] = useState(false);
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [loggedEmail, setLoggedEmail] = useState<string | undefined>(undefined);

  // Let portal auto-refresh docs when chat upload succeeds
  const [uploadBump, setUploadBump] = useState(0);

  const sessionId = useMemo(() => ensureSessionId(), []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chosenVoice = useRef<SpeechSynthesisVoice | null>(null);

  const [portalEmail, setPortalEmail] = useState("");
  const [portalPass, setPortalPass] = useState("");
  const [portalPass2, setPortalPass2] = useState("");
  const [portalMode, setPortalMode] = useState<"login" | "register" | "reset">("login");
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [docs, setDocs] = useState<PortalDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);

  // I&E popup
  const [showIe, setShowIe] = useState(false);
  const [ieIncome, setIeIncome] = useState<{ source: string; amount: number }[]>([{ source: "Wages", amount: 0 }]);
  const [ieExpense, setIeExpense] = useState<{ item: string; amount: number }[]>([{ item: "Rent/Mortgage", amount: 0 }]);
  const [ieSaving, setIeSaving] = useState(false);
  const [ieError, setIeError] = useState<string | null>(null);

  // Fact Find popup (Step 5)
  const [showFactFind, setShowFactFind] = useState(false);
  const [ffFullName, setFfFullName] = useState("");
  const [ffPhone, setFfPhone] = useState("");
  const [ffEmail, setFfEmail] = useState("");
  const [ffDob, setFfDob] = useState("");
  const [ffResStatus, setFfResStatus] = useState("");
  const [ffAddrYears, setFfAddrYears] = useState("");
  const [ffAddrMonths, setFfAddrMonths] = useState("");

  const [ffManualAddress, setFfManualAddress] = useState(false);
  const [ffAddr1, setFfAddr1] = useState("");
  const [ffAddr2, setFfAddr2] = useState("");
  const [ffCity, setFfCity] = useState("");
  const [ffCounty, setFfCounty] = useState("");
  const [ffPostcodeTried, setFfPostcodeTried] = useState(false);
  const [activePostcodeContext, setActivePostcodeContext] = useState<"factfind" | "address" | null>(null);
  const [ffSaving, setFfSaving] = useState(false);
  const [ffError, setFfError] = useState<string | null>(null);

  const ffFullNameRef = useRef<HTMLInputElement | null>(null);
  const ffPhoneRef = useRef<HTMLInputElement | null>(null);
  const ffEmailRef = useRef<HTMLInputElement | null>(null);
  const ffDobRef = useRef<HTMLInputElement | null>(null);
  const ffPostcodeRef = useRef<HTMLInputElement | null>(null);

  
  const [postcode, setPostcode] = useState("");
  const [postcodeLoading, setPostcodeLoading] = useState(false);
  const [postcodeError, setPostcodeError] = useState<string | null>(null);
  const [postcodeResults, setPostcodeResults] = useState<any[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<any | null>(null);

const canSubmitFactFind = useMemo(() => {
    const hasSelected = Boolean(selectedAddress && selectedAddress.trim());
    const hasManual =
      Boolean(ffAddr1.trim()) &&
      Boolean(ffCity.trim()) &&
      Boolean(ffCounty.trim()) &&
      Boolean(postcode.trim());
    const hasAddress = hasSelected || (ffManualAddress && hasManual);
    return Boolean(
      ffFullName.trim() &&
        ffPhone.trim() &&
        ffEmail.trim() &&
        ffDob.trim() &&
        postcode.trim() &&
        hasAddress &&
        ffAddrYears.trim() &&
        ffAddrMonths.trim() &&
        ffResStatus.trim()
    );
  }, [
    ffFullName,
    ffPhone,
    ffEmail,
    ffDob,
    postcode,
    selectedAddress,
    ffManualAddress,
    ffAddr1,
    ffCity,
    ffCounty,
    ffAddrYears,
    ffAddrMonths,
    ffResStatus,
  ]);

// Address popup
  const [showAddress, setShowAddress] = useState(false);
  const [pinned, setPinned] = useState<{ id: string; text: string } | null>(null);

  const [addressHistory, setAddressHistory] = useState<AddressEntry[]>([
    { line1: "", line2: "", city: "", postcode: "", yearsAt: 0 },
  ]);

  const isDark = theme === "dark";

  // ✅ FIX: make loadDocs stable so it can be used in useEffect deps (removes ESLint warning)
  const loadDocs = useCallback(async () => {
    if (!sessionId) return;
    try {
      setDocsError(null);
      setDocsLoading(true);
      const r = await fetch(`/api/portal/documents?sessionId=${encodeURIComponent(sessionId)}`);
      const j = await r.json();
      if (j?.ok) setDocs(j?.documents || []);
      else setDocsError("Couldn’t load documents.");
    } catch {
      setDocsError("Couldn’t load documents (network).");
    } finally {
      setDocsLoading(false);
    }
  }, [sessionId]);

  // ✅ FIX: style function must NOT live inside styles object (which is CSSProperties-only)
  const tabStyle = useCallback(
    (active: boolean): CSSProperties => ({
      padding: "6px 10px",
      borderRadius: 999,
      border: isDark ? "1px solid #374151" : "1px solid #d1d5db",
      background: active ? (isDark ? "#1f2937" : "#111827") : isDark ? "#111827" : "#fff",
      color: active ? "#fff" : isDark ? "#e5e7eb" : "#111827",
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 600,
    }),
    [isDark]
  );

  const styles: { [k: string]: CSSProperties } = {
    frame: {
      display: "grid",
      gridTemplateColumns: "1fr",
      gap: 0,
      maxWidth: 1200,
      margin: "0 auto",
      padding: 16,
      fontFamily: "'Segoe UI', Arial, sans-serif",
      background: isDark ? "#0b1220" : "#f3f4f6",
      minHeight: "100vh",
      color: isDark ? "#e5e7eb" : "#111827",
    },
    card: {
      border: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb",
      borderRadius: 16,
      background: isDark ? "#111827" : "#ffffff",
      boxShadow: isDark ? "0 8px 24px rgba(0,0,0,0.45)" : "0 8px 24px rgba(0,0,0,0.06)",
      overflow: "hidden",
      width: 760,
      margin: "0 auto",
    },
    header: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "12px 16px",
      borderBottom: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb",
      background: isDark ? "#0f172a" : "#fafafa",
    },
    brand: { display: "flex", alignItems: "center", gap: 10, fontWeight: 700 },
    onlineDot: { marginLeft: 8, fontSize: 12, color: "#10b981", fontWeight: 600 },
    tools: { display: "flex", alignItems: "center", gap: 8 },
    select: {
      padding: "6px 10px",
      borderRadius: 8,
      border: isDark ? "1px solid #374151" : "1px solid #d1d5db",
      background: isDark ? "#111827" : "#fff",
      color: isDark ? "#e5e7eb" : "#111827",
    },
    btn: {
      padding: "6px 10px",
      borderRadius: 8,
      border: isDark ? "1px solid #374151" : "1px solid #d1d5db",
      background: isDark ? "#111827" : "#fff",
      color: isDark ? "#e5e7eb" : "#111827",
      cursor: "pointer",
    },
    chat: {
      height: 560,
      overflowY: "auto",
      padding: 16,
      background: isDark ? "linear-gradient(#0b1220,#0f172a)" : "linear-gradient(#ffffff,#fafafa)",
      display: "flex",
      flexDirection: "column",
      gap: 12,
    },
    row: { display: "flex", alignItems: "flex-start", gap: 10 },
    bubbleBot: {
      background: isDark ? "#0b1220" : "#f3f4f6",
      border: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb",
      padding: 12,
      borderRadius: 14,
      maxWidth: 600,
      whiteSpace: "pre-wrap",
      lineHeight: 1.35,
    },
    bubbleUser: {
      marginLeft: "auto",
      background: isDark ? "#1f2937" : "#111827",
      color: "#fff",
      padding: 12,
      borderRadius: 14,
      maxWidth: 600,
      whiteSpace: "pre-wrap",
      lineHeight: 1.35,
    },
    footer: {
      display: "flex",
      gap: 8,
      padding: 12,
      borderTop: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb",
      alignItems: "center",
    },
    input: {
      flex: 1,
      padding: "10px 12px",
      borderRadius: 12,
      border: isDark ? "1px solid #374151" : "1px solid #d1d5db",
      background: isDark ? "#0b1220" : "#fff",
      color: isDark ? "#e5e7eb" : "#111827",
    },
    small: { fontSize: 12, opacity: 0.8 },
    pinnedBar: {
      padding: "10px 12px",
      marginBottom: 10,
      borderRadius: 14,
      border: `1px solid ${isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)"}`,
      background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.03)",
    },
    pinnedLabel: { fontSize: 12, opacity: 0.8, marginBottom: 6 },
    pinnedText: { fontSize: 14, lineHeight: 1.35 },
    inlinePopupCard: {
      borderRadius: 16,
      border: `1px solid ${isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)"}`,
      padding: 12,
      background: isDark ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.75)",
    },
    inlinePopupTitle: {
      fontSize: 14,
      fontWeight: 700,
      marginBottom: 6,
    },
    inlinePopupText: {
      fontSize: 13,
      opacity: 0.9,
      lineHeight: 1.4,
    },
    inlinePopupLabel: {
      fontSize: 12,
      fontWeight: 600,
      marginTop: 8,
      marginBottom: 6,
      opacity: 0.9,
    },
    inlinePopupInput: {
      flex: "1 1 220px",
      minWidth: 220,
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "#e5e7eb",
      color: "#111827",
      outline: "none",
    },

    inlinePopupRow: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap",
    },
    inlinePopupFieldLabel: {
      minWidth: 140,
      fontSize: 13,
      fontWeight: 700,
      opacity: 0.9,
    },
    inlinePopupTick: {
      width: 22,
      minWidth: 22,
      textAlign: "center" as const,
      fontSize: 16,
      fontWeight: 900,
      color: "#16a34a",
      lineHeight: "1",
    },
    inlinePopupTickInline: {
      width: 22,
      minWidth: 22,
      textAlign: "center" as const,
      fontSize: 16,
      fontWeight: 900,
      color: "#16a34a",
      lineHeight: "1",
      alignSelf: "center",
    },

    inlinePopupInputFlex: {
      flex: "1 1 260px",
      minWidth: 240,
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "#e5e7eb",
      color: "#111827",
      outline: "none",
    },
    inlinePopupInputSmall: {
      flex: "1 1 120px",
      minWidth: 120,
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "#e5e7eb",
      color: "#111827",
      outline: "none",
    },
    inlinePopupSelect: {
      width: "100%",
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "#e5e7eb",
      color: "#111827",
      outline: "none",
    },
    inlinePopupSelectFlex: {
      flex: "1 1 260px",
      minWidth: 240,
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "#e5e7eb",
      color: "#111827",
      outline: "none",
    },
    inlinePopupBtn: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(17, 24, 39, 0.35)",
    background: "rgba(17, 24, 39, 0.92)",
    color: "#fff",
    fontWeight: 800,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
    inlinePopupBtnPrimary: {
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid #111827",
      background: "#111827",
      color: "#fff",
      cursor: "pointer",
      whiteSpace: "nowrap",
      fontWeight: 700,
    },
    inlinePopupList: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      maxHeight: 240,
      overflowY: "auto",
      marginTop: 6,
    },
    inlinePopupListItem: {
      textAlign: "left",
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(0,0,0,0.18)",
      color: "#fff",
      cursor: "pointer",
    },
    inlinePopupSelected: {
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(0,0,0,0.18)",
      fontSize: 13,
    },
    modalOverlay: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.6)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      zIndex: 50,
    },
    modal: {
      width: "min(560px, 96vw)",
      borderRadius: 16,
      background: isDark ? "#111827" : "#ffffff",
      border: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb",
      boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
      overflow: "hidden",
    },
    modalHeader: {
      padding: "12px 16px",
      borderBottom: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      background: isDark ? "#0f172a" : "#fafafa",
    },
    modalBody: { padding: 16 },
    field: { display: "grid", gap: 6, marginBottom: 12 },
    label: { fontSize: 13, fontWeight: 600, opacity: 0.9 },
    text: {
      padding: "10px 12px",
      borderRadius: 12,
      border: isDark ? "1px solid #374151" : "1px solid #d1d5db",
      background: isDark ? "#0b1220" : "#fff",
      color: isDark ? "#e5e7eb" : "#111827",
    },
    row2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
    tabs: { display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" },
    docsList: { display: "grid", gap: 10, marginTop: 10 },
    docRow: {
      display: "flex",
      justifyContent: "space-between",
      gap: 12,
      padding: 12,
      borderRadius: 12,
      border: isDark ? "1px solid #1f2937" : "1px solid #e5e7eb",
      background: isDark ? "#0b1220" : "#fff",
      alignItems: "center",
    },
    link: { color: "#60a5fa", textDecoration: "underline" },
    divider: { height: 1, background: isDark ? "#1f2937" : "#e5e7eb", margin: "12px 0" },
  };

  useEffect(() => {
    const savedTheme = typeof window === "undefined" ? null : localStorage.getItem("da_theme");
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme as any);

    setMessages([{ id: makeId(), sender: "bot", text: "Hello! My name’s Mark. What prompted you to seek help with your debts today?", at: nowTime() }]);
    setChatState({ step: 0, askedNameTries: 0, name: null });
  }, []);

  useEffect(() => {
    // When an inline popup opens, we "push up" the triggering bot message to the top of the viewport.
    // In that moment we *must not* auto-scroll to the bottom (or it cancels the push-up effect).
    if (pinToTopId) {
      messageRefs.current[pinToTopId]?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (showFactFind || showIe || showAddress) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pinToTopId, showFactFind, showIe, showAddress]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const assign = () => {
      chosenVoice.current = pickUkMaleVoice((window as any).speechSynthesis.getVoices());
    };
    const vs = (window as any).speechSynthesis.getVoices();
    if (vs?.length) assign();
    else (window as any).speechSynthesis.onvoiceschanged = assign;
  }, []);

  useEffect(() => {
    if (!voiceOn) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const last = messages[messages.length - 1];
    if (!last || last.sender !== "bot") return;
    const u = new SpeechSynthesisUtterance(last.text);
    if (chosenVoice.current) u.voice = chosenVoice.current;
    u.rate = 1;
    u.pitch = 1;
    u.volume = 1;
    (window as any).speechSynthesis.cancel();
    (window as any).speechSynthesis.speak(u);
  }, [messages, voiceOn]);

  const sendToApi = async (text: string, hist: Message[]) => {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, userMessage: text, history: hist.map((m) => m.text), language, state: chatState }),
    });
    return r.json();
  };

  // chat upload (paperclip)
  const onChatUpload = async (file: File) => {
    try {
      const form = new FormData();
      form.append("sessionId", sessionId);
      form.append("file", file);
      const r = await fetch("/api/upload", { method: "POST", body: form });
      const j = await r.json();
      if (j?.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            sender: "bot",
            text: `Got it — uploaded ${prettyFilename(j.filename)}.`,
            attachment: { filename: j.filename, url: j.url, mimeType: j.mimeType, size: j.size },
            at: nowTime(),
          },
        ]);
        setUploadBump((x) => x + 1);
      } else {
        setMessages((prev) => [...prev, { id: makeId(), sender: "bot", text: "Sorry — upload failed.", at: nowTime() }]);
      }
    } catch {
      setMessages((prev) => [...prev, { id: makeId(), sender: "bot", text: "Sorry — upload failed (network).", at: nowTime() }]);
    }
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    const userMsg: Message = { id: makeId(), sender: "user", text, at: nowTime() };
    const nextHist = [...messages, userMsg];
    setMessages(nextHist);

    try {
      const data = await sendToApi(text, nextHist);
      const rawReply = (data?.reply as string) || "Thanks — let’s continue.";
      const reply = rawReply.replace(/\s*\[(?:TRIGGER|UI):[^\]]*\]\s*/gi, " ").replace(/\s{2,}/g, " ").trim();
      if (data?.state) setChatState(data.state);
      if (data?.displayName) setDisplayName(data.displayName);
      // Handle optional UI directives returned by the API (safe: ignored if UI not implemented)
      // NOTE: backend variants may return uiTrigger (string), uiTriggers (string[]), popup (string), or triggers (string|string[])
      const uiTrigRaw = (data?.uiTrigger ?? data?.ui ?? "").toString();
      const uiTrigsArr: string[] = Array.isArray((data as any)?.uiTriggers)
        ? ((data as any).uiTriggers as any[]).map((x) => String(x))
        : Array.isArray((data as any)?.triggers)
          ? ((data as any).triggers as any[]).map((x) => String(x))
          : [];

      const uiPop = (data?.popup ?? "").toString();

      // Fallback: if the compliance sentence is present, we should open the Fact Find popup even if triggers weren't returned.
      const looksLikeStep5 =
        typeof reply === "string" &&
        reply.toLowerCase().includes("moneyhelper.org.uk") &&
        (reply.toLowerCase().includes("please complete a few details") ||
          reply.toLowerCase().includes("to continue") ||
          reply.toLowerCase().includes("complete a few details") ||
          reply.toLowerCase().includes("complete a few details so we can help")); 

      const uiAll = [uiTrigRaw, ...uiTrigsArr, uiPop].filter(Boolean).join(" | ");

      const wantsFactFindPopup =
        looksLikeStep5 ||
        uiAll.includes("OPEN_FACT_FIND_POPUP") ||
        uiAll.includes("OPEN_FACT_FIND") ||
        uiAll.toUpperCase().includes("FACT_FIND");

      const wantsIncome =
        uiAll.includes("OPEN_INCOME_EXPENSE_POPUP") ||
        uiAll.includes("OPEN_INCOME_EXPENSE") ||
        uiAll.toUpperCase().includes("INCOME");

      const wantsAddress =
        uiAll.includes("OPEN_ADDRESS_POPUP") ||
        uiAll.includes("OPEN_ADDRESS") ||
        uiAll.toUpperCase().includes("ADDRESS");

      const willOpenPopup = wantsFactFindPopup || wantsIncome || wantsAddress;
      const ui = uiAll;


// Open portal/auth (existing behaviour keeps working)
      if (ui.includes("OPEN_CLIENT_PORTAL")) {
        setShowAuth(true);
      }
      const botId = makeId();
if (willOpenPopup) {
        setPinned({ id: botId, text: reply });
      } else if (pinned) {
        // If we were previously pinned but the conversation moves on, unpin.
        setPinned(null);
      }

      setMessages((prev) => [...prev, { id: botId, sender: "bot", text: reply, at: nowTime() }]);

      if (willOpenPopup) {
        // Defer opening UI until after the bot message has rendered, so the sentence appears first.
        setTimeout(() => {
          if (wantsFactFindPopup) setShowFactFind(true);
          if (wantsIncome) setShowIe(true);
          if (wantsAddress) setShowAddress(true);
          setPinToTopId(botId);
        }, 0);
      }

      if (data?.openPortal) setShowAuth(true);
    } catch {
      setMessages((prev) => [...prev, { id: makeId(), sender: "bot", text: "⚠️ I couldn’t reach the server just now.", at: nowTime() }]);
    }
  };

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (typeof window !== "undefined") localStorage.setItem("da_theme", next);
  };

  const onPickFile = () => {
    const el = document.createElement("input");
    el.type = "file";
    el.onchange = () => {
      const f = el.files?.[0];
      if (f) onChatUpload(f);
    };
    el.click();
  };

  const onAuthAction = async () => {
    setPortalError(null);
    setNotice(null);

    const email = portalEmail.trim();
    if (!email || !email.includes("@")) return setNotice("Enter a valid email.");
    if (portalMode !== "reset") {
      if (!portalPass || portalPass.length < 6) return setNotice("Password must be at least 6 characters.");
    }
    if (portalMode === "register" && portalPass !== portalPass2) return setNotice("Passwords do not match.");

    setPortalLoading(true);
    try {
      if (portalMode === "login") {
        const r = await fetch("/api/portal/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: portalPass, sessionId }),
        });
        const j = await r.json();
        if (!j?.ok) setPortalError(j?.error || "Login failed.");
        else {
          setLoggedEmail(email);
          setShowAuth(false);
          setShowPortal(true);
          setNotice("Logged in.");
          loadDocs();
        }
      } else if (portalMode === "register") {
        const r = await fetch("/api/portal/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: portalPass, sessionId }),
        });
        const j = await r.json();
        if (!j?.ok) setPortalError(j?.error || "Registration failed.");
        else {
          setLoggedEmail(email);
          setShowAuth(false);
          setShowPortal(true);
          setNotice("Registered.");
          loadDocs();
        }
      } else {
        const r = await fetch("/api/portal/request-reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const j = await r.json();
        if (!j?.ok) setPortalError(j?.error || "Reset request failed.");
        else setNotice("Reset email sent (if the account exists).");
      }
    } catch {
      setPortalError("Network error.");
    } finally {
      setPortalLoading(false);
    }
  };

  useEffect(() => {
    if (showPortal) loadDocs();
  }, [showPortal, uploadBump, loadDocs]);

  const lookupPostcode = async () => {
    const pc = postcode.trim();
    if (!pc) return;
    setPostcodeError(null);
    setPostcodeLoading(true);
    setPostcodeResults([]);
    setSelectedAddress(null);

    // If we are searching from Fact Find, reset manual mode until we know results.
    if (activePostcodeContext === "factfind") {
      setFfPostcodeTried(true);
      setFfManualAddress(false);
    }

    try {
      const r = await fetch("/api/portal/lookup-postcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postcode: pc }),
      });

      let j: any = null;
      try {
        j = await r.json();
      } catch {
        j = null;
      }

      if (!r.ok) {
        const msg = j?.error || `Lookup failed (${r.status}).`;
        setPostcodeError(msg);
        setPostcodeResults([]);
        if (activePostcodeContext === "factfind") setFfManualAddress(true);
        return;
      }

      if (!j?.ok) {
        setPostcodeError(j?.error || "No results.");
        setPostcodeResults([]);
        if (activePostcodeContext === "factfind") setFfManualAddress(true);
        return;
      }

      const addrs: string[] = j?.addresses || [];
      setPostcodeResults(addrs);
      if (!addrs.length && activePostcodeContext === "factfind") setFfManualAddress(true);
    } catch {
      setPostcodeError("Network error.");
      setPostcodeResults([]);
      if (activePostcodeContext === "factfind") setFfManualAddress(true);
    } finally {
      setPostcodeLoading(false);
    }
  };

  const saveIncomeExpense = async () => {
    setIeError(null);
    setIeSaving(true);
    try {
      const r = await fetch("/api/income-expense", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, income: ieIncome, expense: ieExpense }),
      });
      const j = await r.json();
      if (!j?.ok) setIeError(j?.error || "Couldn’t save.");
      else {
        setShowIe(false);
                      setPinned(null);
        setNotice("Income & expenditure saved.");
      }
    } catch {
      setIeError("Network error.");
    } finally {
      setIeSaving(false);
    }
  };

  const saveAddressHistory = async () => {
    setNotice(null);
    try {
      const r = await fetch("/api/portal/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          profile: {
            postcode,
            selectedAddress,
            addressHistory,
          },
        }),
      });
      const j = await r.json();
      if (!j?.ok) setNotice(j?.error || "Couldn’t save address.");
      else {
        setShowAddress(false);
                      setPinned(null);
        setNotice("Address saved.");
      }
    } catch {
      setNotice("Network error.");
    }
  };
  const submitFactFind = async () => {
    setFfError(null);
    if (!canSubmitFactFind) {
      setFfError("Please complete all required fields before continuing.");
      return;
    }

    const addressString = selectedAddress?.trim()
      ? selectedAddress.trim()
      : [
          ffAddr1.trim(),
          ffAddr2.trim(),
          ffCity.trim(),
          ffCounty.trim(),
          postcode.trim(),
        ]
          .filter(Boolean)
          .join(", ");

    setFfSaving(true);
    try {
      const payload = {
        fullName: ffFullName.trim(),
        phone: ffPhone.trim(),
        email: ffEmail.trim(),
        dob: ffDob.trim(),
        postcode: postcode.trim(),
        address: addressString,
        timeAtAddressYears: ffAddrYears.trim(),
        timeAtAddressMonths: ffAddrMonths.trim(),
        residentialStatus: ffResStatus.trim(),
      };

      // Seed portal email field for convenience
      setLoggedEmail(ffEmail.trim());

      // Send a hidden marker message to the chat API so the script continues.
      const marker = `__PROFILE_SUBMIT__ ${JSON.stringify(payload)}`;
      const userMsg: Message = { id: makeId(), sender: "user", text: marker, at: nowTime(), hidden: true };
      const nextHist = [...messages, userMsg];
      setMessages(nextHist);

      const data = await sendToApi(marker, nextHist);
      const rawReply = (data?.reply as string) || "Thanks — let’s continue.";
      const reply = rawReply.replace(/\s*\[(?:TRIGGER|UI):[^\]]*\]\s*/gi, " ").replace(/\s{2,}/g, " ").trim();

      if (data?.state) setChatState(data.state);
      if (data?.displayName) setDisplayName(data.displayName);

      const botMsg: Message = { id: makeId(), sender: "bot", text: reply, at: nowTime() };
      setMessages((prev) => [...prev, botMsg]);

      setShowFactFind(false);
      setFfManualAddress(false);
      setFfPostcodeTried(false);
    } catch {
      setFfError("Sorry — something went wrong saving your details. Please try again.");
    } finally {
      setFfSaving(false);
    }
  };

  return (
    <>
    <div style={styles.frame}>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={styles.brand}>
            <Image src={avatarPhoto} alt="Advisor" width={34} height={34} style={{ borderRadius: 999 }} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>Debt Advisor</span>
                <span style={styles.onlineDot}>● Online</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {displayName ? `Chatting with ${displayName}` : "Private session"} • {sessionId.slice(0, 8)}
              </div>
            </div>
          </div>

          <div style={styles.tools}>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} style={styles.select}>
              <option>English</option>
              <option>Spanish</option>
              <option>Polish</option>
              <option>French</option>
              <option>German</option>
              <option>Portuguese</option>
              <option>Italian</option>
              <option>Romanian</option>
            </select>
            <button style={styles.btn} onClick={() => setVoiceOn((v) => !v)}>
              {voiceOn ? "Voice: On" : "Voice: Off"}
            </button>
            <button style={styles.btn} onClick={toggleTheme}>
              {isDark ? "Light" : "Dark"}
            </button>
            <button style={styles.btn} onClick={onPickFile}>
              Upload
            </button>
            <button style={styles.btn} onClick={() => setShowIe(true)}>
              I&E
            </button>
            <button style={styles.btn} onClick={() => setShowAddress(true)}>
              Address
            </button>
            <button style={styles.btn} onClick={() => setShowPortal((p) => !p)}>
              {showPortal ? "Hide Portal" : "Portal"}
            </button>
          </div>
        </div>

        <div style={styles.chat}>
          {messages.map((m) => (
            <div key={m.id} style={styles.row} ref={(el) => { messageRefs.current[m.id] = el; }}>
              {m.sender === "bot" ? (
                <>
                  <Image src={avatarPhoto} alt="Advisor" width={28} height={28} style={{ borderRadius: 999, marginTop: 2 }} />
                  <div style={styles.bubbleBot}>
                    {m.text}
                    {m.attachment ? (
                      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
                        📎{" "}
                        <a href={m.attachment.url} target="_blank" rel="noreferrer" style={styles.link}>
                          {prettyFilename(m.attachment.filename)}
                        </a>
                      </div>
                    ) : null}
                    {m.at ? <div style={{ marginTop: 6, fontSize: 11, opacity: 0.6 }}>{m.at}</div> : null}
                  </div>
                </>
              ) : (
                <div style={styles.bubbleUser}>
                  {m.text}
                  {m.at ? <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>{m.at}</div> : null}
                </div>
              )}
            </div>
          ))}

          {(showFactFind || showIe || showAddress) ? (
            <div style={{ marginTop: 12 }}>
              <div style={styles.inlinePopupCard}>
                {showFactFind ? (
                  <div style={{ marginBottom: showIe || showAddress ? 16 : 0 }}>
                    <div style={styles.inlinePopupTitle}>Fact Find — your details</div>
                    <div style={styles.inlinePopupText}>
                      Please complete the details below. This will be saved to your file and used to create your client reference.
                    </div>

                    <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                      <div style={styles.inlinePopupRow} onClick={() => ffFullNameRef.current?.focus()}>
                        <div style={styles.inlinePopupFieldLabel}>Full name:</div>
                        <input
                          ref={ffFullNameRef}
                          style={styles.inlinePopupInputFlex as any}
                          value={ffFullName}
                          onChange={(e) => setFfFullName(e.target.value)}
                          placeholder=""
                        />
                        <div style={styles.inlinePopupTick}>{ffFullName.trim() ? "✓" : ""}</div>
                      </div>

                      <div style={styles.inlinePopupRow} onClick={() => ffPhoneRef.current?.focus()}>
                        <div style={styles.inlinePopupFieldLabel}>Contact number:</div>
                        <input
                          ref={ffPhoneRef}
                          style={styles.inlinePopupInputFlex as any}
                          value={ffPhone}
                          onChange={(e) => setFfPhone(e.target.value)}
                          placeholder=""
                        />
                        <div style={styles.inlinePopupTick}>{ffPhone.trim() ? "✓" : ""}</div>
                      </div>

                      <div style={styles.inlinePopupRow} onClick={() => ffEmailRef.current?.focus()}>
                        <div style={styles.inlinePopupFieldLabel}>Email address:</div>
                        <input
                          ref={ffEmailRef}
                          style={styles.inlinePopupInputFlex as any}
                          value={ffEmail}
                          onChange={(e) => setFfEmail(e.target.value)}
                          placeholder=""
                        />
                        <div style={styles.inlinePopupTick}>{ffEmail.trim() ? "✓" : ""}</div>
                      </div>

                      <div style={styles.inlinePopupRow} onClick={() => ffDobRef.current?.focus()}>
                        <div style={styles.inlinePopupFieldLabel}>Date of birth:</div>
                        <input
                          ref={ffDobRef}
                          style={styles.inlinePopupInputFlex as any}
                          type="date"
                          value={ffDob}
                          onChange={(e) => setFfDob(e.target.value)}
                        />
                        <div style={styles.inlinePopupTick}>{ffDob.trim() ? "✓" : ""}</div>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={styles.inlinePopupFieldLabel}>Address postcode:</div>
                      <input
                        ref={ffPostcodeRef}
                        style={styles.inlinePopupInputFlex as any}
                        value={postcode}
                        onChange={(e) => setPostcode(e.target.value)}
                        placeholder="e.g. M1 1AA"
                      />
                      <button
                        type="button"
                        style={styles.inlinePopupBtn as any}
                        onClick={() => {
                          setActivePostcodeContext("factfind");
                          lookupPostcode();
                        }}
                        disabled={postcodeLoading || !postcode.trim()}
                      >
                        {postcodeLoading ? "Searching..." : "Search postcode"}
                      </button>
                      <div style={styles.inlinePopupTickInline}>{postcode.trim() ? "✓" : ""}</div>
                    </div>

                    {postcodeError ? (
  <div style={{ marginTop: 8, fontSize: 13, color: isDark ? "#fecaca" : "#b91c1c" }}>
    {postcodeError}
  </div>
) : null}

{postcodeResults.length ? (
                      <div style={{ marginTop: 10 }}>
                        <div style={styles.inlinePopupLabel}>Selected address:</div>
                        <select
                          style={styles.inlinePopupSelect as any}
                          value={selectedAddress || ""}
                          onChange={(e) => setSelectedAddress(e.target.value)}
                        >
                          <option value="">Select…</option>
                          {postcodeResults.slice(0, 50).map((a, idx) => (
                            <option key={idx} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    
                    {ffManualAddress ? (
                      <div style={{ marginTop: 10 }}>
                        <div style={styles.inlinePopupLabel}>Enter address manually:</div>

                        <div style={styles.inlinePopupRow} onClick={() => ffAddr1Ref.current?.focus()}>
                          <div style={styles.inlinePopupFieldLabel}>Address line 1:</div>
                          <input
                            ref={ffAddr1Ref}
                            style={styles.inlinePopupInputFlex as any}
                            value={ffAddr1}
                            onChange={(e) => setFfAddr1(e.target.value)}
                            placeholder=""
                          />
                          <div style={styles.inlinePopupTick}>{ffAddr1.trim() ? "✓" : ""}</div>
                        </div>

                        <div style={styles.inlinePopupRow} onClick={() => ffAddr2Ref.current?.focus()}>
                          <div style={styles.inlinePopupFieldLabel}>Address line 2:</div>
                          <input
                            ref={ffAddr2Ref}
                            style={styles.inlinePopupInputFlex as any}
                            value={ffAddr2}
                            onChange={(e) => setFfAddr2(e.target.value)}
                            placeholder=""
                          />
                          <div style={styles.inlinePopupTick}>{ffAddr2.trim() ? "✓" : ""}</div>
                        </div>

                        <div style={styles.inlinePopupRow} onClick={() => ffCityRef.current?.focus()}>
                          <div style={styles.inlinePopupFieldLabel}>City / Town:</div>
                          <input
                            ref={ffCityRef}
                            style={styles.inlinePopupInputFlex as any}
                            value={ffCity}
                            onChange={(e) => setFfCity(e.target.value)}
                            placeholder=""
                            list="ff-city-suggestions"
                          />
                          <datalist id="ff-city-suggestions">
                            <option value="Manchester" />
                            <option value="Liverpool" />
                            <option value="Birmingham" />
                            <option value="Leeds" />
                            <option value="Sheffield" />
                            <option value="London" />
                          </datalist>
                          <div style={styles.inlinePopupTick}>{ffCity.trim() ? "✓" : ""}</div>
                        </div>

                        <div style={styles.inlinePopupRow}>
                          <div style={styles.inlinePopupFieldLabel}>County:</div>
                          <select
                            style={styles.inlinePopupSelectFlex as any}
                            value={ffCounty}
                            onChange={(e) => setFfCounty(e.target.value)}
                          >
                            <option value="">Select…</option>
                            <option value="Greater Manchester">Greater Manchester</option>
                            <option value="Cheshire">Cheshire</option>
                            <option value="Lancashire">Lancashire</option>
                            <option value="Merseyside">Merseyside</option>
                            <option value="West Midlands">West Midlands</option>
                            <option value="Warwickshire">Warwickshire</option>
                            <option value="West Yorkshire">West Yorkshire</option>
                            <option value="South Yorkshire">South Yorkshire</option>
                            <option value="Kent">Kent</option>
                            <option value="Essex">Essex</option>
                            <option value="Other">Other</option>
                          </select>
                          <div style={styles.inlinePopupTick}>{ffCounty.trim() ? "✓" : ""}</div>
                        </div>
                      </div>
                    ) : null}

<div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                      <div style={styles.inlinePopupRow} onClick={() => ffYearsRef.current?.focus()}>
                        <div style={styles.inlinePopupFieldLabel}>Years at address:</div>
                        <input
                          ref={ffYearsRef}
                          style={styles.inlinePopupInputSmall as any}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={ffAddrYears}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9]/g, "");
                            setFfAddrYears(v);
                          }}
                          placeholder=""
                        />
                        <div style={styles.inlinePopupTick}>{ffAddrYears.trim() ? "✓" : ""}</div>
                      </div>

                      <div style={styles.inlinePopupRow} onClick={() => ffMonthsRef.current?.focus()}>
                        <div style={styles.inlinePopupFieldLabel}>Months at address:</div>
                        <input
                          ref={ffMonthsRef}
                          style={styles.inlinePopupInputSmall as any}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={11}
                          value={ffAddrMonths}
                          onChange={(e) => {
                            let v = e.target.value.replace(/[^0-9]/g, "");
                            if (v !== "" && Number(v) > 11) v = "11";
                            setFfAddrMonths(v);
                          }}
                          placeholder=""
                        />
                        <div style={styles.inlinePopupTick}>{ffAddrMonths.trim() ? "✓" : ""}</div>
                      </div>

                      <div style={styles.inlinePopupRow}>
                        <div style={styles.inlinePopupFieldLabel}>Residential status:</div></div>
                        <select
                          style={styles.inlinePopupSelectFlex as any}
                          value={ffResStatus}
                          onChange={(e) => setFfResStatus(e.target.value)}
                        >
                          <option value="">Select…</option>
                          <option value="Private Tenant">Private Tenant</option>
                          <option value="Council Tenant">Council Tenant</option>
                          <option value="Homeowner">Homeowner</option>
                          <option value="Housing Association">Housing Association</option>
                          <option value="Living with Family">Living with Family</option>
                        </select>
                        <div style={styles.inlinePopupTick}>{ffResStatus.trim() ? "✓" : ""}</div>
                      </div>
                    </div>

                    {ffError ? <div style={{ marginTop: 10, color: "#b91c1c", fontWeight: 700 }}>{ffError}</div> : null}

                    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={styles.inlinePopupBtnPrimary as any}
                        onClick={submitFactFind}
                        disabled={ffSaving || !canSubmitFactFind}
                        aria-disabled={ffSaving || !canSubmitFactFind}
                        title={!canSubmitFactFind ? "Complete all fields to continue" : ""}
                      >
                        {ffSaving ? "Saving..." : canSubmitFactFind ? "Submit & continue" : "🔒 Submit & continue"}
                      </button>
                      <button
                        type="button"
                        style={styles.inlinePopupBtn as any}
                        onClick={() => {
                          setShowFactFind(false);
                          setFfError(null);
                        }}
                        disabled={ffSaving}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : showAddress ? (

                  <div style={{ marginBottom: showIe ? 16 : 0 }}>
                    <div style={styles.inlinePopupTitle}>Address details</div>
                    <div style={styles.inlinePopupText}>Enter your postcode and pick your address. This will be saved to your file.</div>

                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      <input
                        style={styles.inlinePopupInput as any}
                        value={postcode}
                        onChange={(e) => setPostcode(e.target.value)}
                        placeholder="Postcode (e.g. M1 1AA)"
                      />
                      <button
                        type="button"
                        style={styles.inlinePopupBtn as any}
                        onClick={() => {
                          setActivePostcodeContext("address");
                          lookupPostcode();
                        }}
                        disabled={postcodeLoading || !postcode.trim()}
                      >
                        {postcodeLoading ? "Searching..." : "Search"}
                      </button>
                    </div>

                    {postcodeResults.length ? (
                      <div style={{ marginTop: 10 }}>
                        <div style={styles.inlinePopupLabel}>Select your address:</div>
                        <div style={styles.inlinePopupList}>
                          {postcodeResults.slice(0, 8).map((a, idx) => (
                            <button
                              key={idx}
                              type="button"
                              style={styles.inlinePopupListItem as any}
                              onClick={() => setSelectedAddress(a)}
                            >
                              {a}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {selectedAddress ? (
                      <div style={{ marginTop: 10 }}>
                        <div style={styles.inlinePopupLabel}>Selected:</div>
                        <div style={styles.inlinePopupSelected}>{selectedAddress}</div>
                        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            style={styles.inlinePopupBtnPrimary as any}
                            onClick={() => { saveAddressHistory(); setShowAddress(false); }}
                          >
                            Save to your file
                          </button>
                          <button
                            type="button"
                            style={styles.inlinePopupBtn as any}
                            onClick={() => { setSelectedAddress(""); setPostcodeResults([]); }}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Income & Expenditure can still use the existing UI below (or legacy modal if enabled) */}
              </div>
            </div>
          ) : null}

          <div ref={bottomRef} />
        </div>

        <div style={styles.footer}>
          <input
            style={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            placeholder="Type your message..."
          />
          <button style={styles.btn} onClick={handleSubmit}>
            Send
          </button>
        </div>
      </div>

      {/* ======= Portal ======= */}
      {showPortal ? (
        <div style={{ width: 760, margin: "12px auto 0", ...styles.card }}>
          <div style={styles.modalHeader}>
            <div style={{ fontWeight: 800 }}>Client Portal</div>
            <div style={styles.small}>{loggedEmail ? loggedEmail : "Not logged in"}</div>
          </div>

          <div style={{ padding: 16 }}>
            {!loggedEmail ? (
              <div>
                <div style={styles.tabs}>
                  <button style={tabStyle(portalMode === "login")} onClick={() => setPortalMode("login")}>
                    Login
                  </button>
                  <button style={tabStyle(portalMode === "register")} onClick={() => setPortalMode("register")}>
                    Register
                  </button>
                  <button style={tabStyle(portalMode === "reset")} onClick={() => setPortalMode("reset")}>
                    Reset
                  </button>
                </div>

                <div style={styles.field}>
                  <div style={styles.label}>Email</div>
                  <input style={styles.text} value={portalEmail} onChange={(e) => setPortalEmail(e.target.value)} />
                </div>

                {portalMode !== "reset" ? (
                  <div style={styles.field}>
                    <div style={styles.label}>Password</div>
                    <input
                      style={styles.text}
                      type="password"
                      value={portalPass}
                      onChange={(e) => setPortalPass(e.target.value)}
                    />
                  </div>
                ) : null}

                {portalMode === "register" ? (
                  <div style={styles.field}>
                    <div style={styles.label}>Confirm Password</div>
                    <input
                      style={styles.text}
                      type="password"
                      value={portalPass2}
                      onChange={(e) => setPortalPass2(e.target.value)}
                    />
                  </div>
                ) : null}

                {notice ? <div style={{ marginTop: 8, fontSize: 12, color: "#10b981" }}>{notice}</div> : null}
                {portalError ? <div style={{ marginTop: 8, fontSize: 12, color: "#ef4444" }}>{portalError}</div> : null}

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button style={styles.btn} onClick={onAuthAction} disabled={portalLoading}>
                    {portalLoading
                      ? "Please wait..."
                      : portalMode === "reset"
                      ? "Send reset"
                      : portalMode === "register"
                      ? "Create account"
                      : "Login"}
                  </button>
                  <button style={styles.btn} onClick={() => setShowAuth(true)}>
                    Open Auth Modal
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button style={styles.btn} onClick={loadDocs} disabled={docsLoading}>
                    {docsLoading ? "Loading..." : "Refresh Docs"}
                  </button>
                  <button style={styles.btn} onClick={() => setLoggedEmail(undefined)}>
                    Logout
                  </button>
                </div>

                {docsError ? <div style={{ marginTop: 10, fontSize: 12, color: "#ef4444" }}>{docsError}</div> : null}

                <div style={styles.docsList}>
                  {(docs || []).map((d) => (
                    <div key={d.id} style={styles.docRow}>
                      <div style={{ display: "grid", gap: 4 }}>
                        <div style={{ fontWeight: 700 }}>{prettyFilename(d.filename)}</div>
                        <div style={styles.small}>
                          {d.category || "Document"} {d.uploadedAt ? `• ${d.uploadedAt}` : ""}
                        </div>
                      </div>
                      <a href={d.url} target="_blank" rel="noreferrer" style={styles.link}>
                        Open
                      </a>
                    </div>
                  ))}
                  {!docs?.length && !docsLoading ? <div style={{ opacity: 0.8, fontSize: 12 }}>No documents yet.</div> : null}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* ======= Auth Modal ======= */}
      {showAuth ? (
        <div style={styles.modalOverlay} onClick={() => setShowAuth(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={{ fontWeight: 800 }}>Portal Access</div>
              <button style={styles.btn} onClick={() => setShowAuth(false)}>
                Close
              </button>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.tabs}>
                <button style={tabStyle(portalMode === "login")} onClick={() => setPortalMode("login")}>
                  Login
                </button>
                <button style={tabStyle(portalMode === "register")} onClick={() => setPortalMode("register")}>
                  Register
                </button>
                <button style={tabStyle(portalMode === "reset")} onClick={() => setPortalMode("reset")}>
                  Reset
                </button>
              </div>

              <div style={styles.field}>
                <div style={styles.label}>Email</div>
                <input style={styles.text} value={portalEmail} onChange={(e) => setPortalEmail(e.target.value)} />
              </div>

              {portalMode !== "reset" ? (
                <div style={styles.field}>
                  <div style={styles.label}>Password</div>
                  <input
                    style={styles.text}
                    type="password"
                    value={portalPass}
                    onChange={(e) => setPortalPass(e.target.value)}
                  />
                </div>
              ) : null}

              {portalMode === "register" ? (
                <div style={styles.field}>
                  <div style={styles.label}>Confirm Password</div>
                  <input
                    style={styles.text}
                    type="password"
                    value={portalPass2}
                    onChange={(e) => setPortalPass2(e.target.value)}
                  />
                </div>
              ) : null}

              {notice ? <div style={{ marginTop: 8, fontSize: 12, color: "#10b981" }}>{notice}</div> : null}
              {portalError ? <div style={{ marginTop: 8, fontSize: 12, color: "#ef4444" }}>{portalError}</div> : null}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button style={styles.btn} onClick={onAuthAction} disabled={portalLoading}>
                  {portalLoading
                    ? "Please wait..."
                    : portalMode === "reset"
                    ? "Send reset"
                    : portalMode === "register"
                    ? "Create account"
                    : "Login"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ======= Income & Expense popup ======= */}
      {showIe ? (
        <div style={styles.modalOverlay} onClick={() => setShowIe(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={{ fontWeight: 800 }}>Income & Expenditure</div>
              <button style={styles.btn} onClick={() => setShowIe(false)}>
                Close
              </button>
            </div>
            <div style={styles.modalBody}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>Income</div>
              {ieIncome.map((row, idx) => (
                <div key={idx} style={styles.row2}>
                  <input
                    style={styles.text}
                    value={row.source}
                    onChange={(e) => {
                      const v = e.target.value;
                      setIeIncome((prev) => prev.map((r, i) => (i === idx ? { ...r, source: v } : r)));
                    }}
                    placeholder="Source"
                  />
                  <input
                    style={styles.text}
                    value={row.amount}
                    type="number"
                    onChange={(e) => {
                      const v = Number(e.target.value || 0);
                      setIeIncome((prev) => prev.map((r, i) => (i === idx ? { ...r, amount: v } : r)));
                    }}
                    placeholder="Amount"
                  />
                </div>
              ))}
              <button style={{ ...styles.btn, marginTop: 8 }} onClick={() => setIeIncome((prev) => [...prev, { source: "", amount: 0 }])}>
                + Add income
              </button>

              <div style={styles.divider} />

              <div style={{ fontWeight: 800, marginBottom: 8 }}>Expenditure</div>
              {ieExpense.map((row, idx) => (
                <div key={idx} style={styles.row2}>
                  <input
                    style={styles.text}
                    value={row.item}
                    onChange={(e) => {
                      const v = e.target.value;
                      setIeExpense((prev) => prev.map((r, i) => (i === idx ? { ...r, item: v } : r)));
                    }}
                    placeholder="Item"
                  />
                  <input
                    style={styles.text}
                    value={row.amount}
                    type="number"
                    onChange={(e) => {
                      const v = Number(e.target.value || 0);
                      setIeExpense((prev) => prev.map((r, i) => (i === idx ? { ...r, amount: v } : r)));
                    }}
                    placeholder="Amount"
                  />
                </div>
              ))}
              <button style={{ ...styles.btn, marginTop: 8 }} onClick={() => setIeExpense((prev) => [...prev, { item: "", amount: 0 }])}>
                + Add expense
              </button>

              {ieError ? <div style={{ marginTop: 10, fontSize: 12, color: "#ef4444" }}>{ieError}</div> : null}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button style={styles.btn} onClick={saveIncomeExpense} disabled={ieSaving}>
                  {ieSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>

      <style jsx global>{`
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus,
        textarea:-webkit-autofill,
        select:-webkit-autofill {
          -webkit-text-fill-color: #111827 !important;
          box-shadow: 0 0 0px 1000px #e5e7eb inset !important;
          transition: background-color 9999s ease-in-out 0s;
        }
      `}</style>

    </>
  );
}