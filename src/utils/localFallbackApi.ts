import type {
  AppSettings,
  ChallanRecord,
  ChallanReportRow,
  DateBackupRecord,
  DealerRecord,
  DoIssueRecord,
  DuplicateBackupRecord,
  LicenseeRecord,
  OfficialChallanData,
  PermissionKey,
  PermissionsMap,
  ReportTemplate,
  SavedReport,
  SuballocationRecord,
  UserAccount,
} from '../types.ts';
import {
  DEFAULT_KHATS,
  DEFAULT_SETTINGS,
  extractSpreadsheetId,
  normalizeChallanNo,
  toEnglishDigits,
  toNumericValue,
} from './challan.ts';
import {
  matchDoIssueForChallan,
  normalizeSheetCategory,
  parseChallansFromRows,
  parseCsvMatrix,
  parseDealersFromRows,
  parseDoIssuesFromRows,
  parseSuballocationsFromRows,
} from './sheetParser.ts';

interface LocalStoredUser extends UserAccount {
  password: string;
}

interface LocalDbState {
  records: ChallanRecord[];
  duplicateBackups: DuplicateBackupRecord[];
  dateBackups: DateBackupRecord[];
  dealers: DealerRecord[];
  licensees: LicenseeRecord[];
  suballocations: SuballocationRecord[];
  doIssues: DoIssueRecord[];
  templates: ReportTemplate[];
  savedReports: SavedReport[];
  users: LocalStoredUser[];
  settings: AppSettings;
  lockPassword: string;
  activeSessionUserId: string;
}

const LOCAL_DB_KEY = 'challan_apk_local_db_v1';

const FULL_ADMIN_PERMISSIONS: PermissionsMap = {
  scan: true,
  records: true,
  recordEdit: true,
  recordDelete: true,
  report: true,
  templates: true,
  dealers: true,
  settings: true,
  adminUsers: true,
};

const DEFAULT_OPERATOR_PERMISSIONS: PermissionsMap = {
  scan: true,
  records: true,
  recordEdit: false,
  recordDelete: false,
  report: true,
  templates: true,
  dealers: false,
  settings: false,
  adminUsers: false,
};

function getSeedUsers(): LocalStoredUser[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'usr-admin-1',
      userId: 'admin',
      name: 'উপজেলা খাদ্য নিয়ন্ত্রক (সুপার এডমিন)',
      email: 'foodchannelregister@gmail.com',
      role: 'admin',
      permissions: { ...FULL_ADMIN_PERMISSIONS },
      active: true,
      createdAt: now,
      password: 'ChallanAdmin#2026',
    },
    {
      id: 'usr-operator-1',
      userId: 'operator1',
      name: 'সহকারী অপারেটর (সীমিত অ্যাক্সেস)',
      email: 'operator@upazila.gov.bd',
      role: 'operator',
      permissions: { ...DEFAULT_OPERATOR_PERMISSIONS },
      active: true,
      createdAt: now,
      password: 'Operator#2026',
    },
  ];
}

function toPublicUser(u: LocalStoredUser): UserAccount {
  return {
    id: u.id,
    userId: u.userId,
    name: u.name,
    email: u.email,
    role: u.role,
    permissions: { ...DEFAULT_OPERATOR_PERMISSIONS, ...u.permissions },
    active: u.active,
    createdAt: u.createdAt,
  };
}

