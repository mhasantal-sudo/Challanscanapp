import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
} from 'react';
import {
  Calendar,
  FileBadge2,
  FileDown,
  FileSpreadsheet,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Printer,
  RectangleHorizontal,
  RectangleVertical,
  RefreshCw,
  Search,
  Wheat,
} from 'lucide-react';
import type {
  AppSettings,
  ChallanReportResponse,
  ChallanReportRow,
  KhatConfig,
} from '../types.ts';
import {
  CHALLAN_CATEGORIES,
  DEFAULT_LICENSE_FEES,
  DEFAULT_SETTINGS,
  buildDefaultCommissionTaxComment,
  countChallanBreakdown,
  extractEconomicCodeFromText,
  sanitizeRegisterSubRowText,
  showDate,
  splitTaxDepartmentAndExtra,
  stripEconomicCodeText,
  toBengaliDigits,
  toEnglishDigits,
} from '../utils/challan.ts';
import { apiFetch } from '../utils/api.ts';
import { saveBlobFile, triggerPrint } from '../utils/nativeExport.ts';
import { downloadNikoshPdf, ensureNikoshFontsReady } from '../utils/pdfExport.ts';
import { A4FitPreview } from './A4FitPreview.tsx';

interface ReportViewProps {
  unions: string[];
  khats?: KhatConfig[];
  settings?: AppSettings;
  recordsCount?: number;
  onSyncSheet?: () => Promise<void> | void;
  syncing?: boolean;
}

type RegisterType = 'grain' | 'license';
type PageOrientation = 'portrait' | 'landscape';

function getTodayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}-${String(now.getDate()).padStart(2, '0')}`;
}

function getMonthStartIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}-01`;
}

function getTodayFormatted(): string {
  return getTodayIso();
}

