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

export function normalizeChallanNo(no: string): string {
  const s = toEnglishDigits(no).trim();
  const m = s.match(/^(\d{4})\s*-\s*(\d+)$/);
  if (!m) return s;
  const body = m[2].length === 10 ? m[2] + '1' : m[2];
  return `${m[1]}-${body}`;
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

export function normalizeChallanDate(v: string | null | undefined): string {
  const t = toEnglishDigits(v).trim();
  if (!t) return '';
  let m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  }
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${year}`;
  }
  return t;
}

export function toSheetSlashDate(ddmmyyyy: string): string {
  const m = toEnglishDigits(ddmmyyyy)
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return ddmmyyyy;
  return `${Number(m[2])}/${Number(m[1])}/${m[3]}`;
}

export function showDate(iso: string | null | undefined): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}

export function parseInputDate(v: string): string {
  const t = toEnglishDigits(v).trim();
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
  const t = toEnglishDigits(raw).replace(/\D/g, '').slice(0, 8);
  if (t.length > 4) return `${t.slice(0, 2)}/${t.slice(2, 4)}/${t.slice(4)}`;
  if (t.length > 2) return `${t.slice(0, 2)}/${t.slice(2)}`;
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
    const code = data.New37Code.trim();
    seen.add(code);
    out.push({
      code,
      name: data.ChallanTypeNameBn || 'মূল অর্থনৈতিক কোড',
      amount: toEnglishDigits(String(data.Amount || '')).replace(/,/g, ''),
    });
  }

  if (Array.isArray(data.Economics)) {
    for (const item of data.Economics) {
      const code = String(item.EconomicNew37Code || item.EconomicCode || '').trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        name: String(item.EconomicNameBn || item.EconomicRemarks || 'অর্থনৈতিক কোড').trim(),
        amount: toEnglishDigits(String(item.EconomicAmount || '')).replace(/,/g, ''),
      });
    }
  }
  return out;
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
  const org = data.ToOrgNameBn || data.OrgNameBn || '';
  const economicOptions = extractEconomicCodes(data);
  const econCode = economicOptions[0]?.code || '';

  const details = [
    data.ChallanTypeNameBn,
    econCode ? `কোড: ${econCode}` : '',
    remarks ? remarks : '',
  ].filter(Boolean);

  const normalizedRemarks = toEnglishDigits(remarks);

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
    description: details.join(' | '),
    quantity: quantityMatch ? quantityMatch[1] : '',
    rate,
    amount: toEnglishDigits(String(data.Amount || '')).replace(/,/g, ''),
    challanDate: normalizeChallanDate(data.ChallanDate),
  };
}