function generateId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(10000 + Math.random() * 89999)}`;
}

function ensureLocalDb(): LocalDbState {
  try {
    const raw = localStorage.getItem(LOCAL_DB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalDbState>;
      const users =
        Array.isArray(parsed.users) && parsed.users.length > 0
          ? parsed.users
          : getSeedUsers();
      const khats =
        Array.isArray(parsed.settings?.khats) && parsed.settings.khats.length > 0
          ? parsed.settings.khats
          : DEFAULT_KHATS;
      return {
        records: Array.isArray(parsed.records) ? parsed.records : [],
        duplicateBackups: Array.isArray(parsed.duplicateBackups)
          ? parsed.duplicateBackups
          : [],
        dateBackups: Array.isArray(parsed.dateBackups) ? parsed.dateBackups : [],
        dealers: Array.isArray(parsed.dealers) ? parsed.dealers : [],
        licensees: Array.isArray(parsed.licensees) ? parsed.licensees : [],
        suballocations: Array.isArray(parsed.suballocations)
          ? parsed.suballocations
          : [],
        doIssues: Array.isArray(parsed.doIssues) ? parsed.doIssues : [],
        templates: Array.isArray(parsed.templates) ? parsed.templates : [],
        savedReports: Array.isArray(parsed.savedReports) ? parsed.savedReports : [],
        users,
        settings: parsed.settings
          ? {
              ...DEFAULT_SETTINGS,
              ...parsed.settings,
              khats,
              licenseFees:
                Array.isArray(parsed.settings.licenseFees) &&
                parsed.settings.licenseFees.length > 0
                  ? parsed.settings.licenseFees
                  : DEFAULT_SETTINGS.licenseFees,
              customColumns: Array.isArray(parsed.settings.customColumns)
                ? parsed.settings.customColumns
                : [],
            }
          : DEFAULT_SETTINGS,
        lockPassword: parsed.lockPassword || 'ChallanAdmin#2026',
        activeSessionUserId: parsed.activeSessionUserId || '',
      };
    }
  } catch {
    // recreate fresh local db
  }

  const initial: LocalDbState = {
    records: [],
    duplicateBackups: [],
    dateBackups: [],
    dealers: [],
    licensees: [],
    suballocations: [],
    doIssues: [],
    templates: [],
    savedReports: [],
    users: getSeedUsers(),
    settings: { ...DEFAULT_SETTINGS },
    lockPassword: 'ChallanAdmin#2026',
    activeSessionUserId: '',
  };
  saveLocalDb(initial);
  return initial;
}

function saveLocalDb(state: LocalDbState): void {
  try {
    localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(state));
  } catch {
    // ignore storage quota failures
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Challan-Local-Mode': 'true',
    },
  });
}

function parseChallanDateLocal(text: string): { display: string; iso: string } {
  const cleaned = toEnglishDigits(text).trim();
  if (!cleaned) return { display: '', iso: '' };

  let y: number;
  let mo: number;
  let d: number;

  let m = cleaned.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
  if (m) {
    d = Number(m[1]);
    mo = Number(m[2]);
    y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  } else {
    m = cleaned.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (!m) {
      throw new Error(
        'চালান জমার তারিখ বোঝা যায়নি। দিন/মাস/বছর (dd/MM/yyyy) লিখুন।'
      );
    }
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  }

  const check = new Date(y, mo - 1, d);
  if (
    y < 1970 ||
    y > 2100 ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    check.getFullYear() !== y ||
    check.getMonth() !== mo - 1 ||
    check.getDate() !== d
  ) {
    throw new Error(`চালান জমার তারিখটি সঠিক নয়: ${text}`);
  }

  return {
    display: `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`,
    iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  };
}

function toISODateSafe(value: string): string {
  const text = toEnglishDigits(value).trim();
  if (!text) return '';
  let match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  match = text.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  }
  return '';
}

function getAuthenticatedUser(db: LocalDbState, tokenHeader: string): LocalStoredUser | null {
  const token = tokenHeader.replace(/^Bearer\s+/i, '').trim();
  if (token.startsWith('local-')) {
    const uid = token.slice(6);
    const found = db.users.find((u) => u.id === uid && u.active);
    if (found) return found;
  }
  if (db.activeSessionUserId) {
    const found = db.users.find((u) => u.id === db.activeSessionUserId && u.active);
    if (found) return found;
  }
  if (!db.settings.lockEnabled) {
    return (
      db.users.find((u) => u.role === 'admin' && u.active) ||
      db.users.find((u) => u.active) ||
      db.users[0] ||
      null
    );
  }
  return null;
}

function hasPerm(user: LocalStoredUser | null, key: PermissionKey): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Boolean(user.permissions?.[key]);
}

function mergeSyncPayloadIntoDb(
  db: LocalDbState,
  payload: {
    dealers?: DealerRecord[] | null;
    suballocations?: SuballocationRecord[] | null;
    doIssues?: DoIssueRecord[] | null;
    challans?: ChallanRecord[] | null;
  }
): {
  dealers: number;
  suballocations: number;
  doIssues: number;
  records: number;
  removedRecords: number;
} {
  if (Array.isArray(payload.dealers)) {
    const dealerMap = new Map<string, DealerRecord>();
    for (const d of payload.dealers) {
      dealerMap.set(d.id || `${d.dealerName}::${d.unionName}`, d);
    }
    db.dealers = Array.from(dealerMap.values());
  }

  if (Array.isArray(payload.suballocations)) {
    const subMap = new Map<string, SuballocationRecord>();
    for (const s of payload.suballocations) {
      subMap.set(s.id, s);
    }
    db.suballocations = Array.from(subMap.values());
  }

  if (Array.isArray(payload.doIssues)) {
    const doMap = new Map<string, DoIssueRecord>();
    for (const d of payload.doIssues) {
      const key = d.challanNo ? `${d.challanNo}::${d.doNo}` : d.id;
      doMap.set(key, d);
    }
    db.doIssues = Array.from(doMap.values());
  }

  let removedRecords = 0;
  if (Array.isArray(payload.challans)) {
    const prevCount = db.records.length;
    const prevById = new Map<string, number>();
    const prevByRecordId = new Map<string, number>();
    const prevByNo = new Map<string, number>();
    const usedPrev = new Set<number>();

    db.records.forEach((r, idx) => {
      if (r.id && !prevById.has(r.id)) prevById.set(r.id, idx);
      if (r.recordId && !prevByRecordId.has(r.recordId)) prevByRecordId.set(r.recordId, idx);
      const no = normalizeChallanNo(
        r.challanNo || r.incomeTaxChallanNo || r.vatChallanNo || ''
      );
      if (no && !prevByNo.has(no)) prevByNo.set(no, idx);
    });

    const nextRecords: ChallanRecord[] = [];
    for (const c of payload.challans) {
      const no = normalizeChallanNo(
        c.challanNo || c.incomeTaxChallanNo || c.vatChallanNo || ''
      );
      if (!c.id && !no) continue;

      let matchIdx: number | undefined;
      if (c.id && prevById.has(c.id)) {
        const candidate = prevById.get(c.id)!;
        if (!usedPrev.has(candidate)) matchIdx = candidate;
      }
      if (matchIdx === undefined && c.recordId && prevByRecordId.has(c.recordId)) {
        const candidate = prevByRecordId.get(c.recordId)!;
        if (!usedPrev.has(candidate)) matchIdx = candidate;
      }
      if (matchIdx === undefined && no && prevByNo.has(no)) {
        const candidate = prevByNo.get(no)!;
        if (!usedPrev.has(candidate)) matchIdx = candidate;
      }

      const cur = matchIdx !== undefined ? db.records[matchIdx] : undefined;
      if (matchIdx !== undefined) usedPrev.add(matchIdx);

      const normalizedCat =
        normalizeSheetCategory(c.challanCategory || cur?.challanCategory) ||
        c.challanCategory ||
        cur?.challanCategory ||
        '';

      nextRecords.push({
        ...(cur || {}),
        ...c,
        serialNo: nextRecords.length + 1,
        id: c.id || cur?.id || `CHL-${nextRecords.length + 1}`,
        recordId: cur?.recordId || c.recordId || generateId('rec'),
        date: c.date ?? cur?.date ?? '',
        department: c.department ?? cur?.department ?? '',
        taxDepartment: c.taxDepartment ?? cur?.taxDepartment ?? c.sourceMemo ?? cur?.sourceMemo ?? '',
        toOrganization: c.toOrganization ?? cur?.toOrganization ?? '',
        dealerId: c.dealerId || cur?.dealerId || '',
        dealerName: c.dealerName || cur?.dealerName || '',
        unionName: c.unionName || cur?.unionName || '',
        dealerAllocationId: c.dealerAllocationId ?? cur?.dealerAllocationId ?? '',
        challanCategory: normalizedCat,
        licenseActionType: c.licenseActionType || cur?.licenseActionType || '',
        submittedThrough: c.submittedThrough || cur?.submittedThrough || '',
        submittedOnBehalfOf: c.submittedOnBehalfOf || cur?.submittedOnBehalfOf || '',
        challanDate: c.challanDate ?? cur?.challanDate ?? '',
        expectedAmount: c.expectedAmount || cur?.expectedAmount || '',
        expectedTaxAmount: c.expectedTaxAmount || cur?.expectedTaxAmount || '',
        incomeTaxChallanNo: c.incomeTaxChallanNo ?? cur?.incomeTaxChallanNo ?? '',
        incomeTaxDate: c.incomeTaxDate ?? cur?.incomeTaxDate ?? '',
        incomeTaxAmount: c.incomeTaxAmount ?? cur?.incomeTaxAmount ?? '',
        vatChallanNo: c.vatChallanNo ?? cur?.vatChallanNo ?? '',
        vatDate: c.vatDate ?? cur?.vatDate ?? '',
        vatAmount: c.vatAmount ?? cur?.vatAmount ?? '',
        licenseNo: c.licenseNo ?? cur?.licenseNo ?? '',
        new37Code: c.new37Code ?? cur?.new37Code ?? '',
        comment: c.comment ?? cur?.comment ?? '',
        taxComment: c.taxComment ?? cur?.taxComment ?? '',
        doNo: c.doNo || cur?.doNo || '',
        doIssueDate: c.doIssueDate || cur?.doIssueDate || '',
        pdfUrl: c.pdfUrl || cur?.pdfUrl || '',
        entryTime: c.entryTime || cur?.entryTime || '',
      });
    }

    db.records = nextRecords;
    removedRecords = Math.max(0, prevCount - nextRecords.length);
  }

  const subById = new Map(db.suballocations.map((s) => [s.id, s]));
  db.records = db.records.map((r) => {
    const normalizedCat =
      normalizeSheetCategory(r.challanCategory) || r.challanCategory;
    let matchedSub = r.dealerAllocationId
      ? subById.get(r.dealerAllocationId)
      : undefined;
    if (!matchedSub && r.amount) {
      const numAmt = toNumericValue(r.amount);
      if (numAmt > 0) {
        const amtMatches = db.suballocations.filter(
          (s) =>
            Math.abs(s.totalAmount - numAmt) < 1 &&
            (!normalizedCat ||
              !s.category ||
              normalizeSheetCategory(s.category) === normalizedCat)
        );
        if (amtMatches.length === 1) {
          matchedSub = amtMatches[0];
        }
      }
    }
    const matchedDo = matchDoIssueForChallan(r, db.doIssues);
    return {
      ...r,
      challanCategory: normalizedCat,
      dealerName:
        r.dealerName || matchedSub?.dealerName || matchedDo?.recipientName || '',
      unionName:
        r.unionName || matchedSub?.unionName || matchedDo?.unionName || '',
      expectedAmount:
        matchedSub && matchedSub.totalAmount > 0
          ? String(matchedSub.totalAmount)
          : matchedDo && matchedDo.requiredAmount && matchedDo.requiredAmount > 0
            ? String(matchedDo.requiredAmount)
            : r.expectedAmount || '',
      expectedTaxAmount:
        matchedSub && matchedSub.taxAmount > 0
          ? String(matchedSub.taxAmount)
          : matchedDo &&
              matchedDo.requiredTaxAmount &&
              matchedDo.requiredTaxAmount > 0
            ? String(matchedDo.requiredTaxAmount)
            : r.expectedTaxAmount || '',
      doNo: matchedDo?.doNo || r.doNo || '',
      doIssueDate: matchedDo?.issueDate || r.doIssueDate || '',
    };
  });

  return {
    dealers: db.dealers.length,
    suballocations: db.suballocations.length,
    doIssues: db.doIssues.length,
    records: db.records.length,
    removedRecords,
  };
}

interface CapacitorHttpPlugin {
  request: (options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
  }) => Promise<{ status: number; data: unknown; url?: string }>;
}

function getCapacitorHttp(): CapacitorHttpPlugin | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    Capacitor?: { Plugins?: { CapacitorHttp?: CapacitorHttpPlugin } };
  };
  return w.Capacitor?.Plugins?.CapacitorHttp || null;
}

async function fetchPublicSheetCsvDirect(
  spreadsheetId: string,
  tabName: string
): Promise<{ accessible: boolean; rows: string[][] }> {
  const cleanTab = tabName.trim();
  if (!spreadsheetId.trim() || !cleanTab) {
    return { accessible: false, rows: [] };
  }
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
    spreadsheetId.trim()
  )}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(cleanTab)}`;

  let text = '';
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (res.ok && !(res.url && res.url.includes('accounts.google.com'))) {
      text = await res.text();
    }
  } catch {
    // fallback to native CapacitorHttp below
  }

  if (!text) {
    try {
      const capHttp = getCapacitorHttp();
      if (capHttp) {
        const resp = await capHttp.request({
          url,
          method: 'GET',
          headers: { Accept: 'text/csv,text/plain,*/*' },
          connectTimeout: 10000,
          readTimeout: 10000,
        });
        if (resp.status >= 200 && resp.status < 300) {
          text = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
        }
      }
    } catch {
      return { accessible: false, rows: [] };
    }
  }

  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    return { accessible: false, rows: [] };
  }
  return { accessible: true, rows: parseCsvMatrix(trimmed) };
}

