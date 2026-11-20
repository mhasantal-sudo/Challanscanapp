import type {
  AppSettings,
  ChallanRecord,
  KhatConfig,
  LicenseFeeConfig,
  OfficialChallanData,
} from '../types.ts';

export const CHALLAN_CATEGORIES = [
  'খাদ্য বান্ধব',
  'ওএমএস সাধারণ',
  'ওএমএস বিশেষ',
  'ওএমএস টিসিবি',
  'ইপি চাল',
  'ইপি গম',
  'খাদ্য বান্ধব লাইসেন্স',
  'ওএমএস লাইসেন্স',
  'ফুড গ্রেইন লাইসেন্স (খুচরা)',
  'ফুড গ্রেইন লাইসেন্স (পাইকারি)',
  'জরিমানা বিবিধ',
  'অন্যান্য চালান',
] as const;

export const DEFAULT_LICENSE_FEES: LicenseFeeConfig[] = [
  {
    khatName: 'খাদ্য বান্ধব লাইসেন্স',
    newFee: 1000,
    renewalFee: 500,
    vatAmount: 150,
    taxAmount: 100,
  },
  {
    khatName: 'ওএমএস লাইসেন্স',
    newFee: 2000,
    renewalFee: 1000,
    vatAmount: 300,
    taxAmount: 200,
  },
  {
    khatName: 'ফুড গ্রেইন লাইসেন্স (খুচরা)',
    newFee: 1000,
    renewalFee: 500,
    vatAmount: 150,
    taxAmount: 100,
  },
  {
    khatName: 'ফুড গ্রেইন লাইসেন্স (পাইকারি)',
    newFee: 5000,
    renewalFee: 2500,
    vatAmount: 750,
    taxAmount: 500,
  },
  {
    khatName: 'জরিমানা বিবিধ',
    newFee: 0,
    renewalFee: 0,
    vatAmount: 0,
    taxAmount: 0,
  },
];

export const DEFAULT_KHATS: KhatConfig[] = [
  {
    id: 'khat-khaddo-bandhob',
    name: 'খাদ্য বান্ধব',
    group: 'grain',
    iconKey: 'wheat',
    colorKey: 'rose',
    hasIncomeTax: true,
    hasVat: false,
    showQuantityRate: true,
    active: true,
  },
  {
    id: 'khat-oms-general',
    name: 'ওএমএস সাধারণ',
    group: 'grain',
    iconKey: 'bag',
    colorKey: 'sky',
    hasIncomeTax: true,
    hasVat: false,
    showQuantityRate: true,
    active: true,
  },
  {
    id: 'khat-oms-special',
    name: 'ওএমএস বিশেষ',
    group: 'grain',
    iconKey: 'bag',
    colorKey: 'indigo',
    hasIncomeTax: true,
    hasVat: false,
    showQuantityRate: true,
    active: true,
  },
  {
    id: 'khat-oms-tcb',
    name: 'ওএমএস টিসিবি',
    group: 'grain',
    iconKey: 'bag',
    colorKey: 'purple',
    hasIncomeTax: true,
    hasVat: false,
    showQuantityRate: true,
    active: true,
  },
  {
    id: 'khat-ep-rice',
    name: 'ইপি চাল',
    group: 'grain',
    iconKey: 'flame',
    colorKey: 'amber',
    hasIncomeTax: true,
    hasVat: false,
    showQuantityRate: true,
    active: true,
  },
  {
    id: 'khat-ep-wheat',
    name: 'ইপি গম',
    group: 'grain',
    iconKey: 'flame',
    colorKey: 'orange',
    hasIncomeTax: true,
    hasVat: false,
    showQuantityRate: true,
    active: true,
  },
  {
    id: 'khat-lic-khaddo',
    name: 'খাদ্য বান্ধব লাইসেন্স',
    group: 'license',
    subGroup: 'new',
    iconKey: 'wheat',
    colorKey: 'rose',
    hasIncomeTax: true,
    hasVat: true,
    showQuantityRate: false,
    active: true,
  },
  {
    id: 'khat-lic-oms',
    name: 'ওএমএস লাইসেন্স',
    group: 'license',
    subGroup: 'new',
    iconKey: 'bag',
    colorKey: 'sky',
    hasIncomeTax: true,
    hasVat: true,
    showQuantityRate: false,
    active: true,
  },
  {
    id: 'khat-lic-retail',
    name: 'ফুড গ্রেইন লাইসেন্স (খুচরা)',
    group: 'license',
    subGroup: 'new',
    iconKey: 'license',
    colorKey: 'teal',
    hasIncomeTax: true,
    hasVat: true,
    showQuantityRate: false,
    active: true,
  },
  {
    id: 'khat-lic-wholesale',
    name: 'ফুড গ্রেইন লাইসেন্স (পাইকারি)',
    group: 'license',
    subGroup: 'new',
    iconKey: 'shield',
    colorKey: 'emerald',
    hasIncomeTax: true,
    hasVat: true,
    showQuantityRate: false,
    active: true,
  },
  {
    id: 'khat-fine',
    name: 'জরিমানা বিবিধ',
    group: 'license',
    subGroup: 'fine',
    iconKey: 'alert',
    colorKey: 'red',
    hasIncomeTax: false,
    hasVat: false,
    showQuantityRate: false,
    active: true,
  },
  {
    id: 'khat-other',
    name: 'অন্যান্য চালান',
    group: 'license',
    subGroup: 'other',
    iconKey: 'receipt',
    colorKey: 'indigo',
    hasIncomeTax: true,
    hasVat: true,
    showQuantityRate: false,
    active: true,
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  officeTitle: 'উজিরপুর, বরিশাল',
  officeSubtitle: 'উপজেলা খাদ্য নিয়ন্ত্রকের কার্যালয়',
  spreadsheetId: '1uJkb4qs5cAHb78tJA9hmKuUCz5boDcSwKJ0X4dcmO4Q',
  challanTabName: 'Challan',
  suballocationTabName: 'Dealer_Suballocation',
  foodDealerTabName: 'Food_Dealer',
  omsDealerTabName: 'OMS_Dealers',
  doIssueTabName: 'DO_Issue',
  separateVatTabName: 'License_VAT_Log',
  syncMethod: 'both',
  gasWebAppUrl: '',
  allowedEmails: ['foodchannelregister@gmail.com'],
  lockEnabled: false,
  hideDealerIds: true,
  dashboardPageSize: 15,
  officerName: '',
  officerSignatureText: 'উপজেলা খাদ্য নিয়ন্ত্রক',
  officerSignatureImageDataUrl: '',
  licenseFees: DEFAULT_LICENSE_FEES,
  customColumns: [],
  khats: DEFAULT_KHATS,
};

export const OFFICIAL_VERIFICATION_BASE =
  'https://challanverification.finance.gov.bd/echalan/index.php';

export function toEnglishDigits(
  value: string | number | null | undefined
): string {
  return String(value ?? '').replace(/[০-৯]/g, (d) =>
    String('০১২৩৪৫৬৭৮৯'.indexOf(d))
  );
}

export function toBengaliDigits(
  value: string | number | null | undefined
): string {
  const bn = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(value ?? '').replace(/[0-9]/g, (d) => bn[Number(d)] ?? d);
}

export function extractSpreadsheetId(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const urlMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1].trim();
  }
  return raw;
}

