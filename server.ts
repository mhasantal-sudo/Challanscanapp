import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
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
} from './src/types.ts';
import {
  areSwappedMonthDayDates,
  buildDefaultCommissionTaxComment,
  DEFAULT_KHATS,
  DEFAULT_SETTINGS,
  extractEconomicCodeFromText,
  extractRemarksFromOfficialPayload,
  extractSpreadsheetId,
  getChallanDepositSortKey,
  getCleanBaseRecordId,
  isSameYearMonth,
  normalizeChallanDate,
  splitTaxDepartmentAndExtra,
} from './src/utils/challan.ts';
import {
  matchDoIssueForChallan,
  normalizeSheetCategory,
  parseChallansFromRows,
  parseCsvMatrix,
  parseDealersFromRows,
  parseDeletedChallanLogsFromRows,
  parseDoIssuesFromRows,
  parseSuballocationsFromRows,
  type DeletedChallanLogEntry,
} from './src/utils/sheetParser.ts';

interface StoredUser extends UserAccount {
  passwordHash: string;
}

interface DatabaseState {
  records: ChallanRecord[];
  duplicateBackups: DuplicateBackupRecord[];
  dateBackups: DateBackupRecord[];
  deletedRecordIds?: string[];
  dealers: DealerRecord[];
  licensees: LicenseeRecord[];
  suballocations: SuballocationRecord[];
  doIssues: DoIssueRecord[];
  templates: ReportTemplate[];
  savedReports: SavedReport[];
  users: StoredUser[];
  settings: AppSettings;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'challan-store.json');

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

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, keyHex] = String(storedHash || '').split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

function toPublicUser(u: StoredUser): UserAccount {
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

function getDefaultSeedUsers(): StoredUser[] {
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
      passwordHash: hashPassword('ChallanAdmin#2026'),
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
      passwordHash: hashPassword('Operator#2026'),
    },
  ];
}

function ensureDb(): DatabaseState {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const initial: DatabaseState = {
      records: [],
      duplicateBackups: [],
      dateBackups: [],
      dealers: [],
      licensees: [],
      suballocations: [],
      doIssues: [],
      templates: [],
      savedReports: [],
      users: getDefaultSeedUsers(),
      settings: DEFAULT_SETTINGS,
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw || '{}') as Partial<DatabaseState>;

  let khats =
    Array.isArray(parsed.settings?.khats) && parsed.settings.khats.length > 0
      ? parsed.settings.khats
      : DEFAULT_KHATS;

  const hasLicenseSubGroup = khats.some(
    (k) => k.group === 'license' && Boolean(k.subGroup)
  );
  if (!hasLicenseSubGroup) {
    const customOrGrain = khats.filter((k) => k.group === 'grain');
    const licenseDefaults = DEFAULT_KHATS.filter((k) => k.group === 'license');
    khats = [...customOrGrain, ...licenseDefaults];
  }

  const allowedEmails =
    Array.isArray(parsed.settings?.allowedEmails) &&
    parsed.settings.allowedEmails.length > 0
      ? Array.from(
          new Set(
            parsed.settings.allowedEmails
              .map((e) => String(e || '').trim().toLowerCase())
              .filter(Boolean)
          )
        )
      : DEFAULT_SETTINGS.allowedEmails;

  const users =
    Array.isArray(parsed.users) && parsed.users.length > 0
      ? parsed.users
      : getDefaultSeedUsers();

  return {
    records: Array.isArray(parsed.records) ? parsed.records : [],
    duplicateBackups: Array.isArray(parsed.duplicateBackups)
      ? parsed.duplicateBackups
      : [],
    dateBackups: Array.isArray(parsed.dateBackups) ? parsed.dateBackups : [],
    deletedRecordIds: Array.isArray(parsed.deletedRecordIds)
      ? parsed.deletedRecordIds
      : [],
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
          allowedEmails,
          lockEnabled:
            typeof parsed.settings.lockEnabled === 'boolean'
              ? parsed.settings.lockEnabled
              : false,
          hideDealerIds:
            typeof parsed.settings.hideDealerIds === 'boolean'
              ? parsed.settings.hideDealerIds
              : DEFAULT_SETTINGS.hideDealerIds,
          doIssueTabName:
            parsed.settings.doIssueTabName || DEFAULT_SETTINGS.doIssueTabName,
          licenseFees:
            Array.isArray(parsed.settings.licenseFees) &&
            parsed.settings.licenseFees.length > 0
              ? parsed.settings.licenseFees
              : DEFAULT_SETTINGS.licenseFees,
          customColumns: Array.isArray(parsed.settings.customColumns)
            ? parsed.settings.customColumns
            : DEFAULT_SETTINGS.customColumns,
          khats,
        }
      : DEFAULT_SETTINGS,
  };
}

function saveDb(state: DatabaseState): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

let writeQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = writeQueue.then(() => fn());
  writeQueue = next.catch(() => undefined);
  return next;
}

// Persistent HMAC-signed session tokens so server restarts never drop logged-in users
const SESSION_COOKIE_NAME = 'challan_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const revokedTokens = new Set<string>();
let cachedSessionSecret: string | null = null;

function getSessionSecret(): string {
  if (cachedSessionSecret) return cachedSessionSecret;
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const existing = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) {
        cachedSessionSecret = existing;
        return existing;
      }
    }
  } catch {
    // ignore read failure and regenerate
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SESSION_SECRET_FILE, generated, 'utf8');
  } catch {
    // keep in memory if filesystem is read-only
  }
  cachedSessionSecret = generated;
  return generated;
}

function createSessionToken(userId: string): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string): string | null {
  if (!token || revokedTokens.has(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresStr, sig] = parts;
  const expiresAt = Number(expiresStr);
  if (!userId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(`${userId}.${expiresStr}`)
    .digest('hex');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  return userId;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) out[key] = val;
  }
  return out;
}

function getSessionTokenFromRequest(req: Request): string {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || '';
}

function getDefaultUnlockedUser(db: DatabaseState): StoredUser | null {
  return (
    db.users.find((u) => u.role === 'admin' && u.active) ||
    db.users.find((u) => u.active) ||
    db.users[0] ||
    null
  );
}

function getAuthenticatedUser(req: Request): StoredUser | null {
  const db = ensureDb();
  const token = getSessionTokenFromRequest(req);
  if (token) {
    const userId = verifySessionToken(token);
    if (userId) {
      const user = db.users.find((u) => u.id === userId && u.active);
      if (user) return user;
    }
  }
  if (!db.settings?.lockEnabled) {
    return getDefaultUnlockedUser(db);
  }
  return null;
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

function hasPermission(user: StoredUser, perm: PermissionKey): boolean {
  if (user.role === 'admin') return true;
  return Boolean(user.permissions?.[perm]);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({
      success: false,
      error: 'অনুগ্রহ করে প্রথমে লগইন করুন।',
      message: 'অনুগ্রহ করে প্রথমে লগইন করুন।',
    });
    return;
  }
  next();
}

function requirePermission(perm: PermissionKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'অনুগ্রহ করে প্রথমে লগইন করুন।',
        message: 'অনুগ্রহ করে প্রথমে লগইন করুন।',
      });
      return;
    }
    if (!hasPermission(user, perm)) {
      res.status(403).json({
        success: false,
        error: 'এই বাটনে কাজ করার অনুমতি আপনার নেই।',
        message: 'এই বাটনে কাজ করার অনুমতি আপনার নেই।',
      });
      return;
    }
    next();
  };
}

function toEnglishDigits(value: string | number | null | undefined): string {
  return String(value ?? '').replace(/[০-৯]/g, (d) =>
    String('০১২৩৪৫৬৭৮৯'.indexOf(d))
  );
}

function normalizeChallanNo(no: string): string {
  const s = toEnglishDigits(no).trim();
  const m = s.match(/^(\d{4})\s*-\s*(\d+)$/);
  if (!m) return s;
  const body = m[2].length === 10 ? m[2] + '1' : m[2];
  return `${m[1]}-${body}`;
}

function cleanChallanNo(no: string | number | null | undefined): string {
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

type ServerChallanSlot = 'main' | 'tax' | 'vat';

function getServerChallanSlotLabel(slot: ServerChallanSlot): string {
  if (slot === 'tax') return 'আয়কর চালান (Col M)';
  if (slot === 'vat') return 'ভ্যাট চালান (Col S)';
  return 'মূল চালান (Col H)';
}

function findGlobalChallanConflict(
  records: ChallanRecord[],
  incoming: { main?: string; tax?: string; vat?: string },
  excludeRecordId?: string
): {
  number: string;
  incomingSlot: ServerChallanSlot;
  existingSlot: ServerChallanSlot;
  existingRecord?: ChallanRecord;
  message: string;
} | null {
  const main = cleanChallanNo(incoming.main);
  const tax = cleanChallanNo(incoming.tax);
  const vat = cleanChallanNo(incoming.vat);

  if (main && tax && main === tax) {
    return {
      number: main,
      incomingSlot: 'tax',
      existingSlot: 'main',
      message: `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${main}) মূল চালান ও আয়কর চালান উভয় ঘরে থাকতে পারবে না।`,
    };
  }
  if (main && vat && main === vat) {
    return {
      number: main,
      incomingSlot: 'vat',
      existingSlot: 'main',
      message: `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${main}) মূল চালান ও ভ্যাট চালান উভয় ঘরে থাকতে পারবে না।`,
    };
  }
  if (tax && vat && tax === vat) {
    return {
      number: tax,
      incomingSlot: 'vat',
      existingSlot: 'tax',
      message: `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${tax}) আয়কর চালান ও ভ্যাট চালান উভয় ঘরে থাকতে পারবে না।`,
    };
  }

  const incomingItems: Array<{ slot: ServerChallanSlot; num: string }> = [];
  if (main) incomingItems.push({ slot: 'main', num: main });
  if (tax) incomingItems.push({ slot: 'tax', num: tax });
  if (vat) incomingItems.push({ slot: 'vat', num: vat });
  if (incomingItems.length === 0) return null;

  for (const r of records) {
    if (excludeRecordId && r.recordId === excludeRecordId) continue;
    const rMain = cleanChallanNo(r.challanNo);
    const rTax = cleanChallanNo(r.incomeTaxChallanNo);
    const rVat = cleanChallanNo(r.vatChallanNo);

    for (const item of incomingItems) {
      let existingSlot: ServerChallanSlot | null = null;
      if (rMain && rMain === item.num) existingSlot = 'main';
      else if (rTax && rTax === item.num) existingSlot = 'tax';
      else if (rVat && rVat === item.num) existingSlot = 'vat';

      if (existingSlot) {
        const who = r.dealerName ? ` (${r.dealerName})` : '';
        return {
          number: item.num,
          incomingSlot: item.slot,
          existingSlot,
          existingRecord: r,
          message: `বাধা দেওয়া হয়েছে: চালান নম্বর ${item.num} সম্পূর্ণ শিটে কেবল একবারই থাকবে — এটি আগে থেকেই ক্রমিক ${r.serialNo}${who}-এর ${getServerChallanSlotLabel(existingSlot)} হিসেবে সংরক্ষিত আছে! দ্বিতীয়বার যোগ করা যাবে না।`,
        };
      }
    }
  }
  return null;
}

function parseChallanDate(text: string): { display: string; iso: string } {
  const cleaned = toEnglishDigits(text).trim();
  if (!cleaned) {
    return { display: '', iso: '' };
  }

  let y: number;
  let mo: number;
  let d: number;

  const isoMatch = cleaned.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:$|T|\s)/);
  if (isoMatch) {
    y = Number(isoMatch[1]);
    mo = Number(isoMatch[2]);
    d = Number(isoMatch[3]);
  } else {
    const m = cleaned.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
    if (!m) {
      throw new Error(
        'চালান জমার তারিখ বোঝা যায়নি। বছর-মাস-তারিখ (yyyy-MM-dd) অথবা দিন/মাস/বছর লিখুন।'
      );
    }
    d = Number(m[1]);
    mo = Number(m[2]);
    y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
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

  const dd = String(d).padStart(2, '0');
  const mm = String(mo).padStart(2, '0');
  const formatted = `${y}-${mm}-${dd}`;
  return {
    display: formatted,
    iso: formatted,
  };
}

function toISODateSafe(value: string): string {
  const text = toEnglishDigits(value).trim();
  if (!text) return '';
  const isoMatch = text.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:$|T|\s)/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(
      2,
      '0'
    )}`;
  }
  const match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(
      2,
      '0'
    )}`;
  }
  return '';
}

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = toEnglishDigits(value)
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

class AchallanHttpError extends Error {
  statusCode: number;
  retryable: boolean;
  cooldownMs: number;
  constructor(
    statusCode: number,
    message: string,
    retryable = false,
    cooldownMs = 0
  ) {
    super(message);
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.cooldownMs = cooldownMs;
  }
}

const OFFICIAL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const officialChallanCache = new Map<
  string,
  { data: OfficialChallanData; cachedAt: number }
>();
const officialLookupInFlight = new Map<string, Promise<OfficialChallanData>>();

let achallanCooldownUntil = 0;
let lastInteractiveOfficialLookupAt = 0;
let achallanCookieJar = '';
let gasRelayUnsupportedAt = 0;
const GAS_RELAY_RETRY_MS = 5 * 60 * 1000;

function cacheOfficialPayload(
  keys: string[],
  data: OfficialChallanData
): void {
  const now = Date.now();
  if (officialChallanCache.size > 600) {
    const oldestKey = officialChallanCache.keys().next().value;
    if (oldestKey) officialChallanCache.delete(oldestKey);
  }
  for (const k of keys) {
    if (k) officialChallanCache.set(k, { data, cachedAt: now });
  }
}

function getCachedOfficialPayload(keys: string[]): OfficialChallanData | null {
  const now = Date.now();
  for (const k of keys) {
    if (!k) continue;
    const hit = officialChallanCache.get(k);
    if (hit) {
      if (now - hit.cachedAt <= OFFICIAL_CACHE_TTL_MS) {
        return hit.data;
      }
      officialChallanCache.delete(k);
    }
  }
  return null;
}

function extractSetCookieHeader(headers: Headers): string {
  const rawList =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : headers.get('set-cookie')
      ? [headers.get('set-cookie') || '']
      : [];
  const pairs: string[] = [];
  for (const item of rawList) {
    const first = String(item || '').split(';')[0].trim();
    if (first && first.includes('=')) pairs.push(first);
  }
  return pairs.join('; ');
}

