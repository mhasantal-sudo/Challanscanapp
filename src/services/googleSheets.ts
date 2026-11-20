import type {
  AppSettings,
  ChallanRecord,
  DealerRecord,
  DoIssueRecord,
  SuballocationRecord,
} from '../types.ts';
import { apiFetch } from '../utils/api.ts';
import {
  areSwappedMonthDayDates,
  buildDefaultCommissionTaxComment,
  cleanChallanNo,
  extractSpreadsheetId,
  getChallanSlotLabel,
  getCleanBaseRecordId,
  getYearMonthKey,
  isSameYearMonth,
  normalizeChallanNo,
  splitTaxDepartmentAndExtra,
  stripEconomicCodeText,
  toSheetIsoDate,
  type ChallanSlot,
} from '../utils/challan.ts';
import {
  colLetterToIndex,
  parseChallansFromRows,
  parseDealersFromRows,
  parseDeletedChallanLogsFromRows,
  parseDoIssuesFromRows,
  parseSuballocationsFromRows,
  type DeletedChallanLogEntry,
} from '../utils/sheetParser.ts';
import { loadLocalVault } from '../utils/localVault.ts';
import { clearGoogleAccessToken, getGoogleAccessToken } from './googleAuth.ts';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export type { DeletedChallanLogEntry };
export { parseDeletedChallanLogsFromRows };

export interface SheetSyncPayload {
  dealers: DealerRecord[] | null;
  suballocations: SuballocationRecord[] | null;
  doIssues: DoIssueRecord[] | null;
  challans: ChallanRecord[] | null;
  challansVerified?: boolean;
  reconcileMissing?: boolean;
  deletedChallanLogs?: DeletedChallanLogEntry[];
  extShadowCount?: number;
  availableTabs: string[];
}

export interface SheetMatchHints {
  id?: string;
  srcRecordId?: string;
  challanNo?: string;
  incomeTaxChallanNo?: string;
  vatChallanNo?: string;
  dealerAllocationId?: string;
  licenseNo?: string;
  category?: string;
}

async function throwGoogleApiError(
  res: Response,
  fallbackAction: string
): Promise<never> {
  if (res.status === 401) {
    clearGoogleAccessToken();
    throw new Error(
      'Google সাইন-ইন সেশনের মেয়াদ শেষ হয়েছে — পুনরায় সাইন-ইন করুন।'
    );
  }
  let detail = '';
  try {
    const json = (await res.json()) as { error?: { message?: string } };
    detail = json?.error?.message || '';
  } catch {
    try {
      detail = (await res.text()).slice(0, 180);
    } catch {
      detail = '';
    }
  }
  if (res.status === 403) {
    throw new Error(
      `Google Sheet-এ লেখার অনুমতি নেই (403)${detail ? `: ${detail}` : ''}`
    );
  }
  throw new Error(
    `${fallbackAction} (${res.status})${detail ? `: ${detail}` : ''}`
  );
}

