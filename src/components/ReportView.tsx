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
  showDate,
  toBengaliDigits,
} from '../utils/challan.ts';
import { apiFetch } from '../utils/api.ts';
import { downloadNikoshPdf } from '../utils/pdfExport.ts';

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
  const now = new Date();
  return `${String(now.getDate()).padStart(2, '0')}/${String(
    now.getMonth() + 1
  ).padStart(2, '0')}/${now.getFullYear()}`;
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
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (active) setFontsReadyTick((n) => n + 1);
      });
    }
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
          setStatusText(`${toBengaliDigits(allJson.rows.length)}টি`);
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
      setStatusText(`${toBengaliDigits(json.rows.length)}টি`);
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
            sub.orgDesc,
            sub.new37Code,
            sIdx === 0 ? row.quantity || '' : '',
            sIdx === 0 ? row.rate || '' : '',
            sub.expectedNum || '',
            sub.challanNo,
            sub.challanDate,
            sub.depositedNum || '',
            sub.gormilText,
            sIdx === 0 ? row.doNo || '' : '',
            sIdx === 0 ? row.doIssueDate || '' : '',
            sub.comment,
          ]
            .map(escapeCell)
            .join(',')
        );
      });
    });

    const blob = new Blob(['\uFEFF' + csvRows.join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Challan_Register_${appliedMeta.startISO}_${appliedMeta.endISO}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

      subs.push({
        key: `${row.recordId}-main`,
        orgDesc:
          [row.toOrganization, row.description].filter(Boolean).join(' - ') ||
          'খাদ্য অধিদপ্তর',
        khatLabel: row.category,
        new37Code: row.new37Code || '',
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
        comment: row.comment || '',
        canSign,
      });
    }

    if (hasTax) {
      const taxAmt = Number(row.incomeTaxAmount || 0);
      const expectedTax = Number(row.expectedTaxAmount || 0);
      const gormil = formatGormil(expectedTax, taxAmt);
      const canSign =
        taxAmt > 0 && (expectedTax <= 0 || gormil.shortfall <= 0);

      subs.push({
        key: `${row.recordId}-tax`,
        orgDesc: 'কর অঞ্চল, বরিশাল — আয়কর',
        khatLabel: 'আয়কর',
        new37Code: row.new37Code || '',
        qtyRateText: row.quantity ? fmtBnQty(row.quantity) : '',
        expectedNum: expectedTax,
        challanNo: row.incomeTaxChallanNo || '',
        challanDate: row.incomeTaxDate || showDate(row.challanDate),
        depositedNum: taxAmt,
        gormilText: gormil.text,
        shortfall: gormil.shortfall,
        comment: '',
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

      subs.push({
        key: `${row.recordId}-lic-main`,
        orgDesc: row.toOrganization || row.category,
        khatLabel: `${row.category}${actionLabel ? ` (${actionLabel})` : ''}`,
        new37Code: row.new37Code || '',
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
        comment: row.comment || '',
        canSign,
      });
    }

    if (hasTax) {
      const taxAmt = Number(row.incomeTaxAmount || 0);
      const expectedTax =
        row.expectedTaxAmount > 0 ? row.expectedTaxAmount : fee?.taxAmount || 0;
      const gormil = formatGormil(expectedTax, taxAmt);
      subs.push({
        key: `${row.recordId}-lic-tax`,
        orgDesc: 'আয়কর',
        khatLabel: 'আয়কর',
        new37Code: row.new37Code || '',
        qtyRateText: '',
        expectedNum: expectedTax,
        challanNo: row.incomeTaxChallanNo || '',
        challanDate: row.incomeTaxDate || showDate(row.challanDate),
        depositedNum: taxAmt,
        gormilText: gormil.text,
        shortfall: gormil.shortfall,
        comment: '',
        canSign: taxAmt > 0 && (expectedTax <= 0 || gormil.shortfall <= 0),
      });
    }

    if (hasVat) {
      const vatAmt = Number(row.vatAmount || 0);
      const expectedVat = fee?.vatAmount || 0;
      const gormil = formatGormil(expectedVat, vatAmt);
      subs.push({
        key: `${row.recordId}-lic-vat`,
        orgDesc: 'ভ্যাট',
        khatLabel: 'ভ্যাট',
        new37Code: row.new37Code || '',
        qtyRateText: '',
        expectedNum: expectedVat,
        challanNo: row.vatChallanNo || '',
        challanDate: row.vatDate || showDate(row.challanDate),
        depositedNum: vatAmt,
        gormilText: gormil.text,
        shortfall: gormil.shortfall,
        comment: '',
        canSign: vatAmt > 0 && (expectedVat <= 0 || gormil.shortfall <= 0),
      });
    }

    return subs;
  }

  const activeMode = appliedMeta?.registerType ?? registerType;

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

    const maxHeightBudget = orientation === 'portrait' ? 880 : 540;
    const descChars = orientation === 'portrait' ? 16 : 26;
    const dealerChars = orientation === 'portrait' ? 13 : 21;
    const commentChars = orientation === 'portrait' ? 9 : 15;
    const challanChars = orientation === 'portrait' ? 14 : 20;

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
          (s.new37Code ? 1 : 0);
        const commentLines = Math.max(
          1,
          Math.ceil((s.comment?.length || 0) / commentChars)
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
        total += Math.max(32, lines * 14 + 8);
      }

      const spanMinHeight = Math.max(dealerLines, doLines) * 14 + 8;
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

  // Column order: ... মন্তব্য | [CustomCols] | ডিও নং ও তারিখ | স্বাক্ষর (LAST)
  // Normalize column widths so sum ALWAYS equals strictly 100% (prevents border overflow)
  const grainWidths = useMemo(() => {
    const base = [4, 12.5, 15, 7, 7, 7.5, 12, 8, 5.5, 7.5]; // 86.0 (cols 0..9)
    const customWeights = customCols.map(() => 5.5);
    const all = [...base, ...customWeights, 8, 6]; // DO = 8, Signature = 6
    const total = all.reduce((a, b) => a + b, 0);
    return all.map((w) => `${((w / total) * 100).toFixed(2)}%`);
  }, [customCols]);

  const licenseWidths = useMemo(() => {
    const base = [4.5, 15.5, 10.5, 10, 13.5, 9, 9.5, 7, 7.5]; // 87.0 (cols 0..8)
    const customWeights = customCols.map(() => 6);
    const doWeight = showLicenseDoColumn ? [8.5] : [];
    const all = [...base, ...customWeights, ...doWeight, 7.5]; // Signature = 7.5 (LAST)
    const total = all.reduce((a, b) => a + b, 0);
    return all.map((w) => `${((w / total) * 100).toFixed(2)}%`);
  }, [customCols, showLicenseDoColumn]);

  const cellFontPx = orientation === 'portrait' ? '10px' : '11px';
  const cellPad = orientation === 'portrait' ? '2.5px 3px' : '3px 4.5px';
  const cellClipStyle = {
    overflow: 'hidden' as const,
    overflowWrap: 'anywhere' as const,
    wordBreak: 'break-word' as const,
  };

  function formatShortChipDate(iso: string): string {
    if (!iso) return 'তারিখ';
    const parts = iso.split('-');
    if (parts.length !== 3) return toBengaliDigits(iso);
    return toBengaliDigits(`${parts[2]}/${parts[1]}/${parts[0].slice(2)}`);
  }

  function renderSignatureCell(sub: RegisterSubRow) {
    if (!sub.canSign) return null;
    if (signatureImage) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <img
            src={signatureImage}
            alt="স্বাক্ষর"
            style={{
              height: '20px',
              maxWidth: '58px',
              objectFit: 'contain',
              display: 'block',
            }}
          />
          <span style={{ fontSize: '8px', lineHeight: 1.1 }}>
            {signatureText}
          </span>
        </div>
      );
    }
    return <span>{signatureText}</span>;
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
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          ক্রমিক
        </th>
        <th
          style={{
            width: grainWidths[1],
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          ইউনিয়ন ও ডিলার
        </th>
        <th
          style={{
            width: grainWidths[2],
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          প্রতিষ্ঠান ও বিবরণ
        </th>
        <th
          style={{
            width: grainWidths[3],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          খাত
        </th>
        <th
          style={{
            width: grainWidths[4],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          পরিমাণ ও দর
        </th>
        <th
          style={{
            width: grainWidths[5],
            textAlign: 'right',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          প্রাপ্য টাকা
        </th>
        <th
          style={{
            width: grainWidths[6],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          চালান নং ও তারিখ
        </th>
        <th
          style={{
            width: grainWidths[7],
            textAlign: 'right',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          জমাকৃত টাকা
        </th>
        <th
          style={{
            width: grainWidths[8],
            textAlign: 'right',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          গরমিল
        </th>
        <th
          style={{
            width: grainWidths[9],
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          মন্তব্য
        </th>
        {customCols.map((col, cIdx) => (
          <th
            key={col.id}
            style={{
              width: grainWidths[10 + cIdx],
              textAlign: 'center',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {col.label}
          </th>
        ))}
        <th
          style={{
            width: grainWidths[10 + customCols.length],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          ডিও নং ও তারিখ
        </th>
        <th
          style={{
            width: grainWidths[11 + customCols.length],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
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
                ...cellClipStyle,
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
                ...cellClipStyle,
              }}
            >
              <div style={{ fontWeight: 'bold' }}>{row.dealerName || '—'}</div>
              {row.unionName && (
                <div style={{ fontSize: '9.5px' }}>{row.unionName}</div>
              )}
            </td>
          )}
          <td style={{ fontSize: cellFontPx, padding: cellPad, ...cellClipStyle }}>
            <div>{sub.orgDesc}</div>
            {sub.new37Code && (
              <div
                style={{ fontSize: '9.5px', fontWeight: 'bold', marginTop: '1px' }}
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
              ...cellClipStyle,
            }}
          >
            {sub.khatLabel}
          </td>
          <td
            style={{
              textAlign: 'center',
              whiteSpace: 'pre-line',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {sub.qtyRateText}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {fmtBnAmount(sub.expectedNum)}
          </td>
          <td
            style={{
              textAlign: 'center',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            <div>{toBengaliDigits(sub.challanNo)}</div>
            {sub.challanDate && (
              <div style={{ fontSize: '9.5px' }}>
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
              ...cellClipStyle,
            }}
          >
            {fmtBnAmount(sub.depositedNum)}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {sub.gormilText}
          </td>
          <td style={{ fontSize: '9.5px', padding: cellPad, ...cellClipStyle }}>
            {sub.comment}
          </td>
          {customCols.map((col) => (
            <td
              key={`${sub.key}-${col.id}`}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellClipStyle,
              }}
            >
              {subIdx === 0
                ? toBengaliDigits(row.customFields?.[col.id] || '')
                : ''}
            </td>
          ))}
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellClipStyle,
              }}
            >
              {row.doNo ? (
                <div>
                  <div style={{ fontWeight: 'bold' }}>
                    {toBengaliDigits(row.doNo)}
                  </div>
                  {row.doIssueDate && (
                    <div style={{ fontSize: '9.5px' }}>
                      {toBengaliDigits(row.doIssueDate)}
                    </div>
                  )}
                </div>
              ) : (
                ''
              )}
            </td>
          )}
          <td
            style={{
              textAlign: 'center',
              fontSize: '9px',
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {renderSignatureCell(sub)}
          </td>
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
          colSpan={4}
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
          }}
        >
          মোট ({toBengaliDigits(report.rows.length)}টি)
        </th>
        <th
          style={{
            textAlign: 'center',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
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
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          ক্রমিক
        </th>
        <th
          style={{
            width: licenseWidths[1],
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          লাইসেন্সধারীর নাম ও ঠিকানা
        </th>
        <th
          style={{
            width: licenseWidths[2],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          জমা কোড
        </th>
        <th
          style={{
            width: licenseWidths[3],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          খাত
        </th>
        <th
          style={{
            width: licenseWidths[4],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          চালান নং ও তারিখ
        </th>
        <th
          style={{
            width: licenseWidths[5],
            textAlign: 'right',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          সরকারি মূল্য
        </th>
        <th
          style={{
            width: licenseWidths[6],
            textAlign: 'right',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          জমাকৃত টাকা
        </th>
        <th
          style={{
            width: licenseWidths[7],
            textAlign: 'right',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          গরমিল
        </th>
        <th
          style={{
            width: licenseWidths[8],
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
          }}
        >
          মন্তব্য
        </th>
        {customCols.map((col, cIdx) => (
          <th
            key={col.id}
            style={{
              width: licenseWidths[9 + cIdx],
              textAlign: 'center',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {col.label}
          </th>
        ))}
        {showLicenseDoColumn && (
          <th
            style={{
              width: licenseWidths[9 + customCols.length],
              textAlign: 'center',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            ডিও নং ও তারিখ
          </th>
        )}
        <th
          style={{
            width:
              licenseWidths[
                9 + customCols.length + (showLicenseDoColumn ? 1 : 0)
              ],
            textAlign: 'center',
            fontSize: cellFontPx,
            padding: cellPad,
            ...cellClipStyle,
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
                ...cellClipStyle,
              }}
            >
              {toBengaliDigits(globalIndex + 1)}
            </td>
          )}
          {subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{ fontSize: cellFontPx, padding: cellPad, ...cellClipStyle }}
            >
              <div style={{ fontWeight: 'bold' }}>{row.dealerName || '—'}</div>
              {row.unionName && (
                <div style={{ fontSize: '9.5px' }}>{row.unionName}</div>
              )}
              {row.licenseNo && (
                <div style={{ fontSize: '9.5px' }}>
                  লাইঃ {toBengaliDigits(row.licenseNo)}
                </div>
              )}
            </td>
          )}
          <td
            style={{
              textAlign: 'center',
              fontSize: '10px',
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {toBengaliDigits(sub.new37Code || '—')}
          </td>
          <td
            style={{
              textAlign: 'center',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {sub.khatLabel}
          </td>
          <td
            style={{
              textAlign: 'center',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            <div>{toBengaliDigits(sub.challanNo)}</div>
            {sub.challanDate && (
              <div style={{ fontSize: '9.5px' }}>
                {toBengaliDigits(sub.challanDate)}
              </div>
            )}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
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
              ...cellClipStyle,
            }}
          >
            {fmtBnAmount(sub.depositedNum)}
          </td>
          <td
            style={{
              textAlign: 'right',
              fontSize: cellFontPx,
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {sub.gormilText}
          </td>
          <td style={{ fontSize: '9.5px', padding: cellPad, ...cellClipStyle }}>
            {sub.comment}
          </td>
          {customCols.map((col) => (
            <td
              key={`${sub.key}-${col.id}`}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellClipStyle,
              }}
            >
              {subIdx === 0
                ? toBengaliDigits(row.customFields?.[col.id] || '')
                : ''}
            </td>
          ))}
          {showLicenseDoColumn && subIdx === 0 && (
            <td
              rowSpan={subs.length}
              style={{
                textAlign: 'center',
                fontSize: cellFontPx,
                padding: cellPad,
                ...cellClipStyle,
              }}
            >
              {row.doNo ? (
                <div>
                  <div style={{ fontWeight: 'bold' }}>
                    {toBengaliDigits(row.doNo)}
                  </div>
                  {row.doIssueDate && (
                    <div style={{ fontSize: '9.5px' }}>
                      {toBengaliDigits(row.doIssueDate)}
                    </div>
                  )}
                </div>
              ) : (
                ''
              )}
            </td>
          )}
          <td
            style={{
              textAlign: 'center',
              fontSize: '9px',
              padding: cellPad,
              ...cellClipStyle,
            }}
          >
            {renderSignatureCell(sub)}
          </td>
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
          colSpan={5}
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
          }}
        >
          মোট ({toBengaliDigits(report.rows.length)}টি)
        </th>
        <th
          style={{
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: cellFontPx,
            padding: cellPad,
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
      <style>{`@media print { @page { size: A4 ${orientation}; margin: 7.5mm; } }`}</style>

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

      {/* Live Normal Page Tabular Report View (Web View) */}
      {report && appliedMeta && (
        <section className="no-print rounded-2xl border border-slate-200 bg-white shadow-2xs overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-200 bg-slate-50/80 px-3.5 py-2.5 sm:px-4">
            <div className="text-xs font-bold text-slate-700 tabular-nums">
              {activeMode === 'grain' ? 'খাদ্যশস্য' : 'লাইসেন্স'}
              <span aria-hidden="true"> · </span>
              {toBengaliDigits(report.rows.length)}টি চালান
              {registerTotals.depositedTotal > 0 && (
                <>
                  <span aria-hidden="true"> · </span>
                  মোট জমা {fmtBnAmount(registerTotals.depositedTotal)} টাকা
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <div
                className="flex items-center gap-1 rounded-xl border border-slate-300 bg-white p-0.5"
                role="group"
                aria-label="PDF পেজ ওরিয়েন্টেশন"
              >
                <button
                  type="button"
                  onClick={() => setOrientation('portrait')}
                  className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer ${
                    orientation === 'portrait'
                      ? 'bg-rose-700 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <RectangleVertical className="h-3.5 w-3.5" />
                  পোর্ট্রেট
                </button>
                <button
                  type="button"
                  onClick={() => setOrientation('landscape')}
                  className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer ${
                    orientation === 'landscape'
                      ? 'bg-rose-700 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <RectangleHorizontal className="h-3.5 w-3.5" />
                  ল্যান্ডস্কেপ
                </button>
              </div>

              <button
                type="button"
                disabled={pdfLoading}
                onClick={() => void downloadPdf()}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-rose-700 px-3 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {pdfLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileDown className="h-3.5 w-3.5" />
                )}
                PDF ডাউনলোড
              </button>

              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-slate-900 px-3 text-xs font-bold text-white hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Printer className="h-3.5 w-3.5" />
                প্রিন্ট
              </button>
            </div>
          </div>

          <div className="px-3 pt-4 pb-2 text-center text-slate-950 sm:px-5">
            <div className="text-base font-bold leading-snug">
              গণপ্রজাতন্ত্রী বাংলাদেশ সরকার
            </div>
            <div className="text-sm font-bold text-slate-800">
              {settings.officeSubtitle || 'উপজেলা খাদ্য নিয়ন্ত্রকের কার্যালয়'},{' '}
              {settings.officeTitle || 'উজিরপুর, বরিশাল'}।
            </div>
            <div className="mt-0.5 text-sm font-bold text-slate-900">
              চালান রেজিস্টার —{' '}
              {activeMode === 'grain'
                ? appliedMeta.category === 'সকল'
                  ? 'খাদ্যশস্য'
                  : appliedMeta.category
                : appliedMeta.category === 'সকল'
                ? 'লাইসেন্স ও অন্যান্য'
                : appliedMeta.category}
            </div>
            <div className="mt-0.5 text-xs text-slate-600">
              তারিখ: {toBengaliDigits(showDate(appliedMeta.startISO))} হতে{' '}
              {toBengaliDigits(showDate(appliedMeta.endISO))} পর্যন্ত
              {appliedMeta.unionName !== 'সব ইউনিয়ন'
                ? ` · ইউনিয়ন: ${appliedMeta.unionName}`
                : ''}
            </div>
          </div>

          <div className="overflow-x-auto px-2 pb-4 sm:px-4">
            {activeMode === 'grain' ? (
              <table className="web-register-table min-w-[820px] text-[12px]">
                <thead>
                  <tr>
                    <th style={{ width: grainWidths[0], textAlign: 'center' }}>
                      ক্রমিক
                    </th>
                    <th style={{ width: grainWidths[1] }}>ইউনিয়ন ও ডিলার</th>
                    <th style={{ width: grainWidths[2] }}>প্রতিষ্ঠান ও বিবরণ</th>
                    <th style={{ width: grainWidths[3], textAlign: 'center' }}>
                      খাত
                    </th>
                    <th style={{ width: grainWidths[4], textAlign: 'center' }}>
                      পরিমাণ ও দর
                    </th>
                    <th style={{ width: grainWidths[5], textAlign: 'right' }}>
                      প্রাপ্য টাকা
                    </th>
                    <th style={{ width: grainWidths[6], textAlign: 'center' }}>
                      চালান নং ও তারিখ
                    </th>
                    <th style={{ width: grainWidths[7], textAlign: 'right' }}>
                      জমাকৃত টাকা
                    </th>
                    <th style={{ width: grainWidths[8], textAlign: 'right' }}>
                      গরমিল
                    </th>
                    <th style={{ width: grainWidths[9] }}>মন্তব্য</th>
                    {customCols.map((col, cIdx) => (
                      <th
                        key={`web-h-${col.id}`}
                        style={{
                          width: grainWidths[10 + cIdx],
                          textAlign: 'center',
                        }}
                      >
                        {col.label}
                      </th>
                    ))}
                    <th
                      style={{
                        width: grainWidths[10 + customCols.length],
                        textAlign: 'center',
                      }}
                    >
                      ডিও নং ও তারিখ
                    </th>
                    <th
                      style={{
                        width: grainWidths[11 + customCols.length],
                        textAlign: 'center',
                      }}
                    >
                      স্বাক্ষর
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {allPreparedRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={12 + customCols.length}
                        className="py-8 text-center text-xs text-slate-500"
                      >
                        এই সময়ে কোনো খাদ্যশস্য চালান পাওয়া যায়নি।
                      </td>
                    </tr>
                  ) : (
                    allPreparedRows.flatMap(({ row, globalIndex, subs }) =>
                      subs.map((sub, subIdx) => (
                        <tr key={`web-${sub.key}`}>
                          {subIdx === 0 && (
                            <td
                              rowSpan={subs.length}
                              className="text-center font-bold tabular-nums"
                            >
                              {toBengaliDigits(globalIndex + 1)}
                            </td>
                          )}
                          {subIdx === 0 && (
                            <td rowSpan={subs.length}>
                              <div className="font-bold text-slate-900">
                                {row.dealerName || '—'}
                              </div>
                              {row.unionName && (
                                <div className="text-[11px] text-slate-600">
                                  {row.unionName}
                                </div>
                              )}
                            </td>
                          )}
                          <td>
                            <div>{sub.orgDesc}</div>
                            {sub.new37Code && (
                              <div className="mt-0.5 text-[11px] font-bold text-slate-700">
                                কোড: {toBengaliDigits(sub.new37Code)}
                              </div>
                            )}
                          </td>
                          <td className="text-center">{sub.khatLabel}</td>
                          <td className="text-center whitespace-pre-line tabular-nums">
                            {sub.qtyRateText}
                          </td>
                          <td className="text-right tabular-nums">
                            {fmtBnAmount(sub.expectedNum)}
                          </td>
                          <td className="text-center tabular-nums">
                            <div className="font-semibold">
                              {toBengaliDigits(sub.challanNo)}
                            </div>
                            {sub.challanDate && (
                              <div className="text-[11px] text-slate-600">
                                {toBengaliDigits(sub.challanDate)}
                              </div>
                            )}
                          </td>
                          <td className="text-right font-bold tabular-nums text-slate-900">
                            {fmtBnAmount(sub.depositedNum)}
                          </td>
                          <td className="text-right tabular-nums">
                            {sub.gormilText}
                          </td>
                          <td className="text-[11px] text-slate-700">
                            {sub.comment}
                          </td>
                          {customCols.map((col) => (
                            <td
                              key={`web-${sub.key}-${col.id}`}
                              className="text-center"
                            >
                              {subIdx === 0
                                ? toBengaliDigits(row.customFields?.[col.id] || '')
                                : ''}
                            </td>
                          ))}
                          {subIdx === 0 && (
                            <td rowSpan={subs.length} className="text-center tabular-nums">
                              {row.doNo ? (
                                <div>
                                  <div className="font-bold">
                                    {toBengaliDigits(row.doNo)}
                                  </div>
                                  {row.doIssueDate && (
                                    <div className="text-[11px] text-slate-600">
                                      {toBengaliDigits(row.doIssueDate)}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                ''
                              )}
                            </td>
                          )}
                          <td className="text-center text-[10.5px]">
                            {renderSignatureCell(sub)}
                          </td>
                        </tr>
                      ))
                    )
                  )}
                  {report.rows.length > 0 && (
                    <tr className="bg-slate-100 font-bold">
                      <th colSpan={4} className="text-right">
                        মোট ({toBengaliDigits(report.rows.length)}টি)
                      </th>
                      <th className="text-center tabular-nums">
                        {fmtBnQty(registerTotals.qtyTotal)}
                      </th>
                      <th className="text-right tabular-nums">
                        {fmtBnAmount(registerTotals.expectedTotal)}
                      </th>
                      <th />
                      <th className="text-right tabular-nums">
                        {fmtBnAmount(registerTotals.depositedTotal)}
                      </th>
                      <th className="text-right tabular-nums">
                        {fmtBnAmount(registerTotals.gormilTotal)}
                      </th>
                      <th />
                      {customCols.map((col) => (
                        <th key={`web-foot-${col.id}`} />
                      ))}
                      <th />
                      <th />
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="web-register-table min-w-[780px] text-[12px]">
                <thead>
                  <tr>
                    <th style={{ width: licenseWidths[0], textAlign: 'center' }}>
                      ক্রমিক
                    </th>
                    <th style={{ width: licenseWidths[1] }}>
                      লাইসেন্সধারীর নাম ও ঠিকানা
                    </th>
                    <th style={{ width: licenseWidths[2], textAlign: 'center' }}>
                      জমা কোড
                    </th>
                    <th style={{ width: licenseWidths[3], textAlign: 'center' }}>
                      খাত
                    </th>
                    <th style={{ width: licenseWidths[4], textAlign: 'center' }}>
                      চালান নং ও তারিখ
                    </th>
                    <th style={{ width: licenseWidths[5], textAlign: 'right' }}>
                      সরকারি মূল্য
                    </th>
                    <th style={{ width: licenseWidths[6], textAlign: 'right' }}>
                      জমাকৃত টাকা
                    </th>
                    <th style={{ width: licenseWidths[7], textAlign: 'right' }}>
                      গরমিল
                    </th>
                    <th style={{ width: licenseWidths[8] }}>মন্তব্য</th>
                    {customCols.map((col, cIdx) => (
                      <th
                        key={`web-lh-${col.id}`}
                        style={{
                          width: licenseWidths[9 + cIdx],
                          textAlign: 'center',
                        }}
                      >
                        {col.label}
                      </th>
                    ))}
                    {showLicenseDoColumn && (
                      <th
                        style={{
                          width: licenseWidths[9 + customCols.length],
                          textAlign: 'center',
                        }}
                      >
                        ডিও নং ও তারিখ
                      </th>
                    )}
                    <th
                      style={{
                        width:
                          licenseWidths[
                            9 + customCols.length + (showLicenseDoColumn ? 1 : 0)
                          ],
                        textAlign: 'center',
                      }}
                    >
                      স্বাক্ষর
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {allPreparedRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={
                          10 + customCols.length + (showLicenseDoColumn ? 1 : 0)
                        }
                        className="py-8 text-center text-xs text-slate-500"
                      >
                        এই সময়ে কোনো লাইসেন্স বা অন্যান্য চালান পাওয়া যায়নি।
                      </td>
                    </tr>
                  ) : (
                    allPreparedRows.flatMap(({ row, globalIndex, subs }) =>
                      subs.map((sub, subIdx) => (
                        <tr key={`web-l-${sub.key}`}>
                          {subIdx === 0 && (
                            <td
                              rowSpan={subs.length}
                              className="text-center font-bold tabular-nums"
                            >
                              {toBengaliDigits(globalIndex + 1)}
                            </td>
                          )}
                          {subIdx === 0 && (
                            <td rowSpan={subs.length}>
                              <div className="font-bold text-slate-900">
                                {row.dealerName || '—'}
                              </div>
                              {row.unionName && (
                                <div className="text-[11px] text-slate-600">
                                  {row.unionName}
                                </div>
                              )}
                              {row.licenseNo && (
                                <div className="text-[11px] text-slate-600">
                                  লাইঃ {toBengaliDigits(row.licenseNo)}
                                </div>
                              )}
                            </td>
                          )}
                          <td className="text-center text-[11px] tabular-nums">
                            {toBengaliDigits(sub.new37Code || '—')}
                          </td>
                          <td className="text-center">{sub.khatLabel}</td>
                          <td className="text-center tabular-nums">
                            <div className="font-semibold">
                              {toBengaliDigits(sub.challanNo)}
                            </div>
                            {sub.challanDate && (
                              <div className="text-[11px] text-slate-600">
                                {toBengaliDigits(sub.challanDate)}
                              </div>
                            )}
                          </td>
                          <td className="text-right tabular-nums">
                            {fmtBnAmount(sub.expectedNum)}
                          </td>
                          <td className="text-right font-bold tabular-nums text-slate-900">
                            {fmtBnAmount(sub.depositedNum)}
                          </td>
                          <td className="text-right tabular-nums">
                            {sub.gormilText}
                          </td>
                          <td className="text-[11px] text-slate-700">
                            {sub.comment}
                          </td>
                          {customCols.map((col) => (
                            <td
                              key={`web-l-${sub.key}-${col.id}`}
                              className="text-center"
                            >
                              {subIdx === 0
                                ? toBengaliDigits(row.customFields?.[col.id] || '')
                                : ''}
                            </td>
                          ))}
                          {showLicenseDoColumn && subIdx === 0 && (
                            <td rowSpan={subs.length} className="text-center tabular-nums">
                              {row.doNo ? (
                                <div>
                                  <div className="font-bold">
                                    {toBengaliDigits(row.doNo)}
                                  </div>
                                  {row.doIssueDate && (
                                    <div className="text-[11px] text-slate-600">
                                      {toBengaliDigits(row.doIssueDate)}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                ''
                              )}
                            </td>
                          )}
                          <td className="text-center text-[10.5px]">
                            {renderSignatureCell(sub)}
                          </td>
                        </tr>
                      ))
                    )
                  )}
                  {report.rows.length > 0 && (
                    <tr className="bg-slate-100 font-bold">
                      <th colSpan={5} className="text-right">
                        মোট ({toBengaliDigits(report.rows.length)}টি)
                      </th>
                      <th className="text-right tabular-nums">
                        {fmtBnAmount(registerTotals.expectedTotal)}
                      </th>
                      <th className="text-right tabular-nums">
                        {fmtBnAmount(registerTotals.depositedTotal)}
                      </th>
                      <th className="text-right tabular-nums">
                        {fmtBnAmount(registerTotals.gormilTotal)}
                      </th>
                      <th />
                      {customCols.map((col) => (
                        <th key={`web-lfoot-${col.id}`} />
                      ))}
                      {showLicenseDoColumn && <th />}
                      <th />
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4 border-t border-slate-200 bg-slate-50/50 px-4 py-3 text-xs text-slate-600">
            <div>
              মোট {toBengaliDigits(report.rows.length)}টি চালান · আপডেট:{' '}
              {toBengaliDigits(getTodayFormatted())}
            </div>
            <div className="text-center min-w-[150px]">
              {signatureImage && (
                <img
                  src={signatureImage}
                  alt="স্বাক্ষর"
                  className="mx-auto mb-1 h-8 max-w-[130px] object-contain"
                />
              )}
              <div
                className={`pt-0.5 text-xs font-bold text-slate-900 ${
                  signatureImage
                    ? 'border-t border-slate-500'
                    : 'border-t border-dashed border-slate-400'
                }`}
              >
                {officerName || signatureText}
              </div>
              {officerName && (
                <div className="text-[11px] text-slate-600">{signatureText}</div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Off-Screen DOM Measurement + 1:1 Paginated A4 Sheets for Clean PDF Download & Print */}
      {report && appliedMeta && (
        <div className="a4-pdf-staging">
          {/* Hidden Off-Screen Measurement A4 Sheet (Excluded from Print & PDF Export) */}
          <div className="no-print" aria-hidden="true">
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
                                colSpan={12 + customCols.length}
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
                                  10 +
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
        </div>
      )}

      {/* Floating Action Bar: Portrait | Landscape | Excel CSV | PDF | Print */}
      {report && (
        <div
          className="no-print fixed bottom-20 right-4 z-40 flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-xl backdrop-blur md:bottom-6"
          role="toolbar"
          aria-label="রেজিস্টার প্রিন্ট ও পেজ নিয়ন্ত্রণ"
        >
          <button
            type="button"
            onClick={() => setOrientation('portrait')}
            title="পোর্ট্রেট মোড (A4)"
            aria-label="পোর্ট্রেট মোড"
            className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors cursor-pointer ${
              orientation === 'portrait'
                ? 'bg-rose-700 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <RectangleVertical className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={() => setOrientation('landscape')}
            title="ল্যান্ডস্কেপ মোড (A4)"
            aria-label="ল্যান্ডস্কেপ মোড"
            className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors cursor-pointer ${
              orientation === 'landscape'
                ? 'bg-rose-700 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <RectangleHorizontal className="h-5 w-5" />
          </button>

          <div className="h-6 w-px bg-slate-200" aria-hidden="true" />

          <button
            type="button"
            onClick={downloadExcelCsv}
            title="Excel / CSV ডাউনলোড"
            aria-label="Excel ডাউনলোড"
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
          >
            <FileSpreadsheet className="h-5 w-5" />
          </button>

          <button
            type="button"
            disabled={pdfLoading}
            onClick={() => void downloadPdf()}
            title="PDF ডাউনলোড (Nikosh)"
            aria-label="PDF ডাউনলোড"
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 cursor-pointer"
          >
            {pdfLoading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <FileDown className="h-5 w-5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            title="প্রিন্ট (A4)"
            aria-label="প্রিন্ট"
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white hover:bg-slate-800 cursor-pointer"
          >
            <Printer className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