function parseOfficialHtmlPayload(
  html: string,
  queryNo: string,
  cleaned11: string,
  has11CheckDigit: boolean
): OfficialChallanData {
  const objMatch = html.match(/var\s+obj\s*=\s*(\{[\s\S]*?\});/);
  if (!objMatch) {
    throw new AchallanHttpError(
      404,
      'সরকারি পেজে চালানের তথ্য পাওয়া যায়নি।',
      false
    );
  }

  const data = JSON.parse(objMatch[1]) as Record<string, unknown>;
  if (String(data.ChallanNo || '') !== queryNo) {
    throw new AchallanHttpError(
      404,
      'প্রাপ্ত চালান নম্বরের সঙ্গে মিল পাওয়া যায়নি।',
      false
    );
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

  const returnedChallanNo = has11CheckDigit
    ? cleaned11
    : normalizeChallanNo(String(data.ChallanNo || ''));

  return {
    ChallanNo: returnedChallanNo,
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

function isValidGasWebAppUrl(url: string): boolean {
  const u = String(url || '').trim();
  if (
    !u.startsWith('https://script.google.com/') &&
    !u.startsWith('https://script.googleusercontent.com/')
  ) {
    return false;
  }
  if (/\/dev(\?|$)/i.test(u)) return false;
  if (
    u.includes('script.google.com') &&
    (!u.includes('/macros/s/') || /\/edit(\?|$|#)/i.test(u))
  ) {
    return false;
  }
  return true;
}

async function fetchOfficialChallanViaGasRelay(
  cleaned: string,
  queryNo: string,
  gasUrlOverride?: string
): Promise<OfficialChallanData | null> {
  if (
    gasRelayUnsupportedAt > 0 &&
    Date.now() - gasRelayUnsupportedAt < GAS_RELAY_RETRY_MS
  ) {
    return null;
  }
  const dbUrl = ensureDb().settings.gasWebAppUrl || '';
  const gasUrl = String(gasUrlOverride || dbUrl).trim();
  if (!isValidGasWebAppUrl(gasUrl)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14000);
  try {
    const response = await fetch(gasUrl, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fetchOfficialChallan',
        payload: { challanNo: cleaned },
      }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    // Older Code.gs without fetchOfficialChallan falls through to syncAll returning `tabs`
    if ('tabs' in parsed && !('data' in parsed)) {
      gasRelayUnsupportedAt = Date.now();
      return null;
    }

    if (
      parsed.success === true &&
      parsed.data &&
      typeof parsed.data === 'object'
    ) {
      const payload = parsed.data as OfficialChallanData;
      if (payload.ChallanNo) {
        gasRelayUnsupportedAt = 0;
        const normalizedReturn = normalizeChallanNo(payload.ChallanNo || cleaned);
        const result: OfficialChallanData = {
          ...payload,
          ChallanNo: normalizedReturn || cleaned,
        };
        cacheOfficialPayload([queryNo, cleaned, result.ChallanNo], result);
        return result;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOfficialChallanDirectOnce(
  queryNo: string,
  cleaned: string,
  has11CheckDigit: boolean,
  timeoutMs = 14000
): Promise<{ ok: true; data: OfficialChallanData } | { ok: false; status: number }> {
  const url = `https://www.achallan.gov.bd/acs/General/PrintChallanSlipDetailsHTML?challanNo=${encodeURIComponent(
    queryNo
  )}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const reqHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
      Referer: 'https://www.achallan.gov.bd/acs/General/VerifyChallan',
      'Cache-Control': 'no-cache',
    };
    if (achallanCookieJar) {
      reqHeaders.Cookie = achallanCookieJar;
    }

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: reqHeaders,
    });

    const newCookie = extractSetCookieHeader(response.headers);
    if (newCookie) {
      achallanCookieJar = newCookie;
    }

    if (response.status === 409) {
      return { ok: false, status: 409 };
    }

    if (!response.ok) {
      return { ok: false, status: response.status };
    }

    const html = await response.text();
    const parsed = parseOfficialHtmlPayload(
      html,
      queryNo,
      cleaned,
      has11CheckDigit
    );
    achallanCooldownUntil = 0;
    return { ok: true, data: parsed };
  } catch (err) {
    if (err instanceof AchallanHttpError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AchallanHttpError(
        504,
        'সরকারি সার্ভার সাড়া দিতে বেশি সময় নিচ্ছে। আবার চেষ্টা করুন।',
        true,
        3000
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOfficialChallanData(
  rawChallanNo: string,
  options: { interactive?: boolean; gasUrlOverride?: string } = {}
): Promise<OfficialChallanData> {
  const interactive = options.interactive !== false;
  const cleaned = toEnglishDigits(rawChallanNo).trim();
  const match11 = cleaned.match(/^(\d{4})-(\d{10})(\d)$/);
  const queryNo = match11 ? `${match11[1]}-${match11[2]}` : cleaned;

  if (!/^\d{4}-\d{10}$/.test(queryNo)) {
    throw new AchallanHttpError(
      400,
      'সঠিক চালান নম্বর পাওয়া যায়নি। (ফরম্যাট: YYYY-XXXXXXXXXX বা ১১ অঙ্ক)',
      false
    );
  }

  const cacheKeys = [queryNo, cleaned];
  const cached = getCachedOfficialPayload(cacheKeys);
  if (cached) {
    if (interactive) {
      lastInteractiveOfficialLookupAt = Date.now();
    }
    return cached;
  }

  if (interactive) {
    lastInteractiveOfficialLookupAt = Date.now();
    if (enrichRetryTimer) {
      clearTimeout(enrichRetryTimer);
      enrichRetryTimer = null;
    }
  }

  const existingInFlight = officialLookupInFlight.get(queryNo);
  if (existingInFlight) {
    return existingInFlight;
  }

  const promise = (async (): Promise<OfficialChallanData> => {
    try {
      // Background enrichment must never fight active cooldowns or hit GAS relay
      if (!interactive && Date.now() < achallanCooldownUntil) {
        throw new AchallanHttpError(
          409,
          'সরকারি পেজ থেকে তথ্য আনা যায়নি। HTTP: 409',
          true,
          Math.max(5000, achallanCooldownUntil - Date.now())
        );
      }

      // If primary IP is already known to be in 409 cooldown during interactive scan, try GAS relay first!
      if (interactive && Date.now() < achallanCooldownUntil) {
        const gasData = await fetchOfficialChallanViaGasRelay(
          cleaned,
          queryNo,
          options.gasUrlOverride
        );
        if (gasData) return gasData;
      }

      const maxAttempts = interactive ? 2 : 1;
      let lastStatus = 409;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          // Clear sticky SERVERID cookie when rotating on retry after 409
          achallanCookieJar = '';
          await new Promise((r) => setTimeout(r, 1800));
        }

        const result = await fetchOfficialChallanDirectOnce(
          queryNo,
          cleaned,
          Boolean(match11),
          interactive ? 14000 : 10000
        );

        if (result.ok) {
          cacheOfficialPayload(
            [queryNo, cleaned, result.data.ChallanNo],
            result.data
          );
          return result.data;
        }

        lastStatus = result.status;
        if (result.status === 409) {
          achallanCooldownUntil = Date.now() + 25000;
          if (interactive) {
            // Try Google Apps Script global IP relay immediately on 409 before burning more time
            const gasData = await fetchOfficialChallanViaGasRelay(
              cleaned,
              queryNo,
              options.gasUrlOverride
            );
            if (gasData) return gasData;
            continue;
          }
          break;
        }

        throw new AchallanHttpError(
          result.status,
          `সরকারি পেজ থেকে তথ্য আনা যায়নি। HTTP: ${result.status}`,
          result.status >= 500
        );
      }

      if (lastStatus === 409) {
        achallanCooldownUntil = Date.now() + 25000;
        enrichCooldownUntil = Math.max(
          enrichCooldownUntil,
          Date.now() + 180000
        );
      }
      throw new AchallanHttpError(
        lastStatus,
        `সরকারি পেজ থেকে তথ্য আনা যায়নি। HTTP: ${lastStatus}`,
        lastStatus === 409 || lastStatus >= 500,
        lastStatus === 409 ? 5000 : 3000
      );
    } finally {
      officialLookupInFlight.delete(queryNo);
    }
  })();

  officialLookupInFlight.set(queryNo, promise);
  return promise;
}

async function fetchPublicSheetTabCsv(
  spreadsheetId: string,
  tabName: string,
  timeoutMs = 8000
): Promise<{ accessible: boolean; rows: string[][] }> {
  const cleanTab = tabName.trim();
  if (!spreadsheetId.trim() || !cleanTab) {
    return { accessible: false, rows: [] };
  }
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
    spreadsheetId.trim()
  )}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(cleanTab)}&_=${Date.now()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/csv,text/plain,*/*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    });
    if (!res.ok) {
      return { accessible: false, rows: [] };
    }
    if (res.url && res.url.includes('accounts.google.com')) {
      return { accessible: false, rows: [] };
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
      return { accessible: false, rows: [] };
    }
    return { accessible: true, rows: parseCsvMatrix(trimmed) };
  } catch {
    return { accessible: false, rows: [] };
  } finally {
    clearTimeout(timer);
  }
}

function mergeSyncPayloadIntoDb(
  db: DatabaseState,
  payload: {
    dealers?: DealerRecord[] | null;
    suballocations?: SuballocationRecord[] | null;
    doIssues?: DoIssueRecord[] | null;
    challans?: ChallanRecord[] | null;
    challansVerified?: boolean;
    pendingRecordIds?: string[];
    deletedRecordIds?: string[];
    deletedChallanLogs?: DeletedChallanLogEntry[];
    reconcileMissing?: boolean;
    extShadowCount?: number;
  }
): {
  dealers: number;
  suballocations: number;
  doIssues: number;
  records: number;
  removedRecords: number;
  removedIds: string[];
  localOnlyRecords: number;
  localOnlyIds: string[];
  extShadowCount: number;
} {
  if (Array.isArray(payload.dealers) && payload.dealers.length > 0) {
    const dealerMap = new Map<string, DealerRecord>();
    for (const d of payload.dealers) {
      dealerMap.set(d.id || `${d.dealerName}::${d.unionName}`, d);
    }
    for (const localD of db.dealers) {
      const key = localD.id || `${localD.dealerName}::${localD.unionName}`;
      if (!dealerMap.has(key)) {
        dealerMap.set(key, localD);
      }
    }
    db.dealers = Array.from(dealerMap.values());
  }

  if (Array.isArray(payload.suballocations) && payload.suballocations.length > 0) {
    const subMap = new Map<string, SuballocationRecord>();
    for (const s of payload.suballocations) {
      subMap.set(s.id, s);
    }
    for (const localS of db.suballocations) {
      if (!subMap.has(localS.id)) {
        subMap.set(localS.id, localS);
      }
    }
    db.suballocations = Array.from(subMap.values());
  }

  if (Array.isArray(payload.doIssues) && payload.doIssues.length > 0) {
    const doMap = new Map<string, DoIssueRecord>();
    for (const d of payload.doIssues) {
      const key = d.challanNo ? `${d.challanNo}::${d.doNo}` : d.id;
      doMap.set(key, d);
    }
    for (const localDo of db.doIssues) {
      const key = localDo.challanNo
        ? `${localDo.challanNo}::${localDo.doNo}`
        : localDo.id;
      if (!doMap.has(key)) {
        doMap.set(key, localDo);
      }
    }
    db.doIssues = Array.from(doMap.values());
  }

  const removedIds: string[] = [];
  const logExtraRemovedIds: string[] = [];
  const localOnlyIds: string[] = [];
  const pendingSet = new Set((payload.pendingRecordIds || []).filter(Boolean));
  const mergedDeleted = Array.from(
    new Set([
      ...(Array.isArray(db.deletedRecordIds) ? db.deletedRecordIds : []),
      ...(payload.deletedRecordIds || []),
    ].filter(Boolean))
  ).slice(-2000);
  db.deletedRecordIds = mergedDeleted;
  const deletedSet = new Set(mergedDeleted);
  const canReconcileChallans =
    Array.isArray(payload.challans) &&
    (payload.challans.length > 0 || Boolean(payload.challansVerified));

  const livePayloadRecordIds = new Set<string>();
  const livePayloadBaseIds = new Set<string>();
  if (Array.isArray(payload.challans)) {
    for (const c of payload.challans) {
      if (c.recordId) livePayloadRecordIds.add(c.recordId);
      const cId = String(c.id || '').trim();
      if (cId && !/^ch-ext-/i.test(cId)) {
        const base = getCleanBaseRecordId(cId);
        if (base) livePayloadBaseIds.add(base);
      }
    }
  }

  if (Array.isArray(payload.deletedChallanLogs)) {
    for (const entry of payload.deletedChallanLogs) {
      const candidates = [
        String(entry.srcRecordId || '').trim(),
        entry.id ? getCleanBaseRecordId(String(entry.id)) : '',
      ].filter(Boolean);
      for (const cid of candidates) {
        if (livePayloadRecordIds.has(cid) || livePayloadBaseIds.has(cid)) {
          continue;
        }
        if (!deletedSet.has(cid)) {
          deletedSet.add(cid);
        }
        logExtraRemovedIds.push(cid);
      }
    }
  }

  if (canReconcileChallans && Array.isArray(payload.challans)) {
    const indexByRecordId = new Map<string, number>();
    const indexById = new Map<string, number>();
    const indexByAnyNo = new Map<string, number>();
    const matchedLocalIndices = new Set<number>();

    const indexRecord = (r: ChallanRecord, idx: number) => {
      if (r.recordId && !indexByRecordId.has(r.recordId)) {
        indexByRecordId.set(r.recordId, idx);
      }
      if (r.id && !/^ch-ext-/i.test(String(r.id)) && !indexById.has(r.id)) {
        indexById.set(r.id, idx);
      }
      const m = cleanChallanNo(r.challanNo);
      const t = cleanChallanNo(r.incomeTaxChallanNo);
      const v = cleanChallanNo(r.vatChallanNo);
      if (m && !indexByAnyNo.has(m)) indexByAnyNo.set(m, idx);
      if (t && !indexByAnyNo.has(t)) indexByAnyNo.set(t, idx);
      if (v && !indexByAnyNo.has(v)) indexByAnyNo.set(v, idx);
    };

    const unindexRecordNumbers = (r: ChallanRecord, idx: number) => {
      for (const raw of [r.challanNo, r.incomeTaxChallanNo, r.vatChallanNo]) {
        const num = cleanChallanNo(raw);
        if (num && indexByAnyNo.get(num) === idx) {
          indexByAnyNo.delete(num);
        }
      }
    };

    db.records.forEach((r, idx) => indexRecord(r, idx));

    const orderedChallans = [
      ...payload.challans.filter((c) => !/^ch-ext-/i.test(String(c.id || ''))),
      ...payload.challans.filter((c) => /^ch-ext-/i.test(String(c.id || ''))),
    ];

    for (const c of orderedChallans) {
      if (c.recordId && deletedSet.has(c.recordId)) {
        continue;
      }

      const cMain = cleanChallanNo(c.challanNo);
      let cTax = cleanChallanNo(c.incomeTaxChallanNo);
      let cVat = cleanChallanNo(c.vatChallanNo);

      if (cTax && cTax === cMain) cTax = '';
      if (cVat && (cVat === cMain || cVat === cTax)) cVat = '';

      if (!cMain && !cTax && !cVat) continue;

      const isExternalDupRow = /^ch-ext-/i.test(String(c.id || ''));
      let directIdx: number | undefined;
      if (!isExternalDupRow) {
        if (c.recordId && indexByRecordId.has(c.recordId)) {
          directIdx = indexByRecordId.get(c.recordId);
        } else if (c.id && indexById.has(c.id)) {
          directIdx = indexById.get(c.id);
        }
      }

      const matchedIndices = new Set<number>();
      if (directIdx !== undefined) {
        matchedIndices.add(directIdx);
      } else {
        if (cMain && indexByAnyNo.has(cMain)) {
          matchedIndices.add(indexByAnyNo.get(cMain)!);
        }
        if (cTax && indexByAnyNo.has(cTax)) {
          matchedIndices.add(indexByAnyNo.get(cTax)!);
        }
        if (cVat && indexByAnyNo.has(cVat)) {
          matchedIndices.add(indexByAnyNo.get(cVat)!);
        }
      }

      if (matchedIndices.size > 0) {
        for (const mi of matchedIndices) {
          matchedLocalIndices.add(mi);
        }
        if (isExternalDupRow) {
          continue;
        }
        if (matchedIndices.size === 1) {
          const existingIdx = Array.from(matchedIndices)[0];
          const cur = db.records[existingIdx];
          if (cur.recordId && pendingSet.has(cur.recordId)) {
            continue;
          }

          unindexRecordNumbers(cur, existingIdx);

          const safeMain =
            cMain && !indexByAnyNo.has(cMain) ? cMain : '';
          const safeTax =
            cTax && cTax !== safeMain && !indexByAnyNo.has(cTax)
              ? cTax
              : '';
          const safeVat =
            cVat &&
            cVat !== safeMain &&
            cVat !== safeTax &&
            !indexByAnyNo.has(cVat)
              ? cVat
              : '';

          const sheetMainDate = normalizeChallanDate(c.challanDate);
          const sheetTaxDate = normalizeChallanDate(c.incomeTaxDate);
          const sheetVatDate = normalizeChallanDate(c.vatDate);
          const sheetRowDate = normalizeChallanDate(c.date);
          const safeSheetRowDate =
            sheetRowDate &&
            sheetMainDate &&
            areSwappedMonthDayDates(sheetRowDate, sheetMainDate)
              ? sheetMainDate
              : sheetRowDate;

          const hasMainSlot = Boolean(safeMain || toNumber(c.amount) > 0);
          const hasTaxSlot = Boolean(safeTax || toNumber(c.incomeTaxAmount) > 0);
          const hasVatSlot = Boolean(safeVat || toNumber(c.vatAmount) > 0);
          const mergedCategory =
            normalizeSheetCategory(c.challanCategory || cur.challanCategory) ||
            cur.challanCategory ||
            c.challanCategory;
          const preservedTaxComment =
            hasTaxSlot || hasVatSlot
              ? c.taxComment ||
                cur.taxComment ||
                (hasTaxSlot
                  ? buildDefaultCommissionTaxComment(
                      mergedCategory,
                      sheetTaxDate || sheetMainDate || sheetRowDate,
                      safeTax
                    )
                  : '')
              : c.taxComment || '';

          db.records[existingIdx] = {
            ...cur,
            id: cur.id || c.id,
            recordId: cur.recordId || c.recordId || crypto.randomUUID(),
            date:
              safeSheetRowDate ||
              sheetMainDate ||
              sheetTaxDate ||
              sheetVatDate ||
              '',
            department: c.department || cur.department || '',
            taxDepartment:
              hasTaxSlot || hasVatSlot
                ? c.taxDepartment || c.sourceMemo || cur.taxDepartment || ''
                : c.taxDepartment || c.sourceMemo || '',
            toOrganization:
              c.toOrganization || c.department || cur.toOrganization || '',
            dealerName: c.dealerName || cur.dealerName,
            unionName: c.unionName || cur.unionName,
            dealerAllocationId: c.dealerAllocationId || cur.dealerAllocationId || '',
            challanCategory: mergedCategory,
            licenseActionType: c.licenseActionType || cur.licenseActionType || '',
            challanNo: safeMain,
            challanDate: sheetMainDate,
            rate: c.rate || '',
            quantity: c.quantity || '',
            amount: c.amount || '',
            expectedAmount: c.expectedAmount || cur.expectedAmount,
            expectedTaxAmount: c.expectedTaxAmount || cur.expectedTaxAmount,
            incomeTaxChallanNo: safeTax,
            incomeTaxDate: sheetTaxDate,
            incomeTaxAmount: c.incomeTaxAmount || '',
            vatChallanNo: safeVat,
            vatDate: sheetVatDate,
            vatAmount: c.vatAmount || '',
            licenseNo: c.licenseNo || cur.licenseNo || '',
            new37Code: hasMainSlot ? c.new37Code || cur.new37Code || '' : c.new37Code || '',
            taxCode: hasTaxSlot ? c.taxCode || cur.taxCode || '' : c.taxCode || '',
            vatCode: hasVatSlot ? c.vatCode || cur.vatCode || '' : c.vatCode || '',
            comment:
              hasMainSlot || (!hasTaxSlot && !hasVatSlot)
                ? c.comment || cur.comment || ''
                : c.comment || '',
            taxComment: preservedTaxComment,
            taxExtra:
              hasTaxSlot || hasVatSlot
                ? c.taxExtra || cur.taxExtra || ''
                : c.taxExtra || '',
            doNo: c.doNo || cur.doNo,
            doIssueDate: normalizeChallanDate(c.doIssueDate) || cur.doIssueDate,
            customFields: c.customFields || cur.customFields,
            taxCustomFields: c.taxCustomFields || cur.taxCustomFields,
            vatCustomFields: c.vatCustomFields || cur.vatCustomFields,
          };
          indexRecord(db.records[existingIdx], existingIdx);
        }
        continue;
      }

      const newIdx = db.records.length;
      const newTaxComment =
        c.taxComment ||
        (cTax || toNumber(c.incomeTaxAmount) > 0
          ? buildDefaultCommissionTaxComment(
              normalizeSheetCategory(c.challanCategory) || c.challanCategory,
              normalizeChallanDate(c.incomeTaxDate || c.challanDate || c.date),
              cTax
            )
          : '');
      const cleanRec: ChallanRecord = {
        ...c,
        id: c.id || `CHL-${newIdx + 1}`,
        recordId: c.recordId || crypto.randomUUID(),
        date: normalizeChallanDate(
          c.date || c.challanDate || c.incomeTaxDate || c.vatDate
        ),
        challanNo: cMain,
        challanDate: normalizeChallanDate(c.challanDate),
        incomeTaxChallanNo: cTax,
        incomeTaxDate: normalizeChallanDate(c.incomeTaxDate),
        vatChallanNo: cVat,
        vatDate: normalizeChallanDate(c.vatDate),
        doIssueDate: normalizeChallanDate(c.doIssueDate),
        challanCategory:
          normalizeSheetCategory(c.challanCategory) || c.challanCategory,
        taxComment: newTaxComment,
        serialNo: newIdx + 1,
      };
      db.records.push(cleanRec);
      indexRecord(cleanRec, newIdx);
      matchedLocalIndices.add(newIdx);
    }

    const keptRecords: ChallanRecord[] = [];
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const shouldReconcileMissing = Boolean(payload.reconcileMissing);
    let anyRemoved = false;

    for (let idx = 0; idx < db.records.length; idx++) {
      const rec = db.records[idx];
      if (rec.recordId && deletedSet.has(rec.recordId)) {
        removedIds.push(rec.recordId);
        anyRemoved = true;
        continue;
      }
      if (
        matchedLocalIndices.has(idx) ||
        (rec.recordId && pendingSet.has(rec.recordId))
      ) {
        keptRecords.push(rec);
        continue;
      }
      const entryTs = Date.parse(rec.entryTime || '');
      const isFreshlyCreated =
        Number.isFinite(entryTs) && nowMs - entryTs < 90 * 1000;
      if (shouldReconcileMissing && !isFreshlyCreated) {
        db.duplicateBackups.push({
          ...rec,
          deletedAt: nowIso,
          originalRowNo: idx + 2,
        });
        if (rec.recordId) {
          removedIds.push(rec.recordId);
          deletedSet.add(rec.recordId);
        }
        anyRemoved = true;
      } else {
        // Non-destructive merge when reconciliation is skipped or entry is freshly created (<90s)
        keptRecords.push(rec);
        if (rec.recordId && !/^ch-ext-/i.test(String(rec.id || rec.recordId))) {
          localOnlyIds.push(rec.recordId);
        }
      }
    }
    if (anyRemoved) {
      db.records = keptRecords.map((rec, i) => ({
        ...rec,
        serialNo: i + 1,
      }));
    }
  }

  db.deletedRecordIds = Array.from(deletedSet).slice(-2000);
  const removedCountFromRecords = removedIds.length;
  const allRemovedIds = Array.from(
    new Set([...removedIds, ...logExtraRemovedIds].filter(Boolean))
  );

  const subById = new Map(db.suballocations.map((s) => [s.id, s]));
  db.records = db.records.map((r) => {
    const normalizedCat =
      normalizeSheetCategory(r.challanCategory) || r.challanCategory;
    let matchedSub = r.dealerAllocationId
      ? subById.get(r.dealerAllocationId)
      : undefined;
    if (!matchedSub && r.amount) {
      const numAmt = toNumber(r.amount);
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
        r.dealerName ||
        matchedSub?.dealerName ||
        matchedDo?.recipientName ||
        '',
      unionName:
        r.unionName ||
        matchedSub?.unionName ||
        matchedDo?.unionName ||
        '',
      expectedAmount:
        matchedSub && matchedSub.totalAmount > 0
          ? String(matchedSub.totalAmount)
          : matchedDo && matchedDo.requiredAmount && matchedDo.requiredAmount > 0
            ? String(matchedDo.requiredAmount)
            : r.expectedAmount || '',
      expectedTaxAmount:
        matchedSub && matchedSub.taxAmount > 0
          ? String(matchedSub.taxAmount)
          : matchedDo && matchedDo.requiredTaxAmount && matchedDo.requiredTaxAmount > 0
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
    removedRecords: removedCountFromRecords,
    removedIds: allRemovedIds,
    localOnlyRecords: localOnlyIds.length,
    localOnlyIds,
    extShadowCount: Number(payload.extShadowCount || 0),
  };
}

async function pullAndMergePublicGoogleSheet(
  overrideSettings?: Partial<AppSettings> & {
    pendingRecordIds?: string[];
    deletedRecordIds?: string[];
    reconcileMissing?: boolean;
  }
): Promise<{
  dealers: number;
  suballocations: number;
  doIssues: number;
  records: number;
  removedRecords: number;
  removedIds: string[];
  localOnlyRecords: number;
  localOnlyIds: string[];
  extShadowCount: number;
}> {
  const current = ensureDb();
  const cfg: AppSettings = {
    ...current.settings,
    ...(overrideSettings || {}),
  };
  const spreadsheetId = extractSpreadsheetId(cfg.spreadsheetId);
  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID নির্ধারিত নেই।');
  }

  const [foodRes, omsRes, subRes, doRes, chlRes, delLogRes] = await Promise.all([
    fetchPublicSheetTabCsv(spreadsheetId, cfg.foodDealerTabName),
    fetchPublicSheetTabCsv(spreadsheetId, cfg.omsDealerTabName),
    fetchPublicSheetTabCsv(spreadsheetId, cfg.suballocationTabName),
    fetchPublicSheetTabCsv(spreadsheetId, cfg.doIssueTabName || 'DO_Issue'),
    fetchPublicSheetTabCsv(spreadsheetId, cfg.challanTabName),
    fetchPublicSheetTabCsv(spreadsheetId, 'Challan_Deleted_Log'),
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
  if (foodRes.accessible) {
    dealers.push(...parseDealersFromRows(foodRes.rows, 'খাদ্য বান্ধব'));
  }
  if (omsRes.accessible) {
    dealers.push(...parseDealersFromRows(omsRes.rows, 'ওএমএস সাধারণ'));
  }

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

  const deletedChallanLogs = delLogRes.accessible
    ? parseDeletedChallanLogsFromRows(delLogRes.rows)
    : [];

  const extShadowCount = chlRes.accessible
    ? chlRes.rows
        .slice(1)
        .filter((r) => /^ch-ext-/i.test(String(r[0] || '').trim())).length
    : 0;

  const autoReconcile =
    chlRes.accessible &&
    (chlRes.rows.length > 1 || deletedChallanLogs.length > 0);

  return await withLock(() => {
    const db = ensureDb();
    const counts = mergeSyncPayloadIntoDb(db, {
      dealers: foodRes.accessible || omsRes.accessible ? dealers : null,
      suballocations,
      doIssues,
      challans,
      challansVerified: chlRes.accessible && chlRes.rows.length >= 1,
      pendingRecordIds: Array.isArray(overrideSettings?.pendingRecordIds)
        ? overrideSettings.pendingRecordIds
        : [],
      deletedRecordIds: Array.isArray(overrideSettings?.deletedRecordIds)
        ? overrideSettings.deletedRecordIds
        : [],
      deletedChallanLogs,
      reconcileMissing:
        overrideSettings?.reconcileMissing !== undefined
          ? Boolean(overrideSettings.reconcileMissing)
          : autoReconcile,
      extShadowCount,
    });
    saveDb(db);
    return counts;
  });
}

let enrichInFlight: Promise<number> | null = null;
let enrichRetryTimer: ReturnType<typeof setTimeout> | null = null;
let enrichCooldownUntil = 0;
let enrichLastRunAt = 0;
let enrich409Streak = 0;
const ENRICH_INTERACTIVE_PAUSE_MS = 120 * 1000;
const ENRICH_MIN_TRIGGER_GAP_MS = 10 * 60 * 1000;
const failedEnrichCache = new Map<string, number>();
const ENRICH_FAIL_TTL_MS = 30 * 60 * 1000;

function extractCodeFromOfficialPayload(data: OfficialChallanData): string {
  const topCode = String(data.New37Code || '').trim();
  if (topCode) return topCode;
  if (Array.isArray(data.Economics)) {
    for (const item of data.Economics) {
      const c = String(
        item.EconomicNew37Code || item.EconomicCode || ''
      ).trim();
      if (c) return c;
    }
  }
  return '';
}

function isValidAchallanLookupNo(no: string): boolean {
  const cleaned = toEnglishDigits(no).trim();
  return /^\d{4}-\d{10,11}$/.test(cleaned);
}

async function applyResolvedCodesToDb(
  resolvedMap: Map<string, { code: string; orgName: string; remarks?: string }>
): Promise<number> {
  if (resolvedMap.size === 0) return 0;
  return withLock(() => {
    const db = ensureDb();
    let updatedCount = 0;

    db.records = db.records.map((r) => {
      let changed = false;
      const next = { ...r };

      const mainNo = normalizeChallanNo(r.challanNo || '');
      const mainHit = mainNo ? resolvedMap.get(mainNo) : undefined;
      if (mainHit) {
        if (!String(next.new37Code || '').trim() && mainHit.code) {
          next.new37Code = mainHit.code;
          changed = true;
        }
        if (mainHit.orgName) {
          if (!String(next.toOrganization || '').trim()) {
            next.toOrganization = mainHit.orgName;
            changed = true;
          }
          if (!String(next.department || '').trim()) {
            next.department = mainHit.orgName;
            changed = true;
          }
        }
        if (!String(next.comment || '').trim() && mainHit.remarks) {
          next.comment = mainHit.remarks;
          changed = true;
        }
      }

      const taxNo = normalizeChallanNo(r.incomeTaxChallanNo || '');
      const taxHit = taxNo ? resolvedMap.get(taxNo) : undefined;
      if (taxHit) {
        if (!String(next.taxCode || '').trim() && taxHit.code) {
          next.taxCode = taxHit.code;
          changed = true;
        }
        if (!String(next.taxDepartment || '').trim() && taxHit.orgName) {
          const split = splitTaxDepartmentAndExtra(
            taxHit.orgName,
            taxHit.code || next.taxCode
          );
          next.taxDepartment = split.institution || taxHit.orgName;
          changed = true;
        }
        if (!String(next.taxComment || '').trim() && taxHit.remarks) {
          next.taxComment = taxHit.remarks;
          changed = true;
        }
      }

      const vatNo = normalizeChallanNo(r.vatChallanNo || '');
      const vatHit = vatNo ? resolvedMap.get(vatNo) : undefined;
      if (vatHit) {
        if (!String(next.vatCode || '').trim() && vatHit.code) {
          next.vatCode = vatHit.code;
          changed = true;
        }
        if (!String(next.taxDepartment || '').trim() && vatHit.orgName) {
          const split = splitTaxDepartmentAndExtra(
            vatHit.orgName,
            vatHit.code || next.vatCode
          );
          next.taxDepartment = split.institution || vatHit.orgName;
          changed = true;
        }
        if (!String(next.taxComment || '').trim() && vatHit.remarks) {
          next.taxComment = vatHit.remarks;
          changed = true;
        }
      }

      if (changed) updatedCount++;
      return next;
    });

    if (updatedCount > 0) {
      saveDb(db);
    }
    return updatedCount;
  });
}

async function enrichMissingCodesAndDepts(): Promise<number> {
  if (enrichInFlight) return enrichInFlight;
  const nowCheck = Date.now();
  if (
    nowCheck < enrichCooldownUntil ||
    nowCheck < achallanCooldownUntil ||
    nowCheck - lastInteractiveOfficialLookupAt < ENRICH_INTERACTIVE_PAUSE_MS
  ) {
    return 0;
  }

  enrichLastRunAt = nowCheck;
  enrichInFlight = (async () => {
    try {
      const dbSnap = ensureDb();
      const now = Date.now();
      const pendingNos = new Set<string>();

      for (const r of dbSnap.records) {
        const mainNo = normalizeChallanNo(r.challanNo || '');
        if (
          mainNo &&
          isValidAchallanLookupNo(mainNo) &&
          (!String(r.new37Code || '').trim() ||
            !String(r.department || r.toOrganization || '').trim() ||
            !String(r.comment || '').trim())
        ) {
          const failedAt = failedEnrichCache.get(mainNo);
          if (!failedAt || now - failedAt > ENRICH_FAIL_TTL_MS) {
            pendingNos.add(mainNo);
          }
        }

        const taxNo = normalizeChallanNo(r.incomeTaxChallanNo || '');
        if (
          taxNo &&
          isValidAchallanLookupNo(taxNo) &&
          (!String(r.taxCode || '').trim() ||
            !String(r.taxDepartment || r.sourceMemo || '').trim() ||
            !String(r.taxComment || '').trim())
        ) {
          const failedAt = failedEnrichCache.get(taxNo);
          if (!failedAt || now - failedAt > ENRICH_FAIL_TTL_MS) {
            pendingNos.add(taxNo);
          }
        }

        const vatNo = normalizeChallanNo(r.vatChallanNo || '');
        if (
          vatNo &&
          isValidAchallanLookupNo(vatNo) &&
          (!String(r.vatCode || '').trim() ||
            !String(r.taxComment || '').trim())
        ) {
          const failedAt = failedEnrichCache.get(vatNo);
          if (!failedAt || now - failedAt > ENRICH_FAIL_TTL_MS) {
            pendingNos.add(vatNo);
          }
        }
      }

      if (pendingNos.size === 0) return 0;

      const resolvedBatch = new Map<
        string,
        { code: string; orgName: string; remarks?: string }
      >();
      let totalUpdated = 0;
      let hitRateLimit = false;
      const MAX_BG_ITEMS_PER_PASS = 2;
      const queue = Array.from(pendingNos).slice(0, MAX_BG_ITEMS_PER_PASS);

      for (let i = 0; i < queue.length; i++) {
        // Yield immediately if an interactive scan starts
        if (
          Date.now() - lastInteractiveOfficialLookupAt <
          ENRICH_INTERACTIVE_PAUSE_MS
        ) {
          break;
        }
        const no = queue[i];
        try {
          const official = await fetchOfficialChallanData(no, {
            interactive: false,
          });
          enrich409Streak = 0;
          const code = extractCodeFromOfficialPayload(official);
          const orgName = String(
            official.ToOrgNameBn || official.OrgNameBn || ''
          ).trim();
          const remarks = extractRemarksFromOfficialPayload(
            official,
            code ? [code] : undefined
          );
          if (code || orgName || remarks) {
            resolvedBatch.set(no, { code, orgName, remarks });
          } else {
            failedEnrichCache.set(no, Date.now());
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isRateLimit =
            (err instanceof AchallanHttpError &&
              (err.statusCode === 409 || err.retryable)) ||
            msg.includes('409') ||
            msg.includes('সময় নিচ্ছে');
          if (isRateLimit) {
            hitRateLimit = true;
            enrich409Streak = Math.min(4, enrich409Streak + 1);
            const backoffMs = Math.min(
              15 * 60 * 1000,
              120 * 1000 * Math.pow(2, enrich409Streak - 1)
            );
            enrichCooldownUntil = Date.now() + backoffMs;
            break;
          }
          failedEnrichCache.set(no, Date.now());
        }

        if (i < queue.length - 1) {
          await new Promise((r) => setTimeout(r, 5500));
        }
      }

      if (resolvedBatch.size > 0) {
        totalUpdated += await applyResolvedCodesToDb(resolvedBatch);
        resolvedBatch.clear();
      }

      if (hitRateLimit && !enrichRetryTimer) {
        const retryWait = Math.max(
          120 * 1000,
          enrichCooldownUntil - Date.now() + 2000
        );
        enrichRetryTimer = setTimeout(() => {
          enrichRetryTimer = null;
          void enrichMissingCodesAndDepts().catch(() => undefined);
        }, retryWait);
      }

      return totalUpdated;
    } finally {
      enrichInFlight = null;
    }
  })();

  return enrichInFlight;
}

function scheduleIdleEnrichment(delayMs = 20000): void {
  const now = Date.now();
  if (enrichRetryTimer || enrichInFlight) return;
  if (now < enrichCooldownUntil || now < achallanCooldownUntil) return;
  if (now - lastInteractiveOfficialLookupAt < ENRICH_INTERACTIVE_PAUSE_MS) return;
  if (now - enrichLastRunAt < ENRICH_MIN_TRIGGER_GAP_MS) return;

  enrichRetryTimer = setTimeout(() => {
    enrichRetryTimer = null;
    void enrichMissingCodesAndDepts().catch(() => undefined);
  }, delayMs);
}

async function startServer() {
  const app = express();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,DELETE,OPTIONS'
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization'
      );
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '15mb' }));

  // ======================== AUTH ROUTES ========================
  app.get('/api/auth/me', (req, res) => {
    const db = ensureDb();
    const lockEnabled = Boolean(db.settings?.lockEnabled);
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ success: false, lockEnabled, user: null });
      return;
    }
    res.json({ success: true, lockEnabled, user: toPublicUser(user) });
  });

  app.post('/api/auth/login', (req, res) => {
    const identifier = String(req.body?.identifier || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!password) {
      res.status(400).json({
        success: false,
        error: 'পাসওয়ার্ড দিন।',
      });
      return;
    }

    const db = ensureDb();
    let user: StoredUser | undefined;

    if (identifier) {
      user = db.users.find(
        (u) =>
          u.userId.toLowerCase() === identifier ||
          u.email.toLowerCase() === identifier
      );
      if (!user || !verifyPassword(password, user.passwordHash)) {
        res.status(401).json({
          success: false,
          error: 'ইউজার আইডি, ইমেইল বা পাসওয়ার্ড সঠিক নয়।',
        });
        return;
      }
    } else {
      // Password-only unlock: check active admin first, then any active user matching password
      const candidates = [
        ...db.users.filter((u) => u.active && u.role === 'admin'),
        ...db.users.filter((u) => u.active && u.role !== 'admin'),
      ];
      user = candidates.find((u) => verifyPassword(password, u.passwordHash));
      if (!user) {
        res.status(401).json({
          success: false,
          error: 'পাসওয়ার্ড সঠিক নয়।',
        });
        return;
      }
    }

    if (!user.active) {
      res.status(403).json({
        success: false,
        error: 'আপনার অ্যাকাউন্টটি নিষ্ক্রিয় করা হয়েছে। এডমিনের সাথে যোগাযোগ করুন।',
      });
      return;
    }

    const token = createSessionToken(user.id);
    setSessionCookie(res, token);
    res.json({ success: true, token, user: toPublicUser(user) });
  });

  app.post('/api/auth/quick-login', (req, res) => {
    const target = req.body?.target === 'operator' ? 'operator' : 'admin';
    const db = ensureDb();
    if (db.settings?.lockEnabled) {
      res.status(403).json({
        success: false,
        error: 'লক সিস্টেম চালু আছে — প্রবেশ করতে পাসওয়ার্ড দিন।',
      });
      return;
    }
    const user =
      target === 'admin'
        ? db.users.find((u) => u.role === 'admin' && u.active) || db.users[0]
        : db.users.find((u) => u.role === 'operator' && u.active) || db.users[0];

    if (!user) {
      res.status(404).json({ success: false, error: 'কোনো সক্রিয় ইউজার পাওয়া যায়নি।' });
      return;
    }

    const token = createSessionToken(user.id);
    setSessionCookie(res, token);
    res.json({ success: true, token, user: toPublicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = getSessionTokenFromRequest(req);
    if (token) revokedTokens.add(token);
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ success: true });
  });

  app.put('/api/auth/lock-password', requirePermission('settings'), async (req, res) => {
    try {
      const newPassword = String(req.body?.newPassword ?? req.body?.password ?? '');
      const enableLock =
        typeof req.body?.lockEnabled === 'boolean'
          ? req.body.lockEnabled
          : undefined;
      if (newPassword.length < 4) {
        res.status(400).json({
          success: false,
          message: 'পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে।',
        });
        return;
      }
      const result = await withLock(() => {
        const db = ensureDb();
        const admin =
          db.users.find((u) => u.role === 'admin' && u.active) || db.users[0];
        if (!admin) {
          throw new Error('অ্যাডমিন অ্যাকাউন্ট পাওয়া যায়নি।');
        }
        admin.passwordHash = hashPassword(newPassword);
        if (enableLock !== undefined) {
          db.settings.lockEnabled = enableLock;
        }
        saveDb(db);
        return { admin, lockEnabled: Boolean(db.settings.lockEnabled) };
      });
      const token = createSessionToken(result.admin.id);
      setSessionCookie(res, token);
      res.json({
        success: true,
        token,
        lockEnabled: result.lockEnabled,
        message: 'লক পাসওয়ার্ড সংরক্ষিত হয়েছে।',
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'পাসওয়ার্ড পরিবর্তন ব্যর্থ।',
      });
    }
  });

  // ======================== ADMIN USER CRUD ROUTES ========================
  app.get('/api/users', requirePermission('adminUsers'), (_req, res) => {
    const db = ensureDb();
    res.json({ success: true, users: db.users.map(toPublicUser) });
  });

  app.post('/api/users', requirePermission('adminUsers'), async (req, res) => {
    try {
      const userId = String(req.body?.userId || '').trim();
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const role = req.body?.role === 'admin' ? 'admin' : 'operator';
      const permissions: PermissionsMap =
        role === 'admin'
          ? { ...FULL_ADMIN_PERMISSIONS }
          : {
              ...DEFAULT_OPERATOR_PERMISSIONS,
              ...(req.body?.permissions || {}),
            };

      if (!userId || !name || !email || !password) {
        throw new Error('ইউজার আইডি, নাম, ইমেইল এবং পাসওয়ার্ড সব দিতে হবে।');
      }

      const created = await withLock(() => {
        const db = ensureDb();
        const dup = db.users.find(
          (u) =>
            u.userId.toLowerCase() === userId.toLowerCase() ||
            u.email.toLowerCase() === email
        );
        if (dup) {
          throw new Error('এই ইউজার আইডি বা ইমেইল আগে থেকেই ব্যবহৃত হয়েছে।');
        }
        const entry: StoredUser = {
          id: `usr-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          userId,
          name,
          email,
          role,
          permissions,
          active: true,
          createdAt: new Date().toISOString(),
          passwordHash: hashPassword(password),
        };
        db.users.push(entry);
        // Auto-include in allowedEmails if not already present
        if (!db.settings.allowedEmails.includes(email)) {
          db.settings.allowedEmails.push(email);
        }
        saveDb(db);
        return toPublicUser(entry);
      });

      res.json({ success: true, user: created });
    } catch (error) {
      res.status(400).json({
        success: false,
        error:
          error instanceof Error ? error.message : 'ইউজার তৈরি করা যায়নি।',
      });
    }
  });

  app.put('/api/users/:id', requirePermission('adminUsers'), async (req, res) => {
    try {
      const { id } = req.params;
      const updated = await withLock(() => {
        const db = ensureDb();
        const idx = db.users.findIndex((u) => u.id === id);
        if (idx === -1) throw new Error('ইউজার পাওয়া যায়নি।');
        const cur = db.users[idx];
        const nextRole =
          req.body?.role === 'admin'
            ? 'admin'
            : req.body?.role === 'operator'
              ? 'operator'
              : cur.role;
        const nextEmail = req.body?.email
          ? String(req.body.email).trim().toLowerCase()
          : cur.email;

        db.users[idx] = {
          ...cur,
          name: req.body?.name ? String(req.body.name).trim() : cur.name,
          email: nextEmail,
          role: nextRole,
          active:
            typeof req.body?.active === 'boolean' ? req.body.active : cur.active,
          permissions:
            nextRole === 'admin'
              ? { ...FULL_ADMIN_PERMISSIONS }
              : req.body?.permissions
                ? { ...DEFAULT_OPERATOR_PERMISSIONS, ...req.body.permissions }
                : cur.permissions,
          passwordHash:
            req.body?.password && String(req.body.password).trim()
              ? hashPassword(String(req.body.password).trim())
              : cur.passwordHash,
        };
        if (nextEmail && !db.settings.allowedEmails.includes(nextEmail)) {
          db.settings.allowedEmails.push(nextEmail);
        }
        saveDb(db);
        return toPublicUser(db.users[idx]);
      });
      res.json({ success: true, user: updated });
    } catch (error) {
      res.status(400).json({
        success: false,
        error:
          error instanceof Error ? error.message : 'ইউজার আপডেট করা যায়নি।',
      });
    }
  });

  app.delete('/api/users/:id', requirePermission('adminUsers'), async (req, res) => {
    try {
      const { id } = req.params;
      await withLock(() => {
        const db = ensureDb();
        const target = db.users.find((u) => u.id === id);
        if (target && target.userId === 'admin') {
          throw new Error('মূল সুপার এডমিন মুছে ফেলা যাবে না।');
        }
        db.users = db.users.filter((u) => u.id !== id);
        saveDb(db);
      });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'মুছে ফেলা যায়নি।',
      });
    }
  });

  // ======================== SETTINGS ROUTES ========================
  app.get('/api/settings', requireAuth, (_req, res) => {
    const db = ensureDb();
    res.json({ success: true, settings: db.settings });
  });

  app.put('/api/settings', requirePermission('settings'), async (req, res) => {
    try {
      const incoming = req.body as Partial<AppSettings>;
      const prevId = ensureDb().settings.spreadsheetId;
      const prevGasUrl = ensureDb().settings.gasWebAppUrl;
      const updated = await withLock(() => {
        const db = ensureDb();
        const nextSheetId =
          incoming.spreadsheetId !== undefined
            ? extractSpreadsheetId(incoming.spreadsheetId)
            : db.settings.spreadsheetId;
        db.settings = {
          ...db.settings,
          ...incoming,
          lockEnabled:
            typeof incoming.lockEnabled === 'boolean'
              ? incoming.lockEnabled
              : Boolean(db.settings.lockEnabled),
          spreadsheetId: nextSheetId,
          khats: Array.isArray(incoming.khats)
            ? incoming.khats
            : db.settings.khats,
        };
        saveDb(db);
        return db.settings;
      });
      if (updated.gasWebAppUrl && updated.gasWebAppUrl !== prevGasUrl) {
        gasRelayUnsupportedAt = 0;
      }
      if (updated.spreadsheetId && updated.spreadsheetId !== prevId) {
        void pullAndMergePublicGoogleSheet().catch(() => undefined);
      }
      let issuedToken: string | undefined;
      if (updated.lockEnabled && !getSessionTokenFromRequest(req)) {
        const defaultUser = getDefaultUnlockedUser(ensureDb());
        if (defaultUser) {
          issuedToken = createSessionToken(defaultUser.id);
          setSessionCookie(res, issuedToken);
        }
      }
      res.json({
        success: true,
        settings: updated,
        ...(issuedToken ? { token: issuedToken } : {}),
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'সেটিংস সংরক্ষণ ব্যর্থ হয়েছে।',
      });
    }
  });

  // ======================== OFFICIAL CHALLAN & SHEETS BRIDGE ========================
  app.get('/api/official-challan', requireAuth, async (req, res) => {
    try {
      const challanNo = String(req.query.challanNo || '').trim();
      const gasUrlOverride = String(req.query.gasUrl || '').trim();
      const data = await fetchOfficialChallanData(challanNo, {
        interactive: true,
        gasUrlOverride: gasUrlOverride || undefined,
      });
      const resolvedNo = normalizeChallanNo(data.ChallanNo || challanNo);
      if (resolvedNo) {
        const code = extractCodeFromOfficialPayload(data);
        const orgName = String(data.ToOrgNameBn || data.OrgNameBn || '').trim();
        const remarks = extractRemarksFromOfficialPayload(
          data,
          code ? [code] : undefined
        );
        if (code || orgName || remarks) {
          void applyResolvedCodesToDb(
            new Map([[resolvedNo, { code, orgName, remarks }]])
          ).catch(() => undefined);
        }
      }
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof AchallanHttpError) {
        const httpCode = error.statusCode >= 400 ? error.statusCode : 400;
        res.status(httpCode).json({
          success: false,
          statusCode: error.statusCode,
          retryable: error.retryable,
          cooldownMs: error.cooldownMs,
          message: error.message,
        });
        return;
      }
      const message =
        error instanceof Error ? error.message : 'সরকারি তথ্য আনা যায়নি।';
      const is409 = message.includes('409');
      res.status(is409 ? 409 : 400).json({
        success: false,
        statusCode: is409 ? 409 : 400,
        retryable: is409,
        cooldownMs: is409 ? 5000 : 0,
        message,
      });
    }
  });

  app.post('/api/gas-bridge', requireAuth, async (req, res) => {
    try {
      const url = String(req.body?.url || '').trim();
      const action = String(req.body?.action || 'syncAll').trim();
      const payload = req.body?.payload ?? {};

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
          'এটি এডিটর/হোম লিংক — Web App URL নয়। Deploy > Web app থেকে পাওয়া https://script.google.com/macros/s/.../exec লিংকটি কপি করে বসান।'
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, payload }),
        });
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          const finalUrl = String(response.url || '');
          const lower = text.toLowerCase();
          if (
            finalUrl.includes('accounts.google.com') ||
            lower.includes('servicelogin') ||
            lower.includes('accounts.google.com')
          ) {
            throw new Error(
              'Apps Script-এ Google লগইন পেজ এসেছে: Web App-এর অনুমতি "Anyone" করা নেই অথবা "Execute as: Me" নির্বাচন করা হয়নি। Deploy > Manage deployments-এ গিয়ে Execute as: Me এবং Who has access: Anyone সেট করে Update/New version করুন।'
            );
          }
          if (lower.includes('script function not found: dopost')) {
            throw new Error(
              'ডিপ্লয় করা Apps Script-এ doPost ফাংশন নেই। কোড পেস্ট ও সেভ করার পর অবশ্যই Deploy > New deployment (অথবা Manage deployments > New version) করতে হবে।'
            );
          }
          if (
            lower.includes('authorization is required') ||
            lower.includes('permission')
          ) {
            throw new Error(
              'Apps Script-এর অনুমতি (Review permissions > Allow) অনুমোদন বাকি আছে অথবা শিটে অ্যাক্সেস নেই।'
            );
          }
          if (response.status === 404 || lower.includes('page not found')) {
            throw new Error(
              'এই Apps Script Web App URL-টি পাওয়া যায়নি (404)। নতুন Web App ডিপ্লয় করে সঠিক .../exec লিংক দিন।'
            );
          }
          throw new Error(
            `Apps Script থেকে বৈধ JSON পাওয়া যায়নি (HTTP ${response.status})। সঠিক .../exec লিংক এবং ডিপ্লয়মেন্ট অনুমতি (Anyone) যাচাই করুন।`
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
          const friendlyMsg = rawErr.includes('Unknown action')
            ? `আপনার Apps Script Web App-এ "${action}" অ্যাকশনটি নেই (${rawErr})। সেটিংস > শিট সিঙ্ক থেকে নতুন Code.gs ডিপ্লয় করুন অথবা Google Sign-In ব্যবহার করুন।`
            : rawErr;
          res.status(400).json({
            success: false,
            message: friendlyMsg,
            data: parsed,
          });
          return;
        }

        res.json({ success: true, data: parsed });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'Apps Script সংযোগ ব্যর্থ হয়েছে।',
      });
    }
  });

  // ======================== CHALLAN RECORDS CRUD ========================
  app.get('/api/challans', requireAuth, (_req, res) => {
    const db = ensureDb();
    const hasMissingCodes = db.records.some(
      (r) =>
        (r.challanNo && isValidAchallanLookupNo(r.challanNo) && !String(r.new37Code || '').trim()) ||
        (r.incomeTaxChallanNo &&
          isValidAchallanLookupNo(r.incomeTaxChallanNo) &&
          !String(r.taxCode || '').trim()) ||
        (r.vatChallanNo &&
          isValidAchallanLookupNo(r.vatChallanNo) &&
          !String(r.vatCode || '').trim())
    );
    if (hasMissingCodes) {
      scheduleIdleEnrichment(25000);
    }
    res.json({
      success: true,
      records: db.records,
      deletedRecordIds: db.deletedRecordIds || [],
    });
  });

  app.post('/api/challans', requirePermission('scan'), async (req, res) => {
    try {
      const payload = req.body as Record<string, unknown>;
      const result = await withLock(() => {
        const db = ensureDb();
        const scanMode = String(payload.scanMode || 'main').trim();
        const mergeExisting = payload.mergeExisting !== false;

        const unionName = String(payload.unionName || '').trim();
        const dealerName = String(payload.dealerName || '').trim();
        const dealerId = String(payload.dealerId || '').trim();
        const dealerAllocationId = String(
          payload.dealerAllocationId || ''
        ).trim();
        const challanCategory = String(payload.challanCategory || '').trim();
        const licenseActionType = String(
          payload.licenseActionType || ''
        ).trim() as ChallanRecord['licenseActionType'];
        const licenseNo = String(payload.licenseNo || '').trim();
        const new37Code = String(payload.new37Code || '').trim();
        const explicitTaxCode = String(payload.taxCode || '').trim();
        const explicitVatCode = String(payload.vatCode || '').trim();
        const expectedAmount = toEnglishDigits(
          String(payload.expectedAmount || '')
        ).trim();
        const expectedTaxAmount = toEnglishDigits(
          String(payload.expectedTaxAmount || '')
        ).trim();
        const customFields =
          payload.customFields && typeof payload.customFields === 'object'
            ? (payload.customFields as Record<string, string>)
            : undefined;
        const taxCustomFields =
          payload.taxCustomFields && typeof payload.taxCustomFields === 'object'
            ? (payload.taxCustomFields as Record<string, string>)
            : undefined;
        const vatCustomFields =
          payload.vatCustomFields && typeof payload.vatCustomFields === 'object'
            ? (payload.vatCustomFields as Record<string, string>)
            : undefined;

        const department = String(
          payload.department ?? payload.toOrganization ?? payload.field1 ?? ''
        ).trim();
        const toOrganization = String(
          payload.toOrganization ?? payload.department ?? payload.field1 ?? ''
        ).trim();
        const submittedThrough = String(
          payload.submittedThrough ?? payload.field2 ?? ''
        ).trim();
        const submittedOnBehalfOf = String(
          payload.submittedOnBehalfOf ?? payload.field3 ?? ''
        ).trim();

        const rawChallanNo = String(
          payload.challanNo ?? payload.field4 ?? ''
        ).trim();
        const challanNo = cleanChallanNo(rawChallanNo);

        const rawTaxChallanNo = String(
          payload.incomeTaxChallanNo || ''
        ).trim();
        const incomeTaxChallanNo = cleanChallanNo(rawTaxChallanNo);

        const rawVatChallanNo = String(payload.vatChallanNo || '').trim();
        const vatChallanNo = cleanChallanNo(rawVatChallanNo);

        const description = String(
          payload.description ?? payload.field5 ?? ''
        ).trim();
        const quantity = toEnglishDigits(
          String(payload.quantity ?? payload.field6 ?? '')
        ).trim();
        const rate = toEnglishDigits(
          String(payload.rate ?? payload.field7 ?? '')
        ).trim();
        const amount = toEnglishDigits(
          String(payload.amount ?? payload.field8 ?? '')
        ).trim();
        const rawDate = String(
          payload.challanDate ?? payload.field9 ?? ''
        ).trim();

        const incomeTaxAmount = toEnglishDigits(
          String(payload.incomeTaxAmount || '')
        ).trim();
        const rawTaxDate = String(payload.incomeTaxDate || '').trim();

        const vatAmount = toEnglishDigits(
          String(payload.vatAmount || '')
        ).trim();
        const rawVatDate = String(payload.vatDate || '').trim();

        const comment = String(
          payload.comment ?? payload.description ?? ''
        ).trim();
        const taxComment = String(payload.taxComment ?? '').trim();
        const sourceMemo = String(payload.sourceMemo || '').trim();
        const rawTaxDepartment = String(
          payload.taxDepartment ?? sourceMemo ?? ''
        ).trim();
        const modeHintCode =
          scanMode === 'tax'
            ? explicitTaxCode || new37Code
            : scanMode === 'vat'
              ? explicitVatCode || new37Code
              : new37Code;
        const taxSplit = splitTaxDepartmentAndExtra(rawTaxDepartment, modeHintCode);
        const taxDepartment = taxSplit.institution || rawTaxDepartment;
        const taxExtra =
          String(payload.taxExtra ?? '').trim() || taxSplit.extra || '';
        const taxCode =
          explicitTaxCode ||
          (scanMode === 'tax'
            ? new37Code || taxSplit.code || extractEconomicCodeFromText([taxDepartment, taxExtra, taxComment].filter(Boolean).join(' '))
            : '');
        const vatCode =
          explicitVatCode ||
          (scanMode === 'vat'
            ? new37Code || taxSplit.code || extractEconomicCodeFromText([taxDepartment, taxExtra, taxComment].filter(Boolean).join(' '))
            : '');
        const dcMemo = String(payload.dcMemo || '').trim();
        const pdfUrl = String(payload.pdfUrl || '').trim();

        const resolvedMainNo =
          scanMode === 'tax' || scanMode === 'vat' ? '' : challanNo;
        const resolvedTaxNo =
          scanMode === 'tax'
            ? incomeTaxChallanNo || challanNo
            : incomeTaxChallanNo;
        const resolvedVatNo =
          scanMode === 'vat' ? vatChallanNo || challanNo : vatChallanNo;

        const primaryNumber =
          scanMode === 'tax'
            ? resolvedTaxNo
            : scanMode === 'vat'
              ? resolvedVatNo
              : resolvedMainNo;

        if (!primaryNumber) {
          throw new Error(
            'সঠিক চালান নম্বর অবশ্যই দিতে হবে (কমপক্ষে ৫ অঙ্কের বৈধ চালান নম্বর লিখুন)।'
          );
        }
        if (!challanCategory) {
          throw new Error('চালানের খাত / ক্যাটেগরি নির্বাচন করুন।');
        }

        const parsedMainDate = parseChallanDate(rawDate);
        const parsedTaxDate = parseChallanDate(rawTaxDate || rawDate);
        const parsedVatDate = parseChallanDate(rawVatDate || rawDate);

        const globalConflict = findGlobalChallanConflict(db.records, {
          main: resolvedMainNo,
          tax: resolvedTaxNo,
          vat: resolvedVatNo,
        });
        if (globalConflict) {
          return {
            success: false,
            duplicate: true,
            blocked: true,
            message: globalConflict.message,
          };
        }

        const slotIsEmpty = (r: ChallanRecord): boolean => {
          if (scanMode === 'tax') {
            return !cleanChallanNo(r.incomeTaxChallanNo);
          }
          if (scanMode === 'vat') {
            return !cleanChallanNo(r.vatChallanNo);
          }
          return !cleanChallanNo(r.challanNo);
        };

        const effectiveAllocId =
          dealerAllocationId && dealerAllocationId !== dealerId
            ? dealerAllocationId
            : '';

        const matchDateDisplay =
          scanMode === 'tax'
            ? parsedTaxDate.display || parsedMainDate.display
            : scanMode === 'vat'
              ? parsedVatDate.display || parsedMainDate.display
              : parsedMainDate.display;

        const sameMonthOrUnset = (r: ChallanRecord): boolean => {
          if (!matchDateDisplay) return true;
          const existingDate =
            r.challanDate || r.incomeTaxDate || r.vatDate || r.date || '';
          if (!existingDate) return true;
          return isSameYearMonth(matchDateDisplay, existingDate);
        };

        let mergeTargetIndex = -1;
        if (mergeExisting && scanMode !== 'single') {
          if (effectiveAllocId) {
            mergeTargetIndex = db.records.findIndex(
              (r) =>
                r.dealerAllocationId &&
                r.dealerAllocationId === effectiveAllocId &&
                sameMonthOrUnset(r) &&
                slotIsEmpty(r)
            );
          } else if (licenseNo) {
            mergeTargetIndex = db.records.findIndex(
              (r) =>
                r.licenseNo &&
                r.licenseNo === licenseNo &&
                r.challanCategory === challanCategory &&
                (!licenseActionType || r.licenseActionType === licenseActionType) &&
                sameMonthOrUnset(r) &&
                slotIsEmpty(r)
            );
          } else if (dealerName && matchDateDisplay) {
            mergeTargetIndex = db.records.findIndex(
              (r) =>
                r.dealerName === dealerName &&
                r.challanCategory === challanCategory &&
                isSameYearMonth(
                  matchDateDisplay,
                  r.challanDate || r.incomeTaxDate || r.vatDate || r.date || ''
                ) &&
                slotIsEmpty(r)
            );
          }
        }

        if (mergeTargetIndex !== -1) {
          const existing = db.records[mergeTargetIndex];
          const nextCombinedMain =
            scanMode === 'main' || scanMode === 'single'
              ? resolvedMainNo || cleanChallanNo(existing.challanNo)
              : cleanChallanNo(existing.challanNo);
          const nextCombinedTax =
            scanMode === 'tax'
              ? resolvedTaxNo || cleanChallanNo(existing.incomeTaxChallanNo)
              : cleanChallanNo(existing.incomeTaxChallanNo);
          const nextCombinedVat =
            scanMode === 'vat'
              ? resolvedVatNo || cleanChallanNo(existing.vatChallanNo)
              : cleanChallanNo(existing.vatChallanNo);

          const mergeConflict = findGlobalChallanConflict(
            db.records,
            {
              main: nextCombinedMain,
              tax: nextCombinedTax,
              vat: nextCombinedVat,
            },
            existing.recordId
          );
          if (mergeConflict) {
            return {
              success: false,
              duplicate: true,
              blocked: true,
              message: mergeConflict.message,
            };
          }

          const mergedCustom =
            scanMode === 'tax' || scanMode === 'vat'
              ? existing.customFields || {}
              : {
                  ...(existing.customFields || {}),
                  ...(customFields || {}),
                };
          const mergedTaxCustom =
            scanMode === 'tax'
              ? {
                  ...(existing.taxCustomFields || {}),
                  ...(taxCustomFields || customFields || {}),
                }
              : existing.taxCustomFields;
          const mergedVatCustom =
            scanMode === 'vat'
              ? {
                  ...(existing.vatCustomFields || {}),
                  ...(vatCustomFields || customFields || {}),
                }
              : existing.vatCustomFields;
          if (scanMode === 'tax') {
            const defaultTaxRule = buildDefaultCommissionTaxComment(
              existing.challanCategory || challanCategory,
              parsedTaxDate.display || existing.incomeTaxDate || existing.challanDate || existing.date,
              incomeTaxChallanNo || challanNo
            );
            db.records[mergeTargetIndex] = {
              ...existing,
              taxDepartment: taxDepartment || existing.taxDepartment || '',
              sourceMemo: taxDepartment || existing.sourceMemo || '',
              incomeTaxChallanNo: incomeTaxChallanNo || challanNo,
              incomeTaxDate: parsedTaxDate.display || existing.incomeTaxDate,
              incomeTaxAmount:
                incomeTaxAmount || amount || existing.incomeTaxAmount,
              expectedTaxAmount:
                expectedTaxAmount || expectedAmount || existing.expectedTaxAmount,
              new37Code: existing.new37Code || taxCode || new37Code,
              taxCode: taxCode || new37Code || existing.taxCode || '',
              vatCode: existing.vatCode || '',
              licenseNo: existing.licenseNo || licenseNo,
              expectedAmount: existing.expectedAmount || expectedAmount,
              comment: existing.comment || '',
              taxComment:
                taxComment ||
                comment ||
                existing.taxComment ||
                defaultTaxRule ||
                '',
              taxExtra: taxExtra || existing.taxExtra || '',
              submittedThrough: existing.submittedThrough || submittedThrough,
              submittedOnBehalfOf:
                existing.submittedOnBehalfOf || submittedOnBehalfOf,
              customFields: mergedCustom,
              taxCustomFields: mergedTaxCustom,
            };
          } else if (scanMode === 'vat') {
            db.records[mergeTargetIndex] = {
              ...existing,
              taxDepartment: taxDepartment || existing.taxDepartment || '',
              sourceMemo: taxDepartment || existing.sourceMemo || '',
              vatChallanNo: vatChallanNo || challanNo,
              vatDate: parsedVatDate.display || existing.vatDate,
              vatAmount: vatAmount || amount || existing.vatAmount,
              new37Code: existing.new37Code || vatCode || new37Code,
              taxCode: existing.taxCode || '',
              vatCode: vatCode || new37Code || existing.vatCode || '',
              licenseNo: existing.licenseNo || licenseNo,
              expectedAmount: existing.expectedAmount || expectedAmount,
              comment: existing.comment || '',
              taxComment: taxComment || comment || existing.taxComment || '',
              taxExtra: taxExtra || existing.taxExtra || '',
              customFields: mergedCustom,
              vatCustomFields: mergedVatCustom,
            };
          } else {
            db.records[mergeTargetIndex] = {
              ...existing,
              department: department || existing.department,
              toOrganization: toOrganization || existing.toOrganization,
              submittedThrough: submittedThrough || existing.submittedThrough,
              submittedOnBehalfOf:
                submittedOnBehalfOf || existing.submittedOnBehalfOf,
              challanNo: challanNo || existing.challanNo,
              challanDate: parsedMainDate.display || existing.challanDate,
              rate: rate || existing.rate,
              expectedAmount: expectedAmount || existing.expectedAmount,
              expectedTaxAmount: expectedTaxAmount || existing.expectedTaxAmount,
              quantity: quantity || existing.quantity,
              amount: amount || existing.amount,
              licenseNo: licenseNo || existing.licenseNo,
              new37Code: new37Code || existing.new37Code,
              taxCode: taxCode || existing.taxCode || '',
              vatCode: vatCode || existing.vatCode || '',
              licenseActionType:
                licenseActionType || existing.licenseActionType,
              description: description || existing.description,
              comment: comment || existing.comment,
              taxComment: existing.taxComment || taxComment || '',
              taxExtra: existing.taxExtra || taxExtra || '',
              customFields: mergedCustom,
              taxCustomFields: mergedTaxCustom,
              vatCustomFields: mergedVatCustom,
            };
          }
          saveDb(db);
          return {
            success: true,
            merged: true,
            message: `আগের সারিতেই (ক্রমিক নং: ${existing.serialNo}) চালানের তথ্য সমন্বয়/আপডেট হয়েছে।`,
            recordId: existing.recordId,
            serialNo: existing.serialNo,
            record: db.records[mergeTargetIndex],
          };
        }

        const serialNo = db.records.length + 1;
        const recordId = crypto.randomUUID();
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
          new37Code: new37Code || taxSplit.code || '',
          taxCode,
          vatCode,
          expectedAmount: scanMode === 'tax' ? '' : expectedAmount,
          expectedTaxAmount:
            scanMode === 'tax' ? expectedTaxAmount || expectedAmount : expectedTaxAmount,
          sourceMemo: taxDepartment || sourceMemo,
          taxDepartment,
          dcMemo,
          toOrganization: scanMode === 'tax' || scanMode === 'vat' ? '' : toOrganization,
          submittedThrough,
          submittedOnBehalfOf,
          challanNo:
            scanMode === 'tax' || scanMode === 'vat' ? '' : challanNo,
          description,
          quantity: scanMode === 'tax' || scanMode === 'vat' ? '' : quantity,
          rate: scanMode === 'tax' || scanMode === 'vat' ? '' : rate,
          amount: scanMode === 'tax' || scanMode === 'vat' ? '' : amount,
          challanDate:
            scanMode === 'tax' || scanMode === 'vat'
              ? ''
              : parsedMainDate.display,
          incomeTaxChallanNo:
            scanMode === 'tax'
              ? incomeTaxChallanNo || challanNo
              : incomeTaxChallanNo,
          incomeTaxDate:
            scanMode === 'tax'
              ? parsedTaxDate.display
              : incomeTaxChallanNo
                ? parsedTaxDate.display
                : '',
          incomeTaxAmount:
            scanMode === 'tax'
              ? incomeTaxAmount || amount
              : incomeTaxAmount,
          vatChallanNo:
            scanMode === 'vat' ? vatChallanNo || challanNo : vatChallanNo,
          vatDate:
            scanMode === 'vat'
              ? parsedVatDate.display
              : vatChallanNo
                ? parsedVatDate.display
                : '',
          vatAmount: scanMode === 'vat' ? vatAmount || amount : vatAmount,
          customFields:
            scanMode === 'tax' || scanMode === 'vat' ? undefined : customFields,
          taxCustomFields:
            scanMode === 'tax' ? taxCustomFields || customFields : taxCustomFields,
          vatCustomFields:
            scanMode === 'vat' ? vatCustomFields || customFields : vatCustomFields,
          comment: scanMode === 'tax' || scanMode === 'vat' ? '' : comment,
          taxComment:
            (scanMode === 'tax' || scanMode === 'vat'
              ? taxComment || comment
              : taxComment) ||
            (scanMode === 'tax' || incomeTaxChallanNo || toNumber(incomeTaxAmount) > 0
              ? buildDefaultCommissionTaxComment(
                  challanCategory,
                  parsedTaxDate.display || parsedMainDate.display,
                  incomeTaxChallanNo || (scanMode === 'tax' ? challanNo : '')
                )
              : ''),
          taxExtra,
          recordId,
          pdfUrl,
          entryTime: new Date().toISOString(),
        };

        db.records.push(record);
        saveDb(db);

        return {
          success: true,
          merged: false,
          message: `নতুন চালান সংরক্ষিত হয়েছে। ক্রমিক নং: ${serialNo}`,
          recordId,
          serialNo,
          record,
        };
      });

      if (!result.success && (result as { duplicate?: boolean }).duplicate) {
        res.status(409).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'সংরক্ষণ ব্যর্থ হয়েছে।';
      res.status(400).json({ success: false, message });
    }
  });

  app.post('/api/sync/snapshot', requireAuth, async (req, res) => {
    try {
      const dealers = Array.isArray(req.body?.dealers)
        ? (req.body.dealers as DealerRecord[])
        : null;
      const suballocations = Array.isArray(req.body?.suballocations)
        ? (req.body.suballocations as SuballocationRecord[])
        : null;
      const doIssues = Array.isArray(req.body?.doIssues)
        ? (req.body.doIssues as DoIssueRecord[])
        : null;
      const challans = Array.isArray(req.body?.challans)
        ? (req.body.challans as ChallanRecord[])
        : null;
      const challansVerified =
        Array.isArray(challans) && req.body?.challansVerified !== false;
      const pendingRecordIds = Array.isArray(req.body?.pendingRecordIds)
        ? (req.body.pendingRecordIds as string[])
        : [];
      const deletedRecordIds = Array.isArray(req.body?.deletedRecordIds)
        ? (req.body.deletedRecordIds as string[])
        : [];
      const deletedChallanLogs = Array.isArray(req.body?.deletedChallanLogs)
        ? (req.body.deletedChallanLogs as DeletedChallanLogEntry[])
        : [];

      const reconcileMissing =
        req.body?.reconcileMissing !== undefined
          ? Boolean(req.body.reconcileMissing)
          : Boolean(
              challansVerified &&
                Array.isArray(challans) &&
                (challans.length > 0 || deletedChallanLogs.length > 0)
            );
      const extShadowCount = Number(req.body?.extShadowCount || 0);

      const counts = await withLock(() => {
        const db = ensureDb();
        const summary = mergeSyncPayloadIntoDb(db, {
          dealers,
          suballocations,
          doIssues,
          challans,
          challansVerified,
          pendingRecordIds,
          deletedRecordIds,
          deletedChallanLogs,
          reconcileMissing,
          extShadowCount,
        });
        saveDb(db);
        return summary;
      });

      scheduleIdleEnrichment(25000);

      res.json({ success: true, counts });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'সিঙ্ক সংরক্ষণ ব্যর্থ হয়েছে।',
      });
    }
  });

  app.post('/api/sync/public-sheet', requireAuth, async (req, res) => {
    try {
      const counts = await pullAndMergePublicGoogleSheet(
        req.body as Partial<AppSettings> & {
          pendingRecordIds?: string[];
          deletedRecordIds?: string[];
          reconcileMissing?: boolean;
        }
      );
      scheduleIdleEnrichment(25000);
      const removedNote =
        counts.removedRecords > 0
          ? ` (শিট থেকে মোছা ${counts.removedRecords}টি সরানো হয়েছে)`
          : '';
      res.json({
        success: true,
        counts,
        message: `সিঙ্ক সম্পন্ন: ডিলার ${counts.dealers} জন, উপ-বরাদ্দ ${counts.suballocations}টি, ডিউ ${counts.doIssues}টি, চালান ${counts.records}টি${removedNote}`,
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : 'Google Sheet থেকে তথ্য আনা যায়নি।',
      });
    }
  });

  app.put('/api/challans/:recordId', requirePermission('recordEdit'), async (req, res) => {
    try {
      const { recordId } = req.params;
      const payload = req.body as Record<string, unknown>;

      const updated = await withLock(() => {
        const db = ensureDb();
        const idx = db.records.findIndex((r) => r.recordId === recordId);
        if (idx === -1) {
          throw new Error('রেকর্ডটি পাওয়া যায়নি।');
        }

        const cur = db.records[idx];

        const challanNo =
          payload.challanNo !== undefined
            ? cleanChallanNo(String(payload.challanNo))
            : cleanChallanNo(cur.challanNo);

        const incomeTaxChallanNo =
          payload.incomeTaxChallanNo !== undefined
            ? cleanChallanNo(String(payload.incomeTaxChallanNo))
            : cleanChallanNo(cur.incomeTaxChallanNo);

        const vatChallanNo =
          payload.vatChallanNo !== undefined
            ? cleanChallanNo(String(payload.vatChallanNo))
            : cleanChallanNo(cur.vatChallanNo);

        const editConflict = findGlobalChallanConflict(
          db.records,
          {
            main: challanNo,
            tax: incomeTaxChallanNo,
            vat: vatChallanNo,
          },
          recordId
        );
        if (editConflict) {
          throw new Error(editConflict.message);
        }

        const rawDate =
          payload.challanDate !== undefined
            ? String(payload.challanDate).trim()
            : String(cur.challanDate || '').trim();
        const parsedDate =
          payload.challanDate !== undefined
            ? parseChallanDate(rawDate)
            : { display: normalizeChallanDate(cur.challanDate), iso: '' };

        const nextIncomeTaxDate =
          payload.incomeTaxDate !== undefined
            ? String(payload.incomeTaxDate).trim()
              ? parseChallanDate(String(payload.incomeTaxDate).trim()).display
              : ''
            : normalizeChallanDate(cur.incomeTaxDate);

        const nextVatDate =
          payload.vatDate !== undefined
            ? String(payload.vatDate).trim()
              ? parseChallanDate(String(payload.vatDate).trim()).display
              : ''
            : normalizeChallanDate(cur.vatDate);

        const nextDescription =
          payload.description !== undefined
            ? String(payload.description).trim()
            : cur.description;

        const nextComment =
          payload.comment !== undefined
            ? String(payload.comment).trim()
            : cur.comment ?? '';

        const nextLicenseActionType =
          payload.licenseActionType !== undefined
            ? (String(payload.licenseActionType).trim() as ChallanRecord['licenseActionType'])
            : cur.licenseActionType;

        const nextCustomFields =
          payload.customFields !== undefined &&
          payload.customFields &&
          typeof payload.customFields === 'object'
            ? (payload.customFields as Record<string, string>)
            : cur.customFields;
        const nextTaxCustomFields =
          payload.taxCustomFields !== undefined &&
          payload.taxCustomFields &&
          typeof payload.taxCustomFields === 'object'
            ? (payload.taxCustomFields as Record<string, string>)
            : cur.taxCustomFields;
        const nextVatCustomFields =
          payload.vatCustomFields !== undefined &&
          payload.vatCustomFields &&
          typeof payload.vatCustomFields === 'object'
            ? (payload.vatCustomFields as Record<string, string>)
            : cur.vatCustomFields;

        const rawPayloadDate =
          payload.date !== undefined ? String(payload.date).trim() : '';
        const normalizedPayloadDate = rawPayloadDate
          ? normalizeChallanDate(rawPayloadDate)
          : '';
        const nextDate =
          parsedDate.display ||
          nextIncomeTaxDate ||
          nextVatDate ||
          normalizedPayloadDate ||
          normalizeChallanDate(cur.date);

        db.records[idx] = {
          ...cur,
          date: nextDate,
          unionName: String(payload.unionName ?? cur.unionName).trim(),
          dealerName: String(payload.dealerName ?? cur.dealerName).trim(),
          dealerAllocationId: String(
            payload.dealerAllocationId ?? cur.dealerAllocationId ?? ''
          ).trim(),
          challanCategory: String(
            payload.challanCategory ?? cur.challanCategory
          ).trim(),
          licenseActionType: nextLicenseActionType,
          department: String(
            payload.department ?? cur.department ?? ''
          ).trim(),
          toOrganization: String(
            payload.toOrganization ?? cur.toOrganization
          ).trim(),
          submittedThrough: String(
            payload.submittedThrough ?? cur.submittedThrough
          ).trim(),
          submittedOnBehalfOf: String(
            payload.submittedOnBehalfOf ?? cur.submittedOnBehalfOf
          ).trim(),
          challanNo,
          description: nextDescription,
          comment: nextComment,
          taxComment:
            payload.taxComment !== undefined
              ? String(payload.taxComment).trim()
              : cur.taxComment ?? '',
          taxExtra:
            payload.taxExtra !== undefined
              ? String(payload.taxExtra).trim()
              : cur.taxExtra ?? '',
          sourceMemo: String(
            payload.sourceMemo ?? cur.sourceMemo ?? ''
          ).trim(),
          taxDepartment: String(
            payload.taxDepartment ?? cur.taxDepartment ?? ''
          ).trim(),
          dcMemo: String(payload.dcMemo ?? cur.dcMemo ?? '').trim(),
          quantity: toEnglishDigits(
            String(payload.quantity ?? cur.quantity)
          ).trim(),
          rate: toEnglishDigits(String(payload.rate ?? cur.rate)).trim(),
          amount: toEnglishDigits(String(payload.amount ?? cur.amount)).trim(),
          challanDate: parsedDate.display,
          incomeTaxChallanNo,
          incomeTaxDate: nextIncomeTaxDate,
          incomeTaxAmount: toEnglishDigits(
            String(payload.incomeTaxAmount ?? cur.incomeTaxAmount ?? '')
          ).trim(),
          vatChallanNo,
          vatDate: nextVatDate,
          vatAmount: toEnglishDigits(
            String(payload.vatAmount ?? cur.vatAmount ?? '')
          ).trim(),
          licenseNo: String(payload.licenseNo ?? cur.licenseNo ?? '').trim(),
          expectedAmount: toEnglishDigits(
            String(payload.expectedAmount ?? cur.expectedAmount ?? '')
          ).trim(),
          expectedTaxAmount: toEnglishDigits(
            String(payload.expectedTaxAmount ?? cur.expectedTaxAmount ?? '')
          ).trim(),
          new37Code: String(payload.new37Code ?? cur.new37Code ?? '').trim(),
          taxCode: String(payload.taxCode ?? cur.taxCode ?? '').trim(),
          vatCode: String(payload.vatCode ?? cur.vatCode ?? '').trim(),
          doNo: String(payload.doNo ?? cur.doNo ?? '').trim(),
          doIssueDate: String(
            payload.doIssueDate ?? cur.doIssueDate ?? ''
          ).trim(),
          customFields: nextCustomFields,
          taxCustomFields: nextTaxCustomFields,
          vatCustomFields: nextVatCustomFields,
          pdfUrl: String(payload.pdfUrl ?? cur.pdfUrl).trim(),
        };

        saveDb(db);
        return db.records[idx];
      });

      res.json({ success: true, record: updated });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'আপডেট ব্যর্থ হয়েছে।';
      res.status(400).json({ success: false, message });
    }
  });

  app.delete('/api/challans/:recordId', requirePermission('recordDelete'), async (req, res) => {
    try {
      const { recordId } = req.params;
      await withLock(() => {
        const db = ensureDb();
        const idx = db.records.findIndex((r) => r.recordId === recordId);
        if (idx === -1) {
          throw new Error('রেকর্ডটি পাওয়া যায়নি।');
        }
        const deleted = db.records[idx];
        db.records.splice(idx, 1);
        db.records.forEach((r, i) => {
          r.serialNo = i + 1;
        });
        const delIds = new Set(db.deletedRecordIds || []);
        if (deleted.recordId) delIds.add(deleted.recordId);
        db.deletedRecordIds = Array.from(delIds).slice(-2000);
        saveDb(db);
      });
      res.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'মুছে ফেলা যায়নি।';
      res.status(400).json({ success: false, message });
    }
  });

  app.post('/api/challans/import', requirePermission('scan'), async (req, res) => {
    try {
      const rows = Array.isArray(req.body?.rows)
        ? (req.body.rows as Array<Record<string, unknown>>)
        : [];
      const result = await withLock(() => {
        const db = ensureDb();
        const existingSet = new Set<string>();
        for (const r of db.records) {
          const m = cleanChallanNo(r.challanNo);
          const t = cleanChallanNo(r.incomeTaxChallanNo);
          const v = cleanChallanNo(r.vatChallanNo);
          if (m) existingSet.add(m);
          if (t) existingSet.add(t);
          if (v) existingSet.add(v);
        }

        const deletedSet = new Set(db.deletedRecordIds || []);
        let added = 0;
        let skippedDuplicates = 0;
        let skippedInvalid = 0;

        for (const item of rows) {
          const itemRecId = String(item.recordId || '').trim();
          const itemId = String(item.id || '').trim();
          if (
            (itemRecId && deletedSet.has(itemRecId)) ||
            (itemId && deletedSet.has(itemId) && (!itemRecId || itemRecId === itemId))
          ) {
            skippedDuplicates++;
            continue;
          }

          const challanNo = cleanChallanNo(String(item.challanNo || ''));
          const incomeTaxChallanNo = cleanChallanNo(
            String(item.incomeTaxChallanNo || '')
          );
          const vatChallanNo = cleanChallanNo(String(item.vatChallanNo || ''));

          if (!challanNo && !incomeTaxChallanNo && !vatChallanNo) {
            skippedInvalid++;
            continue;
          }

          const rowNums = [challanNo, incomeTaxChallanNo, vatChallanNo].filter(Boolean);
          const hasInternalDup = new Set(rowNums).size !== rowNums.length;
          const hasGlobalDup = rowNums.some((n) => existingSet.has(n));
          if (hasInternalDup || hasGlobalDup) {
            skippedDuplicates++;
            continue;
          }

          let formattedDate = String(item.challanDate || '').trim();
          try {
            formattedDate = parseChallanDate(formattedDate).display;
          } catch {
            formattedDate = normalizeChallanDate(formattedDate);
          }

          let formattedTaxDate = String(item.incomeTaxDate || '').trim();
          try {
            formattedTaxDate = parseChallanDate(formattedTaxDate).display;
          } catch {
            formattedTaxDate = normalizeChallanDate(formattedTaxDate);
          }

          let formattedVatDate = String(item.vatDate || '').trim();
          try {
            formattedVatDate = parseChallanDate(formattedVatDate).display;
          } catch {
            formattedVatDate = normalizeChallanDate(formattedVatDate);
          }

          const formattedRowDate =
            normalizeChallanDate(String(item.date || '').trim()) ||
            formattedDate ||
            formattedTaxDate ||
            formattedVatDate;

          for (const n of rowNums) existingSet.add(n);
          const serialNo = db.records.length + 1;
          db.records.push({
            serialNo,
            id: String(item.id || '').trim() || undefined,
            date: formattedRowDate || undefined,
            department: String(item.department || '').trim() || undefined,
            taxDepartment: String(item.taxDepartment || '').trim() || undefined,
            unionName: String(item.unionName || '').trim(),
            dealerName: String(item.dealerName || '').trim(),
            dealerId: String(item.dealerId || '').trim() || undefined,
            dealerAllocationId: String(item.dealerAllocationId || '').trim(),
            challanCategory:
              String(item.challanCategory || '').trim() || 'খাদ্য বান্ধব',
            licenseActionType: (String(item.licenseActionType || '').trim() as ChallanRecord['licenseActionType']) || '',
            licenseNo: String(item.licenseNo || '').trim() || undefined,
            new37Code: String(item.new37Code || '').trim() || undefined,
            taxCode: String(item.taxCode || '').trim() || undefined,
            vatCode: String(item.vatCode || '').trim() || undefined,
            expectedAmount: toEnglishDigits(String(item.expectedAmount || '')).trim() || undefined,
            expectedTaxAmount: toEnglishDigits(String(item.expectedTaxAmount || '')).trim() || undefined,
            sourceMemo: String(item.sourceMemo || '').trim() || undefined,
            dcMemo: String(item.dcMemo || '').trim() || undefined,
            toOrganization: String(item.toOrganization || '').trim(),
            submittedThrough: String(item.submittedThrough || '').trim(),
            submittedOnBehalfOf: String(item.submittedOnBehalfOf || '').trim(),
            challanNo,
            description: String(item.description || '').trim(),
            quantity: toEnglishDigits(String(item.quantity || '')).trim(),
            rate: toEnglishDigits(String(item.rate || '')).trim(),
            amount: toEnglishDigits(String(item.amount || '')).trim(),
            challanDate: formattedDate,
            incomeTaxChallanNo,
            incomeTaxDate: formattedTaxDate,
            incomeTaxAmount: toEnglishDigits(
              String(item.incomeTaxAmount || '')
            ).trim(),
            vatChallanNo,
            vatDate: formattedVatDate,
            vatAmount: toEnglishDigits(String(item.vatAmount || '')).trim(),
            doNo: String(item.doNo || '').trim() || undefined,
            doIssueDate: normalizeChallanDate(String(item.doIssueDate || '').trim()) || undefined,
            comment: String(item.comment || '').trim() || undefined,
            taxComment: String(item.taxComment || '').trim() || undefined,
            taxExtra: String(item.taxExtra || '').trim() || undefined,
            customFields:
              item.customFields && typeof item.customFields === 'object'
                ? (item.customFields as Record<string, string>)
                : undefined,
            recordId: String(item.recordId || '').trim() || crypto.randomUUID(),
            pdfUrl: String(item.pdfUrl || '').trim(),
            entryTime:
              String(item.entryTime || '').trim() || new Date().toISOString(),
          });
          added++;
        }

        saveDb(db);
        return { added, skippedDuplicates, skippedInvalid };
      });

      res.json({ success: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'ইমপোর্ট ব্যর্থ হয়েছে।';
      res.status(400).json({ success: false, message });
    }
  });

  // ======================== SUBALLOCATIONS ========================
  app.get('/api/suballocations', requireAuth, (_req, res) => {
    const db = ensureDb();
    res.json({ success: true, suballocations: db.suballocations });
  });

  app.post('/api/suballocations/import', requirePermission('dealers'), async (req, res) => {
    try {
      const incoming = Array.isArray(req.body?.suballocations)
        ? (req.body.suballocations as Array<Record<string, unknown>>)
        : [];
      const result = await withLock(() => {
        const db = ensureDb();
        const existingIds = new Set(db.suballocations.map((s) => s.id));
        let added = 0;
        for (const item of incoming) {
          const id =
            String(item.id || '').trim() ||
            `ds-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          if (existingIds.has(id)) continue;
          existingIds.add(id);
          db.suballocations.push({
            id,
            dealerId: String(item.dealerId || '').trim(),
            dealerName: String(item.dealerName || '').trim(),
            unionName: String(item.unionName || '').trim(),
            category: String(item.category || '').trim(),
            sourceMemo: String(item.sourceMemo || '').trim(),
            unoMemo: String(item.unoMemo || '').trim(),
            allocationDate: String(item.allocationDate || '').trim(),
            cardCount: toNumber(item.cardCount as string | number),
            unusedCards: toNumber(item.unusedCards as string | number),
            allocationQty: toNumber(item.allocationQty as string | number),
            totalAmount: toNumber(item.totalAmount as string | number),
            taxAmount: toNumber(item.taxAmount as string | number),
            createdAt:
              String(item.createdAt || '').trim() || new Date().toISOString(),
          });
          added++;
        }
        saveDb(db);
        return { added };
      });
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'উপ-বরাদ্দ ইমপোর্ট ব্যর্থ।',
      });
    }
  });

  // ======================== MAINTENANCE & BACKUPS ========================
  app.get('/api/maintenance/cleanup-preview', requireAuth, (_req, res) => {
    const db = ensureDb();
    const seen = new Set<string>();
    let willAppendOneCount = 0;
    let duplicateCount = 0;
    let junkValuesCleared = 0;
    let extShadowRows = 0;
    const samples: Array<{
      serialNo: number;
      oldNo: string;
      normalizedNo: string;
      action: 'normalize' | 'duplicate';
    }> = [];

    const ordered = [
      ...db.records.filter((r) => !/^ch-ext-/i.test(String(r.id || r.recordId || ''))),
      ...db.records.filter((r) => /^ch-ext-/i.test(String(r.id || r.recordId || ''))),
    ];

    for (const r of ordered) {
      const oldMain = String(r.challanNo || '').trim();
      const oldTax = String(r.incomeTaxChallanNo || '').trim();
      const oldVat = String(r.vatChallanNo || '').trim();

      let m = cleanChallanNo(oldMain);
      let t = cleanChallanNo(oldTax);
      let v = cleanChallanNo(oldVat);

      if (oldMain && !m) junkValuesCleared++;
      if (oldTax && !t) junkValuesCleared++;
      if (oldVat && !v) junkValuesCleared++;

      const isExt = /^ch-ext-/i.test(String(r.id || r.recordId || ''));
      if (isExt) extShadowRows++;

      if (m && seen.has(m)) m = '';
      if (t && (t === m || seen.has(t))) t = '';
      if (v && (v === m || v === t || seen.has(v))) v = '';

      if (!m && !t && !v) {
        duplicateCount++;
        if (samples.length < 25) {
          samples.push({
            serialNo: r.serialNo,
            oldNo: oldMain || oldTax || oldVat || '(খালি/১১)',
            normalizedNo: '(বাদ)',
            action: 'duplicate',
          });
        }
        continue;
      }

      if (m) seen.add(m);
      if (t) seen.add(t);
      if (v) seen.add(v);

      if ((m && m !== oldMain) || (t && t !== oldTax) || (v && v !== oldVat)) {
        willAppendOneCount++;
        if (samples.length < 25) {
          samples.push({
            serialNo: r.serialNo,
            oldNo: oldMain || oldTax || oldVat,
            normalizedNo: m || t || v,
            action: 'normalize',
          });
        }
      }
    }

    res.json({
      success: true,
      totalRows: db.records.length,
      totalRecords: db.records.length,
      willAppendOneCount,
      duplicateCount,
      duplicateRowsToRemove: duplicateCount,
      junkValuesCleared,
      extShadowRows,
      alreadyBackedUp: db.duplicateBackups.length,
      samples,
    });
  });

  app.post('/api/maintenance/cleanup-duplicates', requirePermission('recordEdit'), async (_req, res) => {
    const summary = await withLock(() => {
      const db = ensureDb();
      const seen = new Set<string>();
      const keptByIndex = new Map<number, ChallanRecord>();
      const removed: DuplicateBackupRecord[] = [];
      let fixed = 0;
      const now = new Date().toISOString();

      const indexed = db.records.map((r, origIdx) => ({ r, origIdx }));
      indexed.sort((a, b) => {
        const aExt = /^ch-ext-/i.test(String(a.r.id || a.r.recordId || '')) ? 1 : 0;
        const bExt = /^ch-ext-/i.test(String(b.r.id || b.r.recordId || '')) ? 1 : 0;
        if (aExt !== bExt) return aExt - bExt;
        return a.origIdx - b.origIdx;
      });

      for (const { r, origIdx } of indexed) {
        const rawMain = String(r.challanNo || '').trim();
        const rawTax = String(r.incomeTaxChallanNo || '').trim();
        const rawVat = String(r.vatChallanNo || '').trim();

        let nextMain = cleanChallanNo(rawMain);
        let nextTax = cleanChallanNo(rawTax);
        let nextVat = cleanChallanNo(rawVat);

        const isExt = /^ch-ext-/i.test(String(r.id || r.recordId || ''));
        if (isExt && !nextMain && !nextTax && !nextVat) {
          removed.push({ ...r, deletedAt: now, originalRowNo: origIdx + 2 });
          continue;
        }

        if (nextMain && seen.has(nextMain)) {
          nextMain = '';
        }
        if (nextTax && (nextTax === nextMain || seen.has(nextTax))) {
          nextTax = '';
        }
        if (
          nextVat &&
          (nextVat === nextMain || nextVat === nextTax || seen.has(nextVat))
        ) {
          nextVat = '';
        }

        if (!nextMain && !nextTax && !nextVat) {
          removed.push({
            ...r,
            deletedAt: now,
            originalRowNo: origIdx + 2,
          });
          continue;
        }

        if (nextMain) seen.add(nextMain);
        if (nextTax) seen.add(nextTax);
        if (nextVat) seen.add(nextVat);

        if (
          nextMain !== rawMain ||
          nextTax !== rawTax ||
          nextVat !== rawVat
        ) {
          fixed++;
        }

        keptByIndex.set(origIdx, {
          ...r,
          challanNo: nextMain,
          incomeTaxChallanNo: nextTax,
          incomeTaxDate: nextTax ? r.incomeTaxDate : '',
          incomeTaxAmount: nextTax ? r.incomeTaxAmount : '',
          vatChallanNo: nextVat,
          vatDate: nextVat ? r.vatDate : '',
          vatAmount: nextVat ? r.vatAmount : '',
        });
      }

      const kept = Array.from(keptByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, rec]) => rec);

      kept.forEach((r, idx) => {
        r.serialNo = idx + 1;
      });

      db.records = kept;
      if (removed.length) {
        db.duplicateBackups.push(...removed);
      }
      saveDb(db);

      return {
        fixed,
        removedCount: removed.length,
        keptCount: kept.length,
        message: `সম্পন্ন। সংশোধিত: ${fixed}টি, মুছে ফেলা ডুপ্লিকেট/অকার্যকর সারি: ${removed.length}টি, অবশিষ্ট: ${kept.length}টি।`,
      };
    });

    res.json({ success: true, ...summary });
  });

  app.post('/api/maintenance/fix-dates', requirePermission('recordEdit'), async (req, res) => {
    const swapMonthDay = Boolean(req.body?.swapAmbiguous);
    const allowedMonths = Array.isArray(req.body?.allowedMonths)
      ? (req.body.allowedMonths as string[])
          .map((m) => String(m).padStart(2, '0'))
          .filter((m) => /^\d{2}$/.test(m))
      : [];
    const sortOrder =
      req.body?.sortOrder === 'asc' || req.body?.sortOrder === 'desc'
        ? (req.body.sortOrder as 'asc' | 'desc')
        : 'none';

    const summary = await withLock(() => {
      const db = ensureDb();
      const now = new Date().toISOString();
      let swapped = 0;
      let converted = 0;
      let skipped = 0;

      const tryFixField = (
        rec: ChallanRecord,
        rowIdx: number,
        field: 'date' | 'challanDate' | 'incomeTaxDate' | 'vatDate'
      ) => {
        const raw = toEnglishDigits(rec[field]).trim();
        if (!raw) return;

        const working = normalizeChallanDate(raw);
        const didConvert = working !== raw;

        const m = working.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) {
          const year = Number(m[1]);
          const first = Number(m[2]); // month
          const second = Number(m[3]); // day
          const mmStr = m[2];
          const canSwap = first <= 12 && second <= 12 && first !== second;
          const swappedCandidate = canSwap
            ? `${year}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`
            : '';

          if (
            allowedMonths.length > 0 &&
            !allowedMonths.includes(mmStr) &&
            swappedCandidate &&
            allowedMonths.includes(String(second).padStart(2, '0'))
          ) {
            db.dateBackups.push({
              rowNo: rowIdx + 2,
              challanNo: rec.challanNo || rec.incomeTaxChallanNo || '',
              previousValue: raw,
              previousFormat: `swapped (${field})`,
              newValue: swappedCandidate,
              fixedAt: now,
            });
            rec[field] = swappedCandidate;
            swapped++;
            return;
          }

          if (
            swapMonthDay &&
            canSwap &&
            (allowedMonths.length === 0 || !allowedMonths.includes(mmStr))
          ) {
            db.dateBackups.push({
              rowNo: rowIdx + 2,
              challanNo: rec.challanNo || rec.incomeTaxChallanNo || '',
              previousValue: raw,
              previousFormat: `yyyy-dd-MM (${field})`,
              newValue: swappedCandidate,
              fixedAt: now,
            });
            rec[field] = swappedCandidate;
            swapped++;
            return;
          }
        }

        if (didConvert) {
          db.dateBackups.push({
            rowNo: rowIdx + 2,
            challanNo: rec.challanNo || rec.incomeTaxChallanNo || '',
            previousValue: raw,
            previousFormat: `format (${field})`,
            newValue: working,
            fixedAt: now,
          });
          rec[field] = working;
          converted++;
        } else if (field === 'challanDate') {
          skipped++;
        }
      };

      db.records.forEach((r, idx) => {
        tryFixField(r, idx, 'challanDate');
        tryFixField(r, idx, 'incomeTaxDate');
        tryFixField(r, idx, 'vatDate');
        tryFixField(r, idx, 'date');

        if (r.date && r.challanDate && areSwappedMonthDayDates(r.date, r.challanDate)) {
          const prevDate = r.date;
          r.date = r.challanDate;
          db.dateBackups.push({
            rowNo: idx + 2,
            challanNo: r.challanNo || r.incomeTaxChallanNo || '',
            previousValue: prevDate,
            previousFormat: 'row date mismatch',
            newValue: r.challanDate,
            fixedAt: now,
          });
          swapped++;
        }
      });

      if (sortOrder !== 'none') {
        db.records.sort((a, b) => {
          const ka = getChallanDepositSortKey(a);
          const kb = getChallanDepositSortKey(b);
          const cmp = sortOrder === 'asc' ? ka.localeCompare(kb) : kb.localeCompare(ka);
          if (cmp !== 0) return cmp;
          return (a.challanNo || '').localeCompare(b.challanNo || '');
        });
        db.records.forEach((r, idx) => {
          r.serialNo = idx + 1;
        });
      }

      saveDb(db);
      return {
        swapped,
        converted,
        skipped,
        sorted: sortOrder !== 'none',
        message: `ঠিক করা হয়েছে। উল্টানো সংশোধন: ${swapped}টি, ফরম্যাট ঠিক: ${converted}টি${
          sortOrder !== 'none' ? ', তারিখ অনুযায়ী সাজানো হয়েছে' : ''
        }।`,
      };
    });

    res.json({ success: true, ...summary });
  });

  app.post('/api/maintenance/sort-challans', requirePermission('recordEdit'), async (req, res) => {
    const order = req.body?.order === 'desc' ? 'desc' : 'asc';
    const count = await withLock(() => {
      const db = ensureDb();
      db.records.sort((a, b) => {
        const ka = getChallanDepositSortKey(a);
        const kb = getChallanDepositSortKey(b);
        const cmp = order === 'asc' ? ka.localeCompare(kb) : kb.localeCompare(ka);
        if (cmp !== 0) return cmp;
        return (a.challanNo || '').localeCompare(b.challanNo || '');
      });
      db.records.forEach((r, idx) => {
        r.serialNo = idx + 1;
      });
      saveDb(db);
      return db.records.length;
    });
    res.json({
      success: true,
      count,
      message: `সব ${count}টি চালান জমার তারিখ অনুযায়ী (${
        order === 'asc' ? 'পুরোনো → নতুন' : 'নতুন → পুরোনো'
      }) সুন্দরভাবে সাজানো ও ক্রমিক নম্বর হালনাগাদ করা হয়েছে।`,
    });
  });

  app.get('/api/backups', requireAuth, (_req, res) => {
    const db = ensureDb();
    res.json({
      success: true,
      duplicateBackups: db.duplicateBackups,
      dateBackups: db.dateBackups,
    });
  });

  // ======================== REGISTER REPORT ========================
  app.get('/api/report', requirePermission('report'), (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').trim();
      const endDate = String(req.query.endDate || '').trim();
      const allDates =
        String(req.query.allDates || '').trim() === 'true' ||
        startDate === 'ALL' ||
        endDate === 'ALL';
      const category = String(req.query.category || 'সব ক্যাটেগরি').trim();
      const normalizedQueryCategory =
        normalizeSheetCategory(category) || category;
      const unionName = String(req.query.unionName || '').trim();
      const registerType = String(req.query.registerType || 'all').trim();
      const actionType = String(req.query.actionType || '').trim();

      if (!allDates) {
        if (!startDate || !endDate) {
          throw new Error('রিপোর্টের শুরুর ও শেষ তারিখ নির্বাচন করুন।');
        }
        if (startDate > endDate) {
          throw new Error('শুরুর তারিখ শেষ তারিখের পরে হতে পারবে না।');
        }
      }

      const db = ensureDb();
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

          return (
            dateMatches &&
            categoryMatches &&
            actionMatches &&
            unionMatches
          );
        })
        .map((r) => {
          const rawCat = String(r.challanCategory || '').trim();
          const cat = normalizeSheetCategory(rawCat) || rawCat;
          let matchedSub = r.dealerAllocationId
            ? subById.get(r.dealerAllocationId)
            : undefined;
          const numericDeposit = toNumber(r.amount);
          if (!matchedSub && numericDeposit > 0) {
            const amtMatches = db.suballocations.filter(
              (s) =>
                Math.abs(s.totalAmount - numericDeposit) < 1 &&
                (!cat ||
                  !s.category ||
                  normalizeSheetCategory(s.category) === cat)
            );
            if (amtMatches.length === 1) {
              matchedSub = amtMatches[0];
            }
          }

          const matchedDo = matchDoIssueForChallan(r, db.doIssues);

          const resolvedExpectedAmount =
            matchedSub && matchedSub.totalAmount > 0
              ? matchedSub.totalAmount
              : matchedDo && matchedDo.requiredAmount && matchedDo.requiredAmount > 0
                ? matchedDo.requiredAmount
                : toNumber(r.expectedAmount);

          const resolvedExpectedTaxAmount =
            matchedSub && matchedSub.taxAmount > 0
              ? matchedSub.taxAmount
              : matchedDo &&
                  matchedDo.requiredTaxAmount &&
                  matchedDo.requiredTaxAmount > 0
                ? matchedDo.requiredTaxAmount
                : toNumber(r.expectedTaxAmount);

          const rawTaxDept = r.taxDepartment || r.sourceMemo || '';
          const taxSplit = splitTaxDepartmentAndExtra(
            rawTaxDept,
            r.taxCode || r.vatCode || undefined
          );
          const resolvedTaxCode =
            String(r.taxCode || '').trim() ||
            (r.incomeTaxChallanNo
              ? taxSplit.code || (!r.challanNo ? r.new37Code || '' : '')
              : '');
          const resolvedVatCode =
            String(r.vatCode || '').trim() ||
            (r.vatChallanNo
              ? taxSplit.code || (!r.challanNo ? r.new37Code || '' : '')
              : '');

          const rescuedMainCode =
            String(r.new37Code || '').trim() ||
            extractEconomicCodeFromText(
              [r.toOrganization, r.department, r.description, r.comment]
                .filter(Boolean)
                .join(' ')
            );

          return {
            serialNo: r.serialNo,
            unionName:
              r.unionName ||
              matchedSub?.unionName ||
              matchedDo?.unionName ||
              '',
            dealerName:
              r.dealerName ||
              matchedSub?.dealerName ||
              matchedDo?.recipientName ||
              '',
            category: cat,
            licenseActionType: r.licenseActionType || '',
            licenseNo: r.licenseNo || '',
            new37Code: rescuedMainCode,
            taxCode: resolvedTaxCode,
            vatCode: resolvedVatCode,
            doNo: matchedDo?.doNo || r.doNo || '',
            doIssueDate: matchedDo?.issueDate || r.doIssueDate || '',
            toOrganization: r.toOrganization || r.department || '',
            taxDepartment: taxSplit.institution || rawTaxDept,
            submittedThrough: r.submittedThrough,
            submittedOnBehalfOf: r.submittedOnBehalfOf,
            challanNo: r.challanNo || r.incomeTaxChallanNo || r.vatChallanNo || '',
            description: r.description || '',
            quantity: toNumber(r.quantity),
            rate: toNumber(r.rate),
            amount: numericDeposit,
            expectedAmount: resolvedExpectedAmount,
            expectedTaxAmount: resolvedExpectedTaxAmount,
            challanDate: toISODateSafe(
              r.challanDate || r.incomeTaxDate || r.vatDate || r.date || ''
            ),
            incomeTaxChallanNo: r.incomeTaxChallanNo,
            incomeTaxDate: r.incomeTaxDate,
            incomeTaxAmount: toNumber(r.incomeTaxAmount),
            vatChallanNo: r.vatChallanNo,
            vatDate: r.vatDate,
            vatAmount: toNumber(r.vatAmount),
            customFields: r.customFields,
            taxCustomFields: r.taxCustomFields,
            vatCustomFields: r.vatCustomFields,
            comment: r.comment || r.description || '',
            taxComment: r.taxComment || '',
            taxExtra: r.taxExtra || taxSplit.extra || '',
            pdfUrl: r.pdfUrl,
            recordId: r.recordId,
          };
        })
        .sort(
          (a, b) =>
            b.challanDate.localeCompare(a.challanDate) ||
            a.serialNo - b.serialNo
        );

      res.json({
        success: true,
        rows,
        count: rows.length,
        totalInGroup: groupMatchedRecords.length,
        totalStoredRecords: db.records.length,
        totalAmount: rows.reduce((sum, r) => sum + r.amount, 0),
        totalTaxAmount: rows.reduce(
          (sum, r) => sum + (r.incomeTaxAmount || 0),
          0
        ),
        totalVatAmount: rows.reduce((sum, r) => sum + (r.vatAmount || 0), 0),
        totalQuantity: rows.reduce((sum, r) => sum + r.quantity, 0),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'রিপোর্ট তৈরি করা যায়নি।';
      res.status(400).json({ success: false, message });
    }
  });

  // ======================== LICENSEES & DEALERS ========================
  app.get('/api/licensees', requireAuth, (_req, res) => {
    const db = ensureDb();
    res.json({ success: true, licensees: db.licensees });
  });

  app.post('/api/licensees', requirePermission('dealers'), async (req, res) => {
    try {
      const licenseeName = String(req.body?.licenseeName || '').trim();
      const address = String(req.body?.address || '').trim();
      const licenseType = String(req.body?.licenseType || '').trim();
      const licenseNo = String(req.body?.licenseNo || '').trim();
      const firstIssueDate = String(req.body?.firstIssueDate || '').trim();
      const nid = String(req.body?.nid || '').trim();

      if (!licenseeName || !licenseNo) {
        throw new Error('লাইসেন্সধারীর নাম ও লাইসেন্স নং অবশ্যই দিতে হবে।');
      }

      const entry = await withLock(() => {
        const db = ensureDb();
        const item: LicenseeRecord = {
          id: `LIC-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          serialNo: db.licensees.length + 1,
          licenseeName,
          address,
          licenseType: licenseType || 'ফুড গ্রেইন লাইসেন্স (খুচরা)',
          licenseNo,
          firstIssueDate,
          nid,
        };
        db.licensees.push(item);
        saveDb(db);
        return item;
      });
      res.json({ success: true, licensee: entry });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'লাইসেন্সধারী যোগ করা যায়নি।',
      });
    }
  });

  app.post('/api/licensees/import', requirePermission('dealers'), async (req, res) => {
    try {
      const incoming = Array.isArray(req.body?.licensees)
        ? (req.body.licensees as Array<Record<string, unknown>>)
        : [];
      const result = await withLock(() => {
        const db = ensureDb();
        const existingKeys = new Set(
          db.licensees.map(
            (l) => `${l.licenseNo.trim()}::${l.licenseeName.trim()}`
          )
        );
        let added = 0;
        let skipped = 0;
        for (const row of incoming) {
          const licenseeName = String(row.licenseeName || '').trim();
          const licenseNo = String(row.licenseNo || '').trim();
          if (!licenseeName) {
            skipped++;
            continue;
          }
          const key = `${licenseNo}::${licenseeName}`;
          if (licenseNo && existingKeys.has(key)) {
            skipped++;
            continue;
          }
          if (licenseNo) existingKeys.add(key);
          db.licensees.push({
            id: `LIC-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
            serialNo: db.licensees.length + 1,
            licenseeName,
            address: String(row.address || '').trim(),
            licenseType:
              String(row.licenseType || '').trim() ||
              'ফুড গ্রেইন লাইসেন্স (খুচরা)',
            licenseNo,
            firstIssueDate: String(row.firstIssueDate || '').trim(),
            nid: String(row.nid || '').trim(),
          });
          added++;
        }
        saveDb(db);
        return { added, skipped };
      });
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'লাইসেন্স তালিকা ইমপোর্ট ব্যর্থ।',
      });
    }
  });

  app.delete('/api/licensees/:id', requirePermission('dealers'), async (req, res) => {
    try {
      const { id } = req.params;
      await withLock(() => {
        const db = ensureDb();
        db.licensees = db.licensees
          .filter((l) => l.id !== id)
          .map((l, idx) => ({ ...l, serialNo: idx + 1 }));
        saveDb(db);
      });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'লাইসেন্সধারী মুছে ফেলা যায়নি।',
      });
    }
  });

  app.get('/api/dealers', requireAuth, (_req, res) => {
    const db = ensureDb();
    const unions = Array.from(
      new Set(
        db.dealers.map((d) => String(d.unionName || '').trim()).filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, 'bn'));
    res.json({ success: true, unions, dealers: db.dealers });
  });

  app.post('/api/dealers', requirePermission('dealers'), async (req, res) => {
    try {
      const unionName = String(req.body?.unionName || '').trim();
      const dealerName = String(req.body?.dealerName || '').trim();
      const salesCenter = String(req.body?.salesCenter || '').trim();
      const category = String(req.body?.category || '').trim();
      const customId = String(req.body?.id || '').trim();

      if (!unionName || !dealerName) {
        throw new Error('ইউনিয়নের নাম এবং ডিলারের নাম অবশ্যই দিতে হবে।');
      }

      const dealer = await withLock(() => {
        const db = ensureDb();
        const exists = db.dealers.some(
          (d) =>
            d.unionName.trim() === unionName &&
            d.dealerName.trim() === dealerName
        );
        if (exists) {
          throw new Error('এই ইউনিয়নে এই ডিলার ইতিমধ্যে যুক্ত আছে।');
        }
        const entry: DealerRecord = {
          id: customId || `DF-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          unionName,
          dealerName,
          salesCenter,
          category,
        };
        db.dealers.push(entry);
        saveDb(db);
        return entry;
      });

      res.json({ success: true, dealer });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'ডিলার যোগ করা যায়নি।';
      res.status(400).json({ success: false, message });
    }
  });

  app.post('/api/dealers/import', requirePermission('dealers'), async (req, res) => {
    try {
      const incoming = Array.isArray(req.body?.dealers)
        ? (req.body.dealers as Array<Record<string, unknown>>)
        : [];
      const result = await withLock(() => {
        const db = ensureDb();
        const keySet = new Set(
          db.dealers.map(
            (d) => `${d.unionName.trim()}::${d.dealerName.trim()}`
          )
        );
        let added = 0;
        let skipped = 0;
        for (const item of incoming) {
          const unionName = String(item.unionName || '').trim();
          const dealerName = String(item.dealerName || '').trim();
          const salesCenter = String(item.salesCenter || '').trim();
          const category = String(item.category || '').trim();
          if (!dealerName) {
            skipped++;
            continue;
          }
          const key = `${unionName}::${dealerName}`;
          if (keySet.has(key)) {
            skipped++;
            continue;
          }
          keySet.add(key);
          db.dealers.push({
            id: String(item.id || '').trim() || crypto.randomUUID(),
            unionName,
            dealerName,
            salesCenter,
            category,
          });
          added++;
        }
        saveDb(db);
        return { added, skipped };
      });
      res.json({ success: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'ডিলার ইমপোর্ট ব্যর্থ হয়েছে।';
      res.status(400).json({ success: false, message });
    }
  });

  app.delete('/api/dealers/:id', requirePermission('dealers'), async (req, res) => {
    try {
      const { id } = req.params;
      await withLock(() => {
        const db = ensureDb();
        db.dealers = db.dealers.filter((d) => d.id !== id);
        saveDb(db);
      });
      res.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'ডিলার মুছে ফেলা যায়নি।';
      res.status(400).json({ success: false, message });
    }
  });

  // ======================== WORD TEMPLATES & REPORTS ========================
  app.get('/api/templates', requirePermission('templates'), (_req, res) => {
    const db = ensureDb();
    res.json({ success: true, templates: db.templates });
  });

  app.post('/api/templates', requirePermission('settings'), async (req, res) => {
    try {
      const incoming = req.body as Partial<ReportTemplate>;
      const title = String(incoming.title || '').trim();
      const htmlContent = String(incoming.htmlContent || '').trim();
      if (!title) {
        throw new Error('টেম্পলেটের টাইটেল (Title) অবশ্যই দিতে হবে।');
      }
      if (!htmlContent) {
        throw new Error('টেম্পলেটের বিষয়বস্তু খালি রাখা যাবে না।');
      }

      const result = await withLock(() => {
        const db = ensureDb();
        const id =
          String(incoming.id || '').trim() ||
          `TPL-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const entry: ReportTemplate = {
          id,
          title,
          category: String(incoming.category || 'রিপোর্ট').trim() || 'রিপোর্ট',
          htmlContent,
          defaultMemoNo: String(incoming.defaultMemoNo || '').trim(),
          defaultDate: String(incoming.defaultDate || '').trim(),
          defaultRecipient: String(incoming.defaultRecipient || '').trim(),
          officerName: String(incoming.officerName || '').trim(),
          officerDesignation: String(incoming.officerDesignation || '').trim(),
          signatureImageDataUrl: String(
            incoming.signatureImageDataUrl || ''
          ).trim(),
          orientation:
            incoming.orientation === 'landscape' ? 'landscape' : 'portrait',
          editableFields: incoming.editableFields
            ? {
                allowDate: Boolean(incoming.editableFields.allowDate),
                allowMemo: Boolean(incoming.editableFields.allowMemo),
                allowRecipient: Boolean(incoming.editableFields.allowRecipient),
                allowTableEdit: Boolean(incoming.editableFields.allowTableEdit),
              }
            : {
                allowDate: true,
                allowMemo: true,
                allowRecipient: true,
                allowTableEdit: true,
              },
          updatedAt: new Date().toISOString(),
        };
        const idx = db.templates.findIndex((t) => t.id === id);
        if (idx >= 0) {
          db.templates[idx] = entry;
        } else {
          db.templates.unshift(entry);
        }
        saveDb(db);
        return { template: entry, templates: db.templates };
      });

      res.json({ success: true, ...result });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'টেম্পলেট সংরক্ষণ ব্যর্থ হয়েছে।',
      });
    }
  });

  app.delete('/api/templates/:id', requirePermission('settings'), async (req, res) => {
    try {
      const { id } = req.params;
      const templates = await withLock(() => {
        const db = ensureDb();
        db.templates = db.templates.filter((t) => t.id !== id);
        saveDb(db);
        return db.templates;
      });
      res.json({ success: true, templates });
    } catch (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'টেম্পলেট মুছে ফেলা যায়নি।',
      });
    }
  });

  // Saved Filled Template Reports History
  app.get('/api/reports', requirePermission('templates'), (_req, res) => {
    const db = ensureDb();
    res.json({ success: true, reports: db.savedReports });
  });

  app.post('/api/templates/:id/reports', requirePermission('templates'), async (req, res) => {
    try {
      const user = getAuthenticatedUser(req);
      const { id } = req.params;
      const dbSnap = ensureDb();
      const tpl = dbSnap.templates.find((t) => t.id === id);
      if (!tpl) {
        throw new Error('টেম্পলেট পাওয়া যায়নি।');
      }
      const renderedHtml = String(req.body?.renderedHtml || '').trim();
      if (!renderedHtml) {
        throw new Error('রিপোর্টের বিষয়বস্তু খালি।');
      }

      const saved = await withLock(() => {
        const db = ensureDb();
        const entry: SavedReport = {
          id: `RPT-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          templateId: tpl.id,
          templateTitle: tpl.title,
          category: tpl.category || 'রিপোর্ট',
          dateValue: String(req.body?.dateValue || '').trim(),
          memoNo: String(req.body?.memoNo || '').trim(),
          recipient: String(req.body?.recipient || '').trim(),
          renderedHtml,
          orientation: tpl.orientation === 'landscape' ? 'landscape' : 'portrait',
          createdBy: user?.name || user?.userId || 'User',
          createdAt: new Date().toISOString(),
        };
        db.savedReports.unshift(entry);
        saveDb(db);
        return { report: entry, reports: db.savedReports };
      });
      res.json({ success: true, ...saved });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : 'রিপোর্ট সংরক্ষণ ব্যর্থ হয়েছে।',
      });
    }
  });

  app.delete('/api/reports/:id', requirePermission('templates'), async (req, res) => {
    try {
      const { id } = req.params;
      const reports = await withLock(() => {
        const db = ensureDb();
        db.savedReports = db.savedReports.filter((r) => r.id !== id);
        saveDb(db);
        return db.savedReports;
      });
      res.json({ success: true, reports });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : 'রিপোর্ট মুছে ফেলা যায়নি।',
      });
    }
  });

  // Helper: collect all project source files for GitHub / APK export
  function collectExportableSourceFiles(rootDir: string): string[] {
    const collectFiles = (dir: string, relBase = ''): string[] => {
      if (!fs.existsSync(dir)) return [];
      const out: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          ['node_modules', 'dist', 'data', '.git', '.aistudio'].includes(
            entry.name
          )
        ) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (relPath.startsWith('public/assets/aistudio')) {
          continue;
        }
        if (entry.isDirectory()) {
          out.push(...collectFiles(fullPath, relPath));
        } else if (
          /\.(ts|tsx|css|html|json|md|js|mjs|cjs|svg|png|jpg|jpeg|webp)$/i.test(
            entry.name
          ) &&
          !entry.name.includes('package-lock') &&
          !entry.name.includes('challan-store') &&
          !entry.name.endsWith('.zip')
        ) {
          out.push(relPath);
        }
      }
      return out;
    };

    const rootFiles = [
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'index.html',
      'metadata.json',
      'server.ts',
      'firebase-applet-config.json',
      '.env.example',
      '.gitignore',
    ].filter((f) => fs.existsSync(path.join(rootDir, f)));

    const srcFiles = collectFiles(path.join(rootDir, 'src'), 'src').sort();
    const publicFiles = collectFiles(
      path.join(rootDir, 'public'),
      'public'
    ).sort();
    return Array.from(new Set([...rootFiles, ...srcFiles, ...publicFiles]));
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function createZipArchive(
    entries: Array<{ name: string; data: Buffer }>
  ): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
      const uncompressed = entry.data;
      const compressed = zlib.deflateRawSync(uncompressed);
      const crc = crc32(uncompressed);

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4); // version needed
      localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
      localHeader.writeUInt16LE(8, 8); // deflate
      localHeader.writeUInt16LE(0, 10); // mod time
      localHeader.writeUInt16LE(0x5421, 12); // mod date
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(compressed.length, 18);
      localHeader.writeUInt32LE(uncompressed.length, 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);

      localParts.push(localHeader, nameBuf, compressed);

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4); // version made by
      centralHeader.writeUInt16LE(20, 6); // version needed
      centralHeader.writeUInt16LE(0x0800, 8); // UTF-8
      centralHeader.writeUInt16LE(8, 10); // deflate
      centralHeader.writeUInt16LE(0, 12);
      centralHeader.writeUInt16LE(0x5421, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(compressed.length, 20);
      centralHeader.writeUInt32LE(uncompressed.length, 24);
      centralHeader.writeUInt16LE(nameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(offset, 42);

      centralParts.push(centralHeader, nameBuf);
      offset += localHeader.length + nameBuf.length + compressed.length;
    }

    const centralDir = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDir, eocd]);
  }

  // Full App Source Code ZIP Download for GitHub & Capacitor APK
  app.get('/api/export/source-zip', requirePermission('settings'), (_req, res) => {
    try {
      const rootDir = process.cwd();
      const allFiles = collectExportableSourceFiles(rootDir);
      const entries = allFiles.map((relPath) => ({
        name: relPath,
        data: fs.readFileSync(path.join(rootDir, relPath)),
      }));
      const zipBuffer = createZipArchive(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="Challan_Portal_GitHub_Source.zip"'
      );
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : 'সোর্স কোড ZIP তৈরি করা যায়নি।',
      });
    }
  });

  // Full App Source Code Download Bundle (.txt) for GitHub & Capacitor APK
  app.get('/api/export/source-bundle', requirePermission('settings'), (_req, res) => {
    try {
      const rootDir = process.cwd();
      const allFiles = collectExportableSourceFiles(rootDir);

      const parts: string[] = [
        '================================================================================',
        'CHALLAN QR SCANNER & REGISTER PORTAL — FULL SOURCE CODE BUNDLE',
        `Generated: ${new Date().toISOString()}`,
        '================================================================================',
        '',
        '--- GITHUB & ANDROID APK QUICK STEPS ---',
        '1. GitHub Repository Setup:',
        '   Create each file below at its exact relative path, then run:',
        '   git init && git add . && git commit -m "Initial commit"',
        '   git branch -M main && git remote add origin <YOUR_GITHUB_REPO_URL>',
        '   git push -u origin main',
        '',
        '2. Run Web Server Locally:',
        '   npm install && npm run dev',
        '',
        '3. Build Android APK (via Capacitor):',
        '   npm run build',
        '   npm install @capacitor/core @capacitor/cli @capacitor/android',
        '   npx cap init "Challan Scan" "com.foodoffice.challanscan" --web-dir=dist',
        '   npx cap add android && npx cap sync android',
        '   (Or build APK on GitHub Actions using gradle assembleDebug in android/)',
        '================================================================================',
        '',
      ];

      for (const relPath of allFiles) {
        const absPath = path.join(rootDir, relPath);
        const content = fs.readFileSync(absPath, 'utf8');
        parts.push(`\n// ==================== FILE: ${relPath} ====================`);
        parts.push(content);
        parts.push(`// ==================== END: ${relPath} ====================\n`);
      }

      const bundle = parts.join('\n');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="Challan_Portal_Full_Source_Code.txt"'
      );
      res.send(bundle);
    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : 'সোর্স কোড বান্ডেল তৈরি করা যায়নি।',
      });
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr:
          process.env.DISABLE_HMR === 'true'
            ? false
            : { server: httpServer },
        ws:
          process.env.DISABLE_HMR === 'true'
            ? false
            : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  await withLock(() => {
    const db = ensureDb();
    let backfilled = 0;
    db.records = db.records.map((r) => {
      if (
        (r.incomeTaxChallanNo || toNumber(r.incomeTaxAmount) > 0) &&
        !String(r.taxComment || '').trim()
      ) {
        const fallbackRemark = buildDefaultCommissionTaxComment(
          r.challanCategory,
          r.incomeTaxDate || r.challanDate || r.date,
          r.incomeTaxChallanNo
        );
        if (fallbackRemark) {
          backfilled++;
          return { ...r, taxComment: fallbackRemark };
        }
      }
      return r;
    });
    if (backfilled > 0) {
      saveDb(db);
      console.log(
        `Restored missing 10% commission taxComment on ${backfilled} records.`
      );
    }
  });

  const initialDb = ensureDb();
  const needsImmediateSync =
    Boolean(initialDb.settings.spreadsheetId) &&
    ((initialDb.dealers.length === 0 &&
      initialDb.suballocations.length === 0 &&
      initialDb.records.length === 0) ||
      initialDb.doIssues.length === 0);

  if (needsImmediateSync) {
    try {
      const counts = await pullAndMergePublicGoogleSheet();
      console.log('Initial Google Sheet auto-sync complete:', counts);
    } catch (err) {
      console.log(
        'Initial public Google Sheet sync skipped:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const PORT = 3000;
  httpServer.on('error', (err) => {
    console.error('HTTP server error:', err);
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Challan portal running on http://0.0.0.0:${PORT}`);
    if (initialDb.settings.spreadsheetId && !needsImmediateSync) {
      void pullAndMergePublicGoogleSheet()
        .then((counts) => {
          console.log('Background Google Sheet auto-sync complete:', counts);
          scheduleIdleEnrichment(20000);
        })
        .catch((err) => {
          console.log(
            'Background public Google Sheet sync skipped:',
            err instanceof Error ? err.message : String(err)
          );
        });
    } else {
      scheduleIdleEnrichment(20000);
    }
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});