async function fetchSheetValues(
  spreadsheetId: string,
  range: string,
  accessToken: string
): Promise<string[][]> {
  const url = `${SHEETS_API}/${encodeURIComponent(
    spreadsheetId
  )}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    await throwGoogleApiError(res, 'Google Sheet পড়তে সমস্যা');
  }
  const json = (await res.json()) as { values?: string[][] };
  return Array.isArray(json.values) ? json.values : [];
}

async function getSpreadsheetSheetProperties(
  spreadsheetId: string,
  accessToken: string
): Promise<Array<{ sheetId: number; title: string }>> {
  const url = `${SHEETS_API}/${encodeURIComponent(
    spreadsheetId
  )}?fields=sheets.properties(sheetId,title)`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    await throwGoogleApiError(res, 'স্প্রেডশিট মেটাডেটা পড়া যায়নি');
  }
  const json = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  return (json.sheets || [])
    .map((s) => ({
      sheetId: Number(s.properties?.sheetId ?? -1),
      title: String(s.properties?.title || ''),
    }))
    .filter((s) => s.title && s.sheetId >= 0);
}

export async function getSpreadsheetTabs(
  spreadsheetId: string,
  accessToken: string
): Promise<string[]> {
  const props = await getSpreadsheetSheetProperties(spreadsheetId, accessToken);
  return props.map((p) => p.title);
}

async function formatSheetDateColumns(
  spreadsheetId: string,
  sheetTitle: string,
  accessToken: string,
  startRow1Based: number,
  endRow1Based: number,
  colIndicesZeroBased: number[],
  sheetPropsCache?: Array<{ sheetId: number; title: string }>
): Promise<void> {
  if (endRow1Based < startRow1Based || colIndicesZeroBased.length === 0) return;
  try {
    const props =
      sheetPropsCache ||
      (await getSpreadsheetSheetProperties(spreadsheetId, accessToken));
    const target = props.find((s) => s.title === sheetTitle);
    if (!target) return;

    const requests = colIndicesZeroBased.map((colIdx) => ({
      repeatCell: {
        range: {
          sheetId: target.sheetId,
          startRowIndex: startRow1Based - 1,
          endRowIndex: endRow1Based,
          startColumnIndex: colIdx,
          endColumnIndex: colIdx + 1,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type: 'DATE',
              pattern: 'yyyy-mm-dd',
            },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    }));

    await fetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    }).catch(() => undefined);
  } catch {
    // Best-effort formatting
  }
}

export async function pullFromGoogleSheetsOAuth(
  settings: AppSettings
): Promise<SheetSyncPayload> {
  const token = getGoogleAccessToken();
  if (!token) {
    throw new Error('আগে সেটিংস থেকে Google অ্যাকাউন্টে সাইন-ইন করুন।');
  }
  const cleanId = extractSpreadsheetId(settings.spreadsheetId);
  if (!cleanId) {
    throw new Error('Spreadsheet ID প্রদান করুন।');
  }

  const availableTabs = await getSpreadsheetTabs(cleanId, token);

  const hasFoodTab = availableTabs.includes(settings.foodDealerTabName);
  const hasOmsTab = availableTabs.includes(settings.omsDealerTabName);
  const dealersList: DealerRecord[] = [];

  if (hasFoodTab) {
    const rows = await fetchSheetValues(
      cleanId,
      `${settings.foodDealerTabName}!A:Z`,
      token
    );
    dealersList.push(...parseDealersFromRows(rows, 'খাদ্য বান্ধব'));
  }

  if (hasOmsTab) {
    const rows = await fetchSheetValues(
      cleanId,
      `${settings.omsDealerTabName}!A:Z`,
      token
    );
    dealersList.push(...parseDealersFromRows(rows, 'ওএমএস সাধারণ'));
  }

  const dealers = hasFoodTab || hasOmsTab ? dealersList : null;

  let suballocations: SuballocationRecord[] | null = null;
  if (availableTabs.includes(settings.suballocationTabName)) {
    const rows = await fetchSheetValues(
      cleanId,
      `${settings.suballocationTabName}!A:Z`,
      token
    );
    suballocations = parseSuballocationsFromRows(rows);
  }

  let doIssues: DoIssueRecord[] | null = null;
  const doTab = settings.doIssueTabName?.trim() || 'DO_Issue';
  if (availableTabs.includes(doTab)) {
    const rows = await fetchSheetValues(cleanId, `${doTab}!A:Z`, token);
    doIssues = parseDoIssuesFromRows(rows);
  }

  let challans: ChallanRecord[] | null = null;
  let extShadowCount = 0;
  let challanRowsCount = 0;
  const challansVerified = availableTabs.includes(settings.challanTabName);
  if (challansVerified) {
    const rows = await fetchSheetValues(
      cleanId,
      `${settings.challanTabName}!A:AD`,
      token
    );
    challanRowsCount = rows.length;
    extShadowCount = rows
      .slice(1)
      .filter((r) => /^ch-ext-/i.test(String(r?.[0] || '').trim())).length;
    challans = parseChallansFromRows(
      rows,
      dealersList,
      settings,
      suballocations || [],
      doIssues || []
    );
  }

  let deletedChallanLogs: DeletedChallanLogEntry[] = [];
  if (availableTabs.includes('Challan_Deleted_Log')) {
    try {
      const delRows = await fetchSheetValues(
        cleanId,
        'Challan_Deleted_Log!A:F',
        token
      );
      deletedChallanLogs = parseDeletedChallanLogsFromRows(delRows);
    } catch {
      // optional deleted log tab
    }
  }

  return {
    dealers,
    suballocations,
    doIssues,
    challans,
    challansVerified,
    reconcileMissing: Boolean(
      challansVerified && (challanRowsCount > 1 || deletedChallanLogs.length > 0)
    ),
    deletedChallanLogs,
    extShadowCount,
    availableTabs,
  };
}

export async function pullFromPublicSheetBackend(
  settings?: Partial<AppSettings>
): Promise<{
  success: boolean;
  counts?: {
    dealers: number;
    suballocations: number;
    records: number;
    removedRecords?: number;
    removedIds?: string[];
    localOnlyRecords?: number;
    localOnlyIds?: string[];
    extShadowCount?: number;
  };
  message?: string;
}> {
  const vault = loadLocalVault();
  const res = await apiFetch('/api/sync/public-sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(settings || {}),
      pendingRecordIds: vault.pendingSheetIds,
      deletedRecordIds: vault.deletedRecordIds,
    }),
  });
  const json = (await res.json()) as {
    success: boolean;
    counts?: {
      dealers: number;
      suballocations: number;
      records: number;
      removedRecords?: number;
      removedIds?: string[];
      localOnlyRecords?: number;
      localOnlyIds?: string[];
      extShadowCount?: number;
    };
    message?: string;
  };
  if (!res.ok || !json.success) {
    throw new Error(
      json.message || 'Google Sheet থেকে তথ্য আনা যায়নি। সেটিংস যাচাই করুন।'
    );
  }
  return json;
}

export interface SheetChallanEntry {
  scanType: 'main' | 'tax' | 'vat' | 'single';
  id: string;
  date: string;
  department: string;
  taxDepartment?: string;
  category: string;
  sourceMemo: string;
  dcMemo: string;
  dealerAllocationId: string;
  dealerName?: string;
  unionName?: string;
  licenseActionType?: string;
  expectedAmount?: string;
  expectedTaxAmount?: string;
  challanNo: string;
  challanDate: string;
  rate: string;
  quantity: string;
  totalAmount: string;
  incomeTaxChallanNo: string;
  incomeTaxDate: string;
  incomeTaxAmount: string;
  vatChallanNo?: string;
  vatDate?: string;
  vatAmount?: string;
  licenseNo?: string;
  new37Code?: string;
  taxCode?: string;
  vatCode?: string;
  customFields?: Record<string, string>;
  taxCustomFields?: Record<string, string>;
  vatCustomFields?: Record<string, string>;
  comment: string;
  taxComment?: string;
  taxExtra?: string;
  createdAt: string;
  srcRecordId: string;
  overwrite?: boolean;
  matchHints?: SheetMatchHints;
}

export function getSheetPushCapability(settings: AppSettings): {
  oauthReady: boolean;
  gasReady: boolean;
  anyReady: boolean;
  methodLabel: string;
} {
  const token = getGoogleAccessToken();
  const hasSheetId = Boolean(extractSpreadsheetId(settings.spreadsheetId));
  const hasGasUrl = Boolean(settings.gasWebAppUrl?.trim());
  const oauthReady =
    (settings.syncMethod === 'oauth' || settings.syncMethod === 'both') &&
    Boolean(token) &&
    hasSheetId;
  const gasReady =
    (settings.syncMethod === 'apps_script' || settings.syncMethod === 'both') &&
    hasGasUrl;

  const methodLabel =
    oauthReady && gasReady
      ? 'Google OAuth ও লগইন-ছাড়া Apps Script উভয় সক্রিয়'
      : oauthReady
        ? 'Google OAuth শিট সংযুক্ত'
        : gasReady
          ? 'লগইন-ছাড়া Apps Script ব্রিজ সক্রিয়'
          : hasSheetId
            ? 'শুধু সরাসরি শিট পড়া (Sync) সক্রিয় — পুশ/এডিট/ডিলিট করতে Apps Script বা Google সাইন-ইন যুক্ত করুন'
            : 'Google Sheet পুশ সংযুক্ত নয়';

  return {
    oauthReady,
    gasReady,
    anyReady: oauthReady || gasReady,
    methodLabel,
  };
}

export function challanRecordToSheetEntry(
  r: ChallanRecord,
  options?: { overwrite?: boolean; matchHints?: SheetMatchHints }
): SheetChallanEntry {
  const cleanMain = cleanChallanNo(r.challanNo);
  const cleanTax = cleanChallanNo(r.incomeTaxChallanNo);
  const cleanVat = cleanChallanNo(r.vatChallanNo);
  const hasMain = Boolean(cleanMain || r.amount);
  const hasTax = Boolean(cleanTax || r.incomeTaxAmount);
  const hasVat = Boolean(cleanVat || r.vatAmount);
  const scanType: SheetChallanEntry['scanType'] = hasMain
    ? hasTax || hasVat
      ? 'main'
      : 'single'
    : hasTax
      ? 'tax'
      : hasVat
        ? 'vat'
        : 'single';

  const taxSplit = splitTaxDepartmentAndExtra(
    r.taxDepartment || r.sourceMemo || '',
    r.new37Code
  );
  const cleanTaxDept = taxSplit.institution || r.taxDepartment || '';
  const cleanTaxExtra = r.taxExtra || taxSplit.extra || '';

  const allCodes = [r.new37Code || '', r.taxCode || '', r.vatCode || ''].filter(
    Boolean
  );
  const cleanComment = stripEconomicCodeText(
    r.comment || r.description || r.licenseActionType || '',
    allCodes
  );
  const rawTaxComment = stripEconomicCodeText(r.taxComment || '', allCodes);
  const cleanTaxComment =
    rawTaxComment ||
    (hasTax
      ? buildDefaultCommissionTaxComment(
          r.challanCategory,
          r.incomeTaxDate || r.challanDate || r.date,
          cleanTax
        )
      : '');
  const baseRecordId = getCleanBaseRecordId(r.id || r.recordId || `CHL-${r.serialNo}`);

  return {
    scanType,
    id: baseRecordId || r.id || r.recordId || `CHL-${r.serialNo}`,
    date: toSheetIsoDate(
      r.challanDate || r.incomeTaxDate || r.vatDate || r.date || ''
    ),
    department: r.department || r.toOrganization || '',
    taxDepartment: cleanTaxDept,
    category: r.challanCategory || '',
    sourceMemo: cleanTaxDept || r.sourceMemo || '',
    dcMemo: r.dcMemo || '',
    dealerAllocationId: r.dealerAllocationId || '',
    dealerName: r.dealerName || '',
    unionName: r.unionName || '',
    licenseActionType: r.licenseActionType || '',
    expectedAmount: r.expectedAmount || '',
    expectedTaxAmount: r.expectedTaxAmount || '',
    challanNo: cleanMain,
    challanDate: toSheetIsoDate(r.challanDate || ''),
    rate: r.rate || '',
    quantity: r.quantity || '',
    totalAmount: r.amount || '',
    incomeTaxChallanNo: cleanTax,
    incomeTaxDate: toSheetIsoDate(r.incomeTaxDate || ''),
    incomeTaxAmount: r.incomeTaxAmount || '',
    vatChallanNo: cleanVat,
    vatDate: toSheetIsoDate(r.vatDate || ''),
    vatAmount: r.vatAmount || '',
    licenseNo: r.licenseNo || '',
    new37Code: r.new37Code || '',
    taxCode: r.taxCode || '',
    vatCode: r.vatCode || '',
    customFields: r.customFields || {},
    taxCustomFields: r.taxCustomFields || {},
    vatCustomFields: r.vatCustomFields || {},
    comment: cleanComment,
    taxComment: cleanTaxComment,
    taxExtra: cleanTaxExtra,
    createdAt: r.entryTime || new Date().toISOString(),
    srcRecordId: r.recordId || '',
    ...(options?.overwrite ? { overwrite: true } : {}),
    ...(options?.matchHints ? { matchHints: options.matchHints } : {}),
  };
}

type SheetSubRowRole = 'main' | 'tax' | 'vat';

const ISO_TS_REGEX = /^\d{4}-\d{2}-\d{2}(?:T|\s+\d{2}:\d{2})/;

function getRowSrcId(row: string[]): string {
  const legacy17 = String(row[17] || '').trim();
  return String(
    row[23] || (!ISO_TS_REGEX.test(legacy17) ? legacy17 : '') || ''
  ).trim();
}

function classifySheetSubRowRole(row: string[]): SheetSubRowRole {
  const rId = String(row[0] || '').trim();
  const rM = cleanChallanNo(String(row[7] || ''));
  const rT = cleanChallanNo(String(row[12] || ''));
  const rV = cleanChallanNo(String(row[18] || ''));
  if (
    /-TAX$/i.test(rId) ||
    /^ch-ext-t-/i.test(rId) ||
    (!rM && Boolean(rT)) ||
    (Boolean(rM) && rM === rT)
  ) {
    return 'tax';
  }
  if (
    /-VAT$/i.test(rId) ||
    /^ch-ext-v-/i.test(rId) ||
    (!rM && !rT && Boolean(rV)) ||
    (Boolean(rM) && rM === rV)
  ) {
    return 'vat';
  }
  return 'main';
}

function getRowEffectiveDate(row: string[]): string {
  return toSheetIsoDate(
    String(row[8] || row[13] || row[19] || row[1] || '').trim()
  );
}

function findSheetRowConflict(
  existingRows: string[][],
  entry: SheetChallanEntry,
  allowedRowNumbers: number[] | number = []
): string | null {
  const eMain = cleanChallanNo(entry.challanNo);
  const eTax = cleanChallanNo(entry.incomeTaxChallanNo);
  const eVat = cleanChallanNo(entry.vatChallanNo);

  if (eMain && eTax && eMain === eTax) {
    return `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${eMain}) মূল চালান (Col H) এবং আয়কর চালান (Col M) উভয় কলামে থাকতে পারবে না।`;
  }
  if (eMain && eVat && eMain === eVat) {
    return `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${eMain}) মূল চালান (Col H) এবং ভ্যাট চালান (Col S) উভয় কলামে থাকতে পারবে না।`;
  }
  if (eTax && eVat && eTax === eVat) {
    return `বাধা দেওয়া হয়েছে: একই চালান নম্বর (${eTax}) আয়কর চালান (Col M) এবং ভ্যাট চালান (Col S) উভয় কলামে থাকতে পারবে না।`;
  }

  const incoming: Array<{ slot: ChallanSlot; num: string }> = [];
  if (eMain) incoming.push({ slot: 'main', num: eMain });
  if (eTax) incoming.push({ slot: 'tax', num: eTax });
  if (eVat) incoming.push({ slot: 'vat', num: eVat });
  if (incoming.length === 0) return null;

  const allowedSet = new Set(
    Array.isArray(allowedRowNumbers)
      ? allowedRowNumbers
      : allowedRowNumbers > 0
        ? [allowedRowNumbers]
        : []
  );

  for (let i = 1; i < existingRows.length; i++) {
    const row = existingRows[i] || [];
    const rowId = String(row[0] || '').trim();
    if (/^ch-ext-/i.test(rowId)) continue;
    const sheetRowNum = i + 1;
    if (allowedSet.has(sheetRowNum)) continue;

    const rMain = cleanChallanNo(String(row[7] || ''));
    const rTax = cleanChallanNo(String(row[12] || ''));
    const rVat = cleanChallanNo(String(row[18] || ''));
    const role = classifySheetSubRowRole(row);

    for (const item of incoming) {
      let existingSlot: ChallanSlot | null = null;
      if (rTax && rTax === item.num) {
        existingSlot = 'tax';
      } else if (rVat && rVat === item.num) {
        existingSlot = 'vat';
      } else if (rMain && rMain === item.num) {
        existingSlot = role === 'tax' ? 'tax' : role === 'vat' ? 'vat' : 'main';
      }

      if (!existingSlot) continue;

      return `বাধা দেওয়া হয়েছে: চালান নম্বর ${item.num} সম্পূর্ণ শিটে কেবল একবারই থাকবে — এটি আগে থেকেই শিটের ${sheetRowNum} নম্বর সারির ${getChallanSlotLabel(existingSlot)} ঘরে আছে! দ্বিতীয়বার যোগ করা যাবে না।`;
    }
  }

  return null;
}

interface PairedSheetRowMatch {
  mainRowIndex: number;
  taxRowIndex: number;
  vatRowIndex: number;
  allIndices: number[];
}

function findPairedSheetRows(
  existingRows: string[][],
  entry: SheetChallanEntry,
  options?: { strictForDelete?: boolean }
): PairedSheetRowMatch {
  const hints = entry.matchHints;
  const eMain = cleanChallanNo(entry.challanNo);
  const eTax = cleanChallanNo(entry.incomeTaxChallanNo);
  const eVat = cleanChallanNo(entry.vatChallanNo);

  const hMain = cleanChallanNo(hints?.challanNo);
  const hTax = cleanChallanNo(hints?.incomeTaxChallanNo);
  const hVat = cleanChallanNo(hints?.vatChallanNo);

  const entryBaseId = getCleanBaseRecordId(entry.id);
  const hintBaseId = getCleanBaseRecordId(hints?.id);
  const entryDateIso = toSheetIsoDate(
    entry.date || entry.challanDate || entry.incomeTaxDate || entry.vatDate || ''
  );

  const matchedIndices = new Set<number>();

  const canMergeSlotIntoRow = (
    row: string[],
    role: SheetSubRowRole
  ): boolean => {
    if (entry.overwrite || options?.strictForDelete) return true;
    const rMain = cleanChallanNo(String(row[7] || ''));
    const rTax = cleanChallanNo(String(row[12] || ''));
    const rVat = cleanChallanNo(String(row[18] || ''));
    const effMain = role === 'main' ? rMain : '';
    const effTax = role === 'tax' ? rTax || rMain : rTax;
    const effVat = role === 'vat' ? rVat || rMain : rVat;
    if (eMain && effMain && effMain !== eMain) return false;
    if (!eMain && eTax && effTax && effTax !== eTax) return false;
    if (!eMain && !eTax && eVat && effVat && effVat !== eVat) return false;
    return true;
  };

  for (let i = 1; i < existingRows.length; i++) {
    const row = existingRows[i] || [];
    const rowId = String(row[0] || '').trim();
    const isExt = /^ch-ext-/i.test(rowId);
    if (isExt && !options?.strictForDelete) continue;

    const sheetRowNum = i + 1;
    const rowBaseId = getCleanBaseRecordId(rowId);
    const rowSrcId = getRowSrcId(row);
    const rowCat = String(row[3] || '').trim();
    const rowAllocId = String(row[6] || '').trim();
    const rowMain = cleanChallanNo(String(row[7] || ''));
    const rowTax = cleanChallanNo(String(row[12] || ''));
    const rowVat = cleanChallanNo(String(row[18] || ''));
    const rowLic = String(row[21] || '').trim();
    const rowComment = String(row[15] || '').trim();
    const rowDateIso = getRowEffectiveDate(row);
    const role = classifySheetSubRowRole(row);

    const effMain = role === 'main' ? rowMain : '';
    const effTax = role === 'tax' ? rowTax || rowMain : rowTax;
    const effVat = role === 'vat' ? rowVat || rowMain : rowVat;

    let hit = false;
    if (entry.srcRecordId && rowSrcId && rowSrcId === entry.srcRecordId) hit = true;
    else if (hints?.srcRecordId && rowSrcId && rowSrcId === hints.srcRecordId) hit = true;
    else if (!isExt && entryBaseId && rowBaseId && rowBaseId === entryBaseId) hit = true;
    else if (!isExt && hintBaseId && rowBaseId && rowBaseId === hintBaseId) hit = true;
    else if (eMain && effMain && effMain === eMain) hit = true;
    else if (hMain && effMain && effMain === hMain) hit = true;
    else if (eTax && effTax && effTax === eTax) hit = true;
    else if (hTax && effTax && effTax === hTax) hit = true;
    else if (eVat && effVat && effVat === eVat) hit = true;
    else if (hVat && effVat && effVat === hVat) hit = true;

    if (hit) {
      matchedIndices.add(sheetRowNum);
    }
  }

  // Same-month + allocation / license / dealer pairing (also when Main & Tax are scanned on different days in same month)
  if (!options?.strictForDelete) {
    for (let i = 1; i < existingRows.length; i++) {
      const row = existingRows[i] || [];
      const rowId = String(row[0] || '').trim();
      if (/^ch-ext-/i.test(rowId)) continue;
      const sheetRowNum = i + 1;
      if (matchedIndices.has(sheetRowNum)) continue;

      const rowCat = String(row[3] || '').trim();
      const rowAllocId = String(row[6] || '').trim();
      const rowLic = String(row[21] || '').trim();
      const rowComment = String(row[15] || '').trim();
      const rowDateIso = getRowEffectiveDate(row);
      const role = classifySheetSubRowRole(row);

      if (!canMergeSlotIntoRow(row, role)) continue;

      const sameMonth =
        !entryDateIso || !rowDateIso || isSameYearMonth(entryDateIso, rowDateIso);

      if (
        entry.dealerAllocationId &&
        rowAllocId &&
        rowAllocId === entry.dealerAllocationId &&
        sameMonth
      ) {
        matchedIndices.add(sheetRowNum);
        continue;
      }

      if (
        entry.licenseNo &&
        rowLic &&
        rowLic === entry.licenseNo &&
        (!entry.category || rowCat === entry.category) &&
        sameMonth
      ) {
        matchedIndices.add(sheetRowNum);
        continue;
      }

      if (
        entry.dealerName &&
        entry.category &&
        rowCat === entry.category &&
        rowComment.includes(entry.dealerName) &&
        entryDateIso &&
        rowDateIso &&
        isSameYearMonth(entryDateIso, rowDateIso)
      ) {
        matchedIndices.add(sheetRowNum);
      }
    }
  }

  // Expand to collect any companion rows sharing baseId / srcRecordId / sameMonth+allocId with matched rows
  if (matchedIndices.size > 0) {
    const groupBaseIds = new Set<string>();
    const groupSrcIds = new Set<string>();
    const groupAllocs = new Set<string>();
    const groupMonths = new Set<string>();
    for (const rowNum of matchedIndices) {
      const row = existingRows[rowNum - 1] || [];
      const rId = String(row[0] || '').trim();
      const bId = !/^ch-ext-/i.test(rId) ? getCleanBaseRecordId(rId) : '';
      const sId = getRowSrcId(row);
      const alloc = String(row[6] || '').trim();
      const ym = getYearMonthKey(getRowEffectiveDate(row));
      if (bId) groupBaseIds.add(bId);
      if (sId) groupSrcIds.add(sId);
      if (alloc) groupAllocs.add(alloc);
      if (ym) groupMonths.add(ym);
    }

    for (let i = 1; i < existingRows.length; i++) {
      const sheetRowNum = i + 1;
      if (matchedIndices.has(sheetRowNum)) continue;
      const row = existingRows[i] || [];
      const rId = String(row[0] || '').trim();
      const isExt = /^ch-ext-/i.test(rId);
      const bId = !isExt ? getCleanBaseRecordId(rId) : '';
      const sId = getRowSrcId(row);
      const alloc = String(row[6] || '').trim();
      const ym = getYearMonthKey(getRowEffectiveDate(row));

      if (sId && groupSrcIds.has(sId)) {
        matchedIndices.add(sheetRowNum);
      } else if (!isExt && bId && groupBaseIds.has(bId)) {
        matchedIndices.add(sheetRowNum);
      } else if (
        alloc &&
        groupAllocs.has(alloc) &&
        (!ym || groupMonths.size === 0 || groupMonths.has(ym)) &&
        isExt
      ) {
        matchedIndices.add(sheetRowNum);
      }
    }
  }

  const allIndices = [...matchedIndices].sort((a, b) => a - b);
  let mainRowIndex = -1;
  let taxRowIndex = -1;
  let vatRowIndex = -1;

  for (const rowNum of allIndices) {
    const row = existingRows[rowNum - 1] || [];
    const role = classifySheetSubRowRole(row);
    if (role === 'tax' && taxRowIndex < 0) taxRowIndex = rowNum;
    else if (role === 'vat' && vatRowIndex < 0) vatRowIndex = rowNum;
    else if (role === 'main' && mainRowIndex < 0) mainRowIndex = rowNum;
  }

  return { mainRowIndex, taxRowIndex, vatRowIndex, allIndices };
}

function applyCustomColumnsToRow(
  row: string[],
  settings: AppSettings,
  fields: Record<string, string> | undefined,
  cur: string[],
  ow: boolean
): void {
  for (const colDef of settings.customColumns || []) {
    const idx = colLetterToIndex(colDef.sheetColumn);
    if (idx >= 0) {
      while (row.length <= idx) row.push('');
      const val = fields?.[colDef.id];
      if (ow) {
        row[idx] = val || '';
      } else if (val) {
        row[idx] = val;
      } else if (cur[idx]) {
        row[idx] = cur[idx];
      }
    }
  }
}

function buildSplitSheetRowsForEntry(
  settings: AppSettings,
  entry: SheetChallanEntry,
  curMain: string[] = [],
  curTax: string[] = [],
  curVat: string[] = []
): {
  mainRow: string[] | null;
  taxRow: string[] | null;
  vatRow: string[] | null;
  orderedRows: string[][];
} {
  const ow = Boolean(entry.overwrite);
  const eMain = cleanChallanNo(entry.challanNo);
  const eTax = cleanChallanNo(entry.incomeTaxChallanNo);
  const eVat = cleanChallanNo(entry.vatChallanNo);

  const curMainRole = curMain.length > 0 ? classifySheetSubRowRole(curMain) : 'main';
  const curMainNo = curMainRole === 'main' ? cleanChallanNo(curMain[7]) : '';
  const curTaxNo = cleanChallanNo(
    curTax[12] || curTax[7] || curMain[12] || ''
  );
  const curVatNo = cleanChallanNo(
    curVat[18] || curVat[7] || curMain[18] || ''
  );

  const finalMain = ow ? eMain : eMain || curMainNo || '';
  const finalTax = ow ? eTax : eTax || curTaxNo || '';
  const finalVat = ow ? eVat : eVat || curVatNo || '';

  const mainAmount = ow ? entry.totalAmount || '' : entry.totalAmount || curMain[11] || '';
  const taxAmount = ow
    ? entry.incomeTaxAmount || ''
    : entry.incomeTaxAmount || curTax[14] || curTax[11] || curMain[14] || '';
  const vatAmount = ow
    ? entry.vatAmount || ''
    : entry.vatAmount || curVat[20] || curVat[11] || curMain[20] || '';

  const hasMain = Boolean(finalMain || mainAmount);
  const hasTax = Boolean(finalTax || taxAmount);
  const hasVat = Boolean(finalVat || vatAmount);

  const rawIdCandidate =
    getCleanBaseRecordId(curMain[0]) ||
    getCleanBaseRecordId(curTax[0]) ||
    getCleanBaseRecordId(curVat[0]) ||
    getCleanBaseRecordId(entry.id) ||
    `CHL-${Date.now()}`;
  const baseId = /^ch-ext-/i.test(rawIdCandidate)
    ? getCleanBaseRecordId(entry.id) || `CHL-${Date.now()}`
    : rawIdCandidate;

  const isTaxOrVatScan =
    !ow && (entry.scanType === 'tax' || entry.scanType === 'vat');

  const rawColE = entry.taxDepartment || entry.sourceMemo || '';
  const colESplit = splitTaxDepartmentAndExtra(
    rawColE,
    entry.taxCode || entry.vatCode || entry.new37Code
  );
  const colEVal = colESplit.institution || rawColE;
  const effectiveTaxExtra = entry.taxExtra || colESplit.extra || '';

  const maxCustomColIdx = (settings.customColumns || []).reduce(
    (mx, c) => Math.max(mx, colLetterToIndex(c.sheetColumn)),
    -1
  );
  const rowWidth = Math.max(27, maxCustomColIdx + 1);
  const hasCustomAt = (colIdx: number) =>
    (settings.customColumns || []).some(
      (c) => colLetterToIndex(c.sheetColumn) === colIdx
    );

  const srcRecordId =
    entry.srcRecordId ||
    getRowSrcId(curMain) ||
    getRowSrcId(curTax) ||
    getRowSrcId(curVat) ||
    '';

  const isoMainDate = toSheetIsoDate(entry.challanDate || '');
  const isoEntryDate = toSheetIsoDate(entry.date || '');
  const isoTaxDate = ow
    ? toSheetIsoDate(entry.incomeTaxDate || entry.date || '')
    : toSheetIsoDate(entry.incomeTaxDate) ||
      toSheetIsoDate(curTax[13] || curTax[8] || curMain[13] || '') ||
      curTax[13] ||
      curMain[13] ||
      isoEntryDate ||
      isoMainDate ||
      '';
  const isoVatDate = ow
    ? toSheetIsoDate(entry.vatDate || entry.date || '')
    : toSheetIsoDate(entry.vatDate) ||
      toSheetIsoDate(curVat[19] || curVat[8] || curMain[19] || '') ||
      curVat[19] ||
      curMain[19] ||
      isoEntryDate ||
      isoMainDate ||
      '';

  let mainRow: string[] | null = null;
  let taxRow: string[] | null = null;
  let vatRow: string[] | null = null;

  if (hasMain || (!hasTax && !hasVat)) {
    mainRow = new Array(rowWidth).fill('');
    for (let k = 0; k < Math.min(curMain.length, rowWidth); k++) {
      mainRow[k] = curMain[k] ?? '';
    }
    const curColBIso = toSheetIsoDate(curMain[1] || '');
    const canonicalMainColB = ow
      ? isoEntryDate || isoMainDate || curColBIso || curMain[1] || ''
      : curColBIso &&
          !(
            (isoMainDate && areSwappedMonthDayDates(curColBIso, isoMainDate)) ||
            (isoEntryDate && areSwappedMonthDayDates(curColBIso, isoEntryDate))
          )
        ? curColBIso
        : isoMainDate || isoEntryDate || curMain[1] || '';

    const prevMainCreatedAt = ISO_TS_REGEX.test(String(curMain[17] || '').trim())
      ? curMain[17]
      : ISO_TS_REGEX.test(String(curMain[16] || '').trim())
        ? curMain[16]
        : '';

    mainRow[0] = baseId;
    mainRow[1] = canonicalMainColB;
    mainRow[2] = ow
      ? entry.department
      : isTaxOrVatScan
        ? curMain[2] || ''
        : entry.department || curMain[2] || '';
    mainRow[3] = ow
      ? entry.category
      : entry.category || curMain[3] || curTax[3] || '';
    mainRow[4] = hasTax
      ? curMain[4] && !isTaxOrVatScan && colEVal === ''
        ? curMain[4]
        : isTaxOrVatScan
          ? ''
          : colEVal === entry.taxDepartment
            ? ''
            : colEVal || ''
      : ow
        ? colEVal
        : colEVal || curMain[4] || '';
    mainRow[5] = ow
      ? entry.dcMemo
      : entry.dcMemo || curMain[5] || curTax[5] || '';
    mainRow[6] = ow
      ? entry.dealerAllocationId
      : entry.dealerAllocationId || curMain[6] || curTax[6] || '';
    mainRow[7] = finalMain;
    mainRow[8] = ow
      ? isoMainDate
      : isoMainDate || toSheetIsoDate(curMain[8]) || curMain[8] || '';
    mainRow[9] = ow ? entry.rate : entry.rate || curMain[9] || '';
    mainRow[10] = ow ? entry.quantity : entry.quantity || curMain[10] || '';
    mainRow[11] = mainAmount;
    // Clear Tax (Col M/N/O/Q) & VAT (Col S/T/U) on Main row so external auto-copy scripts never trigger extra rows!
    mainRow[12] = '';
    mainRow[13] = '';
    mainRow[14] = '';
    mainRow[15] = ow ? entry.comment : entry.comment || curMain[15] || '';
    mainRow[16] = '';
    mainRow[17] = prevMainCreatedAt || entry.createdAt;
    mainRow[18] = '';
    mainRow[19] = '';
    mainRow[20] = '';
    mainRow[21] = ow
      ? entry.licenseNo || ''
      : entry.licenseNo || curMain[21] || curTax[21] || '';
    mainRow[22] = ow
      ? entry.new37Code || ''
      : isTaxOrVatScan
        ? curMain[22] || entry.new37Code || ''
        : entry.new37Code || curMain[22] || '';

    if (!hasCustomAt(23) && (curMain[23] || srcRecordId)) {
      mainRow[23] = curMain[23] || srcRecordId;
    }
    if (!hasCustomAt(24)) mainRow[24] = '';
    if (!hasCustomAt(25)) mainRow[25] = '';
    if (!hasCustomAt(26)) mainRow[26] = '';

    const mainCustomSource =
      entry.customFields &&
      (entry.scanType !== 'tax' && entry.scanType !== 'vat'
        ? entry.customFields
        : undefined);
    applyCustomColumnsToRow(mainRow, settings, mainCustomSource, curMain, ow && !isTaxOrVatScan);
  }

  if (hasTax) {
    taxRow = new Array(rowWidth).fill('');
    for (let k = 0; k < Math.min(curTax.length, rowWidth); k++) {
      taxRow[k] = curTax[k] ?? '';
    }
    const prevTaxComment = ISO_TS_REGEX.test(String(curTax[16] || '').trim())
      ? ''
      : curTax[16] || curMain[16] || curTax[15] || '';
    const prevTaxCreatedAt = ISO_TS_REGEX.test(String(curTax[17] || '').trim())
      ? curTax[17]
      : ISO_TS_REGEX.test(String(curTax[16] || '').trim())
        ? curTax[16]
        : '';

    const taxDeptVal = ow
      ? colEVal
      : colEVal ||
        curTax[4] ||
        curTax[2] ||
        (curMain.length > 0 && curMain[4] && curMain[4] !== entry.department
          ? curMain[4]
          : '') ||
        '';
    const defaultTaxCommentFallback = buildDefaultCommissionTaxComment(
      entry.category || curTax[3] || curMain[3] || '',
      isoTaxDate || entry.date,
      finalTax
    );
    const taxCommentVal = ow
      ? entry.taxComment || defaultTaxCommentFallback || ''
      : entry.taxComment || prevTaxComment || defaultTaxCommentFallback || '';
    const taxCodeVal = ow
      ? entry.taxCode || ''
      : entry.taxCode || curTax[25] || curTax[22] || curMain[25] || '';
    const taxExtraVal = ow
      ? effectiveTaxExtra
      : effectiveTaxExtra || curTax[24] || curMain[24] || '';

    taxRow[0] = `${baseId}-TAX`;
    taxRow[1] = isoTaxDate;
    taxRow[2] = '';
    taxRow[3] = ow
      ? entry.category
      : entry.category || curTax[3] || curMain[3] || '';
    taxRow[4] = taxDeptVal;
    taxRow[5] = ow
      ? entry.dcMemo
      : entry.dcMemo || curTax[5] || curMain[5] || '';
    taxRow[6] = ow
      ? entry.dealerAllocationId
      : entry.dealerAllocationId || curTax[6] || curMain[6] || '';
    // Leave Main columns (Col C, H, I, J, K, L, P) blank on -TAX row so other apps ONLY read Income Tax from Col M/N/O!
    taxRow[7] = '';
    taxRow[8] = '';
    taxRow[9] = '';
    taxRow[10] = '';
    taxRow[11] = '';
    taxRow[12] = finalTax;
    taxRow[13] = isoTaxDate;
    taxRow[14] = taxAmount;
    taxRow[15] = '';
    taxRow[16] = taxCommentVal;
    taxRow[17] = prevTaxCreatedAt || entry.createdAt;
    taxRow[18] = '';
    taxRow[19] = '';
    taxRow[20] = '';
    taxRow[21] = ow
      ? entry.licenseNo || ''
      : entry.licenseNo || curTax[21] || curMain[21] || '';
    taxRow[22] =
      taxCodeVal ||
      (ow ? entry.new37Code || '' : entry.new37Code || curMain[22] || '');

    if (!hasCustomAt(23) && (curTax[23] || srcRecordId)) {
      taxRow[23] = curTax[23] || srcRecordId;
    }
    if (!hasCustomAt(24) && (ow || taxExtraVal)) {
      taxRow[24] = taxExtraVal;
    }
    if (!hasCustomAt(25) && (ow || taxCodeVal)) {
      taxRow[25] = taxCodeVal;
    }
    if (!hasCustomAt(26)) taxRow[26] = '';

    const taxCustomSource =
      entry.taxCustomFields && Object.keys(entry.taxCustomFields).length > 0
        ? entry.taxCustomFields
        : entry.scanType === 'tax'
          ? entry.customFields
          : undefined;
    applyCustomColumnsToRow(
      taxRow,
      settings,
      taxCustomSource,
      curTax,
      ow && entry.scanType !== 'main'
    );
  }

  if (hasVat) {
    vatRow = new Array(rowWidth).fill('');
    for (let k = 0; k < Math.min(curVat.length, rowWidth); k++) {
      vatRow[k] = curVat[k] ?? '';
    }
    const prevVatCreatedAt = ISO_TS_REGEX.test(String(curVat[17] || '').trim())
      ? curVat[17]
      : '';
    const vatCodeVal = ow
      ? entry.vatCode || ''
      : entry.vatCode || curVat[26] || curVat[22] || curMain[26] || '';
    const vatDeptVal =
      curVat[4] || curVat[2] || (!hasTax ? colEVal : '') || '';

    vatRow[0] = `${baseId}-VAT`;
    vatRow[1] = isoVatDate;
    vatRow[2] = '';
    vatRow[3] = ow
      ? entry.category
      : entry.category || curVat[3] || curMain[3] || '';
    vatRow[4] = vatDeptVal;
    vatRow[5] = ow
      ? entry.dcMemo
      : entry.dcMemo || curVat[5] || curMain[5] || '';
    vatRow[6] = ow
      ? entry.dealerAllocationId
      : entry.dealerAllocationId || curVat[6] || curMain[6] || '';
    vatRow[7] = '';
    vatRow[8] = '';
    vatRow[9] = '';
    vatRow[10] = '';
    vatRow[11] = '';
    vatRow[12] = '';
    vatRow[13] = '';
    vatRow[14] = '';
    vatRow[15] = '';
    vatRow[16] = ow ? curVat[16] || '' : curVat[16] || '';
    vatRow[17] = prevVatCreatedAt || entry.createdAt;
    vatRow[18] = finalVat;
    vatRow[19] = isoVatDate;
    vatRow[20] = vatAmount;
    vatRow[21] = ow
      ? entry.licenseNo || ''
      : entry.licenseNo || curVat[21] || curMain[21] || '';
    vatRow[22] =
      vatCodeVal ||
      (ow ? entry.new37Code || '' : entry.new37Code || curMain[22] || '');

    if (!hasCustomAt(23) && (curVat[23] || srcRecordId)) {
      vatRow[23] = curVat[23] || srcRecordId;
    }
    if (!hasCustomAt(24)) vatRow[24] = curVat[24] || '';
    if (!hasCustomAt(25)) vatRow[25] = '';
    if (!hasCustomAt(26) && (ow || vatCodeVal)) {
      vatRow[26] = vatCodeVal;
    }

    const vatCustomSource =
      entry.vatCustomFields && Object.keys(entry.vatCustomFields).length > 0
        ? entry.vatCustomFields
        : entry.scanType === 'vat'
          ? entry.customFields
          : undefined;
    applyCustomColumnsToRow(
      vatRow,
      settings,
      vatCustomSource,
      curVat,
      ow && entry.scanType !== 'main'
    );
  }

  const orderedRows: string[][] = [];
  if (mainRow) orderedRows.push(mainRow);
  if (taxRow) orderedRows.push(taxRow);
  if (vatRow) orderedRows.push(vatRow);

  return { mainRow, taxRow, vatRow, orderedRows };
}

export async function writeChallanToGoogleSheetOAuth(
  settings: AppSettings,
  entry: SheetChallanEntry
): Promise<{ mode: 'updated' | 'appended'; rowNumber: number }> {
  const token = getGoogleAccessToken();
  if (!token) {
    throw new Error('Google অ্যাকাউন্টে সাইন-ইন করা নেই।');
  }
  const sheetId = extractSpreadsheetId(settings.spreadsheetId);
  if (!sheetId) {
    throw new Error('Spreadsheet ID সেট করা নেই।');
  }
  const tab = settings.challanTabName.trim() || 'Challan';

  const sheetProps = await getSpreadsheetSheetProperties(sheetId, token);
  const targetSheet = sheetProps.find((s) => s.title === tab);
  const availableTabs = sheetProps.map((s) => s.title);
  if (!targetSheet) {
    throw new Error(
      `Google Sheet-এ "${tab}" ট্যাবটি পাওয়া যায়নি। (বিদ্যমান ট্যাব: ${availableTabs.join(', ')})`
    );
  }

  const existingRows = await fetchSheetValues(sheetId, `${tab}!A:AD`, token);
  const match = findPairedSheetRows(existingRows, entry);
  const conflictMsg = findSheetRowConflict(
    existingRows,
    entry,
    match.allIndices
  );
  if (conflictMsg) {
    throw new Error(conflictMsg);
  }

  const curMain =
    match.mainRowIndex > 0 ? existingRows[match.mainRowIndex - 1] || [] : [];
  const curTax =
    match.taxRowIndex > 0 ? existingRows[match.taxRowIndex - 1] || [] : [];
  const curVat =
    match.vatRowIndex > 0 ? existingRows[match.vatRowIndex - 1] || [] : [];

  const { orderedRows } = buildSplitSheetRowsForEntry(
    settings,
    entry,
    curMain,
    curTax,
    curVat
  );

  let resultInfo: { mode: 'updated' | 'appended'; rowNumber: number };
  let startFormatRow = 2;
  let endFormatRow = 2;

  if (match.allIndices.length > 0 && orderedRows.length > 0) {
    const anchorRow = match.allIndices[0];
    const isContiguousSameCount =
      match.allIndices.length === orderedRows.length &&
      match.allIndices.every((r, idx) => r === anchorRow + idx);

    if (!isContiguousSameCount) {
      const requests: Array<Record<string, unknown>> = [];
      const otherDesc = match.allIndices
        .filter((r) => r !== anchorRow)
        .sort((a, b) => b - a);
      for (const rNum of otherDesc) {
        requests.push({
          deleteDimension: {
            range: {
              sheetId: targetSheet.sheetId,
              dimension: 'ROWS',
              startIndex: rNum - 1,
              endIndex: rNum,
            },
          },
        });
      }
      if (orderedRows.length > 1) {
        requests.push({
          insertDimension: {
            range: {
              sheetId: targetSheet.sheetId,
              dimension: 'ROWS',
              startIndex: anchorRow,
              endIndex: anchorRow + orderedRows.length - 1,
            },
            inheritFromBefore: true,
          },
        });
      }
      if (requests.length > 0) {
        const structRes = await fetch(
          `${SHEETS_API}/${encodeURIComponent(sheetId)}:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ requests }),
          }
        );
        if (!structRes.ok) {
          await throwGoogleApiError(
            structRes,
            'Google Sheet-এ মূল ও আয়কর সারি পাশাপাশি সাজানো যায়নি'
          );
        }
      }
    }

    const endRow = anchorRow + orderedRows.length - 1;
    const updateUrl = `${SHEETS_API}/${encodeURIComponent(
      sheetId
    )}/values/${encodeURIComponent(
      `${tab}!A${anchorRow}:AD${endRow}`
    )}?valueInputOption=USER_ENTERED`;

    const res = await fetch(updateUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: orderedRows.map((r) => r.slice(0, 30)) }),
    });
    if (!res.ok) {
      await throwGoogleApiError(res, 'Google Sheet আপডেট ব্যর্থ');
    }
    startFormatRow = anchorRow;
    endFormatRow = endRow;
    resultInfo = { mode: 'updated', rowNumber: anchorRow };
  } else {
    const appendUrl = `${SHEETS_API}/${encodeURIComponent(
      sheetId
    )}/values/${encodeURIComponent(
      `${tab}!A:AD`
    )}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const res = await fetch(appendUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: orderedRows.map((r) => r.slice(0, 30)) }),
    });
    if (!res.ok) {
      await throwGoogleApiError(res, 'Google Sheet সংরক্ষণ ব্যর্থ');
    }
    startFormatRow = Math.max(2, existingRows.length + 1);
    endFormatRow = startFormatRow + Math.max(0, orderedRows.length - 1);
    resultInfo = { mode: 'appended', rowNumber: startFormatRow };
  }

  await ensureSheetTaxCommentHeaderOAuth(
    sheetId,
    tab,
    token,
    existingRows[0] || [],
    settings
  );

  await formatSheetDateColumns(
    sheetId,
    tab,
    token,
    startFormatRow,
    endFormatRow,
    [1, 8, 13, 19],
    sheetProps
  );

  const vatTab = settings.separateVatTabName?.trim();
  if (
    vatTab &&
    vatTab !== tab &&
    entry.vatChallanNo &&
    availableTabs.includes(vatTab)
  ) {
    const vatRow = [
      entry.id,
      toSheetIsoDate(entry.vatDate || entry.date),
      entry.category,
      entry.dealerName || '',
      entry.licenseNo || '',
      normalizeChallanNo(entry.vatChallanNo),
      entry.vatAmount || '',
      entry.vatCode || entry.new37Code || '',
      entry.createdAt,
    ];
    await fetch(
      `${SHEETS_API}/${encodeURIComponent(
        sheetId
      )}/values/${encodeURIComponent(
        `${vatTab}!A:I`
      )}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [vatRow] }),
      }
    ).catch(() => undefined);
    await formatSheetDateColumns(sheetId, vatTab, token, 2, 2000, [1], sheetProps);
  }

  return resultInfo;
}

function findAllMatchingSheetRowIndicesForDelete(
  existingRows: string[][],
  entry: SheetChallanEntry
): number[] {
  const hints = entry.matchHints;
  const entryNums = new Set(
    [
      cleanChallanNo(entry.challanNo),
      cleanChallanNo(entry.incomeTaxChallanNo),
      cleanChallanNo(entry.vatChallanNo),
      cleanChallanNo(hints?.challanNo),
      cleanChallanNo(hints?.incomeTaxChallanNo),
      cleanChallanNo(hints?.vatChallanNo),
    ].filter(Boolean)
  );
  const srcIds = new Set(
    [entry.srcRecordId, hints?.srcRecordId].filter((v): v is string => Boolean(v))
  );
  const rowBaseIds = new Set(
    [getCleanBaseRecordId(entry.id), getCleanBaseRecordId(hints?.id)].filter(
      Boolean
    )
  );

  const matches: number[] = [];
  for (let i = 1; i < existingRows.length; i++) {
    const row = existingRows[i] || [];
    const rId = String(row[0] || '').trim();
    const rBaseId = !/^ch-ext-/i.test(rId) ? getCleanBaseRecordId(rId) : '';
    const rSrcId = getRowSrcId(row);
    const rMain = cleanChallanNo(String(row[7] || ''));
    const rTax = cleanChallanNo(String(row[12] || ''));
    const rVat = cleanChallanNo(String(row[18] || ''));

    const matchedById =
      (rSrcId && srcIds.has(rSrcId)) ||
      (rBaseId && rowBaseIds.has(rBaseId));
    const matchedByNum =
      (rMain && entryNums.has(rMain)) ||
      (rTax && entryNums.has(rTax)) ||
      (rVat && entryNums.has(rVat));

    if (matchedById || matchedByNum) {
      matches.push(i + 1);
    }
  }
  return matches;
}