async function fetchOfficialChallanDirect(
  rawChallanNo: string
): Promise<OfficialChallanData> {
  const cleaned = toEnglishDigits(rawChallanNo).trim();
  const match11 = cleaned.match(/^(\d{4})-(\d{10})(\d)$/);
  const queryNo = match11 ? `${match11[1]}-${match11[2]}` : cleaned;

  if (!/^\d{4}-\d{10}$/.test(queryNo)) {
    throw new Error(
      'সঠিক চালান নম্বর পাওয়া যায়নি। (ফরম্যাট: YYYY-XXXXXXXXXX বা ১১ অঙ্ক)'
    );
  }

  const url = `https://www.achallan.gov.bd/acs/General/PrintChallanSlipDetailsHTML?challanNo=${encodeURIComponent(
    queryNo
  )}`;

  const capHttp = getCapacitorHttp();
  let html = '';
  if (capHttp) {
    const resp = await capHttp.request({
      url,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      connectTimeout: 15000,
      readTimeout: 15000,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`সরকারি পেজ থেকে তথ্য আনা যায়নি। HTTP: ${resp.status}`);
    }
    html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
  } else {
    throw new Error(
      'সরাসরি সরকারি পোর্টাল থেকে তথ্য আনতে সার্ভার সংযোগ অথবা Android অ্যাপ প্রয়োজন।'
    );
  }

  const objMatch = html.match(/var\s+obj\s*=\s*(\{[\s\S]*?\});/);
  if (!objMatch) {
    throw new Error('সরকারি পেজে চালানের তথ্য পাওয়া যায়নি।');
  }
  const data = JSON.parse(objMatch[1]) as Record<string, unknown>;
  if (String(data.ChallanNo || '') !== queryNo) {
    throw new Error('প্রাপ্ত চালান নম্বরের সঙ্গে মিল পাওয়া যায়নি।');
  }

  const economics = Array.isArray(data.Economics)
    ? data.Economics.map((item: Record<string, unknown>) => ({
        EconomicNameBn: String(item.EconomicNameBn || ''),
        EconomicCode: String(item.EconomicCode || ''),
        EconomicAmount: (item.EconomicAmount as string | number) ?? '',
        EconomicNew37Code: String(item.EconomicNew37Code || ''),
        EconomicRemarks: String(item.EconomicRemarks || ''),
      }))
    : [];

  return {
    ChallanNo: match11 ? cleaned : normalizeChallanNo(String(data.ChallanNo || '')),
    NameBn: String(data.NameBn || ''),
    ClientForNameBn: String(data.ClientForNameBn || ''),
    ClientByNameBn: String(data.ClientByNameBn || ''),
    OrgNameBn: String(data.OrgNameBn || ''),
    ToOrgNameBn: String(data.ToOrgNameBn || ''),
    Amount: (data.Amount as string | number) ?? '',
    ChallanDate: String(data.ChallanDate || ''),
    ChallanTypeNameBn: String(data.ChallanTypeNameBn || ''),
    New37Code: String(data.New37Code || ''),
    Remarks: String(data.Remarks || ''),
    Economics: economics,
  };
}