export function getOfficialVerificationUrl(challanNo: string): string {
  const cleaned = toEnglishDigits(challanNo).trim();
  const m = cleaned.match(/^(\d{4})-(\d{10,11})$/);
  const queryNo = m ? `${m[1]}-${m[2].slice(0, 10)}` : cleaned;
  return `${OFFICIAL_VERIFICATION_BASE}?challanNo=${encodeURIComponent(queryNo)}`;
}

/**
 * চালান নম্বরের শেষে কমন ১ (১১ অঙ্ক):
 * "YYYY-" এর পরে ঠিক ১০ অঙ্ক এলে শেষে ১ বসিয়ে ১১ অঙ্ক করে।
 * ১১ অঙ্ক থাকলে হুবহু ১১ অঙ্কই রাখে। কখনো শেষের ১ বাদ দেবে না।
 */
export function normalizeChallanNo(no: string): string {
  const s = toEnglishDigits(no).trim();
  const m = s.match(/^(\d{4})\s*-\s*(\d+)$/);
  if (!m) return s;
  const body = m[2].length === 10 ? m[2] + '1' : m[2];
  return `${m[1]}-${body}`;
}

export function cleanChallanNo(no: string | null | undefined): string {
  const s = normalizeChallanNo(String(no ?? ''));
  if (!s) return '';
  const low = s.toLowerCase();
  if (
    low === '11' ||
    low === '1' ||
    low === '0' ||
    low === '-' ||
    low === '—' ||
    low === 'n/a' ||
    low === 'na' ||
    low === 'null' ||
    low === 'undefined'
  ) {
    return '';
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length < 5) return '';
  return s;
}

export function isValidChallanNo(no: string | null | undefined): boolean {
  return Boolean(cleanChallanNo(no));
}

export type ChallanSlot = 'main' | 'tax' | 'vat';

export function getChallanSlotLabel(slot: ChallanSlot): string {
  if (slot === 'tax') return 'আয়কর চালান (Col M)';
  if (slot === 'vat') return 'ভ্যাট চালান (Col S)';
  return 'মূল চালান (Col H)';
}

export interface ChallanConflictResult {
  number: string;
  incomingSlot: ChallanSlot;
  existingSlot: ChallanSlot;
  existingRecord?: ChallanRecord;
  intraRow?: boolean;
  message: string;
}

/**
 * সম্পূর্ণ শিট/ডেটাবেজের মূল, আয়কর ও ভ্যাট — এই তিনটি কলামের মধ্যে
 * কোনো চালান নম্বর দ্বিতীয়বার থাকলে তা শনাক্ত করে বাধা দেয়।
 */