export async function deleteChallanFromGoogleSheetOAuth(
  settings: AppSettings,
  record: ChallanRecord
): Promise<{ deleted: boolean; rowNumber?: number }> {
  const token = getGoogleAccessToken();
  if (!token) {
    throw new Error('Google অ্যাকাউন্টে সাইন-ইন করা নেই।');
  }
  const sheetId = extractSpreadsheetId(settings.spreadsheetId);
  if (!sheetId) {
    throw new Error('Spreadsheet ID সেট করা নেই।');
  }
  const tab = settings.challanTabName.trim() || 'Challan';
  const sheetProps = await getSpreadsheetSheetProperties(sheetId, token);
  const targetSheet = sheetProps.find((s) => s.title === tab);
  if (!targetSheet) {
    throw new Error(`Google Sheet-এ "${tab}" ট্যাবটি পাওয়া যায়নি।`);
  }

  const existingRows = await fetchSheetValues(sheetId, `${tab}!A:AD`, token);
  const entry = challanRecordToSheetEntry(record);
  const matchRows = findAllMatchingSheetRowIndicesForDelete(existingRows, entry);

  if (matchRows.length === 0) {
    return { deleted: false };
  }

  const sortedDesc = [...new Set(matchRows)]
    .filter((n) => n > 1)
    .sort((a, b) => b - a);
  if (sortedDesc.length === 0) {
    return { deleted: false };
  }

  const deleteRes = await fetch(
    `${SHEETS_API}/${encodeURIComponent(sheetId)}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: sortedDesc.map((rowNum) => ({
          deleteDimension: {
            range: {
              sheetId: targetSheet.sheetId,
              dimension: 'ROWS',
              startIndex: rowNum - 1,
              endIndex: rowNum,
            },
          },
        })),
      }),
    }
  );
  if (!deleteRes.ok) {
    await throwGoogleApiError(
      deleteRes,
      'Google Sheet থেকে সারি মোছা যায়নি'
    );
  }

  const vatTab = settings.separateVatTabName?.trim();
  const vatSheet = vatTab
    ? sheetProps.find((s) => s.title === vatTab)
    : undefined;
  if (vatSheet && (record.vatChallanNo || record.id)) {
    try {
      const vatRows = await fetchSheetValues(sheetId, `${vatTab}!A:I`, token);
      const vatNo = cleanChallanNo(record.vatChallanNo);
      const vatMatches: number[] = [];
      vatRows.forEach((r, i) => {
        if (
          i > 0 &&
          ((record.id && String(r[0] || '').trim() === record.id) ||
            (vatNo && r[5] && cleanChallanNo(String(r[5])) === vatNo))
        ) {
          vatMatches.push(i);
        }
      });
      if (vatMatches.length > 0) {
        const vatDesc = vatMatches.sort((a, b) => b - a);
        await fetch(
          `${SHEETS_API}/${encodeURIComponent(sheetId)}:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              requests: vatDesc.map((vatIdx) => ({
                deleteDimension: {
                  range: {
                    sheetId: vatSheet.sheetId,
                    dimension: 'ROWS',
                    startIndex: vatIdx,
                    endIndex: vatIdx + 1,
                  },
                },
              })),
            }),
          }
        );
      }
    } catch {
      // Optional VAT log delete is best-effort
    }
  }

  // Also sync Challan_Deleted_Log and purge Challan_Safe_Snapshot so snapshot guard won't restore deleted rows
  const delBaseId = getCleanBaseRecordId(entry.id || '');
  const delSrcId = String(entry.srcRecordId || '').trim();
  const delMain = cleanChallanNo(entry.challanNo || '');
  const delTax = cleanChallanNo(entry.incomeTaxChallanNo || '');
  const delVat = cleanChallanNo(entry.vatChallanNo || '');
  const delLogSheet = sheetProps.find((s) => s.title === 'Challan_Deleted_Log');
  if (delLogSheet && (delBaseId || delSrcId || delMain || delTax || delVat)) {
    try {
      await fetch(
        `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(
          'Challan_Deleted_Log!A:F'
        )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            values: [
              [
                new Date().toISOString(),
                delBaseId,
                delSrcId,
                delMain,
                delTax,
                delVat,
              ],
            ],
          }),
        }
      );
    } catch {
      // best-effort log update
    }
  }

  const snapSheet = sheetProps.find((s) => s.title === 'Challan_Safe_Snapshot');
  if (snapSheet) {
    try {
      const snapRows = await fetchSheetValues(
        sheetId,
        'Challan_Safe_Snapshot!A:F',
        token
      );
      const snapDesc: number[] = [];
      for (let i = 1; i < snapRows.length; i++) {
        const sr = snapRows[i] || [];
        const sId = getCleanBaseRecordId(String(sr[1] || ''));
        const sSrc = String(sr[2] || '').trim();
        const sm = cleanChallanNo(String(sr[3] || ''));
        const st = cleanChallanNo(String(sr[4] || ''));
        const sv = cleanChallanNo(String(sr[5] || ''));
        const hit =
          (delBaseId && sId === delBaseId) ||
          (delSrcId && sSrc === delSrcId) ||
          (delMain && (sm === delMain || st === delMain || sv === delMain)) ||
          (delTax && (sm === delTax || st === delTax || sv === delTax)) ||
          (delVat && (sm === delVat || st === delVat || sv === delVat));
        if (hit) snapDesc.push(i);
      }
      if (snapDesc.length > 0) {
        snapDesc.sort((a, b) => b - a);
        await fetch(`${SHEETS_API}/${encodeURIComponent(sheetId)}:batchUpdate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requests: snapDesc.map((rowIdx) => ({
              deleteDimension: {
                range: {
                  sheetId: snapSheet.sheetId,
                  dimension: 'ROWS',
                  startIndex: rowIdx,
                  endIndex: rowIdx + 1,
                },
              },
            })),
          }),
        });
      }
    } catch {
      // best-effort snapshot cleanup
    }
  }

  return { deleted: true, rowNumber: sortedDesc[sortedDesc.length - 1] };
}

interface LogicalSheetGroup {
  firstOrder: number;
  baseId: string;
  srcId: string;
  allocId: string;
  licenseNo: string;
  category: string;
  dateYm: string;
  mainRow?: string[];
  taxRow?: string[];
  vatRow?: string[];
  entryOverride?: SheetChallanEntry;
}

function canonicalizeSheetRowsForPairedLayout(
  settings: AppSettings,
  existingRows: string[][],
  entriesToUpsert: SheetChallanEntry[] = []
): {
  outputRows: string[][];
  removedCount: number;
  mergedCount: number;
  updatedEntries: number;
  appendedEntries: number;
  changed: boolean;
} {
  const dataRows = existingRows.slice(1);
  const groups: LogicalSheetGroup[] = [];
  const byBaseId = new Map<string, number>();
  const bySrcId = new Map<string, number>();
  const byNum = new Map<string, number>();
  const byAllocMonth = new Map<string, number>();
  const byLicMonth = new Map<string, number>();

  const registerGroupKeys = (gIdx: number, g: LogicalSheetGroup) => {
    if (g.baseId) byBaseId.set(g.baseId, gIdx);
    if (g.srcId) bySrcId.set(g.srcId, gIdx);
    if (g.allocId) byAllocMonth.set(`${g.allocId}|${g.dateYm || ''}`, gIdx);
    if (g.licenseNo && g.category) {
      byLicMonth.set(`${g.licenseNo}|${g.category}|${g.dateYm || ''}`, gIdx);
    }
  };

  const registerNums = (gIdx: number, row: string[], role: SheetSubRowRole) => {
    const rM = cleanChallanNo(String(row[7] || ''));
    const rT = cleanChallanNo(String(row[12] || ''));
    const rV = cleanChallanNo(String(row[18] || ''));
    if (rM && role === 'main') byNum.set(rM, gIdx);
    if (rT) byNum.set(rT, gIdx);
    else if (rM && role === 'tax') byNum.set(rM, gIdx);
    if (rV) byNum.set(rV, gIdx);
    else if (rM && role === 'vat') byNum.set(rM, gIdx);
  };

  // Process primary rows first, then ch-ext- shadow rows
  const order = dataRows
    .map((r, idx) => ({
      idx,
      isExt: /^ch-ext-/i.test(String(r?.[0] || '').trim()) ? 1 : 0,
    }))
    .sort((a, b) => (a.isExt !== b.isExt ? a.isExt - b.isExt : a.idx - b.idx));

  let removedCount = 0;

  for (const item of order) {
    const r = (dataRows[item.idx] || []).map((v) => String(v ?? ''));
    const rId = String(r[0] || '').trim();
    const rBaseId = !item.isExt ? getCleanBaseRecordId(rId) : '';
    const rSrcId = getRowSrcId(r);
    const rAlloc = String(r[6] || '').trim();
    const rLic = String(r[21] || '').trim();
    const rCat = String(r[3] || '').trim();
    const rDateYm = getYearMonthKey(getRowEffectiveDate(r));
    const role = classifySheetSubRowRole(r);

    const rawM = String(r[7] || '').trim();
    const rM = cleanChallanNo(rawM);
    const rT = cleanChallanNo(String(r[12] || ''));
    const rV = cleanChallanNo(String(r[18] || ''));

    if (!rId && !rM && !rT && !rV) {
      removedCount++;
      continue;
    }
    if (item.isExt && (rawM === '11' || !rM)) {
      removedCount++;
      continue;
    }

    let gIdx: number | undefined;
    if (!item.isExt && rBaseId && byBaseId.has(rBaseId)) gIdx = byBaseId.get(rBaseId);
    else if (rSrcId && bySrcId.has(rSrcId)) gIdx = bySrcId.get(rSrcId);
    else if (rM && byNum.has(rM)) gIdx = byNum.get(rM);
    else if (rT && byNum.has(rT)) gIdx = byNum.get(rT);
    else if (rV && byNum.has(rV)) gIdx = byNum.get(rV);
    else if (rAlloc && byAllocMonth.has(`${rAlloc}|${rDateYm || ''}`)) {
      gIdx = byAllocMonth.get(`${rAlloc}|${rDateYm || ''}`);
    } else if (
      !rDateYm &&
      rAlloc
    ) {
      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].allocId === rAlloc) {
          gIdx = gi;
          break;
        }
      }
    } else if (
      rLic &&
      rCat &&
      byLicMonth.has(`${rLic}|${rCat}|${rDateYm || ''}`)
    ) {
      gIdx = byLicMonth.get(`${rLic}|${rCat}|${rDateYm || ''}`);
    }

    // Check slot compatibility when matching by allocation/license across non-ext rows
    if (gIdx !== undefined && !item.isExt) {
      const g = groups[gIdx];
      if (role === 'main' && g.mainRow) {
        const gm = cleanChallanNo(String(g.mainRow[7] || ''));
        if (gm && rM && gm !== rM && g.baseId !== rBaseId && g.srcId !== rSrcId) {
          gIdx = undefined;
        }
      }
    }

    if (gIdx === undefined) {
      const newGroup: LogicalSheetGroup = {
        firstOrder: item.idx,
        baseId: rBaseId || `CHL-${Date.now()}-${item.idx}`,
        srcId: rSrcId,
        allocId: rAlloc,
        licenseNo: rLic,
        category: rCat,
        dateYm: rDateYm,
      };
      if (role === 'tax') newGroup.taxRow = r;
      else if (role === 'vat') newGroup.vatRow = r;
      else newGroup.mainRow = r;

      const idxNew = groups.length;
      groups.push(newGroup);
      registerGroupKeys(idxNew, newGroup);
      registerNums(idxNew, r, role);
    } else {
      const g = groups[gIdx];
      if (item.idx < g.firstOrder) g.firstOrder = item.idx;
      if (!g.srcId && rSrcId) g.srcId = rSrcId;
      if (!g.allocId && rAlloc) g.allocId = rAlloc;
      if (!g.dateYm && rDateYm) g.dateYm = rDateYm;
      if (item.isExt) {
        removedCount++;
        const destTax = g.taxRow || g.mainRow || [];
        if (role === 'vat') {
          const vatDest = g.vatRow || new Array(27).fill('');
          if (!vatDest[18] && rM) vatDest[18] = rM;
          if (!vatDest[19] && (r[19] || r[8] || r[1])) {
            vatDest[19] = r[19] || r[8] || r[1] || '';
          }
          if (!vatDest[20] && (r[20] || r[11])) vatDest[20] = r[20] || r[11] || '';
          g.vatRow = vatDest;
        } else {
          if (!destTax[12] && rM) destTax[12] = rM;
          if (!destTax[13] && (r[13] || r[8] || r[1])) {
            destTax[13] = r[13] || r[8] || r[1] || '';
          }
          if (!destTax[14] && (r[14] || r[11])) destTax[14] = r[14] || r[11] || '';
          if (g.taxRow) g.taxRow = destTax;
          else if (g.mainRow) g.mainRow = destTax;
        }
      } else if (role === 'tax') {
        if (!g.taxRow) {
          g.taxRow = r;
        } else {
          removedCount++;
          for (let c = 0; c < r.length; c++) {
            if (!String(g.taxRow[c] || '').trim() && String(r[c] || '').trim()) {
              g.taxRow[c] = r[c];
            }
          }
        }
      } else if (role === 'vat') {
        if (!g.vatRow) {
          g.vatRow = r;
        } else {
          removedCount++;
          for (let c = 0; c < r.length; c++) {
            if (!String(g.vatRow[c] || '').trim() && String(r[c] || '').trim()) {
              g.vatRow[c] = r[c];
            }
          }
        }
      } else {
        if (!g.mainRow) {
          g.mainRow = r;
        } else {
          removedCount++;
          for (let c = 0; c < r.length; c++) {
            if (!String(g.mainRow[c] || '').trim() && String(r[c] || '').trim()) {
              g.mainRow[c] = r[c];
            }
          }
        }
      }
      registerGroupKeys(gIdx, g);
      registerNums(gIdx, r, role);
    }
  }

  let updatedEntries = 0;
  let appendedEntries = 0;

  for (const entry of entriesToUpsert) {
    const eMain = cleanChallanNo(entry.challanNo);
    const eTax = cleanChallanNo(entry.incomeTaxChallanNo);
    const eVat = cleanChallanNo(entry.vatChallanNo);
    const eBaseId = getCleanBaseRecordId(entry.id);
    const eDateYm = getYearMonthKey(
      entry.date || entry.challanDate || entry.incomeTaxDate || entry.vatDate || ''
    );

    let gIdx: number | undefined;
    if (entry.srcRecordId && bySrcId.has(entry.srcRecordId)) {
      gIdx = bySrcId.get(entry.srcRecordId);
    } else if (eBaseId && byBaseId.has(eBaseId)) {
      gIdx = byBaseId.get(eBaseId);
    } else if (eMain && byNum.has(eMain)) {
      gIdx = byNum.get(eMain);
    } else if (eTax && byNum.has(eTax)) {
      gIdx = byNum.get(eTax);
    } else if (eVat && byNum.has(eVat)) {
      gIdx = byNum.get(eVat);
    } else if (
      entry.dealerAllocationId &&
      byAllocMonth.has(`${entry.dealerAllocationId}|${eDateYm || ''}`)
    ) {
      gIdx = byAllocMonth.get(`${entry.dealerAllocationId}|${eDateYm || ''}`);
    } else if (
      entry.licenseNo &&
      entry.category &&
      byLicMonth.has(`${entry.licenseNo}|${entry.category}|${eDateYm || ''}`)
    ) {
      gIdx = byLicMonth.get(
        `${entry.licenseNo}|${entry.category}|${eDateYm || ''}`
      );
    }

    if (gIdx !== undefined) {
      groups[gIdx].entryOverride = entry;
      updatedEntries++;
    } else {
      const newGroup: LogicalSheetGroup = {
        firstOrder: dataRows.length + groups.length,
        baseId: eBaseId || entry.id,
        srcId: entry.srcRecordId || '',
        allocId: entry.dealerAllocationId || '',
        licenseNo: entry.licenseNo || '',
        category: entry.category || '',
        dateYm: eDateYm,
        entryOverride: entry,
      };
      const idxNew = groups.length;
      groups.push(newGroup);
      registerGroupKeys(idxNew, newGroup);
      if (eMain) byNum.set(eMain, idxNew);
      if (eTax) byNum.set(eTax, idxNew);
      if (eVat) byNum.set(eVat, idxNew);
      appendedEntries++;
    }
  }

  // Sort logical groups by earliest row index so relative document order is preserved while Main & Tax exchange into adjacent rows
  const orderedGroups = [...groups].sort((a, b) => a.firstOrder - b.firstOrder);

  const outputRows: string[][] = [];
  let mergedCount = 0;

  for (const g of orderedGroups) {
    if (g.entryOverride) {
      const built = buildSplitSheetRowsForEntry(
        settings,
        g.entryOverride,
        g.mainRow || [],
        g.taxRow || [],
        g.vatRow || []
      );
      for (const row of built.orderedRows) {
        outputRows.push(row.slice(0, 30));
      }
      continue;
    }

    const refRow = g.mainRow || g.taxRow || g.vatRow || [];
    const mainRowData = g.mainRow || [];
    const taxRowData = g.taxRow || [];
    const vatRowData = g.vatRow || [];
    const dummyEntry: SheetChallanEntry = {
      scanType: 'main',
      id: g.baseId,
      date: toSheetIsoDate(
        mainRowData[1] ||
          mainRowData[8] ||
          taxRowData[13] ||
          taxRowData[1] ||
          vatRowData[1] ||
          ''
      ),
      department: String(mainRowData[2] || '').trim(),
      taxDepartment: String(
        taxRowData[4] || taxRowData[2] || mainRowData[4] || ''
      ).trim(),
      category: String(refRow[3] || '').trim(),
      sourceMemo: String(
        taxRowData[4] || mainRowData[4] || ''
      ).trim(),
      dcMemo: String(refRow[5] || '').trim(),
      dealerAllocationId: String(refRow[6] || '').trim(),
      challanNo: cleanChallanNo(mainRowData[7] || ''),
      challanDate: toSheetIsoDate(mainRowData[8] || mainRowData[1] || ''),
      rate: String(mainRowData[9] || refRow[9] || '').trim(),
      quantity: String(mainRowData[10] || refRow[10] || '').trim(),
      totalAmount: String(mainRowData[11] || '').trim(),
      incomeTaxChallanNo: cleanChallanNo(
        taxRowData[12] || taxRowData[7] || mainRowData[12] || ''
      ),
      incomeTaxDate: toSheetIsoDate(
        taxRowData[13] || taxRowData[8] || taxRowData[1] || mainRowData[13] || ''
      ),
      incomeTaxAmount: String(
        taxRowData[14] || taxRowData[11] || mainRowData[14] || ''
      ).trim(),
      vatChallanNo: cleanChallanNo(
        vatRowData[18] || vatRowData[7] || mainRowData[18] || ''
      ),
      vatDate: toSheetIsoDate(
        vatRowData[19] || vatRowData[8] || vatRowData[1] || mainRowData[19] || ''
      ),
      vatAmount: String(
        vatRowData[20] || vatRowData[11] || mainRowData[20] || ''
      ).trim(),
      licenseNo: String(refRow[21] || '').trim(),
      new37Code: String(mainRowData[22] || '').trim(),
      taxCode: String(taxRowData[25] || taxRowData[22] || mainRowData[25] || '').trim(),
      vatCode: String(vatRowData[26] || vatRowData[22] || mainRowData[26] || '').trim(),
      comment: String(mainRowData[15] || '').trim(),
      taxComment: String(
        (ISO_TS_REGEX.test(String(taxRowData[16] || '').trim())
          ? ''
          : taxRowData[16]) ||
          taxRowData[15] ||
          (ISO_TS_REGEX.test(String(mainRowData[16] || '').trim())
            ? ''
            : mainRowData[16]) ||
          ''
      ).trim(),
      taxExtra: String(taxRowData[24] || mainRowData[24] || '').trim(),
      createdAt: String(
        (ISO_TS_REGEX.test(String(refRow[17] || '').trim()) ? refRow[17] : '') ||
          new Date().toISOString()
      ).trim(),
      srcRecordId: g.srcId,
      overwrite: false,
    };

    const built = buildSplitSheetRowsForEntry(
      settings,
      dummyEntry,
      mainRowData,
      taxRowData,
      vatRowData
    );
    if (built.orderedRows.length > (g.mainRow ? 1 : 0) + (g.taxRow ? 1 : 0) + (g.vatRow ? 1 : 0)) {
      mergedCount++;
    }
    for (const row of built.orderedRows) {
      outputRows.push(row.slice(0, 30));
    }
  }

  const changed =
    outputRows.length !== dataRows.length ||
    outputRows.some((r, idx) => {
      const oldR = dataRows[idx] || [];
      const len = Math.max(r.length, oldR.length);
      for (let c = 0; c < len; c++) {
        if (String(r[c] ?? '') !== String(oldR[c] ?? '')) return true;
      }
      return false;
    });

  return {
    outputRows,
    removedCount,
    mergedCount,
    updatedEntries,
    appendedEntries,
    changed,
  };
}

async function rewriteChallanSheetRowsOAuth(
  sheetId: string,
  targetSheetId: number,
  tab: string,
  token: string,
  oldDataRowCount: number,
  outputRows: string[][]
): Promise<void> {
  if (outputRows.length > 0) {
    const putRes = await fetch(
      `${SHEETS_API}/${encodeURIComponent(
        sheetId
      )}/values/${encodeURIComponent(
        `${tab}!A2:AD${outputRows.length + 1}`
      )}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: outputRows }),
      }
    );
    if (!putRes.ok) {
      await throwGoogleApiError(putRes, 'Google Sheet সারি আপডেট ব্যর্থ');
    }
  }

  if (oldDataRowCount > outputRows.length) {
    const delRes = await fetch(
      `${SHEETS_API}/${encodeURIComponent(sheetId)}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: targetSheetId,
                  dimension: 'ROWS',
                  startIndex: outputRows.length + 1,
                  endIndex: oldDataRowCount + 1,
                },
              },
            },
          ],
        }),
      }
    );
    if (!delRes.ok) {
      await throwGoogleApiError(
        delRes,
        'Google Sheet অতিরিক্ত সারি মোছা ব্যর্থ'
      );
    }
  }

  if (outputRows.length > 0) {
    await formatSheetDateColumns(
      sheetId,
      tab,
      token,
      2,
      outputRows.length + 1,
      [1, 8, 13, 19]
    );
  }
}