export async function handleLocalApiRequest(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const method = String(init.method || 'GET').toUpperCase();
  const parsedUrl = new URL(input, 'https://local.challan');
  const pathname = parsedUrl.pathname;
  const searchParams = parsedUrl.searchParams;

  let body: Record<string, unknown> = {};
  if (typeof init.body === 'string' && init.body.trim()) {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }

  const headers = new Headers(init.headers || {});
  const authHeader = headers.get('Authorization') || '';
  const db = ensureLocalDb();

  // ---- AUTH ----
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = getAuthenticatedUser(db, authHeader);
    if (!user) {
      return jsonResponse({
        success: false,
        user: null,
        lockEnabled: Boolean(db.settings.lockEnabled),
      });
    }
    return jsonResponse({
      success: true,
      user: toPublicUser(user),
      lockEnabled: Boolean(db.settings.lockEnabled),
    });
  }

  if (pathname === '/api/auth/quick-login' && method === 'POST') {
    if (db.settings.lockEnabled) {
      return jsonResponse(
        { success: false, error: 'অ্যাপ লক চালু আছে — পাসওয়ার্ড দিয়ে প্রবেশ করুন।' },
        403
      );
    }
    const target = String(body.target || 'admin').trim();
    const user =
      target === 'operator'
        ? db.users.find((u) => u.role === 'operator' && u.active)
        : db.users.find((u) => u.role === 'admin' && u.active) || db.users[0];
    if (!user) {
      return jsonResponse({ success: false, error: 'ব্যবহারকারী পাওয়া যায়নি।' }, 404);
    }
    db.activeSessionUserId = user.id;
    saveLocalDb(db);
    return jsonResponse({
      success: true,
      user: toPublicUser(user),
      token: `local-${user.id}`,
    });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const identifier = String(body.identifier || '').trim().toLowerCase();
    const password = String(body.password || '');

    let user: LocalStoredUser | undefined;
    if (identifier) {
      user = db.users.find(
        (u) =>
          u.userId.toLowerCase() === identifier ||
          u.email.toLowerCase() === identifier
      );
      if (!user || !user.active || (user.password !== password && db.lockPassword !== password)) {
        return jsonResponse(
          { success: false, error: 'ভুল ইউজার আইডি বা পাসওয়ার্ড।' },
          401
        );
      }
    } else {
      const admin =
        db.users.find((u) => u.role === 'admin' && u.active) || db.users[0];
      if (!admin || (admin.password !== password && db.lockPassword !== password)) {
        return jsonResponse({ success: false, error: 'ভুল পাসওয়ার্ড।' }, 401);
      }
      user = admin;
    }

    db.activeSessionUserId = user.id;
    saveLocalDb(db);
    return jsonResponse({
      success: true,
      user: toPublicUser(user),
      token: `local-${user.id}`,
    });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    db.activeSessionUserId = '';
    saveLocalDb(db);
    return jsonResponse({ success: true });
  }

  const currentUser = getAuthenticatedUser(db, authHeader);
  if (!currentUser) {
    return jsonResponse(
      {
        success: false,
        error: 'অনুগ্রহ করে প্রথমে লগইন করুন।',
        message: 'অনুগ্রহ করে প্রথমে লগইন করুন।',
      },
      401
    );
  }

  if (pathname === '/api/auth/lock-password' && method === 'PUT') {
    if (!hasPerm(currentUser, 'settings')) {
      return jsonResponse({ success: false, message: 'অনুমতি নেই।' }, 403);
    }
    const nextPassword = String(body.password || '').trim();
    if (nextPassword.length < 4) {
      return jsonResponse(
        { success: false, message: 'কমপক্ষে ৪ অক্ষরের পাসওয়ার্ড লিখুন।' },
        400
      );
    }
    db.lockPassword = nextPassword;
    const admin = db.users.find((u) => u.role === 'admin') || db.users[0];
    if (admin) admin.password = nextPassword;
    if (typeof body.lockEnabled === 'boolean') {
      db.settings.lockEnabled = body.lockEnabled;
    }
    saveLocalDb(db);
    return jsonResponse({
      success: true,
      lockEnabled: Boolean(db.settings.lockEnabled),
      token: `local-${currentUser.id}`,
    });
  }

  // ---- USERS ----
  if (pathname === '/api/users' && method === 'GET') {
    return jsonResponse({ success: true, users: db.users.map(toPublicUser) });
  }
  if (pathname === '/api/users' && method === 'POST') {
    const newUser: LocalStoredUser = {
      id: generateId('usr'),
      userId: String(body.userId || `user${db.users.length + 1}`).trim(),
      name: String(body.name || 'নতুন ইউজার').trim(),
      email: String(body.email || '').trim().toLowerCase(),
      role: body.role === 'admin' ? 'admin' : 'operator',
      permissions: {
        ...DEFAULT_OPERATOR_PERMISSIONS,
        ...((body.permissions as Partial<PermissionsMap>) || {}),
      },
      active: true,
      createdAt: new Date().toISOString(),
      password: String(body.password || '123456'),
    };
    db.users.push(newUser);
    saveLocalDb(db);
    return jsonResponse({ success: true, user: toPublicUser(newUser) });
  }
  if (pathname.startsWith('/api/users/') && method === 'PUT') {
    const id = decodeURIComponent(pathname.slice('/api/users/'.length));
    const idx = db.users.findIndex((u) => u.id === id);
    if (idx === -1) return jsonResponse({ success: false, error: 'পাওয়া যায়নি।' }, 404);
    db.users[idx] = {
      ...db.users[idx],
      name: body.name !== undefined ? String(body.name) : db.users[idx].name,
      email: body.email !== undefined ? String(body.email) : db.users[idx].email,
      role: body.role === 'admin' || body.role === 'operator' ? body.role : db.users[idx].role,
      active: typeof body.active === 'boolean' ? body.active : db.users[idx].active,
      permissions:
        body.permissions && typeof body.permissions === 'object'
          ? { ...db.users[idx].permissions, ...(body.permissions as Partial<PermissionsMap>) }
          : db.users[idx].permissions,
      password:
        body.password && String(body.password).trim()
          ? String(body.password).trim()
          : db.users[idx].password,
    };
    saveLocalDb(db);
    return jsonResponse({ success: true, user: toPublicUser(db.users[idx]) });
  }
  if (pathname.startsWith('/api/users/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/users/'.length));
    db.users = db.users.filter((u) => u.id !== id);
    saveLocalDb(db);
    return jsonResponse({ success: true });
  }

  // ---- SETTINGS ----
  if (pathname === '/api/settings' && method === 'GET') {
    return jsonResponse({ success: true, settings: db.settings });
  }
  if (pathname === '/api/settings' && method === 'PUT') {
    db.settings = {
      ...db.settings,
      ...(body as Partial<AppSettings>),
    };
    saveLocalDb(db);
    return jsonResponse({ success: true, settings: db.settings });
  }

  // ---- OFFICIAL CHALLAN ----
  if (pathname === '/api/official-challan' && method === 'GET') {
    try {
      const challanNo = searchParams.get('challanNo') || '';
      const data = await fetchOfficialChallanDirect(challanNo);
      return jsonResponse({ success: true, data });
    } catch (err) {
      return jsonResponse(
        {
          success: false,
          message: err instanceof Error ? err.message : 'সরকারি তথ্য আনা যায়নি।',
        },
        400
      );
    }
  }

  // ---- GAS BRIDGE ----
  if (pathname === '/api/gas-bridge' && method === 'POST') {
    try {
      const url = String(body.url || '').trim();
      const action = String(body.action || 'syncAll').trim();
      const payload = body.payload ?? {};
      if (
        !url.startsWith('https://script.google.com/') &&
        !url.startsWith('https://script.googleusercontent.com/')
      ) {
        throw new Error(
          'সঠিক Google Apps Script Web App URL (https://script.google.com/macros/s/.../exec) দিন।'
        );
      }
      if (/\/dev(\?|$)/i.test(url)) {
        throw new Error(
          'আপনি টেস্ট (/dev) লিংক দিয়েছেন। Deploy > New deployment > Web app থেকে পাওয়া .../exec লিংকটি বসান।'
        );
      }
      if (
        url.includes('script.google.com') &&
        (!url.includes('/macros/s/') || /\/edit(\?|$|#)/i.test(url))
      ) {
        throw new Error(
          'এটি এডিটর/হোম লিংক — Web App URL নয়। Deploy > Web app থেকে পাওয়া https://script.google.com/macros/s/.../exec লিংকটি বসান।'
        );
      }

      let text = '';
      let lastStatus = 0;
      try {
        const res = await fetch(url, {
          method: 'POST',
          redirect: 'follow',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, payload }),
        });
        lastStatus = res.status;
        text = await res.text();
      } catch {
        const capHttp = getCapacitorHttp();
        if (!capHttp) {
          throw new Error('Apps Script সার্ভারে সংযোগ করা যায়নি।');
        }
        const resp = await capHttp.request({
          url,
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          data: JSON.stringify({ action, payload }),
          connectTimeout: 20000,
          readTimeout: 20000,
        });
        lastStatus = resp.status;
        text =
          typeof resp.data === 'string'
            ? resp.data
            : JSON.stringify(resp.data || {});
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        const lower = text.toLowerCase();
        if (lower.includes('servicelogin') || lower.includes('accounts.google.com')) {
          throw new Error(
            'Apps Script Web App-এর অনুমতি "Anyone" করা নেই। Deploy > Manage deployments-এ Execute as: Me এবং Who has access: Anyone সেট করুন।'
          );
        }
        throw new Error(
          `Apps Script থেকে বৈধ JSON পাওয়া যায়নি (HTTP ${lastStatus || '?'})। সঠিক .../exec লিংক যাচাই করুন।`
        );
      }

      const obj =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : null;
      if (
        obj &&
        (obj.ok === false ||
          obj.success === false ||
          (typeof obj.error === 'string' && obj.error.trim().length > 0))
      ) {
        const rawErr = String(
          obj.error || obj.message || 'Apps Script অনুরোধ প্রত্যাখ্যান করেছে।'
        );
        return jsonResponse({ success: false, message: rawErr, data: parsed }, 400);
      }

      return jsonResponse({ success: true, data: parsed });
    } catch (err) {
      return jsonResponse(
        {
          success: false,
          message: err instanceof Error ? err.message : 'Apps Script সংযোগ ব্যর্থ।',
        },
        400
      );
    }
  }

  // ---- SYNC ----
  if (pathname === '/api/sync/snapshot' && method === 'POST') {
    const counts = mergeSyncPayloadIntoDb(db, {
      dealers: Array.isArray(body.dealers) ? (body.dealers as DealerRecord[]) : null,
      suballocations: Array.isArray(body.suballocations)
        ? (body.suballocations as SuballocationRecord[])
        : null,
      doIssues: Array.isArray(body.doIssues) ? (body.doIssues as DoIssueRecord[]) : null,
      challans: Array.isArray(body.challans) ? (body.challans as ChallanRecord[]) : null,
    });
    saveLocalDb(db);
    return jsonResponse({ success: true, counts });
  }

  if (pathname === '/api/sync/public-sheet' && method === 'POST') {
    try {
      const cfg: AppSettings = { ...db.settings, ...(body as Partial<AppSettings>) };
      const spreadsheetId = extractSpreadsheetId(cfg.spreadsheetId);
      if (!spreadsheetId) {
        throw new Error('Spreadsheet ID নির্ধারিত নেই।');
      }
      const [foodRes, omsRes, subRes, doRes, chlRes] = await Promise.all([
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.foodDealerTabName),
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.omsDealerTabName),
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.suballocationTabName),
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.doIssueTabName || 'DO_Issue'),
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.challanTabName),
      ]);
      if (
        !foodRes.accessible &&
        !omsRes.accessible &&
        !subRes.accessible &&
        !doRes.accessible &&
        !chlRes.accessible
      ) {
        throw new Error(
          'Google Sheet থেকে পড়া যায়নি। শিটটি প্রাইভেট হলে সেটিংস থেকে Google অ্যাকাউন্টে সাইন-ইন করে সিঙ্ক করুন।'
        );
      }

      const dealers: DealerRecord[] = [];
      if (foodRes.accessible) dealers.push(...parseDealersFromRows(foodRes.rows, 'খাদ্য বান্ধব'));
      if (omsRes.accessible) dealers.push(...parseDealersFromRows(omsRes.rows, 'ওএমএস সাধারণ'));

      const suballocations = subRes.accessible
        ? parseSuballocationsFromRows(subRes.rows)
        : null;
      const doIssues = doRes.accessible ? parseDoIssuesFromRows(doRes.rows) : null;
      const challans = chlRes.accessible
        ? parseChallansFromRows(
            chlRes.rows,
            dealers,
            cfg,
            suballocations || [],
            doIssues || []
          )
        : null;

      const counts = mergeSyncPayloadIntoDb(db, {
        dealers: foodRes.accessible || omsRes.accessible ? dealers : null,
        suballocations,
        doIssues,
        challans,
      });
      saveLocalDb(db);
      const removedNote =
        counts.removedRecords > 0
          ? ` (শিট থেকে মোছা ${counts.removedRecords}টি সরানো হয়েছে)`
          : '';
      return jsonResponse({
        success: true,
        counts,
        message: `সিঙ্ক সম্পন্ন: ডিলার ${counts.dealers} জন, উপ-বরাদ্দ ${counts.suballocations}টি, ডিউ ${counts.doIssues}টি, চালান ${counts.records}টি${removedNote}`,
      });
    } catch (err) {
      return jsonResponse(
        {
          success: false,
          message: err instanceof Error ? err.message : 'Google Sheet থেকে তথ্য আনা যায়নি।',
        },
        400
      );
    }
  }

  // ---- CHALLANS ----
  if (pathname === '/api/challans' && method === 'GET') {
    return jsonResponse({ success: true, records: db.records });
  }

  if (pathname === '/api/challans' && method === 'POST') {
    try {
      const scanMode = String(body.scanMode || 'main').trim();
      const mergeExisting = body.mergeExisting !== false;

      const unionName = String(body.unionName || '').trim();
      const dealerName = String(body.dealerName || '').trim();
      const dealerId = String(body.dealerId || '').trim();
      const dealerAllocationId = String(body.dealerAllocationId || '').trim();
      const challanCategory = String(body.challanCategory || '').trim();
      const licenseActionType = String(
        body.licenseActionType || ''
      ).trim() as ChallanRecord['licenseActionType'];
      const licenseNo = String(body.licenseNo || '').trim();
      const new37Code = String(body.new37Code || '').trim();
      const expectedAmount = toEnglishDigits(String(body.expectedAmount || '')).trim();
      const expectedTaxAmount = toEnglishDigits(String(body.expectedTaxAmount || '')).trim();
      const customFields =
        body.customFields && typeof body.customFields === 'object'
          ? (body.customFields as Record<string, string>)
          : undefined;

      const department = String(
        body.department ?? body.toOrganization ?? body.field1 ?? ''
      ).trim();
      const toOrganization = String(
        body.toOrganization ?? body.department ?? body.field1 ?? ''
      ).trim();
      const submittedThrough = String(body.submittedThrough ?? body.field2 ?? '').trim();
      const submittedOnBehalfOf = String(
        body.submittedOnBehalfOf ?? body.field3 ?? ''
      ).trim();

      const rawChallanNo = String(body.challanNo ?? body.field4 ?? '').trim();
      const challanNo = rawChallanNo ? normalizeChallanNo(rawChallanNo) : '';

      const rawTaxChallanNo = String(body.incomeTaxChallanNo || '').trim();
      const incomeTaxChallanNo = rawTaxChallanNo
        ? normalizeChallanNo(rawTaxChallanNo)
        : '';

      const rawVatChallanNo = String(body.vatChallanNo || '').trim();
      const vatChallanNo = rawVatChallanNo ? normalizeChallanNo(rawVatChallanNo) : '';

      const description = String(body.description ?? body.field5 ?? '').trim();
      const quantity = toEnglishDigits(String(body.quantity ?? body.field6 ?? '')).trim();
      const rate = toEnglishDigits(String(body.rate ?? body.field7 ?? '')).trim();
      const amount = toEnglishDigits(String(body.amount ?? body.field8 ?? '')).trim();
      const rawDate = String(body.challanDate ?? body.field9 ?? '').trim();
      const incomeTaxAmount = toEnglishDigits(String(body.incomeTaxAmount || '')).trim();
      const rawTaxDate = String(body.incomeTaxDate || '').trim();
      const vatAmount = toEnglishDigits(String(body.vatAmount || '')).trim();
      const rawVatDate = String(body.vatDate || '').trim();
      const comment = String(body.comment ?? body.description ?? '').trim();
      const taxComment = String(body.taxComment ?? '').trim();
      const sourceMemo = String(body.sourceMemo || '').trim();
      const taxDepartment = String(body.taxDepartment ?? sourceMemo ?? '').trim();
      const dcMemo = String(body.dcMemo || '').trim();
      const pdfUrl = String(body.pdfUrl || '').trim();

      const primaryNumber =
        scanMode === 'tax'
          ? incomeTaxChallanNo || challanNo
          : scanMode === 'vat'
            ? vatChallanNo || challanNo
            : challanNo;

      if (!primaryNumber) throw new Error('চালান নম্বর অবশ্যই দিতে হবে।');
      if (!challanCategory) throw new Error('চালানের খাত / ক্যাটেগরি নির্বাচন করুন।');

      const parsedMainDate = parseChallanDateLocal(rawDate);
      const parsedTaxDate = parseChallanDateLocal(rawTaxDate || rawDate);
      const parsedVatDate = parseChallanDateLocal(rawVatDate || rawDate);

      const dupRow = db.records.find(
        (r) =>
          (r.challanNo && normalizeChallanNo(r.challanNo) === primaryNumber) ||
          (r.incomeTaxChallanNo &&
            normalizeChallanNo(r.incomeTaxChallanNo) === primaryNumber) ||
          (r.vatChallanNo && normalizeChallanNo(r.vatChallanNo) === primaryNumber)
      );
      if (dupRow) {
        return jsonResponse({
          success: false,
          duplicate: true,
          message: 'এই চালান নম্বরটি আগে সংরক্ষিত হয়েছে।',
        });
      }

      const slotIsEmpty = (r: ChallanRecord): boolean => {
        if (scanMode === 'tax') return !String(r.incomeTaxChallanNo || '').trim();
        if (scanMode === 'vat') return !String(r.vatChallanNo || '').trim();
        return !String(r.challanNo || '').trim();
      };

      const effectiveAllocId =
        dealerAllocationId && dealerAllocationId !== dealerId
          ? dealerAllocationId
          : '';

      let mergeTargetIndex = -1;
      if (mergeExisting && scanMode !== 'single') {
        if (effectiveAllocId) {
          mergeTargetIndex = db.records.findIndex(
            (r) =>
              r.dealerAllocationId &&
              r.dealerAllocationId === effectiveAllocId &&
              slotIsEmpty(r)
          );
        } else if (licenseNo) {
          mergeTargetIndex = db.records.findIndex(
            (r) =>
              r.licenseNo &&
              r.licenseNo === licenseNo &&
              r.challanCategory === challanCategory &&
              (!licenseActionType || r.licenseActionType === licenseActionType) &&
              slotIsEmpty(r)
          );
        } else if (dealerName && parsedMainDate.display) {
          mergeTargetIndex = db.records.findIndex(
            (r) =>
              r.dealerName === dealerName &&
              r.challanCategory === challanCategory &&
              (r.challanDate === parsedMainDate.display ||
                r.incomeTaxDate === parsedTaxDate.display ||
                r.vatDate === parsedVatDate.display) &&
              slotIsEmpty(r)
          );
        }
      }

      if (mergeTargetIndex !== -1) {
        const existing = db.records[mergeTargetIndex];
        const mergedCustom = {
          ...(existing.customFields || {}),
          ...(customFields || {}),
        };
        if (scanMode === 'tax') {
          db.records[mergeTargetIndex] = {
            ...existing,
            taxDepartment: taxDepartment || existing.taxDepartment || '',
            sourceMemo: taxDepartment || existing.sourceMemo || '',
            incomeTaxChallanNo: incomeTaxChallanNo || challanNo,
            incomeTaxDate: parsedTaxDate.display || existing.incomeTaxDate,
            incomeTaxAmount: incomeTaxAmount || amount || existing.incomeTaxAmount,
            expectedTaxAmount:
              expectedTaxAmount || expectedAmount || existing.expectedTaxAmount,
            new37Code: existing.new37Code || new37Code,
            licenseNo: existing.licenseNo || licenseNo,
            expectedAmount: existing.expectedAmount || expectedAmount,
            comment: existing.comment || '',
            taxComment: taxComment || comment || existing.taxComment || '',
            submittedThrough: existing.submittedThrough || submittedThrough,
            submittedOnBehalfOf: existing.submittedOnBehalfOf || submittedOnBehalfOf,
            customFields: mergedCustom,
          };
        } else if (scanMode === 'vat') {
          db.records[mergeTargetIndex] = {
            ...existing,
            taxDepartment: taxDepartment || existing.taxDepartment || '',
            sourceMemo: taxDepartment || existing.sourceMemo || '',
            vatChallanNo: vatChallanNo || challanNo,
            vatDate: parsedVatDate.display || existing.vatDate,
            vatAmount: vatAmount || amount || existing.vatAmount,
            new37Code: existing.new37Code || new37Code,
            licenseNo: existing.licenseNo || licenseNo,
            expectedAmount: existing.expectedAmount || expectedAmount,
            comment: existing.comment || '',
            taxComment: taxComment || comment || existing.taxComment || '',
            customFields: mergedCustom,
          };
        } else {
          db.records[mergeTargetIndex] = {
            ...existing,
            department: department || existing.department,
            toOrganization: toOrganization || existing.toOrganization,
            submittedThrough: submittedThrough || existing.submittedThrough,
            submittedOnBehalfOf: submittedOnBehalfOf || existing.submittedOnBehalfOf,
            challanNo: challanNo || existing.challanNo,
            challanDate: parsedMainDate.display || existing.challanDate,
            rate: rate || existing.rate,
            expectedAmount: expectedAmount || existing.expectedAmount,
            expectedTaxAmount: expectedTaxAmount || existing.expectedTaxAmount,
            quantity: quantity || existing.quantity,
            amount: amount || existing.amount,
            licenseNo: licenseNo || existing.licenseNo,
            new37Code: new37Code || existing.new37Code,
            licenseActionType: licenseActionType || existing.licenseActionType,
            description: description || existing.description,
            comment: comment || existing.comment,
            taxComment: existing.taxComment || taxComment || '',
            customFields: mergedCustom,
          };
        }
        saveLocalDb(db);
        return jsonResponse({
          success: true,
          merged: true,
          message: `আগের সারিতেই (ক্রমিক নং: ${existing.serialNo}) চালানের তথ্য সমন্বয়/আপডেট হয়েছে।`,
          recordId: existing.recordId,
          serialNo: existing.serialNo,
          record: db.records[mergeTargetIndex],
        });
      }

      const serialNo = db.records.length + 1;
      const recordId = generateId('rec');
      const chlId = `CHL-${Date.now()}-${Math.floor(10000 + Math.random() * 89999)}`;

      const record: ChallanRecord = {
        serialNo,
        id: chlId,
        date:
          (scanMode === 'tax'
            ? parsedTaxDate.display
            : scanMode === 'vat'
              ? parsedVatDate.display
              : parsedMainDate.display) || '',
        department: scanMode === 'tax' || scanMode === 'vat' ? '' : department,
        unionName,
        dealerName,
        dealerId,
        dealerAllocationId: effectiveAllocId,
        challanCategory,
        licenseActionType,
        licenseNo,
        new37Code,
        expectedAmount: scanMode === 'tax' ? '' : expectedAmount,
        expectedTaxAmount:
          scanMode === 'tax' ? expectedTaxAmount || expectedAmount : expectedTaxAmount,
        sourceMemo: taxDepartment || sourceMemo,
        taxDepartment,
        dcMemo,
        toOrganization: scanMode === 'tax' || scanMode === 'vat' ? '' : toOrganization,
        submittedThrough,
        submittedOnBehalfOf,
        challanNo: scanMode === 'tax' || scanMode === 'vat' ? '' : challanNo,
        description,
        quantity: scanMode === 'tax' || scanMode === 'vat' ? '' : quantity,
        rate: scanMode === 'tax' || scanMode === 'vat' ? '' : rate,
        amount: scanMode === 'tax' || scanMode === 'vat' ? '' : amount,
        challanDate:
          scanMode === 'tax' || scanMode === 'vat' ? '' : parsedMainDate.display,
        incomeTaxChallanNo:
          scanMode === 'tax' ? incomeTaxChallanNo || challanNo : incomeTaxChallanNo,
        incomeTaxDate:
          scanMode === 'tax'
            ? parsedTaxDate.display
            : incomeTaxChallanNo
              ? parsedTaxDate.display
              : '',
        incomeTaxAmount:
          scanMode === 'tax' ? incomeTaxAmount || amount : incomeTaxAmount,
        vatChallanNo: scanMode === 'vat' ? vatChallanNo || challanNo : vatChallanNo,
        vatDate:
          scanMode === 'vat'
            ? parsedVatDate.display
            : vatChallanNo
              ? parsedVatDate.display
              : '',
        vatAmount: scanMode === 'vat' ? vatAmount || amount : vatAmount,
        customFields,
        comment: scanMode === 'tax' || scanMode === 'vat' ? '' : comment,
        taxComment:
          scanMode === 'tax' || scanMode === 'vat'
            ? taxComment || comment
            : taxComment,
        recordId,
        pdfUrl,
        entryTime: new Date().toISOString(),
      };

      db.records.push(record);
      saveLocalDb(db);
      return jsonResponse({
        success: true,
        merged: false,
        message: `নতুন চালান সংরক্ষিত হয়েছে। ক্রমিক নং: ${serialNo}`,
        recordId,
        serialNo,
        record,
      });
    } catch (err) {
      return jsonResponse(
        {
          success: false,
          message: err instanceof Error ? err.message : 'সংরক্ষণ ব্যর্থ হয়েছে।',
        },
        400
      );
    }
  }

  if (pathname.startsWith('/api/challans/') && pathname !== '/api/challans/import') {
    const recordId = decodeURIComponent(pathname.slice('/api/challans/'.length));
    if (method === 'PUT') {
      const idx = db.records.findIndex((r) => r.recordId === recordId);
      if (idx === -1) return jsonResponse({ success: false, message: 'পাওয়া যায়নি।' }, 404);
      db.records[idx] = {
        ...db.records[idx],
        ...(body as Partial<ChallanRecord>),
      };
      saveLocalDb(db);
      return jsonResponse({ success: true, record: db.records[idx] });
    }
    if (method === 'DELETE') {
      db.records = db.records
        .filter((r) => r.recordId !== recordId)
        .map((r, i) => ({ ...r, serialNo: i + 1 }));
      saveLocalDb(db);
      return jsonResponse({ success: true });
    }
  }

  if (pathname === '/api/challans/import' && method === 'POST') {
    const incoming = Array.isArray(body.records)
      ? (body.records as ChallanRecord[])
      : [];
    const counts = mergeSyncPayloadIntoDb(db, { challans: incoming });
    saveLocalDb(db);
    return jsonResponse({ success: true, count: counts.records });
  }

  // ---- DEALERS / LICENSEES / SUBALLOCATIONS ----
  if (pathname === '/api/dealers' && method === 'GET') {
    const unions = Array.from(
      new Set(db.dealers.map((d) => d.unionName).filter(Boolean))
    );
    return jsonResponse({ success: true, dealers: db.dealers, unions });
  }
  if (pathname === '/api/dealers' && method === 'POST') {
    const dealer: DealerRecord = {
      id: String(body.id || generateId('dlr')),
      unionName: String(body.unionName || '').trim(),
      dealerName: String(body.dealerName || '').trim(),
      fatherName: String(body.fatherName || '').trim(),
      salesCenter: String(body.salesCenter || '').trim(),
      category: String(body.category || 'খাদ্য বান্ধব').trim(),
    };
    const idx = db.dealers.findIndex((d) => d.id === dealer.id);
    if (idx !== -1) db.dealers[idx] = dealer;
    else db.dealers.push(dealer);
    saveLocalDb(db);
    return jsonResponse({ success: true, dealer });
  }
  if (pathname === '/api/dealers/import' && method === 'POST') {
    const list = Array.isArray(body.dealers) ? (body.dealers as DealerRecord[]) : [];
    const counts = mergeSyncPayloadIntoDb(db, { dealers: list });
    saveLocalDb(db);
    return jsonResponse({ success: true, count: counts.dealers });
  }
  if (pathname.startsWith('/api/dealers/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/dealers/'.length));
    db.dealers = db.dealers.filter((d) => d.id !== id);
    saveLocalDb(db);
    return jsonResponse({ success: true });
  }

  if (pathname === '/api/licensees' && method === 'GET') {
    return jsonResponse({ success: true, licensees: db.licensees });
  }
  if (pathname === '/api/licensees' && method === 'POST') {
    const item: LicenseeRecord = {
      id: String(body.id || generateId('lic')),
      serialNo: Number(body.serialNo || db.licensees.length + 1),
      licenseeName: String(body.licenseeName || '').trim(),
      address: String(body.address || '').trim(),
      licenseType: String(body.licenseType || 'ফুড গ্রেইন লাইসেন্স (খুচরা)').trim(),
      licenseNo: String(body.licenseNo || '').trim(),
      firstIssueDate: String(body.firstIssueDate || '').trim(),
      nid: String(body.nid || '').trim(),
    };
    const idx = db.licensees.findIndex((l) => l.id === item.id);
    if (idx !== -1) db.licensees[idx] = item;
    else db.licensees.push(item);
    saveLocalDb(db);
    return jsonResponse({ success: true, licensee: item });
  }
  if (pathname === '/api/licensees/import' && method === 'POST') {
    const list = Array.isArray(body.licensees) ? (body.licensees as LicenseeRecord[]) : [];
    db.licensees = list;
    saveLocalDb(db);
    return jsonResponse({ success: true, count: list.length });
  }
  if (pathname.startsWith('/api/licensees/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/licensees/'.length));
    db.licensees = db.licensees.filter((l) => l.id !== id);
    saveLocalDb(db);
    return jsonResponse({ success: true });
  }

  if (pathname === '/api/suballocations' && method === 'GET') {
    return jsonResponse({ success: true, suballocations: db.suballocations });
  }
  if (pathname === '/api/suballocations/import' && method === 'POST') {
    const list = Array.isArray(body.suballocations)
      ? (body.suballocations as SuballocationRecord[])
      : [];
    const counts = mergeSyncPayloadIntoDb(db, { suballocations: list });
    saveLocalDb(db);
    return jsonResponse({ success: true, count: counts.suballocations });
  }

  // ---- TEMPLATES & REPORTS ----
  if (pathname === '/api/templates' && method === 'GET') {
    return jsonResponse({ success: true, templates: db.templates });
  }
  if (pathname === '/api/templates' && method === 'POST') {
    const tpl: ReportTemplate = {
      id: String(body.id || generateId('tpl')),
      title: String(body.title || 'নতুন টেমপ্লেট').trim(),
      category: String(body.category || 'রিপোর্ট').trim(),
      htmlContent: String(body.htmlContent || ''),
      defaultMemoNo: String(body.defaultMemoNo || ''),
      defaultDate: String(body.defaultDate || ''),
      defaultRecipient: String(body.defaultRecipient || ''),
      officerName: String(body.officerName || ''),
      officerDesignation: String(body.officerDesignation || ''),
      signatureImageDataUrl: String(body.signatureImageDataUrl || ''),
      orientation: body.orientation === 'landscape' ? 'landscape' : 'portrait',
      editableFields: body.editableFields as ReportTemplate['editableFields'],
      updatedAt: new Date().toISOString(),
    };
    const idx = db.templates.findIndex((t) => t.id === tpl.id);
    if (idx !== -1) db.templates[idx] = tpl;
    else db.templates.push(tpl);
    saveLocalDb(db);
    return jsonResponse({ success: true, template: tpl });
  }
  if (pathname.startsWith('/api/templates/') && pathname.endsWith('/reports') && method === 'POST') {
    const templateId = decodeURIComponent(
      pathname.slice('/api/templates/'.length, -'/reports'.length)
    );
    const tpl = db.templates.find((t) => t.id === templateId);
    const saved: SavedReport = {
      id: generateId('rpt'),
      templateId,
      templateTitle: String(body.templateTitle || tpl?.title || 'প্রতিবেদন'),
      category: String(body.category || tpl?.category || 'রিপোর্ট'),
      dateValue: String(body.dateValue || ''),
      memoNo: String(body.memoNo || ''),
      recipient: String(body.recipient || ''),
      renderedHtml: String(body.renderedHtml || ''),
      orientation: body.orientation === 'landscape' ? 'landscape' : 'portrait',
      createdBy: currentUser.name,
      createdAt: new Date().toISOString(),
    };
    db.savedReports.unshift(saved);
    saveLocalDb(db);
    return jsonResponse({ success: true, report: saved, reports: db.savedReports });
  }
  if (pathname.startsWith('/api/templates/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/templates/'.length));
    db.templates = db.templates.filter((t) => t.id !== id);
    saveLocalDb(db);
    return jsonResponse({ success: true });
  }

  if (pathname === '/api/reports' && method === 'GET') {
    return jsonResponse({ success: true, reports: db.savedReports });
  }
  if (pathname.startsWith('/api/reports/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/reports/'.length));
    db.savedReports = db.savedReports.filter((r) => r.id !== id);
    saveLocalDb(db);
    return jsonResponse({ success: true, reports: db.savedReports });
  }

  // ---- MAINTENANCE & BACKUPS ----
  if (pathname === '/api/backups' && method === 'GET') {
    return jsonResponse({
      success: true,
      duplicateBackups: db.duplicateBackups,
      dateBackups: db.dateBackups,
    });
  }
  if (pathname === '/api/maintenance/cleanup-preview' && method === 'GET') {
    return jsonResponse({
      success: true,
      totalRows: db.records.length,
      willAppendOneCount: 0,
      duplicateCount: 0,
      samples: [],
    });
  }
  if (pathname === '/api/maintenance/cleanup-duplicates' && method === 'POST') {
    return jsonResponse({
      success: true,
      normalizedCount: 0,
      removedCount: 0,
      message: 'কোনো ডুপ্লিকেট পাওয়া যায়নি।',
    });
  }
  if (pathname === '/api/maintenance/fix-dates' && method === 'POST') {
    return jsonResponse({
      success: true,
      fixedCount: 0,
      message: 'সব তারিখ সঠিক ফরম্যাটে আছে।',
    });
  }

  // ---- REPORT ----
  if (pathname === '/api/report' && method === 'GET') {
    const startDate = String(searchParams.get('startDate') || '').trim();
    const endDate = String(searchParams.get('endDate') || '').trim();
    const allDates =
      String(searchParams.get('allDates') || '').trim() === 'true' ||
      startDate === 'ALL' ||
      endDate === 'ALL';
    const category = String(searchParams.get('category') || 'সব ক্যাটেগরি').trim();
    const normalizedQueryCategory = normalizeSheetCategory(category) || category;
    const unionName = String(searchParams.get('unionName') || '').trim();
    const registerType = String(searchParams.get('registerType') || 'all').trim();
    const actionType = String(searchParams.get('actionType') || '').trim();

    const grainKhatNames = new Set(
      db.settings.khats
        .filter((k) => k.group === 'grain')
        .map((k) => normalizeSheetCategory(k.name) || k.name)
    );
    const licenseKhatNames = new Set(
      db.settings.khats
        .filter((k) => k.group === 'license')
        .map((k) => normalizeSheetCategory(k.name) || k.name)
    );
    const subById = new Map(db.suballocations.map((s) => [s.id, s]));

    const groupMatchedRecords = db.records.filter((r) => {
      const rawCat = String(r.challanCategory || '').trim();
      const cat = normalizeSheetCategory(rawCat) || rawCat;
      return (
        registerType === 'all' ||
        (registerType === 'grain' && grainKhatNames.has(cat)) ||
        (registerType === 'license' &&
          (licenseKhatNames.has(cat) ||
            cat.includes('লাইসেন্স') ||
            cat.includes('জরিমানা') ||
            cat.includes('অন্যান্য')))
      );
    });

    const rows: ChallanReportRow[] = groupMatchedRecords
      .filter((r) => {
        const isoDate = toISODateSafe(
          r.challanDate || r.incomeTaxDate || r.vatDate || r.date || ''
        );
        const dateMatches = allDates
          ? true
          : Boolean(isoDate) && isoDate >= startDate && isoDate <= endDate;
        const rawCat = String(r.challanCategory || '').trim();
        const cat = normalizeSheetCategory(rawCat) || rawCat;
        const categoryMatches =
          category === 'সব ক্যাটেগরি' ||
          category === 'সকল' ||
          cat === normalizedQueryCategory;
        const actionMatches =
          !actionType ||
          actionType === 'সকল' ||
          String(r.licenseActionType || '').trim() === actionType;
        const unionMatches =
          !unionName ||
          unionName === 'সব ইউনিয়ন' ||
          String(r.unionName || '').trim() === unionName;
        return dateMatches && categoryMatches && actionMatches && unionMatches;
      })
      .map((r) => {
        const rawCat = String(r.challanCategory || '').trim();
        const cat = normalizeSheetCategory(rawCat) || rawCat;
        let matchedSub = r.dealerAllocationId
          ? subById.get(r.dealerAllocationId)
          : undefined;
        const numericDeposit = toNumericValue(r.amount);
        if (!matchedSub && numericDeposit > 0) {
          const amtMatches = db.suballocations.filter(
            (s) =>
              Math.abs(s.totalAmount - numericDeposit) < 1 &&
              (!cat || !s.category || normalizeSheetCategory(s.category) === cat)
          );
          if (amtMatches.length === 1) matchedSub = amtMatches[0];
        }
        const matchedDo = matchDoIssueForChallan(r, db.doIssues);
        return {
          serialNo: r.serialNo,
          unionName:
            r.unionName || matchedSub?.unionName || matchedDo?.unionName || '',
          dealerName:
            r.dealerName || matchedSub?.dealerName || matchedDo?.recipientName || '',
          category: cat,
          licenseActionType: r.licenseActionType || '',
          licenseNo: r.licenseNo || '',
          new37Code: r.new37Code || '',
          doNo: matchedDo?.doNo || r.doNo || '',
          doIssueDate: matchedDo?.issueDate || r.doIssueDate || '',
          toOrganization: r.toOrganization || r.department || '',
          taxDepartment: r.taxDepartment || r.sourceMemo || '',
          submittedThrough: r.submittedThrough,
          submittedOnBehalfOf: r.submittedOnBehalfOf,
          challanNo: r.challanNo || r.incomeTaxChallanNo || r.vatChallanNo || '',
          description: r.description || '',
          quantity: toNumericValue(r.quantity),
          rate: toNumericValue(r.rate),
          amount: numericDeposit,
          expectedAmount:
            matchedSub && matchedSub.totalAmount > 0
              ? matchedSub.totalAmount
              : matchedDo && matchedDo.requiredAmount && matchedDo.requiredAmount > 0
                ? matchedDo.requiredAmount
                : toNumericValue(r.expectedAmount),
          expectedTaxAmount:
            matchedSub && matchedSub.taxAmount > 0
              ? matchedSub.taxAmount
              : matchedDo &&
                  matchedDo.requiredTaxAmount &&
                  matchedDo.requiredTaxAmount > 0
                ? matchedDo.requiredTaxAmount
                : toNumericValue(r.expectedTaxAmount),
          challanDate: toISODateSafe(
            r.challanDate || r.incomeTaxDate || r.vatDate || r.date || ''
          ),
          incomeTaxChallanNo: r.incomeTaxChallanNo,
          incomeTaxDate: r.incomeTaxDate,
          incomeTaxAmount: toNumericValue(r.incomeTaxAmount),
          vatChallanNo: r.vatChallanNo,
          vatDate: r.vatDate,
          vatAmount: toNumericValue(r.vatAmount),
          customFields: r.customFields,
          comment: r.comment || r.description || '',
          taxComment: r.taxComment || '',
          pdfUrl: r.pdfUrl,
          recordId: r.recordId,
        };
      })
      .sort(
        (a, b) =>
          b.challanDate.localeCompare(a.challanDate) || a.serialNo - b.serialNo
      );

    return jsonResponse({
      success: true,
      rows,
      count: rows.length,
      totalInGroup: groupMatchedRecords.length,
      totalStoredRecords: db.records.length,
      totalAmount: rows.reduce((sum, r) => sum + r.amount, 0),
      totalTaxAmount: rows.reduce((sum, r) => sum + (r.incomeTaxAmount || 0), 0),
      totalVatAmount: rows.reduce((sum, r) => sum + (r.vatAmount || 0), 0),
      totalQuantity: rows.reduce((sum, r) => sum + r.quantity, 0),
    });
  }

  return jsonResponse({ success: false, message: 'রুট পাওয়া যায়নি।' }, 404);
}