function fmtBnAmount(val: number | undefined): string {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n === 0) return '';
  const hasDecimals = Math.abs(n - Math.round(n)) > 0.001;
  return toBengaliDigits(
    n.toLocaleString('en-US', {
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}

function fmtBnQty(val: number | undefined): string {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n === 0) return '';
  return toBengaliDigits(
    n.toLocaleString('en-US', {
      minimumFractionDigits: Math.abs(n - Math.round(n)) > 0.001 ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}

function formatGormil(expected: number, deposited: number): {
  text: string;
  shortfall: number;
} {
  if (expected <= 0) {
    return { text: '', shortfall: 0 };
  }
  const diff = Math.round((expected - deposited) * 100) / 100;
  if (Math.abs(diff) < 0.5) {
    return { text: '০', shortfall: 0 };
  }
  if (diff > 0) {
    return { text: fmtBnAmount(diff), shortfall: diff };
  }
  return { text: `বেশি ${fmtBnAmount(Math.abs(diff))}`, shortfall: diff };
}

interface RegisterSubRow {
  key: string;
  orgDesc: string;
  khatLabel: string;
  new37Code: string;
  qtyRateText: string;
  expectedNum: number;
  challanNo: string;
  challanDate: string;
  depositedNum: number;
  gormilText: string;
  shortfall: number;
  comment: string;
  customFields?: Record<string, string>;
  canSign: boolean;
}

interface ChunkedPageRow {
  row: ChallanReportRow;
  globalIndex: number;
  subs: RegisterSubRow[];
}

export function ReportView({
  unions,
  khats = [],
  settings = DEFAULT_SETTINGS,
  recordsCount,
  onSyncSheet,
  syncing = false,
}: ReportViewProps) {
  const [registerType, setRegisterType] = useState<RegisterType>('grain');
  const [orientation, setOrientation] = useState<PageOrientation>('portrait');
  const [previewScale, setPreviewScale] = useState<number | null>(0.39);
  const [datePreset, setDatePreset] = useState<
    'today' | 'thisMonth' | 'lastMonth' | 'all' | 'custom'
  >('thisMonth');
  const [startDateIso, setStartDateIso] = useState(getMonthStartIso);
  const [endDateIso, setEndDateIso] = useState(getTodayIso);
  const [category, setCategory] = useState('সকল');
  const [actionType, setActionType] = useState('সকল');
  const [unionName, setUnionName] = useState('সব ইউনিয়ন');

  const [report, setReport] = useState<ChallanReportResponse | null>(null);
  const [appliedMeta, setAppliedMeta] = useState<{
    registerType: RegisterType;
    startISO: string;
    endISO: string;
    allDates?: boolean;
    category: string;
    actionType: string;
    unionName: string;
  } | null>(null);
  const [statusText, setStatusText] = useState('');
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [measuredPages, setMeasuredPages] = useState<ChunkedPageRow[][] | null>(
    null
  );
  const [fontsReadyTick, setFontsReadyTick] = useState(0);
  const [sigImgTick, setSigImgTick] = useState(0);
  const activeScaleRef = useRef(0.39);

  useEffect(() => {
    setPreviewScale(0.39);
  }, [orientation]);

  function stepPreviewZoom(delta: number) {
    const base = activeScaleRef.current || 0.39;
    const next = Math.min(1.5, Math.max(0.2, Number((base + delta).toFixed(2))));
    setPreviewScale(next);
  }

  const printAreaRef = useRef<HTMLDivElement | null>(null);
  const measurePageRef = useRef<HTMLDivElement | null>(null);
  const measureHeaderRef = useRef<HTMLDivElement | null>(null);
  const measureTheadRef = useRef<HTMLTableSectionElement | null>(null);
  const measureTbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const measureTotalsRef = useRef<HTMLTableRowElement | null>(null);
  const measureFooterRef = useRef<HTMLDivElement | null>(null);

  const startDateInputRef = useRef<HTMLInputElement | null>(null);
  const endDateInputRef = useRef<HTMLInputElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const userSelectedDateRef = useRef(false);
  const prevRecordsCountRef = useRef(recordsCount);

  useEffect(() => {
    let active = true;
    void ensureNikoshFontsReady().then(() => {
      if (active) setFontsReadyTick((n) => n + 1);
    });
    return () => {
      active = false;
    };
  }, []);

  const activeKhats = useMemo(() => {
    const list = khats.length > 0 ? khats : DEFAULT_SETTINGS.khats;
    return list.filter((k) => k.group === registerType);
  }, [khats, registerType]);

  const categoryOptions = useMemo(() => {
    const dynamicNames = activeKhats.map((k) => k.name);
    if (dynamicNames.length > 0) return dynamicNames;
    return [...CHALLAN_CATEGORIES];
  }, [activeKhats]);

  const feeLookupMap = useMemo(() => {
    const list =
      settings.licenseFees && settings.licenseFees.length > 0
        ? settings.licenseFees
        : DEFAULT_LICENSE_FEES;
    const map = new Map<string, (typeof list)[number]>();
    for (const f of list) {
      map.set(f.khatName.trim(), f);
    }
    return map;
  }, [settings.licenseFees]);

  const customCols = useMemo(() => {
    const cols = settings.customColumns || [];
    return cols.filter((c) =>
      registerType === 'grain'
        ? c.includeInGrainRegister
        : c.includeInLicenseRegister
    );
  }, [settings.customColumns, registerType]);

  function applyPreset(
    preset: 'today' | 'thisMonth' | 'lastMonth' | 'all',
    isUserAction = true
  ) {
    if (isUserAction) {
      userSelectedDateRef.current = true;
    }
    setDatePreset(preset);
    const now = new Date();
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')}`;

    let nextStart = startDateIso;
    let nextEnd = endDateIso;
    let isAll = false;

    if (preset === 'today') {
      const today = toIso(now);
      nextStart = today;
      nextEnd = today;
    } else if (preset === 'thisMonth') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      nextStart = toIso(start);
      nextEnd = toIso(now);
    } else if (preset === 'lastMonth') {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      nextStart = toIso(start);
      nextEnd = toIso(end);
    } else {
      nextStart = '2020-01-01';
      nextEnd = toIso(now);
      isAll = true;
    }

    setStartDateIso(nextStart);
    setEndDateIso(nextEnd);
    void runReport({
      startISO: nextStart,
      endISO: nextEnd,
      allDates: isAll,
    });
  }

  async function runReport(overrides?: {
    registerType?: RegisterType;
    startISO?: string;
    endISO?: string;
    category?: string;
    actionType?: string;
    unionName?: string;
    allDates?: boolean;
  }) {
    const effectiveType = overrides?.registerType ?? registerType;
    const effectiveCategory =
      overrides?.category !== undefined
        ? overrides.category
        : overrides?.registerType
          ? 'সকল'
          : category;
    const effectiveAction =
      overrides?.actionType !== undefined
        ? overrides.actionType
        : overrides?.registerType
          ? 'সকল'
          : actionType;
    const effectiveUnion = overrides?.unionName ?? unionName;
    const startISO = overrides?.startISO ?? startDateIso;
    const endISO = overrides?.endISO ?? endDateIso;
    const useAllDates = overrides?.allDates ?? datePreset === 'all';

    if (!useAllDates) {
      if (!startISO || !endISO) {
        setStatusText('তারিখ নির্বাচন করুন');
        return;
      }
      if (startISO > endISO) {
        setStatusText('শুরুর তারিখ বড় হতে পারবে না');
        return;
      }
    }

    setLoading(true);
    setStatusText('');
    try {
      const params = new URLSearchParams({
        startDate: useAllDates ? 'ALL' : startISO,
        endDate: useAllDates ? 'ALL' : endISO,
        allDates: useAllDates ? 'true' : 'false',
        registerType: effectiveType,
        category:
          effectiveCategory === 'সকল' ? 'সব ক্যাটেগরি' : effectiveCategory,
        actionType:
          effectiveType === 'license' && effectiveAction !== 'সকল'
            ? effectiveAction
            : '',
        unionName: effectiveUnion,
      });
      const res = await apiFetch(`/api/report?${params.toString()}`);
      const json = (await res.json()) as ChallanReportResponse & {
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'রেজিস্টার তৈরি ব্যর্থ।');
      }

      if (
        json.rows.length === 0 &&
        (json.totalInGroup ?? 0) > 0 &&
        !useAllDates &&
        !userSelectedDateRef.current
      ) {
        const allParams = new URLSearchParams({
          startDate: 'ALL',
          endDate: 'ALL',
          allDates: 'true',
          registerType: effectiveType,
          category:
            effectiveCategory === 'সকল' ? 'সব ক্যাটেগরি' : effectiveCategory,
          actionType:
            effectiveType === 'license' && effectiveAction !== 'সকল'
              ? effectiveAction
              : '',
          unionName: effectiveUnion,
        });
        const allRes = await apiFetch(`/api/report?${allParams.toString()}`);
        const allJson = (await allRes.json()) as ChallanReportResponse & {
          message?: string;
        };
        if (allRes.ok && allJson.success && allJson.rows.length > 0) {
          const validDates = allJson.rows
            .map((r) => r.challanDate)
            .filter(Boolean)
            .sort();
          const minIso = validDates[0] || '2020-01-01';
          const maxIso = validDates[validDates.length - 1] || getTodayIso();
          setDatePreset('all');
          setStartDateIso(minIso);
          setEndDateIso(maxIso);
          setReport(allJson);
          setAppliedMeta({
            registerType: effectiveType,
            startISO: minIso,
            endISO: maxIso,
            allDates: true,
            category: effectiveCategory,
            actionType: effectiveAction,
            unionName: effectiveUnion,
          });
          setStatusText(
            `${toBengaliDigits(
              countChallanBreakdown(allJson.rows).totalChallans
            )}টি`
          );
          return;
        }
      }

      let displayStart = startISO;
      let displayEnd = endISO;
      if (useAllDates && json.rows.length > 0) {
        const validDates = json.rows
          .map((r) => r.challanDate)
          .filter(Boolean)
          .sort();
        if (validDates.length > 0) {
          displayStart = validDates[0];
          displayEnd = validDates[validDates.length - 1];
        }
      }

      setReport(json);
      setAppliedMeta({
        registerType: effectiveType,
        startISO: displayStart,
        endISO: displayEnd,
        allDates: useAllDates,
        category: effectiveCategory,
        actionType: effectiveAction,
        unionName: effectiveUnion,
      });
      setStatusText(
        `${toBengaliDigits(countChallanBreakdown(json.rows).totalChallans)}টি`
      );
    } catch (err) {
      setStatusText(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void runReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      recordsCount !== undefined &&
      recordsCount !== prevRecordsCountRef.current
    ) {
      prevRecordsCountRef.current = recordsCount;
      void runReport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordsCount]);

  function switchRegisterType(next: RegisterType) {
    if (next === registerType) return;
    setRegisterType(next);
    setCategory('সকল');
    setActionType('সকল');
    void runReport({
      registerType: next,
      category: 'সকল',
      actionType: 'সকল',
    });
  }

  function handleSwipeStart(e: TouchEvent<HTMLDivElement>) {
    touchStartXRef.current = e.changedTouches[0]?.clientX ?? null;
  }

  function handleSwipeEnd(e: TouchEvent<HTMLDivElement>) {
    if (touchStartXRef.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartXRef.current;
    const dx = endX - touchStartXRef.current;
    touchStartXRef.current = null;
    if (Math.abs(dx) < 55) return;
    if (dx < 0 && registerType === 'grain') {
      switchRegisterType('license');
    } else if (dx > 0 && registerType === 'license') {
      switchRegisterType('grain');
    }
  }

  async function downloadPdf() {
    if (!report) return;
    const targetEl = printAreaRef.current;
    if (!targetEl) return;

    setPdfLoading(true);
    try {
      const fileTag =
        (appliedMeta?.registerType ?? registerType) === 'grain'
          ? 'Grain_Register'
          : 'License_Register';
      await downloadNikoshPdf(
        targetEl,
        `${fileTag}_${appliedMeta?.startISO || 'report'}.pdf`,
        orientation
      );
    } catch (err) {
      setStatusText(err instanceof Error ? err.message : 'PDF ব্যর্থ।');
    } finally {
      setPdfLoading(false);
    }
  }

  function downloadExcelCsv() {
    if (!report || !appliedMeta) return;
    const headers = [
      'ক্রমিক',
      'ডিলার/লাইসেন্সধারী',
      'ইউনিয়ন',
      'খাত',
      'প্রতিষ্ঠান ও বিবরণ',
      'অর্থনৈতিক কোড',
      'পরিমাণ (টন)',
      'দর',
      'প্রাপ্য টাকা',
      'চালান নং',
      'চালান তারিখ',
      'জমাকৃত টাকা',
      'গরমিল',
      'ডিও নং',
      'ডিও তারিখ',
      'মন্তব্য',
      ...customCols.map((c) => c.label),
    ];
    const escapeCell = (v: unknown) => {
      const s = String(v ?? '').replace(/"/g, '""');
      return `"${s}"`;
    };
    const csvRows: string[] = [headers.map(escapeCell).join(',')];

    report.rows.forEach((row, idx) => {
      const subs =
        activeMode === 'grain'
          ? buildGrainSubRows(row)
          : buildLicenseSubRows(row);
      subs.forEach((sub, sIdx) => {
        csvRows.push(
          [
            sIdx === 0 ? idx + 1 : '',
            row.dealerName,
            row.unionName,
            sub.khatLabel,
            [
              sub.orgDesc,
              sub.khatLabel ? `খাত: ${sub.khatLabel}` : '',
              sub.new37Code ? `কোড: ${toBengaliDigits(sub.new37Code)}` : '',
            ]
              .filter(Boolean)
              .join(' | '),
            toBengaliDigits(sub.new37Code),
            sIdx === 0 ? row.quantity || '' : '',
            sIdx === 0 ? row.rate || '' : '',
            sub.expectedNum || '',
            sub.challanNo,
            showDate(sub.challanDate),
            sub.depositedNum || '',
            sub.gormilText,
            sIdx === 0 ? row.doNo || '' : '',
            sIdx === 0 ? showDate(row.doIssueDate) : '',
            stripEconomicCodeText(sub.comment, [sub.new37Code, row.new37Code || ''].filter(Boolean)),
            ...customCols.map((col) =>
              toBengaliDigits(
                sub.customFields?.[col.id] ??
                  (sIdx === 0 ? row.customFields?.[col.id] : '') ??
                  ''
              )
            ),
          ]
            .map(escapeCell)
            .join(',')
        );
      });
    });

    const blob = new Blob(['\uFEFF' + csvRows.join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const csvName = `Challan_Register_${appliedMeta.startISO}_${appliedMeta.endISO}.csv`;
    void saveBlobFile(blob, csvName, 'text/csv;charset=utf-8').catch((err) => {
      setStatusText(
        err instanceof Error ? err.message : 'CSV ডাউনলোড ব্যর্থ হয়েছে।'
      );
    });
  }

  const signatureText =
    settings.officerSignatureText?.trim() || 'উপজেলা খাদ্য নিয়ন্ত্রক';
  const officerName = settings.officerName?.trim() || '';
  const signatureImage = settings.officerSignatureImageDataUrl?.trim() || '';

  function buildGrainSubRows(row: ChallanReportRow): RegisterSubRow[] {
    const subs: RegisterSubRow[] = [];
    const hasDistinctMain =
      Boolean(
        row.challanNo &&
          row.challanNo !== row.incomeTaxChallanNo &&
          row.challanNo !== row.vatChallanNo
      ) || row.amount > 0;
    const hasTax = Boolean(
      row.incomeTaxChallanNo || (row.incomeTaxAmount ?? 0) > 0
    );

    if (hasDistinctMain || !hasTax) {
      const calcExpected = row.expectedAmount > 0 ? row.expectedAmount : 0;
      const gormil = formatGormil(calcExpected, row.amount);
      const qtyLine = row.quantity ? fmtBnQty(row.quantity) : '';
      const rateLine = row.rate ? fmtBnAmount(row.rate) : '';
      const qtyRateText = [qtyLine, rateLine].filter(Boolean).join('\n');

      const canSign =
        row.amount > 0 && (calcExpected <= 0 || gormil.shortfall <= 0);

      const cleanMain = sanitizeRegisterSubRowText({
        orgText: row.toOrganization,
        descText: row.description,
        commentText: row.comment || '',
        knownCode: row.new37Code,
        fallbackOrg: 'খাদ্য অধিদপ্তর',
      });

      subs.push({
        key: `${row.recordId}-main`,
        orgDesc: cleanMain.orgDesc,
        khatLabel: row.category,
        new37Code: cleanMain.code,
        qtyRateText,
        expectedNum: calcExpected,
        challanNo:
          row.challanNo &&
          row.challanNo !== row.incomeTaxChallanNo &&
          row.challanNo !== row.vatChallanNo
            ? row.challanNo
            : '',
        challanDate: showDate(row.challanDate),
        depositedNum: row.amount,
        gormilText: gormil.text,
        shortfall: gormil.shortfall,
        comment: cleanMain.comment,
        customFields: row.customFields,
        canSign,
      });
    }

    if (hasTax) {
      const taxAmt = Number(row.incomeTaxAmount || 0);
      const expectedTax = Number(row.expectedTaxAmount || 0);
      const gormil = formatGormil(expectedTax, taxAmt);
      const canSign =
        taxAmt > 0 && (expectedTax <= 0 || gormil.shortfall <= 0);
      const taxSplit = splitTaxDepartmentAndExtra(
        row.taxDepartment || '',
        row.taxCode || undefined
      );
      const rescuedCode =
        toEnglishDigits(String(row.taxCode || '')).trim() ||
        taxSplit.code ||
        extractEconomicCodeFromText(
          [
            row.taxDepartment,
            row.taxExtra,
            row.taxComment,
            !hasDistinctMain ? row.description : '',
            !hasDistinctMain ? row.comment : '',
            !hasDistinctMain ? row.toOrganization : '',
          ]
            .filter(Boolean)
            .join(' ')
        ) ||
        (!hasDistinctMain ? toEnglishDigits(String(row.new37Code || '')).trim() : '');
      const cleanOrg =
        stripEconomicCodeText(taxSplit.institution, rescuedCode) ||
        'কর অঞ্চল বরিশাল';
      const defaultCommissionTaxComment = buildDefaultCommissionTaxComment(
        row.category,
        row.incomeTaxDate || row.challanDate,
        row.incomeTaxChallanNo
      );
      const fallbackProvider =
        !row.taxComment &&
        !defaultCommissionTaxComment &&
        (row.submittedThrough || row.submittedOnBehalfOf)
          ? `প্রদানকারী: ${row.submittedThrough || row.submittedOnBehalfOf}`
          : '';
      const mainProviderMatch =
        !row.taxComment &&
        !defaultCommissionTaxComment &&
        !fallbackProvider &&
        row.comment
          ? row.comment.match(/প্রদানকারী\s*[:：]\s*[^|\n]+/i)?.[0] || ''
          : '';
      const topComment = stripEconomicCodeText(
        row.taxComment ||
          defaultCommissionTaxComment ||
          fallbackProvider ||
          (hasDistinctMain ? mainProviderMatch : row.comment || ''),
        [rescuedCode, row.new37Code || ''].filter(Boolean)
      );
      const bottomExtra = stripEconomicCodeText(
        row.taxExtra || taxSplit.extra || '',
        [rescuedCode, row.new37Code || ''].filter(Boolean)
      );
      const combinedComment = [
        topComment,
        bottomExtra && !topComment.includes(bottomExtra) ? bottomExtra : '',
      ]
        .filter(Boolean)
        .join('\n');

      subs.push({
        key: `${row.recordId}-tax`,
        orgDesc: cleanOrg,
        khatLabel: 'আয়কর',
        new37Code: rescuedCode,
        qtyRateText: row.quantity ? fmtBnQty(row.quantity) : '',
        expectedNum: expectedTax,
        challanNo: row.incomeTaxChallanNo || '',
        challanDate: showDate(row.incomeTaxDate || row.challanDate),
        depositedNum: taxAmt,
        gormilText: gormil.text,
        shortfall: gormil.shortfall,
        comment: combinedComment,
        customFields: row.taxCustomFields,
        canSign,
      });
    }

    return subs;
  }

  function buildLicenseSubRows(row: ChallanReportRow): RegisterSubRow[] {
    const subs: RegisterSubRow[] = [];
    const fee = feeLookupMap.get(row.category.trim());
    const actionLabel = row.licenseActionType || 'নতুন';

    const hasDistinctMain =
      Boolean(
        row.challanNo &&
          row.challanNo !== row.incomeTaxChallanNo &&
          row.challanNo !== row.vatChallanNo
      ) || row.amount > 0;
    const hasTax = Boolean(
      row.incomeTaxChallanNo || (row.incomeTaxAmount ?? 0) > 0
    );
    const hasVat = Boolean(row.vatChallanNo || (row.vatAmount ?? 0) > 0);

    if (hasDistinctMain || (!hasTax && !hasVat)) {
      const feeFromSettings =
        actionLabel === 'নবায়ন' ? fee?.renewalFee || 0 : fee?.newFee || 0;
      const expectedFee =
        row.expectedAmount > 0 ? row.expectedAmount : feeFromSettings;
      const gormil = formatGormil(expectedFee, row.amount);
      const canSign =
        row.amount > 0 && (expectedFee <= 0 || gormil.shortfall <= 0);
      const cleanLicMain = sanitizeRegisterSubRowText({
        orgText: row.toOrganization,
        descText: row.description,
        commentText: row.comment || '',
        knownCode: row.new37Code,
        fallbackOrg: row.category,
      });

      subs.push({
        key: `${row.recordId}-lic-main`,
        orgDesc: cleanLicMain.orgDesc,
        khatLabel: `${row.category}${actionLabel ? ` (${actionLabel})` : ''}`,
        new37Code: cleanLicMain.code,
        qtyRateText: '',
        expectedNum: expectedFee,
        challanNo:
          row.challanNo &&
          row.challanNo !== row.incomeTaxChallanNo &&
          row.challanNo !== row.vatChallanNo
            ? row.challanNo
            : '',
        challanDate: showDate(row.challanDate),
        depositedNum: row.amount,
        gormilText: gormil.text,
        shortfall: gormil.shortfall,
        comment: cleanLicMain.comment,
        customFields: row.customFields,
        canSign,
      });
    }

    if (hasTax) {
      const taxAmt = Number(row.incomeTaxAmount || 0);
      const expectedTax =
        row.expectedTaxAmount > 0 ? row.expectedTaxAmount : fee?.taxAmount || 0;
      const gormil = formatGormil(expectedTax, taxAmt);
      const taxSplit = splitTaxDepartmentAndExtra(
        row.taxDepartment || '',
        row.taxCode || undefined
      );
      const rescuedCode =
        toEnglishDigits(String(row.taxCode || '')).trim() ||
        taxSplit.code ||
        extractEconomicCodeFromText(
          [
            row.taxDepartment,
            row.taxExtra,
            row.taxComment,
            !hasDistinctMain ? row.description : '',
            !hasDistinctMain ? row.comment : '',
            !hasDistinctMain ? row.toOrganization : '',
          ]
            .filter(Boolean)
            .join(' ')
        ) ||
        (!hasDistinctMain ? toEnglishDigits(String(row.new37Code || '')).trim() : '');
      const cleanOrg =
        stripEconomicCodeText(taxSplit.institution, rescuedCode) ||
        'কর অঞ্চল বরিশাল';
      const fallbackProvider =
        !row.taxComment && (row.submittedThrough || row.submittedOnBehalfOf)
          ? `প্রদানকারী: ${row.submittedThrough || row.submittedOnBehalfOf}`
          : '';
      const mainProviderMatch = !row.taxComment && !fallbackProvider && row.comment
        ? row.comment.match(/প্রদানকারী\s*[:：]\s*[^|\n]+/i)?.[0] || ''
        : '';
      const topComment = stripEconomicCodeText(
        row.taxComment ||
          fallbackProvider ||
          (hasDistinctMain ? mainProviderMatch : row.comment || ''),
        [rescuedCode, row.new37Code || ''].filter(Boolean)
      );
      const bottomExtra = stripEconomicCodeText(
        row.taxExtra || taxSplit.extra || '',
        [rescuedCode, row.new37Code || ''].filter(Boolean)
      );
      const combinedComment = [
        topComment,
        bottomExtra && !topComment.includes(bottomExtra) ? bottomExtra : '',
      ]
        .filter(Boolean)
        .join('\n');

      subs.push({
        key: `${row.recordId}-lic-tax`,
        orgDesc: cleanOrg,
        khatLabel: 'আয়কর',
        new37Code: rescuedCode,
        qtyRateText: '',
        expectedNum: expectedTax,
        challanNo: row.incomeTaxChallanNo || '',
        challanDate: showDate(row.incomeTaxDate || row.challanDate),
        depositedNum: taxAmt,
        gormilText: gormil.text,
        shortfall: gormil.shortfall,
        comment: combinedComment,
        customFields: row.taxCustomFields,
        canSign: taxAmt > 0 && (expectedTax <= 0 || gormil.shortfall <= 0),
      });
    }

    if (hasVat) {
      const vatAmt = Number(row.vatAmount || 0);
      const expectedVat = fee?.vatAmount || 0;
      const gormil = formatGormil(expectedVat, vatAmt);
      const vatSplit = splitTaxDepartmentAndExtra(
        row.taxDepartment || '',
        row.vatCode || undefined
      );
      const rescuedCode =
        toEnglishDigits(String(row.vatCode || '')).trim() ||
        vatSplit.code ||
        extractEconomicCodeFromText(
          [
            row.taxDepartment,
            row.taxExtra,
            row.taxComment,
            !hasDistinctMain ? row.description : '',
            !hasDistinctMain ? row.comment : '',
            !hasDistinctMain ? row.toOrganization : '',
          ]
            .filter(Boolean)
            .join(' ')
        ) ||
        (!hasDistinctMain && !hasTax
          ? toEnglishDigits(String(row.new37Code || '')).trim()
          : '');
      const cleanOrg =
        stripEconomicCodeText(vatSplit.institution, rescuedCode) || 'ভ্যাট';
      const fallbackProvider =
        !row.taxComment && (row.submittedThrough || row.submittedOnBehalfOf)
          ? `প্রদানকারী: ${row.submittedThrough || row.submittedOnBehalfOf}`
          : '';
      const mainProviderMatch = !row.taxComment && !fallbackProvider && row.comment
        ? row.comment.match(/প্রদানকারী\s*[:：]\s*[^|\n]+/i)?.[0] || ''
        : '';
      const topComment = stripEconomicCodeText(
        row.taxComment ||
          fallbackProvider ||
          (hasDistinctMain || hasTax ? mainProviderMatch : row.comment || ''),
        [rescuedCode, row.new37Code || ''].filter(Boolean)
      );
      const bottomExtra = stripEconomicCodeText(
        row.taxExtra || vatSplit.extra || '',
        [rescuedCode, row.new37Code || ''].filter(Boolean)
      );
      const combinedComment = [
        topComment,
        bottomExtra && !topComment.includes(bottomExtra) ? bottomExtra : '',
      ]
        .filter(Boolean)
        .join('\n');

      subs.push({
        key: `${row.recordId}-lic-vat`,
        orgDesc: cleanOrg,
        khatLabel: 'ভ্যাট',
        new37Code: rescuedCode,
        qtyRateText: '',
        expectedNum: expectedVat,
        challanNo: row.vatChallanNo || '',
        challanDate: showDate(row.vatDate || row.challanDate),
        depositedNum: vatAmt,
        gormilText: gormil.text,
        shortfall: gormil.shortfall,
        comment: combinedComment,
        customFields: row.vatCustomFields,
        canSign: vatAmt > 0 && (expectedVat <= 0 || gormil.shortfall <= 0),
      });
    }

    return subs;
  }

  const activeMode = appliedMeta?.registerType ?? registerType;

  const reportBreakdown = useMemo(
    () => countChallanBreakdown(report?.rows || []),
    [report?.rows]
  );

  // Fallback heuristic pagination used before DOM measurement finishes
  const { allPreparedRows, heuristicPages, registerTotals } = useMemo(() => {
    if (!report) {
      return {
        allPreparedRows: [] as ChunkedPageRow[],
        heuristicPages: [] as ChunkedPageRow[][],
        registerTotals: {
          expectedTotal: 0,
          depositedTotal: 0,
          gormilTotal: 0,
          qtyTotal: 0,
        },
      };
    }

    let expectedTotal = 0;
    let depositedTotal = 0;
    let qtyTotal = 0;

    const prepared: ChunkedPageRow[] = report.rows.map((row, idx) => {
      qtyTotal += row.quantity || 0;
      const subs =
        activeMode === 'grain'
          ? buildGrainSubRows(row)
          : buildLicenseSubRows(row);
      for (const s of subs) {
        expectedTotal += s.expectedNum;
        depositedTotal += s.depositedNum;
      }
      return { row, globalIndex: idx, subs };
    });

    const gormilTotal = Math.max(0, expectedTotal - depositedTotal);

    if (prepared.length === 0) {
      return {
        allPreparedRows: [] as ChunkedPageRow[],
        heuristicPages: [[]] as ChunkedPageRow[][],
        registerTotals: { expectedTotal, depositedTotal, gormilTotal, qtyTotal },
      };
    }

    const maxHeightBudget = orientation === 'portrait' ? 860 : 530;
    const descChars = orientation === 'portrait' ? 19 : 29;
    const dealerChars = orientation === 'portrait' ? 11 : 16;
    const commentChars = orientation === 'portrait' ? 20 : 32;
    const challanChars = orientation === 'portrait' ? 16 : 20;

    const estimateItemPx = (item: ChunkedPageRow): number => {
      const dealerLines =
        Math.max(1, Math.ceil((item.row.dealerName?.length || 0) / dealerChars)) +
        (item.row.unionName
          ? Math.max(1, Math.ceil(item.row.unionName.length / dealerChars))
          : 0) +
        (item.row.licenseNo ? 1 : 0);
      const doLines =
        (item.row.doNo ? Math.max(1, Math.ceil(item.row.doNo.length / 10)) : 0) +
        (item.row.doIssueDate ? 1 : 0);

      let total = 0;
      for (const s of item.subs) {
        const descLines =
          Math.max(1, Math.ceil((s.orgDesc?.length || 0) / descChars)) +
          (s.khatLabel ? 1 : 0) +
          (s.new37Code ? 2 : 0);
        const commentLines = Math.max(
          1,
          (s.comment || '')
            .split('\n')
            .reduce(
              (acc, ln) => acc + Math.max(1, Math.ceil(ln.length / commentChars)),
              0
            )
        );
        const challanLines =
          Math.max(1, Math.ceil((s.challanNo?.length || 0) / challanChars)) +
          (s.challanDate ? 1 : 0);
        const lines = Math.max(
          descLines,
          commentLines,
          challanLines,
          s.qtyRateText ? 2 : 1,
          2
        );
        total += Math.max(36, lines * 15 + 10);
      }

      const spanMinHeight = Math.max(dealerLines, doLines) * 15 + 10;
      return Math.max(total, spanMinHeight);
    };

    const chunked: ChunkedPageRow[][] = [];
    let currentPage: ChunkedPageRow[] = [];
    let currentPx = 0;

    for (let idx = 0; idx < prepared.length; idx++) {
      const item = prepared[idx];
      const itemPx = estimateItemPx(item);
      const isLastItem = idx === prepared.length - 1;
      const totalsReserve = isLastItem ? 38 : 0;

      if (
        currentPage.length > 0 &&
        currentPx + itemPx + totalsReserve > maxHeightBudget
      ) {
        chunked.push(currentPage);
        currentPage = [item];
        currentPx = itemPx;
      } else {
        currentPage.push(item);
        currentPx += itemPx;
      }
    }
    if (currentPage.length > 0) {
      chunked.push(currentPage);
    }

    return {
      allPreparedRows: prepared,
      heuristicPages: chunked,
      registerTotals: { expectedTotal, depositedTotal, gormilTotal, qtyTotal },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, activeMode, orientation, feeLookupMap, signatureText]);

  const showLicenseDoColumn = useMemo(
    () => Boolean(report?.rows.some((r) => Boolean(r.doNo))),
    [report]
  );

  // Measure real off-screen rendered A4 row & footer heights so pages pack tightly
  // without leftover bottom whitespace and NEVER overflow beneath .a4-page-footer
  useLayoutEffect(() => {
    if (!report || !appliedMeta) {
      setMeasuredPages(null);
      return;
    }
    if (allPreparedRows.length === 0) {
      setMeasuredPages([[]]);
      return;
    }

    const pageEl = measurePageRef.current;
    const headerEl = measureHeaderRef.current;
    const theadEl = measureTheadRef.current;
    const tbodyEl = measureTbodyRef.current;
    const footerEl = measureFooterRef.current;

    if (!pageEl || !headerEl || !theadEl || !tbodyEl || !footerEl) {
      setMeasuredPages(null);
      return;
    }

    const cs = window.getComputedStyle(pageEl);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const pageInnerH = pageEl.clientHeight - padTop - padBottom;
    const headerH = headerEl.getBoundingClientRect().height;
    const theadH = theadEl.getBoundingClientRect().height;
    const footerH = footerEl.getBoundingClientRect().height;
    const totalsH =
      measureTotalsRef.current?.getBoundingClientRect().height || 34;

    // Account for .a4-page-content bottom spacing (10px) + @media print height delta (~8px)
    const availableTbodyH = Math.max(
      140,
      pageInnerH - headerH - theadH - footerH - 18
    );

    const groupHeights = new Map<number, number>();
    const allTrs = Array.from(
      tbodyEl.querySelectorAll<HTMLTableRowElement>('tr[data-measure-group]')
    );
    for (const tr of allTrs) {
      const idx = Number(tr.dataset.measureGroup);
      if (!Number.isNaN(idx)) {
        const h = tr.getBoundingClientRect().height || 30;
        groupHeights.set(idx, (groupHeights.get(idx) || 0) + h);
      }
    }

    const packed: ChunkedPageRow[][] = [];
    let currentPage: ChunkedPageRow[] = [];
    let currentH = 0;

    for (let i = 0; i < allPreparedRows.length; i++) {
      const item = allPreparedRows[i];
      const itemH = groupHeights.get(item.globalIndex) || 34;
      const isLast = i === allPreparedRows.length - 1;
      const reserveTotals = isLast ? totalsH + 2 : 0;

      if (
        currentPage.length > 0 &&
        currentH + itemH + reserveTotals > availableTbodyH
      ) {
        packed.push(currentPage);
        currentPage = [item];
        currentH = itemH;
      } else {
        currentPage.push(item);
        currentH += itemH;
      }
    }

    if (currentPage.length > 0) {
      packed.push(currentPage);
    }

    setMeasuredPages(packed.length > 0 ? packed : [[]]);
  }, [
    report,
    appliedMeta,
    allPreparedRows,
    activeMode,
    orientation,
    customCols,
    showLicenseDoColumn,
    signatureImage,
    officerName,
    signatureText,
    fontsReadyTick,
    sigImgTick,
  ]);

  const pages = measuredPages ?? heuristicPages;

  // Column order: ক্রমিক | খাত, ডিলার ও ইউনিয়ন | প্রতিষ্ঠান ও বিবরণ | ... | মন্তব্য | [CustomCols] | ডিও নং ও তারিখ | স্বাক্ষর
  // Normalize column widths so sum ALWAYS equals strictly 100% (prevents border overflow & clipping)
  const grainWidths = useMemo(() => {
    const base = [4.7, 10.5, 17.5, 6.8, 7.2, 12.3, 7.2, 5.3, 14.3]; // 85.8
    const customWeights = customCols.map(() => 5);
    const all = [...base, ...customWeights, 7.2, 7.0]; // DO = 7.2, Signature = 7.0 -> 100.0
    const total = all.reduce((a, b) => a + b, 0);
    return all.map((w) => `${((w / total) * 100).toFixed(2)}%`);
  }, [customCols]);

  const licenseWidths = useMemo(() => {
    const base = [4.7, 11.5, 17.5, 12.3, 7.4, 7.4, 5.3, 19.7]; // 85.8
    const customWeights = customCols.map(() => 5);
    const doWeight = showLicenseDoColumn ? [7.2] : [];
    const all = [...base, ...customWeights, ...doWeight, 7.0]; // Signature = 7.0 (LAST)
    const total = all.reduce((a, b) => a + b, 0);
    return all.map((w) => `${((w / total) * 100).toFixed(2)}%`);
  }, [customCols, showLicenseDoColumn]);

  const customPenalty = Math.min(2, customCols.length * 0.45);
  const cellFontPx =
    orientation === 'portrait'
      ? `${(11.5 - customPenalty).toFixed(1)}px`
      : `${(12.5 - customPenalty).toFixed(1)}px`;
  const theadFontPx =
    orientation === 'portrait'
      ? `${(10.5 - customPenalty * 0.8).toFixed(1)}px`
      : `${(11.5 - customPenalty * 0.8).toFixed(1)}px`;
  const compactDetailFontPx =
    orientation === 'portrait'
      ? `${(10.0 - customPenalty * 0.7).toFixed(1)}px`
      : `${(11.0 - customPenalty * 0.7).toFixed(1)}px`;
  const compactSubFontPx =
    orientation === 'portrait'
      ? `${(9.5 - customPenalty * 0.6).toFixed(1)}px`
      : `${(10.0 - customPenalty * 0.6).toFixed(1)}px`;
  const cellPad = orientation === 'portrait' ? '2.5px 2.5px' : '3px 4px';
  const cellWrapStyle = {
    overflow: 'visible' as const,
    overflowWrap: 'break-word' as const,
    wordBreak: 'normal' as const,
    lineHeight: 1.32,
  };
  const longTextCellStyle = {
    overflow: 'visible' as const,
    overflowWrap: 'anywhere' as const,
    wordBreak: 'break-word' as const,
    lineHeight: 1.32,
  };

  function formatShortChipDate(iso: string): string {
    if (!iso) return 'তারিখ';
    const parts = iso.split('-');
    if (parts.length !== 3) return toBengaliDigits(iso);
    return toBengaliDigits(`${parts[2]}/${parts[1]}/${parts[0].slice(2)}`);
  }

  function renderGroupSignatureCell(subs: RegisterSubRow[]) {
    const anySigned = subs.some((s) => s.canSign);
    const noShortfall = subs.every(
      (s) => s.expectedNum <= 0 || s.shortfall <= 0
    );
    if (!anySigned || !noShortfall) return null;
    if (signatureImage) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
          }}
        >
          <img
            src={signatureImage}
            alt="স্বাক্ষর"
            style={{
              height: '22px',
              maxWidth: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
          <span style={{ fontSize: compactSubFontPx, lineHeight: 1.15 }}>
            {signatureText}
          </span>
        </div>
      );
    }
    return (
      <span style={{ fontSize: compactSubFontPx, lineHeight: 1.2 }}>
        {signatureText}
      </span>
    );
  }

  function renderA4Header() {
    if (!appliedMeta) return null;
    return (
      <div
        style={{
          textAlign: 'center',
          marginBottom: orientation === 'portrait' ? '6px' : '8px',
          color: '#000000',
        }}
      >
        <div
          style={{
            fontSize: orientation === 'portrait' ? '14.5px' : '16px',
            fontWeight: 'bold',
            lineHeight: 1.25,
          }}
        >
          গণপ্রজাতন্ত্রী বাংলাদেশ সরকার
        </div>
        <div
          style={{
            fontSize: orientation === 'portrait' ? '12.5px' : '13.5px',
            fontWeight: 'bold',
            lineHeight: 1.25,
          }}
        >
          {settings.officeSubtitle || 'উপজেলা খাদ্য নিয়ন্ত্রকের কার্যালয়'},{' '}
          {settings.officeTitle || 'উজিরপুর, বরিশাল'}।
        </div>
        <div
          style={{
            fontSize: orientation === 'portrait' ? '13.5px' : '15px',
            fontWeight: 'bold',
            marginTop: '1px',
            lineHeight: 1.25,
          }}
        >
          চালান রেজিস্টার —{' '}
          {activeMode === 'grain'
            ? appliedMeta.category === 'সকল'
              ? 'খাদ্যশস্য'
              : appliedMeta.category
            : appliedMeta.category === 'সকল'
            ? 'লাইসেন্স ও অন্যান্য'
            : appliedMeta.category}
        </div>
        <div
          style={{
            fontSize: orientation === 'portrait' ? '11px' : '12px',
            marginTop: '1px',
          }}
        >
          তারিখ: {toBengaliDigits(showDate(appliedMeta.startISO))} হতে{' '}
          {toBengaliDigits(showDate(appliedMeta.endISO))} পর্যন্ত
          {appliedMeta.unionName !== 'সব ইউনিয়ন'
            ? ` · ইউনিয়ন: ${appliedMeta.unionName}`
            : ''}
        </div>
      </div>
    );
  }

  function renderA4Footer(pageNumber: number, totalPages: number) {
    return (
      <div className="a4-page-footer">
        <div style={{ fontSize: '10.5px', color: '#334155' }}>
          পৃষ্ঠা {toBengaliDigits(pageNumber)} / {toBengaliDigits(totalPages)} ·
          প্রিন্ট: {toBengaliDigits(getTodayFormatted())}
        </div>

        <div style={{ textAlign: 'center', minWidth: '150px' }}>
          {signatureImage && (
            <img
              src={signatureImage}
              alt="স্বাক্ষর"
              onLoad={() => setSigImgTick((n) => n + 1)}
              style={{
                height: '32px',
                maxWidth: '130px',
                objectFit: 'contain',
                margin: '0 auto 2px auto',
                display: 'block',
              }}
            />
          )}
          <div
            style={{
              borderTop: signatureImage
                ? '1px solid #475569'
                : '1px dashed #64748b',
              paddingTop: '2px',
              fontSize: '11px',
              fontWeight: 'bold',
            }}
          >
            {officerName || signatureText}
          </div>
          {officerName && (
            <div style={{ fontSize: '10px', color: '#334155' }}>
              {signatureText}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderGrainA4Thead() {
    return (
      <tr>
        <th
          style={{
            width: grainWidths[0],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          ক্রমিক
        </th>
        <th
          style={{
            width: grainWidths[1],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          খাত, ডিলার ও ইউনিয়ন
        </th>
        <th
          style={{
            width: grainWidths[2],
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          প্রতিষ্ঠান ও বিবরণ
        </th>
        <th
          style={{
            width: grainWidths[3],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          পরিমাণ ও দর
        </th>
        <th
          style={{
            width: grainWidths[4],
            textAlign: 'right',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          প্রাপ্য টাকা
        </th>
        <th
          style={{
            width: grainWidths[5],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          চালান নং ও তারিখ
        </th>
        <th
          style={{
            width: grainWidths[6],
            textAlign: 'right',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          জমাকৃত টাকা
        </th>
        <th
          style={{
            width: grainWidths[7],
            textAlign: 'right',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          গরমিল
        </th>
        <th
          style={{
            width: grainWidths[8],
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          মন্তব্য
        </th>
        {customCols.map((col, cIdx) => (
          <th
            key={col.id}
            style={{
              width: grainWidths[9 + cIdx],
              textAlign: 'center',
              fontSize: theadFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {col.label}
          </th>
        ))}
        <th
          style={{
            width: grainWidths[9 + customCols.length],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          ডিও নং ও তারিখ
        </th>
        <th
          style={{
            width: grainWidths[10 + customCols.length],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          স্বাক্ষর
        </th>
      </tr>
    );
  }

  function renderGrainA4Rows(rows: ChunkedPageRow[], forMeasure = false) {
    return rows.flatMap(({ row, globalIndex, subs }) =>
      subs.map((sub, subIdx) => (
        <tr
          key={forMeasure ? `m-${sub.key}` : sub.key}
          data-measure-group={forMeasure ? globalIndex : undefined}
        >
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                fontWeight: 'bold',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {toBengaliDigits(globalIndex + 1)}
            </td>
          )}
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {(row.category || subs[0]?.khatLabel) && (
                <div
                  style={{
                    fontSize: compactSubFontPx,
                    fontWeight: 'bold',
                    color: '#334155',
                    marginBottom: '1px',
                  }}
                >
                  {row.category || subs[0]?.khatLabel}
                </div>
              )}
              <div style={{ fontWeight: 'bold' }}>{row.dealerName || '—'}</div>
              {row.unionName && (
                <div style={{ fontSize: compactSubFontPx }}>{row.unionName}</div>
              )}
            </td>
          )}
          <td
            style={{
              fontSize: compactDetailFontPx,
              padding: cellPad,
              ...longTextCellStyle,
            }}
          >
            <div>{sub.orgDesc}</div>
            {sub.khatLabel && (
              <div
                style={{
                  fontSize: compactSubFontPx,
                  fontWeight: 'bold',
                  color: '#334155',
                  marginTop: '1px',
                }}
              >
                খাত: {sub.khatLabel}
              </div>
            )}
            {sub.new37Code && (
              <div
                style={{
                  fontSize: compactSubFontPx,
                  fontWeight: 'bold',
                  marginTop: '1px',
                  overflowWrap: 'anywhere',
                }}
              >
                কোড: {toBengaliDigits(sub.new37Code)}
              </div>
            )}
          </td>
          <td
            style={{
              textAlign: 'center',
              whiteSpace: 'pre-line',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {sub.qtyRateText}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {fmtBnAmount(sub.expectedNum)}
          </td>
          <td
            style={{
              textAlign: 'center',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            <div>{toBengaliDigits(sub.challanNo)}</div>
            {sub.challanDate && (
              <div style={{ fontSize: compactSubFontPx }}>
                {toBengaliDigits(sub.challanDate)}
              </div>
            )}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontWeight: 'bold',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {fmtBnAmount(sub.depositedNum)}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {sub.gormilText}
          </td>
          <td
            style={{
              fontSize: compactDetailFontPx,
              whiteSpace: 'pre-line',
              padding: cellPad,
              ...longTextCellStyle,
            }}
          >
            {sub.comment}
          </td>
          {customCols.map((col) => (
            <td
              key={`${sub.key}-${col.id}`}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {toBengaliDigits(
                sub.customFields?.[col.id] ??
                  (subIdx === 0 ? row.customFields?.[col.id] : '') ??
                  ''
              )}
            </td>
          ))}
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {row.doNo ? (
                <div>
                  <div style={{ fontWeight: 'bold' }}>
                    {toBengaliDigits(row.doNo)}
                  </div>
                  {row.doIssueDate && (
                    <div style={{ fontSize: compactSubFontPx }}>
                      {toBengaliDigits(showDate(row.doIssueDate))}
                    </div>
                  )}
                </div>
              ) : (
                ''
              )}
            </td>
          )}
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                verticalAlign: 'middle',
                fontSize: compactSubFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {renderGroupSignatureCell(subs)}
            </td>
          )}
        </tr>
      ))
    );
  }

  function renderGrainA4TotalsRow(includeMeasureRef = false) {
    if (!report || report.rows.length === 0) return null;
    return (
      <tr
        ref={includeMeasureRef ? measureTotalsRef : undefined}
        style={{ backgroundColor: '#f1f5f9' }}
      >
        <th
          colSpan={3}
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          মোট ({toBengaliDigits(reportBreakdown.totalChallans)}টি চালান — মূল:{' '}
          {toBengaliDigits(reportBreakdown.mainCount)}, আয়কর:{' '}
          {toBengaliDigits(reportBreakdown.taxCount)}
          {reportBreakdown.vatCount > 0
            ? `, ভ্যাট: ${toBengaliDigits(reportBreakdown.vatCount)}`
            : ''}
          )
        </th>
        <th
          style={{
            textAlign: 'center',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          {fmtBnQty(registerTotals.qtyTotal)}
        </th>
        <th
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          {fmtBnAmount(registerTotals.expectedTotal)}
        </th>
        <th style={{ padding: cellPad }} />
        <th
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          {fmtBnAmount(registerTotals.depositedTotal)}
        </th>
        <th
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          {fmtBnAmount(registerTotals.gormilTotal)}
        </th>
        <th style={{ padding: cellPad }} />
        {customCols.map((col) => (
          <th key={`foot-${col.id}`} style={{ padding: cellPad }} />
        ))}
        <th style={{ padding: cellPad }} />
        <th style={{ padding: cellPad }} />
      </tr>
    );
  }

  function renderLicenseA4Thead() {
    return (
      <tr>
        <th
          style={{
            width: licenseWidths[0],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          ক্রমিক
        </th>
        <th
          style={{
            width: licenseWidths[1],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          খাত, লাইসেন্সধারী ও ঠিকানা
        </th>
        <th
          style={{
            width: licenseWidths[2],
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          প্রতিষ্ঠান ও বিবরণ
        </th>
        <th
          style={{
            width: licenseWidths[3],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          চালান নং ও তারিখ
        </th>
        <th
          style={{
            width: licenseWidths[4],
            textAlign: 'right',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          সরকারি মূল্য
        </th>
        <th
          style={{
            width: licenseWidths[5],
            textAlign: 'right',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          জমাকৃত টাকা
        </th>
        <th
          style={{
            width: licenseWidths[6],
            textAlign: 'right',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          গরমিল
        </th>
        <th
          style={{
            width: licenseWidths[7],
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          মন্তব্য
        </th>
        {customCols.map((col, cIdx) => (
          <th
            key={col.id}
            style={{
              width: licenseWidths[8 + cIdx],
              textAlign: 'center',
              fontSize: theadFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {col.label}
          </th>
        ))}
        {showLicenseDoColumn && (
          <th
            style={{
              width: licenseWidths[8 + customCols.length],
              textAlign: 'center',
              fontSize: theadFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            ডিও নং ও তারিখ
          </th>
        )}
        <th
          style={{
            width:
              licenseWidths[
                8 + customCols.length + (showLicenseDoColumn ? 1 : 0)
              ],
            textAlign: 'center',
            fontSize: theadFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          স্বাক্ষর
        </th>
      </tr>
    );
  }

  function renderLicenseA4Rows(rows: ChunkedPageRow[], forMeasure = false) {
    return rows.flatMap(({ row, globalIndex, subs }) =>
      subs.map((sub, subIdx) => (
        <tr
          key={forMeasure ? `ml-${sub.key}` : sub.key}
          data-measure-group={forMeasure ? globalIndex : undefined}
        >
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                fontWeight: 'bold',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {toBengaliDigits(globalIndex + 1)}
            </td>
          )}
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {row.category && (
                <div
                  style={{
                    fontSize: compactSubFontPx,
                    fontWeight: 'bold',
                    color: '#334155',
                    marginBottom: '1px',
                  }}
                >
                  {row.category}
                  {row.licenseActionType ? ` (${row.licenseActionType})` : ''}
                </div>
              )}
              <div style={{ fontWeight: 'bold' }}>{row.dealerName || '—'}</div>
              {row.unionName && (
                <div style={{ fontSize: compactSubFontPx }}>{row.unionName}</div>
              )}
              {row.licenseNo && (
                <div style={{ fontSize: compactSubFontPx }}>
                  লাইঃ {toBengaliDigits(row.licenseNo)}
                </div>
              )}
            </td>
          )}
          <td
            style={{
              fontSize: compactDetailFontPx,
              padding: cellPad,
              ...longTextCellStyle,
            }}
          >
            <div>{sub.orgDesc}</div>
            {sub.khatLabel && (
              <div
                style={{
                  fontSize: compactSubFontPx,
                  fontWeight: 'bold',
                  color: '#334155',
                  marginTop: '1px',
                }}
              >
                খাত: {sub.khatLabel}
              </div>
            )}
            {sub.new37Code && (
              <div
                style={{
                  fontSize: compactSubFontPx,
                  fontWeight: 'bold',
                  marginTop: '1px',
                  overflowWrap: 'anywhere',
                }}
              >
                কোড: {toBengaliDigits(sub.new37Code)}
              </div>
            )}
          </td>
          <td
            style={{
              textAlign: 'center',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            <div>{toBengaliDigits(sub.challanNo)}</div>
            {sub.challanDate && (
              <div style={{ fontSize: compactSubFontPx }}>
                {toBengaliDigits(sub.challanDate)}
              </div>
            )}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {fmtBnAmount(sub.expectedNum)}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontWeight: 'bold',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {fmtBnAmount(sub.depositedNum)}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellWrapStyle,
            }}
          >
            {sub.gormilText}
          </td>
          <td
            style={{
              fontSize: compactDetailFontPx,
              whiteSpace: 'pre-line',
              padding: cellPad,
              ...longTextCellStyle,
            }}
          >
            {sub.comment}
          </td>
          {customCols.map((col) => (
            <td
              key={`${sub.key}-${col.id}`}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {toBengaliDigits(
                sub.customFields?.[col.id] ??
                  (subIdx === 0 ? row.customFields?.[col.id] : '') ??
                  ''
              )}
            </td>
          ))}
          {showLicenseDoColumn && subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {row.doNo ? (
                <div>
                  <div style={{ fontWeight: 'bold' }}>
                    {toBengaliDigits(row.doNo)}
                  </div>
                  {row.doIssueDate && (
                    <div style={{ fontSize: compactSubFontPx }}>
                      {toBengaliDigits(showDate(row.doIssueDate))}
                    </div>
                  )}
                </div>
              ) : (
                ''
              )}
            </td>
          )}
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                verticalAlign: 'middle',
                fontSize: compactSubFontPx,
                padding: cellPad,
                ...cellWrapStyle,
              }}
            >
              {renderGroupSignatureCell(subs)}
            </td>
          )}
        </tr>
      ))
    );
  }

  function renderLicenseA4TotalsRow(includeMeasureRef = false) {
    if (!report || report.rows.length === 0) return null;
    return (
      <tr
        ref={includeMeasureRef ? measureTotalsRef : undefined}
        style={{ backgroundColor: '#f1f5f9' }}
      >
        <th
          colSpan={4}
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          মোট ({toBengaliDigits(reportBreakdown.totalChallans)}টি চালান — মূল:{' '}
          {toBengaliDigits(reportBreakdown.mainCount)}, আয়কর:{' '}
          {toBengaliDigits(reportBreakdown.taxCount)}, ভ্যাট:{' '}
          {toBengaliDigits(reportBreakdown.vatCount)})
        </th>
        <th
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          {fmtBnAmount(registerTotals.expectedTotal)}
        </th>
        <th
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          {fmtBnAmount(registerTotals.depositedTotal)}
        </th>
        <th
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellWrapStyle,
          }}
        >
          {fmtBnAmount(registerTotals.gormilTotal)}
        </th>
        <th style={{ padding: cellPad }} />
        {customCols.map((col) => (
          <th key={`foot-${col.id}`} style={{ padding: cellPad }} />
        ))}
        {showLicenseDoColumn && <th style={{ padding: cellPad }} />}
        <th style={{ padding: cellPad }} />
      </tr>
    );
  }

  return (
    <div
      className="space-y-4 pb-20"
      onTouchStart={handleSwipeStart}
      onTouchEnd={handleSwipeEnd}
    >
      {/* Dynamic Print Page Orientation Rule */}
      <style>{`@media print { @page { size: A4 ${orientation}; margin: 6.5mm; } }`}</style>

      {/* Compact Single-Row Controls */}
      <section className="no-print rounded-2xl border border-slate-200 bg-white p-2.5 sm:p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 w-full sm:w-auto">
            <button
              type="button"
              onClick={() => switchRegisterType('grain')}
              className={`inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                registerType === 'grain'
                  ? 'bg-rose-600 text-white shadow-xs'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              <Wheat className="h-3.5 w-3.5" />
              খাদ্যশস্য
            </button>
            <button
              type="button"
              onClick={() => switchRegisterType('license')}
              className={`inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                registerType === 'license'
                  ? 'bg-teal-700 text-white shadow-xs'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              <FileBadge2 className="h-3.5 w-3.5" />
              লাইসেন্স
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => applyPreset('today')}
              className={`rounded-lg px-2 py-1 text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                datePreset === 'today'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              আজ
            </button>
            <button
              type="button"
              onClick={() => applyPreset('thisMonth')}
              className={`rounded-lg px-2 py-1 text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                datePreset === 'thisMonth'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              এই মাস
            </button>
            <button
              type="button"
              onClick={() => applyPreset('lastMonth')}
              className={`rounded-lg px-2 py-1 text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                datePreset === 'lastMonth'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              গত মাস
            </button>
            <button
              type="button"
              onClick={() => applyPreset('all')}
              className={`rounded-lg px-2 py-1 text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                datePreset === 'all'
                  ? 'bg-teal-700 text-white shadow-xs'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              সব তারিখ
            </button>
            {statusText && (
              <span className="px-1.5 text-[11px] font-bold text-rose-700 tabular-nums whitespace-nowrap">
                {statusText}
              </span>
            )}
          </div>
        </div>

        {/* Single-Row Symbolic Filter Bar */}
        <div className="flex flex-nowrap items-center gap-1 sm:gap-2">
          <div
            onClick={() => {
              const el = startDateInputRef.current;
              if (el && 'showPicker' in el && typeof el.showPicker === 'function') {
                try {
                  el.showPicker();
                } catch {
                  el.focus();
                }
              }
            }}
            title="শুরুর তারিখ"
            className="relative flex h-9 flex-1 min-w-0 items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white px-1.5 text-[11px] font-bold text-slate-800 hover:border-slate-500 cursor-pointer"
          >
            <Calendar className="h-3.5 w-3.5 shrink-0 text-rose-700" />
            <span className="truncate tabular-nums">
              {datePreset === 'all' ? 'শুরু হতে' : formatShortChipDate(startDateIso)}
            </span>
            <input
              ref={startDateInputRef}
              id="reportStartDate"
              type="date"
              aria-label="শুরুর তারিখ"
              value={startDateIso}
              onChange={(e) => {
                const next = e.target.value;
                userSelectedDateRef.current = true;
                setDatePreset('custom');
                setStartDateIso(next);
                if (next && endDateIso && next <= endDateIso) {
                  void runReport({
                    startISO: next,
                    endISO: endDateIso,
                    allDates: false,
                  });
                }
              }}
              className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
            />
          </div>

          <div
            onClick={() => {
              const el = endDateInputRef.current;
              if (el && 'showPicker' in el && typeof el.showPicker === 'function') {
                try {
                  el.showPicker();
                } catch {
                  el.focus();
                }
              }
            }}
            title="শেষ তারিখ"
            className="relative flex h-9 flex-1 min-w-0 items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white px-1.5 text-[11px] font-bold text-slate-800 hover:border-slate-500 cursor-pointer"
          >
            <Calendar className="h-3.5 w-3.5 shrink-0 text-teal-700" />
            <span className="truncate tabular-nums">
              {datePreset === 'all' ? 'সকল' : formatShortChipDate(endDateIso)}
            </span>
            <input
              ref={endDateInputRef}
              id="reportEndDate"
              type="date"
              aria-label="শেষ তারিখ"
              value={endDateIso}
              onChange={(e) => {
                const next = e.target.value;
                userSelectedDateRef.current = true;
                setDatePreset('custom');
                setEndDateIso(next);
                if (startDateIso && next && startDateIso <= next) {
                  void runReport({
                    startISO: startDateIso,
                    endISO: next,
                    allDates: false,
                  });
                }
              }}
              className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
            />
          </div>

          <select
            id="reportCategory"
            aria-label="খাত"
            value={category}
            onChange={(e) => {
              const next = e.target.value;
              setCategory(next);
              void runReport({ category: next });
            }}
            className="h-9 flex-1 min-w-0 rounded-xl border border-slate-300 bg-white px-1.5 text-[11px] font-bold text-slate-900 focus:border-slate-900 focus:outline-none truncate"
          >
            <option value="সকল">সকল খাত</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {registerType === 'license' ? (
            <select
              id="reportActionType"
              aria-label="ধরণ"
              value={actionType}
              onChange={(e) => {
                const next = e.target.value;
                setActionType(next);
                void runReport({ actionType: next });
              }}
              className="h-9 flex-1 min-w-0 rounded-xl border border-slate-300 bg-white px-1.5 text-[11px] font-bold text-slate-900 focus:border-slate-900 focus:outline-none truncate"
            >
              <option value="সকল">সব ধরণ</option>
              <option value="নতুন">নতুন</option>
              <option value="নবায়ন">নবায়ন</option>
              <option value="জরিমানা">জরিমানা</option>
              <option value="অন্যান্য">অন্যান্য</option>
            </select>
          ) : (
            <select
              id="reportUnion"
              aria-label="ইউনিয়ন"
              value={unionName}
              onChange={(e) => {
                const next = e.target.value;
                setUnionName(next);
                void runReport({ unionName: next });
              }}
              className="h-9 flex-1 min-w-0 rounded-xl border border-slate-300 bg-white px-1.5 text-[11px] font-bold text-slate-900 focus:border-slate-900 focus:outline-none truncate"
            >
              <option value="সব ইউনিয়ন">সব ইউনিয়ন</option>
              {unions.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            disabled={loading}
            onClick={() => void runReport()}
            title="সার্চ / রিপোর্ট দেখুন"
            aria-label="সার্চ"
            className="inline-flex h-9 w-9 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
          </button>
        </div>
      </section>

      {/* Helpful Empty-State Actions */}
      {report && appliedMeta && report.rows.length === 0 && (
        <section className="no-print rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center space-y-2.5">
          <div className="text-xs font-bold text-amber-950">
            {(report.totalInGroup ?? 0) > 0
              ? `এই ফিল্টারে কোনো ${
                  activeMode === 'grain' ? 'খাদ্যশস্য' : 'লাইসেন্স'
                } চালান নেই, তবে মোট ${toBengaliDigits(
                  report.totalInGroup ?? 0
                )}টি চালান সংরক্ষিত আছে।`
              : `এই সময়ে কোনো ${
                  activeMode === 'grain' ? 'খাদ্যশস্য' : 'লাইসেন্স বা অন্যান্য'
                } চালান পাওয়া যায়নি।`}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {(report.totalInGroup ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => {
                  setCategory('সকল');
                  setActionType('সকল');
                  setUnionName('সব ইউনিয়ন');
                  userSelectedDateRef.current = true;
                  setDatePreset('all');
                  setStartDateIso('2020-01-01');
                  const today = getTodayIso();
                  setEndDateIso(today);
                  void runReport({
                    category: 'সকল',
                    actionType: 'সকল',
                    unionName: 'সব ইউনিয়ন',
                    startISO: '2020-01-01',
                    endISO: today,
                    allDates: true,
                  });
                }}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800 whitespace-nowrap cursor-pointer"
              >
                সব তারিখের {toBengaliDigits(report.totalInGroup ?? 0)}টি চালান দেখুন
              </button>
            )}
            {onSyncSheet && (
              <button
                type="button"
                disabled={syncing}
                onClick={() => void onSyncSheet()}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-4 py-2 text-xs font-bold text-slate-800 hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap cursor-pointer"
              >
                <RefreshCw
                  className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`}
                />
                শিট থেকে সিঙ্ক করুন
              </button>
            )}
          </div>
        </section>
      )}

      {/* Off-Screen DOM Measurement Sheet (Excluded from Print & PDF) */}
      {report && appliedMeta && (
        <div className="a4-pdf-staging no-print" aria-hidden="true">
          <div
            ref={measurePageRef}
            className={`a4-sheet-page a4-register-page font-nikosh ${
              orientation === 'portrait'
                ? 'a4-page-portrait'
                : 'a4-page-landscape'
            }`}
          >
            <div className="a4-page-content">
              <div ref={measureHeaderRef}>{renderA4Header()}</div>
              {activeMode === 'grain' ? (
                <table
                  style={{
                    width: '100%',
                    tableLayout: 'fixed',
                    borderCollapse: 'collapse',
                  }}
                >
                  <thead ref={measureTheadRef}>{renderGrainA4Thead()}</thead>
                  <tbody ref={measureTbodyRef}>
                    {renderGrainA4Rows(allPreparedRows, true)}
                    {renderGrainA4TotalsRow(true)}
                  </tbody>
                </table>
              ) : (
                <table
                  style={{
                    width: '100%',
                    tableLayout: 'fixed',
                    borderCollapse: 'collapse',
                  }}
                >
                  <thead ref={measureTheadRef}>{renderLicenseA4Thead()}</thead>
                  <tbody ref={measureTbodyRef}>
                    {renderLicenseA4Rows(allPreparedRows, true)}
                    {renderLicenseA4TotalsRow(true)}
                  </tbody>
                </table>
              )}
            </div>
            <div ref={measureFooterRef}>
              {renderA4Footer(1, Math.max(1, pages.length))}
            </div>
          </div>
        </div>
      )}

      {/* Visible A4 Register Preview Directly Below Filters at 39% Default Zoom */}
      {report && appliedMeta && (
        <A4FitPreview
          orientation={orientation}
          defaultScale={0.39}
          scale={previewScale}
          hideZoomControls
          onScaleChange={setPreviewScale}
          onResolvedScale={(s) => {
            activeScaleRef.current = s;
          }}
          leftSlot={
            <div className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 tabular-nums shadow-2xs">
              <span>{activeMode === 'grain' ? 'খাদ্যশস্য' : 'লাইসেন্স'}</span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-900">
                মোট চালান: {toBengaliDigits(reportBreakdown.totalChallans)}টি
              </span>
              <span className="font-semibold text-slate-600">
                (মূল: {toBengaliDigits(reportBreakdown.mainCount)} · আয়কর:{' '}
                {toBengaliDigits(reportBreakdown.taxCount)} · ভ্যাট:{' '}
                {toBengaliDigits(reportBreakdown.vatCount)})
              </span>
              {registerTotals.depositedTotal > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-rose-700">
                    মোট {fmtBnAmount(registerTotals.depositedTotal)} ৳
                  </span>
                </>
              )}
            </div>
          }
        >
          <div
            id="challanReportPrintArea"
            ref={printAreaRef}
            className="font-nikosh"
          >
            {pages.map((pageRows, pageIdx) => {
              const isLastPage = pageIdx === pages.length - 1;
              return (
                <div
                  key={`a4-page-${pageIdx}`}
                  className={`a4-sheet-page a4-register-page font-nikosh ${
                    orientation === 'portrait'
                      ? 'a4-page-portrait'
                      : 'a4-page-landscape'
                  }`}
                >
                  <div className="a4-page-content">
                    {renderA4Header()}

                    {activeMode === 'grain' ? (
                      <table
                        style={{
                          width: '100%',
                          tableLayout: 'fixed',
                          borderCollapse: 'collapse',
                        }}
                      >
                        <thead>{renderGrainA4Thead()}</thead>
                        <tbody>
                          {pageRows.length === 0 ? (
                            <tr>
                              <td
                                colSpan={11 + customCols.length}
                                style={{
                                  textAlign: 'center',
                                  padding: '16px',
                                  fontSize: cellFontPx,
                                }}
                              >
                                এই সময়ে কোনো খাদ্যশস্য চালান পাওয়া যায়নি।
                              </td>
                            </tr>
                          ) : (
                            renderGrainA4Rows(pageRows, false)
                          )}
                          {isLastPage && renderGrainA4TotalsRow(false)}
                        </tbody>
                      </table>
                    ) : (
                      <table
                        style={{
                          width: '100%',
                          tableLayout: 'fixed',
                          borderCollapse: 'collapse',
                        }}
                      >
                        <thead>{renderLicenseA4Thead()}</thead>
                        <tbody>
                          {pageRows.length === 0 ? (
                            <tr>
                              <td
                                colSpan={
                                  9 +
                                  customCols.length +
                                  (showLicenseDoColumn ? 1 : 0)
                                }
                                style={{
                                  textAlign: 'center',
                                  padding: '16px',
                                  fontSize: cellFontPx,
                                }}
                              >
                                এই সময়ে কোনো লাইসেন্স বা অন্যান্য চালান পাওয়া যায়নি।
                              </td>
                            </tr>
                          ) : (
                            renderLicenseA4Rows(pageRows, false)
                          )}
                          {isLastPage && renderLicenseA4TotalsRow(false)}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Clean Dedicated Page Footer (Never overlaps table!) */}
                  {renderA4Footer(pageIdx + 1, pages.length)}
                </div>
              );
            })}
          </div>
        </A4FitPreview>
      )}

      {/* Floating Action Bar (Far Left) + Bottom Zoom +/- Controls */}
      {report && (
        <div
          className="no-print fixed bottom-20 inset-x-2 z-40 flex items-center justify-between gap-1.5 pointer-events-none md:inset-x-6 md:bottom-6"
          role="toolbar"
          aria-label="রেজিস্টার প্রিন্ট, পেজ ও জুম নিয়ন্ত্রণ"
        >
          <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-slate-200 bg-white/95 p-1 shadow-xl backdrop-blur">
            <button
              type="button"
              onClick={() => setOrientation('portrait')}
              title="পোর্ট্রেট মোড (A4)"
              aria-label="পোর্ট্রেট মোড"
              className={`flex h-9 w-8 sm:h-11 sm:w-11 items-center justify-center rounded-xl transition-colors cursor-pointer ${
                orientation === 'portrait'
                  ? 'bg-rose-700 text-white shadow-xs'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <RectangleVertical className="h-4 w-4 sm:h-5 sm:w-5" />
            </button>

            <button
              type="button"
              onClick={() => setOrientation('landscape')}
              title="ল্যান্ডস্কেপ মোড (A4)"
              aria-label="ল্যান্ডস্কেপ মোড"
              className={`flex h-9 w-8 sm:h-11 sm:w-11 items-center justify-center rounded-xl transition-colors cursor-pointer ${
                orientation === 'landscape'
                  ? 'bg-rose-700 text-white shadow-xs'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <RectangleHorizontal className="h-4 w-4 sm:h-5 sm:w-5" />
            </button>

            <div className="h-5 w-px bg-slate-200 mx-0.5" aria-hidden="true" />

            <button
              type="button"
              onClick={downloadExcelCsv}
              title="Excel / CSV ডাউনলোড"
              aria-label="Excel ডাউনলোড"
              className="flex h-9 w-8 sm:h-11 sm:w-11 items-center justify-center rounded-xl bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 sm:h-5 sm:w-5" />
            </button>

            <button
              type="button"
              disabled={pdfLoading}
              onClick={() => void downloadPdf()}
              title="PDF ডাউনলোড (Nikosh)"
              aria-label="PDF ডাউনলোড"
              className="flex h-9 w-8 sm:h-11 sm:w-11 items-center justify-center rounded-xl bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 cursor-pointer"
            >
              {pdfLoading ? (
                <Loader2 className="h-4 w-4 sm:h-5 sm:w-5 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4 sm:h-5 sm:w-5" />
              )}
            </button>

            <button
              type="button"
              onClick={() =>
                void triggerPrint(
                  `Challan_Register_${appliedMeta?.startISO || 'report'}`,
                  downloadPdf
                )
              }
              title="প্রিন্ট (A4)"
              aria-label="প্রিন্ট"
              className="flex h-9 w-8 sm:h-11 sm:w-11 items-center justify-center rounded-xl bg-slate-900 text-white hover:bg-slate-800 cursor-pointer"
            >
              <Printer className="h-4 w-4 sm:h-5 sm:w-5" />
            </button>
          </div>

          <div className="pointer-events-auto flex items-center gap-0.5 rounded-2xl border border-slate-200 bg-white/95 p-1 shadow-xl backdrop-blur">
            <button
              type="button"
              onClick={() => stepPreviewZoom(-0.05)}
              title="জুম কমান"
              aria-label="জুম কমান"
              className="flex h-9 w-8 sm:h-11 sm:w-10 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 cursor-pointer"
            >
              <Minus className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => setPreviewScale(null)}
              title="স্ক্রিন অনুযায়ী ফিট করুন"
              aria-label="স্ক্রিন অনুযায়ী ফিট"
              className={`inline-flex h-9 sm:h-11 items-center gap-1 rounded-xl px-1.5 sm:px-2.5 text-[11px] sm:text-xs font-bold transition-colors whitespace-nowrap cursor-pointer ${
                previewScale === null
                  ? 'bg-rose-700 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <Maximize2 className="h-3.5 w-3.5" />
              <span>ফিট</span>
            </button>

            <button
              type="button"
              onClick={() => stepPreviewZoom(0.05)}
              title="জুম বাড়ান"
              aria-label="জুম বাড়ান"
              className="flex h-9 w-8 sm:h-11 sm:w-10 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 cursor-pointer"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}