async function ensureSheetTaxCommentHeaderOAuth(
  sheetId: string,
  tab: string,
  token: string,
  headerRow: string[],
  settings: AppSettings
): Promise<void> {
  const customColSet = new Set(
    (settings.customColumns || [])
      .map((c) => colLetterToIndex(c.sheetColumn))
      .filter((n) => n >= 0)
  );
  const targetHeaders: Array<[number, string]> = [
    [16, 'taxComment'],
    [17, 'createdAt'],
    [18, 'vatChallanNo'],
    [19, 'vatDate'],
    [20, 'vatAmount'],
    [21, 'licenseNo'],
    [22, 'new37Code'],
    [23, 'srcRecordId'],
    [24, 'taxExtra'],
    [25, 'taxCode'],
    [26, 'vatCode'],
  ];
  const curQ = String(headerRow[16] || '').trim().toLowerCase();
  const curR = String(headerRow[17] || '').trim();
  const needsUpgrade =
    !curQ ||
    (curQ === 'createdat' && !curR) ||
    !String(headerRow[22] || '').trim();
  if (!needsUpgrade) return;

  const updated = [...headerRow];
  while (updated.length < 27) updated.push('');
  let changed = false;
  for (const [idx, label] of targetHeaders) {
    if (customColSet.has(idx)) continue;
    const curVal = String(updated[idx] || '').trim();
    if (!curVal || (idx === 16 && curVal.toLowerCase() === 'createdat')) {
      updated[idx] = label;
      changed = true;
    }
  }
  if (!changed) return;

  await fetch(
    `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(
      `${tab}!Q1:AA1`
    )}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [updated.slice(16, 27)] }),
    }
  ).catch(() => undefined);
}

async function batchPushChallansToGoogleSheetOAuth(
  settings: AppSettings,
  entries: SheetChallanEntry[]
): Promise<{ updated: number; appended: number }> {
  const token = getGoogleAccessToken();
  if (!token) {
    throw new Error('Google অ্যাকাউন্টে সাইন-ইন করা নেই।');
  }
  const sheetId = extractSpreadsheetId(settings.spreadsheetId);
  const tab = settings.challanTabName.trim() || 'Challan';
  const sheetProps = await getSpreadsheetSheetProperties(sheetId, token);
  const targetSheet = sheetProps.find((s) => s.title === tab);
  if (!targetSheet) {
    throw new Error(`Google Sheet-এ "${tab}" ট্যাবটি পাওয়া যায়নি।`);
  }

  const existingRows = await fetchSheetValues(sheetId, `${tab}!A:AD`, token);
  const canonical = canonicalizeSheetRowsForPairedLayout(
    settings,
    existingRows,
    entries
  );

  if (canonical.changed) {
    await rewriteChallanSheetRowsOAuth(
      sheetId,
      targetSheet.sheetId,
      tab,
      token,
      Math.max(0, existingRows.length - 1),
      canonical.outputRows
    );
  }
  await ensureSheetTaxCommentHeaderOAuth(
    sheetId,
    tab,
    token,
    existingRows[0] || [],
    settings
  );

  return {
    updated: canonical.updatedEntries,
    appended: canonical.appendedEntries,
  };
}

export async function pullFromAppsScriptBridge(
  gasWebAppUrl: string,
  settings?: AppSettings
): Promise<Partial<SheetSyncPayload>> {
  const res = await apiFetch('/api/gas-bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: gasWebAppUrl, action: 'syncAll' }),
  });
  const json = (await res.json()) as {
    success: boolean;
    message?: string;
    data?: Partial<SheetSyncPayload> & {
      tabs?: {
        challan?: string[][];
        suballocations?: string[][];
        foodDealers?: string[][];
        omsDealers?: string[][];
        doIssues?: string[][];
        deletedLog?: string[][];
      };
    };
  };
  if (!res.ok || !json.success) {
    throw new Error(
      json.message || 'Apps Script ব্রিজ থেকে তথ্য আনা যায়নি।'
    );
  }
  const raw = json.data || {};
  if (raw.tabs) {
    const tabsList = Array.isArray(raw.availableTabs) ? raw.availableTabs : [];
    const hasFoodTab =
      Array.isArray(raw.tabs.foodDealers) &&
      (raw.tabs.foodDealers.length > 0 ||
        (settings?.foodDealerTabName &&
          tabsList.includes(settings.foodDealerTabName)));
    const hasOmsTab =
      Array.isArray(raw.tabs.omsDealers) &&
      (raw.tabs.omsDealers.length > 0 ||
        (settings?.omsDealerTabName &&
          tabsList.includes(settings.omsDealerTabName)));
    const hasSubTab =
      Array.isArray(raw.tabs.suballocations) &&
      (raw.tabs.suballocations.length > 0 ||
        (settings?.suballocationTabName &&
          tabsList.includes(settings.suballocationTabName)));
    const doTabName = settings?.doIssueTabName?.trim() || 'DO_Issue';
    const hasDoTab =
      Array.isArray(raw.tabs.doIssues) &&
      (raw.tabs.doIssues.length > 0 || tabsList.includes(doTabName));
    const hasChallanTab =
      Array.isArray(raw.tabs.challan) &&
      (raw.tabs.challan.length > 0 ||
        (settings?.challanTabName &&
          tabsList.includes(settings.challanTabName)));

    const dealersList: DealerRecord[] = [];
    if (hasFoodTab && raw.tabs.foodDealers) {
      dealersList.push(
        ...parseDealersFromRows(raw.tabs.foodDealers, 'খাদ্য বান্ধব')
      );
    }
    if (hasOmsTab && raw.tabs.omsDealers) {
      dealersList.push(
        ...parseDealersFromRows(raw.tabs.omsDealers, 'ওএমএস সাধারণ')
      );
    }
    const suballocations =
      hasSubTab && raw.tabs.suballocations
        ? parseSuballocationsFromRows(raw.tabs.suballocations)
        : null;
    const doIssues =
      hasDoTab && raw.tabs.doIssues
        ? parseDoIssuesFromRows(raw.tabs.doIssues)
        : null;
    const fallbackSettings =
      settings ||
      ({
        customColumns: [],
      } as unknown as AppSettings);
    const extShadowCount =
      hasChallanTab && raw.tabs.challan
        ? raw.tabs.challan
            .slice(1)
            .filter((r) => /^ch-ext-/i.test(String(r?.[0] || '').trim())).length
        : 0;
    const challans =
      hasChallanTab && raw.tabs.challan
        ? parseChallansFromRows(
            raw.tabs.challan,
            dealersList,
            fallbackSettings,
            suballocations || [],
            doIssues || []
          )
        : null;
    const deletedChallanLogs = Array.isArray(raw.tabs.deletedLog)
      ? parseDeletedChallanLogsFromRows(raw.tabs.deletedLog)
      : [];
    return {
      dealers: hasFoodTab || hasOmsTab ? dealersList : null,
      suballocations,
      doIssues,
      challans,
      challansVerified: Boolean(hasChallanTab && raw.tabs.challan),
      reconcileMissing: Boolean(
        hasChallanTab &&
          raw.tabs.challan &&
          (raw.tabs.challan.length > 1 || deletedChallanLogs.length > 0)
      ),
      deletedChallanLogs,
      extShadowCount,
      availableTabs: tabsList,
    };
  }
  return raw;
}

export async function pushToAppsScriptBridge(
  gasWebAppUrl: string,
  payload: Record<string, unknown>,
  action:
    | 'saveChallan'
    | 'saveChallanBatch'
    | 'editChallan'
    | 'deleteChallan'
    | 'dedupeSheet'
    | 'dedupeChallan'
    | 'fixDates' = 'saveChallan'
): Promise<{
  message?: string;
  updated?: number;
  appended?: number;
  blocked?: number;
  deleted?: boolean;
  removed?: number;
  removedCount?: number;
  fixedCount?: number;
  swappedCount?: number;
  merged?: number;
}> {
  const res = await apiFetch('/api/gas-bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: gasWebAppUrl, action, payload }),
  });
  const json = (await res.json()) as {
    success: boolean;
    message?: string;
    data?: {
      message?: string;
      updated?: number;
      appended?: number;
      blocked?: number;
      deleted?: boolean;
      removed?: number;
      removedCount?: number;
      fixedCount?: number;
      swappedCount?: number;
      merged?: number;
    };
  };
  if (!res.ok || !json.success) {
    throw new Error(
      json.message || 'Apps Script ব্রিজে তথ্য পাঠানো যায়নি।'
    );
  }
  return json.data || { message: json.message };
}

export async function dedupeSheetViaAppsScript(
  gasWebAppUrl: string
): Promise<{ message: string; removedCount?: number; fixedCount?: number }> {
  const res = await pushToAppsScriptBridge(
    gasWebAppUrl,
    {},
    'dedupeChallan'
  );
  const removed = Number(res.removedCount ?? res.removed ?? 0);
  return {
    message:
      res.message ||
      `শিট ডুপ্লিকেট পরিষ্কার সম্পন্ন (বাদ: ${removed}টি)`,
    removedCount: removed,
    fixedCount: res.fixedCount,
  };
}

export async function fixDatesViaAppsScript(
  gasWebAppUrl: string,
  options: { allowedMonths?: string[]; sortOrder?: 'asc' | 'desc' | 'none' } = {}
): Promise<{ message: string; fixedCount?: number; swappedCount?: number }> {
  const res = await pushToAppsScriptBridge(
    gasWebAppUrl,
    options as Record<string, unknown>,
    'fixDates'
  );
  return {
    message:
      res.message ||
      `শিটের তারিখ সংশোধন সম্পন্ন (${res.fixedCount ?? 0}টি)।`,
    fixedCount: res.fixedCount,
    swappedCount: res.swappedCount,
  };
}

export interface SheetPushSummary {
  total: number;
  oauthUpdated: number;
  oauthAppended: number;
  gasPushed: number;
  notes: string[];
}

export async function pushRecordsToGoogleSheet(
  settings: AppSettings,
  records: ChallanRecord[],
  onProgress?: (done: number, total: number) => void,
  options?: { overwrite?: boolean; matchHints?: SheetMatchHints }
): Promise<SheetPushSummary> {
  if (records.length === 0) {
    throw new Error('শিটে পাঠানোর জন্য কোনো চালান রেকর্ড নেই।');
  }
  const cap = getSheetPushCapability(settings);
  if (!cap.anyReady) {
    throw new Error(
      'Google Sheet-এ পুশ করার জন্য আগে Google অ্যাকাউন্টে সাইন-ইন অথবা সঠিক Apps Script Web App URL যুক্ত করুন।'
    );
  }

  const rawEntries = records.map((r) => challanRecordToSheetEntry(r, options));
  const dedupedEntries: SheetChallanEntry[] = [];
  const seenIds = new Set<string>();
  const seenSrcIds = new Set<string>();
  const seenMainNos = new Set<string>();
  const seenTaxNos = new Set<string>();
  const seenVatNos = new Set<string>();

  const orderedForDedupe = [...rawEntries].sort((a, b) => {
    const scoreA =
      (a.challanNo ? 2 : 0) +
      (a.incomeTaxChallanNo ? 1 : 0) +
      (a.vatChallanNo ? 1 : 0);
    const scoreB =
      (b.challanNo ? 2 : 0) +
      (b.incomeTaxChallanNo ? 1 : 0) +
      (b.vatChallanNo ? 1 : 0);
    return scoreB - scoreA;
  });

  for (const e of orderedForDedupe) {
    const eid = String(e.id || '').trim();
    const esrc = String(e.srcRecordId || '').trim();
    const m = cleanChallanNo(e.challanNo);
    const t = cleanChallanNo(e.incomeTaxChallanNo);
    const v = cleanChallanNo(e.vatChallanNo);
    if (eid && !/^ch-ext-/i.test(eid) && seenIds.has(eid)) continue;
    if (esrc && seenSrcIds.has(esrc)) continue;
    if (m && seenMainNos.has(m)) continue;
    if (!m && t && seenTaxNos.has(t)) continue;
    if (!m && !t && v && seenVatNos.has(v)) continue;
    if (eid && !/^ch-ext-/i.test(eid)) seenIds.add(eid);
    if (esrc) seenSrcIds.add(esrc);
    if (m) seenMainNos.add(m);
    if (t) seenTaxNos.add(t);
    if (v) seenVatNos.add(v);
    dedupedEntries.push(e);
  }
  const entries = dedupedEntries;

  let oauthUpdated = 0;
  let oauthAppended = 0;
  let gasPushed = 0;
  const notes: string[] = [];
  const errors: string[] = [];

  if (cap.oauthReady) {
    try {
      if (entries.length === 1) {
        const r = await writeChallanToGoogleSheetOAuth(settings, entries[0]);
        if (r.mode === 'updated') oauthUpdated = 1;
        else oauthAppended = 1;
        notes.push(
          r.mode === 'updated'
            ? `Google Sheet সারি ${r.rowNumber} আপডেট`
            : `Google Sheet নতুন সারি ${r.rowNumber} যোগ`
        );
      } else {
        const res = await batchPushChallansToGoogleSheetOAuth(
          settings,
          entries
        );
        oauthUpdated = res.updated;
        oauthAppended = res.appended;
        notes.push(
          `Google OAuth: আপডেট ${res.updated}টি, নতুন যোগ ${res.appended}টি`
        );
      }
      onProgress?.(entries.length, entries.length);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (cap.gasReady && oauthUpdated + oauthAppended === 0) {
    const gasUrl = settings.gasWebAppUrl.trim();
    try {
      if (entries.length === 1) {
        const gasAction = options?.overwrite ? 'editChallan' : 'saveChallan';
        await pushToAppsScriptBridge(
          gasUrl,
          entries[0] as unknown as Record<string, unknown>,
          gasAction
        );
        gasPushed = 1;
        notes.push('Apps Script-এ সংরক্ষিত');
        onProgress?.(1, 1);
      } else {
        try {
          await pushToAppsScriptBridge(
            gasUrl,
            { entries },
            'saveChallanBatch'
          );
          gasPushed = entries.length;
          notes.push(`Apps Script: ${entries.length}টি পুশ সম্পন্ন`);
          onProgress?.(entries.length, entries.length);
        } catch (batchErr) {
          const msg = batchErr instanceof Error ? batchErr.message : '';
          if (msg.includes('Unknown action')) {
            throw batchErr;
          }
          for (let i = 0; i < entries.length; i++) {
            await pushToAppsScriptBridge(
              gasUrl,
              entries[i] as unknown as Record<string, unknown>,
              'saveChallan'
            );
            gasPushed++;
            onProgress?.(i + 1, entries.length);
          }
          notes.push(`Apps Script: ${gasPushed}টি পুশ সম্পন্ন`);
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const anySucceeded = oauthUpdated + oauthAppended > 0 || gasPushed > 0;
  if (!anySucceeded) {
    throw new Error(
      errors.join(' · ') || 'Google Sheet-এ কোনো তথ্য সংরক্ষণ করা যায়নি।'
    );
  }

  return {
    total: entries.length,
    oauthUpdated,
    oauthAppended,
    gasPushed,
    notes: [...notes, ...errors.map((e) => `সতর্কতা: ${e}`)],
  };
}

export async function updateChallanInGoogleSheet(
  settings: AppSettings,
  updatedRecord: ChallanRecord,
  previousRecord?: ChallanRecord | null
): Promise<SheetPushSummary> {
  const matchHints: SheetMatchHints | undefined = previousRecord
    ? {
        id: previousRecord.id,
        srcRecordId: previousRecord.recordId,
        challanNo: previousRecord.challanNo,
        incomeTaxChallanNo: previousRecord.incomeTaxChallanNo,
        vatChallanNo: previousRecord.vatChallanNo,
        dealerAllocationId: previousRecord.dealerAllocationId,
        licenseNo: previousRecord.licenseNo,
        category: previousRecord.challanCategory,
      }
    : undefined;

  return pushRecordsToGoogleSheet(settings, [updatedRecord], undefined, {
    overwrite: true,
    matchHints,
  });
}

export async function deleteChallanFromGoogleSheet(
  settings: AppSettings,
  record: ChallanRecord
): Promise<{
  oauthDeleted: boolean;
  gasDeleted: boolean;
  notes: string[];
}> {
  const cap = getSheetPushCapability(settings);
  if (!cap.anyReady) {
    throw new Error(
      'Google Sheet থেকে মুছতে আগে Google অ্যাকাউন্টে সাইন-ইন অথবা Apps Script Web App URL যুক্ত করুন।'
    );
  }

  let oauthDeleted = false;
  let gasDeleted = false;
  const notes: string[] = [];
  const errors: string[] = [];

  if (cap.oauthReady) {
    try {
      const res = await deleteChallanFromGoogleSheetOAuth(settings, record);
      oauthDeleted = true;
      notes.push(
        res.deleted
          ? `Google Sheet সারি ${res.rowNumber} মোছা হয়েছে`
          : 'Google Sheet-এ সারিটি পাওয়া যায়নি (হয়তো আগেই মোছা হয়েছে)'
      );
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (cap.gasReady) {
    try {
      const entry = challanRecordToSheetEntry(record);
      const res = await pushToAppsScriptBridge(
        settings.gasWebAppUrl.trim(),
        entry as unknown as Record<string, unknown>,
        'deleteChallan'
      );
      gasDeleted = true;
      if (!oauthDeleted) {
        notes.push(res.message || 'Apps Script দিয়ে শিট থেকে মোছা হয়েছে');
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (!oauthDeleted && !gasDeleted) {
    throw new Error(
      errors.join(' · ') || 'Google Sheet থেকে সারিটি মোছা যায়নি।'
    );
  }

  return {
    oauthDeleted,
    gasDeleted,
    notes: [...notes, ...errors.map((e) => `সতর্কতা: ${e}`)],
  };
}

export async function cleanupDuplicatesInGoogleSheet(
  settings: AppSettings
): Promise<{
  removedCount: number;
  mergedCount: number;
  keptCount: number;
  notes: string[];
}> {
  const cap = getSheetPushCapability(settings);
  if (!cap.anyReady) {
    throw new Error(
      'Google Sheet থেকে ডুপ্লিকেট সারি মুছতে আগে Google অ্যাকাউন্টে সাইন-ইন অথবা Apps Script Web App URL যুক্ত করুন।'
    );
  }

  const notes: string[] = [];

  if (cap.oauthReady) {
    const token = getGoogleAccessToken();
    if (!token) {
      throw new Error('Google অ্যাকাউন্টে সাইন-ইন করা নেই।');
    }
    const sheetId = extractSpreadsheetId(settings.spreadsheetId);
    if (!sheetId) {
      throw new Error('Spreadsheet ID সেট করা নেই।');
    }
    const tab = settings.challanTabName.trim() || 'Challan';
    const sheetProps = await getSpreadsheetSheetProperties(sheetId, token);
    const targetSheet = sheetProps.find((s) => s.title === tab);
    if (!targetSheet) {
      throw new Error(`Google Sheet-এ "${tab}" ট্যাবটি পাওয়া যায়নি।`);
    }

    const rows = await fetchSheetValues(sheetId, `${tab}!A:AD`, token);
    if (rows.length <= 1) {
      return {
        removedCount: 0,
        mergedCount: 0,
        keptCount: 0,
        notes: ['Google Sheet-এ কোনো ডেটা সারি পাওয়া যায়নি।'],
      };
    }

    const canonical = canonicalizeSheetRowsForPairedLayout(settings, rows);
    if (canonical.changed) {
      await rewriteChallanSheetRowsOAuth(
        sheetId,
        targetSheet.sheetId,
        tab,
        token,
        Math.max(0, rows.length - 1),
        canonical.outputRows
      );
    }
    await ensureSheetTaxCommentHeaderOAuth(
      sheetId,
      tab,
      token,
      rows[0] || [],
      settings
    );

    notes.push(
      canonical.changed
        ? `Google Sheet সাজানো সম্পন্ন: অতিরিক্ত সারি বাদ ${canonical.removedCount}টি, মূল ও আয়কর পাশাপাশি লাইনে মোট ${canonical.outputRows.length}টি সারি।`
        : 'Google Sheet-এ সব সারি আগেই সঠিকভাবে পাশাপাশি সাজানো আছে'
    );

    return {
      removedCount: canonical.removedCount,
      mergedCount: canonical.mergedCount,
      keptCount: canonical.outputRows.length,
      notes,
    };
  }

  const gasRes = await pushToAppsScriptBridge(
    settings.gasWebAppUrl.trim(),
    {},
    'dedupeChallan'
  );
  return {
    removedCount: Number(gasRes.removedCount ?? gasRes.removed ?? 0),
    mergedCount: Number(gasRes.merged ?? gasRes.fixedCount ?? 0),
    keptCount: 0,
    notes: [
      gasRes.message ||
        'Apps Script দিয়ে Google Sheet ডুপ্লিকেট পরিষ্কার সম্পন্ন',
    ],
  };
}

export function generateGoogleAppsScriptCode(settings: AppSettings): string {
  const spreadsheetId = extractSpreadsheetId(settings.spreadsheetId || '');
  const challanTab = settings.challanTabName?.trim() || 'Challan';
  const subTab =
    settings.suballocationTabName?.trim() || 'Dealer_Suballocation';
  const foodTab = settings.foodDealerTabName?.trim() || 'Food_Dealer';
  const omsTab = settings.omsDealerTabName?.trim() || 'OMS_Dealers';
  const doTab = settings.doIssueTabName?.trim() || 'DO_Issue';
  const vatTab = settings.separateVatTabName?.trim() || '';
  const customCols = (settings.customColumns || []).map((c) => ({
    id: c.id,
    label: c.label,
    colIndex: colLetterToIndex(c.sheetColumn),
  }));

  return `// Google Apps Script Web App Bridge & Dual-Row Paired Challan Guard (Code.gs)
// কোথায় বসাবেন: আপনার Google Sheet খুলুন > Extensions > Apps Script > Code.gs-এ পেস্ট করুন
// ডিপ্লয়: Deploy > New deployment (অথবা Manage deployments > New version) > Execute as: Me | Who has access: Anyone
//
// নতুন পাশাপাশি ২-লাইন নিয়ম (মূল + আয়কর):
// - প্রতিটি বরাদ্দ/মাসের মূল চালান (১ম লাইন, Col H/I/L, Col M/N/O ফাঁকা) ও আয়কর চালান (ঠিক নিচের ২য় লাইন, id + "-TAX")
//   পাশাপাশি সারিতে সাজানো থাকবে। আগে বা পরে যেকোনো সময় স্ক্যান করলেও স্বয়ংক্রিয়ভাবে রো এক্সচেঞ্জ করে পাশাপাশি আসবে।
// - ২য় লাইনে মূল চালানের কলাম (Col H/I/J/K/L) ফাঁকা রেখে শুধুমাত্র আয়কর কলামে (Col M/N/O) আয়কর চালান ও টাকা থাকবে
//   যাতে অন্য অ্যাপ কখনো আয়করকে মূল চালান না ধরে এবং ডিও ইস্যুকালে Col M/N/O ও Col G থেকে নির্ভুলভাবে খুঁজে পায়।
// - স্বয়ংক্রিয় সুরক্ষা চালু করতে "installDuplicateGuardTrigger" বেছে Run দিন (১ বার অনুমোদন দিন)।

const SPREADSHEET_ID = ${JSON.stringify(spreadsheetId)};
const TAB_CHALLAN = ${JSON.stringify(challanTab)};
const TAB_SUBALLOC = ${JSON.stringify(subTab)};
const TAB_FOOD_DEALER = ${JSON.stringify(foodTab)};
const TAB_OMS_DEALER = ${JSON.stringify(omsTab)};
const TAB_DO_ISSUE = ${JSON.stringify(doTab)};
const TAB_VAT = ${JSON.stringify(vatTab)};
const TAB_DUP_BACKUP = 'Challan_Duplicate_Backup';
const TAB_SAFE_SNAPSHOT = 'Challan_Safe_Snapshot';
const TAB_DELETED_LOG = 'Challan_Deleted_Log';
const CUSTOM_COLS = ${JSON.stringify(customCols)};

function getTargetSpreadsheet() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function toAsciiDigits(val) {
  var bn = '০১২৩৪৫৬৭৮৯';
  return String(val == null ? '' : val).replace(/[০-৯]/g, function(ch) {
    var idx = bn.indexOf(ch);
    return idx >= 0 ? String(idx) : ch;
  });
}

function normChallan11(val) {
  var s = toAsciiDigits(val || '').replace(/\\s+/g, '').replace(/[–—]/g, '-').trim();
  if (!s) return '';
  var m = s.match(/^(\\d{4})-(\\d{10})$/);
  if (m) return m[1] + '-' + m[2] + '1';
  var digits = s.replace(/\\D/g, '');
  if (digits.length === 14) return digits.slice(0, 4) + '-' + digits.slice(4) + '1';
  if (digits.length === 15) return digits.slice(0, 4) + '-' + digits.slice(4);
  return s;
}

function cleanChallanNo_(val) {
  var s = normChallan11(val);
  if (!s) return '';
  var low = s.toLowerCase();
  if (low === '11' || low === '1' || low === '0' || low === '-' || low === 'n/a' || low === 'na' || low === 'null' || low === 'undefined') {
    return '';
  }
  var digits = s.replace(/\\D/g, '');
  if (digits.length < 5) return '';
  return s;
}

function cleanBaseId_(id) {
  return String(id || '').trim().replace(/-(?:TAX|VAT)$/i, '');
}

function toIsoSheetDate(val) {
  var s = toAsciiDigits(val).trim();
  if (!s) return '';
  var mIso = s.match(/^(\\d{4})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{1,2})(?:$|T|\\s)/);
  if (mIso) {
    return mIso[1] + '-' + ('0' + Number(mIso[2])).slice(-2) + '-' + ('0' + Number(mIso[3])).slice(-2);
  }
  var mDmy = s.match(/^(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{4}|\\d{2})$/);
  if (mDmy) {
    var p1 = Number(mDmy[1]);
    var p2 = Number(mDmy[2]);
    var yr = mDmy[3].length === 2 ? '20' + mDmy[3] : mDmy[3];
    var day = p1, mo = p2;
    if (p2 > 12 && p1 <= 12) {
      mo = p1; day = p2;
    }
    return yr + '-' + ('0' + mo).slice(-2) + '-' + ('0' + day).slice(-2);
  }
  return s;
}

function toSlashDate(val) {
  return toIsoSheetDate(val);
}

function getYearMonthKey_(val) {
  var iso = toIsoSheetDate(val || '');
  var m = iso.match(/^(\\d{4})-(\\d{2})-\\d{2}$/);
  return m ? (m[1] + '-' + m[2]) : '';
}

function isSameYearMonth_(a, b) {
  var ya = getYearMonthKey_(a);
  var yb = getYearMonthKey_(b);
  if (!ya || !yb) return true;
  return ya === yb;
}

function areSwappedIsoDates_(a, b) {
  var ia = toIsoSheetDate(a);
  var ib = toIsoSheetDate(b);
  var ma = ia.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
  var mb = ib.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
  if (!ma || !mb) return false;
  return ma[1] === mb[1] && ma[2] === mb[3] && ma[3] === mb[2] && ma[2] !== ma[3];
}

function getOrCreateSheet(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function isIsoTsVal(val) {
  return /^\\d{4}-\\d{2}-\\d{2}(?:T|\\s+\\d{2}:\\d{2})/.test(String(val || '').trim());
}

function getRowSrcId_(row) {
  var legacy17 = String(row[17] || '').trim();
  return String(row[23] || (!isIsoTsVal(legacy17) ? legacy17 : '') || '').trim();
}

function getRowEffectiveDate_(row) {
  return toIsoSheetDate(String(row[8] || row[13] || row[19] || row[1] || '').trim());
}

function classifyRowRole_(row) {
  var rId = String(row[0] || '').trim();
  var rM = cleanChallanNo_(row[7] || '');
  var rT = cleanChallanNo_(row[12] || '');
  var rV = cleanChallanNo_(row[18] || '');
  if (/-TAX$/i.test(rId) || /^ch-ext-t-/i.test(rId) || (!rM && rT) || (rM && rM === rT)) return 'tax';
  if (/-VAT$/i.test(rId) || /^ch-ext-v-/i.test(rId) || (!rM && !rT && rV) || (rM && rM === rV)) return 'vat';
  return 'main';
}

function getSlotLabelBn_(slot) {
  if (slot === 'tax') return 'আয়কর চালান (Col M)';
  if (slot === 'vat') return 'ভ্যাট চালান (Col S)';
  return 'মূল চালান (Col H)';
}

function buildGlobalChallanIndex_(values) {
  var index = {};
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var rId = String(r[0] || '').trim();
    if (/^ch-ext-/i.test(rId)) continue;
    var rowNum = i + 2;
    var role = classifyRowRole_(r);
    var rMain = cleanChallanNo_(r[7]);
    var rTax = cleanChallanNo_(r[12]);
    var rVat = cleanChallanNo_(r[18]);
    if (rTax && !index[rTax]) index[rTax] = { rowNumber: rowNum, slot: 'tax', id: rId };
    if (rVat && !index[rVat]) index[rVat] = { rowNumber: rowNum, slot: 'vat', id: rId };
    if (rMain && !index[rMain]) {
      index[rMain] = { rowNumber: rowNum, slot: role === 'tax' ? 'tax' : (role === 'vat' ? 'vat' : 'main'), id: rId };
    }
  }
  return index;
}

function findPairedRowsInSheet_(values, entry, strictDelete) {
  var hints = entry.matchHints || {};
  var eChallan = cleanChallanNo_(entry.challanNo || '');
  var eTaxNo = cleanChallanNo_(entry.incomeTaxChallanNo || '');
  var eVatNo = cleanChallanNo_(entry.vatChallanNo || '');
  var hChallan = cleanChallanNo_(hints.challanNo || '');
  var hTaxNo = cleanChallanNo_(hints.incomeTaxChallanNo || '');
  var hVatNo = cleanChallanNo_(hints.vatChallanNo || '');
  var eBaseId = cleanBaseId_(entry.id || '');
  var hBaseId = cleanBaseId_(hints.id || '');
  var eDateIso = toIsoSheetDate(entry.date || entry.challanDate || entry.incomeTaxDate || entry.vatDate || '');

  var matchedMap = {};

  function canMergeRole(r, role) {
    if (entry.overwrite || strictDelete) return true;
    var rM = cleanChallanNo_(r[7] || '');
    var rT = cleanChallanNo_(r[12] || '');
    var rV = cleanChallanNo_(r[18] || '');
    var effMain = role === 'main' ? rM : '';
    var effTax = role === 'tax' ? (rT || rM) : rT;
    var effVat = role === 'vat' ? (rV || rM) : rV;
    if (eChallan && effMain && effMain !== eChallan) return false;
    if (!eChallan && eTaxNo && effTax && effTax !== eTaxNo) return false;
    if (!eChallan && !eTaxNo && eVatNo && effVat && effVat !== eVatNo) return false;
    return true;
  }

  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var rId = String(r[0] || '').trim();
    var isExt = /^ch-ext-/i.test(rId);
    if (isExt && !strictDelete) continue;
    var rowNum = i + 2;
    var rBaseId = !isExt ? cleanBaseId_(rId) : '';
    var rSrc = getRowSrcId_(r);
    var rM = cleanChallanNo_(r[7] || '');
    var rT = cleanChallanNo_(r[12] || '');
    var rV = cleanChallanNo_(r[18] || '');
    var role = classifyRowRole_(r);
    var effM = role === 'main' ? rM : '';
    var effT = role === 'tax' ? (rT || rM) : rT;
    var effV = role === 'vat' ? (rV || rM) : rV;

    var hit = false;
    if (entry.srcRecordId && rSrc && rSrc === entry.srcRecordId) hit = true;
    else if (hints.srcRecordId && rSrc && rSrc === hints.srcRecordId) hit = true;
    else if (!isExt && eBaseId && rBaseId && rBaseId === eBaseId) hit = true;
    else if (!isExt && hBaseId && rBaseId && rBaseId === hBaseId) hit = true;
    else if (eChallan && effM && effM === eChallan) hit = true;
    else if (hChallan && effM && effM === hChallan) hit = true;
    else if (eTaxNo && effT && effT === eTaxNo) hit = true;
    else if (hTaxNo && effT && effT === hTaxNo) hit = true;
    else if (eVatNo && effV && effV === eVatNo) hit = true;
    else if (hVatNo && effV && effV === hVatNo) hit = true;

    if (hit) matchedMap[rowNum] = true;
  }

  if (!strictDelete) {
    for (var j = 0; j < values.length; j++) {
      var r2 = values[j];
      var r2Id = String(r2[0] || '').trim();
      if (/^ch-ext-/i.test(r2Id)) continue;
      var rn2 = j + 2;
      if (matchedMap[rn2]) continue;
      var r2Cat = String(r2[3] || '').trim();
      var r2Alloc = String(r2[6] || '').trim();
      var r2Lic = String(r2[21] || '').trim();
      var r2Comment = String(r2[15] || '').trim();
      var r2DateIso = getRowEffectiveDate_(r2);
      var r2Role = classifyRowRole_(r2);
      if (!canMergeRole(r2, r2Role)) continue;
      var sameMo = !eDateIso || !r2DateIso || isSameYearMonth_(eDateIso, r2DateIso);
      if (entry.dealerAllocationId && r2Alloc === entry.dealerAllocationId && sameMo) {
        matchedMap[rn2] = true;
      } else if (entry.licenseNo && r2Lic === entry.licenseNo && (!entry.category || r2Cat === entry.category) && sameMo) {
        matchedMap[rn2] = true;
      } else if (entry.dealerName && entry.category && r2Cat === entry.category && r2Comment.indexOf(entry.dealerName) !== -1 && eDateIso && r2DateIso && isSameYearMonth_(eDateIso, r2DateIso)) {
        matchedMap[rn2] = true;
      }
    }
  }

  var allIndices = Object.keys(matchedMap).map(Number).sort(function(a, b) { return a - b; });
  if (allIndices.length > 0) {
    var grpBase = {}, grpSrc = {};
    for (var m = 0; m < allIndices.length; m++) {
      var rowObj = values[allIndices[m] - 2] || [];
      var oid = String(rowObj[0] || '').trim();
      if (!/^ch-ext-/i.test(oid) && oid) grpBase[cleanBaseId_(oid)] = true;
      var osrc = getRowSrcId_(rowObj);
      if (osrc) grpSrc[osrc] = true;
    }
    for (var k = 0; k < values.length; k++) {
      var rn = k + 2;
      if (matchedMap[rn]) continue;
      var rk = values[k];
      var rkid = String(rk[0] || '').trim();
      var rksrc = getRowSrcId_(rk);
      var rkbase = !/^ch-ext-/i.test(rkid) ? cleanBaseId_(rkid) : '';
      if ((rksrc && grpSrc[rksrc]) || (rkbase && grpBase[rkbase])) {
        matchedMap[rn] = true;
      }
    }
    allIndices = Object.keys(matchedMap).map(Number).sort(function(a, b) { return a - b; });
  }

  var mainRowIndex = -1, taxRowIndex = -1, vatRowIndex = -1;
  for (var x = 0; x < allIndices.length; x++) {
    var rowNumX = allIndices[x];
    var roleX = classifyRowRole_(values[rowNumX - 2] || []);
    if (roleX === 'tax' && taxRowIndex < 0) taxRowIndex = rowNumX;
    else if (roleX === 'vat' && vatRowIndex < 0) vatRowIndex = rowNumX;
    else if (roleX === 'main' && mainRowIndex < 0) mainRowIndex = rowNumX;
  }
  return { mainRowIndex: mainRowIndex, taxRowIndex: taxRowIndex, vatRowIndex: vatRowIndex, allIndices: allIndices };
}

