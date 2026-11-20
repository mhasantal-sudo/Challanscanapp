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
  areSwappedMonthDayDates,
  buildDefaultCommissionTaxComment,
  cleanChallanNo,
  DEFAULT_KHATS,
  DEFAULT_SETTINGS,
  extractEconomicCodeFromText,
  extractSpreadsheetId,
  findChallanConflictInRecords,
  getChallanDepositSortKey,
  getCleanBaseRecordId,
  isSameYearMonth,
  normalizeChallanDate,
  normalizeChallanNo,
  splitTaxDepartmentAndExtra,
  toEnglishDigits,
  toNumericValue,
} from './challan.ts';
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
} from './sheetParser.ts';

interface LocalStoredUser extends UserAccount {
  password: string;
}

interface LocalDbState {
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

  const formatted = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  const match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
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

          const safeMain = cMain && !indexByAnyNo.has(cMain) ? cMain : '';
          const safeTax =
            cTax && cTax !== safeMain && !indexByAnyNo.has(cTax) ? cTax : '';
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

          const hasMainSlot = Boolean(safeMain || toNumericValue(c.amount) > 0);
          const hasTaxSlot = Boolean(safeTax || toNumericValue(c.incomeTaxAmount) > 0);
          const hasVatSlot = Boolean(safeVat || toNumericValue(c.vatAmount) > 0);
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
            recordId: cur.recordId || c.recordId || generateId('rec'),
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
            dealerAllocationId:
              c.dealerAllocationId || cur.dealerAllocationId || '',
            challanCategory: mergedCategory,
            licenseActionType:
              c.licenseActionType || cur.licenseActionType || '',
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
      const cleanRec: ChallanRecord = {
        ...c,
        id: c.id || `CHL-${newIdx + 1}`,
        recordId: c.recordId || generateId('rec'),
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
    removedRecords: removedCountFromRecords,
    removedIds: allRemovedIds,
    localOnlyRecords: localOnlyIds.length,
    localOnlyIds,
    extShadowCount: Number(payload.extShadowCount || 0),
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
  }) => Promise<{
    status: number;
    data: unknown;
    url?: string;
    headers?: Record<string, string>;
  }>;
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
  )}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(cleanTab)}&_=${Date.now()}`;

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

class LocalAchallanError extends Error {
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

const localOfficialCache = new Map<
  string,
  { data: OfficialChallanData; cachedAt: number }
>();
const localOfficialInFlight = new Map<string, Promise<OfficialChallanData>>();
let localAchallanCookie = '';

async function fetchOfficialChallanViaGasDirect(
  gasUrlRaw: string,
  cleaned: string
): Promise<OfficialChallanData | null> {
  const url = String(gasUrlRaw || '').trim();
  if (
    (!url.startsWith('https://script.google.com/') &&
      !url.startsWith('https://script.googleusercontent.com/')) ||
    /\/dev(\?|$)/i.test(url) ||
    (url.includes('script.google.com') &&
      (!url.includes('/macros/s/') || /\/edit(\?|$|#)/i.test(url)))
  ) {
    return null;
  }

  let text = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'fetchOfficialChallan',
        payload: { challanNo: cleaned },
      }),
    });
    text = await res.text();
  } catch {
    const capHttp = getCapacitorHttp();
    if (!capHttp) return null;
    try {
      const resp = await capHttp.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: JSON.stringify({
          action: 'fetchOfficialChallan',
          payload: { challanNo: cleaned },
        }),
        connectTimeout: 15000,
        readTimeout: 15000,
      });
      text = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    if ('tabs' in parsed && !('data' in parsed)) return null;
    if (parsed.success === true && parsed.data && typeof parsed.data === 'object') {
      const payload = parsed.data as OfficialChallanData;
      if (payload.ChallanNo) {
        return {
          ...payload,
          ChallanNo: normalizeChallanNo(payload.ChallanNo || cleaned) || cleaned,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchOfficialChallanDirect(
  rawChallanNo: string,
  settings?: AppSettings
): Promise<OfficialChallanData> {
  const cleaned = toEnglishDigits(rawChallanNo).trim();
  const match11 = cleaned.match(/^(\d{4})-(\d{10})(\d)$/);
  const queryNo = match11 ? `${match11[1]}-${match11[2]}` : cleaned;

  if (!/^\d{4}-\d{10}$/.test(queryNo)) {
    throw new LocalAchallanError(
      400,
      'সঠিক চালান নম্বর পাওয়া যায়নি। (ফরম্যাট: YYYY-XXXXXXXXXX বা ১১ অঙ্ক)',
      false
    );
  }

  const now = Date.now();
  const cached = localOfficialCache.get(queryNo) || localOfficialCache.get(cleaned);
  if (cached && now - cached.cachedAt <= 12 * 60 * 60 * 1000) {
    return cached.data;
  }

  const existing = localOfficialInFlight.get(queryNo);
  if (existing) return existing;

  const task = (async (): Promise<OfficialChallanData> => {
    try {
      const url = `https://www.achallan.gov.bd/acs/General/PrintChallanSlipDetailsHTML?challanNo=${encodeURIComponent(
        queryNo
      )}`;

      const capHttp = getCapacitorHttp();
      let html = '';
      let lastStatus = 409;

      if (capHttp) {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            localAchallanCookie = '';
            await new Promise((r) => setTimeout(r, attempt === 1 ? 1600 : 2600));
          }
          const reqHeaders: Record<string, string> = {
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
            Referer: 'https://www.achallan.gov.bd/acs/General/VerifyChallan',
          };
          if (localAchallanCookie) {
            reqHeaders.Cookie = localAchallanCookie;
          }

          const resp = await capHttp.request({
            url,
            method: 'GET',
            headers: reqHeaders,
            connectTimeout: 15000,
            readTimeout: 15000,
          });
          lastStatus = resp.status;
          const sc = (resp.headers?.['set-cookie'] || resp.headers?.['Set-Cookie'] || '').split(';')[0].trim();
          if (sc) localAchallanCookie = sc;

          if (resp.status >= 200 && resp.status < 300) {
            html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
            break;
          }

          if (resp.status === 409) {
            if (attempt === 0 && settings?.gasWebAppUrl) {
              const gasData = await fetchOfficialChallanViaGasDirect(
                settings.gasWebAppUrl,
                cleaned
              );
              if (gasData) {
                localOfficialCache.set(queryNo, { data: gasData, cachedAt: Date.now() });
                localOfficialCache.set(cleaned, { data: gasData, cachedAt: Date.now() });
                return gasData;
              }
            }
            continue;
          }

          throw new LocalAchallanError(
            resp.status,
            `সরকারি পেজ থেকে তথ্য আনা যায়নি। HTTP: ${resp.status}`,
            resp.status >= 500
          );
        }

        if (!html) {
          throw new LocalAchallanError(
            lastStatus || 409,
            `সরকারি পেজ থেকে তথ্য আনা যায়নি। HTTP: ${lastStatus || 409}`,
            lastStatus === 409 || lastStatus >= 500,
            5000
          );
        }
      } else {
        if (settings?.gasWebAppUrl) {
          const gasData = await fetchOfficialChallanViaGasDirect(
            settings.gasWebAppUrl,
            cleaned
          );
          if (gasData) {
            localOfficialCache.set(queryNo, { data: gasData, cachedAt: Date.now() });
            localOfficialCache.set(cleaned, { data: gasData, cachedAt: Date.now() });
            return gasData;
          }
        }
        throw new LocalAchallanError(
          400,
          'সরাসরি সরকারি পোর্টাল থেকে তথ্য আনতে সার্ভার সংযোগ অথবা Android অ্যাপ প্রয়োজন।',
          false
        );
      }

      const objMatch = html.match(/var\s+obj\s*=\s*(\{[\s\S]*?\});/);
      if (!objMatch) {
        throw new LocalAchallanError(404, 'সরকারি পেজে চালানের তথ্য পাওয়া যায়নি।', false);
      }
      const data = JSON.parse(objMatch[1]) as Record<string, unknown>;
      if (String(data.ChallanNo || '') !== queryNo) {
        throw new LocalAchallanError(404, 'প্রাপ্ত চালান নম্বরের সঙ্গে মিল পাওয়া যায়নি।', false);
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

      const parsed: OfficialChallanData = {
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
      localOfficialCache.set(queryNo, { data: parsed, cachedAt: Date.now() });
      localOfficialCache.set(cleaned, { data: parsed, cachedAt: Date.now() });
      return parsed;
    } finally {
      localOfficialInFlight.delete(queryNo);
    }
  })();

  localOfficialInFlight.set(queryNo, task);
  return task;
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
      const data = await fetchOfficialChallanDirect(challanNo, db.settings);
      return jsonResponse({ success: true, data });
    } catch (err) {
      if (err instanceof LocalAchallanError) {
        return jsonResponse(
          {
            success: false,
            statusCode: err.statusCode,
            retryable: err.retryable,
            cooldownMs: err.cooldownMs,
            message: err.message,
          },
          err.statusCode >= 400 ? err.statusCode : 400
        );
      }
      const message = err instanceof Error ? err.message : 'সরকারি তথ্য আনা যায়নি।';
      const is409 = message.includes('409');
      return jsonResponse(
        {
          success: false,
          statusCode: is409 ? 409 : 400,
          retryable: is409,
          cooldownMs: is409 ? 5000 : 0,
          message,
        },
        is409 ? 409 : 400
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
    const challans = Array.isArray(body.challans)
      ? (body.challans as ChallanRecord[])
      : null;
    const challansVerified = Boolean(body.challansVerified);
    const deletedChallanLogs = Array.isArray(body.deletedChallanLogs)
      ? (body.deletedChallanLogs as DeletedChallanLogEntry[])
      : [];
    const counts = mergeSyncPayloadIntoDb(db, {
      dealers: Array.isArray(body.dealers) ? (body.dealers as DealerRecord[]) : null,
      suballocations: Array.isArray(body.suballocations)
        ? (body.suballocations as SuballocationRecord[])
        : null,
      doIssues: Array.isArray(body.doIssues) ? (body.doIssues as DoIssueRecord[]) : null,
      challans,
      challansVerified,
      pendingRecordIds: Array.isArray(body.pendingRecordIds)
        ? (body.pendingRecordIds as string[])
        : undefined,
      deletedRecordIds: Array.isArray(body.deletedRecordIds)
        ? (body.deletedRecordIds as string[])
        : undefined,
      deletedChallanLogs,
      reconcileMissing:
        body.reconcileMissing !== undefined
          ? Boolean(body.reconcileMissing)
          : Boolean(
              challansVerified &&
                Array.isArray(challans) &&
                (challans.length > 0 || deletedChallanLogs.length > 0)
            ),
      extShadowCount: Number(body.extShadowCount || 0),
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
      const [foodRes, omsRes, subRes, doRes, chlRes, delLogRes] = await Promise.all([
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.foodDealerTabName),
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.omsDealerTabName),
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.suballocationTabName),
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.doIssueTabName || 'DO_Issue'),
        fetchPublicSheetCsvDirect(spreadsheetId, cfg.challanTabName),
        fetchPublicSheetCsvDirect(spreadsheetId, 'Challan_Deleted_Log'),
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

      const counts = mergeSyncPayloadIntoDb(db, {
        dealers: foodRes.accessible || omsRes.accessible ? dealers : null,
        suballocations,
        doIssues,
        challans,
        challansVerified: chlRes.accessible,
        pendingRecordIds: Array.isArray(body.pendingRecordIds)
          ? (body.pendingRecordIds as string[])
          : undefined,
        deletedRecordIds: Array.isArray(body.deletedRecordIds)
          ? (body.deletedRecordIds as string[])
          : undefined,
        deletedChallanLogs,
        reconcileMissing:
          body.reconcileMissing !== undefined
            ? Boolean(body.reconcileMissing)
            : autoReconcile,
        extShadowCount,
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
    return jsonResponse({
      success: true,
      records: db.records,
      deletedRecordIds: db.deletedRecordIds || [],
    });
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
      const explicitTaxCode = String(body.taxCode || '').trim();
      const explicitVatCode = String(body.vatCode || '').trim();
      const expectedAmount = toEnglishDigits(String(body.expectedAmount || '')).trim();
      const expectedTaxAmount = toEnglishDigits(String(body.expectedTaxAmount || '')).trim();
      const customFields =
        body.customFields && typeof body.customFields === 'object'
          ? (body.customFields as Record<string, string>)
          : undefined;
      const taxCustomFields =
        body.taxCustomFields && typeof body.taxCustomFields === 'object'
          ? (body.taxCustomFields as Record<string, string>)
          : undefined;
      const vatCustomFields =
        body.vatCustomFields && typeof body.vatCustomFields === 'object'
          ? (body.vatCustomFields as Record<string, string>)
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
      const challanNo = cleanChallanNo(rawChallanNo);

      const rawTaxChallanNo = String(body.incomeTaxChallanNo || '').trim();
      const incomeTaxChallanNo = cleanChallanNo(rawTaxChallanNo);

      const rawVatChallanNo = String(body.vatChallanNo || '').trim();
      const vatChallanNo = cleanChallanNo(rawVatChallanNo);

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
      const rawTaxDepartment = String(body.taxDepartment ?? sourceMemo ?? '').trim();
      const modeHintCode =
        scanMode === 'tax'
          ? explicitTaxCode || new37Code
          : scanMode === 'vat'
            ? explicitVatCode || new37Code
            : new37Code;
      const taxSplit = splitTaxDepartmentAndExtra(rawTaxDepartment, modeHintCode);
      const taxDepartment = taxSplit.institution || rawTaxDepartment;
      const taxExtra =
        String(body.taxExtra ?? '').trim() || taxSplit.extra || '';
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
      const dcMemo = String(body.dcMemo || '').trim();
      const pdfUrl = String(body.pdfUrl || '').trim();

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
      if (!challanCategory) throw new Error('চালানের খাত / ক্যাটেগরি নির্বাচন করুন।');

      const parsedMainDate = parseChallanDateLocal(rawDate);
      const parsedTaxDate = parseChallanDateLocal(rawTaxDate || rawDate);
      const parsedVatDate = parseChallanDateLocal(rawVatDate || rawDate);

      const globalConflict = findChallanConflictInRecords(db.records, {
        main: resolvedMainNo,
        tax: resolvedTaxNo,
        vat: resolvedVatNo,
      });
      if (globalConflict) {
        return jsonResponse(
          {
            success: false,
            duplicate: true,
            blocked: true,
            existingRecord: globalConflict.existingRecord
              ? {
                  serialNo: globalConflict.existingRecord.serialNo,
                  dealerName: globalConflict.existingRecord.dealerName,
                  challanCategory: globalConflict.existingRecord.challanCategory,
                  recordId: globalConflict.existingRecord.recordId,
                }
              : undefined,
            message: globalConflict.message,
          },
          409
        );
      }

      const slotIsEmpty = (r: ChallanRecord): boolean => {
        if (scanMode === 'tax') return !cleanChallanNo(r.incomeTaxChallanNo);
        if (scanMode === 'vat') return !cleanChallanNo(r.vatChallanNo);
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

        const mergeConflict = findChallanConflictInRecords(
          db.records,
          {
            main: nextCombinedMain,
            tax: nextCombinedTax,
            vat: nextCombinedVat,
          },
          existing.recordId
        );
        if (mergeConflict) {
          return jsonResponse(
            {
              success: false,
              duplicate: true,
              blocked: true,
              message: mergeConflict.message,
            },
            409
          );
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
          db.records[mergeTargetIndex] = {
            ...existing,
            taxDepartment: taxDepartment || existing.taxDepartment || '',
            sourceMemo: taxDepartment || existing.sourceMemo || '',
            incomeTaxChallanNo: incomeTaxChallanNo || challanNo,
            incomeTaxDate: parsedTaxDate.display || existing.incomeTaxDate,
            incomeTaxAmount: incomeTaxAmount || amount || existing.incomeTaxAmount,
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
              buildDefaultCommissionTaxComment(
                existing.challanCategory || challanCategory,
                parsedTaxDate.display || existing.incomeTaxDate || existing.challanDate || existing.date,
                incomeTaxChallanNo || challanNo
              ) ||
              '',
            taxExtra: taxExtra || existing.taxExtra || '',
            submittedThrough: existing.submittedThrough || submittedThrough,
            submittedOnBehalfOf: existing.submittedOnBehalfOf || submittedOnBehalfOf,
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
            taxCode: taxCode || existing.taxCode || '',
            vatCode: vatCode || existing.vatCode || '',
            licenseActionType: licenseActionType || existing.licenseActionType,
            description: description || existing.description,
            comment: comment || existing.comment,
            taxComment: existing.taxComment || taxComment || '',
            taxExtra: existing.taxExtra || taxExtra || '',
            customFields: mergedCustom,
            taxCustomFields: mergedTaxCustom,
            vatCustomFields: mergedVatCustom,
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
          (scanMode === 'tax' || incomeTaxChallanNo || toNumericValue(incomeTaxAmount) > 0
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
      try {
        const idx = db.records.findIndex((r) => r.recordId === recordId);
        if (idx === -1) {
          return jsonResponse({ success: false, message: 'রেকর্ডটি পাওয়া যায়নি।' }, 404);
        }
        const cur = db.records[idx];
        const challanNo =
          body.challanNo !== undefined
            ? cleanChallanNo(String(body.challanNo))
            : cleanChallanNo(cur.challanNo);
        const incomeTaxChallanNo =
          body.incomeTaxChallanNo !== undefined
            ? cleanChallanNo(String(body.incomeTaxChallanNo))
            : cleanChallanNo(cur.incomeTaxChallanNo);
        const vatChallanNo =
          body.vatChallanNo !== undefined
            ? cleanChallanNo(String(body.vatChallanNo))
            : cleanChallanNo(cur.vatChallanNo);

        const editConflict = findChallanConflictInRecords(
          db.records,
          { main: challanNo, tax: incomeTaxChallanNo, vat: vatChallanNo },
          recordId
        );
        if (editConflict) {
          return jsonResponse({ success: false, message: editConflict.message }, 400);
        }

        const rawDate =
          body.challanDate !== undefined
            ? String(body.challanDate).trim()
            : String(cur.challanDate || '').trim();
        const parsedDate =
          body.challanDate !== undefined
            ? parseChallanDateLocal(rawDate)
            : { display: cur.challanDate, iso: '' };

        const nextIncomeTaxDate =
          body.incomeTaxDate !== undefined
            ? String(body.incomeTaxDate).trim()
              ? parseChallanDateLocal(String(body.incomeTaxDate).trim()).display
              : ''
            : cur.incomeTaxDate ?? '';

        const nextVatDate =
          body.vatDate !== undefined
            ? String(body.vatDate).trim()
              ? parseChallanDateLocal(String(body.vatDate).trim()).display
              : ''
            : cur.vatDate ?? '';

        const nextDoIssueDate =
          body.doIssueDate !== undefined
            ? String(body.doIssueDate).trim()
              ? normalizeChallanDate(String(body.doIssueDate).trim())
              : ''
            : cur.doIssueDate ?? '';

        const rawBodyDate =
          body.date !== undefined ? String(body.date).trim() : '';
        const parsedBodyDate = rawBodyDate
          ? normalizeChallanDate(rawBodyDate)
          : '';

        const nextDate =
          parsedDate.display ||
          nextIncomeTaxDate ||
          nextVatDate ||
          parsedBodyDate ||
          normalizeChallanDate(cur.date);

        db.records[idx] = {
          ...cur,
          ...(body as Partial<ChallanRecord>),
          date: nextDate,
          challanNo,
          challanDate: parsedDate.display,
          incomeTaxChallanNo,
          incomeTaxDate: nextIncomeTaxDate,
          vatChallanNo,
          vatDate: nextVatDate,
          doIssueDate: nextDoIssueDate,
          customFields:
            body.customFields && typeof body.customFields === 'object'
              ? (body.customFields as Record<string, string>)
              : cur.customFields,
          taxCustomFields:
            body.taxCustomFields && typeof body.taxCustomFields === 'object'
              ? (body.taxCustomFields as Record<string, string>)
              : cur.taxCustomFields,
          vatCustomFields:
            body.vatCustomFields && typeof body.vatCustomFields === 'object'
              ? (body.vatCustomFields as Record<string, string>)
              : cur.vatCustomFields,
        };
        saveLocalDb(db);
        return jsonResponse({ success: true, record: db.records[idx] });
      } catch (err) {
        return jsonResponse(
          {
            success: false,
            message: err instanceof Error ? err.message : 'আপডেট ব্যর্থ হয়েছে।',
          },
          400
        );
      }
    }
    if (method === 'DELETE') {
      const delIds = new Set(db.deletedRecordIds || []);
      if (recordId) delIds.add(recordId);
      db.deletedRecordIds = Array.from(delIds).slice(-2000);
      db.records = db.records
        .filter((r) => r.recordId !== recordId)
        .map((r, i) => ({ ...r, serialNo: i + 1 }));
      saveLocalDb(db);
      return jsonResponse({ success: true });
    }
  }

  if (pathname === '/api/challans/import' && method === 'POST') {
    const rawItems = Array.isArray(body.rows)
      ? (body.rows as Array<Record<string, unknown>>)
      : Array.isArray(body.records)
        ? (body.records as Array<Record<string, unknown>>)
        : [];
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

    for (const item of rawItems) {
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
      const incomeTaxChallanNo = cleanChallanNo(String(item.incomeTaxChallanNo || ''));
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
        formattedDate = parseChallanDateLocal(formattedDate).display;
      } catch {
        formattedDate = normalizeChallanDate(formattedDate);
      }
      const normalizedTaxDate = normalizeChallanDate(
        String(item.incomeTaxDate || '').trim()
      );
      const normalizedVatDate = normalizeChallanDate(
        String(item.vatDate || '').trim()
      );
      const normalizedDoDate = normalizeChallanDate(
        String(item.doIssueDate || '').trim()
      );
      const normalizedRowDate =
        normalizeChallanDate(String(item.date || '').trim()) ||
        formattedDate ||
        normalizedTaxDate ||
        normalizedVatDate;

      for (const n of rowNums) existingSet.add(n);
      const serialNo = db.records.length + 1;
      db.records.push({
        serialNo,
        id: String(item.id || '').trim() || undefined,
        date: normalizedRowDate || undefined,
        department: String(item.department || '').trim() || undefined,
        taxDepartment: String(item.taxDepartment || '').trim() || undefined,
        unionName: String(item.unionName || '').trim(),
        dealerName: String(item.dealerName || '').trim(),
        dealerId: String(item.dealerId || '').trim() || undefined,
        dealerAllocationId: String(item.dealerAllocationId || '').trim(),
        challanCategory:
          String(item.challanCategory || '').trim() || 'খাদ্য বান্ধব',
        licenseActionType:
          (String(item.licenseActionType || '').trim() as ChallanRecord['licenseActionType']) ||
          '',
        licenseNo: String(item.licenseNo || '').trim() || undefined,
        new37Code: String(item.new37Code || '').trim() || undefined,
        taxCode: String(item.taxCode || '').trim() || undefined,
        vatCode: String(item.vatCode || '').trim() || undefined,
        expectedAmount:
          toEnglishDigits(String(item.expectedAmount || '')).trim() || undefined,
        expectedTaxAmount:
          toEnglishDigits(String(item.expectedTaxAmount || '')).trim() || undefined,
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
        incomeTaxDate: normalizedTaxDate,
        incomeTaxAmount: toEnglishDigits(String(item.incomeTaxAmount || '')).trim(),
        vatChallanNo,
        vatDate: normalizedVatDate,
        vatAmount: toEnglishDigits(String(item.vatAmount || '')).trim(),
        doNo: String(item.doNo || '').trim() || undefined,
        doIssueDate: normalizedDoDate || undefined,
        comment: String(item.comment || '').trim() || undefined,
        taxComment: String(item.taxComment || '').trim() || undefined,
        taxExtra: String(item.taxExtra || '').trim() || undefined,
        customFields:
          item.customFields && typeof item.customFields === 'object'
            ? (item.customFields as Record<string, string>)
            : undefined,
        recordId: String(item.recordId || '').trim() || generateId('rec'),
        pdfUrl: String(item.pdfUrl || '').trim(),
        entryTime:
          String(item.entryTime || '').trim() || new Date().toISOString(),
      });
      added++;
    }
    saveLocalDb(db);
    return jsonResponse({
      success: true,
      added,
      skippedDuplicates,
      skippedInvalid,
      count: added,
    });
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

    return jsonResponse({
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
  }
  if (pathname === '/api/maintenance/cleanup-duplicates' && method === 'POST') {
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

      if (nextMain && seen.has(nextMain)) nextMain = '';
      if (nextTax && (nextTax === nextMain || seen.has(nextTax))) nextTax = '';
      if (nextVat && (nextVat === nextMain || nextVat === nextTax || seen.has(nextVat))) {
        nextVat = '';
      }

      if (!nextMain && !nextTax && !nextVat) {
        removed.push({ ...r, deletedAt: now, originalRowNo: origIdx + 2 });
        continue;
      }

      if (nextMain) seen.add(nextMain);
      if (nextTax) seen.add(nextTax);
      if (nextVat) seen.add(nextVat);

      if (nextMain !== rawMain || nextTax !== rawTax || nextVat !== rawVat) {
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
    saveLocalDb(db);
    return jsonResponse({
      success: true,
      fixed,
      removedCount: removed.length,
      keptCount: kept.length,
      message: `সম্পন্ন। সংশোধিত: ${fixed}টি, মুছে ফেলা ডুপ্লিকেট/অকার্যকর সারি: ${removed.length}টি, অবশিষ্ট: ${kept.length}টি।`,
    });
  }
  if (pathname === '/api/maintenance/fix-dates' && method === 'POST') {
    const swapMonthDay = Boolean(body.swapAmbiguous);
    const allowedMonths = Array.isArray(body.allowedMonths)
      ? (body.allowedMonths as string[])
          .map((m) => String(m).padStart(2, '0'))
          .filter((m) => /^\d{2}$/.test(m))
      : [];
    const sortOrder =
      body.sortOrder === 'asc' || body.sortOrder === 'desc'
        ? (body.sortOrder as 'asc' | 'desc')
        : 'none';

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

    saveLocalDb(db);
    return jsonResponse({
      success: true,
      swapped,
      converted,
      skipped,
      sorted: sortOrder !== 'none',
      message: `ঠিক করা হয়েছে। উল্টানো সংশোধন: ${swapped}টি, ফরম্যাট ঠিক: ${converted}টি${
        sortOrder !== 'none' ? ', তারিখ অনুযায়ী সাজানো হয়েছে' : ''
      }।`,
    });
  }
  if (pathname === '/api/maintenance/sort-challans' && method === 'POST') {
    const order = body.order === 'desc' ? 'desc' : 'asc';
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
    saveLocalDb(db);
    return jsonResponse({
      success: true,
      count: db.records.length,
      message: `সব ${db.records.length}টি চালান জমার তারিখ অনুযায়ী (${
        order === 'asc' ? 'পুরোনো → নতুন' : 'নতুন → পুরোনো'
      }) সুন্দরভাবে সাজানো ও ক্রমিক নম্বর হালনাগাদ করা হয়েছে।`,
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
            r.unionName || matchedSub?.unionName || matchedDo?.unionName || '',
          dealerName:
            r.dealerName || matchedSub?.dealerName || matchedDo?.recipientName || '',
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



