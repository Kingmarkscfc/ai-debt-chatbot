import type { NextApiRequest, NextApiResponse } from "next";
import { scripts, Lang } from "@/utils/i18n";

const HUMOUR = {
  en: [
    "That’s a plot twist I didn’t see coming… but let’s stick to your debts, yeah?",
    "I’m flattered — but let’s focus on getting you debt-free.",
    "If the aliens return your payslip, upload it — meanwhile, let’s keep going.",
  ],
  es: [
    "Vaya giro… pero volvamos a tus deudas, ¿sí?",
    "Me halaga, pero enfoquémonos en dejarte sin deudas.",
    "Si los alienígenas devuelven tu nómina, súbela; seguimos mientras tanto.",
  ],
  fr: [
    "Surprenant… mais revenons à vos dettes, d’accord ?",
    "Flatté, mais concentrons-nous sur l’objectif : vous libérer des dettes.",
    "Si les aliens rendent votre fiche de paie, envoyez-la — on continue.",
  ],
};

type Session = { idx: number; lang: Lang };
const sessions = new Map<string, Session>();

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const { message, sessionId: raw, init, lang } = req.body || {};
  const sessionId: string = typeof raw === "string" && raw ? raw : Math.random().toString(36).slice(2);
  const langSafe: Lang = (["en","es","fr"].includes(lang) ? lang : "en") as Lang;

  // start / re-init
  if (init || !sessions.has(sessionId)) {
    sessions.set(sessionId, { idx: 0, lang: langSafe });
    return res.status(200).json({ reply: scripts[langSafe].steps[0].prompt, sessionId });
  }

  const s = sessions.get(sessionId)!;
  if (lang && s.lang !== lang) s.lang = langSafe; // allow language switch mid-session

  const steps = scripts[s.lang].steps;
  const userText: string = (message || "").toString().trim();
  if (!userText) return res.status(200).json({ reply: steps[s.idx].prompt, sessionId });

  const kws = (steps[s.idx].keywords || []).map((k) => k.toLowerCase());
  const matched = kws.length === 0 || kws.some((k) => userText.toLowerCase().includes(k));

  if (matched) {
    s.idx = Math.min(s.idx + 1, steps.length - 1);
    sessions.set(sessionId, s);
    return res.status(200).json({ reply: steps[s.idx].prompt, sessionId });
  } else {
    const h = HUMOUR[s.lang];
    return res.status(200).json({ reply: h[Math.floor(Math.random() * h.length)], sessionId });
  }
}