function applyCustomColsToGasRow_(row, fields, cur, ow) {
  for (var c = 0; c < CUSTOM_COLS.length; c++) {
    var colDef = CUSTOM_COLS[c];
    if (colDef.colIndex >= 0) {
      while (row.length <= colDef.colIndex) row.push('');
      var val = fields && fields[colDef.id];
      if (ow) row[colDef.colIndex] = val || '';
      else if (val) row[colDef.colIndex] = val;
      else if (cur && cur[colDef.colIndex]) row[colDef.colIndex] = cur[colDef.colIndex];
    }
  }
}

function buildPairedRows_(entry, curMain, curTax, curVat) {
  curMain = curMain || [];
  curTax = curTax || [];
  curVat = curVat || [];
  var ow = Boolean(entry.overwrite);
  var eChallan = cleanChallanNo_(entry.challanNo || '');
  var eTax = cleanChallanNo_(entry.incomeTaxChallanNo || '');
  var eVat = cleanChallanNo_(entry.vatChallanNo || '');

  var curMainRole = curMain.length > 0 ? classifyRowRole_(curMain) : 'main';
  var curMainNo = curMainRole === 'main' ? cleanChallanNo_(curMain[7] || '') : '';
  var curTaxNo = cleanChallanNo_(curTax[12] || curTax[7] || curMain[12] || '');
  var curVatNo = cleanChallanNo_(curVat[18] || curVat[7] || curMain[18] || '');

  var finalMain = ow ? eChallan : (eChallan || curMainNo || '');
  var finalTax = ow ? eTax : (eTax || curTaxNo || '');
  var finalVat = ow ? eVat : (eVat || curVatNo || '');

  var mainAmt = ow ? (entry.totalAmount || '') : (entry.totalAmount || curMain[11] || '');
  var taxAmt = ow ? (entry.incomeTaxAmount || '') : (entry.incomeTaxAmount || curTax[14] || curTax[11] || curMain[14] || '');
  var vatAmt = ow ? (entry.vatAmount || '') : (entry.vatAmount || curVat[20] || curVat[11] || curMain[20] || '');

  var hasMain = Boolean(finalMain || mainAmt);
  var hasTax = Boolean(finalTax || taxAmt);
  var hasVat = Boolean(finalVat || vatAmt);

  var maxCustomIdx = -1;
  var hasCustom23 = false, hasCustom24 = false, hasCustom25 = false, hasCustom26 = false;
  for (var cc = 0; cc < CUSTOM_COLS.length; cc++) {
    var ci = CUSTOM_COLS[cc].colIndex;
    if (ci > maxCustomIdx) maxCustomIdx = ci;
    if (ci === 23) hasCustom23 = true;
    if (ci === 24) hasCustom24 = true;
    if (ci === 25) hasCustom25 = true;
    if (ci === 26) hasCustom26 = true;
  }
  var width = Math.max(27, maxCustomIdx + 1);

  var rawBase = cleanBaseId_(curMain[0] || '') || cleanBaseId_(curTax[0] || '') || cleanBaseId_(curVat[0] || '') || cleanBaseId_(entry.id || '') || ('CHL-' + Date.now());
  var baseId = /^ch-ext-/i.test(rawBase) ? (cleanBaseId_(entry.id || '') || ('CHL-' + Date.now())) : rawBase;
  var srcRecordId = entry.srcRecordId || getRowSrcId_(curMain) || getRowSrcId_(curTax) || getRowSrcId_(curVat) || '';
  var isTaxOrVatScan = !ow && (entry.scanType === 'tax' || entry.scanType === 'vat');
  var colEVal = entry.taxDepartment || entry.sourceMemo || '';

  var isoMainDate = toIsoSheetDate(entry.challanDate || '');
  var isoEntryDate = toIsoSheetDate(entry.date || '');
  var isoTaxDate = ow
    ? toIsoSheetDate(entry.incomeTaxDate || entry.date || '')
    : (toIsoSheetDate(entry.incomeTaxDate || '') || toIsoSheetDate(curTax[13] || curTax[8] || curMain[13] || '') || curTax[13] || curMain[13] || isoEntryDate || isoMainDate || '');
  var isoVatDate = ow
    ? toIsoSheetDate(entry.vatDate || entry.date || '')
    : (toIsoSheetDate(entry.vatDate || '') || toIsoSheetDate(curVat[19] || curVat[8] || curMain[19] || '') || curVat[19] || curMain[19] || isoEntryDate || isoMainDate || '');

  function makeArr(cur) {
    var arr = new Array(width);
    for (var k = 0; k < width; k++) arr[k] = (cur && cur[k]) ? String(cur[k]) : '';
    return arr;
  }

  var ordered = [];

  if (hasMain || (!hasTax && !hasVat)) {
    var mRow = makeArr(curMain);
    var curColBIso = toIsoSheetDate(curMain[1] || '');
    var canonColB = ow
      ? (isoEntryDate || isoMainDate || curColBIso || curMain[1] || '')
      : ((curColBIso && !((isoMainDate && areSwappedIsoDates_(curColBIso, isoMainDate)) || (isoEntryDate && areSwappedIsoDates_(curColBIso, isoEntryDate))))
          ? curColBIso : (isoMainDate || isoEntryDate || curMain[1] || ''));
    var prevMCat = isIsoTsVal(curMain[17]) ? curMain[17] : (isIsoTsVal(curMain[16]) ? curMain[16] : '');

    mRow[0] = baseId;
    mRow[1] = canonColB;
    mRow[2] = ow ? (entry.department || '') : (isTaxOrVatScan ? (curMain[2] || '') : (entry.department || curMain[2] || ''));
    mRow[3] = ow ? (entry.category || '') : (entry.category || curMain[3] || curTax[3] || '');
    mRow[4] = hasTax ? (isTaxOrVatScan ? '' : ((colEVal === entry.taxDepartment) ? '' : (colEVal || curMain[4] || ''))) : (ow ? colEVal : (colEVal || curMain[4] || ''));
    mRow[5] = ow ? (entry.dcMemo || '') : (entry.dcMemo || curMain[5] || curTax[5] || '');
    mRow[6] = ow ? (entry.dealerAllocationId || '') : (entry.dealerAllocationId || curMain[6] || curTax[6] || '');
    mRow[7] = finalMain;
    mRow[8] = ow ? isoMainDate : (isoMainDate || toIsoSheetDate(curMain[8] || '') || curMain[8] || '');
    mRow[9] = ow ? (entry.rate || '') : (entry.rate || curMain[9] || '');
    mRow[10] = ow ? (entry.quantity || '') : (entry.quantity || curMain[10] || '');
    mRow[11] = mainAmt;
    mRow[12] = ''; mRow[13] = ''; mRow[14] = ''; mRow[16] = '';
    mRow[15] = ow ? (entry.comment || '') : (entry.comment || curMain[15] || '');
    mRow[17] = prevMCat || entry.createdAt || new Date().toISOString();
    mRow[18] = ''; mRow[19] = ''; mRow[20] = '';
    mRow[21] = ow ? (entry.licenseNo || '') : (entry.licenseNo || curMain[21] || curTax[21] || '');
    mRow[22] = ow ? (entry.new37Code || '') : (isTaxOrVatScan ? (curMain[22] || entry.new37Code || '') : (entry.new37Code || curMain[22] || ''));
    if (!hasCustom23 && (curMain[23] || srcRecordId)) mRow[23] = curMain[23] || srcRecordId;
    if (!hasCustom24) mRow[24] = '';
    if (!hasCustom25) mRow[25] = '';
    if (!hasCustom26) mRow[26] = '';
    var mCustom = (!isTaxOrVatScan ? entry.customFields : null);
    applyCustomColsToGasRow_(mRow, mCustom, curMain, ow && !isTaxOrVatScan);
    ordered.push(mRow);
  }

  if (hasTax) {
    var tRow = makeArr(curTax);
    var prevTComment = isIsoTsVal(curTax[16]) ? '' : (curTax[16] || curMain[16] || curTax[15] || '');
    var prevTCat = isIsoTsVal(curTax[17]) ? curTax[17] : (isIsoTsVal(curTax[16]) ? curTax[16] : '');
    var tDeptVal = ow ? colEVal : (colEVal || curTax[4] || curTax[2] || ((curMain[4] && curMain[4] !== entry.department) ? curMain[4] : '') || '');
    var defaultTaxRemark = (function() {
      var cat = String(entry.category || curTax[3] || curMain[3] || '').trim();
      if (!cat || cat.indexOf('লাইসেন্স') !== -1) return '';
      if (cat !== 'খাদ্য বান্ধব' && cat.indexOf('ওএমএস') !== 0) return '';
      var fy = '';
      var dm = String(isoTaxDate || entry.date || '').match(/^(\\d{4})-(\\d{2})-\\d{2}$/);
      if (dm) {
        var yr = Number(dm[1]), mo = Number(dm[2]);
        fy = mo >= 7 ? (yr + '-' + String(yr + 1).slice(-2)) : ((yr - 1) + '-' + String(yr).slice(-2));
      } else {
        var pm = String(finalTax || '').match(/^(\\d{2})(\\d{2})-/);
        if (pm && Number(pm[2]) === (Number(pm[1]) + 1) % 100) {
          fy = '20' + pm[1] + '-' + pm[2];
        } else {
          var nowD = new Date(), cy = nowD.getFullYear(), cm = nowD.getMonth() + 1;
          fy = cm >= 7 ? (cy + '-' + String(cy + 1).slice(-2)) : ((cy - 1) + '-' + String(cy).slice(-2));
        }
      }
      return 'করবর্ষ ' + fy + ' এর জন্য আয়কর ধারা ৯৪ অনুযায়ী INCOME TAX ON 10% COMMISSION';
    })();
    var tCommentVal = ow
      ? (entry.taxComment || defaultTaxRemark || '')
      : (entry.taxComment || prevTComment || defaultTaxRemark || '');
    var tCodeVal = ow ? (entry.taxCode || '') : (entry.taxCode || curTax[25] || curTax[22] || curMain[25] || '');
    var tExtraVal = ow ? (entry.taxExtra || '') : (entry.taxExtra || curTax[24] || curMain[24] || '');

    tRow[0] = baseId + '-TAX';
    tRow[1] = isoTaxDate;
    tRow[2] = '';
    tRow[3] = ow ? (entry.category || '') : (entry.category || curTax[3] || curMain[3] || '');
    tRow[4] = tDeptVal;
    tRow[5] = ow ? (entry.dcMemo || '') : (entry.dcMemo || curTax[5] || curMain[5] || '');
    tRow[6] = ow ? (entry.dealerAllocationId || '') : (entry.dealerAllocationId || curTax[6] || curMain[6] || '');
    tRow[7] = '';
    tRow[8] = '';
    tRow[9] = '';
    tRow[10] = '';
    tRow[11] = '';
    tRow[12] = finalTax;
    tRow[13] = isoTaxDate;
    tRow[14] = taxAmt;
    tRow[15] = '';
    tRow[16] = tCommentVal;
    tRow[17] = prevTCat || entry.createdAt || new Date().toISOString();
    tRow[18] = ''; tRow[19] = ''; tRow[20] = '';
    tRow[21] = ow ? (entry.licenseNo || '') : (entry.licenseNo || curTax[21] || curMain[21] || '');
    tRow[22] = tCodeVal || (ow ? (entry.new37Code || '') : (entry.new37Code || curMain[22] || ''));
    if (!hasCustom23 && (curTax[23] || srcRecordId)) tRow[23] = curTax[23] || srcRecordId;
    if (!hasCustom24 && (ow || tExtraVal)) tRow[24] = tExtraVal;
    if (!hasCustom25 && (ow || tCodeVal)) tRow[25] = tCodeVal;
    if (!hasCustom26) tRow[26] = '';
    var tCustom = (entry.taxCustomFields && Object.keys(entry.taxCustomFields).length > 0)
      ? entry.taxCustomFields
      : (entry.scanType === 'tax' ? entry.customFields : null);
    applyCustomColsToGasRow_(tRow, tCustom, curTax, ow && entry.scanType !== 'main');
    ordered.push(tRow);
  }

  if (hasVat) {
    var vRow = makeArr(curVat);
    var prevVCat = isIsoTsVal(curVat[17]) ? curVat[17] : '';
    var vCodeVal = ow ? (entry.vatCode || '') : (entry.vatCode || curVat[26] || curVat[22] || curMain[26] || '');
    var vDeptVal = curVat[4] || curVat[2] || (!hasTax ? colEVal : '') || '';
    vRow[0] = baseId + '-VAT';
    vRow[1] = isoVatDate;
    vRow[2] = '';
    vRow[3] = ow ? (entry.category || '') : (entry.category || curVat[3] || curMain[3] || '');
    vRow[4] = vDeptVal;
    vRow[5] = ow ? (entry.dcMemo || '') : (entry.dcMemo || curVat[5] || curMain[5] || '');
    vRow[6] = ow ? (entry.dealerAllocationId || '') : (entry.dealerAllocationId || curVat[6] || curMain[6] || '');
    vRow[7] = '';
    vRow[8] = '';
    vRow[9] = '';
    vRow[10] = '';
    vRow[11] = '';
    vRow[12] = ''; vRow[13] = ''; vRow[14] = '';
    vRow[15] = '';
    vRow[16] = ow ? (curVat[16] || '') : (curVat[16] || '');
    vRow[17] = prevVCat || entry.createdAt || new Date().toISOString();
    vRow[18] = finalVat;
    vRow[19] = isoVatDate;
    vRow[20] = vatAmt;
    vRow[21] = ow ? (entry.licenseNo || '') : (entry.licenseNo || curVat[21] || curMain[21] || '');
    vRow[22] = vCodeVal || (ow ? (entry.new37Code || '') : (entry.new37Code || curMain[22] || ''));
    if (!hasCustom23 && (curVat[23] || srcRecordId)) vRow[23] = curVat[23] || srcRecordId;
    if (!hasCustom24) vRow[24] = curVat[24] || '';
    if (!hasCustom25) vRow[25] = '';
    if (!hasCustom26 && (ow || vCodeVal)) vRow[26] = vCodeVal;
    var vCustom = (entry.vatCustomFields && Object.keys(entry.vatCustomFields).length > 0)
      ? entry.vatCustomFields
      : (entry.scanType === 'vat' ? entry.customFields : null);
    applyCustomColsToGasRow_(vRow, vCustom, curVat, ow && entry.scanType !== 'main');
    ordered.push(vRow);
  }

  return ordered;
}

function upsertChallanRow(sh, entry) {
  var lastRow = sh.getLastRow();
  var numCols = Math.max(30, sh.getLastColumn());
  var values = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, numCols).getDisplayValues() : [];

  var eChallan = cleanChallanNo_(entry.challanNo || '');
  var eTaxNo = cleanChallanNo_(entry.incomeTaxChallanNo || '');
  var eVatNo = cleanChallanNo_(entry.vatChallanNo || '');

  if (eChallan && eTaxNo && eChallan === eTaxNo) {
    return { mode: 'blocked', duplicate: true, message: 'বাধা দেওয়া হয়েছে: একই চালান নম্বর (' + eChallan + ') মূল ও আয়কর উভয় ঘরে থাকতে পারবে না।' };
  }
  if (eChallan && eVatNo && eChallan === eVatNo) {
    return { mode: 'blocked', duplicate: true, message: 'বাধা দেওয়া হয়েছে: একই চালান নম্বর (' + eChallan + ') মূল ও ভ্যাট উভয় ঘরে থাকতে পারবে না।' };
  }
  if (eTaxNo && eVatNo && eTaxNo === eVatNo) {
    return { mode: 'blocked', duplicate: true, message: 'বাধা দেওয়া হয়েছে: একই চালান নম্বর (' + eTaxNo + ') আয়কর ও ভ্যাট উভয় ঘরে থাকতে পারবে না।' };
  }

  var match = findPairedRowsInSheet_(values, entry, false);
  var allowedMap = {};
  for (var a = 0; a < match.allIndices.length; a++) allowedMap[match.allIndices[a]] = true;

  var globalIndex = buildGlobalChallanIndex_(values);
  var checkPairs = [];
  if (eChallan) checkPairs.push({ slot: 'main', num: eChallan });
  if (eTaxNo) checkPairs.push({ slot: 'tax', num: eTaxNo });
  if (eVatNo) checkPairs.push({ slot: 'vat', num: eVatNo });

  for (var p = 0; p < checkPairs.length; p++) {
    var item = checkPairs[p];
    var hit = globalIndex[item.num];
    if (!hit) continue;
    if (!allowedMap[hit.rowNumber]) {
      return {
        mode: 'blocked',
        duplicate: true,
        message: 'বাধা দেওয়া হয়েছে: চালান নম্বর ' + item.num + ' সম্পূর্ণ শিটে কেবল একবারই থাকবে — এটি আগে থেকেই ' + hit.rowNumber + ' নম্বর সারির ' + getSlotLabelBn_(hit.slot) + ' ঘরে আছে!'
      };
    }
  }

  var curMain = match.mainRowIndex > 0 ? values[match.mainRowIndex - 2] : [];
  var curTax = match.taxRowIndex > 0 ? values[match.taxRowIndex - 2] : [];
  var curVat = match.vatRowIndex > 0 ? values[match.vatRowIndex - 2] : [];
  var desiredRows = buildPairedRows_(entry, curMain, curTax, curVat);
  var rowWidth = desiredRows.length > 0 ? desiredRows[0].length : 27;

  var anchorRow = 0;
  if (match.allIndices.length > 0 && desiredRows.length > 0) {
    anchorRow = match.allIndices[0];
    var isContiguousSameCount = match.allIndices.length === desiredRows.length;
    if (isContiguousSameCount) {
      for (var c = 0; c < match.allIndices.length; c++) {
        if (match.allIndices[c] !== anchorRow + c) { isContiguousSameCount = false; break; }
      }
    }
    if (!isContiguousSameCount) {
      var othersDesc = match.allIndices.filter(function(n) { return n !== anchorRow; }).sort(function(x, y) { return y - x; });
      for (var d = 0; d < othersDesc.length; d++) {
        sh.deleteRow(othersDesc[d]);
      }
      if (desiredRows.length > 1) {
        sh.insertRowsAfter(anchorRow, desiredRows.length - 1);
      }
    }
    sh.getRange(anchorRow, 1, desiredRows.length, rowWidth).setValues(desiredRows);
  } else {
    anchorRow = Math.max(2, sh.getLastRow() + 1);
    sh.getRange(anchorRow, 1, desiredRows.length, rowWidth).setValues(desiredRows);
  }

  [2, 9, 14, 20].forEach(function(colIdx) {
    sh.getRange(anchorRow, colIdx, desiredRows.length, 1).setNumberFormat('yyyy-mm-dd');
  });
  SpreadsheetApp.flush();
  return { mode: match.allIndices.length > 0 ? 'updated' : 'appended', rowNumber: anchorRow };
}

function dedupeBatchEntries(list) {
  if (!list || list.length <= 1) return list || [];
  var sorted = list.slice().sort(function(a, b) {
    var sa = (cleanChallanNo_(a.challanNo) ? 2 : 0) + (cleanChallanNo_(a.incomeTaxChallanNo) ? 1 : 0) + (cleanChallanNo_(a.vatChallanNo) ? 1 : 0);
    var sb = (cleanChallanNo_(b.challanNo) ? 2 : 0) + (cleanChallanNo_(b.incomeTaxChallanNo) ? 1 : 0) + (cleanChallanNo_(b.vatChallanNo) ? 1 : 0);
    return sb - sa;
  });
  var seenId = {}, seenSrc = {}, seenNum = {}, out = [];
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    var eid = cleanBaseId_(e.id || '');
    var esrc = String(e.srcRecordId || '').trim();
    var m = cleanChallanNo_(e.challanNo || '');
    var t = cleanChallanNo_(e.incomeTaxChallanNo || '');
    var v = cleanChallanNo_(e.vatChallanNo || '');
    if (eid && !/^ch-ext-/i.test(eid) && seenId[eid]) continue;
    if (esrc && seenSrc[esrc]) continue;
    if (m && seenNum[m]) continue;
    if (!m && t && seenNum[t]) continue;
    if (!m && !t && v && seenNum[v]) continue;
    if (eid && !/^ch-ext-/i.test(eid)) seenId[eid] = true;
    if (esrc) seenSrc[esrc] = true;
    if (m) seenNum[m] = true;
    if (t) seenNum[t] = true;
    if (v) seenNum[v] = true;
    out.push(e);
  }
  return out;
}