export function findChallanConflictInRecords(
  records: ChallanRecord[],
  incoming: { main?: string; tax?: string; vat?: string },
  excludeRecordId?: string
): ChallanConflictResult | null {
  const main = cleanChallanNo(incoming.main);
  const tax = cleanChallanNo(incoming.tax);
  const vat = cleanChallanNo(incoming.vat);

  if (main && tax && main === tax) {
    return {
      number: main,
      incomingSlot: 'tax',
      existingSlot: 'main',
      intraRow: true,
      message: `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${main}) মূল চালান ও আয়কর চালান উভয় ঘরে থাকতে পারবে না।`,
    };
  }
  if (main && vat && main === vat) {
    return {
      number: main,
      incomingSlot: 'vat',
      existingSlot: 'main',
      intraRow: true,
      message: `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${main}) মূল চালান ও ভ্যাট চালান উভয় ঘরে থাকতে পারবে না।`,
    };
  }
  if (tax && vat && tax === vat) {
    return {
      number: tax,
      incomingSlot: 'vat',
      existingSlot: 'tax',
      intraRow: true,
      message: `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${tax}) আয়কর চালান ও ভ্যাট চালান উভয় ঘরে থাকতে পারবে না।`,
    };
  }

  const incomingEntries: Array<{ slot: ChallanSlot; num: string }> = [];
  if (main) incomingEntries.push({ slot: 'main', num: main });
  if (tax) incomingEntries.push({ slot: 'tax', num: tax });
  if (vat) incomingEntries.push({ slot: 'vat', num: vat });

  if (incomingEntries.length === 0) return null;

  for (const r of records) {
    if (excludeRecordId && r.recordId === excludeRecordId) continue;

    const rMain = cleanChallanNo(r.challanNo);
    const rTax = cleanChallanNo(r.incomeTaxChallanNo);
    const rVat = cleanChallanNo(r.vatChallanNo);

    for (const item of incomingEntries) {
      let matchedSlot: ChallanSlot | null = null;
      if (rMain && rMain === item.num) matchedSlot = 'main';
      else if (rTax && rTax === item.num) matchedSlot = 'tax';
      else if (rVat && rVat === item.num) matchedSlot = 'vat';

      if (matchedSlot) {
        const who = r.dealerName ? ` (${r.dealerName})` : '';
        return {
          number: item.num,
          incomingSlot: item.slot,
          existingSlot: matchedSlot,
          existingRecord: r,
          message: `বাধা দেওয়া হয়েছে: চালান নম্বর ${item.num} সম্পূর্ণ শিটে কেবল একবারই থাকবে — এটি আগে থেকেই ক্রমিক ${r.serialNo}${who}-এর ${getChallanSlotLabel(matchedSlot)} হিসেবে সংরক্ষিত আছে! দ্বিতীয়বার যোগ করা যাবে না।`,
        };
      }
    }
  }

  return null;
}

