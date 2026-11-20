import type {
  AppSettings,
  ChallanRecord,
  DealerRecord,
  DoIssueRecord,
  SuballocationRecord,
} from '../types.ts';
import {
  areSwappedMonthDayDates,
  buildDefaultCommissionTaxComment,
  cleanChallanNo,
  getCleanBaseRecordId,
  isSameYearMonth,
  normalizeChallanDate,
  normalizeChallanNo,
  splitTaxDepartmentAndExtra,
  toEnglishDigits,
  toNumericValue,
} from './challan.ts';

export function colLetterToIndex(col: string): number {
  const clean = col
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .trim();
  if (!clean) return -1;
  let idx = 0;
  for (let i = 0; i < clean.length; i++) {
    idx = idx * 26 + (clean.charCodeAt(i) - 64);
  }
  return idx - 1;
}

export function normalizeSheetCategory(
  rawCategory: string | null | undefined
): string {
  const s = String(rawCategory || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'ep চাল' || low === 'ep rice') return 'ইপি চাল';
  if (low === 'ep গম' || low === 'ep wheat') return 'ইপি গম';
  return s;
}

/** Parse RFC-4180 CSV text (handles quoted commas, escaped quotes, newlines inside quotes) */
export function parseCsvMatrix(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const text = csvText.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type SlashDateOrder = 'DMY' | 'MDY';

/**
 * একটি কলামের সব স্ল্যাশ-তারিখ পরীক্ষা করে দেখে কলামটি dd/MM/yyyy নাকি MM/dd/yyyy ফরম্যাটে আছে।
 * দিন > ১২ হলে নিশ্চিত DMY; দ্বিতীয় অংশ > ১২ হলে MDY; অন্যথায় অ্যাপের মানক DMY (dd/MM/yyyy)।
 */
export function detectColumnSlashFormat(
  values: Array<string | null | undefined>
): SlashDateOrder {
  let dmyEvidence = 0;
  let mdyEvidence = 0;
  for (const val of values) {
    const t = toEnglishDigits(val).trim();
    if (!t || /^\d{4}[\/\-.]/.test(t) || /^Date\(/i.test(t)) continue;
    const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
    if (!m) continue;
    const p1 = Number(m[1]);
    const p2 = Number(m[2]);
    if (p1 > 12 && p2 >= 1 && p2 <= 12) dmyEvidence++;
    else if (p2 > 12 && p1 >= 1 && p1 <= 12) mdyEvidence++;
  }
  if (mdyEvidence > 0 && dmyEvidence === 0) return 'MDY';
  return 'DMY';
}

function excelSerialToDisplay(serial: number): string {
  // Google Sheets / Excel epoch: Dec 30, 1899 UTC
  const utcMs = Math.round((serial - 25569) * 86400 * 1000);
  const dt = new Date(utcMs);
  if (Number.isNaN(dt.getTime())) return '';
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const y = dt.getUTCFullYear();
  return `${y}-${mo}-${d}`;
}

/**
 * Google Sheet থেকে পড়া তারিখ (yyyy-MM-dd, dd/MM/yyyy, বা column-level MDY) -> মানক yyyy-MM-dd।
 * দিন ১২ বা তার কম হলে আর কখনো অন্ধভাবে দিন ও মাস উল্টাবে না।
 */
export function parseGoogleSheetDateToDisplay(
  raw: string | null | undefined,
  preferredSlashOrder: SlashDateOrder = 'DMY'
): string {
  const t = toEnglishDigits(raw).trim();
  if (!t) return '';

  // 1) Google gviz Date(yyyy, zeroBasedMonth, day)
  const gviz = t.match(/^Date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})/);
  if (gviz) {
    const y = Number(gviz[1]);
    const mo = Number(gviz[2]) + 1;
    const d = Number(gviz[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // 2) ISO yyyy-MM-dd (or yyyy/MM/dd or yyyy-MM-ddTHH:mm...)
  const isoMatch = t.match(
    /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:$|T|\s)/
  );
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(
      2,
      '0'
    )}`;
  }

  // 3) Numeric spreadsheet serial date (e.g. 46275)
  if (/^\d{5}$/.test(t)) {
    const serial = Number(t);
    if (serial >= 25000 && serial <= 65000) {
      const converted = excelSerialToDisplay(serial);
      if (converted) return converted;
    }
  }

  // 4) Slash / dot / dash date
  const slashMatch = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/);
  if (slashMatch) {
    const p1 = Number(slashMatch[1]);
    const p2 = Number(slashMatch[2]);
    const year =
      slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3];

    if (p1 > 12 && p2 >= 1 && p2 <= 12) {
      return `${year}-${String(p2).padStart(2, '0')}-${String(p1).padStart(
        2,
        '0'
      )}`;
    }
    if (p2 > 12 && p1 >= 1 && p1 <= 12) {
      return `${year}-${String(p1).padStart(2, '0')}-${String(p2).padStart(
        2,
        '0'
      )}`;
    }
    if (p1 >= 1 && p1 <= 12 && p2 >= 1 && p2 <= 12) {
      if (preferredSlashOrder === 'MDY') {
        return `${year}-${String(p1).padStart(2, '0')}-${String(p2).padStart(
          2,
          '0'
        )}`;
      }
      return `${year}-${String(p2).padStart(2, '0')}-${String(p1).padStart(
        2,
        '0'
      )}`;
    }
  }

  return normalizeChallanDate(t);
}

export function parseDealersFromRows(
  rows: string[][],
  categoryLabel: string
): DealerRecord[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const idIdx = headers.indexOf('id') !== -1 ? headers.indexOf('id') : 0;
  const nameIdx =
    headers.indexOf('dealername') !== -1 ? headers.indexOf('dealername') : 1;
  const fatherIdx = headers.indexOf('fathername');
  const unionIdx =
    headers.indexOf('unionname') !== -1 ? headers.indexOf('unionname') : 5;
  const municipalityIdx = headers.indexOf('municipality');
  const centerIdx = headers.indexOf('salescenter');
  const categoryIdx = headers.indexOf('category');

  const out: DealerRecord[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dealerName = String(r[nameIdx] || '').trim();
    if (!dealerName) continue;
    const unionVal = String(r[unionIdx] || '').trim();
    const muniVal =
      municipalityIdx >= 0 ? String(r[municipalityIdx] || '').trim() : '';
    const catVal =
      categoryIdx >= 0 ? String(r[categoryIdx] || '').trim() : '';

    out.push({
      id: String(r[idIdx] || `DLR-${i}`).trim(),
      dealerName,
      fatherName: fatherIdx >= 0 ? String(r[fatherIdx] || '').trim() : '',
      unionName: unionVal || muniVal,
      salesCenter: centerIdx >= 0 ? String(r[centerIdx] || '').trim() : '',
      category: catVal || categoryLabel,
    });
  }
  return out;
}

export function parseSuballocationsFromRows(
  rows: string[][]
): SuballocationRecord[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const col = (name: string, fallback: number) => {
    const idx = headers.indexOf(name.toLowerCase());
    return idx !== -1 ? idx : fallback;
  };
  const findCol = (names: string[], fallback: number) => {
    const idx = headers.findIndex((h) => names.includes(h));
    return idx !== -1 ? idx : fallback;
  };

  const catIdx = findCol(['category', 'khat'], 0);
  const sourceMemoIdx = findCol(
    ['sourcememo', 'source_memo', 'dcmemo', 'dc_memo', 'উৎস স্মারক', 'ডিসি স্মারক'],
    1
  );
  const unoMemoIdx = findCol(
    [
      'unomemo',
      'uno_memo',
      'ucfmemo',
      'ucf_memo',
      'ইউসিএফ স্মারক',
      'উপ-বরাদ্দ স্মারক',
      'স্মারক',
    ],
    2
  );
  const dateIdx = findCol(['date', 'তারিখ'], 3);
  const dealerNameIdx = findCol(
    ['dealername', 'dealer', 'ডিলারের নাম'],
    4
  );
  const dealerIdIdx = headers.findIndex((h) =>
    ['dealerid', 'dealer_id'].includes(h)
  );
  const unionIdx = findCol(['unionname', 'union'], 5);

  const cardIdx = col('cardcount', 7);
  const unusedIdx = col('unusedcards', 8);
  const qtyIdx = col('allocationqty', 9);
  const totalIdx = col('totalamount', 10);
  const taxIdx = col('taxamount', 11);
  const createdIdx = col('createdat', 12);
  const idIdx = col('id', 13);

  const subDateOrder = detectColumnSlashFormat(
    rows.slice(1).map((r) => String(r[dateIdx] || ''))
  );

  const out: SuballocationRecord[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[idIdx] || '').trim();
    const totalAmount = toNumericValue(r[totalIdx]);
    const taxAmount = toNumericValue(r[taxIdx]);
    const dealerName = String(r[dealerNameIdx] || r[4] || r[1] || '').trim();

    if (!id && !dealerName && totalAmount === 0 && taxAmount === 0) continue;

    const createdAtVal = String(r[createdIdx] || '').trim();
    const rawDateVal = dateIdx >= 0 ? String(r[dateIdx] || '').trim() : '';
    const allocationDate = rawDateVal
      ? parseGoogleSheetDateToDisplay(rawDateVal, subDateOrder)
      : '';
    const sourceMemo =
      sourceMemoIdx >= 0 ? String(r[sourceMemoIdx] || '').trim() : '';
    const unoMemo = unoMemoIdx >= 0 ? String(r[unoMemoIdx] || '').trim() : '';

    out.push({
      id: id || `ds-row-${i + 1}`,
      dealerId: dealerIdIdx >= 0 ? String(r[dealerIdIdx] || '').trim() : '',
      dealerName,
      unionName: String(r[unionIdx] || r[5] || '').trim(),
      category: normalizeSheetCategory(String(r[catIdx] || r[0] || '').trim()),
      sourceMemo,
      unoMemo,
      allocationDate,
      cardCount: toNumericValue(r[cardIdx]),
      unusedCards: toNumericValue(r[unusedIdx]),
      allocationQty: toNumericValue(r[qtyIdx]),
      totalAmount,
      taxAmount,
      createdAt: createdAtVal || allocationDate || rawDateVal,
    });
  }
  return out;
}

export function parseDoIssuesFromRows(rows: string[][]): DoIssueRecord[] {
  if (rows.length < 2) return [];
  const doDateOrder = detectColumnSlashFormat(
    rows.slice(1).map((r) => String(r[1] || r[2] || ''))
  );
  const out: DoIssueRecord[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const col0 = String(r[0] || '').trim();
    const col1 = String(r[1] || '').trim();
    const col2 = String(r[2] || '').trim();

    const isShiftedLayout =
      !col0 &&
      Boolean(col1) &&
      /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(
        toEnglishDigits(col2)
      );

    let doNo = '';
    let issueDate = '';
    let category = '';
    let unionName = '';
    let recipientName = '';
    let dealerAllocationId = '';
    let challanNo = '';
    let taxChallanNo = '';
    let requiredAmount = 0;
    let requiredTaxAmount = 0;
    let createdAt = '';
    let id = '';

    if (isShiftedLayout) {
      doNo = toEnglishDigits(col1);
      issueDate = parseGoogleSheetDateToDisplay(col2, doDateOrder);
      category = String(r[3] || '').trim();
      unionName = String(r[7] || '').trim();
      recipientName = String(r[8] || '').trim();
      challanNo = normalizeChallanNo(String(r[11] || ''));
      taxChallanNo = normalizeChallanNo(String(r[12] || ''));
      createdAt = String(r[14] || '').trim();
      id = `do-shift-${i + 1}-${doNo}`;
    } else {
      doNo = toEnglishDigits(col0);
      issueDate = parseGoogleSheetDateToDisplay(col1, doDateOrder);
      category = String(r[2] || '').trim();
      unionName = String(r[3] || '').trim();
      recipientName = String(r[4] || '').trim();
      dealerAllocationId = String(r[11] || '').trim();
      challanNo = normalizeChallanNo(String(r[12] || ''));
      taxChallanNo = normalizeChallanNo(String(r[15] || ''));
      requiredAmount = toNumericValue(r[18]);
      requiredTaxAmount = toNumericValue(r[19]);
      createdAt = String(r[20] || '').trim();
      id = String(r[21] || `do-row-${i + 1}`).trim();
    }

    if (!challanNo) {
      for (const cell of r) {
        const s = toEnglishDigits(String(cell || '')).trim();
        if (/^\d{4}-\d{10,11}$/.test(s)) {
          challanNo = normalizeChallanNo(s);
          break;
        }
      }
    }

    if (!doNo && !challanNo && !dealerAllocationId) continue;

    out.push({
      id,
      doNo,
      issueDate,
      category,
      unionName,
      recipientName,
      dealerAllocationId,
      challanNo,
      taxChallanNo,
      requiredAmount,
      requiredTaxAmount,
      createdAt,
    });
  }
  return out;
}

export function matchDoIssueForChallan(
  record: Pick<
    ChallanRecord,
    'challanNo' | 'incomeTaxChallanNo' | 'dealerAllocationId' | 'challanCategory'
  >,
  doIssues: DoIssueRecord[]
): DoIssueRecord | undefined {
  if (!doIssues || doIssues.length === 0) return undefined;
  const mainNo = record.challanNo ? normalizeChallanNo(record.challanNo) : '';
  const taxNo = record.incomeTaxChallanNo
    ? normalizeChallanNo(record.incomeTaxChallanNo)
    : '';

  if (mainNo) {
    const byMain = doIssues.find(
      (d) =>
        (d.challanNo && normalizeChallanNo(d.challanNo) === mainNo) ||
        (d.taxChallanNo && normalizeChallanNo(d.taxChallanNo) === mainNo)
    );
    if (byMain) return byMain;
  }

  if (taxNo) {
    const byTax = doIssues.find(
      (d) =>
        (d.challanNo && normalizeChallanNo(d.challanNo) === taxNo) ||
        (d.taxChallanNo && normalizeChallanNo(d.taxChallanNo) === taxNo)
    );
    if (byTax) return byTax;
  }

  if (record.dealerAllocationId) {
    const byAlloc = doIssues.find(
      (d) =>
        d.dealerAllocationId === record.dealerAllocationId &&
        (!d.category ||
          !record.challanCategory ||
          d.category.trim() === record.challanCategory.trim())
    );
    if (byAlloc) return byAlloc;
  }

  return undefined;
}

export function parseChallansFromRows(
  rows: string[][],
  dealers: DealerRecord[],
  settings: AppSettings,
  suballocations: SuballocationRecord[] = [],
  doIssues: DoIssueRecord[] = []
): ChallanRecord[] {
  if (rows.length < 2) return [];
  const dataRows = rows.slice(1);
  const colBOrder = detectColumnSlashFormat(dataRows.map((r) => r[1]));
  const colIOrder = detectColumnSlashFormat(dataRows.map((r) => r[8]));
  const colNOrder = detectColumnSlashFormat(dataRows.map((r) => r[13]));
  const colTOrder = detectColumnSlashFormat(dataRows.map((r) => r[19]));

  const dealerById = new Map(dealers.map((d) => [d.id, d]));
  const dealerByName = new Map(
    dealers.map((d) => [d.dealerName.trim(), d])
  );
  const subById = new Map(suballocations.map((s) => [s.id, s]));
  const out: ChallanRecord[] = [];

  const hdr16 = String(rows[0]?.[16] || '').trim().toLowerCase();
  const hdr17 = String(rows[0]?.[17] || '').trim().toLowerCase();
  const hasCustomCol23 = (settings.customColumns || []).some(
    (c) => colLetterToIndex(c.sheetColumn) === 23
  );
  const hasCustomCol24 = (settings.customColumns || []).some(
    (c) => colLetterToIndex(c.sheetColumn) === 24
  );
  const hasCustomCol25 = (settings.customColumns || []).some(
    (c) => colLetterToIndex(c.sheetColumn) === 25
  );
  const hasCustomCol26 = (settings.customColumns || []).some(
    (c) => colLetterToIndex(c.sheetColumn) === 26
  );
  const isIsoTsLike = (val: string) =>
    /^\d{4}-\d{2}-\d{2}(?:T|\s+\d{2}:\d{2})/.test(val.trim());

  const hasNonEmptyRecord = (rec?: Record<string, string>) =>
    Boolean(rec && Object.values(rec).some((v) => Boolean(String(v || '').trim())));

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[0] || '').trim();
    let date = parseGoogleSheetDateToDisplay(String(r[1] || ''), colBOrder);
    const department = String(r[2] || '').trim();
    const category = normalizeSheetCategory(String(r[3] || ''));
    const sourceMemo = String(r[4] || '').trim();
    const dcMemo = String(r[5] || '').trim();
    const dealerAllocationId = String(r[6] || '').trim();
    const rawMainNo = String(r[7] || '').trim();
    const challanNo = cleanChallanNo(rawMainNo);
    const parsedChallanDate = parseGoogleSheetDateToDisplay(
      String(r[8] || ''),
      colIOrder
    );
    const rate = toEnglishDigits(String(r[9] || '')).replace(/,/g, '').trim();
    const quantity = toEnglishDigits(String(r[10] || '')).trim();
    const totalAmount = toEnglishDigits(String(r[11] || '')).replace(/,/g, '').trim();
    const rawTaxNo = String(r[12] || '').trim();
    const incomeTaxChallanNo = cleanChallanNo(rawTaxNo);
    const incomeTaxDate = parseGoogleSheetDateToDisplay(
      String(r[13] || ''),
      colNOrder
    );
    const incomeTaxAmount = toEnglishDigits(String(r[14] || '')).replace(/,/g, '').trim();
    const comment = String(r[15] || '').trim();

    const rawQ = String(r[16] || '').trim();
    const rawR = String(r[17] || '').trim();
    const legacyQIsCreatedAt =
      isIsoTsLike(rawQ) && !isIsoTsLike(rawR);

    const taxComment = legacyQIsCreatedAt || isIsoTsLike(rawQ) ? '' : rawQ;
    const createdAt = legacyQIsCreatedAt
      ? rawQ
      : rawR || (isIsoTsLike(rawQ) ? rawQ : '');
    const rawColX = !hasCustomCol23 ? String(r[23] || '').trim() : '';
    const srcRecordId =
      rawColX ||
      (legacyQIsCreatedAt
        ? rawR
        : !isIsoTsLike(rawR) && /^(?:CHL-|[0-9a-f]{8}-)/i.test(rawR)
          ? rawR
          : '');

    const rawVatNo = String(r[18] || '').trim();
    const vatChallanNo = cleanChallanNo(rawVatNo);
    const vatDate = parseGoogleSheetDateToDisplay(
      String(r[19] || ''),
      colTOrder
    );
    const vatAmount = toEnglishDigits(String(r[20] || '')).replace(/,/g, '').trim();
    const licenseNo = String(r[21] || '').trim();
    const rawNew37 = String(r[22] || '').trim();
    const rawColY = !hasCustomCol24 ? String(r[24] || '').trim() : '';
    const taxSplit = splitTaxDepartmentAndExtra(sourceMemo, rawNew37);
    const new37Code = rawNew37 || taxSplit.code || '';
    const rawColZ = !hasCustomCol25 ? String(r[25] || '').trim() : '';
    const rawColAA = !hasCustomCol26 ? String(r[26] || '').trim() : '';
    const taxCode =
      rawColZ || taxSplit.code || (!challanNo && incomeTaxChallanNo ? new37Code : '');
    const vatCode =
      rawColAA || (!challanNo && vatChallanNo ? taxSplit.code || new37Code : '');
    const cleanTaxDepartment = taxSplit.institution || sourceMemo;
    const taxExtra = rawColY || taxSplit.extra;

    const challanDate = parsedChallanDate || date;
    if (
      date &&
      parsedChallanDate &&
      areSwappedMonthDayDates(date, parsedChallanDate)
    ) {
      if (incomeTaxDate === parsedChallanDate || !incomeTaxDate) {
        date = parsedChallanDate;
      }
    }

    const customFields: Record<string, string> = {};
    for (const colDef of settings.customColumns || []) {
      const idx = colLetterToIndex(colDef.sheetColumn);
      if (idx >= 0 && r[idx] !== undefined) {
        customFields[colDef.id] = String(r[idx] || '').trim();
      }
    }

    if (!id && !challanNo && !incomeTaxChallanNo && !vatChallanNo) continue;

    const isExtRow = /^ch-ext-/i.test(id);
    const isExtTax = /^ch-ext-t-/i.test(id);
    const isExtVat = /^ch-ext-v-/i.test(id);
    const isTaxSuffix = /-TAX$/i.test(id);
    const isVatSuffix = /-VAT$/i.test(id);
    const baseId = !isExtRow ? getCleanBaseRecordId(id) : '';
    const effectiveRowDate =
      challanDate || incomeTaxDate || vatDate || date || '';

    const isExplicitVatRow =
      isExtVat ||
      isVatSuffix ||
      (Boolean(challanNo) && Boolean(vatChallanNo) && challanNo === vatChallanNo) ||
      (!challanNo && !incomeTaxChallanNo && Boolean(vatChallanNo));

    const isExplicitTaxRow =
      !isExplicitVatRow &&
      (isExtTax ||
        isTaxSuffix ||
        (Boolean(challanNo) &&
          Boolean(incomeTaxChallanNo) &&
          challanNo === incomeTaxChallanNo) ||
        (!challanNo && !vatChallanNo && Boolean(incomeTaxChallanNo)));

    // Find parent/partner in `out` (scan latest-first so nearby rows pair accurately)
    let parentIdx = -1;
    let detectedAsVatCompanion = isExplicitVatRow;
    let detectedAsTaxCompanion = isExplicitTaxRow;

    for (let p = out.length - 1; p >= 0; p--) {
      const cand = out[p];
      const candDate =
        cand.challanDate || cand.incomeTaxDate || cand.vatDate || cand.date || '';
      const candMain = cleanChallanNo(cand.challanNo);
      const candTax = cleanChallanNo(cand.incomeTaxChallanNo);
      const candVat = cleanChallanNo(cand.vatChallanNo);

      if (srcRecordId && cand.recordId === srcRecordId) {
        parentIdx = p;
        break;
      }
      if (baseId && cand.id && getCleanBaseRecordId(cand.id) === baseId) {
        parentIdx = p;
        break;
      }

      if (
        challanNo &&
        candTax &&
        candTax === challanNo &&
        candMain !== challanNo
      ) {
        parentIdx = p;
        detectedAsTaxCompanion = true;
        break;
      }
      if (
        challanNo &&
        candVat &&
        candVat === challanNo &&
        candMain !== challanNo
      ) {
        parentIdx = p;
        detectedAsVatCompanion = true;
        break;
      }
      if (challanNo && !isExplicitTaxRow && !isExplicitVatRow && candMain === challanNo) {
        parentIdx = p;
        break;
      }

      if (isExplicitTaxRow) {
        const rowTax = incomeTaxChallanNo || challanNo;
        if (rowTax && candTax && candTax === rowTax) {
          parentIdx = p;
          break;
        }
        if (
          dealerAllocationId &&
          cand.dealerAllocationId === dealerAllocationId &&
          isSameYearMonth(effectiveRowDate, candDate) &&
          (!candTax || candTax === rowTax)
        ) {
          parentIdx = p;
          break;
        }
        if (
          licenseNo &&
          cand.licenseNo === licenseNo &&
          (!category || cand.challanCategory === category) &&
          isSameYearMonth(effectiveRowDate, candDate) &&
          (!candTax || candTax === rowTax)
        ) {
          parentIdx = p;
          break;
        }
      } else if (isExplicitVatRow) {
        const rowVat = vatChallanNo || challanNo;
        if (rowVat && candVat && candVat === rowVat) {
          parentIdx = p;
          break;
        }
        if (
          dealerAllocationId &&
          cand.dealerAllocationId === dealerAllocationId &&
          isSameYearMonth(effectiveRowDate, candDate) &&
          (!candVat || candVat === rowVat)
        ) {
          parentIdx = p;
          break;
        }
        if (
          licenseNo &&
          cand.licenseNo === licenseNo &&
          (!category || cand.challanCategory === category) &&
          isSameYearMonth(effectiveRowDate, candDate) &&
          (!candVat || candVat === rowVat)
        ) {
          parentIdx = p;
          break;
        }
      } else {
        // Current row is Main (or ambiguous single row); check if cand is an orphan Tax/VAT-first row for same allocation + same month
        if (
          challanNo &&
          !candMain &&
          dealerAllocationId &&
          cand.dealerAllocationId === dealerAllocationId &&
          isSameYearMonth(effectiveRowDate, candDate)
        ) {
          parentIdx = p;
          break;
        }
        if (
          challanNo &&
          !candMain &&
          licenseNo &&
          cand.licenseNo === licenseNo &&
          (!category || cand.challanCategory === category) &&
          isSameYearMonth(effectiveRowDate, candDate)
        ) {
          parentIdx = p;
          break;
        }
      }
    }

    if (parentIdx !== -1) {
      const parent = out[parentIdx];
      if (detectedAsVatCompanion) {
        const rowVatNo = vatChallanNo || challanNo;
        if (rowVatNo && (!parent.vatChallanNo || isVatSuffix || vatChallanNo)) {
          parent.vatChallanNo = rowVatNo;
        }
        const nextVatDate = vatDate || challanDate || date;
        if (nextVatDate) parent.vatDate = nextVatDate;
        const nextVatAmt = vatAmount || totalAmount;
        if (nextVatAmt) parent.vatAmount = nextVatAmt;
        const nextVatCode = rawColAA || rawNew37 || vatCode;
        if (nextVatCode) parent.vatCode = nextVatCode;
        if (cleanTaxDepartment) {
          parent.taxDepartment = cleanTaxDepartment;
          parent.sourceMemo = cleanTaxDepartment;
        } else if (department && !parent.taxDepartment) {
          const splitFromDept = splitTaxDepartmentAndExtra(
            department,
            parent.vatCode
          );
          if (splitFromDept.institution) {
            parent.taxDepartment = splitFromDept.institution;
            parent.sourceMemo = splitFromDept.institution;
          }
        }
        if (taxComment || (!isExtRow && comment)) {
          parent.taxComment = taxComment || comment || parent.taxComment;
        }
        if (taxExtra) parent.taxExtra = taxExtra;
        if (hasNonEmptyRecord(customFields)) {
          parent.vatCustomFields = {
            ...(parent.vatCustomFields || {}),
            ...customFields,
          };
          parent.customFields = {
            ...customFields,
            ...(parent.customFields || {}),
          };
        }
        continue;
      }

      if (detectedAsTaxCompanion) {
        const rowTaxNo = incomeTaxChallanNo || challanNo;
        if (rowTaxNo && (!parent.incomeTaxChallanNo || isTaxSuffix || incomeTaxChallanNo)) {
          parent.incomeTaxChallanNo = rowTaxNo;
        }
        const nextTaxDate = incomeTaxDate || challanDate || date;
        if (nextTaxDate) parent.incomeTaxDate = nextTaxDate;
        const nextTaxAmt = incomeTaxAmount || totalAmount;
        if (nextTaxAmt) parent.incomeTaxAmount = nextTaxAmt;
        const nextTaxCode = rawColZ || rawNew37 || taxCode;
        if (nextTaxCode) parent.taxCode = nextTaxCode;
        if (cleanTaxDepartment) {
          parent.taxDepartment = cleanTaxDepartment;
          parent.sourceMemo = cleanTaxDepartment;
        } else if (department && !parent.taxDepartment) {
          const splitFromDept = splitTaxDepartmentAndExtra(
            department,
            parent.taxCode
          );
          if (splitFromDept.institution) {
            parent.taxDepartment = splitFromDept.institution;
            parent.sourceMemo = splitFromDept.institution;
          }
        }
        if (taxComment || (!isExtRow && comment)) {
          parent.taxComment = taxComment || comment || parent.taxComment;
        }
        if (!parent.taxComment) {
          parent.taxComment = buildDefaultCommissionTaxComment(
            parent.challanCategory || category,
            nextTaxDate || parent.incomeTaxDate || parent.challanDate || parent.date,
            rowTaxNo || parent.incomeTaxChallanNo
          );
        }
        if (taxExtra) parent.taxExtra = taxExtra;
        if (hasNonEmptyRecord(customFields)) {
          parent.taxCustomFields = {
            ...(parent.taxCustomFields || {}),
            ...customFields,
          };
          parent.customFields = {
            ...customFields,
            ...(parent.customFields || {}),
          };
        }
        continue;
      }

      // Otherwise current row is Main (or combined); upgrade/enrich parent
      if (!isExtRow && baseId && (!parent.id || /-(?:TAX|VAT)$/i.test(parent.id))) {
        parent.id = baseId;
      }
      if (!parent.date && date) parent.date = date;
      if (department) {
        parent.department = department;
        parent.toOrganization = department;
      }
      if (!parent.unionName && dealerAllocationId) {
        const ms = subById.get(dealerAllocationId);
        if (ms?.unionName) parent.unionName = ms.unionName;
        if (ms?.dealerName && !parent.dealerName) parent.dealerName = ms.dealerName;
      }
      if (!parent.dealerAllocationId && dealerAllocationId) {
        parent.dealerAllocationId = dealerAllocationId;
      }
      if (dcMemo) parent.dcMemo = dcMemo;
      if (challanNo && !parent.challanNo) parent.challanNo = challanNo;
      if (challanDate && !parent.challanDate) parent.challanDate = challanDate;
      if (rate && !parent.rate) parent.rate = rate;
      if (quantity && !parent.quantity) parent.quantity = quantity;
      if (totalAmount && !parent.amount) parent.amount = totalAmount;
      if (dealerAllocationId && !parent.expectedAmount) {
        const ms = subById.get(dealerAllocationId);
        if (ms && ms.totalAmount > 0) {
          parent.expectedAmount = String(ms.totalAmount);
        }
        if (ms && ms.taxAmount > 0 && !parent.expectedTaxAmount) {
          parent.expectedTaxAmount = String(ms.taxAmount);
        }
      }
      if (incomeTaxChallanNo && !parent.incomeTaxChallanNo) {
        parent.incomeTaxChallanNo = incomeTaxChallanNo;
      }
      if (incomeTaxDate && !parent.incomeTaxDate) {
        parent.incomeTaxDate = incomeTaxDate;
      }
      if (incomeTaxAmount && !parent.incomeTaxAmount) {
        parent.incomeTaxAmount = incomeTaxAmount;
      }
      if (vatChallanNo && !parent.vatChallanNo) parent.vatChallanNo = vatChallanNo;
      if (vatDate && !parent.vatDate) parent.vatDate = vatDate;
      if (vatAmount && !parent.vatAmount) parent.vatAmount = vatAmount;
      if (licenseNo && !parent.licenseNo) parent.licenseNo = licenseNo;
      if (new37Code && !parent.new37Code) parent.new37Code = new37Code;
      if (taxCode && !parent.taxCode) parent.taxCode = taxCode;
      if (vatCode && !parent.vatCode) parent.vatCode = vatCode;
      if (cleanTaxDepartment && !parent.taxDepartment) {
        parent.taxDepartment = cleanTaxDepartment;
        parent.sourceMemo = cleanTaxDepartment;
      }
      if (taxComment && !parent.taxComment) parent.taxComment = taxComment;
      if (taxExtra && !parent.taxExtra) parent.taxExtra = taxExtra;
      if (comment && !parent.comment) parent.comment = comment;
      if (hasNonEmptyRecord(customFields)) {
        parent.customFields = {
          ...(parent.customFields || {}),
          ...customFields,
        };
      }
      continue;
    }

    let matchedSub = dealerAllocationId
      ? subById.get(dealerAllocationId)
      : undefined;
    const matchedDealer = dealerAllocationId
      ? dealerById.get(dealerAllocationId)
      : undefined;

    let dealerName =
      matchedSub?.dealerName || matchedDealer?.dealerName || '';
    let unionName = matchedSub?.unionName || matchedDealer?.unionName || '';

    if (!matchedSub && totalAmount && !isExplicitTaxRow && !isExplicitVatRow) {
      const numAmt = toNumericValue(totalAmount);
      if (numAmt > 0) {
        const amtMatches = suballocations.filter(
          (s) =>
            Math.abs(s.totalAmount - numAmt) < 1 &&
            (!category || !s.category || s.category === category)
        );
        if (amtMatches.length === 1) {
          matchedSub = amtMatches[0];
          if (!dealerName) dealerName = matchedSub.dealerName;
          if (!unionName) unionName = matchedSub.unionName || '';
        }
      }
    }

    if (dealerName && !unionName) {
      unionName = dealerByName.get(dealerName.trim())?.unionName || '';
    }

    const finalMainChallanNo =
      isExplicitTaxRow || isExplicitVatRow
        ? ''
        : challanNo || incomeTaxChallanNo || vatChallanNo;
    const finalTaxChallanNo = isExplicitTaxRow
      ? incomeTaxChallanNo || challanNo
      : incomeTaxChallanNo;
    const finalVatChallanNo = isExplicitVatRow
      ? vatChallanNo || challanNo
      : vatChallanNo;

    const matchedDo = matchDoIssueForChallan(
      {
        challanNo: finalMainChallanNo || finalTaxChallanNo || finalVatChallanNo,
        incomeTaxChallanNo: finalTaxChallanNo,
        dealerAllocationId,
        challanCategory: category || 'খাদ্য বান্ধব',
      },
      doIssues
    );

    if (!dealerName && matchedDo?.recipientName) {
      dealerName = matchedDo.recipientName.trim();
    }
    if (!unionName && matchedDo?.unionName) {
      unionName = matchedDo.unionName.trim();
    }
    if (dealerName && !unionName) {
      unionName = dealerByName.get(dealerName.trim())?.unionName || '';
    }

    const expectedAmount =
      matchedSub && matchedSub.totalAmount > 0
        ? String(matchedSub.totalAmount)
        : matchedDo && matchedDo.requiredAmount && matchedDo.requiredAmount > 0
          ? String(matchedDo.requiredAmount)
          : '';

    const expectedTaxAmount =
      matchedSub && matchedSub.taxAmount > 0
        ? String(matchedSub.taxAmount)
        : matchedDo && matchedDo.requiredTaxAmount && matchedDo.requiredTaxAmount > 0
          ? String(matchedDo.requiredTaxAmount)
          : '';

    const candidate: ChallanRecord = {
      serialNo: out.length + 1,
      id: baseId || id,
      date,
      department: isExplicitTaxRow || isExplicitVatRow ? '' : department,
      unionName,
      dealerName,
      dealerAllocationId,
      challanCategory: category || 'খাদ্য বান্ধব',
      sourceMemo: cleanTaxDepartment,
      taxDepartment: cleanTaxDepartment,
      dcMemo,
      toOrganization: isExplicitTaxRow || isExplicitVatRow ? '' : department,
      submittedThrough: '',
      submittedOnBehalfOf: '',
      challanNo: finalMainChallanNo,
      description: '',
      quantity: isExplicitTaxRow || isExplicitVatRow ? '' : quantity,
      rate: isExplicitTaxRow || isExplicitVatRow ? '' : rate,
      expectedAmount: isExplicitTaxRow || isExplicitVatRow ? '' : expectedAmount,
      expectedTaxAmount,
      amount: isExplicitTaxRow || isExplicitVatRow ? '' : totalAmount,
      challanDate: isExplicitTaxRow || isExplicitVatRow ? '' : challanDate,
      incomeTaxChallanNo: finalTaxChallanNo,
      incomeTaxDate: isExplicitTaxRow
        ? incomeTaxDate || challanDate || date
        : incomeTaxDate,
      incomeTaxAmount: isExplicitTaxRow
        ? incomeTaxAmount || totalAmount
        : incomeTaxAmount,
      vatChallanNo: finalVatChallanNo,
      vatDate: isExplicitVatRow ? vatDate || challanDate || date : vatDate,
      vatAmount: isExplicitVatRow ? vatAmount || totalAmount : vatAmount,
      licenseNo,
      new37Code: isExplicitTaxRow || isExplicitVatRow ? '' : new37Code,
      taxCode: isExplicitTaxRow ? taxCode || new37Code : taxCode,
      vatCode: isExplicitVatRow ? vatCode || new37Code : vatCode,
      doNo: matchedDo?.doNo || '',
      doIssueDate: matchedDo?.issueDate || '',
      customFields: isExplicitTaxRow || isExplicitVatRow ? undefined : customFields,
      ...(isExplicitTaxRow && hasNonEmptyRecord(customFields)
        ? { taxCustomFields: customFields }
        : {}),
      ...(isExplicitVatRow && hasNonEmptyRecord(customFields)
        ? { vatCustomFields: customFields }
        : {}),
      comment: isExplicitTaxRow || isExplicitVatRow ? '' : comment,
      taxComment:
        (isExplicitTaxRow || isExplicitVatRow ? taxComment || comment : taxComment) ||
        (finalTaxChallanNo || (isExplicitTaxRow ? totalAmount : incomeTaxAmount)
          ? buildDefaultCommissionTaxComment(
              category || 'খাদ্য বান্ধব',
              (isExplicitTaxRow ? incomeTaxDate || challanDate || date : incomeTaxDate) ||
                date,
              finalTaxChallanNo
            )
          : ''),
      taxExtra,
      recordId: srcRecordId || baseId || id || `sheet-row-${i + 1}`,
      pdfUrl: '',
      entryTime: createdAt || new Date().toISOString(),
    };

    out.push(candidate);
  }
  return out;
}

export interface DeletedChallanLogEntry {
  deletedAt: string;
  id: string;
  srcRecordId: string;
  challanNo: string;
  incomeTaxChallanNo: string;
  vatChallanNo: string;
}

export function parseDeletedChallanLogsFromRows(
  rows: string[][]
): DeletedChallanLogEntry[] {
  if (!Array.isArray(rows) || rows.length <= 1) return [];
  const out: DeletedChallanLogEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const deletedAt = String(r[0] || '').trim();
    const id = getCleanBaseRecordId(String(r[1] || '').trim());
    const srcRecordId = String(r[2] || '').trim();
    const challanNo = cleanChallanNo(String(r[3] || ''));
    const incomeTaxChallanNo = cleanChallanNo(String(r[4] || ''));
    const vatChallanNo = cleanChallanNo(String(r[5] || ''));
    if (!id && !srcRecordId && !challanNo && !incomeTaxChallanNo && !vatChallanNo) {
      continue;
    }
    out.push({
      deletedAt,
      id,
      srcRecordId,
      challanNo,
      incomeTaxChallanNo,
      vatChallanNo,
    });
  }
  return out;
}