function dedupeChallanSheet(ssOpt) {
  var ss = ssOpt && ssOpt.getSheetByName ? ssOpt : getTargetSpreadsheet();
  var sh = ssOpt && !ssOpt.getSheetByName ? ssOpt : ss.getSheetByName(TAB_CHALLAN);
  if (!sh) return { removedCount: 0, removed: 0, fixedCount: 0, merged: 0, message: 'Challan ট্যাব পাওয়া যায়নি।' };
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) return { removedCount: 0, removed: 0, fixedCount: 0, merged: 0, message: 'কোনো ডেটা নেই।' };

  var width = Math.max(27, sh.getLastColumn());
  var vals = sh.getRange(2, 1, lastRow - 1, width).getDisplayValues();
  var order = [];
  for (var i = 0; i < vals.length; i++) {
    var isExt = /^ch-ext-/i.test(String(vals[i][0] || '').trim());
    order.push({ idx: i, ext: isExt ? 1 : 0 });
  }
  order.sort(function(a, b) {
    if (a.ext !== b.ext) return a.ext - b.ext;
    return a.idx - b.idx;
  });

  var groups = [];
  var byBase = {}, bySrc = {}, byNum = {}, byAllocMo = {}, byLicMo = {};
  var removedRows = [];
  var fixedCount = 0;
  var nowStr = new Date().toISOString();

  function regGrp(gi, g) {
    if (g.baseId) byBase[g.baseId] = gi;
    if (g.srcId) bySrc[g.srcId] = gi;
    if (g.allocId) byAllocMo[g.allocId + '|' + (g.ym || '')] = gi;
    if (g.lic && g.cat) byLicMo[g.lic + '|' + g.cat + '|' + (g.ym || '')] = gi;
  }
  function regNums(gi, r, role) {
    var rM = cleanChallanNo_(r[7] || '');
    var rT = cleanChallanNo_(r[12] || '');
    var rV = cleanChallanNo_(r[18] || '');
    if (rM && role === 'main') byNum[rM] = gi;
    if (rT) byNum[rT] = gi; else if (rM && role === 'tax') byNum[rM] = gi;
    if (rV) byNum[rV] = gi; else if (rM && role === 'vat') byNum[rM] = gi;
  }

  for (var k = 0; k < order.length; k++) {
    var idx = order[k].idx;
    var r = vals[idx].slice();
    var rId = String(r[0] || '').trim();
    var isExt = /^ch-ext-/i.test(rId);
    var rBase = !isExt ? cleanBaseId_(rId) : '';
    var rSrc = getRowSrcId_(r);
    var rAlloc = String(r[6] || '').trim();
    var rLic = String(r[21] || '').trim();
    var rCat = String(r[3] || '').trim();
    var rYm = getYearMonthKey_(getRowEffectiveDate_(r));
    var role = classifyRowRole_(r);
    var rawM = String(r[7] || '').trim();
    var rM = cleanChallanNo_(rawM);
    var rT = cleanChallanNo_(r[12] || '');
    var rV = cleanChallanNo_(r[18] || '');

    if (!rId && !rM && !rT && !rV) {
      removedRows.push([nowStr, idx + 2, rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
      continue;
    }
    if (isExt && (rawM === '11' || !rM)) {
      removedRows.push([nowStr, idx + 2, rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
      continue;
    }

    var gIdx = -1;
    if (!isExt && rBase && byBase[rBase] !== undefined) gIdx = byBase[rBase];
    else if (rSrc && bySrc[rSrc] !== undefined) gIdx = bySrc[rSrc];
    else if (rM && byNum[rM] !== undefined) gIdx = byNum[rM];
    else if (rT && byNum[rT] !== undefined) gIdx = byNum[rT];
    else if (rV && byNum[rV] !== undefined) gIdx = byNum[rV];
    else if (rAlloc && byAllocMo[rAlloc + '|' + (rYm || '')] !== undefined) gIdx = byAllocMo[rAlloc + '|' + (rYm || '')];
    else if (!rYm && rAlloc) {
      for (var gi0 = 0; gi0 < groups.length; gi0++) {
        if (groups[gi0].allocId === rAlloc) { gIdx = gi0; break; }
      }
    } else if (rLic && rCat && byLicMo[rLic + '|' + rCat + '|' + (rYm || '')] !== undefined) {
      gIdx = byLicMo[rLic + '|' + rCat + '|' + (rYm || '')];
    }

    if (gIdx !== -1 && !isExt && role === 'main' && groups[gIdx].mainRow) {
      var gm = cleanChallanNo_(groups[gIdx].mainRow[7] || '');
      if (gm && rM && gm !== rM && groups[gIdx].baseId !== rBase && groups[gIdx].srcId !== rSrc) {
        gIdx = -1;
      }
    }

    if (gIdx === -1) {
      var ng = { firstOrder: idx, baseId: rBase || ('CHL-' + Date.now() + '-' + idx), srcId: rSrc, allocId: rAlloc, lic: rLic, cat: rCat, ym: rYm, mainRow: null, taxRow: null, vatRow: null };
      if (role === 'tax') ng.taxRow = r;
      else if (role === 'vat') ng.vatRow = r;
      else ng.mainRow = r;
      gIdx = groups.length;
      groups.push(ng);
      regGrp(gIdx, ng);
      regNums(gIdx, r, role);
    } else {
      var g = groups[gIdx];
      if (idx < g.firstOrder) g.firstOrder = idx;
      if (!g.srcId && rSrc) g.srcId = rSrc;
      if (!g.allocId && rAlloc) g.allocId = rAlloc;
      if (!g.ym && rYm) g.ym = rYm;
      if (isExt) {
        removedRows.push([nowStr, idx + 2, rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
        var dest = (role === 'vat') ? (g.vatRow || new Array(width)) : (g.taxRow || g.mainRow || new Array(width));
        if (role === 'vat') {
          if (!dest[18] && rM) { dest[18] = rM; fixedCount++; }
          if (!dest[19] && (r[19] || r[8] || r[1])) dest[19] = r[19] || r[8] || r[1] || '';
          if (!dest[20] && (r[20] || r[11])) dest[20] = r[20] || r[11] || '';
          g.vatRow = dest;
        } else {
          if (!dest[12] && rM) { dest[12] = rM; fixedCount++; }
          if (!dest[13] && (r[13] || r[8] || r[1])) dest[13] = r[13] || r[8] || r[1] || '';
          if (!dest[14] && (r[14] || r[11])) dest[14] = r[14] || r[11] || '';
          var extTaxComment = (!isIsoTsVal(r[16]) ? r[16] : '') || r[15] || '';
          if (!dest[16] && extTaxComment) dest[16] = extTaxComment;
          if (!g.taxRow && !g.mainRow) g.mainRow = dest;
        }
      } else if (role === 'tax') {
        if (!g.taxRow) g.taxRow = r;
        else {
          removedRows.push([nowStr, idx + 2, rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
          for (var c1 = 0; c1 < r.length; c1++) if (!String(g.taxRow[c1] || '').trim() && String(r[c1] || '').trim()) { g.taxRow[c1] = r[c1]; fixedCount++; }
        }
      } else if (role === 'vat') {
        if (!g.vatRow) g.vatRow = r;
        else {
          removedRows.push([nowStr, idx + 2, rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
          for (var c2 = 0; c2 < r.length; c2++) if (!String(g.vatRow[c2] || '').trim() && String(r[c2] || '').trim()) { g.vatRow[c2] = r[c2]; fixedCount++; }
        }
      } else {
        if (!g.mainRow) g.mainRow = r;
        else {
          removedRows.push([nowStr, idx + 2, rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
          for (var c3 = 0; c3 < r.length; c3++) if (!String(g.mainRow[c3] || '').trim() && String(r[c3] || '').trim()) { g.mainRow[c3] = r[c3]; fixedCount++; }
        }
      }
      regGrp(gIdx, g);
      regNums(gIdx, r, role);
    }
  }

  groups.sort(function(a, b) { return a.firstOrder - b.firstOrder; });
  var outRows = [];
  for (var x = 0; x < groups.length; x++) {
    var gx = groups[x];
    var mr = gx.mainRow || [], tr = gx.taxRow || [], vr = gx.vatRow || [];
    var ref = gx.mainRow || gx.taxRow || gx.vatRow || [];
    var dEntry = {
      scanType: 'main',
      id: gx.baseId,
      date: toIsoSheetDate(mr[1] || mr[8] || tr[13] || tr[1] || vr[1] || ''),
      department: String(mr[2] || '').trim(),
      taxDepartment: String(tr[4] || tr[2] || mr[4] || '').trim(),
      category: String(ref[3] || '').trim(),
      sourceMemo: String(tr[4] || mr[4] || '').trim(),
      dcMemo: String(ref[5] || '').trim(),
      dealerAllocationId: String(ref[6] || '').trim(),
      challanNo: cleanChallanNo_(mr[7] || ''),
      challanDate: toIsoSheetDate(mr[8] || mr[1] || ''),
      rate: String(mr[9] || ref[9] || '').trim(),
      quantity: String(mr[10] || ref[10] || '').trim(),
      totalAmount: String(mr[11] || '').trim(),
      incomeTaxChallanNo: cleanChallanNo_(tr[12] || tr[7] || mr[12] || ''),
      incomeTaxDate: toIsoSheetDate(tr[13] || tr[8] || tr[1] || mr[13] || ''),
      incomeTaxAmount: String(tr[14] || tr[11] || mr[14] || '').trim(),
      vatChallanNo: cleanChallanNo_(vr[18] || vr[7] || mr[18] || ''),
      vatDate: toIsoSheetDate(vr[19] || vr[8] || vr[1] || mr[19] || ''),
      vatAmount: String(vr[20] || vr[11] || mr[20] || '').trim(),
      licenseNo: String(ref[21] || '').trim(),
      new37Code: String(mr[22] || '').trim(),
      taxCode: String(tr[25] || tr[22] || mr[25] || '').trim(),
      vatCode: String(vr[26] || vr[22] || mr[26] || '').trim(),
      comment: String(mr[15] || '').trim(),
      taxComment: String((isIsoTsVal(tr[16]) ? '' : tr[16]) || tr[15] || (isIsoTsVal(mr[16]) ? '' : mr[16]) || '').trim(),
      taxExtra: String(tr[24] || mr[24] || '').trim(),
      createdAt: String((isIsoTsVal(ref[17]) ? ref[17] : '') || new Date().toISOString()).trim(),
      srcRecordId: gx.srcId,
      overwrite: false
    };
    var built = buildPairedRows_(dEntry, mr, tr, vr);
    for (var b = 0; b < built.length; b++) {
      var br = built[b];
      while (br.length < width) br.push('');
      outRows.push(br.slice(0, width));
    }
  }

  var changed = outRows.length !== vals.length;
  if (!changed) {
    for (var rIdx = 0; rIdx < outRows.length; rIdx++) {
      for (var cIdx = 0; cIdx < width; cIdx++) {
        if (String(outRows[rIdx][cIdx] || '') !== String(vals[rIdx][cIdx] || '')) {
          changed = true; fixedCount++;
        }
      }
    }
  }

  if (removedRows.length > 0 && ss.getSheetByName) {
    var bk = getOrCreateSheet(ss, TAB_DUP_BACKUP, ['deletedAt', 'originalRow', 'id', 'challanNo', 'incomeTaxChallanNo', 'vatChallanNo', 'snapshot']);
    bk.getRange(bk.getLastRow() + 1, 1, removedRows.length, 7).setValues(removedRows);
  }

  if (changed) {
    sh.getRange(2, 1, lastRow - 1, width).clearContent();
    if (outRows.length > 0) {
      sh.getRange(2, 1, outRows.length, width).setValues(outRows);
      [2, 9, 14, 20].forEach(function(colIdx) {
        sh.getRange(2, colIdx, outRows.length, 1).setNumberFormat('yyyy-mm-dd');
      });
    }
    SpreadsheetApp.flush();
  }

  var restoredCount = 0;
  if (ss.getSheetByName) {
    restoredCount = restoreWipedRowsFromSnapshot_(ss, sh);
    if (restoredCount > 0) {
      return dedupeChallanSheet(ss);
    }
    saveSafeSnapshot_(ss, sh);
  }

  return {
    removedCount: removedRows.length,
    removed: removedRows.length,
    restoredCount: restoredCount,
    fixedCount: fixedCount,
    merged: fixedCount,
    message: 'সাজানো ও পরিষ্কার সম্পন্ন: অতিরিক্ত বাদ ' + removedRows.length + 'টি, পুনরুদ্ধার ' + restoredCount + 'টি, মোট পাশাপাশি সারি ' + outRows.length + 'টি।'
  };
}

function getHiddenSystemSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
    try { sh.hideSheet(); } catch (ignore) {}
  }
  return sh;
}

function getDeletedLogSet_(ss) {
  var set = { ids: {}, srcIds: {}, nums: {} };
  if (!ss || !ss.getSheetByName) return set;
  var delSh = ss.getSheetByName(TAB_DELETED_LOG);
  if (!delSh || delSh.getLastRow() <= 1) return set;
  var vals = delSh.getRange(2, 1, delSh.getLastRow() - 1, 6).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    var rid = cleanBaseId_(vals[i][1] || '');
    var rsrc = String(vals[i][2] || '').trim();
    if (rid) set.ids[rid] = true;
    if (rsrc) set.srcIds[rsrc] = true;
    [vals[i][3], vals[i][4], vals[i][5]].forEach(function(raw) {
      var c = cleanChallanNo_(raw || '');
      if (c) set.nums[c] = true;
    });
  }
  return set;
}

function recordDeletedInLog_(ss, entry) {
  if (!ss || !ss.getSheetByName || !entry) return;
  var delSh = getHiddenSystemSheet_(ss, TAB_DELETED_LOG, ['deletedAt', 'id', 'srcRecordId', 'challanNo', 'incomeTaxChallanNo', 'vatChallanNo']);
  var hints = entry.matchHints || {};
  var eid = cleanBaseId_(entry.id || hints.id || '');
  var esrc = String(entry.srcRecordId || hints.srcRecordId || '').trim();
  var mNo = cleanChallanNo_(entry.challanNo || hints.challanNo || '');
  var tNo = cleanChallanNo_(entry.incomeTaxChallanNo || hints.incomeTaxChallanNo || '');
  var vNo = cleanChallanNo_(entry.vatChallanNo || hints.vatChallanNo || '');
  if (!eid && !esrc && !mNo && !tNo && !vNo) return;
  delSh.appendRow([new Date().toISOString(), eid, esrc, mNo, tNo, vNo]);

  var snapSh = ss.getSheetByName(TAB_SAFE_SNAPSHOT);
  if (snapSh && snapSh.getLastRow() > 1) {
    var sVals = snapSh.getRange(2, 1, snapSh.getLastRow() - 1, 7).getDisplayValues();
    for (var i = sVals.length - 1; i >= 0; i--) {
      var sid = cleanBaseId_(sVals[i][1] || '');
      var ssrc = String(sVals[i][2] || '').trim();
      var sm = cleanChallanNo_(sVals[i][3] || '');
      var st = cleanChallanNo_(sVals[i][4] || '');
      var sv = cleanChallanNo_(sVals[i][5] || '');
      var hit = (eid && sid === eid) ||
        (esrc && ssrc === esrc) ||
        (mNo && (sm === mNo || st === mNo || sv === mNo)) ||
        (tNo && (sm === tNo || st === tNo || sv === tNo)) ||
        (vNo && (sm === vNo || st === vNo || sv === vNo));
      if (hit) snapSh.deleteRow(i + 2);
    }
  }
}

function extractSnapshotKey_(row) {
  var rId = String(row[0] || '').trim();
  var rSrc = getRowSrcId_(row);
  var m = cleanChallanNo_(row[7] || '');
  var t = cleanChallanNo_(row[12] || '');
  var v = cleanChallanNo_(row[18] || '');
  var role = classifyRowRole_(row);
  if (rSrc) return 'src:' + rSrc + ':' + role;
  if (rId && !/^ch-ext-/i.test(rId)) return 'id:' + rId;
  if (role === 'tax' && (t || m)) return 't:' + (t || m);
  if (role === 'vat' && (v || m)) return 'v:' + (v || m);
  if (m) return 'm:' + m;
  if (t) return 't:' + t;
  if (v) return 'v:' + v;
  return '';
}

function clearDeletedLogForEntry_(ss, entry) {
  if (!ss || !ss.getSheetByName || !entry) return;
  var delSh = ss.getSheetByName(TAB_DELETED_LOG);
  if (!delSh || delSh.getLastRow() <= 1) return;
  var eid = cleanBaseId_(entry.id || '');
  var esrc = String(entry.srcRecordId || '').trim();
  var mNo = cleanChallanNo_(entry.challanNo || '');
  var tNo = cleanChallanNo_(entry.incomeTaxChallanNo || '');
  var vNo = cleanChallanNo_(entry.vatChallanNo || '');
  if (!eid && !esrc && !mNo && !tNo && !vNo) return;
  var dVals = delSh.getRange(2, 1, delSh.getLastRow() - 1, 6).getDisplayValues();
  for (var i = dVals.length - 1; i >= 0; i--) {
    var rid = cleanBaseId_(dVals[i][1] || '');
    var rsrc = String(dVals[i][2] || '').trim();
    var rm = cleanChallanNo_(dVals[i][3] || '');
    var rt = cleanChallanNo_(dVals[i][4] || '');
    var rv = cleanChallanNo_(dVals[i][5] || '');
    var hit =
      (eid && rid === eid) ||
      (esrc && rsrc === esrc) ||
      (mNo && (rm === mNo || rt === mNo || rv === mNo)) ||
      (tNo && (rm === tNo || rt === tNo || rv === tNo)) ||
      (vNo && (rm === vNo || rt === vNo || rv === vNo));
    if (hit) delSh.deleteRow(i + 2);
  }
}

function saveSafeSnapshot_(ss, sh) {
  if (!ss || !ss.getSheetByName || !sh) return;
  var delSet = getDeletedLogSet_(ss);
  var snapSh = getHiddenSystemSheet_(ss, TAB_SAFE_SNAPSHOT, ['updatedAt', 'id', 'srcRecordId', 'challanNo', 'incomeTaxChallanNo', 'vatChallanNo', 'rowJson']);
  var byKey = {};
  var existingSnapCount = snapSh.getLastRow() - 1;

  var lastRow = sh.getLastRow();
  var nowStr = new Date().toISOString();
  if (lastRow > 1) {
    var width = Math.max(27, sh.getLastColumn());
    var curVals = sh.getRange(2, 1, lastRow - 1, width).getDisplayValues();
    for (var r = 0; r < curVals.length; r++) {
      var row = curVals[r];
      var rId = String(row[0] || '').trim();
      if (/^ch-ext-/i.test(rId)) continue;
      var rM = cleanChallanNo_(row[7] || '');
      var rT = cleanChallanNo_(row[12] || '');
      var rV = cleanChallanNo_(row[18] || '');
      if (!rId && !rM && !rT && !rV) continue;
      var rSrc = getRowSrcId_(row);
      var k2 = extractSnapshotKey_(row);
      if (k2) {
        byKey[k2] = [nowStr, rId, rSrc, rM, rT, rV, JSON.stringify(row)];
      }
    }
  } else {
    // Sheet is empty; retain non-deleted snapshot only for mass-wipe check
    if (existingSnapCount > 0) {
      var prevSnap = snapSh.getRange(2, 1, existingSnapCount, 7).getDisplayValues();
      for (var i = 0; i < prevSnap.length; i++) {
        var sr = prevSnap[i];
        var sidBase = cleanBaseId_(sr[1] || '');
        var ssrc = String(sr[2] || '').trim();
        var sm = cleanChallanNo_(sr[3] || '');
        var st = cleanChallanNo_(sr[4] || '');
        var sv = cleanChallanNo_(sr[5] || '');
        if ((sidBase && delSet.ids[sidBase]) || (ssrc && delSet.srcIds[ssrc]) || (sm && delSet.nums[sm]) || (st && delSet.nums[st]) || (sv && delSet.nums[sv])) {
          continue;
        }
        try {
          var parsedRow = JSON.parse(String(sr[6] || '[]'));
          var k = extractSnapshotKey_(parsedRow);
          if (k) byKey[k] = sr;
        } catch (ignore) {}
      }
    }
  }

  var outRows = [];
  for (var key in byKey) {
    if (Object.prototype.hasOwnProperty.call(byKey, key)) outRows.push(byKey[key]);
  }
  if (existingSnapCount > 0) {
    snapSh.getRange(2, 1, existingSnapCount, 7).clearContent();
  }
  if (outRows.length > 0) {
    snapSh.getRange(2, 1, outRows.length, 7).setValues(outRows);
  }
}

function restoreWipedRowsFromSnapshot_(ss, sh) {
  if (!ss || !ss.getSheetByName || !sh) return 0;
  var snapSh = ss.getSheetByName(TAB_SAFE_SNAPSHOT);
  if (!snapSh || snapSh.getLastRow() <= 1) return 0;
  var delSet = getDeletedLogSet_(ss);
  var snapVals = snapSh.getRange(2, 1, snapSh.getLastRow() - 1, 7).getDisplayValues();

  var curExactIds = {}, curNums = {};
  var curNonExtCount = 0;
  var shWidth = Math.max(27, sh.getLastColumn());
  if (sh.getLastRow() > 1) {
    var curVals = sh.getRange(2, 1, sh.getLastRow() - 1, shWidth).getDisplayValues();
    for (var i = 0; i < curVals.length; i++) {
      var r = curVals[i];
      var rid = String(r[0] || '').trim();
      if (/^ch-ext-/i.test(rid)) continue;
      curNonExtCount++;
      if (rid) curExactIds[rid] = true;
      var cm = cleanChallanNo_(r[7] || '');
      var ct = cleanChallanNo_(r[12] || '');
      var cv = cleanChallanNo_(r[18] || '');
      if (cm) curNums[cm] = true;
      if (ct) curNums[ct] = true;
      if (cv) curNums[cv] = true;
    }
  }

  var toRestore = [];
  var maxCols = shWidth;
  for (var s = 0; s < snapVals.length; s++) {
    var sr = snapVals[s];
    var sid = String(sr[1] || '').trim();
    var sidBase = cleanBaseId_(sid);
    var ssrc = String(sr[2] || '').trim();
    var sm = cleanChallanNo_(sr[3] || '');
    var st = cleanChallanNo_(sr[4] || '');
    var sv = cleanChallanNo_(sr[5] || '');
    if ((sidBase && delSet.ids[sidBase]) || (ssrc && delSet.srcIds[ssrc]) || (sm && delSet.nums[sm]) || (st && delSet.nums[st]) || (sv && delSet.nums[sv])) {
      continue;
    }
    var alreadyPresent = (sid && curExactIds[sid]) ||
      (sm && curNums[sm]) ||
      (st && curNums[st]) ||
      (sv && curNums[sv]);
    if (alreadyPresent) continue;

    try {
      var rowArr = JSON.parse(String(sr[6] || '[]'));
      if (Array.isArray(rowArr) && rowArr.length > 0) {
        if (rowArr.length > maxCols) maxCols = rowArr.length;
        toRestore.push(rowArr);
        if (sid) curExactIds[sid] = true;
        if (sm) curNums[sm] = true;
        if (st) curNums[st] = true;
        if (sv) curNums[sv] = true;
      }
    } catch (ignore) {}
  }

  // Only recover from a catastrophic mass wipe (never resurrect normal single/few manual row deletions)
  var isCatastrophicWipe =
    (curNonExtCount === 0 && toRestore.length >= 3) ||
    (toRestore.length >= 10 && curNonExtCount <= Math.floor(snapVals.length * 0.5));
  if (!isCatastrophicWipe || toRestore.length === 0) return 0;

  for (var x = 0; x < toRestore.length; x++) {
    while (toRestore[x].length < maxCols) toRestore[x].push('');
  }
  var startRow = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(startRow, 1, toRestore.length, maxCols).setValues(toRestore);
  var bk = getOrCreateSheet(ss, TAB_DUP_BACKUP, ['deletedAt', 'originalRow', 'id', 'challanNo', 'incomeTaxChallanNo', 'vatChallanNo', 'snapshot']);
  var nowStr = new Date().toISOString();
  var logRows = toRestore.map(function(rowArr, idx) {
    return [nowStr, 'RESTORED:' + (startRow + idx), rowArr[0] || '', rowArr[7] || '', rowArr[12] || '', rowArr[18] || '', rowArr.join(' | ')];
  });
  bk.getRange(bk.getLastRow() + 1, 1, logRows.length, 7).setValues(logRows);
  SpreadsheetApp.flush();
  return toRestore.length;
}

function fixSheetDates(ssOpt, optionsOpt) {
  var ss = ssOpt || getTargetSpreadsheet();
  var opts = optionsOpt || {};
  var allowedMonths = Array.isArray(opts.allowedMonths) ? opts.allowedMonths : ['07', '09'];
  var sortOrder = opts.sortOrder || 'none';
  var sh = ss.getSheetByName(TAB_CHALLAN);
  if (!sh) return { fixedCount: 0, swappedCount: 0, message: 'Challan ট্যাব পাওয়া যায়নি।' };
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) return { fixedCount: 0, swappedCount: 0, message: 'কোনো ডেটা নেই।' };

  var lastCol = Math.max(27, sh.getLastColumn());
  var data = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
  var dateColIndices = [1, 8, 13, 19]; // B, I, N, T
  var backups = [];
  var fixedCount = 0;
  var swappedCount = 0;
  var nowStr = new Date().toISOString();

  function swapIsoMonthDay_(iso) {
    var m = String(iso || '').match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
    if (!m) return iso;
    var pMo = Number(m[2]), pDay = Number(m[3]);
    if (pMo <= 12 && pDay <= 12 && pMo !== pDay) {
      return m[1] + '-' + m[3] + '-' + m[2];
    }
    return iso;
  }

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var origRow = row.slice();
    var cNo = String(row[7] || row[12] || '').trim();

    for (var d = 0; d < dateColIndices.length; d++) {
      var ci = dateColIndices[d];
      var raw = String(row[ci] || '').trim();
      if (!raw) continue;
      var iso = toIsoSheetDate(raw);
      if (allowedMonths && allowedMonths.length > 0) {
        var mmMatch = iso.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
        if (mmMatch && allowedMonths.indexOf(mmMatch[2]) === -1) {
          var cand = swapIsoMonthDay_(iso);
          var cm = cand.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
          if (cm && allowedMonths.indexOf(cm[2]) !== -1) {
            iso = cand;
            swappedCount++;
          }
        }
      }
      if (iso && iso !== raw) {
        row[ci] = iso;
      }
    }

    if (row[1] && row[8] && areSwappedIsoDates_(row[1], row[8])) {
      var iMatch = String(row[8]).match(/^\\d{4}-(\\d{2})-(\\d{2})$/);
      if (iMatch && (!allowedMonths.length || allowedMonths.indexOf(iMatch[1]) !== -1)) {
        row[1] = row[8];
        swappedCount++;
      }
    }

    var rowChanged = false;
    for (var d2 = 0; d2 < dateColIndices.length; d2++) {
      var ci2 = dateColIndices[d2];
      if (String(row[ci2] || '').trim() !== String(origRow[ci2] || '').trim()) {
        backups.push([nowStr, i + 2, cNo, ci2 + 1, origRow[ci2], row[ci2]]);
        rowChanged = true;
      }
    }
    if (rowChanged) {
      data[i] = row;
      fixedCount++;
    }
  }

  if (sortOrder === 'asc' || sortOrder === 'desc') {
    data.sort(function(a, b) {
      var da = String(a[8] || a[13] || a[19] || a[1] || '');
      var db = String(b[8] || b[13] || b[19] || b[1] || '');
      return sortOrder === 'asc' ? da.localeCompare(db) : db.localeCompare(da);
    });
  }

  if (backups.length > 0) {
    var bSh = getOrCreateSheet(ss, 'Challan_Date_Backup', ['fixedAt', 'rowNo', 'challanNo', 'colNo', 'previousValue', 'newValue']);
    bSh.getRange(bSh.getLastRow() + 1, 1, backups.length, 6).setValues(backups);
  }

  if (fixedCount > 0 || sortOrder === 'asc' || sortOrder === 'desc') {
    sh.getRange(2, 1, data.length, lastCol).setValues(data);
  }
  [2, 9, 14, 20].forEach(function(colIdx) {
    sh.getRange(2, colIdx, data.length, 1).setNumberFormat('yyyy-mm-dd');
  });

  return {
    fixedCount: fixedCount,
    swappedCount: swappedCount,
    message: 'শিটের তারিখ ঠিক করা হয়েছে: ' + fixedCount + 'টি সারি আপডেট (উল্টানো সংশোধন: ' + swappedCount + 'টি)।'
  };
}

function guardNoDuplicateChallans(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return;
  try {
    var ss = getTargetSpreadsheet();
    if (e && e.range && e.range.getSheet) {
      var sh = e.range.getSheet();
      if (sh.getName() !== TAB_CHALLAN) return;
      var col = e.range.getColumn();
      var rowNum = e.range.getRow();
      if (rowNum <= 1) return;
      if (col === 8 || col === 13 || col === 19 || col === 1) {
        var val = cleanChallanNo_(e.range.getDisplayValue());
        var rowId = String(sh.getRange(rowNum, 1).getDisplayValue() || '').trim();
        if (/^ch-ext-/i.test(rowId)) {
          dedupeChallanSheet(ss);
          return;
        }
        if ((col === 8 || col === 13 || col === 19) && e.range.getDisplayValue() && !val) {
          e.range.clearContent();
          return;
        }
        if (val) {
          var values = sh.getRange(2, 1, sh.getLastRow() - 1, 20).getDisplayValues();
          for (var i = 0; i < values.length; i++) {
            var rNum = i + 2;
            var curRowId = String(values[i][0] || '').trim();
            var isSubRow = /-TAX$/i.test(curRowId) || /-VAT$/i.test(curRowId);
            if (isSubRow && rNum === rowNum) continue;
            var slots = [
              { col: 8, num: cleanChallanNo_(values[i][7]) },
              { col: 13, num: cleanChallanNo_(values[i][12]) },
              { col: 19, num: cleanChallanNo_(values[i][18]) }
            ];
            for (var s = 0; s < slots.length; s++) {
              if (slots[s].num === val && !(rNum === rowNum && slots[s].col === col)) {
                e.range.setValue(e.oldValue || '');
                ss.toast('বাধা দেওয়া হয়েছে: চালান নম্বর ' + val + ' আগে থেকেই ' + rNum + ' নম্বর সারিতে আছে!', 'ডুপ্লিকেট চালান সুরক্ষা', 6);
                return;
              }
            }
          }
        }
      }
      return;
    }
    dedupeChallanSheet(ss);
  } finally {
    lock.releaseLock();
  }
}

function guardChallanSheetAuto() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return;
  try {
    var ss = getTargetSpreadsheet();
    var sh = ss.getSheetByName(TAB_CHALLAN);
    if (!sh) return;

    var lastRow = sh.getLastRow();
    var needsCleanOrRestore = false;
    var validRowCount = 0;
    var seenNums = {};
    var lastBaseByIdx = {};

    if (lastRow > 1) {
      var vals = sh.getRange(2, 1, lastRow - 1, Math.min(24, Math.max(20, sh.getLastColumn()))).getDisplayValues();
      for (var i = 0; i < vals.length; i++) {
        var r = vals[i];
        var rid = String(r[0] || '').trim();
        if (/^ch-ext-/i.test(rid)) {
          needsCleanOrRestore = true;
          break;
        }
        var rm = cleanChallanNo_(r[7] || '');
        var rt = cleanChallanNo_(r[12] || '');
        var rv = cleanChallanNo_(r[18] || '');
        // Legacy combined row (both Main and Tax or VAT in a single line) needs split
        if ((rm && rt && rm !== rt) || (rm && rv && rm !== rv) || (rt && rv)) {
          needsCleanOrRestore = true;
          break;
        }
        var rowNums = {};
        if (rm) rowNums[rm] = true;
        if (rt) rowNums[rt] = true;
        if (rv) rowNums[rv] = true;
        for (var numKey in rowNums) {
          if (seenNums[numKey]) {
            needsCleanOrRestore = true;
            break;
          }
          seenNums[numKey] = true;
        }
        if (needsCleanOrRestore) break;

        var baseK = cleanBaseId_(rid);
        if (baseK) {
          if (lastBaseByIdx[baseK] !== undefined && lastBaseByIdx[baseK] !== i - 1) {
            needsCleanOrRestore = true;
            break;
          }
          lastBaseByIdx[baseK] = i;
        }
        if (rid || rm || rt || rv) validRowCount++;
      }
    }

    if (!needsCleanOrRestore) {
      var snapSh = ss.getSheetByName(TAB_SAFE_SNAPSHOT);
      if (snapSh && snapSh.getLastRow() - 1 > validRowCount) {
        needsCleanOrRestore = true;
      }
    }

    if (needsCleanOrRestore) {
      dedupeChallanSheet(ss);
    } else {
      saveSafeSnapshot_(ss, sh);
    }
  } finally {
    lock.releaseLock();
  }
}

function protectChallanTabOwnerOnly() {
  var ss = getTargetSpreadsheet();
  var sh = ss.getSheetByName(TAB_CHALLAN);
  if (!sh) return 'Challan ট্যাব পাওয়া যায়নি';
  var protection = sh.protect().setDescription('Challan Safe Row Protection');
  var me = Session.getEffectiveUser();
  protection.addEditor(me);
  protection.removeEditors(protection.getEditors());
  if (protection.canDomainEdit()) {
    protection.setDomainEdit(false);
  }
  return 'Challan ট্যাবে শুধুমাত্র মালিকের জন্য এডিট সুরক্ষা চালু হয়েছে।';
}

function installDuplicateGuardTrigger() {
  var ss = getTargetSpreadsheet();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'guardNoDuplicateChallans' || fn === 'guardChallanSheetAuto') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('guardNoDuplicateChallans').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('guardChallanSheetAuto').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('guardChallanSheetAuto').timeBased().everyMinutes(1).create();
  return dedupeChallanSheet(ss);
}

function findAllMatchRowsForDelete_(sh, entry) {
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];
  var values = sh.getRange(2, 1, lastRow - 1, Math.max(30, sh.getLastColumn())).getDisplayValues();
  var hints = entry.matchHints || {};
  var targetNums = {};
  [entry.challanNo, entry.incomeTaxChallanNo, entry.vatChallanNo, hints.challanNo, hints.incomeTaxChallanNo, hints.vatChallanNo].forEach(function(raw) {
    var c = cleanChallanNo_(raw || '');
    if (c) targetNums[c] = true;
  });
  var eBase = cleanBaseId_(entry.id || '');
  var hBase = cleanBaseId_(hints.id || '');
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var rId = String(r[0] || '').trim();
    var rBase = !/^ch-ext-/i.test(rId) ? cleanBaseId_(rId) : '';
    var rSrcId = getRowSrcId_(r);
    var rMain = cleanChallanNo_(r[7] || '');
    var rTax = cleanChallanNo_(r[12] || '');
    var rVat = cleanChallanNo_(r[18] || '');
    var matchedById =
      (entry.srcRecordId && rSrcId === entry.srcRecordId) ||
      (hints.srcRecordId && rSrcId === hints.srcRecordId) ||
      (rBase && ((eBase && rBase === eBase) || (hBase && rBase === hBase)));
    var matchedByNum =
      (rMain && targetNums[rMain]) ||
      (rTax && targetNums[rTax]) ||
      (rVat && targetNums[rVat]);
    if (matchedById || matchedByNum) {
      out.push(i + 2);
    }
  }
  return out;
}

function deleteChallanRow(ss, entry) {
  var sh = ss.getSheetByName(TAB_CHALLAN);
  if (!sh) return { deleted: false, message: 'Challan ট্যাব পাওয়া যায়নি' };
  var matchRows = findAllMatchRowsForDelete_(sh, entry);
  for (var d = matchRows.length - 1; d >= 0; d--) {
    if (matchRows[d] > 1) {
      sh.deleteRow(matchRows[d]);
    }
  }
  if (TAB_VAT && TAB_VAT !== TAB_CHALLAN) {
    var vSh = ss.getSheetByName(TAB_VAT);
    if (vSh && vSh.getLastRow() > 1) {
      var vVals = vSh.getRange(2, 1, vSh.getLastRow() - 1, 9).getDisplayValues();
      var vNo = cleanChallanNo_(entry.vatChallanNo || '');
      for (var i = vVals.length - 1; i >= 0; i--) {
        if ((entry.id && cleanBaseId_(vVals[i][0] || '') === cleanBaseId_(entry.id)) ||
            (vNo && cleanChallanNo_(vVals[i][5] || '') === vNo)) {
          vSh.deleteRow(i + 2);
        }
      }
    }
  }
  return {
    deleted: matchRows.length > 0,
    rowNumber: matchRows.length > 0 ? matchRows[0] : null,
    message: matchRows.length > 0
      ? (matchRows.length > 1 ? ('শিট থেকে ' + matchRows.length + 'টি সারি মোছা হয়েছে') : ('সারি ' + matchRows[0] + ' শিট থেকে মোছা হয়েছে'))
      : 'শিটে সারিটি পাওয়া যায়নি'
  };
}

function fetchOfficialChallanFromPortal_(rawChallanNo) {
  var cleaned = toAsciiDigits(rawChallanNo || '').replace(/\\s+/g, '').replace(/[–—]/g, '-').trim();
  var m11 = cleaned.match(/^(\\d{4})-(\\d{10})(\\d)$/);
  var m10 = cleaned.match(/^(\\d{4})-(\\d{10})$/);
  var digits = cleaned.replace(/\\D/g, '');
  if (!m11 && !m10) {
    if (digits.length === 15) {
      cleaned = digits.slice(0, 4) + '-' + digits.slice(4);
      m11 = cleaned.match(/^(\\d{4})-(\\d{10})(\\d)$/);
    } else if (digits.length === 14) {
      cleaned = digits.slice(0, 4) + '-' + digits.slice(4);
      m10 = cleaned.match(/^(\\d{4})-(\\d{10})$/);
    }
  }
  var queryNo = m11 ? (m11[1] + '-' + m11[2]) : (m10 ? (m10[1] + '-' + m10[2]) : '');
  if (!queryNo) {
    return { success: false, statusCode: 400, message: 'সঠিক চালান নম্বর পাওয়া যায়নি।' };
  }

  var url = 'https://www.achallan.gov.bd/acs/General/PrintChallanSlipDetailsHTML?challanNo=' + encodeURIComponent(queryNo);
  var cookieHeader = '';
  var lastStatus = 0;

  for (var attempt = 0; attempt < 2; attempt++) {
    var headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
      'Referer': 'https://www.achallan.gov.bd/acs/General/VerifyChallan'
    };
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true,
      headers: headers
    });
    lastStatus = resp.getResponseCode();

    try {
      var allHeaders = resp.getAllHeaders();
      var setCookie = allHeaders['Set-Cookie'] || allHeaders['set-cookie'];
      if (setCookie) {
        var cookieList = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
        var pairs = [];
        for (var ci = 0; ci < cookieList.length; ci++) {
          var part = String(cookieList[ci] || '').split(';')[0].trim();
          if (part) pairs.push(part);
        }
        if (pairs.length > 0) cookieHeader = pairs.join('; ');
      }
    } catch (ignoreCookie) {}

    if (lastStatus === 409 && attempt === 0) {
      Utilities.sleep(1600);
      continue;
    }

    if (lastStatus < 200 || lastStatus >= 300) {
      return {
        success: false,
        statusCode: lastStatus,
        retryable: lastStatus === 409 || lastStatus >= 500,
        message: 'সরকারি পেজ থেকে তথ্য আনা যায়নি। HTTP: ' + lastStatus
      };
    }

    var html = resp.getContentText() || '';
    var objMatch = html.match(/var\\s+obj\\s*=\\s*(\\{[\\s\\S]*?\\});/);
    if (!objMatch) {
      return { success: false, statusCode: 404, message: 'সরকারি পেজে চালানের তথ্য পাওয়া যায়নি।' };
    }
    var data = JSON.parse(objMatch[1]);
    if (String(data.ChallanNo || '') !== queryNo) {
      return { success: false, statusCode: 404, message: 'প্রাপ্ত চালান নম্বরের সঙ্গে মিল পাওয়া যায়নি।' };
    }

    var economics = Array.isArray(data.Economics)
      ? data.Economics.map(function(item) {
          return {
            EconomicNameBn: String((item && item.EconomicNameBn) || ''),
            EconomicCode: String((item && item.EconomicCode) || ''),
            EconomicAmount: (item && item.EconomicAmount != null) ? item.EconomicAmount : '',
            EconomicNew37Code: String((item && item.EconomicNew37Code) || ''),
            EconomicRemarks: String((item && item.EconomicRemarks) || '')
          };
        })
      : [];

    var returnedNo = m11 ? cleaned : normChallan11(String(data.ChallanNo || ''));
    return {
      success: true,
      data: {
        ChallanNo: returnedNo,
        NameBn: String(data.NameBn || ''),
        ClientForNameBn: String(data.ClientForNameBn || ''),
        ClientByNameBn: String(data.ClientByNameBn || ''),
        OrgNameBn: String(data.OrgNameBn || ''),
        ToOrgNameBn: String(data.ToOrgNameBn || ''),
        Amount: data.Amount != null ? data.Amount : '',
        ChallanDate: String(data.ChallanDate || ''),
        ChallanTypeNameBn: String(data.ChallanTypeNameBn || ''),
        New37Code: String(data.New37Code || ''),
        Remarks: String(data.Remarks || ''),
        Economics: economics
      }
    };
  }

  return {
    success: false,
    statusCode: lastStatus || 409,
    retryable: true,
    message: 'সরকারি পেজ থেকে তথ্য আনা যায়নি। HTTP: ' + (lastStatus || 409)
  };
}