export function extractChallanInfo(rawValue: string): {
  number: string;
  normalized11: string;
  url: string;
} {
  const text = toEnglishDigits(rawValue).trim();
  if (!text) {
    throw new Error('QR থেকে কোনো তথ্য পাওয়া যায়নি।');
  }

  const cnoMatch = text.match(/\bCNO\s*:\s*([A-Za-z0-9-]+)/i);
  if (cnoMatch) {
    const number = cnoMatch[1].trim();
    const normalized11 = normalizeChallanNo(number);
    return {
      number: normalized11,
      normalized11,
      url: getOfficialVerificationUrl(normalized11),
    };
  }

  const urlMatch = text.match(
    /https?:\/\/challanverification\.finance\.gov\.bd\/echalan\/index\.php\?[^\s"'<>]+/i
  );
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[0]);
      const number = url.searchParams.get('challanNo');
      if (number) {
        const normalized11 = normalizeChallanNo(number.trim());
        return {
          number: normalized11,
          normalized11,
          url: getOfficialVerificationUrl(normalized11),
        };
      }
    } catch {
      // ignore malformed URL
    }
  }

  const anyUrlMatch = text.match(/https?:\/\/[^\s"'<>]+challanNo=([0-9-]+)/i);
  if (anyUrlMatch) {
    const normalized11 = normalizeChallanNo(anyUrlMatch[1].trim());
    return {
      number: normalized11,
      normalized11,
      url: getOfficialVerificationUrl(normalized11),
    };
  }

  const numberMatch = text.match(/\b\d{4}\s*-\s*\d{10,11}\b/);
  if (numberMatch) {
    const normalized11 = normalizeChallanNo(numberMatch[0]);
    return {
      number: normalized11,
      normalized11,
      url: getOfficialVerificationUrl(normalized11),
    };
  }

  throw new Error('QR-এর লেখায় চালান নম্বর শনাক্ত করা যায়নি।');
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** যেকোনো ফরম্যাটের তারিখ (dd/MM/yyyy, dd-MMM-yyyy, Date(...), yyyy-MM-dd) -> বছর-মাস-তারিখ (yyyy-MM-dd) */
export function normalizeChallanDate(v: string | null | undefined): string {
  const t = toEnglishDigits(v).trim();
  if (!t) return '';
  // Handle Google Sheets gviz literal Date(yyyy, zeroBasedMonth, day)
  const gviz = t.match(/^Date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})/);
  if (gviz) {
    const y = Number(gviz[1]);
    const mo = Number(gviz[2]) + 1;
    const d = Number(gviz[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const isoMatch = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:$|T|\s)/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const mo = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const monMatch = t.match(/^(\d{1,2})[\s/\-.]([A-Za-z]+)[\s/\-.](\d{4}|\d{2})$/);
  if (monMatch) {
    const d = Number(monMatch[1]);
    const mo = MONTH_NAME_MAP[monMatch[2].toLowerCase()];
    const y = monMatch[3].length === 2 ? 2000 + Number(monMatch[3]) : Number(monMatch[3]);
    if (mo && d >= 1 && d <= 31 && y >= 1970 && y <= 2100) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const dmyMatch = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
  if (dmyMatch) {
    const p1 = Number(dmyMatch[1]);
    const p2 = Number(dmyMatch[2]);
    const year = dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3];
    // Handle clear MDY fallback if second segment > 12 and first <= 12
    const day = p2 > 12 && p1 >= 1 && p1 <= 12 ? p2 : p1;
    const month = p2 > 12 && p1 >= 1 && p1 <= 12 ? p1 : p2;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return t;
}

/**
 * যেকোনো বৈধ তারিখ (dd/MM/yyyy বা yyyy-MM-dd) -> Unambiguous ISO yyyy-MM-dd
 * Google Sheet-এ yyyy-MM-dd পাঠালে তারিখ ১২ বা তার কম হলেও দিন ও মাস কখনোই উল্টায় না।
 */
export function toSheetIsoDate(value: string | null | undefined): string {
  const t = toEnglishDigits(value).trim();
  if (!t) return '';
  const gviz = t.match(/^Date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})/);
  if (gviz) {
    const y = Number(gviz[1]);
    const mo = Number(gviz[2]) + 1;
    const d = Number(gviz[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const isoMatch = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:$|T|\s)/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const mo = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    const chk = new Date(y, mo - 1, d);
    if (
      y >= 1970 &&
      y <= 2100 &&
      mo >= 1 &&
      mo <= 12 &&
      chk.getFullYear() === y &&
      chk.getMonth() === mo - 1 &&
      chk.getDate() === d
    ) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const parsedIso = parseInputDate(t);
  return parsedIso || t;
}

/**
 * Google Sheet-এ লেখার জন্য তারিখ ফরম্যাটার — সব লোক্যালে নিরাপদ করতে yyyy-MM-dd প্রদান করে
 */
export function toSheetSlashDate(dateStr: string): string {
  return toSheetIsoDate(dateStr);
}

/** দুটি dd/MM/yyyy বা yyyy-MM-dd তারিখ পরস্পরের উল্টানো (day <-> month swapped) কি না */
export function areSwappedMonthDayDates(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const da = toSheetIsoDate(a);
  const db = toSheetIsoDate(b);
  const ma = da.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mb = db.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!ma || !mb) return false;
  return (
    ma[1] === mb[1] &&
    ma[2] === mb[3] &&
    ma[3] === mb[2] &&
    ma[2] !== ma[3]
  );
}

/** রেকর্ডের জমার মাসের ২-অঙ্কের কোড (যেমন "07", "09") */
export function getChallanMonth(r: ChallanRecord): string {
  const candidate = toSheetIsoDate(
    r.challanDate || r.incomeTaxDate || r.vatDate || r.date || ''
  );
  const m = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[2] : '';
}

/** যেকোনো তারিখ থেকে YYYY-MM মাস-কী বের করে */
export function getYearMonthKey(dateVal: string | null | undefined): string {
  const iso = toSheetIsoDate(dateVal || '');
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}` : '';
}

/** দুটি তারিখ একই মাসে (YYYY-MM) আছে কি না (একটি ফাঁকা থাকলে true) */
export function isSameYearMonth(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const ymA = getYearMonthKey(a);
  const ymB = getYearMonthKey(b);
  if (!ymA || !ymB) return true;
  return ymA === ymB;
}

/** মূল/আয়কর/ভ্যাট সহায়ক সারির বেস আইডি (যেমন CHL-123-TAX -> CHL-123) */
export function getCleanBaseRecordId(id: string | null | undefined): string {
  return String(id || '')
    .trim()
    .replace(/-(?:TAX|VAT)$/i, '')
    .trim();
}

/** যেকোনো তারিখ -> yyyy-MM-dd */
export function showDate(iso: string | null | undefined): string {
  const raw = String(iso || '').trim();
  if (!raw) return '';
  return toSheetIsoDate(raw) || raw;
}

/** dd/MM/yyyy (or dd/MM/yy or yyyy-MM-dd) -> yyyy-MM-dd (validates real calendar date) */
export function parseInputDate(v: string): string {
  const t = toEnglishDigits(v).trim();
  const iso = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:$|T|\s)/);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    const chk = new Date(y, mo - 1, d);
    if (
      y >= 1970 &&
      y <= 2100 &&
      mo >= 1 &&
      mo <= 12 &&
      d >= 1 &&
      chk.getFullYear() === y &&
      chk.getMonth() === mo - 1 &&
      chk.getDate() === d
    ) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return '';
  }

  const monMatch = t.match(/^(\d{1,2})[\s/\-.]([A-Za-z]+)[\s/\-.](\d{4}|\d{2})$/);
  if (monMatch) {
    const d = Number(monMatch[1]);
    const mo = MONTH_NAME_MAP[monMatch[2].toLowerCase()];
    const y = monMatch[3].length === 2 ? 2000 + Number(monMatch[3]) : Number(monMatch[3]);
    if (mo) {
      const chkMon = new Date(y, mo - 1, d);
      if (
        y >= 1970 &&
        y <= 2100 &&
        d >= 1 &&
        chkMon.getFullYear() === y &&
        chkMon.getMonth() === mo - 1 &&
        chkMon.getDate() === d
      ) {
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
    return '';
  }

  const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
  if (!m) return '';
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const chk = new Date(y, mo - 1, d);
  if (
    y < 1970 ||
    y > 2100 ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    chk.getFullYear() !== y ||
    chk.getMonth() !== mo - 1 ||
    chk.getDate() !== d
  ) {
    return '';
  }
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parse deposit date on a ChallanRecord into sortable ISO yyyy-MM-dd */
export function getChallanDepositSortKey(r: ChallanRecord): string {
  const candidate =
    r.challanDate || r.incomeTaxDate || r.vatDate || r.date || '';
  const norm = normalizeChallanDate(candidate);
  const iso = parseInputDate(norm);
  if (iso) return iso;
  const m = toEnglishDigits(candidate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '0000-00-00';
}

export function maskDateInput(raw: string): string {
  const trimmed = toEnglishDigits(raw).trim();
  if (/^\d{1,2}[\/.]\d{1,2}[\/.]\d{4}$/.test(trimmed)) {
    const flipped = parseInputDate(trimmed);
    if (flipped) return flipped;
  }
  const t = trimmed.replace(/\D/g, '').slice(0, 8);
  if (t.length > 6) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`;
  if (t.length > 4) return `${t.slice(0, 4)}-${t.slice(4)}`;
  return t;
}

export function formatMoney(
  value: string | number | null | undefined
): string {
  const cleaned = toEnglishDigits(value)
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : '0.00';
}

export function toNumericValue(
  value: string | number | null | undefined
): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = toEnglishDigits(value)
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function scoreBengaliNameSimilarity(a: string, b: string): number {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/মোঃ|মো:|মোহাম্মদ|md\.?|মেসার্স|m\/s|প্রোঃ|পিতা|ঠিকানা/gi, ' ')
      .replace(/[.,\-_:;()'"/\s]+/g, ' ')
      .trim()
      .replace(/ী/g, 'ি')
      .replace(/ূ/g, 'ু')
      .replace(/শ|ষ/g, 'স')
      .replace(/ণ/g, 'ন')
      .replace(/য়/g, 'য');

  const na = clean(a);
  const nb = clean(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.92;

  const tokensA = new Set(na.split(' ').filter((t) => t.length > 1));
  const tokensB = new Set(nb.split(' ').filter((t) => t.length > 1));
  let tokenMatches = 0;
  for (const ta of tokensA) {
    for (const tb of tokensB) {
      if (ta === tb || ta.includes(tb) || tb.includes(ta)) {
        tokenMatches++;
        break;
      }
    }
  }
  const tokenScore =
    tokensA.size + tokensB.size > 0
      ? (2 * tokenMatches) / (tokensA.size + tokensB.size)
      : 0;

  const bigrams = (str: string) => {
    const compact = str.replace(/\s+/g, '');
    const list: string[] = [];
    for (let i = 0; i < compact.length - 1; i++) {
      list.push(compact.slice(i, i + 2));
    }
    return list;
  };
  const bgA = bigrams(na);
  const bgB = bigrams(nb);
  if (bgA.length === 0 || bgB.length === 0) return tokenScore;

  const mapB = new Map<string, number>();
  for (const g of bgB) mapB.set(g, (mapB.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of bgA) {
    const count = mapB.get(g) || 0;
    if (count > 0) {
      overlap++;
      mapB.set(g, count - 1);
    }
  }
  const dice = (2 * overlap) / (bgA.length + bgB.length);
  return Math.max(dice, tokenScore * 0.95);
}

export function extractEconomicCodes(data: OfficialChallanData): Array<{
  code: string;
  name: string;
  amount: string;
}> {
  const out: Array<{ code: string; name: string; amount: string }> = [];
  const seen = new Set<string>();

  if (data.New37Code && data.New37Code.trim()) {
    const code = toEnglishDigits(data.New37Code).trim();
    seen.add(code);
    out.push({
      code,
      name: data.ChallanTypeNameBn || 'মূল অর্থনৈতিক কোড',
      amount: toEnglishDigits(String(data.Amount || '')).replace(/,/g, ''),
    });
  }

  if (Array.isArray(data.Economics)) {
    for (const item of data.Economics) {
      const code = toEnglishDigits(
        String(item.EconomicNew37Code || item.EconomicCode || '')
      ).trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        name: String(
          item.EconomicNameBn || item.EconomicRemarks || 'অর্থনৈতিক কোড'
        ).trim(),
        amount: toEnglishDigits(String(item.EconomicAmount || '')).replace(
          /,/g,
          ''
        ),
      });
    }
  }

  // Prefer the longest full code (e.g., 13-digit full New37Code over a 7-digit base code) first
  out.sort((a, b) => {
    const lenA = a.code.replace(/\D/g, '').length;
    const lenB = b.code.replace(/\D/g, '').length;
    return lenB - lenA;
  });

  return out;
}

export const COMMISSION_TAX_CATEGORIES = new Set([
  'খাদ্য বান্ধব',
  'ওএমএস সাধারণ',
  'ওএমএস বিশেষ',
  'ওএমএস টিসিবি',
]);

export function isCommissionTaxCategory(category?: string | null): boolean {
  const cat = String(category || '').trim();
  if (!cat) return false;
  if (COMMISSION_TAX_CATEGORIES.has(cat)) return true;
  if (cat.includes('লাইসেন্স')) return false;
  return cat.startsWith('খাদ্য বান্ধব') || cat.startsWith('ওএমএস');
}

export function getFiscalYearLabelFromChallan(
  dateStr?: string | null,
  challanNo?: string | null
): string {
  const normDate = normalizeChallanDate(String(dateStr || '').trim());
  const isoMatch = normDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    if (year >= 2000 && month >= 1 && month <= 12) {
      return month >= 7
        ? `${year}-${String(year + 1).slice(-2)}`
        : `${year - 1}-${String(year).slice(-2)}`;
    }
  }

  const cleanNo = toEnglishDigits(String(challanNo || '')).trim();
  const prefixMatch = cleanNo.match(/^(\d{2})(\d{2})-/);
  if (prefixMatch) {
    const y1 = Number(prefixMatch[1]);
    const y2 = Number(prefixMatch[2]);
    if (y2 === (y1 + 1) % 100) {
      return `20${prefixMatch[1]}-${prefixMatch[2]}`;
    }
  }

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= 7 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
}

export function buildDefaultCommissionTaxComment(
  category?: string | null,
  taxDate?: string | null,
  taxChallanNo?: string | null
): string {
  if (!isCommissionTaxCategory(category)) return '';
  const fy = getFiscalYearLabelFromChallan(taxDate, taxChallanNo);
  return `করবর্ষ ${fy} এর জন্য আয়কর ধারা ৯৪ অনুযায়ী INCOME TAX ON 10% COMMISSION`;
}

export function extractRemarksFromOfficialPayload(
  data: OfficialChallanData,
  knownCodes?: string[]
): string {
  const remarks = String(data.Remarks || '').trim();
  const econRemarks = Array.isArray(data.Economics)
    ? data.Economics.map((e) => String(e.EconomicRemarks || '').trim())
        .filter(Boolean)
        .join('\n')
    : '';
  const rawRemarks = (remarks || econRemarks).replace(/[ \t]{2,}/g, ' ').trim();
  if (!rawRemarks) return '';
  const codes =
    knownCodes && knownCodes.length > 0
      ? knownCodes
      : extractEconomicCodes(data).map((o) => o.code);
  return stripEconomicCodeText(rawRemarks, codes)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function parseOfficialRemarks(data: OfficialChallanData): {
  department: string;
  toOrganization: string;
  submittedThrough: string;
  submittedOnBehalfOf: string;
  challanNo: string;
  new37Code: string;
  economicOptions: Array<{ code: string; name: string; amount: string }>;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  challanDate: string;
} {
  const remarks = String(data.Remarks || '').trim();
  const econRemarks = Array.isArray(data.Economics)
    ? data.Economics.map((e) => String(e.EconomicRemarks || '').trim())
        .filter(Boolean)
        .join('\n')
    : '';
  const rawRemarks = remarks || econRemarks;
  const org = data.ToOrgNameBn || data.OrgNameBn || '';
  const economicOptions = extractEconomicCodes(data);

  const econCode =
    economicOptions[0]?.code ||
    extractEconomicCodeFromText(
      [org, data.ChallanTypeNameBn, rawRemarks].filter(Boolean).join(' ')
    );

  const allCodes = [econCode, ...economicOptions.map((o) => o.code)].filter(Boolean);
  const normalizedRemarks = toEnglishDigits(rawRemarks);

  const ratePerMtMatch = normalizedRemarks.match(
    /(?:PER\s*MT\s*TK\.?\s*|প্রতি\s*(?:মে\.?\s*টন|মেট্রিক\s*টন)\s*)([0-9]+(?:\.[0-9]+)?)/i
  );
  const ratePerKgMatch = normalizedRemarks.match(
    /প্রতি\s*কেজি\s*([0-9]+(?:\.[0-9]+)?)\s*টাকা/
  );
  const quantityMatch = normalizedRemarks.match(
    /([0-9]+(?:\.[0-9]+)?)\s*(?:MT\*?|মে\.?\s*টন|মেট্রিক\s*টন)/i
  );

  let rate = '';
  if (ratePerMtMatch) {
    rate = ratePerMtMatch[1];
  } else if (ratePerKgMatch) {
    rate = ratePerKgMatch[1];
  }

  return {
    department: org,
    toOrganization: org,
    submittedThrough: data.NameBn || data.ClientByNameBn || '',
    submittedOnBehalfOf: data.ClientForNameBn || data.NameBn || '',
    challanNo: normalizeChallanNo(data.ChallanNo || ''),
    new37Code: econCode,
    economicOptions,
    description: extractRemarksFromOfficialPayload(data, allCodes),
    quantity: quantityMatch ? quantityMatch[1] : '',
    rate,
    amount: toEnglishDigits(String(data.Amount || '')).replace(/,/g, ''),
    challanDate: normalizeChallanDate(data.ChallanDate),
  };
}

export function extractEconomicCodeFromText(text: string): string {
  const src = toEnglishDigits(String(text || ''));
  if (!src.trim()) return '';

  const isChallanOrPhone = (cand: string) => {
    const clean = cand.trim();
    if (/^\d{4}-\d{10,11}$/.test(clean)) return true; // Challan number YYYY-XXXXXXXXXX(1)
    const digits = clean.replace(/\D/g, '');
    if (/^01\d{9}$/.test(digits)) return true; // BD mobile number
    return false;
  };

  const labeledRe =
    /(?:অর্থনৈতিক|নতুন|হিসাব|খাত|জমা[র]?|মূল|ট্রেজারি|Economic|Account|Treasury|New)?\s*(?:কোড|Code)\s*(?:নং|নম্বর|No\.?)?\s*[:：=-]?\s*(\d(?:[\d-]{3,45}\d))/gi;
  let m: RegExpExecArray | null;
  while ((m = labeledRe.exec(src)) !== null) {
    const candidate = m[1].replace(/^-+|-+$/g, '').trim();
    if (!isChallanOrPhone(candidate) && candidate.replace(/\D/g, '').length >= 6) {
      return candidate;
    }
  }

  const standaloneRe =
    /(?<![.\d/-])(\d{6,14}-\d{8,16}-\d{6,10}-\d{6,8}|\d-\d{4}-\d{4}-\d{4}|[1-9]\d{12}|[1-9]\d{6})(?![.\d/-])(?!\s*(?:টাকা|Tk|BDT|কেজি|kg|মে\.?\s*টন|মেট্রিক|MT|%))/gi;
  const found: string[] = [];
  while ((m = standaloneRe.exec(src)) !== null) {
    const candidate = m[1].trim();
    if (!isChallanOrPhone(candidate)) {
      found.push(candidate);
    }
  }
  if (found.length === 0) return '';
  // Prefer longest code (37-digit or 13-digit over 7-digit)
  found.sort((a, b) => b.replace(/\D/g, '').length - a.replace(/\D/g, '').length);
  return found[0];
}

export function stripEconomicCodeText(
  text: string,
  knownCode?: string | string[]
): string {
  if (!text) return '';
  let out = String(text).replace(/\r\n/g, '\n');

  // 1. Remove explicit labeled code clauses such as "কোড: 1422319", "(Code: 1111101100001)", "অর্থনৈতিক কোড- ১-১১৪১-০০০১-০৩১১"
  out = out.replace(
    /[(\[]?\s*(?:অর্থনৈতিক|নতুন|হিসাব|খাত|জমা[র]?|মূল|ট্রেজারি|Economic|Account|Treasury|New)?\s*(?:কোড|Code)\s*(?:নং|নম্বর|No\.?)?\s*[:：=-]?\s*[0-9০-৯][0-9০-৯-]{3,45}\s*[)\]]?/gi,
    ' '
  );

  // 2. Remove occurrences of the known economic code(s) (EN or BN), including 7-digit base if 13-digit/37-digit code
  const knownList = Array.isArray(knownCode)
    ? knownCode
    : knownCode
      ? [knownCode]
      : [];
  const candidates = new Set<string>();
  for (const rawKnown of knownList) {
    const cleanKnownRaw = toEnglishDigits(String(rawKnown || '')).trim();
    const cleanKnown = cleanKnownRaw.replace(/[^0-9]/g, '').trim();
    if (cleanKnownRaw && cleanKnownRaw.replace(/\D/g, '').length >= 4) {
      candidates.add(cleanKnownRaw);
    }
    if (cleanKnown && cleanKnown.length >= 4) {
      candidates.add(cleanKnown);
      if (cleanKnown.length >= 13) {
        candidates.add(cleanKnown.slice(0, 7));
      }
      if (cleanKnownRaw.includes('-')) {
        const segs = cleanKnownRaw.split('-').filter(Boolean);
        const tail = segs[segs.length - 1];
        if (tail && tail.length >= 7) {
          candidates.add(tail);
        }
      }
    }
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const code of candidates) {
    const bnCode = toBengaliDigits(code);
    for (const variant of [code, bnCode]) {
      const parenRe = new RegExp(`[(\\[]\\s*${esc(variant)}\\s*[)\\]]`, 'g');
      const tokenRe = new RegExp(
        `(?<![.\\d০-৯/-])${esc(variant)}(?![.\\d০-৯/-])`,
        'g'
      );
      out = out.replace(parenRe, ' ').replace(tokenRe, ' ');
    }
  }

  // 3. Remove any standalone 7-digit, 13-digit, or dashed economic code left in the middle (excluding BD mobile numbers 01... and challan YYYY-XXXXXXXXXX(1))
  out = out.replace(
    /[(\[]?\s*(?<![.\d০-৯/-])(?:[0-9০-৯]{6,14}-[0-9০-৯]{8,16}-[0-9০-৯]{6,10}-[0-9০-৯]{6,8}|[1-9১-৯][0-9০-৯]{6}|[1-9১-৯][0-9০-৯]{12}|[0-9০-৯]-[0-9০-৯]{4}-[0-9০-৯]{4}-[0-9০-৯]{4})(?![.\d০-৯/-])(?!\s*(?:টাকা|Tk|BDT|কেজি|kg|মে\.?\s*টন|মেট্রিক|MT|%))\s*[)\]]?/gi,
    ' '
  );

  // 4. Clean empty brackets and collapse dangling horizontal whitespace while preserving verbatim text and newlines
  out = out
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/,\s*,+/g, ', ')
    .replace(/[^\S\r\n]*[—-][^\S\r\n]*(?=[—-])/g, ' ')
    .replace(/[^\S\r\n]{2,}/g, ' ')
    .replace(/[^\S\r\n]*\n[^\S\r\n]*/g, '\n');

  const parts = out
    .split('|')
    .map((p) =>
      p
        .split('\n')
        .map((ln) =>
          ln
            .replace(/^[\s,;—-]+|[\s,;—-]+$/g, '')
            .replace(/[^\S\r\n]*[—-][^\S\r\n]*[—-]+/g, ' - ')
            .replace(/[^\S\r\n]{2,}/g, ' ')
            .trim()
        )
        .filter(Boolean)
        .join('\n')
        .trim()
    )
    .filter(Boolean);

  return parts.join(' | ');
}

export function splitTaxDepartmentAndExtra(
  rawText: string | null | undefined,
  knownCode?: string
): { institution: string; extra: string; code: string } {
  const rawStr = String(rawText || '');
  const rescuedCode =
    toEnglishDigits(String(knownCode || '')).trim() ||
    extractEconomicCodeFromText(rawStr);
  const cleaned = stripEconomicCodeText(rawStr, rescuedCode)
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return { institution: '', extra: '', code: rescuedCode };

  const barishalMatch = cleaned.match(
    /^(.*?)(কর\s*অঞ্চল\s*,?\s*বরিশাল)(.*)$/is
  );
  if (barishalMatch) {
    const before = barishalMatch[1]
      .replace(/^[\s,|—:-]+|[\s,|—:-]+$/g, '')
      .trim();
    const after = barishalMatch[3]
      .replace(/^[\s,|—:-]+|[\s,|—:-]+$/g, '')
      .trim();
    const extraParts = [before, after].filter(
      (p) => Boolean(p) && p !== 'আয়কর'
    );
    return {
      institution: 'কর অঞ্চল বরিশাল',
      extra: extraParts.join(' - '),
      code: rescuedCode,
    };
  }

  if (
    /(?:কর\s*অঞ্চল|আয়কর|আয়কর|ভ্যাট|VAT|TAX|সার্কেল|কমিশনারেট|কাস্টমস)/i.test(
      cleaned
    )
  ) {
    const parts = cleaned
      .split(
        /\s*(?:\||—|\s-\s|,\s*(?=সার্কেল|উপ-?কর|কমিশনারেট|বিভাগ|অফিস|কার্যালয়|উপজেলা|জেলা))\s*/i
      )
      .map((p) => p.replace(/^[\s,|—:-]+|[\s,|—:-]+$/g, '').trim())
      .filter(Boolean);

    if (parts.length > 1) {
      return {
        institution: parts[0],
        extra: parts.slice(1).join(' - '),
        code: rescuedCode,
      };
    }
  }

  return { institution: cleaned, extra: '', code: rescuedCode };
}

const REMARK_SEGMENT_RE =
  /(?:প্রদানকারী\s*[:：]|নগদ\s*বিক্র[য়য]|সরকারি\s*পাওনা|মেট্রিক\s*টন|মে\.?\s*টন|\bMT\b|টাকা\s*হিসাবে|দরে\s|বাবদ)/i;

export function sanitizeRegisterSubRowText(options: {
  orgText?: string;
  descText?: string;
  commentText?: string;
  knownCode?: string;
  fallbackOrg: string;
}): { orgDesc: string; comment: string; code: string } {
  const rescuedCode =
    toEnglishDigits(String(options.knownCode || '')).trim() ||
    extractEconomicCodeFromText(
      [options.orgText, options.descText, options.commentText]
        .filter(Boolean)
        .join(' ')
    );

  const rawOrgParts = [options.orgText || '', options.descText || '']
    .join(' | ')
    .split(
      /\s*\|\s*|\s+-\s+(?=প্রদানকারী|নগদ\s*বিক্র|কোড)|\s+(?=প্রদানকারী\s*[:：])/
    )
    .map((p) => p.trim())
    .filter(Boolean);

  const keptOrgParts: string[] = [];
  const movedToComment: string[] = [];

  for (const rawPart of rawOrgParts) {
    const cleanedPart = stripEconomicCodeText(rawPart, rescuedCode);
    if (!cleanedPart) continue;
    if (
      REMARK_SEGMENT_RE.test(cleanedPart) ||
      (options.commentText && options.commentText.includes(cleanedPart))
    ) {
      movedToComment.push(cleanedPart);
    } else if (!keptOrgParts.includes(cleanedPart)) {
      keptOrgParts.push(cleanedPart);
    }
  }

  const explicitComment = stripEconomicCodeText(
    options.commentText || '',
    rescuedCode
  );
  const movedCleaned = movedToComment
    .map((p) => stripEconomicCodeText(p, rescuedCode))
    .filter(Boolean);

  const uniqueMoved: string[] = [];
  for (const c of movedCleaned) {
    if (!uniqueMoved.includes(c) && !explicitComment.includes(c)) {
      uniqueMoved.push(c);
    }
  }

  const orgDesc = keptOrgParts.join(' - ').trim() || options.fallbackOrg;

  return {
    orgDesc,
    comment: explicitComment || uniqueMoved.join(' | '),
    code: rescuedCode,
  };
}

export interface ChallanCountBreakdown {
  rowCount: number;
  mainCount: number;
  taxCount: number;
  vatCount: number;
  totalChallans: number;
}

export function countChallanBreakdown(
  items: ReadonlyArray<{
    challanNo?: string | null;
    amount?: string | number | null;
    incomeTaxChallanNo?: string | null;
    incomeTaxAmount?: string | number | null;
    vatChallanNo?: string | null;
    vatAmount?: string | number | null;
  }>
): ChallanCountBreakdown {
  let mainCount = 0;
  let taxCount = 0;
  let vatCount = 0;

  for (const item of items) {
    const mainNo = cleanChallanNo(item.challanNo);
    const taxNo = cleanChallanNo(item.incomeTaxChallanNo);
    const vatNo = cleanChallanNo(item.vatChallanNo);

    const hasMain =
      Boolean(mainNo && mainNo !== taxNo && mainNo !== vatNo) ||
      toNumericValue(item.amount) > 0;
    const hasTax = Boolean(taxNo) || toNumericValue(item.incomeTaxAmount) > 0;
    const hasVat = Boolean(vatNo) || toNumericValue(item.vatAmount) > 0;

    if (hasMain) mainCount++;
    if (hasTax) taxCount++;
    if (hasVat) vatCount++;
  }

  return {
    rowCount: items.length,
    mainCount,
    taxCount,
    vatCount,
    totalChallans: mainCount + taxCount + vatCount,
  };
}

