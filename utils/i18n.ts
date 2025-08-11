export type Lang = "en" | "es" | "fr";

export const ui = {
  title: { en: "Debt Advisor", es: "Asesor de Deudas", fr: "Conseiller en Dettes" },
  prompt: { en: "Type your message…", es: "Escribe tu mensaje…", fr: "Écrivez votre message…" },
  send: { en: "Send", es: "Enviar", fr: "Envoyer" },
  dark: { en: "Dark", es: "Oscuro", fr: "Sombre" },
  light: { en: "Light", es: "Claro", fr: "Clair" },
  language: { en: "Language", es: "Idioma", fr: "Langue" },
  uploadLabel: { en: "Upload documents (PDF/JPG/PNG)", es: "Subir documentos (PDF/JPG/PNG)", fr: "Télécharger des documents (PDF/JPG/PNG)" },
  uploading: { en: "Uploading…", es: "Subiendo…", fr: "Téléversement…" },
};

export const scripts: Record<Lang, { steps: { prompt: string; keywords?: string[] }[] }> = {
  en: {
    steps: [
      { prompt: "Hello! My name’s Mark. What prompted you to seek help with your debts today?",
        keywords: ["debt","help","struggling","credit","loan","arrears","card","bailiff","bills","money","council","tax","rent"] },
      { prompt: "Thanks for sharing. Roughly how much do you owe in total across all debts?",
        keywords: ["£","k","000","thousand","hundred","owe","balance","amount","ten","five"] },
      { prompt: "Is this with at least two different unsecured creditors (like credit cards or loans)?",
        keywords: ["yes","y","2","two","3","three","multiple","many"] },
      { prompt: "Are any debts joint or guaranteed with someone else?",
        keywords: ["yes","no","none","partner","joint","guarantor"] },
      { prompt: "Thanks. Options include Self-help, Loan Consolidation, DRO, Bankruptcy, DMP, and IVA. I’ll explain IVA/DMP and outline alternatives for fairness. Shall we continue?",
        keywords: ["yes","ok","continue","go on","next","proceed"] },
      { prompt: "Great. We’ll prepare your proposal. Next I’ll need income, expenses, and creditor details. Ready to upload payslips/ID and list creditors now?",
        keywords: ["yes","ok","ready","upload"] },
    ],
  },
  es: {
    steps: [
      { prompt: "¡Hola! Soy Mark. ¿Qué te llevó a buscar ayuda con tus deudas hoy?",
        keywords: ["deuda","ayuda","problemas","tarjeta","préstamo","atrasos","dinero"] },
      { prompt: "Gracias. Aproximadamente, ¿cuánto debes en total?",
        keywords: ["€","mil","cien","debo","cantidad"] },
      { prompt: "¿Es con al menos dos acreedores no garantizados (tarjetas o préstamos)?",
        keywords: ["sí","si","2","dos","3","tres","varios"] },
      { prompt: "¿Alguna deuda conjunta o con avalista?",
        keywords: ["sí","no","pareja","conjunto","aval"] },
      { prompt: "Opciones: Auto-gestión, Consolidación, DRO, Bancarrota, DMP e IVA. Puedo explicar IVA/DMP y las alternativas. ¿Continuamos?",
        keywords: ["sí","si","ok","continuar","sigue"] },
      { prompt: "Perfecto. Prepararé la propuesta. Necesito ingresos, gastos y acreedores. ¿Listo para subir nóminas/ID y listar acreedores?",
        keywords: ["sí","si","listo","subir"] },
    ],
  },
  fr: {
    steps: [
      { prompt: "Bonjour ! Je m’appelle Mark. Qu’est-ce qui vous amène à demander de l’aide aujourd’hui ?",
        keywords: ["dette","aide","problèmes","carte","prêt","arriérés","argent"] },
      { prompt: "Merci. Environ, quel est le montant total que vous devez ?",
        keywords: ["€","mille","cent","dois","montant"] },
      { prompt: "Est-ce auprès d’au moins deux créanciers non garantis (cartes ou prêts) ?",
        keywords: ["oui","2","deux","3","trois","plusieurs"] },
      { prompt: "Des dettes conjointes ou avec garant ?",
        keywords: ["oui","non","conjoint","garant"] },
      { prompt: "Options : Auto-gestion, Consolidation, DRO, Faillite, DMP et IVA. Je peux expliquer IVA/DMP et les alternatives. On continue ?",
        keywords: ["oui","ok","continuer","suivant"] },
      { prompt: "Parfait. Je prépare votre dossier. J’aurai besoin de revenus, dépenses et créanciers. Prêt à téléverser fiches de paie/ID et lister les créanciers ?",
        keywords: ["oui","ok","prêt","téléverser"] },
    ],
  },
};