function doGet() {
  try {
    var ss = getTargetSpreadsheet();
    return jsonOut({
      success: true,
      status: 'ready',
      spreadsheetId: ss.getId(),
      availableTabs: ss.getSheets().map(function(s) { return s.getName(); })
    });
  } catch (err) {
    return jsonOut({ success: false, message: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action || 'syncAll';
    var payload = body.payload || {};

    if (action === 'fetchOfficialChallan') {
      return jsonOut(fetchOfficialChallanFromPortal_(payload.challanNo || body.challanNo || ''));
    }

    var isWriteAction =
      action === 'deleteChallan' ||
      action === 'editChallan' ||
      action === 'saveChallan' ||
      action === 'saveChallanBatch' ||
      action === 'dedupeSheet' ||
      action === 'dedupeChallan' ||
      action === 'fixDates';

    if (isWriteAction) {
      if (!lock.tryLock(20000)) {
        return jsonOut({ success: false, message: 'শিট ব্যস্ত আছে, কিছুক্ষণ পর আবার চেষ্টা করুন।' });
      }
      lockHeld = true;
    }

    var ss = getTargetSpreadsheet();

    if (action === 'dedupeSheet' || action === 'dedupeChallan') {
      var dedupeRes = dedupeChallanSheet(ss);
      return jsonOut({
        success: true,
        removed: dedupeRes.removed,
        removedCount: dedupeRes.removedCount,
        merged: dedupeRes.merged,
        fixedCount: dedupeRes.fixedCount,
        message: dedupeRes.message
      });
    }

    if (action === 'fixDates') {
      var fixRes = fixSheetDates(ss, payload);
      return jsonOut({
        success: true,
        fixedCount: fixRes.fixedCount,
        swappedCount: fixRes.swappedCount,
        message: fixRes.message
      });
    }

    if (action === 'deleteChallan') {
      recordDeletedInLog_(ss, payload);
      var delRes = deleteChallanRow(ss, payload);
      return jsonOut({ success: true, deleted: delRes.deleted, rowNumber: delRes.rowNumber, message: delRes.message });
    }

    if (action === 'editChallan') {
      payload.overwrite = true;
      action = 'saveChallan';
    }

    if (action === 'saveChallan' || action === 'saveChallanBatch') {
      var headers = [
        'id','date','department','category','sourceMemo','dcMemo',
        'dealerAllocationId','challanNo','challanDate','rate','quantity',
        'totalAmount','incomeTaxChallanNo','incomeTaxDate','incomeTaxAmount',
        'comment','taxComment','createdAt','vatChallanNo','vatDate',
        'vatAmount','licenseNo','new37Code','srcRecordId','taxExtra',
        'taxCode','vatCode'
      ];
      var sh = getOrCreateSheet(ss, TAB_CHALLAN, headers);
      var rawEntries = action === 'saveChallanBatch' ? (payload.entries || []) : [payload];
      var entries = dedupeBatchEntries(rawEntries);
      var updated = 0, appended = 0, blocked = 0;
      var blockedMessages = [];
      for (var i = 0; i < entries.length; i++) {
        var r = upsertChallanRow(sh, entries[i]);
        if (r.mode === 'blocked') {
          blocked++;
          blockedMessages.push(r.message);
          if (action === 'saveChallan') {
            return jsonOut({ success: false, duplicate: true, blocked: true, message: r.message });
          }
          continue;
        }
        if (r.mode === 'updated') updated++; else appended++;
        clearDeletedLogForEntry_(ss, entries[i]);
        if (TAB_VAT && TAB_VAT !== TAB_CHALLAN && cleanChallanNo_(entries[i].vatChallanNo)) {
          var vSh = getOrCreateSheet(ss, TAB_VAT, ['id','vatDate','category','dealerName','licenseNo','vatChallanNo','vatAmount','new37Code','createdAt']);
          var cleanVatNo = cleanChallanNo_(entries[i].vatChallanNo);
          var vatVals = vSh.getLastRow() > 1 ? vSh.getRange(2, 6, vSh.getLastRow() - 1, 1).getDisplayValues() : [];
          var vatExists = vatVals.some(function(vr) { return cleanChallanNo_(vr[0]) === cleanVatNo; });
          if (!vatExists) {
            vSh.appendRow([
              entries[i].id || '', toIsoSheetDate(entries[i].vatDate || entries[i].date || ''),
              entries[i].category || '', entries[i].dealerName || '',
              entries[i].licenseNo || '', cleanVatNo,
              entries[i].vatAmount || '', entries[i].vatCode || entries[i].new37Code || '',
              entries[i].createdAt || new Date().toISOString()
            ]);
          }
        }
      }
      if (action === 'saveChallanBatch' && updated === 0 && appended === 0 && blocked > 0) {
        return jsonOut({ success: false, duplicate: true, message: blockedMessages[0] });
      }
      if (action === 'saveChallanBatch') {
        dedupeChallanSheet(ss);
      } else {
        saveSafeSnapshot_(ss, sh);
      }
      return jsonOut({
        success: true,
        updated: updated,
        appended: appended,
        blocked: blocked,
        blockedMessages: blockedMessages,
        message: blocked > 0
          ? ('Google Sheet আপডেট: ' + (updated + appended) + 'টি, ডুপ্লিকেট বাধা: ' + blocked + 'টি')
          : 'Google Sheet আপডেট সম্পন্ন'
      });
    }

    var readTab = function(name) {
      var tab = ss.getSheetByName(name);
      return tab ? tab.getDataRange().getDisplayValues() : [];
    };

    return jsonOut({
      success: true,
      availableTabs: ss.getSheets().map(function(s) { return s.getName(); }),
      tabs: {
        challan: readTab(TAB_CHALLAN),
        suballocations: readTab(TAB_SUBALLOC),
        foodDealers: readTab(TAB_FOOD_DEALER),
        omsDealers: readTab(TAB_OMS_DEALER),
        doIssues: readTab(TAB_DO_ISSUE),
        deletedLog: readTab(TAB_DELETED_LOG)
      }
    });
  } catch (err) {
    return jsonOut({ success: false, message: String(err) });
  } finally {
    if (lockHeld) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}`;
}

export function generateExternalAndroidSheetGuardCode(
  settings: AppSettings
): string {
  const spreadsheetId = extractSpreadsheetId(settings.spreadsheetId || '');
  const challanTab = settings.challanTabName?.trim() || 'Challan';

  return `// ============================================================================
// ChallanGuard.gs — অন্য অ্যান্ড্রয়েড অ্যাপের লিংক করা Google Sheet সুরক্ষা ও ২-লাইন জোড়া স্ক্রিপ্ট
// ============================================================================
// কোথায় ও কীভাবে ব্যবহার করবেন:
// ১) আপনার অন্য অ্যান্ড্রয়েড অ্যাপ যে Google Sheet-এর সাথে লিংক করা, সেই শিট খুলুন
//    (অথবা বর্তমান শিটের সাথে অন্য অ্যাপ যুক্ত থাকলে সেটিতেও নতুন স্ক্রিপ্ট ফাইল "+" দিন)।
// ২) Extensions > Apps Script খুলুন > নতুন ফাইল "ChallanGuard.gs" তৈরি করে এটি পেস্ট করুন।
//    (দ্রষ্টব্য: এতে কোনো doGet/doPost নেই — তাই বিদ্যমান কোডের সাথে কোনো সংঘর্ষ হবে না!)
// ৩) ফাংশন ড্রপডাউন থেকে "installAndroidChallanRowGuard" বেছে Run দিন (১ বার অনুমতি দিন)।
// ৪) ওই শিটে পুরোনো কোনো সিঙ্ক ট্রিগার ("ch-ext-t-" বাড়ায় বা ৩-৪ সারি বানায়)
//    বন্ধ করতে "disableLegacySyncTriggers" একবার Run দিন অথবা Triggers (ঘড়ি আইকন) থেকে মুছুন।
// ============================================================================

const ANDROID_GUARD_SPREADSHEET_ID = ''; // ফাঁকা রাখলে যে শিটে বসানো হয়েছে সেটিই সুরক্ষিত হবে; চাইলে ${JSON.stringify(spreadsheetId)} বসাতে পারেন
const ANDROID_GUARD_TAB_NAMES = [${JSON.stringify(challanTab)}, 'Challan', 'ALL_CHALLANS'];
const ANDROID_GUARD_BACKUP_TAB = 'Challan_Duplicate_Backup';
const ANDROID_GUARD_SNAPSHOT_TAB = 'Challan_Safe_Snapshot';
const ANDROID_GUARD_DELETED_TAB = 'Challan_Deleted_Log';

function agTargetSpreadsheet_() {
  if (ANDROID_GUARD_SPREADSHEET_ID) {
    return SpreadsheetApp.openById(ANDROID_GUARD_SPREADSHEET_ID);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function agToAsciiDigits_(val) {
  var bn = '০১২৩৪৫৬৭৮৯';
  return String(val == null ? '' : val).replace(/[০-৯]/g, function(ch) {
    var idx = bn.indexOf(ch);
    return idx >= 0 ? String(idx) : ch;
  });
}

function agCleanChallan_(val) {
  var s = agToAsciiDigits_(val || '').replace(/\\s+/g, '').replace(/[–—]/g, '-').trim();
  if (!s) return '';
  var m = s.match(/^(\\d{4})-(\\d{10})$/);
  if (m) s = m[1] + '-' + m[2] + '1';
  var digits = s.replace(/\\D/g, '');
  if (digits.length === 14) s = digits.slice(0, 4) + '-' + digits.slice(4) + '1';
  else if (digits.length === 15) s = digits.slice(0, 4) + '-' + digits.slice(4);
  var low = s.toLowerCase();
  if (low === '11' || low === '1' || low === '0' || low === '-' || low === 'n/a' || low === 'na' || low === 'null') return '';
  if (digits.length < 5) return '';
  return s;
}

function agCleanBaseId_(id) {
  return String(id || '').trim().replace(/-(?:TAX|VAT)$/i, '');
}

function agIsIsoTs_(val) {
  return /^\\d{4}-\\d{2}-\\d{2}(?:T|\\s+\\d{2}:\\d{2})/.test(String(val || '').trim());
}

function agToIsoDate_(val) {
  var s = agToAsciiDigits_(val || '').trim();
  if (!s) return '';
  var mIso = s.match(/^(\\d{4})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{1,2})(?:$|T|\\s)/);
  if (mIso) return mIso[1] + '-' + ('0' + Number(mIso[2])).slice(-2) + '-' + ('0' + Number(mIso[3])).slice(-2);
  var mDmy = s.match(/^(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{4}|\\d{2})$/);
  if (mDmy) {
    var p1 = Number(mDmy[1]), p2 = Number(mDmy[2]), yr = mDmy[3].length === 2 ? '20' + mDmy[3] : mDmy[3];
    var day = p1, mo = p2;
    if (p2 > 12 && p1 <= 12) { mo = p1; day = p2; }
    return yr + '-' + ('0' + mo).slice(-2) + '-' + ('0' + day).slice(-2);
  }
  return s;
}

function agYearMonth_(val) {
  var iso = agToIsoDate_(val || '');
  var m = iso.match(/^(\\d{4})-(\\d{2})-\\d{2}$/);
  return m ? (m[1] + '-' + m[2]) : '';
}

function agRowSrcId_(row) {
  var legacy17 = String(row[17] || '').trim();
  return String(row[23] || (!agIsIsoTs_(legacy17) ? legacy17 : '') || '').trim();
}

function agRowRole_(row) {
  var rId = String(row[0] || '').trim();
  var rM = agCleanChallan_(row[7] || '');
  var rT = agCleanChallan_(row[12] || '');
  var rV = agCleanChallan_(row[18] || '');
  if (/-TAX$/i.test(rId) || /^ch-ext-t-/i.test(rId) || (!rM && rT) || (rM && rM === rT)) return 'tax';
  if (/-VAT$/i.test(rId) || /^ch-ext-v-/i.test(rId) || (!rM && !rT && rV) || (rM && rM === rV)) return 'vat';
  return 'main';
}

function agGetOrCreateHiddenSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
    try { sh.hideSheet(); } catch (ignore) {}
  }
  return sh;
}

function agGetTargetSheets_(ss) {
  var seen = {};
  var list = [];
  for (var i = 0; i < ANDROID_GUARD_TAB_NAMES.length; i++) {
    var nm = ANDROID_GUARD_TAB_NAMES[i];
    if (!nm || seen[nm]) continue;
    var sh = ss.getSheetByName(nm);
    if (sh) {
      seen[nm] = true;
      list.push(sh);
    }
  }
  return list;
}

function agGetDeletedSet_(ss) {
  var set = { ids: {}, srcIds: {}, nums: {} };
  var delSh = ss.getSheetByName(ANDROID_GUARD_DELETED_TAB);
  if (!delSh || delSh.getLastRow() <= 1) return set;
  var vals = delSh.getRange(2, 1, delSh.getLastRow() - 1, 6).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    var rid = agCleanBaseId_(vals[i][1] || '');
    var rsrc = String(vals[i][2] || '').trim();
    if (rid) set.ids[rid] = true;
    if (rsrc) set.srcIds[rsrc] = true;
    [vals[i][3], vals[i][4], vals[i][5]].forEach(function(raw) {
      var c = agCleanChallan_(raw || '');
      if (c) set.nums[c] = true;
    });
  }
  return set;
}

function agSnapshotKey_(row) {
  var rId = String(row[0] || '').trim();
  var rSrc = agRowSrcId_(row);
  var m = agCleanChallan_(row[7] || '');
  var t = agCleanChallan_(row[12] || '');
  var v = agCleanChallan_(row[18] || '');
  var role = agRowRole_(row);
  if (rSrc) return 'src:' + rSrc + ':' + role;
  if (rId && !/^ch-ext-/i.test(rId)) return 'id:' + rId;
  if (role === 'tax' && (t || m)) return 't:' + (t || m);
  if (role === 'vat' && (v || m)) return 'v:' + (v || m);
  if (m) return 'm:' + m;
  if (t) return 't:' + t;
  if (v) return 'v:' + v;
  return '';
}

function agSaveSnapshotForSheet_(ss, sh) {
  var snapTabName = sh.getName() === 'Challan'
    ? ANDROID_GUARD_SNAPSHOT_TAB
    : (ANDROID_GUARD_SNAPSHOT_TAB + '_' + sh.getName());
  var delSet = agGetDeletedSet_(ss);
  var snapSh = agGetOrCreateHiddenSheet_(ss, snapTabName, ['updatedAt', 'id', 'srcRecordId', 'challanNo', 'incomeTaxChallanNo', 'vatChallanNo', 'rowJson']);
  var byKey = {};
  var prevCount = snapSh.getLastRow() - 1;
  var lastRow = sh.getLastRow();
  var nowStr = new Date().toISOString();
  if (lastRow > 1) {
    var width = Math.max(27, sh.getLastColumn());
    var curVals = sh.getRange(2, 1, lastRow - 1, width).getDisplayValues();
    for (var r = 0; r < curVals.length; r++) {
      var row = curVals[r];
      var rId = String(row[0] || '').trim();
      if (/^ch-ext-/i.test(rId)) continue;
      var rM = agCleanChallan_(row[7] || '');
      var rT = agCleanChallan_(row[12] || '');
      var rV = agCleanChallan_(row[18] || '');
      if (!rId && !rM && !rT && !rV) continue;
      var rSrc = agRowSrcId_(row);
      var k2 = agSnapshotKey_(row);
      if (k2) byKey[k2] = [nowStr, rId, rSrc, rM, rT, rV, JSON.stringify(row)];
    }
  } else if (prevCount > 0) {
    var prevRows = snapSh.getRange(2, 1, prevCount, 7).getDisplayValues();
    for (var i = 0; i < prevRows.length; i++) {
      var sr = prevRows[i];
      var sidBase = agCleanBaseId_(sr[1] || '');
      var ssrc = String(sr[2] || '').trim();
      var sm = agCleanChallan_(sr[3] || '');
      var st = agCleanChallan_(sr[4] || '');
      var sv = agCleanChallan_(sr[5] || '');
      if ((sidBase && delSet.ids[sidBase]) || (ssrc && delSet.srcIds[ssrc]) || (sm && delSet.nums[sm]) || (st && delSet.nums[st]) || (sv && delSet.nums[sv])) continue;
      try {
        var parsed = JSON.parse(String(sr[6] || '[]'));
        var k = agSnapshotKey_(parsed);
        if (k) byKey[k] = sr;
      } catch (ignore) {}
    }
  }
  var outRows = [];
  for (var key in byKey) {
    if (Object.prototype.hasOwnProperty.call(byKey, key)) outRows.push(byKey[key]);
  }
  if (prevCount > 0) snapSh.getRange(2, 1, prevCount, 7).clearContent();
  if (outRows.length > 0) snapSh.getRange(2, 1, outRows.length, 7).setValues(outRows);
}

function agRestoreMissingForSheet_(ss, sh) {
  var snapTabName = sh.getName() === 'Challan'
    ? ANDROID_GUARD_SNAPSHOT_TAB
    : (ANDROID_GUARD_SNAPSHOT_TAB + '_' + sh.getName());
  var snapSh = ss.getSheetByName(snapTabName);
  if (!snapSh || snapSh.getLastRow() <= 1) return 0;
  var delSet = agGetDeletedSet_(ss);
  var snapVals = snapSh.getRange(2, 1, snapSh.getLastRow() - 1, 7).getDisplayValues();

  var curExactIds = {}, curNums = {};
  var curNonExtCount = 0;
  var shWidth = Math.max(27, sh.getLastColumn());
  if (sh.getLastRow() > 1) {
    var curVals = sh.getRange(2, 1, sh.getLastRow() - 1, shWidth).getDisplayValues();
    for (var i = 0; i < curVals.length; i++) {
      var r = curVals[i];
      var rid = String(r[0] || '').trim();
      if (/^ch-ext-/i.test(rid)) continue;
      curNonExtCount++;
      if (rid) curExactIds[rid] = true;
      var cm = agCleanChallan_(r[7] || '');
      var ct = agCleanChallan_(r[12] || '');
      var cv = agCleanChallan_(r[18] || '');
      if (cm) curNums[cm] = true;
      if (ct) curNums[ct] = true;
      if (cv) curNums[cv] = true;
    }
  }

  var toRestore = [];
  var maxCols = shWidth;
  for (var s = 0; s < snapVals.length; s++) {
    var sr = snapVals[s];
    var sid = String(sr[1] || '').trim();
    var sidBase = agCleanBaseId_(sid);
    var ssrc = String(sr[2] || '').trim();
    var sm = agCleanChallan_(sr[3] || '');
    var st = agCleanChallan_(sr[4] || '');
    var sv = agCleanChallan_(sr[5] || '');
    if ((sidBase && delSet.ids[sidBase]) || (ssrc && delSet.srcIds[ssrc]) || (sm && delSet.nums[sm]) || (st && delSet.nums[st]) || (sv && delSet.nums[sv])) continue;
    var present = (sid && curExactIds[sid]) || (sm && curNums[sm]) || (st && curNums[st]) || (sv && curNums[sv]);
    if (present) continue;
    try {
      var parsed = JSON.parse(String(sr[6] || '[]'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (parsed.length > maxCols) maxCols = parsed.length;
        toRestore.push(parsed);
        if (sid) curExactIds[sid] = true;
        if (sm) curNums[sm] = true;
        if (st) curNums[st] = true;
        if (sv) curNums[sv] = true;
      }
    } catch (ignore) {}
  }

  var isCatastrophicWipe =
    (curNonExtCount === 0 && toRestore.length >= 3) ||
    (toRestore.length >= 10 && curNonExtCount <= Math.floor(snapVals.length * 0.5));
  if (!isCatastrophicWipe || toRestore.length === 0) return 0;
  for (var x = 0; x < toRestore.length; x++) {
    while (toRestore[x].length < maxCols) toRestore[x].push('');
  }
  var startRow = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(startRow, 1, toRestore.length, maxCols).setValues(toRestore);
  SpreadsheetApp.flush();
  return toRestore.length;
}

function agSplitLegacyAndPair_(g, width) {
  var mr = g.mainRow ? g.mainRow.slice() : [];
  var tr = g.taxRow ? g.taxRow.slice() : [];
  var vr = g.vatRow ? g.vatRow.slice() : [];
  var ref = g.mainRow || g.taxRow || g.vatRow || [];
  var baseId = g.baseId || agCleanBaseId_(ref[0] || '') || ('CHL-' + Date.now());
  var srcId = g.srcId || agRowSrcId_(ref);

  function pad(a) {
    var out = new Array(width);
    for (var i = 0; i < width; i++) out[i] = (a && a[i]) ? String(a[i]) : '';
    return out;
  }

  var mNo = agCleanChallan_(mr[7] || '');
  var tNo = agCleanChallan_(tr[12] || tr[7] || mr[12] || '');
  var vNo = agCleanChallan_(vr[18] || vr[7] || mr[18] || '');
  var mAmt = String(mr[11] || '').trim();
  var tAmt = String(tr[14] || tr[11] || mr[14] || '').trim();
  var vAmt = String(vr[20] || vr[11] || mr[20] || '').trim();

  var hasMain = Boolean(mNo || mAmt);
  var hasTax = Boolean(tNo || tAmt);
  var hasVat = Boolean(vNo || vAmt);
  var rows = [];

  if (hasMain || (!hasTax && !hasVat)) {
    var mOut = pad(mr);
    mOut[0] = baseId;
    mOut[1] = agToIsoDate_(mOut[1] || mOut[8] || '');
    if (mOut[8]) mOut[8] = agToIsoDate_(mOut[8]);
    mOut[7] = mNo;
    mOut[12] = ''; mOut[13] = ''; mOut[14] = ''; mOut[16] = '';
    mOut[18] = ''; mOut[19] = ''; mOut[20] = '';
    if (srcId && !mOut[23]) mOut[23] = srcId;
    mOut[24] = ''; mOut[25] = ''; mOut[26] = '';
    rows.push(mOut);
  }
  if (hasTax) {
    var tOut = pad(tr.length > 0 ? tr : mr);
    var tIso = agToIsoDate_(tr[13] || tr[8] || tr[1] || mr[13] || mr[1] || '');
    var tDeptClean = tr[4] || tr[2] || (mr[4] && mr[4] !== mr[2] ? mr[4] : '') || '';
    var tCatClean = String(tr[3] || mr[3] || '').trim();
    var tDefaultComment = (function() {
      if (!tCatClean || tCatClean.indexOf('লাইসেন্স') !== -1) return '';
      if (tCatClean !== 'খাদ্য বান্ধব' && tCatClean.indexOf('ওএমএস') !== 0) return '';
      var fy = '';
      var dm = String(tIso || '').match(/^(\\d{4})-(\\d{2})-\\d{2}$/);
      if (dm) {
        var yr = Number(dm[1]), mo = Number(dm[2]);
        fy = mo >= 7 ? (yr + '-' + String(yr + 1).slice(-2)) : ((yr - 1) + '-' + String(yr).slice(-2));
      } else {
        var pm = String(tNo || '').match(/^(\\d{2})(\\d{2})-/);
        if (pm && Number(pm[2]) === (Number(pm[1]) + 1) % 100) {
          fy = '20' + pm[1] + '-' + pm[2];
        } else {
          var nowD = new Date(), cy = nowD.getFullYear(), cm = nowD.getMonth() + 1;
          fy = cm >= 7 ? (cy + '-' + String(cy + 1).slice(-2)) : ((cy - 1) + '-' + String(cy).slice(-2));
        }
      }
      return 'করবর্ষ ' + fy + ' এর জন্য আয়কর ধারা ৯৪ অনুযায়ী INCOME TAX ON 10% COMMISSION';
    })();
    var tCommentClean = (agIsIsoTs_(tr[16]) ? '' : tr[16]) || (tr.length > 0 ? tr[15] : '') || (agIsIsoTs_(mr[16]) ? '' : mr[16]) || tDefaultComment || '';
    tOut[0] = baseId + '-TAX';
    tOut[1] = tIso;
    tOut[2] = '';
    tOut[3] = tr[3] || mr[3] || '';
    tOut[4] = tDeptClean;
    tOut[5] = tr[5] || mr[5] || '';
    tOut[6] = tr[6] || mr[6] || '';
    tOut[7] = '';
    tOut[8] = '';
    tOut[9] = '';
    tOut[10] = '';
    tOut[11] = '';
    tOut[12] = tNo;
    tOut[13] = tIso;
    tOut[14] = tAmt;
    tOut[15] = '';
    tOut[16] = tCommentClean;
    tOut[17] = (agIsIsoTs_(tr[17]) ? tr[17] : (agIsIsoTs_(mr[17]) ? mr[17] : '')) || new Date().toISOString();
    tOut[18] = ''; tOut[19] = ''; tOut[20] = '';
    tOut[21] = tr[21] || mr[21] || '';
    tOut[22] = tr[25] || tr[22] || mr[25] || mr[22] || '';
    if (srcId && !tOut[23]) tOut[23] = srcId;
    tOut[24] = tr[24] || mr[24] || '';
    tOut[25] = tr[25] || mr[25] || '';
    tOut[26] = '';
    rows.push(tOut);
  }
  if (hasVat) {
    var vOut = pad(vr.length > 0 ? vr : mr);
    var vIso = agToIsoDate_(vr[19] || vr[8] || vr[1] || mr[19] || mr[1] || '');
    vOut[0] = baseId + '-VAT';
    vOut[1] = vIso;
    vOut[2] = '';
    vOut[3] = vr[3] || mr[3] || '';
    vOut[4] = vr[4] || (!hasTax ? (mr[4] || '') : '') || '';
    vOut[5] = vr[5] || mr[5] || '';
    vOut[6] = vr[6] || mr[6] || '';
    vOut[7] = '';
    vOut[8] = '';
    vOut[9] = '';
    vOut[10] = '';
    vOut[11] = '';
    vOut[12] = ''; vOut[13] = ''; vOut[14] = '';
    vOut[15] = '';
    vOut[17] = (agIsIsoTs_(vr[17]) ? vr[17] : (agIsIsoTs_(mr[17]) ? mr[17] : '')) || new Date().toISOString();
    vOut[18] = vNo;
    vOut[19] = vIso;
    vOut[20] = vAmt;
    vOut[21] = vr[21] || mr[21] || '';
    vOut[22] = vr[26] || vr[22] || mr[26] || mr[22] || '';
    if (srcId && !vOut[23]) vOut[23] = srcId;
    vOut[26] = vr[26] || mr[26] || '';
    rows.push(vOut);
  }
  return rows;
}

function agCleanAndProtectSheet_(ss, sh) {
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) {
    agRestoreMissingForSheet_(ss, sh);
    agSaveSnapshotForSheet_(ss, sh);
    return { removed: 0, restored: 0 };
  }
  var width = Math.max(27, sh.getLastColumn());
  var vals = sh.getRange(2, 1, lastRow - 1, width).getDisplayValues();
  var order = [];
  for (var i = 0; i < vals.length; i++) {
    var isExt = /^ch-ext-/i.test(String(vals[i][0] || '').trim());
    order.push({ idx: i, ext: isExt ? 1 : 0 });
  }
  order.sort(function(a, b) {
    if (a.ext !== b.ext) return a.ext - b.ext;
    return a.idx - b.idx;
  });

  var groups = [];
  var byBase = {}, bySrc = {}, byNum = {}, byAllocMo = {}, byLicMo = {};
  var removedRows = [];
  var nowStr = new Date().toISOString();

  function regG(gi, g) {
    if (g.baseId) byBase[g.baseId] = gi;
    if (g.srcId) bySrc[g.srcId] = gi;
    if (g.allocId) byAllocMo[g.allocId + '|' + (g.ym || '')] = gi;
    if (g.lic && g.cat) byLicMo[g.lic + '|' + g.cat + '|' + (g.ym || '')] = gi;
  }
  function regN(gi, r, role) {
    var rm = agCleanChallan_(r[7] || ''), rt = agCleanChallan_(r[12] || ''), rv = agCleanChallan_(r[18] || '');
    if (rm && role === 'main') byNum[rm] = gi;
    if (rt) byNum[rt] = gi; else if (rm && role === 'tax') byNum[rm] = gi;
    if (rv) byNum[rv] = gi; else if (rm && role === 'vat') byNum[rm] = gi;
  }

  for (var k = 0; k < order.length; k++) {
    var idx = order[k].idx;
    var r = vals[idx].slice();
    var rId = String(r[0] || '').trim();
    var isExt = /^ch-ext-/i.test(rId);
    var rBase = !isExt ? agCleanBaseId_(rId) : '';
    var rSrc = agRowSrcId_(r);
    var rAlloc = String(r[6] || '').trim();
    var rLic = String(r[21] || '').trim();
    var rCat = String(r[3] || '').trim();
    var rYm = agYearMonth_(r[8] || r[13] || r[19] || r[1] || '');
    var role = agRowRole_(r);
    var rawM = String(r[7] || '').trim();
    var rM = agCleanChallan_(rawM);
    var rT = agCleanChallan_(r[12] || '');
    var rV = agCleanChallan_(r[18] || '');

    if (!rId && !rM && !rT && !rV) {
      removedRows.push([nowStr, sh.getName() + ':' + (idx + 2), rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
      continue;
    }
    if (isExt && (rawM === '11' || !rM)) {
      removedRows.push([nowStr, sh.getName() + ':' + (idx + 2), rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
      continue;
    }

    var gIdx = -1;
    if (!isExt && rBase && byBase[rBase] !== undefined) gIdx = byBase[rBase];
    else if (rSrc && bySrc[rSrc] !== undefined) gIdx = bySrc[rSrc];
    else if (rM && byNum[rM] !== undefined) gIdx = byNum[rM];
    else if (rT && byNum[rT] !== undefined) gIdx = byNum[rT];
    else if (rV && byNum[rV] !== undefined) gIdx = byNum[rV];
    else if (rAlloc && byAllocMo[rAlloc + '|' + (rYm || '')] !== undefined) gIdx = byAllocMo[rAlloc + '|' + (rYm || '')];
    else if (!rYm && rAlloc) {
      for (var gi0 = 0; gi0 < groups.length; gi0++) {
        if (groups[gi0].allocId === rAlloc) { gIdx = gi0; break; }
      }
    } else if (rLic && rCat && byLicMo[rLic + '|' + rCat + '|' + (rYm || '')] !== undefined) {
      gIdx = byLicMo[rLic + '|' + rCat + '|' + (rYm || '')];
    }

    if (gIdx !== -1 && !isExt && role === 'main' && groups[gIdx].mainRow) {
      var gm = agCleanChallan_(groups[gIdx].mainRow[7] || '');
      if (gm && rM && gm !== rM && groups[gIdx].baseId !== rBase && groups[gIdx].srcId !== rSrc) {
        gIdx = -1;
      }
    }

    if (gIdx === -1) {
      var ng = { firstOrder: idx, baseId: rBase || ('CHL-' + Date.now() + '-' + idx), srcId: rSrc, allocId: rAlloc, lic: rLic, cat: rCat, ym: rYm, mainRow: null, taxRow: null, vatRow: null };
      if (role === 'tax') ng.taxRow = r;
      else if (role === 'vat') ng.vatRow = r;
      else ng.mainRow = r;
      gIdx = groups.length;
      groups.push(ng);
      regG(gIdx, ng);
      regN(gIdx, r, role);
    } else {
      var g = groups[gIdx];
      if (idx < g.firstOrder) g.firstOrder = idx;
      if (!g.srcId && rSrc) g.srcId = rSrc;
      if (!g.allocId && rAlloc) g.allocId = rAlloc;
      if (!g.ym && rYm) g.ym = rYm;
      if (isExt) {
        removedRows.push([nowStr, sh.getName() + ':' + (idx + 2), rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
        var dest = (role === 'vat') ? (g.vatRow || new Array(width)) : (g.taxRow || g.mainRow || new Array(width));
        if (role === 'vat') {
          if (!dest[18] && rM) dest[18] = rM;
          if (!dest[19] && (r[19] || r[8] || r[1])) dest[19] = r[19] || r[8] || r[1] || '';
          if (!dest[20] && (r[20] || r[11])) dest[20] = r[20] || r[11] || '';
          g.vatRow = dest;
        } else {
          if (!dest[12] && rM) dest[12] = rM;
          if (!dest[13] && (r[13] || r[8] || r[1])) dest[13] = r[13] || r[8] || r[1] || '';
          if (!dest[14] && (r[14] || r[11])) dest[14] = r[14] || r[11] || '';
          var extTComment = (!agIsIsoTs_(r[16]) ? r[16] : '') || r[15] || '';
          if (!dest[16] && extTComment) dest[16] = extTComment;
          if (!g.taxRow && !g.mainRow) g.mainRow = dest;
        }
      } else if (role === 'tax') {
        if (!g.taxRow) g.taxRow = r;
        else {
          removedRows.push([nowStr, sh.getName() + ':' + (idx + 2), rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
          for (var c1 = 0; c1 < r.length; c1++) if (!String(g.taxRow[c1] || '').trim() && String(r[c1] || '').trim()) g.taxRow[c1] = r[c1];
        }
      } else if (role === 'vat') {
        if (!g.vatRow) g.vatRow = r;
        else {
          removedRows.push([nowStr, sh.getName() + ':' + (idx + 2), rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
          for (var c2 = 0; c2 < r.length; c2++) if (!String(g.vatRow[c2] || '').trim() && String(r[c2] || '').trim()) g.vatRow[c2] = r[c2];
        }
      } else {
        if (!g.mainRow) g.mainRow = r;
        else {
          removedRows.push([nowStr, sh.getName() + ':' + (idx + 2), rId, rawM, r[12] || '', r[18] || '', r.join(' | ')]);
          for (var c3 = 0; c3 < r.length; c3++) if (!String(g.mainRow[c3] || '').trim() && String(r[c3] || '').trim()) g.mainRow[c3] = r[c3];
        }
      }
      regG(gIdx, g);
      regN(gIdx, r, role);
    }
  }

  groups.sort(function(a, b) { return a.firstOrder - b.firstOrder; });
  var outRows = [];
  for (var x = 0; x < groups.length; x++) {
    var pairRows = agSplitLegacyAndPair_(groups[x], width);
    for (var b = 0; b < pairRows.length; b++) outRows.push(pairRows[b]);
  }

  var changed = outRows.length !== vals.length;
  if (!changed) {
    for (var ri = 0; ri < outRows.length; ri++) {
      for (var ci = 0; ci < width; ci++) {
        if (String(outRows[ri][ci] || '') !== String(vals[ri][ci] || '')) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  if (removedRows.length > 0) {
    var bk = agGetOrCreateHiddenSheet_(ss, ANDROID_GUARD_BACKUP_TAB, ['deletedAt', 'originalRow', 'id', 'challanNo', 'incomeTaxChallanNo', 'vatChallanNo', 'snapshot']);
    bk.getRange(bk.getLastRow() + 1, 1, removedRows.length, 7).setValues(removedRows);
  }

  if (changed) {
    sh.getRange(2, 1, lastRow - 1, width).clearContent();
    if (outRows.length > 0) {
      sh.getRange(2, 1, outRows.length, width).setValues(outRows);
      [2, 9, 14, 20].forEach(function(colIdx) {
        sh.getRange(2, colIdx, outRows.length, 1).setNumberFormat('yyyy-mm-dd');
      });
    }
    SpreadsheetApp.flush();
  }

  var restored = agRestoreMissingForSheet_(ss, sh);
  if (restored > 0) {
    var again = agCleanAndProtectSheet_(ss, sh);
    return { removed: removedRows.length + again.removed, restored: restored + again.restored };
  }
  agSaveSnapshotForSheet_(ss, sh);
  return { removed: removedRows.length, restored: restored };
}

function androidGuardRunCheck_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return;
  try {
    var ss = agTargetSpreadsheet_();
    var sheets = agGetTargetSheets_(ss);
    for (var s = 0; s < sheets.length; s++) {
      agCleanAndProtectSheet_(ss, sheets[s]);
    }
  } finally {
    lock.releaseLock();
  }
}

function androidGuardOnEdit(e) {
  androidGuardRunCheck_();
}

function androidGuardOnChange(e) {
  androidGuardRunCheck_();
}

function androidGuardEveryMinute() {
  androidGuardRunCheck_();
}

function disableLegacySyncTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = [];
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (/^(sync|autoSync|syncChallan|syncAll|pushTo|updateChallan|buildCache|rebuild)/i.test(fn)) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed.push(fn);
    }
  }
  return removed.length > 0
    ? 'পুরোনো অটো-সিঙ্ক ট্রিগার বন্ধ করা হয়েছে: ' + removed.join(', ')
    : 'এই প্রজেক্টে পুরোনো কোনো অটো-সিঙ্ক ট্রিগার পাওয়া যায়নি (Triggers মেনুতে গিয়ে নিজ চোখে দেখে নিশ্চিত হতে পারেন)।';
}

function installAndroidChallanRowGuard() {
  var ss = agTargetSpreadsheet_();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'androidGuardOnEdit' || fn === 'androidGuardOnChange' || fn === 'androidGuardEveryMinute') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('androidGuardOnEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('androidGuardOnChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('androidGuardEveryMinute').timeBased().everyMinutes(1).create();
  var sheets = agGetTargetSheets_(ss);
  var totalRemoved = 0, totalRestored = 0;
  for (var s = 0; s < sheets.length; s++) {
    var res = agCleanAndProtectSheet_(ss, sheets[s]);
    totalRemoved += res.removed;
    totalRestored += res.restored;
  }
  return 'সুরক্ষা চালু সম্পন্ন! পরিষ্কারকৃত অতিরিক্ত সারি: ' + totalRemoved + 'টি, পুনরুদ্ধারকৃত চালান: ' + totalRestored + 'টি।';
}`;
}



