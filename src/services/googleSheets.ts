import type {
  AppSettings,
  ChallanRecord,
  DealerRecord,
  DoIssueRecord,
  SuballocationRecord,
} from '../types.ts';
import { apiFetch } from '../utils/api.ts';
import {
  extractSpreadsheetId,
  normalizeChallanNo,
  toSheetSlashDate,
} from '../utils/challan.ts';
import {
  colLetterToIndex,
  parseChallansFromRows,
  parseDealersFromRows,
  parseDoIssuesFromRows,
  parseSuballocationsFromRows,
} from '../utils/sheetParser.ts';
import { clearGoogleAccessToken, getGoogleAccessToken } from './googleAuth.ts';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface SheetSyncPayload {
  dealers: DealerRecord[] | null;
  suballocations: SuballocationRecord[] | null;
  doIssues: DoIssueRecord[] | null;
  challans: ChallanRecord[] | null;
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
    throw new Error('Google সাইন-ইন সেশনের মেয়াদ শেষ হয়েছে — পুনরায় সাইন-ইন করুন।');
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
  if (availableTabs.includes(settings.challanTabName)) {
    const rows = await fetchSheetValues(
      cleanId,
      `${settings.challanTabName}!A:AD`,
      token
    );
    challans = parseChallansFromRows(
      rows,
      dealersList,
      settings,
      suballocations || [],
      doIssues || []
    );
  }

  return { dealers, suballocations, doIssues, challans, availableTabs };
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
  };
  message?: string;
}> {
  const res = await apiFetch('/api/sync/public-sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings || {}),
  });
  const json = (await res.json()) as {
    success: boolean;
    counts?: {
      dealers: number;
      suballocations: number;
      records: number;
      removedRecords?: number;
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
  customFields?: Record<string, string>;
  comment: string;
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
      ? 'Google OAuth ও লগইন-ছাড়া Apps Script উভয় সক্রিয়'
      : oauthReady
      ? 'Google OAuth শিট সংযুক্ত'
      : gasReady
      ? 'লগইন-ছাড়া Apps Script ব্রিজ সক্রিয়'
      : hasSheetId
      ? 'শুধু সরাসরি শিট পড়া (Sync) সক্রিয় — পুশ/এডিট/ডিলিট করতে Apps Script বা Google সাইন-ইন যুক্ত করুন'
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
  const hasMain = Boolean(r.challanNo || r.amount);
  const hasTax = Boolean(r.incomeTaxChallanNo || r.incomeTaxAmount);
  const hasVat = Boolean(r.vatChallanNo || r.vatAmount);
  const scanType: SheetChallanEntry['scanType'] = hasMain
    ? hasTax || hasVat
      ? 'main'
      : 'single'
    : hasTax
    ? 'tax'
    : hasVat
    ? 'vat'
    : 'single';

  return {
    scanType,
    id: r.id || r.recordId || `CHL-${r.serialNo}`,
    date: r.challanDate || r.incomeTaxDate || r.vatDate || r.date || '',
    department: r.department || r.toOrganization || '',
    category: r.challanCategory || '',
    sourceMemo: r.sourceMemo || '',
    dcMemo: r.dcMemo || '',
    dealerAllocationId: r.dealerAllocationId || '',
    dealerName: r.dealerName || '',
    unionName: r.unionName || '',
    licenseActionType: r.licenseActionType || '',
    expectedAmount: r.expectedAmount || '',
    expectedTaxAmount: r.expectedTaxAmount || '',
    challanNo: r.challanNo ? normalizeChallanNo(r.challanNo) : '',
    challanDate: r.challanDate || '',
    rate: r.rate || '',
    quantity: r.quantity || '',
    totalAmount: r.amount || '',
    incomeTaxChallanNo: r.incomeTaxChallanNo
      ? normalizeChallanNo(r.incomeTaxChallanNo)
      : '',
    incomeTaxDate: r.incomeTaxDate || '',
    incomeTaxAmount: r.incomeTaxAmount || '',
    vatChallanNo: r.vatChallanNo ? normalizeChallanNo(r.vatChallanNo) : '',
    vatDate: r.vatDate || '',
    vatAmount: r.vatAmount || '',
    licenseNo: r.licenseNo || '',
    new37Code: r.new37Code || '',
    customFields: r.customFields || {},
    comment:
      r.comment ||
      [r.licenseActionType, r.description].filter(Boolean).join(' | '),
    createdAt: r.entryTime || new Date().toISOString(),
    srcRecordId: r.recordId || '',
    ...(options?.overwrite ? { overwrite: true } : {}),
    ...(options?.matchHints ? { matchHints: options.matchHints } : {}),
  };
}

function findMatchingSheetRowIndex(
  existingRows: string[][],
  entry: SheetChallanEntry,
  options?: { strictForDelete?: boolean }
): number {
  const hints = entry.matchHints;
  const entryNo = entry.challanNo ? normalizeChallanNo(entry.challanNo) : '';
  const entryTaxNo = entry.incomeTaxChallanNo
    ? normalizeChallanNo(entry.incomeTaxChallanNo)
    : '';
  const entryVatNo = entry.vatChallanNo
    ? normalizeChallanNo(entry.vatChallanNo)
    : '';

  const hintNo = hints?.challanNo ? normalizeChallanNo(hints.challanNo) : '';
  const hintTaxNo = hints?.incomeTaxChallanNo
    ? normalizeChallanNo(hints.incomeTaxChallanNo)
    : '';
  const hintVatNo = hints?.vatChallanNo
    ? normalizeChallanNo(hints.vatChallanNo)
    : '';

  const canFillSlot = (
    rowChallanNo: string,
    rowTaxNo: string,
    rowVatNo: string
  ): boolean => {
    if (entry.overwrite || options?.strictForDelete) return true;
    if (entryNo && rowChallanNo && rowChallanNo !== entryNo) return false;
    if (!entryNo && entryTaxNo && rowTaxNo && rowTaxNo !== entryTaxNo) {
      return false;
    }
    if (
      !entryNo &&
      !entryTaxNo &&
      entryVatNo &&
      rowVatNo &&
      rowVatNo !== entryVatNo
    ) {
      return false;
    }
    return true;
  };

  for (let i = 1; i < existingRows.length; i++) {
    const row = existingRows[i] || [];
    const rowId = String(row[0] || '').trim();
    const rowCat = String(row[3] || '').trim();
    const rowAllocId = String(row[6] || '').trim();
    const rowChallanNo = row[7] ? normalizeChallanNo(String(row[7])) : '';
    const rowTaxNo = row[12] ? normalizeChallanNo(String(row[12])) : '';
    const rowSrcId = String(row[17] || '').trim();
    const rowVatNo = row[18] ? normalizeChallanNo(String(row[18])) : '';
    const rowLicenseNo = String(row[21] || '').trim();

    if (entry.srcRecordId && rowSrcId && rowSrcId === entry.srcRecordId) {
      return i + 1;
    }
    if (hints?.srcRecordId && rowSrcId && rowSrcId === hints.srcRecordId) {
      return i + 1;
    }
    if (entry.id && rowId && rowId === entry.id) {
      return i + 1;
    }
    if (hints?.id && rowId && rowId === hints.id) {
      return i + 1;
    }
    if (entryNo && rowChallanNo && rowChallanNo === entryNo) {
      return i + 1;
    }
    if (hintNo && rowChallanNo && rowChallanNo === hintNo) {
      return i + 1;
    }
    if (entryTaxNo && rowTaxNo && rowTaxNo === entryTaxNo && !entryNo) {
      return i + 1;
    }
    if (hintTaxNo && rowTaxNo && rowTaxNo === hintTaxNo) {
      return i + 1;
    }
    if (entryVatNo && rowVatNo && rowVatNo === entryVatNo && !entryNo && !entryTaxNo) {
      return i + 1;
    }
    if (hintVatNo && rowVatNo && rowVatNo === hintVatNo) {
      return i + 1;
    }
    if (
      !options?.strictForDelete &&
      entry.dealerAllocationId &&
      rowAllocId &&
      rowAllocId === entry.dealerAllocationId &&
      canFillSlot(rowChallanNo, rowTaxNo, rowVatNo)
    ) {
      return i + 1;
    }
    if (
      !options?.strictForDelete &&
      entry.licenseNo &&
      rowLicenseNo &&
      rowLicenseNo === entry.licenseNo &&
      rowCat === entry.category &&
      canFillSlot(rowChallanNo, rowTaxNo, rowVatNo)
    ) {
      return i + 1;
    }
  }
  return -1;
}

function buildSheetRowValues(
  settings: AppSettings,
  entry: SheetChallanEntry,
  cur: string[] = []
): string[] {
  const row: string[] = new Array(23).fill('');
  for (let k = 0; k < Math.min(cur.length, 30); k++) {
    row[k] = cur[k] ?? '';
  }
  const ow = Boolean(entry.overwrite);

  row[0] = cur[0] || entry.id;
  row[1] = ow ? toSheetSlashDate(entry.date) || cur[1] || '' : cur[1] || toSheetSlashDate(entry.date);
  row[2] = ow ? entry.department : entry.department || cur[2] || '';
  row[3] = ow ? entry.category : entry.category || cur[3] || '';
  row[4] = ow ? entry.sourceMemo : entry.sourceMemo || cur[4] || '';
  row[5] = ow ? entry.dcMemo : entry.dcMemo || cur[5] || '';
  row[6] = ow ? entry.dealerAllocationId : entry.dealerAllocationId || cur[6] || '';
  row[7] = ow
    ? entry.challanNo ? normalizeChallanNo(entry.challanNo) : ''
    : entry.challanNo ? normalizeChallanNo(entry.challanNo) : cur[7] || '';
  row[8] = ow
    ? entry.challanDate ? toSheetSlashDate(entry.challanDate) : ''
    : entry.challanDate ? toSheetSlashDate(entry.challanDate) : cur[8] || '';
  row[9] = ow ? entry.rate : entry.rate || cur[9] || '';
  row[10] = ow ? entry.quantity : entry.quantity || cur[10] || '';
  row[11] = ow ? entry.totalAmount : entry.totalAmount || cur[11] || '';
  row[12] = ow
    ? entry.incomeTaxChallanNo ? normalizeChallanNo(entry.incomeTaxChallanNo) : ''
    : entry.incomeTaxChallanNo ? normalizeChallanNo(entry.incomeTaxChallanNo) : cur[12] || '';
  row[13] = ow
    ? entry.incomeTaxDate ? toSheetSlashDate(entry.incomeTaxDate) : ''
    : entry.incomeTaxDate ? toSheetSlashDate(entry.incomeTaxDate) : cur[13] || '';
  row[14] = ow ? entry.incomeTaxAmount : entry.incomeTaxAmount || cur[14] || '';
  row[15] = ow ? entry.comment : entry.comment || cur[15] || '';
  row[16] = cur[16] || entry.createdAt;
  row[17] = cur[17] || entry.srcRecordId;
  row[18] = ow
    ? entry.vatChallanNo ? normalizeChallanNo(entry.vatChallanNo) : ''
    : entry.vatChallanNo ? normalizeChallanNo(entry.vatChallanNo) : cur[18] || '';
  row[19] = ow
    ? entry.vatDate ? toSheetSlashDate(entry.vatDate) : ''
    : entry.vatDate ? toSheetSlashDate(entry.vatDate) : cur[19] || '';
  row[20] = ow ? entry.vatAmount || '' : entry.vatAmount || cur[20] || '';
  row[21] = ow ? entry.licenseNo || '' : entry.licenseNo || cur[21] || '';
  row[22] = ow ? entry.new37Code || '' : entry.new37Code || cur[22] || '';

  for (const colDef of settings.customColumns || []) {
    const idx = colLetterToIndex(colDef.sheetColumn);
    if (idx >= 0) {
      while (row.length <= idx) row.push('');
      const val = entry.customFields?.[colDef.id];
      if (ow) {
        row[idx] = val || '';
      } else if (val) {
        row[idx] = val;
      }
    }
  }
  return row;
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

  const availableTabs = await getSpreadsheetTabs(sheetId, token);
  if (!availableTabs.includes(tab)) {
    throw new Error(
      `Google Sheet-এ "${tab}" ট্যাবটি পাওয়া যায়নি। (বিদ্যমান ট্যাব: ${availableTabs.join(', ')})`
    );
  }

  const existingRows = await fetchSheetValues(sheetId, `${tab}!A:AD`, token);
  const matchRowIndex = findMatchingSheetRowIndex(existingRows, entry);

  let resultInfo: { mode: 'updated' | 'appended'; rowNumber: number };

  if (matchRowIndex > 0) {
    const cur = existingRows[matchRowIndex - 1] || [];
    const mergedRow = buildSheetRowValues(settings, entry, cur);
    const updateUrl = `${SHEETS_API}/${encodeURIComponent(
      sheetId
    )}/values/${encodeURIComponent(
      `${tab}!A${matchRowIndex}:AD${matchRowIndex}`
    )}?valueInputOption=USER_ENTERED`;

    const res = await fetch(updateUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [mergedRow] }),
    });
    if (!res.ok) {
      await throwGoogleApiError(res, 'Google Sheet আপডেট ব্যর্থ');
    }
    resultInfo = { mode: 'updated', rowNumber: matchRowIndex };
  } else {
    const newRow = buildSheetRowValues(settings, entry);
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
      body: JSON.stringify({ values: [newRow] }),
    });
    if (!res.ok) {
      await throwGoogleApiError(res, 'Google Sheet সংরক্ষণ ব্যর্থ');
    }
    resultInfo = { mode: 'appended', rowNumber: existingRows.length + 1 };
  }

  const vatTab = settings.separateVatTabName?.trim();
  if (vatTab && entry.vatChallanNo && availableTabs.includes(vatTab)) {
    const vatRow = [
      entry.id,
      toSheetSlashDate(entry.vatDate || entry.date),
      entry.category,
      entry.dealerName || '',
      entry.licenseNo || '',
      normalizeChallanNo(entry.vatChallanNo),
      entry.vatAmount || '',
      entry.new37Code || '',
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
  }

  return resultInfo;
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
  const matchRowIndex = findMatchingSheetRowIndex(existingRows, entry, {
    strictForDelete: true,
  });

  if (matchRowIndex <= 1) {
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
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: targetSheet.sheetId,
                dimension: 'ROWS',
                startIndex: matchRowIndex - 1,
                endIndex: matchRowIndex,
              },
            },
          },
        ],
      }),
    }
  );
  if (!deleteRes.ok) {
    await throwGoogleApiError(deleteRes, 'Google Sheet থেকে সারি মোছা যায়নি');
  }

  const vatTab = settings.separateVatTabName?.trim();
  const vatSheet = vatTab ? sheetProps.find((s) => s.title === vatTab) : undefined;
  if (vatSheet && (record.vatChallanNo || record.id)) {
    try {
      const vatRows = await fetchSheetValues(sheetId, `${vatTab}!A:I`, token);
      const vatNo = record.vatChallanNo
        ? normalizeChallanNo(record.vatChallanNo)
        : '';
      const vatIdx = vatRows.findIndex(
        (r, i) =>
          i > 0 &&
          ((record.id && String(r[0] || '').trim() === record.id) ||
            (vatNo && r[5] && normalizeChallanNo(String(r[5])) === vatNo))
      );
      if (vatIdx > 0) {
        await fetch(
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
                      sheetId: vatSheet.sheetId,
                      dimension: 'ROWS',
                      startIndex: vatIdx,
                      endIndex: vatIdx + 1,
                    },
                  },
                },
              ],
            }),
          }
        );
      }
    } catch {
      // Optional VAT log delete is best-effort
    }
  }

  return { deleted: true, rowNumber: matchRowIndex };
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
  const existingRows = await fetchSheetValues(sheetId, `${tab}!A:AD`, token);

  const updates: Array<{ range: string; values: string[][] }> = [];
  const appends: string[][] = [];

  for (const entry of entries) {
    const matchRowIndex = findMatchingSheetRowIndex(existingRows, entry);
    if (matchRowIndex > 0) {
      const cur = existingRows[matchRowIndex - 1] || [];
      const merged = buildSheetRowValues(settings, entry, cur);
      existingRows[matchRowIndex - 1] = merged;
      updates.push({
        range: `${tab}!A${matchRowIndex}:AD${matchRowIndex}`,
        values: [merged],
      });
    } else {
      const created = buildSheetRowValues(settings, entry);
      existingRows.push(created);
      appends.push(created);
    }
  }

  if (updates.length > 0) {
    const batchRes = await fetch(
      `${SHEETS_API}/${encodeURIComponent(sheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: updates,
        }),
      }
    );
    if (!batchRes.ok) {
      await throwGoogleApiError(batchRes, 'ব্যাচ আপডেট ব্যর্থ');
    }
  }

  if (appends.length > 0) {
    const appendRes = await fetch(
      `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(
        `${tab}!A:AD`
      )}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: appends }),
      }
    );
    if (!appendRes.ok) {
      await throwGoogleApiError(appendRes, 'ব্যাচ সংরক্ষণ ব্যর্থ');
    }
  }

  return { updated: updates.length, appended: appends.length };
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
      };
    };
  };
  if (!res.ok || !json.success) {
    throw new Error(json.message || 'Apps Script ব্রিজ থেকে তথ্য আনা যায়নি।');
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
      dealersList.push(...parseDealersFromRows(raw.tabs.foodDealers, 'খাদ্য বান্ধব'));
    }
    if (hasOmsTab && raw.tabs.omsDealers) {
      dealersList.push(...parseDealersFromRows(raw.tabs.omsDealers, 'ওএমএস সাধারণ'));
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
    return {
      dealers: hasFoodTab || hasOmsTab ? dealersList : null,
      suballocations,
      doIssues,
      challans,
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
    | 'deleteChallan' = 'saveChallan'
): Promise<{
  message?: string;
  updated?: number;
  appended?: number;
  deleted?: boolean;
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
      deleted?: boolean;
    };
  };
  if (!res.ok || !json.success) {
    throw new Error(
      json.message || 'Apps Script ব্রিজে তথ্য পাঠানো যায়নি।'
    );
  }
  return json.data || { message: json.message };
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

  const entries = records.map((r) =>
    challanRecordToSheetEntry(r, options)
  );
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
        const res = await batchPushChallansToGoogleSheetOAuth(settings, entries);
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

  if (cap.gasReady) {
    const gasUrl = settings.gasWebAppUrl.trim();
    try {
      if (entries.length === 1) {
        const gasAction = options?.overwrite ? 'saveChallan' : 'saveChallan';
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
      notes.push(res.message || 'Apps Script দিয়ে শিট থেকে মোছা হয়েছে');
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

export function generateGoogleAppsScriptCode(settings: AppSettings): string {
  const spreadsheetId = extractSpreadsheetId(settings.spreadsheetId || '');
  const challanTab = settings.challanTabName?.trim() || 'Challan';
  const subTab = settings.suballocationTabName?.trim() || 'DealerSuballocations';
  const foodTab = settings.foodDealerTabName?.trim() || 'Dealers';
  const omsTab = settings.omsDealerTabName?.trim() || 'OMS_Dealers';
  const doTab = settings.doIssueTabName?.trim() || 'DO_Issue';
  const vatTab = settings.separateVatTabName?.trim() || '';
  const customCols = (settings.customColumns || []).map((c) => ({
    id: c.id,
    label: c.label,
    colIndex: colLetterToIndex(c.sheetColumn),
  }));

  return `// Google Apps Script Web App Bridge (Code.gs)
// কোথায় বসাবেন: আপনার Google Sheet খুলুন > Extensions > Apps Script > Code.gs-এ পেস্ট করুন
// ডিপ্লয়: Deploy > New deployment (অথবা Manage deployments > New version) > Execute as: Me | Who has access: Anyone

const SPREADSHEET_ID = ${JSON.stringify(spreadsheetId)};
const TAB_CHALLAN = ${JSON.stringify(challanTab)};
const TAB_SUBALLOC = ${JSON.stringify(subTab)};
const TAB_FOOD_DEALER = ${JSON.stringify(foodTab)};
const TAB_OMS_DEALER = ${JSON.stringify(omsTab)};
const TAB_DO_ISSUE = ${JSON.stringify(doTab)};
const TAB_VAT = ${JSON.stringify(vatTab)};
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
  return String(val || '').replace(/[০-৯]/g, function(ch) {
    var idx = bn.indexOf(ch);
    return idx >= 0 ? String(idx) : ch;
  });
}

function toSlashDate(val) {
  var s = toAsciiDigits(val).trim();
  var m = s.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  return s;
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

function findMatchRowInSheet(sh, entry, strictDelete) {
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) return -1;
  var values = sh.getRange(2, 1, lastRow - 1, 30).getDisplayValues();
  var hints = entry.matchHints || {};

  var eChallan = toAsciiDigits(entry.challanNo || '').trim();
  var eTaxNo = toAsciiDigits(entry.incomeTaxChallanNo || '').trim();
  var eVatNo = toAsciiDigits(entry.vatChallanNo || '').trim();
  var hChallan = toAsciiDigits(hints.challanNo || '').trim();
  var hTaxNo = toAsciiDigits(hints.incomeTaxChallanNo || '').trim();
  var hVatNo = toAsciiDigits(hints.vatChallanNo || '').trim();

  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var rId = String(r[0] || '').trim();
    var rCat = String(r[3] || '').trim();
    var rAlloc = String(r[6] || '').trim();
    var rChallanNo = toAsciiDigits(r[7] || '').trim();
    var rTaxNo = toAsciiDigits(r[12] || '').trim();
    var rSrcId = String(r[17] || '').trim();
    var rVatNo = toAsciiDigits(r[18] || '').trim();
    var rLic = String(r[21] || '').trim();

    var slotConflict = !entry.overwrite && !strictDelete && (
      (eChallan && rChallanNo && rChallanNo !== eChallan) ||
      (!eChallan && eTaxNo && rTaxNo && rTaxNo !== eTaxNo) ||
      (!eChallan && !eTaxNo && eVatNo && rVatNo && rVatNo !== eVatNo)
    );

    if (entry.srcRecordId && rSrcId === entry.srcRecordId) return i + 2;
    if (hints.srcRecordId && rSrcId === hints.srcRecordId) return i + 2;
    if (entry.id && rId === entry.id) return i + 2;
    if (hints.id && rId === hints.id) return i + 2;
    if (eChallan && rChallanNo === eChallan) return i + 2;
    if (hChallan && rChallanNo === hChallan) return i + 2;
    if (eTaxNo && !eChallan && rTaxNo === eTaxNo) return i + 2;
    if (hTaxNo && rTaxNo === hTaxNo) return i + 2;
    if (eVatNo && !eChallan && !eTaxNo && rVatNo === eVatNo) return i + 2;
    if (hVatNo && rVatNo === hVatNo) return i + 2;
    if (!strictDelete && !slotConflict && entry.dealerAllocationId && rAlloc === entry.dealerAllocationId) return i + 2;
    if (!strictDelete && !slotConflict && entry.licenseNo && rLic === entry.licenseNo && rCat === entry.category) return i + 2;
  }
  return -1;
}

function upsertChallanRow(sh, entry) {
  var matchRow = findMatchRowInSheet(sh, entry, false);
  var cur = matchRow > 0 ? sh.getRange(matchRow, 1, 1, 30).getDisplayValues()[0] : [];
  var ow = Boolean(entry.overwrite);
  var row = new Array(23);
  for (var k = 0; k < 23; k++) row[k] = cur[k] || '';

  var eChallan = toAsciiDigits(entry.challanNo || '').trim();
  var eTaxNo = toAsciiDigits(entry.incomeTaxChallanNo || '').trim();
  var eVatNo = toAsciiDigits(entry.vatChallanNo || '').trim();

  row[0] = cur[0] || entry.id || ('CHL-' + Date.now());
  row[1] = ow ? (toSlashDate(entry.date || '') || cur[1] || '') : (cur[1] || toSlashDate(entry.date || ''));
  row[2] = ow ? (entry.department || '') : (entry.department || cur[2] || '');
  row[3] = ow ? (entry.category || '') : (entry.category || cur[3] || '');
  row[4] = ow ? (entry.sourceMemo || '') : (entry.sourceMemo || cur[4] || '');
  row[5] = ow ? (entry.dcMemo || '') : (entry.dcMemo || cur[5] || '');
  row[6] = ow ? (entry.dealerAllocationId || '') : (entry.dealerAllocationId || cur[6] || '');
  row[7] = ow ? eChallan : (eChallan || cur[7] || '');
  row[8] = ow ? toSlashDate(entry.challanDate || '') : (toSlashDate(entry.challanDate || '') || cur[8] || '');
  row[9] = ow ? (entry.rate || '') : (entry.rate || cur[9] || '');
  row[10] = ow ? (entry.quantity || '') : (entry.quantity || cur[10] || '');
  row[11] = ow ? (entry.totalAmount || '') : (entry.totalAmount || cur[11] || '');
  row[12] = ow ? eTaxNo : (eTaxNo || cur[12] || '');
  row[13] = ow ? toSlashDate(entry.incomeTaxDate || '') : (toSlashDate(entry.incomeTaxDate || '') || cur[13] || '');
  row[14] = ow ? (entry.incomeTaxAmount || '') : (entry.incomeTaxAmount || cur[14] || '');
  row[15] = ow ? (entry.comment || '') : (entry.comment || cur[15] || '');
  row[16] = cur[16] || entry.createdAt || new Date().toISOString();
  row[17] = cur[17] || entry.srcRecordId || '';
  row[18] = ow ? eVatNo : (eVatNo || cur[18] || '');
  row[19] = ow ? toSlashDate(entry.vatDate || '') : (toSlashDate(entry.vatDate || '') || cur[19] || '');
  row[20] = ow ? (entry.vatAmount || '') : (entry.vatAmount || cur[20] || '');
  row[21] = ow ? (entry.licenseNo || '') : (entry.licenseNo || cur[21] || '');
  row[22] = ow ? (entry.new37Code || '') : (entry.new37Code || cur[22] || '');

  for (var c = 0; c < CUSTOM_COLS.length; c++) {
    var colDef = CUSTOM_COLS[c];
    if (colDef.colIndex >= 0) {
      while (row.length <= colDef.colIndex) row.push('');
      var customVal = entry.customFields && entry.customFields[colDef.id];
      if (ow) {
        row[colDef.colIndex] = customVal || '';
      } else if (customVal) {
        row[colDef.colIndex] = customVal;
      } else if (cur[colDef.colIndex]) {
        row[colDef.colIndex] = cur[colDef.colIndex];
      }
    }
  }

  if (matchRow > 0) {
    sh.getRange(matchRow, 1, 1, row.length).setValues([row]);
    return { mode: 'updated', rowNumber: matchRow };
  }
  sh.appendRow(row);
  return { mode: 'appended', rowNumber: sh.getLastRow() };
}

function deleteChallanRow(ss, entry) {
  var sh = ss.getSheetByName(TAB_CHALLAN);
  if (!sh) return { deleted: false, message: 'Challan ট্যাব পাওয়া যায়নি' };
  var matchRow = findMatchRowInSheet(sh, entry, true);
  if (matchRow > 1) {
    sh.deleteRow(matchRow);
  }
  if (TAB_VAT) {
    var vSh = ss.getSheetByName(TAB_VAT);
    if (vSh && vSh.getLastRow() > 1) {
      var vVals = vSh.getRange(2, 1, vSh.getLastRow() - 1, 9).getDisplayValues();
      var vNo = toAsciiDigits(entry.vatChallanNo || '').trim();
      for (var i = vVals.length - 1; i >= 0; i--) {
        if ((entry.id && String(vVals[i][0] || '').trim() === entry.id) ||
            (vNo && toAsciiDigits(vVals[i][5] || '').trim() === vNo)) {
          vSh.deleteRow(i + 2);
        }
      }
    }
  }
  return {
    deleted: matchRow > 1,
    rowNumber: matchRow > 1 ? matchRow : null,
    message: matchRow > 1 ? ('সারি ' + matchRow + ' শিট থেকে মোছা হয়েছে') : 'শিটে সারিটি পাওয়া যায়নি'
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
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action || 'syncAll';
    var payload = body.payload || {};
    var ss = getTargetSpreadsheet();

    if (action === 'deleteChallan') {
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
        'comment','createdAt','srcRecordId','vatChallanNo','vatDate',
        'vatAmount','licenseNo','new37Code'
      ];
      var sh = getOrCreateSheet(ss, TAB_CHALLAN, headers);
      var entries = action === 'saveChallanBatch' ? (payload.entries || []) : [payload];
      var updated = 0, appended = 0;
      for (var i = 0; i < entries.length; i++) {
        var r = upsertChallanRow(sh, entries[i]);
        if (r.mode === 'updated') updated++; else appended++;
        if (TAB_VAT && entries[i].vatChallanNo) {
          var vSh = getOrCreateSheet(ss, TAB_VAT, ['id','vatDate','category','dealerName','licenseNo','vatChallanNo','vatAmount','new37Code','createdAt']);
          vSh.appendRow([
            entries[i].id || '', toSlashDate(entries[i].vatDate || entries[i].date || ''),
            entries[i].category || '', entries[i].dealerName || '',
            entries[i].licenseNo || '', entries[i].vatChallanNo || '',
            entries[i].vatAmount || '', entries[i].new37Code || '',
            entries[i].createdAt || new Date().toISOString()
          ]);
        }
      }
      return jsonOut({ success: true, updated: updated, appended: appended, message: 'Google Sheet আপডেট সম্পন্ন' });
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
        doIssues: readTab(TAB_DO_ISSUE)
      }
    });
  } catch (err) {
    return jsonOut({ success: false, message: String(err) });
  }
}`;
}
