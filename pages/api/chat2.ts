import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import { supabaseAdmin } from "../../utils/supabaseAdmin";

type Role = "user" | "assistant";

type StepDef = {
  id?: number;
  name?: string;
  expects?: string; // "name" | "concern" | "amounts" | etc
  prompt: string;
  keywords?: string[];
};

type ScriptDef = {
  steps: StepDef[];
};

type FaqItem = {
  q: string;
  a: string;
  tags?: string[];
};

type ChatState = {
  step: number; // IMPORTANT: this is the step INDEX (0..n-1), not the StepDef.id
  name?: string | null;
  concern?: string | null; // what prompted them / overall concern
  issue?: string | null; // main issue with the debts
  paying?: number | null;
  affordable?: number | null;
  urgent?: string | null;

  profile?: any;
  // loop guards
  askedNameTries?: number;
  lastPromptKey?: string; // dedupe key of last bot prompt
  lastStepPrompted?: number;
};

type ApiReqBody = {
  sessionId?: string;
  message?: string;
  userMessage?: string;
  history?: string[] | { role: Role; content: string }[];
  language?: string;
  state?: ChatState;
};

type ApiResp = {
  reply: string;
  state: ChatState;

  // UI hints for the frontend (safe: ignored if not implemented)
  uiTrigger?: string; // e.g. "OPEN_CLIENT_PORTAL" / "OPEN_FACT_FIND_POPUP"
  popup?: string; // e.g. "FACT_FIND_CLIENT_INFORMATION" / "DEBT_SLIDER" / "AFFORDABLE_SLIDER"
  portalTab?: string; // e.g. "TAB_2_OUTSTANDING_DEBTS"
  openPortal?: boolean; // legacy flag used by some UIs
  displayName?: string;
};

function readJsonSafe<T>(p: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(p, "utf8");
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Some project files may accidentally include wrapper text (e.g. bash heredocs).
      // Try to recover by extracting the first JSON object/array we can find.
      const trimmed = raw.trim();
      const firstObj = trimmed.indexOf("{");
      const lastObj = trimmed.lastIndexOf("}");
      if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
        return JSON.parse(trimmed.slice(firstObj, lastObj + 1)) as T;
      }
      const firstArr = trimmed.indexOf("[");
      const lastArr = trimmed.lastIndexOf("]");
      if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
        return JSON.parse(trimmed.slice(firstArr, lastArr + 1)) as T;
      }
      throw new Error("Unparseable JSON");
    }
  } catch {
    return fallback;
  }
}

function getLocalTimeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function nowTimeStr() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function normalise(s: string) {
  return (s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stripPunctuation(s: string) {
  return s.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
}

function titleCaseName(s: string) {
  const cleaned = stripPunctuation(s);
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Words we never want to treat as a name */
const NAME_BLOCKLIST = new Set(
  [
    "yes",
    "yeah",
    "yep",
    "ok",
    "okay",
    "sure",
    "alright",
    "right",
    "no",
    "nah",
    "hello",
    "hi",
    "hey",
    "good",
    "morning",
    "afternoon",
    "evening",
    "thanks",
    "thank you",
    "please",
    "mate",
    "pal",
    "bro",
    "bruv",
    "sir",
    "madam",
    "mr",
    "mrs",
    "ms",
    "miss",
    "i",
    "im",
    "i'm",
    "me",
    "my",
    "mine",
    "so",
    "and",
    "or",
    "but",
    "because",
    "well",
    "just",
    "like",
    "basically",
    "how",
    "what",
    "why",
    "reset",
    "you",
    "are",
    "your",
    "today",
    "doing",
    "was",
    "were",
    "been",
    "being",
  ].map((x) => x.toLowerCase())
);

/**
 * Expanded profanity list (used only for name parsing / abusive slurs as "names").
 * This does NOT block normal debt messages; it just stops "names" like swearwords.
 */
const PROFANITY = [
  "arse",
  "arsehead",
  "arsehole",
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "bloody",
  "bollocks",
  "brotherfucker",
  "bugger",
  "bullshit",
  "child-fucker",
  "cock",
  "cocksucker",
  "crap",
  "cunt",
  "dammit",
  "damn",
  "damned",
  "dick",
  "dick-head",
  "dickhead",
  "dumb-ass",
  "dumbass",
  "dyke",
  "fag",
  "faggot",
  "father-fucker",
  "fuck",
  "fucker",
  "fucking",
  "goddammit",
  "goddamn",
  "goddamned",
  "goddamnmotherfucker",
  "horseshit",
  "kike",
  "motherfucker",
  "nigga",
  "nigger",
  "pigfucker",
  "piss",
  "prick",
  "pussy",
  "shit",
  "shit ass",
  "shite",
  "sisterfucker",
  "slut",
  "son of a bitch",
  "turd",
  "twat",
  "wank",
  "wanker",
  "whore",
  "fucked",
  "fuck off",
  "goddamnit",
  "godsdamn",
  "jack-ass",
  "jackass",
  "mother-fucker",
  "nigra",
  "sisterfuck",
  "spastic",
  "Shit cunt",
  "tranny",
];

function containsProfanity(s: string) {
  const t = normalise(s);
  return PROFANITY.some((w) => w && t.includes(w));
}

/** Acknowledgement-only messages should NOT advance any step. */
function isAckOnly(userText: string) {
  const t = normalise(userText);
  if (!t) return true;
  const acks = new Set([
    "ok",
    "okay",
    "kk",
    "alright",
    "right",
    "cool",
    "nice",
    "thanks",
    "thank you",
    "cheers",
    "yep",
    "yeah",
    "yes",
    "no worries",
    "got it",
    "fine",
    "great",
  ]);
  return acks.has(t);
}

function looksLikeGreetingOrSmallTalk(s: string) {
  const t = normalise(s);

  if (
    t === "hello" ||
    t === "hi" ||
    t === "hey" ||
    t.startsWith("hello ") ||
    t.startsWith("hi ") ||
    t.startsWith("hey ")
  )
    return true;

  if (t.includes("good morning") || t.includes("good afternoon") || t.includes("good evening")) return true;

  if (t.includes("how are you") || t.includes("how r you") || t.includes("how are u")) return true;

  if (t.includes("what is the time") || t === "what time is it" || t.startsWith("what time")) return true;

  if (t.includes("tell me a joke") || t === "joke" || t.includes("make me laugh")) return true;

  // courtesy / niceties that should be acknowledged
  if (t.includes("nice to meet you") || t.includes("pleased to meet you") || t.includes("good to meet you")) return true;

  return false;
}

function detectCourtesy(userText: string): string | null {
  const t = normalise(userText);
  if (
    t.includes("nice to meet you") ||
    t.includes("pleased to meet you") ||
    t.includes("good to meet you") ||
    t.includes("lovely to meet you")
  ) {
    return "Nice to meet you too.";
  }
  return null;
}

/**
 * IMPORTANT: small talk reply should NOT ask the user questions.
 * We answer briefly, then the handler appends the current scripted prompt.
 */
function smallTalkReply(userText: string) {
  const t = normalise(userText);
  const greeting = getLocalTimeGreeting();
  const courtesy = detectCourtesy(userText);

  if (t.includes("what is the time") || t === "what time is it" || t.startsWith("what time")) {
    const base = `It’s ${nowTimeStr()} right now.`;
    return courtesy ? `${courtesy} ${base}` : base;
  }

  if (t.includes("tell me a joke") || t === "joke" || t.includes("make me laugh")) {
    const base = `Okay — quick one: Why did the scarecrow get promoted? Because he was outstanding in his field.`;
    return courtesy ? `${courtesy} ${base}` : base;
  }

  if (t.includes("how are you") || t.includes("how r you") || t.includes("how are u")) {
    const base = `${greeting}! I’m doing well, thanks for asking.`;
    return courtesy ? `${base} ${courtesy}` : base;
  }

  if (t.includes("good morning") || t.includes("good afternoon") || t.includes("good evening")) {
    const base = `${greeting}!`;
    return courtesy ? `${base} ${courtesy}` : base;
  }

  if (
    t === "hello" ||
    t === "hi" ||
    t === "hey" ||
    t.startsWith("hello ") ||
    t.startsWith("hi ") ||
    t.startsWith("hey ")
  ) {
    const base = `${greeting}!`;
    return courtesy ? `${base} ${courtesy}` : base;
  }

  if (courtesy) return `${greeting}! ${courtesy}`;

  return null;
}

function looksLikeOffTopicQuestion(userText: string) {
  const t = normalise(userText);
  if (!t) return false;

  // obvious "what are you doing" / "who are you" style interruptions
  if (
    t === "what are you doing" ||
    t.startsWith("what are you doing") ||
    t === "what are you" ||
    t.startsWith("what are you ") ||
    t === "who are you" ||
    t.startsWith("who are you") ||
    t === "what can you do" ||
    t.startsWith("what can you do") ||
    t === "are you real" ||
    t.startsWith("are you real") ||
    t.includes("are you a bot") ||
    t.includes("are you human") ||
    t.includes("what is this") ||
    t.startsWith("what is this")
  ) return true;

  // general question marks (but don't steal actual debt questions)
  if (t.includes("?")) return true;

  return false;
}

function offTopicReply(userText: string, state: ChatState) {
  const t = normalise(userText);
  const greeting = getLocalTimeGreeting();
  const courtesy = detectCourtesy(userText);
  const name = state.name && state.name !== "there" ? state.name : null;

  // Keep these sharp and decisive; no follow-up questions here.
  let base: string | null = null;

  if (t.includes("what are you doing") || t === "what are you doing") {
    base = name
      ? `I’m here to help you work out the best way forward with your debts, ${name}.`
      : "I’m here to help you work out the best way forward with your debts.";
  } else if (t.includes("who are you") || t.includes("what are you")) {
    base = "I’m your debt-advice assistant. I’ll ask a few quick questions so we can work out the best options for you.";
  } else if (t.includes("what can you do") || t.includes("help")) {
    base = "I can explain your options, help you organise the situation, and guide you through the next steps based on what you tell me.";
  } else if (t.includes("are you real") || t.includes("are you a bot") || t.includes("are you human")) {
    base = "I’m an online assistant, but I’m here to help in a clear, practical way and keep things simple.";
  } else if (t.includes("what is this")) {
    base = "This is a quick debt help chat. I’ll ask a couple of questions and then explain the options available.";
  } else if (t.includes("?")) {
    base = "I’m here to help with your debts. If you tell me what’s going on, I’ll guide you through the next steps.";
  } else {
    return null;
  }

  // Add a friendly greeting tone if they opened with one
  const opener = looksLikeGreetingOrSmallTalk(userText) ? `${greeting}! ` : "";
  const composed = `${opener}${base}`.trim();

  return courtesy ? `${composed} ${courtesy}` : composed;
}


/** Extra debt / finance terms (from your "likely debt terms" list) */
const DEBT_TERMS_EXTRA = [
  "Accounts",
  "Accounts payable",
  "Accounts receivables",
  "Administration order",
  "Administrator",
  "Advance billing",
  "Adverse credit history",
  "Aged debt report",
  "Arrears",
  "Assignment",
  "Audit",
  "Bacs",
  "Bad debt",
  "Bad debt relief",
  "Bailiffs",
  "Bailiff’s certificate",
  "Balance sheet",
  "Bankruptcy",
  "Business health check",
  "Business restructuring or turnaround",
  "Cash flow",
  "Certificate of satisfaction",
  "Charge for payment",
  "Company registration number",
  "Company Voluntary Arrangement",
  "CVA",
  "Compulsory liquidation",
  "Concentration",
  "Consolidation",
  "Consolidating",
  "Consumer Credit Act 1974",
  "Contractual payments",
  "County Court Judgment",
  "CCJ",
  "CCJs",
  "CCJ’s",
  "Court claim form",
  "Credit control",
  "Credit insurance",
  "Credit management",
  "Credit period",
  "Credit rating",
  "Credit reference agency",
  "Credit reports",
  "Credit terms",
  "Creditor",
  "Creditors Voluntary Liquidation",
  "CVL",
  "Creditworthiness",
  "Day Sales Outstanding",
  "DSO",
  "Debt’s",
  "Debt Consolidation",
  "Debt collection agency",
  "Debt relief order",
  "Debt restructuring",
  "Debtor",
  "Debtor book",
  "Debtor days",
  "Default",
  "Defaults",
  "Default notice",
  "Direct debit",
  "Dispute",
  "Factoring",
  "Financial Conduct Authority",
  "FCA",
  "Forward dating",
  "Fraud",
  "Guarantees",
  "Her Majesty’s Revenue & Customs",
  "HMRC",
  "Informal arrangement",
  "Initial writ",
  "Insolvency",
  "Insolvency Act 1986",
  "Insolvency Practitioner",
  "IP",
  "IPS",
  "Insolvency Rules",
  "Insolvent",
  "Interest rate",
  "Interim order",
  "Invoice",
  "Invoice discounting",
  "Invoice finance",
  "Late Payments",
  "Letter before action",
  "Liquidation",
  "Liquidator",
  "Nominee",
  "Non-recourse facility",
  "Office of Fair Trading",
  "OFT",
  "Order-to-collections process",
  "Preferential creditor",
  "Proof of debt",
  "Proof of delivery",
  "Protracted default",
  "Proxy",
  "Proxyholder",
  "Receiver",
  "Receivership",
  "Sales ledger",
  "Secured creditor",
  "Set aside judgment",
  "Small claims",
  "Statutory demand",
  "Summary cause",
  "Summons",
  "Supervisor",
  "Token payments",
  "Unsecured creditor",
  "Winding-up",
  "Winding-up petition",
  "Working capital",
  "Year-end accounts",
  "Debt",
  "Principal",
  "Interest",
  "Balance",
  "Liability",
  "Collateral",
  "Obligation",
  "Indebtedness",
  "Note",
  "Bond",
  "Lien",
  "Bill",
  "Due",
  "Owing",
  "Debit",
  "Overdraft",
  "Deficit",
  "Encumbrance",
  "Charge",
  "Statement",
  "Commitment",
  "Duty",
  "IOU",
  "Promissory Note",
  "Mortgage",
  "Credit Card",
  "Student Loan",
  "Auto Loan",
  "Personal Loan",
  "Payday Loan",
  "Medical Debt",
  "HELOC",
  "Store Card",
  "Home Equity Loan",
  "Catalogue Debt",
  "Council Tax Arrears",
  "Utility Bill Debt",
  "Rent Arrears",
  "Tax Lien",
  "Joint Debt",
  "Logbook Loan",
  "Car Finance",
  "Buy Now Pay Later",
  "Gambling Debt",
  "Bridge Loan",
  "Peer-to-Peer Loan",
  "Cash Advance",
  "Private Student Loan",
  "Federal Student Loan",
  "Second Mortgage",
  "Overdue Fine",
  "Court Fine",
  "Judgment Debt",
  "Consumer Debt",
  "Garnishment",
  "Repossession",
  "Foreclosure",
  "Judgment",
  "Decree",
  "Diligence",
  "Charging Order",
  "Liability Order",
  "Warrant of Execution",
  "Statute of Limitations",
  "Bailiff",
  "Amortization",
  "Accrual",
  "Write-off",
  "Charge-off",
  "Delinquency",
  "Secured Debt",
  "Unsecured Debt",
  "Revolving Debt",
  "Instalment Debt",
  "Floating Charge",
  "Hypothecation",
  "Pari-passu",
  "Subordinated Debt",
  "Mezzanine Debt",
  "Maturity",
  "Debenture",
  "Senior Debt",
  "Junior Debt",
  "Non-recourse Debt",
  "Guarantor",
  "Co-signer",
  "Indenture",
  "Escrow",
  "Title",
  "Equity",
  "Water",
  "Water Arrears",
  "Council tax",
  "Gas",
  "Gas arrears",
  "Electric arrears",
  "Mobile phone bill",
  "Mobile Phone arrears",
  "Vet Bill",
  "Vet Bills",
  "Dentist arrears",
  "Dentist",
  "Fines",
  "Azzurro Associates Limited",
  "Baker Tilly",
  "Bamboo",
  "Ballymena Credit Union",
  "Bamboo Finance",
  "Barbon Insurance Group",
  "BDO",
  "Believe Housing",
  "Better Borrow",
  "Beyond Housing",
  "Billings finance",
  "Blue Motor Finance",
  "Blue Square",
  "Blues and Twos credit union",
  "BMW",
  "Boom Credit Union ALSO West Sussex Credit Union",
  "BPO Collections",
  "Brachers LLP",
  "Bradford District Credit Union",
  "Brighthouse",
  "Bristol & wessex water",
  "BRISTOL CREDIT UNION LIMITED (I)",
  "BT",
  "Buchanan Clark & Wells",
  "Buddy Loans t/a Advancis Ltd",
  "Bulb Energy (NOW OCTOPUS)",
  "Business Finance Solutions",
  "Buy as You View",
  "BW Legal",
  "C.A.R.S",
  "Calderdale Credit Union",
  "CAMBRIAN credit union",
  "Cambridge Water",
  "CAPITAL ON TAP (NEW WAVE)",
  "Cardiff & Vale Credit Union, Cardiff and Vale",
  "CARDIFF CREDIT UNION(I)",
  "Carlisle Credit Union",
  "Carnegie Consumer Finance Limited",
  "Cash Converters",
  "Cash Euro Net",
  "Cash Generator",
  "Cash Genie",
  "Castle Community Bank",
  "Coal Island Credit Union",
  "Cater Allen",
  "CCS Collect",
  "Cheque Centres Limited",
  "Chestergates Veterinary LTD",
  "Child Support Agency",
  "Citysave Credit Union Ltd",
  "CL Finance Limited",
  "Claims Advisory Group",
  "Clever Money (Blackpool, Fylde & Wyre Credit Union Ltd)",
  "Clockwise Credit Union",
  "Clonard Credit Union",
  "Close Brothers",
  "CLS Finance",
  "Commsave Credit Union",
  "Connaught Collections",
  "Co-op Credit Union",
  "Creditstar UK Limited",
  "Curvissa",
  "Dacorum Credit Union",
  "Danske Bank",
  "Darlington Credit Union",
  "Derry Credit Union",
  "Drafty.co.uk",
  "DRAGON SAVERS CREDIT UNION",
  "Dromara & Drumgooland Credit Union",
  "DWP",
  "East Sussex Credit Union",
  "EDF Energy",
  "EE Insolvency Team",
  "Elevate Credit International (Sunny)",
  "Elfin Market",
  "Engage Credit",
  "Enterprise Credit Union",
  "Business Enterprise Fund",
  "Erewash Credit Union",
  "Essex and Suffolk Water",
  "Etika Finance",
  "West Suffolk Council",
  "Everyday Loans",
  "E.ON",
  "Express Gifts",
  "Express Solicitors",
  "Every Day Loans",
  "Fair for you Enterprise",
  "Family Finance",
  "Fairshare Credit Union",
  "FCE Bank PLC",
  "FGA Capital/ FCA Automotive",
  "Finance U Limited",
  "First Response Finance",
  "First Rate Credit Union",
  "Fintern limited / Abound",
  "Five Lamps Organisation",
  "Flow Energy",
  "Flo Gas",
  "Fly now pay later",
  "Fluro Loans",
  "FML Loans",
  "Funding Circle",
  "Funding Corporation",
  "Future Finance",
  "FUNERAL safe",
  "George Banco",
  "Glasgow Credit Union Limited",
  "Glasgow Housing Association",
  "Glo Loans",
  "GLENSIDE FINANCE LTD",
  "GMAC",
  "Great Western Credit Union",
  "Match the Cash t/a Guarantor My Loan (Match the Cash trading name)",
  "Guinness Partnership",
  "H&T Pawnbrokers",
  "Harp and Crown Credit Union",
  "Hastings Direct Loans",
  "Hastings Car Insurance",
  "Heliodor Mortgages is a trading name of Topaz Finance Limited",
  "Hoot credit union",
  "Hillingdon Credit Union",
  "Hitachi Capital/Credit / Novuna",
  "Hoist Finance UK",
  "HM Revenue & Customs",
  "HMRC - benefits overpayments",
  "Howden Joinery",
  "Hull University",
  "HULL & EAST YORKSHIRE CREDIT UNION (I)",
  "Ikano Finance",
  "IND",
  "Indigo Michael Ltd",
  "Instant Cash loans",
  "Insure The Box",
  "iSmart Consumer Services",
  "IWOCA / IWOKA LOANS",
  "JN Bank Limited are the same as Jamaica Bank",
  "Just Credit Union",
  "Kaleidoscope",
  "Karbon Homes",
  "Kensington Mortgages c/o Capital Recoveries",
  "Koyo Loans",
  "Knowsley Credit Union",
  "Kroo Bank",
  "La Redoute",
  "Land & Property Services",
  "Legal Aid Agency",
  "Lending Stream",
  "Lending Works",
  "Leap Utilites",
  "Lendwise",
  "Leeds City Credit Union",
  "Lewisham Credit Union",
  "Likely Loan",
  "LINK",
  "Lifestyle Loans",
  "Livelend",
  "Central Liverpool Credit Union",
  "Llanelli & District Credit Union",
  "Loans 2 Go",
  "Loans at home",
  "Loans by Mal",
  "London Capital Credit Union  / london community credit union",
  "Loughguile Credit Union",
  "London Mutual Credit Union",
  "LURGAN CREDIT UNION",
  "Max Recovery",
  "Malden Housing Authority",
  "Marsh Finance",
  "Merligen Investments",
  "Moneybarn",
  "Manchester Credit Union",
  "Moneyway",
  "Monzo",
  "Moorcroft Debt Recovery",
  "Morses Club",
  "Mortgage Express",
  "Motonovo Finance",
  "Motor Insurers Bureau",
  "Motormile Finance",
  "Mr Lender",
  "Mutual Clothing",
  "My Community Finance / Bank  (Brent Shine Credit Union)",
  "NPower",
  "Next Directory",
  "Neyber Ltd",
  "NHS CREDIT UNION (I)",
  "No1 Copperpot Credit Union",
  "Nottingham Credit Union Ltd",
  "NORTH WALES CREDIT UNION (I)",
  "Northumbrian Water",
  "NovaLoans/Cash4UNow",
  "NEFirst Credit Union",
  "O2 UK",
  "Omagh Credit Union",
  "Oakbrook Finance",
  "214",
  "One Stop Money Shop",
  "Oodle Finance",
  "Ovo Energy",
  "Octopus Energy",
  "Partners Credit Union",
  "paratusamc",
  "Payl8r (paylater)",
  "Peabody Housing",
  "Peachy.co.uk",
  "Pennine Community Credit Union",
  "Penny Post Credit Union",
  "PennyBurn Credit Union",
  "Perch Capital Limited",
  "Perfect Homes",
  "Peugeot Finance (PSA)",
  "Piggy Bank",
  "Pixie Loans",
  "Plata Loans (BAMBOO)",
  "Platform",
  "Places for People",
  "Plend",
  "Plane Saver Credit Union",
  "Police Credit Union (PCU) aka Serve and Protect",
  "Porterbrook House Ltd",
  "Portsmouth Water",
  "Powys Council",
  "PRA Group",
  "PRAC Finance",
  "Progressive Money",
  "Provident",
  "PSAF (money options)",
  "Quick Quid",
  "Reevo Money",
  "Reward Rate",
  "Ratesetter",
  "RCI Financial",
  "RIA financial services",
  "Rise Credit Card",
  "Specialist Motor Finance",
  "Safetynet",
  "Salford Credit Union",
  "Salad Money",
  "Salary Finance",
  "Santander Consumer Finance",
  "Satsuma Loans",
  "Savvy (TICK TOCK LOANS)",
  "SSE ENERGY",
  "Scottish Power",
  "Secure Trust Bank",
  "Severn Trent Water",
  "Shawbrook",
  "Shell Energy Retail Limited (NOW OCTOPUS)",
  "Shoosmiths LLP",
  "Short Term Finance",
  "Sheffield Credit Union",
  "SLL Capital",
  "Smart Credit Union",
  "Snap On Finance",
  "Snap on Tools",
  "Snap Finance",
  "South East Water",
  "South Manchester Credit Union",
  "South Staffs Water",
  "South West Water",
  "South Yorkshire Credit Union",
  "Southern Water",
  "Spark Energy",
  "Startline Motor Finance",
  "Street UK (street Credit uk)",
  "Student Loans Company",
  "Studio Cards & Gifts",
  "Stockport Credit Union",
  "Sunny Loans",
  "Swift Sterling",
  "Swinton",
  "Trust Two",
  "T Mobile (EE)",
  "Talk Talk",
  "TBI Financial Services",
  "Tesco Mobile",
  "Teachers Pension Fund",
  "TFS Loans",
  "Thames Water",
  "The Funding Corporation",
  "The Sheriffs Office",
  "Transave UK Credit Union",
  "Travis Perkins",
  "TM Advances",
  "UK Credit Ltd",
  "Updraft",
  "Unify Credit Union Limited",
  "United Utilities",
  "Unity",
  "Utility Point",
  "Utilita Energy",
  "V12 Personal Finance",
  "Voyager Alliance Credit Union",
  "Vehicle Credit Ltd",
  "Virgin Credit Card",
  "Virgin Money (Loan) WPM",
  "Virgin Media",
  "Vodafone",
  "Quickly Finance",
  "Wage Day Advance",
  "Welsh Water",
  "West Sussex and Surrey Credit Union",
  "West 28th Street Ltd",
  "WESTERN CIRCLE LTD",
  "Wessex Water",
  "Wesleyn / Wesleyan Bank",
  "Weflex",
  "Wythenshawe Community Housing Group",
  "Wonga",
  "Wilkin Chapman",
  "Wiltshire and Swindon Credit Union",
  "XS Direct",
  "Yorkshire Water",
  "Christ Church",
  "Adur & Worthing District Council",
  "Allerdale Borough Council",
  "Amber Valley Borough Council",
  "Arun District Council",
  "Ashfield Borough / District Council",
  "Ashfield Borough Council",
  "Ashford Borough Council",
  "Aylesbury Vale District Council",
  "Babergh District Council",
  "Barnet (Londong Borough of Barnet)",
  "Barnsley Borough Council",
  "Barrow-in-Furness Borough Council",
  "Basildon Borough Council",
  "Basingstoke & Deanne Borough Council",
  "Bassetlaw District Council",
  "Bath and North East Somerset",
  "Bedford Borough Council",
  "Billing Finance",
  "Birmingham City Council",
  "Blaby District Council",
  "Blackburn with Darwen Borough Council",
  "Blackpool Council",
  "Blaenau Gwent",
  "Bolsover District Council",
  "Bolton Borough Council",
  "Boston Borough Council",
  "Bournemouth + Christ Chucrch  + Poole Council (BCP)",
  "Bournemouth Borough Council",
  "Bracknell Forest Borough Council",
  "Bradford City Council / Metro. Bradford M D Coucil",
  "Braintree District Council",
  "Brentwood Borough Council",
  "Brighton and Hove city Council",
  "Bridgend Council",
  "Bristol City Council",
  "Broadland District Council",
  "Bromley",
  "Bromsgrove District Council",
  "Broxtowe Borough Council",
  "Buckinghamshire Council",
  "Burnley Borough Council",
  "Bury Borough Council",
  "Caerphilly County Borough Council",
  "Calderdale Borough Council",
  "Cambridge City Council",
  "Camden",
  "Cannock Chase District Council",
  "Canterbury City Council",
  "Cardiff City Council",
  "Carlisle City Council",
  "Carmarthenshire Council",
  "Castle Point District Council",
  "Central Bedfordshire Council",
  "Charnwood Borough Council",
  "Chelmsford City Council",
  "Cheltenham Borough Council",
  "Cherwell District Council",
  "Cheshire East council (same as cheshire west & chester Council)",
  "Cheshire West and Chester Council",
  "Chesterfield Borough Council",
  "Chichester District Council",
  "Chiltern District Council",
  "Chorley Borough Council",
  "City of York Council",
  "Colchester Borough Council",
  "Conwy County Borough Council",
  "Copeland Borough Council",
  "Corby Borough Council",
  "Cornwall Council",
  "Cotswold District Council",
  "Coventry City Council",
  "Craven District Council",
  "Crawley Borough Council",
  "Croydon (london borough of croydon)",
  "Croydon / Murton & Sutton Credit Union",
  "Cumberland council",
  "Dacorum Borough Council",
  "Darlington Borough Council",
  "Dartford Borough Council",
  "Daventry District Council",
  "Denbighshire",
  "Denbighshire County Council",
  "Derby City Council",
  "Derbyshire Dales District Council",
  "Doncaster Borough Council",
  "Dorset  Council Direct (Now cover east, northa, south and north dorset)",
  "Dover District Council",
  "Dudley Borough Council",
  "Durham County Council",
  "London borough of ealing",
  "East Cambridgeshire District Council",
  "East Devon District Council",
  "East End Fair Finance",
  "East Hampshire District Council",
  "East Herfordshire District Council",
  "East Lindsey District Council",
  "East Riding  Yorkshire Council",
  "East Staffordshire Borough Council",
  "East Suffolk Council (COVERS Breckland / East Cambs / Fenland + West Suffolk) ) email address counciltaxadmin@angliarevenues.gov.uk",
  "Eastbourne Borough Council",
  "Eastleigh Borough Council",
  "Eden District Council",
  "Elmbridge Borough Council",
  "Enfield 'London Borough of Enfield'",
  "Epping Forest District Council",
  "Epsom and Ewell Borough Council",
  "Erewash Borough Council",
  "Exeter City Council",
  "Fareham Borough Council",
  "Fenland District Council  (COVERS Breckland / East Cambs / Fenland + West Suffolk) ) email address counciltaxadmin@angliarevenues.gov.uk",
  "Finio Loans",
  "First Holiday Finance",
  "Flintshire Council",
  "Forest Health District Council",
  "Forest of Dean District Council",
  "Fylde Borough Council",
  "Gateshead Borough Council",
  "Gedling Borough Council",
  "Gloucester City Council",
  "Gosport Borough Council",
  "Gravesham Borough Council",
  "Great Yarmouth Borough Council",
  "Greenwich",
  "Guildford Borough Council",
  "Gwynedd Council",
  "London Borough of Hackney",
  "Halton Borough Council",
  "Hambleton District Council",
  "Hammersmith and Fulham",
  "Harborough District Council",
  "London Borough of Haringey",
  "Harlow District Council",
  "Harpenden Council",
  "Harrogate Borough Council",
  "Harrow",
  "Hart Council",
  "Hartlepool Borough Council",
  "Hastings Borough Council",
  "Havant Borough Council",
  "Havering",
  "Hemel Hempstead",
  "Herefordshire Council",
  "Hertsmere Borough Council",
  "High Peak Borough Council",
  "Hilingdon Council (Parking Tickets)",
  "hilli",
  "Hillingdon Council (London Borough)",
  "Hinckley and Bosworth Borough Council",
  "Horsham District Council",
  "Hounslow (london borough of hounslow)",
  "Huddersfield (council tax)",
  "Huddersfield Credit Union",
  "Hull City Council",
  "Huntingdonshire District Council",
  "Hyndburn Borough Council",
  "Ipswich Borough Council",
  "Isle of Wight Council",
  "Folkestone & Hythe District Council",
  "Isle of Anglesey County Council",
  "Islington",
  "Kensington and Chelsea",
  "Kettering District Council",
  "Kings Lynn & West Norfolk Borough Council",
  "Kingston University",
  "Kingston Upon Thames",
  "Kirklees Borough Council",
  "Knowsley Borough Council",
  "Lambeth",
  "Lancaster City Council",
  "Leeds City Council",
  "Leicester City Council",
  "Lewes District Council",
  "Lichfield City Council",
  "Lincoln City Council (ON SYSTEM AS CITY OF LINCOLN) / West Lindsey",
  "Liverpool City Council",
  "London Borough of Barking & Dagenham",
  "London Borough of Bexley",
  "London Borough of Brent",
  "London Borough of Lewisham",
  "London Borough of Newham",
  "London Borough of Richmond Upon Thames",
  "Luton Borough Council",
  "Macclesfield County Council",
  "Maidstone Borough Council",
  "Maldon District Council",
  "Malvern Hills District Council",
  "Manchester City Council",
  "Mansfield District Council",
  "Medway",
  "Melton Borough Council",
  "Mendip District Council",
  "Merthyr Tydfil County Borough",
  "Merton ( London Borough of)",
  "Metro Moneywise Credit Union",
  "Mid Devon District Council",
  "Mid Kent",
  "Mid Suffolk District Council",
  "Mid Sussex District Council",
  "Middlesbrough Borough Council",
  "Milton Keynes Council",
  "Mole Valley District Council",
  "Monmouthshire",
  "Neath port talbot Council",
  "New Forest District Council",
  "Newark & Sherwood District Council",
  "Newcastle City Council",
  "Newcastle-under-Lyme Borough Council",
  "Newport City Council",
  "North Devon District Council",
  "North East Derbyshire Council",
  "North East Lincolnshire Council (Grimsby)",
  "North Hertfordshire District Council",
  "North Kesteven District Council",
  "North Lincolnshire Council",
  "North Norfolk District Council",
  "North Northamptonshire (inc wellingborough)",
  "North Somerset Council",
  "North Tyneside Borough Council",
  "North Warwickshire Borough Council",
  "North West Leicestershire District Council",
  "\" NEW NAME IS WEST NORTHAMPTONSHIRE",
  "THIS COVERS DAVENTRY / NORTHAMPTONSHIRE BOROUGH / NORTHAMPTON BOROUGH / NORTHAMPSHIRE SOUTH / NORTHAMPTON SOUTH)\"",
  "Northumberland County Council",
  "Norwich City Council",
  "Nottingham City Council",
  "Nuneaton & Bedworth Borough Council",
  "Oadby & Wigston Borough Council",
  "Oldham Borough Council",
  "Pembrokeshire County Council",
  "Pendle Borough Council",
  "Peterborough City Council",
  "Plymouth City Council",
  "Poole Borough Council",
  "Portsmouth City Council",
  "Powsy County Council",
  "Preston City Council",
  "Purbeck District Council",
  "Reading Borough Council",
  "London Borough of Redbridge",
  "Redcar and Cleveland Borough Council",
  "Redditch Borough Council",
  "Reigate & Banstead Borough Council",
  "Rhondda Cynon Taf County Borough Council",
  "Ribble Valley Borough Council",
  "Richmondshire District Council",
  "Rochdale Borough Council",
  "Rochford District Council",
  "Rossendale Borough Council",
  "Rother District Council",
  "Rotherham Borough Council",
  "Rugby Borough Council",
  "Runnymede Borough Council",
  "Rushcliffe Borough Council",
  "Rushmoor Borough Council",
  "Ryedale District Council",
  "Salford City council",
  "Sandwell Borough Council",
  "\"Scarborough Borough Council was abolished and its functions were transferred to a new single authority for the non-metropolitan county of North Yorkshire.",
  "North Yorkshire Council IS THE NEW COUNCIL!!",
  "\"",
  "Sedgemoor District Council",
  "Sefton Borough Council",
  "Sefton Credit Union",
  "Selby District Council",
  "rth",
  "Sheffield City Council",
  "Shepway District Council",
  "Shropshire Council",
  "Slough Borough Council",
  "Solihull Borough Council",
  "South Buckinghamshire Distinct Council",
  "South Cambridgeshire District Council",
  "South Derbyshire District Council",
  "Southend on Sea Borough Council",
  "South Gloucestershire Council",
  "South Hams District Council",
  "South Holland District Council",
  "South Kesteven District Council",
  "South Lakeland District Council",
  "South Norfolk District Council",
  "South Oxfordshire District Council",
  "South Ribble Borough Council",
  "South Somerset District Council",
  "South Staffordshire District Council",
  "South Tyneside Borough Council",
  "Southampton City Council",
  "Southwark (london borough)",
  "Spelthorne Borough Castle",
  "St Albans City Council",
  "St Edmundsbury Borough Council",
  "St Helens Borough Council",
  "Stafford Borough Council + Cannock Council (work together)",
  "Staffordshire Moorlands District Council",
  "Stevenage Borough Council",
  "Stockport Borough Council",
  "Stockton on Tees",
  "Stoke-on-Trent City Council",
  "Stratford on Avon District Council",
  "Stroud District Council",
  "Suffolk Coastal District Council",
  "Sunderland City Council",
  "Surrey Heath Borough Council",
  "Sutton Council (LONDON BOROUGH OF SUTTON)",
  "Swale Borough Council",
  "Swansea Council",
  "Swindon Borough Council",
  "Tameside Borough Council",
  "Tamworth Borough",
  "Tandridge District Council",
  "Taunton Deane Borough Council",
  "Teignbridge District Council",
  "Telford and Wrekin Borough Council",
  "Tendring District Council",
  "Test Valley Borough Council",
  "Tewkesbury Borough Council",
  "Thanet District Council",
  "Three Rivers District Council",
  "The Vale of Glamorgan Council",
  "Thurrock Council",
  "Tonbridge & Malling Borough Council",
  "Torbay Council",
  "Torfaen County Borough",
  "Torridge District Council",
  "Tower Hamlets",
  "Trafford Borough Council",
  "Tunbridge Wells Borough Council (emails come from Mid KenT)",
  "Uttlesford District Council",
  "Vale of White Horse District Council",
  "Wakefield City Council",
  "Walsall Borough Council",
  "Waltham Forest",
  "Wandsworth",
  "Warrington Borough Council",
  "Warwick District Council",
  "Watford Borough Council",
  "Waveney District Council",
  "Waverley Borough Council",
  "Wealden District Council",
  "Welwyn Hatfield Borough Council",
  "West Berkshire Council",
  "West Cheshire Credit Union",
  "West Devon Borough Council",
  "West Lancashire District Council",
  "West Lindsay",
  "WESTMORLAND & FURNESS COUNCIL",
  "West Oxfordshire District Council",
  "West Somerset District Council",
  "West Suffolk",
  "Westminster",
  "Weymouth & Portland Borough Council",
  "Wigan Borough Council",
  "Wiltshire Council",
  "Winchester City Council",
  "Windsor and Maidenhead Borough Council",
  "Wirral Borough Council",
  "Woking Borough Council",
  "Wokingham Borough Council",
  "Wolverhampton City Council",
  "Worcester City Council",
  "Worthing Borough Council",
  "Wrexham Council",
  "Wychavon District Council",
  "Wycombe District Council",
  "Wyre Borough Council",
  "Wyre Forest District Council",
];

const DEBT_TERMS_NORM = DEBT_TERMS_EXTRA.map((t) => normalise(String(t))).filter(Boolean);


function hasExtraDebtTerm(userText: string) {
  const raw = userText || "";
  const t = ` ${normalise(raw)} `;

  for (const nt of DEBT_TERMS_NORM) {
    if (!nt) continue;

    // word-ish boundary to reduce false hits on very short terms
    if (nt.length <= 3) {
      const safe = nt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${safe}\\b`, "i");
      if (re.test(raw)) return true;
      continue;
    }

    if (t.includes(` ${nt} `) || t.includes(nt)) return true;
  }

  return false;
}

function hasSubstantiveDebtContent(userText: string) {
  const t = normalise(userText);

  // high value regex
  const debtish =
    /\b(debt|debts|loan|loans|credit|card|cards|overdraft|catalogue|catalog|klarna|ccj|ccjs|county court|bailiff|bailiffs|enforcement|parking|pcn|council tax|rent|mortgage|arrears|utility|energy|gas|electric|water|fine|fines|magistrates|attachment of earnings|charging order)\b/i.test(
      t
    );

  return debtish || hasExtraDebtTerm(userText);
}

function extractName(userText: string, opts?: { allowLooseScan?: boolean }): { ok: boolean; name?: string; reason?: string } {
  const raw = (userText || "").trim();

  if (!raw) return { ok: false, reason: "empty" };
  if (containsProfanity(raw)) return { ok: false, reason: "profanity" };

  // IMPORTANT:
  // - We only "guess" a name when we are explicitly expecting one (allowLooseScan === true),
  //   and even then we only accept very short, name-like replies (e.g. "Bob", "Bob Smith").
  // - We never scan inside longer sentences for random tokens (prevents "Are", "Have Been Struggling", etc).
  const allowLooseScan = opts?.allowLooseScan === true;

  // Keep original casing for nicer output, but normalise for checks
  const t = stripPunctuation(raw);

  // Explicit name declarations where the name can appear anywhere after the phrase.
  // Captures up to 3 tokens so "Mark Hughes" or "Mary Jane Smith" works.
  const leadIn =
    /\b(?:my name is|name is|this is|i am|i'?m|im|it's|its|it is|call me)\s+([A-Za-z][A-Za-z'\-]{1,})(?:\s+([A-Za-z][A-Za-z'\-]{1,}))?(?:\s+([A-Za-z][A-Za-z'\-]{1,}))?/i;

  const m = t.match(leadIn);

  const TAIL_FILLERS = new Set(
    ["here", "speaking", "mate", "pal", "bro", "bruv", "thanks", "thank", "you"].map((x) => x.toLowerCase())
  );

  const COMMON_NOT_NAMES = new Set(
    [
      "are",
      "am",
      "is",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "doing",
      "struggling",
      "help",
      "debt",
      "debts",
      "today",
      "now",
    ].map((x) => x.toLowerCase())
  );

  const validateCandidate = (candidate: string): { ok: boolean; name?: string; reason?: string } => {
    const cand = titleCaseName(candidate);
    const simple = normalise(cand);

    if (!cand) return { ok: false, reason: "empty" };
    if (containsProfanity(cand)) return { ok: false, reason: "profanity" };
    if (NAME_BLOCKLIST.has(simple)) return { ok: false, reason: "block" };
    if (COMMON_NOT_NAMES.has(simple)) return { ok: false, reason: "common_not_name" };

    // Don't treat debt-related phrases as names
    if (hasSubstantiveDebtContent(cand)) return { ok: false, reason: "debtish" };

    return { ok: true, name: cand };
  };

  // 1) Explicit "my name is ..." etc
  if (m) {
    const parts = [m[1], m[2], m[3]]
      .filter(Boolean)
      .map((x) => String(x).trim())
      .filter(Boolean)
      .filter((x) => !TAIL_FILLERS.has(normalise(x)));

    return validateCandidate(parts.join(" "));
  }

  // 2) If we are currently ASKING for a name, accept a short name-only reply:
  //    "Bob" / "Bob Smith" / "Mary Jane" (up to 3 tokens).
  if (allowLooseScan) {
    const toks = t.split(" ").filter(Boolean);

    // Reject longer inputs outright (prevents capturing sentences like "I have been struggling")
    if (toks.length >= 1 && toks.length <= 3) {
      // Must be alpha-ish tokens (name-like), and must NOT be obvious verbs/stopwords.
      const allNameLike = toks.every((w) => {
        const nw = normalise(w);
        if (!nw) return false;
        if (TAIL_FILLERS.has(nw)) return false;
        if (NAME_BLOCKLIST.has(nw)) return false;
        if (COMMON_NOT_NAMES.has(nw)) return false;
        if (nw.length < 2) return false;
        if (nw.endsWith("ing")) return false; // blocks "struggling", "doing", etc
        if (!/^[a-zA-Z][a-zA-Z'\-]*$/.test(w)) return false;
        return true;
      });

      if (allNameLike) return validateCandidate(toks.join(" "));
    }
  }

  return { ok: false, reason: "no_match" };
}

function extractAmounts(text: string): { paying?: number; affordable?: number } {
  const cleaned = text.replace(/,/g, "");
  const nums = [...cleaned.matchAll(/£\s*([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
  const bare = [...cleaned.matchAll(/\b([0-9]{2,7})(?:\.[0-9]+)?\b/g)].map((m) => Number(m[1]));
  const all = nums.length ? nums : bare;

  if (all.length >= 2) return { paying: all[0], affordable: all[1] };
  if (all.length === 1) {
    const t = normalise(text);
    if (t.includes("afford") || t.includes("could pay") || t.includes("can pay")) return { affordable: all[0] };
    if (t.includes("paying") || t.includes("pay ") || t.includes("currently pay")) return { paying: all[0] };
    return { paying: all[0] };
  }
  return {};
}

function bestFaqMatch(userText: string, faqs: FaqItem[]) {
  const t = normalise(userText);
  let best: { score: number; a: string } | null = null;

  for (const f of faqs) {
    const q = normalise(f.q || "");
    if (!q) continue;

    let score = 0;
    if (t === q) score += 100;
    if (t.includes(q) || q.includes(t)) score += 60;

    const tags = (f.tags || []).map(normalise);
    for (const tag of tags) {
      if (tag && t.includes(tag)) score += 10;
    }

    const tTokens = new Set(t.split(" ").filter((x) => x.length >= 3));
    const qTokens = q.split(" ").filter((x) => x.length >= 3);
    let overlap = 0;
    for (const tok of qTokens) if (tTokens.has(tok)) overlap++;
    score += overlap;

    if (!best || score > best.score) best = { score, a: f.a };
  }

  if (best && best.score >= 18) return best.a;
  return null;
}

async function callOpenAI(args: {
  userText: string;
  history: string[];
  language: string;
  state: ChatState;
  scriptStepPrompt: string;
}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const { userText, history, language, state, scriptStepPrompt } = args;

  const isComplex =
    userText.length > 140 ||
    /bankrupt|iva|dmp|dro|court|bailiff|enforcement|council tax|ccj|credit rating|interest/i.test(userText);

  const model = isComplex ? "gpt-4o" : "gpt-4o-mini";

  const system = `
You are a professional, friendly UK debt-advice assistant.
Goals:
- Sound human, calm, empathetic, and professional (avoid em dashes).
- Always respond to what the user just said (acknowledge it properly).
- If the user asks a side question, answer briefly, then return to the current step naturally.
- Follow the current script step without looping or asking the same question again.
- Never show internal markers or tags.
- Keep language: ${language}.
Current known name: ${state.name || "unknown"}.
Current step prompt: ${scriptStepPrompt}
`.trim();

  const messages: { role: Role; content: string }[] = [
    { role: "assistant", content: system },
    ...history.slice(-10).map((h) => ({ role: "user" as const, content: h })),
    { role: "user", content: userText },
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.4,
    }),
  });

  if (!r.ok) return null;
  const j = await r.json();
  const reply = j?.choices?.[0]?.message?.content;
  if (typeof reply === "string" && reply.trim()) return reply.trim();
  return null;
}

function promptKey(step: number, prompt: string) {
  return `${step}:${normalise(prompt).slice(0, 120)}`;
}

/**
 * IMPORTANT: We treat state.step as an INDEX into script.steps.
 * This avoids loops caused by script "id" fields not matching our step counter.
 */
function nextScriptPrompt(script: ScriptDef, state: ChatState) {
  if (!script?.steps?.length) return null;
  return script.steps[state.step] || script.steps[script.steps.length - 1] || script.steps[0];
}

function safeAskNameVariant(tries: number) {
  if (tries <= 0) return "Can you let me know who I’m speaking with? A first name is perfect.";
  if (tries === 1) return "Sorry — what first name would you like me to use?";
  if (tries === 2) return "No worries. Just pop a first name and we’ll carry on.";
  return "That’s fine. I’ll just call you ‘there’ for now. What prompted you to reach out about your debts today?";
}

const FALLBACK_STEP0 = "Hello! My name’s Mark. What prompted you to seek help with your debts today?";

function stripLeadingIntroFromPrompt(prompt: string) {
  const p = (prompt || "").trim();
  const lowered = normalise(p);
  if (lowered.startsWith("hello! my name’s mark.")) return p.replace(/^Hello!\s+My name’s Mark\.\s*/i, "");
  if (lowered.startsWith("hello! my name's mark.")) return p.replace(/^Hello!\s+My name'?s Mark\.\s*/i, "");
  return p;
}


type UiParseResult = {
  clean: string;
  uiTrigger?: string;
  popup?: string;
  portalTab?: string;
  openPortal?: boolean;
};

/**
 * Optional UI directives can be embedded inside prompts like:
 *   [UI: uiTrigger=incomeExpense; popup=welcome; portalTab=documents; openPortal=true]
 * They are stripped from the prompt before sending to the user, and returned as fields for the UI.
 */
function parseUiDirectives(prompt: string): UiParseResult {
  const raw = String(prompt ?? "");
  const uiBlocks = raw.match(/\[UI:[^\]]*\]/gi) || [];
  const triggerBlocks = raw.match(/\[TRIGGER:[^\]]*\]/gi) || [];
  const popupBlocks = raw.match(/\[POPUP:[^\]]*\]/gi) || [];
  if (!uiBlocks.length && !triggerBlocks.length && !popupBlocks.length) return { clean: raw };

  let uiTrigger: string | undefined;
  let popup: string | undefined;
  let portalTab: string | undefined;
  let openPortal: boolean | undefined;

  for (const block of uiBlocks) {
    const inner = block.replace(/^\[UI:\s*/i, "").replace(/\]$/i, "").trim();
    const parts = inner.split(/[;,]/).map((s) => s.trim()).filter(Boolean);

    for (const part of parts) {
      const [kRaw, ...vParts] = part.split("=");
      const key = (kRaw || "").trim();
      const val = vParts.join("=").trim();

      if (!key) continue;

      if (/^uitrigger$/i.test(key) || /^trigger$/i.test(key)) uiTrigger = val || uiTrigger;
      else if (/^popup$/i.test(key)) popup = val || popup;
      else if (/^portaltab$/i.test(key) || /^tab$/i.test(key)) portalTab = val || portalTab;
      else if (/^openportal$/i.test(key)) {
        if (/^(true|1|yes)$/i.test(val)) openPortal = true;
        else if (/^(false|0|no)$/i.test(val)) openPortal = false;
      }
    }
  }


  // Support popup markers like: [POPUP: FACT_FIND_CLIENT_INFORMATION]
  for (const block of popupBlocks) {
    const inner = block.replace(/^\[POPUP:\s*/i, "").replace(/\]$/i, "").trim();
    if (inner) popup = popup || inner;
  }

  // Support legacy trigger markers like: [TRIGGER: OPEN_FACT_FIND_POPUP]
  for (const block of triggerBlocks) {
    const inner = block.replace(/^\[TRIGGER:\s*/i, "").replace(/\]$/i, "").trim();
    if (inner) uiTrigger = uiTrigger || inner;
  }

  const clean = raw
    .replace(/\s*\[UI:[^\]]*\]\s*/gi, " ")
    .replace(/\s*\[TRIGGER:[^\]]*\]\s*/gi, " ")
    .replace(/\s*\[POPUP:[^\]]*\]\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { clean, uiTrigger, popup, portalTab, openPortal };
}

/** Convenience: parse UI directives and strip any intro, returning clean text + UI fields. */
function cleanPromptAndUi(prompt: string) {
  const parsed = parseUiDirectives(prompt);
  const clean = stripLeadingIntroFromPrompt(parsed.clean) || parsed.clean;
  return { clean, ui: parsed };
}


function step0Variant(cleanPrompt: string) {
  const canon = "what prompted you to seek help with your debts today?";
  if (normalise(cleanPrompt) === canon) {
    const variants = [
      "What’s led you to reach out for help with your debts today?",
      "What’s made you get in touch about your debts today?",
      "What’s been happening that made you reach out about your debts today?",
    ];
    return variants[Math.floor(Math.random() * variants.length)];
  }
  return cleanPrompt;
}

function inferExpectFromPrompt(prompt: string) {
  const p = normalise(prompt);
  if (p.includes("who i’m speaking with") || p.includes("what name") || p.includes("your name")) return "name";
  if (
    p.includes("what prompted") ||
    p.includes("what’s led you") ||
    p.includes("what has led") ||
    p.includes("reach out") ||
    p.includes("get in touch")
  )
    return "concern";
  if (p.includes("main issue") || p.includes("main concern") || p.includes("biggest issue")) return "issue";
  if (p.includes("how much") && (p.includes("pay") || p.includes("afford"))) return "amounts";
  return "free";
}

function buildAcknowledgement(userText: string, state: ChatState) {
  const courtesy = detectCourtesy(userText);
  const name = state.name && state.name !== "there" ? state.name : null;

  if (hasSubstantiveDebtContent(userText)) {
    const base = name ? `Thanks, ${name} — got it.` : "Thanks — got it.";
    return courtesy ? `${courtesy} ${base}` : base;
  }

  if (courtesy) return courtesy;

  return name ? `Thanks, ${name}.` : "Thanks.";
}

function stripThanksPrefix(text: string) {
  let t = (text || "").trim();
  // Remove leading "Thanks" / "Thank you" / "Cheers" to avoid double-thanking when the script prompt starts similarly.
  t = t.replace(/^(thanks|thank you|cheers)(\s*(—|-|,|\.|!))?\s*/i, "");
  // Also remove the common "got it" directly after thanks
  t = t.replace(/^(got it|understood)(\s*(—|-|,|\.|!))?\s*/i, "");
  return t.trim();
}

function promptStartsWithThanks(prompt: string) {
  const p = normalise((prompt || "").trim());
  return p.startsWith("thanks") || p.startsWith("thank you") || p.startsWith("cheers");
}

function joinAckAndPrompt(ack: string, prompt: string) {
  const aRaw = (ack || "").trim();
  const p = (prompt || "").trim();
  if (!aRaw) return p;
  if (!p) return aRaw;

  const na = normalise(aRaw);
  const np = normalise(p);

  // If the scripted prompt already starts with thanks/thank you, strip that from the ack to avoid "Thanks... Thank you..."
  if (promptStartsWithThanks(p) && (na.startsWith("thanks") || na.startsWith("thank you") || na.startsWith("cheers"))) {
    const stripped = stripThanksPrefix(aRaw);
    return stripped ? `${stripped} ${p}` : p;
  }

  if (na.startsWith("thanks") && np.startsWith("thanks")) return p;
  if (na === np) return p;

  return `${aRaw} ${p}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {

  res.setHeader("Allow", "POST, OPTIONS, GET, HEAD");

  // Accept non-POST requests gracefully to avoid 405s surfacing in the UI.
  // The client should use POST for normal chat interaction.
  if (req.method !== "POST") {
    if (req.method === "OPTIONS") {
      // CORS preflight / safety ping
      return res.status(200).json({ reply: "OK", state: { step: 0 } });
    }
    return res.status(200).json({ reply: "Use POST to interact with this endpoint.", state: { step: 0 } });
  }

  const body = (req.body || {}) as ApiReqBody;
  const userText = (body.userMessage ?? body.message ?? "").toString().trim();
  const language = (body.language || "English").toString();

  const history: string[] = Array.isArray(body.history)
    ? typeof (body.history as any)[0] === "string"
      ? (body.history as string[])
      : (body.history as any[]).map((m) => String(m?.content || "")).filter(Boolean)
    : [];

  const scriptPath = path.join(process.cwd(), "utils", "full_script_logic.json");
  const faqPath = path.join(process.cwd(), "utils", "faqs.json");
  const script = readJsonSafe<ScriptDef>(scriptPath, { steps: [] });
  const faqRaw = readJsonSafe<any>(faqPath, []);
  const faqs: FaqItem[] = Array.isArray(faqRaw) ? faqRaw : Array.isArray(faqRaw?.faqs) ? faqRaw.faqs : [];

  const state: ChatState = {
    step: 0,
    askedNameTries: 0,
    name: null,
    concern: null,
    issue: null,
    ...body.state,
  };

  // Normalise the session id (used for DB persistence / telemetry)
  const sessionId = (
    (body.sessionId as any) ?? (state as any).sessionId ?? (state as any).session_id ?? ""
  )
    .toString()
    .trim();


  if (normalise(userText) === "reset") {
    const first = script.steps?.[0]?.prompt || FALLBACK_STEP0;
    const s: ChatState = {
      step: 0,
      askedNameTries: 0,
      name: null,
      concern: null,
      issue: null,
      lastPromptKey: undefined,
      lastStepPrompted: undefined,
    };
    return res.status(200).json({ reply: first, state: s });
  }
  // If the user cancelled the Fact Find (client details) and it's still outstanding,
  // pause the script until they complete it.
  const cancelledHard = Boolean((state as any).profileCancelledHard);
  const outstanding = Boolean((state as any).profileOutstanding);
  if ((cancelledHard || outstanding) && !userText.startsWith("__PROFILE_SUBMIT__") && !userText.startsWith("__DEBT_TOTAL__") && !userText.startsWith("__MONTHLY_PAY__")) {
    const wantsToContinue = /(ready|continue|proceed|carry on|go on|start)/i.test(userText || "");
    const lead = wantsToContinue ? "Great —" : "Yes —";
    return res.status(200).json({
      reply:
        `${lead} I can still help. Please complete the outstanding Client details task highlighted in red in the chat header. If you’re not ready to do that right now, please come back to the chat when you are ready to proceed.`,
      state,
    });
  }



  // If the frontend sends an out-of-date step (e.g. stuck at 0), try to resync using the latest assistant message.
  // This prevents loops where the UI shows "main issue" but the backend still thinks we're on step 0 ("concern").
  const historyText = history.filter(Boolean).slice(-8).join(" ");
  const lastAssistant = historyText || "";
  const lastA = normalise(lastAssistant);

  function bestStepFromHistory(s: ScriptDef, last: string) {
    if (!s?.steps?.length) return null;
    const hay = normalise(last || "");
    if (!hay) return null;

    let best: number | null = null;
    for (let i = 0; i < s.steps.length; i++) {
      const stepPrompt = s.steps[i]?.prompt || "";
      if (!stepPrompt) continue;
      const cleaned = stripLeadingIntroFromPrompt(parseUiDirectives(stepPrompt).clean);
      const needle = normalise(cleaned).slice(0, 45);
      if (needle && hay.includes(needle)) best = i;
    }

    // Fallback heuristics based on the last assistant question wording
    if (best === null) {
      const exp = (inferExpectFromPrompt(last) || "free").toLowerCase();
      if (exp === "issue") best = Math.max(best ?? 0, 1);
      if (exp === "amounts") best = Math.max(best ?? 0, 2);
    }

    return best;
  }

  const inferredStep = bestStepFromHistory(script, lastAssistant);
  if (typeof inferredStep === "number" && inferredStep >= 0) {
    // Only move forward (never backwards)
    if (state.step < inferredStep) state.step = inferredStep;
  }



  // Fact Find submit marker from the UI: "__PROFILE_SUBMIT__ {json}"
  // We treat this as a state update (not a user chat message) and advance the script.
  if (userText && userText.startsWith("__PROFILE_SUBMIT__")) {
    try {
      const raw = userText.replace(/^__PROFILE_SUBMIT__\s*/i, "").trim();
      const payload = raw ? JSON.parse(raw) : {};
      (state as any).profile = payload;

      // Best-effort: set display name for nicer UX
      const fullName = String(payload?.fullName || "").trim();
      const first = fullName.split(/\s+/).filter(Boolean)[0] || null;
      if (first) state.name = first;

      // Clear "outstanding" guards so the script can continue
      (state as any).profileOutstanding = false;
      (state as any).profileCancelledHard = false;
      (state as any).factFindCompleted = true;

      // Move to the next step now that details are captured
      state.step = Math.min((state.step || 0) + 1, Math.max(0, (script.steps?.length || 1) - 1));

      // If the script still wants the Fact Find after submit (usually due to gating),
      // nudge forward once more to avoid looping.
      for (let i = 0; i < 2; i++) {
        const probe = nextScriptPrompt(script, state);
        const probePrompt = String(probe?.prompt || "").toLowerCase();
        if (probePrompt.includes("fact find") && probePrompt.includes("please complete")) {
          state.step = Math.min((state.step || 0) + 1, Math.max(0, (script.steps?.length || 1) - 1));
          continue;
        }
        break;
      }

      const nextDef = nextScriptPrompt(script, state);
      const nextPromptFull = nextDef?.prompt || FALLBACK_STEP0;
      const nextParsed = parseUiDirectives(nextPromptFull);
      const nextClean = step0Variant(stripLeadingIntroFromPrompt(nextParsed.clean));

      return res.status(200).json({
        reply: nextClean,
        state,
        uiTrigger: "OPEN_CLIENT_PORTAL",
        displayName: state.name || undefined,
      });
    } catch {
      // If parsing fails, continue with normal flow.
    }
  }


  // Step 6 slider marker from the UI: "__DEBT_TOTAL__ {json}"
  if (userText && userText.startsWith("__DEBT_TOTAL__")) {
    try {
      const raw = userText.replace(/^__DEBT_TOTAL__\s*/i, "").trim();
      const payload = raw ? JSON.parse(raw) : {};
      const totalDebt = Number(payload?.totalDebt ?? 0);

      (state as any).totalDebt = totalDebt;
      if (!(state as any).profile) (state as any).profile = {};
      (state as any).profile.totalDebt = totalDebt;

      // Best-effort persist to Supabase 'clients' table (if present)
      try {
        if (sessionId) {
          await supabaseAdmin
            .from("clients")
            .upsert({ session_id: sessionId, total_debt: totalDebt }, { onConflict: "session_id" });
        }
      } catch {
        // ignore
      }

      let bandText = "";
      if (totalDebt <= 3000) {
        bandText =
          "Thanks luckily, it’s not too much debt to deal with — we can definitely point you in the right direction and get you the help that’s needed to get this all sorted.";
      } else if (totalDebt <= 10000) {
        bandText =
          "You have quite a lot of unsecured debt outstanding. It’s clear that it must be very difficult to deal with, but don’t worry — we can help you to get this all sorted today.";
      } else {
        bandText =
          "That is a large amount of debt, it must be very difficult for you to deal with all this. I will ensure that we do everything we can today to alleviate the pressure and get this debt consolidated for you.";
      }

      const nextQ = "Roughly how much are you paying per month to your creditors?";
      return res.status(200).json({
        reply: `${bandText}\n\n${nextQ}`,
        state,
      });
    } catch {
      // If parsing fails, continue with normal flow.
    }
  }

  // Step 7 slider marker from the UI: "__MONTHLY_PAY__ {json}"
  if (userText && userText.startsWith("__MONTHLY_PAY__")) {
    try {
      const raw = userText.replace(/^__MONTHLY_PAY__\s*/i, "").trim();
      const payload = raw ? JSON.parse(raw) : {};
      const monthlyPay = Number(payload?.monthlyPay ?? 0);

      (state as any).monthlyPay = monthlyPay;
      if (!(state as any).profile) (state as any).profile = {};
      (state as any).profile.monthlyPay = monthlyPay;

      let bandText = "";
      if (monthlyPay <= 200) {
        bandText = "It looks like we can help you with this — let’s try and help you save some money today.";
      } else if (monthlyPay <= 500) {
        bandText = "You are paying a lot to your creditors every month — let’s see how much money we can save you today.";
      } else {
        bandText = "You are paying a huge sum of money out to your creditors each month — let’s see how much money we can save you today.";
      }

      // Next step 8 question (kept text-accurate to script style)
      const nextQ =
        "If we could get all your debts consolidated today into one payment, how much money do you feel that you can afford to offer your creditors on a monthly basis?";
      return res.status(200).json({
        reply: `${bandText}\n\n${nextQ}`,
        state,
      });
    } catch {
      // If parsing fails, continue with normal flow.
    }
  }

  const currentStepDef = nextScriptPrompt(script, state);
  const currentPromptFull = currentStepDef?.prompt || FALLBACK_STEP0;

  // Parse any optional UI directives embedded in the prompt (e.g. [UI:...])
  const currentParsed = parseUiDirectives(currentPromptFull);
  const currentPromptClean = stripLeadingIntroFromPrompt(currentParsed.clean) || currentParsed.clean;

  if (isAckOnly(userText)) {
    const follow = state.step === 0 ? step0Variant(currentPromptClean) : currentPromptClean;
    const key = promptKey(state.step, follow);
    return res.status(200).json({
      reply: follow,
      uiTrigger: currentParsed.uiTrigger,
      popup: currentParsed.popup,
      portalTab: currentParsed.portalTab,
      openPortal: currentParsed.openPortal,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  if ((looksLikeGreetingOrSmallTalk(userText) || looksLikeOffTopicQuestion(userText)) && !hasSubstantiveDebtContent(userText)) {
    // If the user includes their name inside small talk (e.g. "Hi Mark, my name is Ali..."),
    // capture it without derailing the current step.
    let nextState: ChatState = { ...state };
    let nameCaptured: string | null = null;

    if (!nextState.name || nextState.name === "there") {
      const n = extractName(userText, { allowLooseScan: false });
      if (n.ok && n.name && !hasSubstantiveDebtContent(userText)) {
        nextState = { ...nextState, name: n.name, askedNameTries: 0 };
        nameCaptured = n.name;
      }
    }

    const st = smallTalkReply(userText) || offTopicReply(userText, state);

    let follow = currentPromptClean;
    if (nextState.step === 0) follow = step0Variant(follow);

    const nameIntro = nameCaptured
      ? normalise(nameCaptured) === "mark"
        ? "Nice to meet you, Mark — nice to meet a fellow Mark."
        : `Nice to meet you, ${nameCaptured}.`
      : "";

    const head = [nameIntro, st].filter(Boolean).join(" ").trim();
    const reply = head ? `${head}

${follow}` : st ? `${st}

${follow}` : follow;

    const key = promptKey(nextState.step, follow);
    if (nextState.lastPromptKey === key) {
      const alt =
        nextState.step === 0
          ? "When you’re ready, tell me what’s brought you here about your debts today."
          : "When you’re ready, we can carry on from where we left off.";
      return res.status(200).json({
        reply: head ? `${head}

${alt}` : st ? `${st}

${alt}` : alt,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, alt), lastStepPrompted: nextState.step },
        ...(nameCaptured ? { displayName: nameCaptured } : {}),
      });
    }

    return res.status(200).json({
      reply,
      state: { ...nextState, lastPromptKey: key, lastStepPrompted: nextState.step },
      ...(nameCaptured ? { displayName: nameCaptured } : {}),
    });
  }

  const faqAnswer = bestFaqMatch(userText, faqs);
  if (faqAnswer) {
    const follow = currentPromptClean;
    const reply = `${faqAnswer}\n\n${follow}`;
    const key = promptKey(state.step, follow);
    return res.status(200).json({
      reply,
      uiTrigger: currentParsed.uiTrigger,
      popup: currentParsed.popup,
      portalTab: currentParsed.portalTab,
      openPortal: currentParsed.openPortal,
      state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
    });
  }

  const stepDef = nextScriptPrompt(script, state);
  const prompt = stepDef?.prompt || currentPromptFull;

  const stepExpects = (stepDef?.expects || "").toLowerCase();
  const inferredExpects = (inferExpectFromPrompt(prompt) || "free").toLowerCase();
  // Prefer what the *prompt actually asks* for, even if the script metadata is out of sync, to avoid loops.
  const expects = inferredExpects !== "free" && inferredExpects !== stepExpects ? inferredExpects : stepExpects || inferredExpects || "free";
  if (expects === "profile") {
    const skipMarker = "__PROFILE_SKIP__";
    if (userText.startsWith(skipMarker)) {
      const nextState: ChatState = { ...state };
      nextState.step = Math.min(state.step + 1, (script.steps?.length || 9999) - 1);
      const next = nextScriptPrompt(script, nextState);
      const parsedNext = parseUiDirectives(next?.prompt || FALLBACK_STEP0);
      const cleanNext = stripLeadingIntroFromPrompt(parsedNext.clean) || parsedNext.clean;
      return res.status(200).json({
        reply: cleanNext,
        uiTrigger: parsedNext.uiTrigger,
        popup: parsedNext.popup,
        portalTab: parsedNext.portalTab,
        openPortal: parsedNext.openPortal,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, cleanNext), lastStepPrompted: nextState.step },
      });
    }
    const marker = "__PROFILE_SUBMIT__";
    if (userText.startsWith(marker)) {
      const raw = userText.slice(marker.length).trim();
      const obj = readJsonSafe<any>(raw, null);
      const nextState: ChatState = { ...state, profile: obj || state.profile };
      nextState.step = Math.min(state.step + 1, (script.steps?.length || 9999) - 1);
      const next = nextScriptPrompt(script, nextState);
      const parsedNext = parseUiDirectives(next?.prompt || FALLBACK_STEP0);
      const cleanNext = stripLeadingIntroFromPrompt(parsedNext.clean) || parsedNext.clean;
      return res.status(200).json({
        reply: cleanNext,
        uiTrigger: parsedNext.uiTrigger,
        popup: parsedNext.popup,
        portalTab: parsedNext.portalTab,
        openPortal: parsedNext.openPortal,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, cleanNext), lastStepPrompted: nextState.step },
      });
    }
    // Re-issue current prompt and instruct UI to open the Fact Find popup.
    return res.status(200).json({
      reply: currentPromptClean,
      uiTrigger: currentParsed.uiTrigger || "OPEN_FACT_FIND_POPUP",
      popup: currentParsed.popup || "FACT_FIND_CLIENT_INFORMATION",
      portalTab: currentParsed.portalTab,
      openPortal: currentParsed.openPortal,
      state: { ...state, lastPromptKey: promptKey(state.step, currentPromptClean), lastStepPrompted: state.step },
    });
  }

  if (expects === "name") {
    const tries = state.askedNameTries || 0;
    const nameParse = extractName(userText, { allowLooseScan: true });

    if (nameParse.ok && nameParse.name) {
      const name = nameParse.name;
      const isSameAsMark = normalise(name) === "mark";

      const greet = isSameAsMark ? `Nice to meet you, Mark — nice to meet a fellow Mark.` : `Nice to meet you, ${name}.`;

      const nextState: ChatState = {
        ...state,
        name,
        askedNameTries: 0,
        step: state.step + 1,
      };

      const nextStepDef = nextScriptPrompt(script, nextState);
      const nextPromptFull = nextStepDef?.prompt || "What’s led you to reach out for help with your debts today?";
      const nextP0 = cleanPromptAndUi(nextPromptFull);
      const nextPrompt = nextState.step === 0 ? step0Variant(nextP0.clean) : nextP0.clean;

      return res.status(200).json({
        reply: `${greet} ${nextPrompt}`,
        uiTrigger: nextP0.ui.uiTrigger,
        popup: nextP0.ui.popup,
        portalTab: nextP0.ui.portalTab,
        openPortal: nextP0.ui.openPortal,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextPrompt), lastStepPrompted: nextState.step },
        displayName: name,
      });
    }

    const nextTries = tries + 1;

    if (nextTries >= 4) {
      const nextState: ChatState = {
        ...state,
        name: "there",
        askedNameTries: nextTries,
        step: state.step + 1,
      };
      const nextStepDef = nextScriptPrompt(script, nextState);
      const nextPromptFull = nextStepDef?.prompt || "What’s led you to reach out for help with your debts today?";
      const nextP = cleanPromptAndUi(nextPromptFull);
      return res.status(200).json({
        reply: `No problem. ${nextP.clean}`,
        uiTrigger: nextP.ui.uiTrigger,
        popup: nextP.ui.popup,
        portalTab: nextP.ui.portalTab,
        openPortal: nextP.ui.openPortal,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextP.clean), lastStepPrompted: nextState.step },
      });
    }

    const ask = safeAskNameVariant(nextTries);
    return res.status(200).json({
      reply: ask,
      state: { ...state, askedNameTries: nextTries, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
    });
  }

  if (expects === "concern") {

    // If the user provides their name early (e.g., "my name is Ali") while we're asking what prompted them,
    // capture it and keep them on the same step (so we still get the reason they reached out).
    const earlyName = extractName(userText, { allowLooseScan: false });
    if (earlyName.ok && earlyName.name && !hasSubstantiveDebtContent(userText)) {
      const name = earlyName.name;
      const isSameAsMark = normalise(name) === "mark";
      const greet = isSameAsMark
        ? "Nice to meet you, Mark — nice to meet a fellow Mark."
        : `Nice to meet you, ${name}.`;

      const nextState: ChatState = {
        ...state,
        name,
        askedNameTries: 0,
        // stay on the same step (concern)
        step: state.step,
      };

      // Re-ask the concern question (without the "My name's Mark" intro)
      const follow = step0Variant(currentPromptClean);
      const key = promptKey(nextState.step, follow);

      return res.status(200).json({
        reply: `${greet} ${follow}`,
        uiTrigger: currentParsed.uiTrigger,
        popup: currentParsed.popup,
        portalTab: currentParsed.portalTab,
        openPortal: currentParsed.openPortal,
        state: { ...nextState, lastPromptKey: key, lastStepPrompted: nextState.step },
        displayName: name,
      });
    }

    const t = userText.trim();
    if (t.length < 3) {
      const follow = step0Variant(stripLeadingIntroFromPrompt(prompt) || prompt);
      return res.status(200).json({
        reply: follow,
        state: { ...state, lastPromptKey: promptKey(state.step, follow), lastStepPrompted: state.step },
      });
    }

    const nextState: ChatState = {
      ...state,
      concern: t,
      step: state.step + 1,
    };

    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextPromptFull = nextStepDef?.prompt || "What would you say is the main issue with the debts at the moment?";
    const nextP = cleanPromptAndUi(nextPromptFull);

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextP.clean),
      uiTrigger: nextP.ui.uiTrigger,
      popup: nextP.ui.popup,
      portalTab: nextP.ui.portalTab,
      openPortal: nextP.ui.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextP.clean), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "issue") {
    const t = userText.trim();
    if (t.length < 2) {
      return res.status(200).json({
        reply: stripLeadingIntroFromPrompt(prompt) || prompt,
        state: { ...state, lastPromptKey: promptKey(state.step, prompt), lastStepPrompted: state.step },
      });
    }

    const nextState: ChatState = {
      ...state,
      issue: t,
      step: state.step + 1,
    };

    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextPromptFull = nextStepDef?.prompt || "Roughly what do you pay towards your debts each month?";
    const nextP = cleanPromptAndUi(nextPromptFull);

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextP.clean),
      uiTrigger: nextP.ui.uiTrigger,
      popup: nextP.ui.popup,
      portalTab: nextP.ui.portalTab,
      openPortal: nextP.ui.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextP.clean), lastStepPrompted: nextState.step },
    });
  }

  if (expects === "amounts") {
    const { paying, affordable } = extractAmounts(userText);

    const nextState: ChatState = {
      ...state,
      paying: typeof paying === "number" ? paying : state.paying ?? null,
      affordable: typeof affordable === "number" ? affordable : state.affordable ?? null,
    };

    const haveBoth = typeof nextState.paying === "number" && typeof nextState.affordable === "number";

    if (!haveBoth) {
      const ask =
        "Thanks. Roughly what do you pay towards all debts each month, and what would feel affordable? For example: “I pay £600 and could afford £200.”";
      return res.status(200).json({
        reply: ask,
        state: { ...nextState, lastPromptKey: promptKey(state.step, ask), lastStepPrompted: state.step },
      });
    }

    nextState.step = state.step + 1;
    const nextStepDef = nextScriptPrompt(script, nextState);
    const nextPromptFull = nextStepDef?.prompt || "Is there anything urgent like bailiff action or missed priority bills?";
    const nextP = cleanPromptAndUi(nextPromptFull);

    const ack = buildAcknowledgement(userText, state);
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, nextP.clean),
      uiTrigger: nextP.ui.uiTrigger,
      popup: nextP.ui.popup,
      portalTab: nextP.ui.portalTab,
      openPortal: nextP.ui.openPortal,
      state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextP.clean), lastStepPrompted: nextState.step },
    });
  }

  // Advance on "free" scripted prompts to prevent repeating "main issue" style questions
  if (expects === "free" && script.steps?.length) {
    const meaningful = userText.trim().length >= 2;
    if (meaningful) {
      const nextState: ChatState = { ...state, step: Math.min(state.step + 1, Math.max(script.steps.length - 1, 0)) };
      const nextStepDef = nextScriptPrompt(script, nextState);
      const nextPromptFull = nextStepDef?.prompt || prompt;
      const nextP = cleanPromptAndUi(nextPromptFull);

      const ack = buildAcknowledgement(userText, state);
      return res.status(200).json({
        reply: joinAckAndPrompt(ack, nextP.clean),
        uiTrigger: nextP.ui.uiTrigger,
        popup: nextP.ui.popup,
        portalTab: nextP.ui.portalTab,
        openPortal: nextP.ui.openPortal,
        state: { ...nextState, lastPromptKey: promptKey(nextState.step, nextP.clean), lastStepPrompted: nextState.step },
      });
    }
  }

  const scriptPrompt = stripLeadingIntroFromPrompt(prompt) || prompt;
  const openAiReply = await callOpenAI({
    userText,
    history,
    language,
    state,
    scriptStepPrompt: scriptPrompt,
  });

  if (openAiReply) {
    return res.status(200).json({
      reply: openAiReply,
      state: { ...state },
    });
  }

  const ack = buildAcknowledgement(userText, state);
  const follow = state.step === 0 ? step0Variant(currentPromptClean) : currentPromptClean;

  const key = promptKey(state.step, follow);
  if (state.lastPromptKey === key) {
    const alt =
      state.step === 0
        ? "When you’re ready, tell me what’s brought you here about your debts today."
        : "When you’re ready, we can carry on from where we left off.";
    return res.status(200).json({
      reply: joinAckAndPrompt(ack, alt),
      state: { ...state, lastPromptKey: promptKey(state.step, alt), lastStepPrompted: state.step },
    });
  }

  return res.status(200).json({
    reply: joinAckAndPrompt(ack, follow),
      uiTrigger: currentParsed.uiTrigger,
      popup: currentParsed.popup,
      portalTab: currentParsed.portalTab,
      openPortal: currentParsed.openPortal,
    state: { ...state, lastPromptKey: key, lastStepPrompted: state.step },
  });
}