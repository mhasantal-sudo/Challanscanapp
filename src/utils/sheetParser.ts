import type {
  AppSettings,
  ChallanRecord,
  DealerRecord,
  DoIssueRecord,
  SuballocationRecord,
} from '../types.ts';
import {
  normalizeChallanDate,
  normalizeChallanNo,
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

export function normalizeSheetCategory(rawCategory: string | null | undefined): string {
  const s = String(rawCategory || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'ep চাল' || low === 'ep rice') return 'ইপি চাল';
  if (low === 'ep গম' || low === 'ep wheat') return 'ইপি গম';
  return s;
}

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

export function parseGoogleSheetDateToDisplay(
  raw: string | null | undefined
): string {
  const t = toEnglishDigits(raw).trim();
  if (!t) return '';

  const isoMatch = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[3].padStart(2, '0')}/${isoMatch[2].padStart(
      2,
      '0'
    )}/${isoMatch[1]}`;
  }

  const slashMatch = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (slashMatch) {
    const p1 = Number(slashMatch[1]);
    const p2 = Number(slashMatch[2]);
    const year = slashMatch[3];

    if (p1 > 12 && p2 >= 1 && p2 <= 12) {
      return `${String(p1).padStart(2, '0')}/${String(p2).padStart(
        2,
        '0'
      )}/${year}`;
    }
    if (p1 >= 1 && p1 <= 12 && p2 >= 1 && p2 <= 31) {
      return `${String(p2).padStart(2, '0')}/${String(p1).padStart(
        2,
        '0'
      )}/${year}`;
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

  const dealerNameIdx = headers.findIndex((h) =>
    ['dealername', 'dealer', 'ডিলারের নাম'].includes(h)
  );
  const dealerIdIdx = headers.findIndex((h) =>
    ['dealerid', 'dealer_id'].includes(h)
  );
  const unionIdx = headers.findIndex((h) =>
    ['unionname', 'union'].includes(h)
  );
  const catIdx = headers.findIndex((h) => ['category', 'khat'].includes(h));
  const dateIdx = headers.findIndex((h) => ['date', 'তারিখ'].includes(h));

  const cardIdx = col('cardcount', 7);
  const unusedIdx = col('unusedcards', 8);
  const qtyIdx = col('allocationqty', 9);
  const totalIdx = col('totalamount', 10);
  const taxIdx = col('taxamount', 11);
  const createdIdx = col('createdat', 12);
  const idIdx = col('id', 13);

  const out: SuballocationRecord[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[idIdx] || '').trim();
    const totalAmount = toNumericValue(r[totalIdx]);
    const taxAmount = toNumericValue(r[taxIdx]);
    const dealerName =
      dealerNameIdx >= 0
        ? String(r[dealerNameIdx] || '').trim()
        : String(r[4] || r[1] || '').trim();

    if (!id && !dealerName && totalAmount === 0 && taxAmount === 0) continue;

    const createdAtVal = String(r[createdIdx] || '').trim();
    const dateVal = dateIdx >= 0 ? String(r[dateIdx] || '').trim() : '';

    out.push({
      id: id || `ds-row-${i + 1}`,
      dealerId: dealerIdIdx >= 0 ? String(r[dealerIdIdx] || '').trim() : '',
      dealerName,
      unionName:
        unionIdx >= 0
          ? String(r[unionIdx] || '').trim()
          : String(r[5] || '').trim(),
      category:
        catIdx >= 0 ? String(r[catIdx] || '').trim() : String(r[0] || '').trim(),
      cardCount: toNumericValue(r[cardIdx]),
      unusedCards: toNumericValue(r[unusedIdx]),
      allocationQty: toNumericValue(r[qtyIdx]),
      totalAmount,
      taxAmount,
      createdAt: createdAtVal || dateVal,
    });
  }
  return out;
}

export function parseDoIssuesFromRows(rows: string[][]): DoIssueRecord[] {
  if (rows.length < 2) return [];
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
      issueDate = parseGoogleSheetDateToDisplay(col2);
      category = String(r[3] || '').trim();
      unionName = String(r[7] || '').trim();
      recipientName = String(r[8] || '').trim();
      challanNo = normalizeChallanNo(String(r[11] || ''));
      taxChallanNo = normalizeChallanNo(String(r[12] || ''));
      createdAt = String(r[14] || '').trim();
      id = `do-shift-${i + 1}-${doNo}`;
    } else {
      doNo = toEnglishDigits(col0);
      issueDate = parseGoogleSheetDateToDisplay(col1);
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
  const dealerById = new Map(dealers.map((d) => [d.id, d]));
  const dealerByName = new Map(
    dealers.map((d) => [d.dealerName.trim(), d])
  );
  const subById = new Map(suballocations.map((s) => [s.id, s]));
  const out: ChallanRecord[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[0] || '').trim();
    const date = parseGoogleSheetDateToDisplay(String(r[1] || ''));
    const department = String(r[2] || '').trim();
    const category = normalizeSheetCategory(String(r[3] || ''));
    const sourceMemo = String(r[4] || '').trim();
    const dcMemo = String(r[5] || '').trim();
    const dealerAllocationId = String(r[6] || '').trim();
    const rawMainNo = String(r[7] || '').trim();
    const challanNo = rawMainNo ? normalizeChallanNo(rawMainNo) : '';
    const challanDate = parseGoogleSheetDateToDisplay(
      String(r[8] || r[1] || '')
    );
    const rate = toEnglishDigits(String(r[9] || '')).replace(/,/g, '').trim();
    const quantity = toEnglishDigits(String(r[10] || '')).trim();
    const totalAmount = toEnglishDigits(String(r[11] || '')).replace(/,/g, '').trim();
    const rawTaxNo = String(r[12] || '').trim();
    const incomeTaxChallanNo = rawTaxNo ? normalizeChallanNo(rawTaxNo) : '';
    const incomeTaxDate = parseGoogleSheetDateToDisplay(String(r[13] || ''));
    const incomeTaxAmount = toEnglishDigits(String(r[14] || '')).replace(/,/g, '').trim();
    const comment = String(r[15] || '').trim();
    const createdAt = String(r[16] || '').trim();
    const srcRecordId = String(r[17] || '').trim();

    const rawVatNo = String(r[18] || '').trim();
    const vatChallanNo = rawVatNo ? normalizeChallanNo(rawVatNo) : '';
    const vatDate = parseGoogleSheetDateToDisplay(String(r[19] || ''));
    const vatAmount = toEnglishDigits(String(r[20] || '')).replace(/,/g, '').trim();
    const licenseNo = String(r[21] || '').trim();
    const new37Code = String(r[22] || '').trim();

    const customFields: Record<string, string> = {};
    for (const colDef of settings.customColumns || []) {
      const idx = colLetterToIndex(colDef.sheetColumn);
      if (idx >= 0 && r[idx] !== undefined) {
        customFields[colDef.id] = String(r[idx] || '').trim();
      }
    }

    if (!id && !challanNo && !incomeTaxChallanNo && !vatChallanNo) continue;

    let matchedSub = dealerAllocationId
      ? subById.get(dealerAllocationId)
      : undefined;
    const matchedDealer = dealerAllocationId
      ? dealerById.get(dealerAllocationId)
      : undefined;

    let dealerName =
      matchedSub?.dealerName || matchedDealer?.dealerName || '';
    let unionName = matchedSub?.unionName || matchedDealer?.unionName || '';

    if (!matchedSub && totalAmount) {
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

    const matchedDo = matchDoIssueForChallan(
      {
        challanNo: challanNo || incomeTaxChallanNo || vatChallanNo,
        incomeTaxChallanNo,
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

    out.push({
      serialNo: out.length + 1,
      id,
      date,
      department,
      unionName,
      dealerName,
      dealerAllocationId,
      challanCategory: category || 'খাদ্য বান্ধব',
      sourceMemo,
      dcMemo,
      toOrganization: department,
      submittedThrough: '',
      submittedOnBehalfOf: '',
      challanNo: challanNo || incomeTaxChallanNo || vatChallanNo,
      description: comment,
      quantity,
      rate,
      expectedAmount,
      expectedTaxAmount,
      amount: totalAmount,
      challanDate,
      incomeTaxChallanNo,
      incomeTaxDate,
      incomeTaxAmount,
      vatChallanNo,
      vatDate,
      vatAmount,
      licenseNo,
      new37Code,
      doNo: matchedDo?.doNo || '',
      doIssueDate: matchedDo?.issueDate || '',
      customFields,
      comment,
      recordId: srcRecordId || id || `sheet-row-${i + 1}`,
      pdfUrl: '',
      entryTime: createdAt || new Date().toISOString(),
    });
  }
  return out;
}
