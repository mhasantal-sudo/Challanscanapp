import { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { Html5Qrcode } from 'html5-qrcode';
import {
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudUpload,
  ExternalLink,
  FileBadge2,
  Hash,
  ImagePlus,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Receipt,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import type {
  AppSettings,
  ChallanRecord,
  DealerRecord,
  KhatConfig,
  LicenseeRecord,
  OfficialChallanData,
  SuballocationRecord,
} from '../types.ts';
import {
  buildDefaultCommissionTaxComment,
  cleanChallanNo,
  countChallanBreakdown,
  extractChallanInfo,
  findChallanConflictInRecords,
  formatMoney,
  getChallanDepositSortKey,
  getOfficialVerificationUrl,
  isSameYearMonth,
  maskDateInput,
  normalizeChallanDate,
  normalizeChallanNo,
  parseInputDate,
  parseOfficialRemarks,
  scoreBengaliNameSimilarity,
  splitTaxDepartmentAndExtra,
  stripEconomicCodeText,
  toBengaliDigits,
  toEnglishDigits,
  toNumericValue,
} from '../utils/challan.ts';
import { apiFetch } from '../utils/api.ts';
import {
  markRecordsSheetSyncedInVault,
  recordSavedInVault,
} from '../utils/localVault.ts';
import { upsertChallanToFirestore } from '../services/firestoreSync.ts';
import { getGoogleAccessToken, googleSignIn } from '../services/googleAuth.ts';
import {
  getSheetPushCapability,
  pushToAppsScriptBridge,
  type SheetChallanEntry,
  writeChallanToGoogleSheetOAuth,
} from '../services/googleSheets.ts';
import { CategoryHub, renderKhatIcon } from './CategoryHub.tsx';
import { QrScannerModal } from './QrScannerModal.tsx';

type ScanRole = 'main' | 'tax' | 'vat';

interface EconomicOption {
  code: string;
  name: string;
  amount: string;
}

interface ScanFormState {
  department: string;
  submittedThrough: string;
  submittedOnBehalfOf: string;
  challanNo: string;
  challanDate: string;
  description: string;
  quantity: string;
  rate: string;
  expectedAmount: string;
  expectedTaxAmount: string;
  amount: string;
  licenseNo: string;
  new37Code: string;
  sourceMemo: string;
  dcMemo: string;
  pdfUrl: string;
}

const EMPTY_FORM: ScanFormState = {
  department: '',
  submittedThrough: '',
  submittedOnBehalfOf: '',
  challanNo: '',
  challanDate: '',
  description: '',
  quantity: '',
  rate: '',
  expectedAmount: '',
  expectedTaxAmount: '',
  amount: '',
  licenseNo: '',
  new37Code: '',
  sourceMemo: '',
  dcMemo: '',
  pdfUrl: '',
};

function parseFlexibleDateMs(raw?: string): number | null {
  const trimmed = toEnglishDigits(raw || '').trim();
  if (!trimmed) return null;

  const dmy = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const yearRaw = Number(dmy[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const ms = new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  const ymd = trimmed.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (ymd) {
    const ms = new Date(
      Number(ymd[1]),
      Number(ymd[2]) - 1,
      Number(ymd[3]),
      12,
      0,
      0,
      0
    ).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function getTimeProximityPenalty(
  createdAt: string | undefined,
  refMs: number
): number {
  const ts = parseFlexibleDateMs(createdAt);
  if (ts === null) return Number.MAX_SAFE_INTEGER;
  if (ts <= refMs) return refMs - ts;
  // Slightly penalize entries timestamped after refMs so immediate past/current entries come first
  return ts - refMs + 30 * 24 * 60 * 60 * 1000;
}

function formatCompactShortDate(raw?: string): string {
  const ms = parseFlexibleDateMs(raw);
  if (ms === null) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

function getSuballocationMemoKey(s: SuballocationRecord): string {
  const uno = String(s.unoMemo || '').trim();
  const src = String(s.sourceMemo || '').trim();
  const dt = String(s.allocationDate || '').trim();
  if (!uno && !src && !dt) return '';
  return `${uno}||${src}||${dt}`;
}

interface ScanEntryViewProps {
  settings: AppSettings;
  dealers: DealerRecord[];
  unions: string[];
  licensees: LicenseeRecord[];
  suballocations: SuballocationRecord[];
  records: ChallanRecord[];
  pendingSheetCount?: number;
  onFlushPendingSheet?: () => Promise<void>;
  cloudUser?: User | null;
  cloudSyncing?: boolean;
  onConnectCloudBackup?: () => Promise<void>;
  canOpenSettings?: boolean;
  onSaved: () => void;
  onOpenSettings: () => void;
  onOpenSheetSettings?: () => void;
  onOpenAllRecords: () => void;
  onFocusModeChange?: (focused: boolean) => void;
  onSyncFromSheetNow?: () => Promise<ChallanRecord[]>;
  externalScanRequestNonce: number;
}

export function ScanEntryView({
  settings,
  dealers,
  unions,
  licensees,
  suballocations,
  records,
  pendingSheetCount = 0,
  onFlushPendingSheet,
  cloudUser = null,
  cloudSyncing = false,
  onConnectCloudBackup,
  canOpenSettings = true,
  onSaved,
  onOpenSettings,
  onOpenSheetSettings,
  onOpenAllRecords,
  onFocusModeChange,
  onSyncFromSheetNow,
  externalScanRequestNonce,
}: ScanEntryViewProps) {
  const [selectedKhat, setSelectedKhat] = useState<KhatConfig | null>(null);
  const [licenseActionType, setLicenseActionType] = useState<
    'নতুন' | 'নবায়ন' | 'জরিমানা' | 'অন্যান্য' | ''
  >('');
  const [scanRole, setScanRole] = useState<ScanRole>('main');
  const [form, setForm] = useState<ScanFormState>(EMPTY_FORM);
  const [economicOptions, setEconomicOptions] = useState<EconomicOption[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<
    Record<string, string>
  >({});

  // Selected Dealer / Licensee / Manual entry
  const [selectedUnion, setSelectedUnion] = useState('');
  const [selectedDealerId, setSelectedDealerId] = useState('');
  const [selectedDealerName, setSelectedDealerName] = useState('');
  const [selectedAllocId, setSelectedAllocId] = useState('');
  const [selectedUcfMemoKey, setSelectedUcfMemoKey] = useState('');
  const [manualEntryOpen, setManualEntryOpen] = useState(false);

  // Camera & File scan states
  const [cameraOpen, setCameraOpen] = useState(false);
  const [fetchingOfficial, setFetchingOfficial] = useState(false);
  const [scanStatus, setScanStatus] = useState<{
    tone: 'neutral' | 'success' | 'error';
    text: string;
  } | null>(null);

  // Pre-Save Google Sheet confirmation dialog
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pushToSheet, setPushToSheet] = useState<boolean>(
    () => getSheetPushCapability(settings).anyReady
  );
  const pushToggledManuallyRef = useRef(false);
  const [googleAuthNonce, setGoogleAuthNonce] = useState(0);
  const [googleConnecting, setGoogleConnecting] = useState(false);
  const [sessionSavedCount, setSessionSavedCount] = useState(0);
  const [pendingSheetEntry, setPendingSheetEntry] =
    useState<SheetChallanEntry | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{
    tone: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

  const sheetCapability = useMemo(
    () => getSheetPushCapability(settings),
    [settings, googleAuthNonce]
  );

  useEffect(() => {
    if (!pushToggledManuallyRef.current) {
      setPushToSheet(sheetCapability.anyReady);
    }
  }, [sheetCapability.anyReady]);

  // Bottom Dashboard Feed State (Sorted by latest deposit date, configurable page size)
  const [dashCategoryFilter, setDashCategoryFilter] = useState('সকল');
  const [dashSearch, setDashSearch] = useState('');
  const [dashPage, setDashPage] = useState(0);
  const dashTouchStartX = useRef<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const suggestionStripRef = useRef<HTMLDivElement | null>(null);
  const saveFeedbackRef = useRef<HTMLDivElement | null>(null);
  const officialCacheRef = useRef<Map<string, OfficialChallanData>>(new Map());
  const officialFetchInFlightRef = useRef<string | null>(null);
  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(0);

  useEffect(() => {
    if (saveFeedback) {
      saveFeedbackRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [saveFeedback]);

  // Notify parent App when focused full-screen mode changes
  useEffect(() => {
    onFocusModeChange?.(Boolean(selectedKhat));
  }, [selectedKhat, onFocusModeChange]);

  // Respond to header quick-scan CTA
  useEffect(() => {
    if (externalScanRequestNonce > 0) {
      if (!selectedKhat && settings.khats.length > 0) {
        const firstActive =
          settings.khats.find((k) => k.active) || settings.khats[0];
        setSelectedKhat(firstActive);
      }
      setScanRole('main');
      setCameraOpen(true);
    }
  }, [externalScanRequestNonce, selectedKhat, settings.khats]);

  // Helper: get reference expected fee from Settings for active License category + role
  function computeReferenceFee(
    khat: KhatConfig | null,
    action: typeof licenseActionType,
    role: ScanRole
  ): string {
    if (!khat || khat.group !== 'license') return '';
    const feeCfg = settings.licenseFees?.find((f) => f.khatName === khat.name);
    if (!feeCfg) return '';
    if (role === 'tax') return feeCfg.taxAmount ? String(feeCfg.taxAmount) : '';
    if (role === 'vat') return feeCfg.vatAmount ? String(feeCfg.vatAmount) : '';
    if (action === 'নবায়ন') {
      return feeCfg.renewalFee ? String(feeCfg.renewalFee) : '';
    }
    return feeCfg.newFee ? String(feeCfg.newFee) : '';
  }

  // Update reference fee when role/action/khat changes
  useEffect(() => {
    if (!selectedKhat || selectedKhat.group !== 'license') return;
    const feeCfg = settings.licenseFees?.find((f) => f.khatName === selectedKhat.name);
    const refFee = computeReferenceFee(selectedKhat, licenseActionType, scanRole);
    setForm((prev) => ({
      ...prev,
      ...(refFee ? { expectedAmount: refFee } : {}),
      ...(feeCfg?.taxAmount ? { expectedTaxAmount: String(feeCfg.taxAmount) } : {}),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKhat, licenseActionType, scanRole, settings.licenseFees]);

  // Suballocations already saved against a challan for the active role NEVER reappear
  const linkedAllocationIds = useMemo(() => {
    const norm = (v?: string) => (v || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const set = new Set<string>();

    for (const sub of suballocations) {
      const subName = norm(sub.dealerName);
      const subUnion = norm(sub.unionName);

      const alreadySaved = records.some((r) => {
        const hasMainSaved =
          Boolean(r.challanNo?.trim()) || toNumericValue(r.amount) > 0;
        const hasTaxSaved =
          Boolean(r.incomeTaxChallanNo?.trim()) ||
          toNumericValue(r.incomeTaxAmount) > 0;
        const hasVatSaved =
          Boolean(r.vatChallanNo?.trim()) || toNumericValue(r.vatAmount) > 0;

        const roleDone =
          scanRole === 'tax'
            ? hasTaxSaved
            : scanRole === 'vat'
            ? hasVatSaved
            : hasMainSaved;

        if (!roleDone) return false;

        if (r.dealerAllocationId && r.dealerAllocationId === sub.id) {
          return true;
        }

        // Fallback match for records synced without dealerAllocationId
        if (!r.dealerAllocationId && subName && norm(r.dealerName) === subName) {
          if (subUnion && norm(r.unionName) && norm(r.unionName) !== subUnion) {
            return false;
          }
          if (scanRole === 'tax' && sub.taxAmount > 0) {
            return Math.abs(toNumericValue(r.incomeTaxAmount) - sub.taxAmount) < 1;
          }
          if (scanRole === 'main' && sub.totalAmount > 0) {
            return Math.abs(toNumericValue(r.amount) - sub.totalAmount) < 1;
          }
        }
        return false;
      });

      if (alreadySaved) {
        set.add(sub.id);
      }
    }
    return set;
  }, [records, suballocations, scanRole]);

  const unlinkedSuballocations = useMemo(
    () => suballocations.filter((s) => !linkedAllocationIds.has(s.id)),
    [suballocations, linkedAllocationIds]
  );

  const categorySuballocations = useMemo(() => {
    if (!selectedKhat || selectedKhat.group !== 'grain') return suballocations;
    const target = selectedKhat.name.trim();
    return suballocations.filter(
      (s) => !s.category || s.category.trim() === target
    );
  }, [suballocations, selectedKhat]);

  const ucfMemoOptions = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        unoMemo: string;
        sourceMemo: string;
        allocationDate: string;
        totalCount: number;
        remainingCount: number;
        sortDate: string;
      }
    >();
    for (const s of categorySuballocations) {
      const key = getSuballocationMemoKey(s);
      if (!key) continue;
      const existing = map.get(key);
      const isRemaining = !linkedAllocationIds.has(s.id);
      if (!existing) {
        map.set(key, {
          key,
          unoMemo: String(s.unoMemo || '').trim(),
          sourceMemo: String(s.sourceMemo || '').trim(),
          allocationDate: String(s.allocationDate || '').trim(),
          totalCount: 1,
          remainingCount: isRemaining ? 1 : 0,
          sortDate: String(s.allocationDate || s.createdAt || '').trim(),
        });
      } else {
        existing.totalCount += 1;
        if (isRemaining) existing.remainingCount += 1;
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      b.sortDate.localeCompare(a.sortDate)
    );
  }, [categorySuballocations, linkedAllocationIds]);

  useEffect(() => {
    if (
      selectedUcfMemoKey &&
      ucfMemoOptions.length > 0 &&
      !ucfMemoOptions.some((o) => o.key === selectedUcfMemoKey)
    ) {
      setSelectedUcfMemoKey('');
    }
  }, [selectedUcfMemoKey, ucfMemoOptions]);

  const memoFilteredUnlinkedSuballocations = useMemo(() => {
    const base = categorySuballocations.filter(
      (s) => !linkedAllocationIds.has(s.id)
    );
    if (!selectedUcfMemoKey) return base;
    return base.filter(
      (s) => getSuballocationMemoKey(s) === selectedUcfMemoKey
    );
  }, [categorySuballocations, linkedAllocationIds, selectedUcfMemoKey]);

  const scanRefMs = useMemo(() => {
    const challanDayMs = parseFlexibleDateMs(form.challanDate);
    if (challanDayMs !== null) {
      const d = new Date(challanDayMs);
      return new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        23,
        59,
        59,
        999
      ).getTime();
    }
    return Date.now();
  }, [form.challanDate]);

  // 1. Grain Smart Matcher: rank remaining unlinked allocations (strictly scoped to selected UCF memo if chosen)
  const matchedSuballocations = useMemo(() => {
    if (!selectedKhat || selectedKhat.group !== 'grain') return [];
    const scannedAmt = toNumericValue(form.amount);
    const nameHint = [
      form.submittedOnBehalfOf,
      form.submittedThrough,
      form.description,
    ]
      .filter(Boolean)
      .join(' ');

    const list = memoFilteredUnlinkedSuballocations.map((s) => {
      const targetAmt = scanRole === 'tax' ? s.taxAmount : s.totalAmount;
      const diff =
        scannedAmt > 0 ? Math.abs(targetAmt - scannedAmt) : 999999999;
      const exact = scannedAmt > 0 && diff < 0.5;
      const close = scannedAmt > 0 && diff <= 50;
      const nameScore = nameHint
        ? scoreBengaliNameSimilarity(nameHint, s.dealerName)
        : 0;
      const dateBasis = s.allocationDate || s.createdAt;
      const ts = parseFlexibleDateMs(dateBasis);
      const timePenalty = getTimeProximityPenalty(dateBasis, scanRefMs);
      return {
        sub: s,
        targetAmt,
        diff,
        exact,
        close,
        nameScore,
        ts,
        timePenalty,
      };
    });

    list.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.close !== b.close) return a.close ? -1 : 1;
      if (Math.abs(a.diff - b.diff) > 1) return a.diff - b.diff;
      if (nameHint && Math.abs(a.nameScore - b.nameScore) > 0.15) {
        return b.nameScore - a.nameScore;
      }
      if (a.timePenalty !== b.timePenalty) {
        return a.timePenalty - b.timePenalty;
      }
      return (b.ts ?? 0) - (a.ts ?? 0);
    });

    return list;
  }, [
    selectedKhat,
    memoFilteredUnlinkedSuballocations,
    form.amount,
    form.submittedOnBehalfOf,
    form.submittedThrough,
    form.description,
    scanRole,
    scanRefMs,
  ]);

  // 2. License Smart Matcher: rank all matching candidates so user can swipe left one-by-one
  const matchedLicenseCandidates = useMemo(() => {
    if (!selectedKhat || selectedKhat.group !== 'license') return [];
    const queryText = [
      form.submittedThrough,
      form.submittedOnBehalfOf,
      form.description,
      form.licenseNo,
      form.challanNo,
    ]
      .filter(Boolean)
      .join(' ');

    const isRetailOrWholesale =
      selectedKhat.name.includes('খুচরা') ||
      selectedKhat.name.includes('পাইকারি');

    if (isRetailOrWholesale && licensees.length > 0) {
      const scored = licensees.map((lic) => {
        const licMatch =
          lic.licenseNo &&
          queryText.includes(toEnglishDigits(lic.licenseNo).trim())
            ? 1
            : 0;
        const nidMatch =
          lic.nid && queryText.includes(toEnglishDigits(lic.nid).trim())
            ? 0.98
            : 0;
        const nameScore = queryText
          ? scoreBengaliNameSimilarity(queryText, lic.licenseeName)
          : 0;
        return {
          id: lic.id,
          name: lic.licenseeName,
          address: lic.address,
          licenseNo: lic.licenseNo,
          licenseType: lic.licenseType,
          score: Math.max(licMatch, nidMatch, nameScore),
        };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 25);
    }

    const catKeyword = selectedKhat.name.includes('ওএমএস')
      ? 'ওএমএস'
      : selectedKhat.name.includes('খাদ্য')
      ? 'খাদ্য'
      : '';
    const pool = catKeyword
      ? dealers.filter(
          (d) => !d.category || d.category.includes(catKeyword)
        )
      : dealers;
    const effectivePool = pool.length > 0 ? pool : dealers;

    const scoredDealers = effectivePool.map((d) => ({
      id: d.id,
      name: d.dealerName,
      address: d.unionName,
      licenseNo: '',
      licenseType: d.category || '',
      score: queryText
        ? scoreBengaliNameSimilarity(queryText, d.dealerName)
        : 0,
    }));
    scoredDealers.sort((a, b) => b.score - a.score);
    return scoredDealers.slice(0, 25);
  }, [
    selectedKhat,
    licensees,
    dealers,
    form.submittedThrough,
    form.submittedOnBehalfOf,
    form.description,
    form.licenseNo,
    form.challanNo,
  ]);

  useEffect(() => {
    setActiveSuggestionIdx(0);
    if (suggestionStripRef.current) {
      suggestionStripRef.current.scrollTo({ left: 0, behavior: 'auto' });
    }
  }, [
    selectedKhat?.id,
    scanRole,
    selectedUcfMemoKey,
    form.challanNo,
    form.amount,
    form.challanDate,
    memoFilteredUnlinkedSuballocations.length,
  ]);

  function scrollToSuggestion(index: number, total: number) {
    if (total <= 0) return;
    const clamped = Math.max(0, Math.min(total - 1, index));
    setActiveSuggestionIdx(clamped);
    const el = suggestionStripRef.current;
    if (el) {
      el.scrollTo({ left: clamped * el.clientWidth, behavior: 'smooth' });
    }
  }

  // Existing record check for merging main + tax + vat on the same row
  const mergeTargetRecord = useMemo(() => {
    if (!selectedKhat) return null;
    if (scanRole === 'main' && !selectedKhat.hasIncomeTax && !selectedKhat.hasVat) {
      return null;
    }

    const incomingClean = cleanChallanNo(form.challanNo);
    const slotIsEmpty = (r: ChallanRecord): boolean => {
      if (
        incomingClean &&
        (cleanChallanNo(r.challanNo) === incomingClean ||
          cleanChallanNo(r.incomeTaxChallanNo) === incomingClean ||
          cleanChallanNo(r.vatChallanNo) === incomingClean)
      ) {
        return false;
      }
      if (scanRole === 'tax') return !cleanChallanNo(r.incomeTaxChallanNo);
      if (scanRole === 'vat') return !cleanChallanNo(r.vatChallanNo);
      return !cleanChallanNo(r.challanNo);
    };

    const incomingDateNorm = form.challanDate
      ? normalizeChallanDate(form.challanDate)
      : '';
    const sameMonthOrUnset = (r: ChallanRecord): boolean => {
      if (!incomingDateNorm) return true;
      const existingDate =
        r.challanDate || r.incomeTaxDate || r.vatDate || r.date || '';
      if (!existingDate) return true;
      return isSameYearMonth(incomingDateNorm, existingDate);
    };

    if (selectedAllocId) {
      return (
        records.find(
          (r) =>
            r.dealerAllocationId === selectedAllocId &&
            sameMonthOrUnset(r) &&
            slotIsEmpty(r)
        ) || null
      );
    }
    if (form.licenseNo) {
      return (
        records.find(
          (r) =>
            r.licenseNo === form.licenseNo &&
            r.challanCategory === selectedKhat.name &&
            sameMonthOrUnset(r) &&
            slotIsEmpty(r)
        ) || null
      );
    }
    if (selectedDealerName && incomingDateNorm) {
      return (
        records.find(
          (r) =>
            r.dealerName === selectedDealerName &&
            r.challanCategory === selectedKhat.name &&
            isSameYearMonth(
              incomingDateNorm,
              r.challanDate || r.incomeTaxDate || r.vatDate || r.date || ''
            ) &&
            slotIsEmpty(r)
        ) || null
      );
    }
    return null;
  }, [
    selectedAllocId,
    form.licenseNo,
    form.challanNo,
    selectedDealerName,
    form.challanDate,
    selectedKhat,
    scanRole,
    records,
  ]);

  const cleanedFormChallanNo = cleanChallanNo(form.challanNo);

  const liveChallanConflict = useMemo(() => {
    if (!selectedKhat || !cleanedFormChallanNo) return null;
    const effectiveMode =
      scanRole === 'vat'
        ? 'vat'
        : scanRole === 'tax'
        ? 'tax'
        : selectedKhat.hasIncomeTax || selectedKhat.hasVat
        ? 'main'
        : 'single';
    return findChallanConflictInRecords(
      records,
      {
        main:
          effectiveMode === 'main' || effectiveMode === 'single'
            ? cleanedFormChallanNo
            : mergeTargetRecord?.challanNo,
        tax:
          effectiveMode === 'tax'
            ? cleanedFormChallanNo
            : mergeTargetRecord?.incomeTaxChallanNo,
        vat:
          effectiveMode === 'vat'
            ? cleanedFormChallanNo
            : mergeTargetRecord?.vatChallanNo,
      },
      mergeTargetRecord?.recordId
    );
  }, [
    selectedKhat,
    scanRole,
    cleanedFormChallanNo,
    records,
    mergeTargetRecord,
  ]);

  const filteredDealers = useMemo(() => {
    if (!selectedUnion) return dealers;
    return dealers.filter((d) => d.unionName.trim() === selectedUnion.trim());
  }, [dealers, selectedUnion]);

  const isMemoFilterActive =
    selectedKhat?.group === 'grain' && Boolean(selectedUcfMemoKey);

  const dropdownUnions = useMemo(() => {
    if (isMemoFilterActive) {
      return Array.from(
        new Set(
          memoFilteredUnlinkedSuballocations
            .map((s) => String(s.unionName || '').trim())
            .filter(Boolean)
        )
      );
    }
    return unions;
  }, [isMemoFilterActive, memoFilteredUnlinkedSuballocations, unions]);

  const dropdownMemoSuballocations = useMemo(() => {
    if (!isMemoFilterActive) return [];
    const u = selectedUnion.trim();
    return u
      ? memoFilteredUnlinkedSuballocations.filter(
          (s) => String(s.unionName || '').trim() === u
        )
      : memoFilteredUnlinkedSuballocations;
  }, [isMemoFilterActive, memoFilteredUnlinkedSuballocations, selectedUnion]);

  // Bottom Dashboard: Sort strictly by latest challan deposit date descending
  const sortedDashboardRecords = useMemo(() => {
    const q = toEnglishDigits(dashSearch).trim().toLowerCase();
    return [...records]
      .filter((r) => {
        const catOk =
          dashCategoryFilter === 'সকল' ||
          r.challanCategory === dashCategoryFilter;
        if (!catOk) return false;
        if (!q) return true;
        return [
          r.challanNo,
          r.incomeTaxChallanNo,
          r.vatChallanNo,
          r.dealerName,
          r.unionName,
          r.licenseNo,
          r.challanCategory,
          r.new37Code,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => {
        const da = getChallanDepositSortKey(a);
        const db = getChallanDepositSortKey(b);
        if (db !== da) return db.localeCompare(da);
        return b.serialNo - a.serialNo;
      });
  }, [records, dashCategoryFilter, dashSearch]);

  const pageSize = settings.dashboardPageSize || 15;
  const totalDashPages = Math.max(
    1,
    Math.ceil(sortedDashboardRecords.length / pageSize)
  );
  const safeDashPage = Math.min(dashPage, totalDashPages - 1);
  const pagedDashboardRecords = useMemo(() => {
    const start = safeDashPage * pageSize;
    return sortedDashboardRecords.slice(start, start + pageSize);
  }, [sortedDashboardRecords, safeDashPage, pageSize]);

  function startCategoryScan(
    khat: KhatConfig,
    actionType?: 'নতুন' | 'নবায়ন' | 'জরিমানা' | 'অন্যান্য'
  ) {
    setSelectedKhat(khat);
    const resolvedAction =
      actionType ||
      (khat.subGroup === 'fine'
        ? 'জরিমানা'
        : khat.subGroup === 'other'
        ? 'অন্যান্য'
        : khat.group === 'license'
        ? 'নতুন'
        : '');
    setLicenseActionType(resolvedAction);
    setScanRole('main');
    const refFee = computeReferenceFee(khat, resolvedAction, 'main');
    setForm({ ...EMPTY_FORM, expectedAmount: refFee });
    setEconomicOptions([]);
    setCustomFieldValues({});
    setSelectedAllocId('');
    setSelectedDealerId('');
    setSelectedDealerName('');
    setSelectedUnion('');
    setSelectedUcfMemoKey('');
    setManualEntryOpen(false);
    setScanStatus(null);
    setSaveFeedback(null);
  }

  function triggerScanWithRole(role: ScanRole) {
    setScanRole(role);
    setSaveFeedback(null);
    setCameraOpen(true);
  }

  async function fetchOfficialChallan(rawInput: string) {
    let normalized11 = '';
    try {
      const info = extractChallanInfo(rawInput);
      normalized11 = cleanChallanNo(info.normalized11);
      if (!normalized11) {
        throw new Error('বৈধ ১১-অঙ্কের চালান নম্বর শনাক্ত করা যায়নি।');
      }
      setForm((prev) => ({ ...prev, challanNo: normalized11 }));
    } catch (err) {
      setScanStatus({
        tone: 'error',
        text: err instanceof Error ? err.message : 'চালান নম্বর শনাক্ত হয়নি।',
      });
      return;
    }

    if (officialFetchInFlightRef.current === normalized11) {
      return;
    }

    const checkNoConflictInList = (
      candidateNo: string,
      recordList: ChallanRecord[]
    ) => {
      if (!selectedKhat) return null;
      const effectiveMode =
        scanRole === 'vat'
          ? 'vat'
          : scanRole === 'tax'
          ? 'tax'
          : selectedKhat.hasIncomeTax || selectedKhat.hasVat
          ? 'main'
          : 'single';
      return findChallanConflictInRecords(
        recordList,
        {
          main:
            effectiveMode === 'main' || effectiveMode === 'single'
              ? candidateNo
              : mergeTargetRecord?.challanNo,
          tax:
            effectiveMode === 'tax'
              ? candidateNo
              : mergeTargetRecord?.incomeTaxChallanNo,
          vat:
            effectiveMode === 'vat'
              ? candidateNo
              : mergeTargetRecord?.vatChallanNo,
        },
        mergeTargetRecord?.recordId
      );
    };

    let activeRecords = records;
    let preConflict = checkNoConflictInList(normalized11, activeRecords);
    if (preConflict && onSyncFromSheetNow && settings.spreadsheetId.trim()) {
      setScanStatus({
        tone: 'neutral',
        text: 'Google Sheet থেকে সর্বশেষ তথ্য যাচাই করা হচ্ছে...',
      });
      activeRecords = await onSyncFromSheetNow();
      preConflict = checkNoConflictInList(normalized11, activeRecords);
    }
    if (preConflict) {
      setScanStatus({
        tone: 'error',
        text: preConflict.message,
      });
      setSaveFeedback({
        tone: 'error',
        text: preConflict.message,
      });
      return;
    }

    const applyOfficialData = (officialData: OfficialChallanData) => {
      const parsed = parseOfficialRemarks(officialData);
      const expectedRef = computeReferenceFee(
        selectedKhat,
        licenseActionType,
        scanRole
      );
      const finalNo =
        cleanChallanNo(parsed.challanNo || normalized11) || normalized11;

      officialCacheRef.current.set(normalized11, officialData);
      officialCacheRef.current.set(finalNo, officialData);

      setEconomicOptions(parsed.economicOptions || []);
      const defaultTaxDesc =
        scanRole === 'tax' && selectedKhat
          ? buildDefaultCommissionTaxComment(
              selectedKhat.name,
              parsed.challanDate || form.challanDate,
              finalNo
            )
          : '';
      setForm((prev) => ({
        ...prev,
        department: parsed.department,
        submittedThrough: parsed.submittedThrough,
        submittedOnBehalfOf: parsed.submittedOnBehalfOf,
        challanNo: finalNo,
        new37Code: parsed.new37Code || prev.new37Code,
        challanDate: parsed.challanDate,
        description: parsed.description || defaultTaxDesc,
        quantity: parsed.quantity || prev.quantity,
        rate: parsed.rate || prev.rate,
        expectedAmount: expectedRef || prev.expectedAmount,
        amount: parsed.amount,
      }));

      const postConflict = checkNoConflictInList(finalNo, activeRecords);
      if (postConflict) {
        setScanStatus({
          tone: 'error',
          text: postConflict.message,
        });
        setSaveFeedback({
          tone: 'error',
          text: postConflict.message,
        });
      } else {
        setScanStatus({
          tone: 'success',
          text: `${finalNo} · ৳ ${formatMoney(parsed.amount)}${
            parsed.new37Code ? ` · কোড ${toBengaliDigits(parsed.new37Code)}` : ''
          }`,
        });
      }
    };

    const cachedOfficial = officialCacheRef.current.get(normalized11);
    if (cachedOfficial) {
      setSaveFeedback(null);
      applyOfficialData(cachedOfficial);
      return;
    }

    officialFetchInFlightRef.current = normalized11;
    setFetchingOfficial(true);
    setSaveFeedback(null);
    setScanStatus({
      tone: 'neutral',
      text: `${normalized11} — সরকারি পেজ থেকে তথ্য আনা হচ্ছে...`,
    });

    try {
      const gasParam = settings.gasWebAppUrl?.trim()
        ? `&gasUrl=${encodeURIComponent(settings.gasWebAppUrl.trim())}`
        : '';
      let resolvedData: OfficialChallanData | null = null;
      let lastErrorMessage = 'সরকারি পেজ থেকে তথ্য আনা যায়নি।';
      const maxClientAttempts = 3;

      for (let attempt = 0; attempt < maxClientAttempts; attempt++) {
        const res = await apiFetch(
          `/api/official-challan?challanNo=${encodeURIComponent(
            normalized11
          )}${gasParam}`
        );
        const json = (await res.json()) as {
          success: boolean;
          data?: OfficialChallanData;
          statusCode?: number;
          retryable?: boolean;
          cooldownMs?: number;
          message?: string;
        };

        if (res.ok && json.success && json.data) {
          resolvedData = json.data;
          break;
        }

        lastErrorMessage = json.message || lastErrorMessage;
        const isRetryable409 =
          res.status === 409 ||
          json.statusCode === 409 ||
          Boolean(json.retryable) ||
          lastErrorMessage.includes('409');

        if (isRetryable409 && attempt < maxClientAttempts - 1) {
          const waitMs = Math.min(
            7000,
            Math.max(3500, Number(json.cooldownMs || 0) || (attempt === 0 ? 4000 : 6000))
          );
          const waitSec = Math.ceil(waitMs / 1000);
          setScanStatus({
            tone: 'neutral',
            text: `সরকারি পেজ সাময়িক ব্যস্ত (HTTP 409) — ${toBengaliDigits(
              String(waitSec)
            )} সেকেন্ড পর স্বয়ংক্রিয়ভাবে আবার চেষ্টা (${toBengaliDigits(
              String(attempt + 1)
            )}/২)...`,
          });
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        throw new Error(
          isRetryable409
            ? `${lastErrorMessage} — কিছুক্ষণ অপেক্ষা করে আবার "তথ্য আনুন" চাপুন${
                settings.gasWebAppUrl?.trim()
                  ? ' (অথবা সেটিংস থেকে নতুন Code.gs আপডেট ও ডিপ্লয় করলে 409 বাইপাস হবে)'
                  : ''
              }।`
            : lastErrorMessage
        );
      }

      if (!resolvedData) {
        throw new Error(lastErrorMessage);
      }

      applyOfficialData(resolvedData);
    } catch (err) {
      setScanStatus({
        tone: 'error',
        text: err instanceof Error ? err.message : 'সরকারি তথ্য আনা যায়নি।',
      });
    } finally {
      officialFetchInFlightRef.current = null;
      setFetchingOfficial(false);
    }
  }

  async function handleLiveQrDetected(decodedText: string) {
    setCameraOpen(false);
    await fetchOfficialChallan(decodedText);
  }

  async function handleFileQrUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setScanStatus({ tone: 'neutral', text: 'QR পড়া হচ্ছে...' });
    const scanner = new Html5Qrcode('qr-photo-decode-hidden');
    try {
      const decoded = await scanner.scanFile(file, false);
      await fetchOfficialChallan(decoded);
    } catch {
      setScanStatus({
        tone: 'error',
        text: 'ছবিতে QR পড়া যায়নি।',
      });
    } finally {
      try {
        scanner.clear();
      } catch {
        // ignore
      }
    }
  }

  function selectMatchedSuballocation(sub: SuballocationRecord) {
    setSelectedAllocId(sub.id);
    setSelectedDealerId(sub.dealerId || '');
    setSelectedDealerName(sub.dealerName || '');
    if (sub.unionName) setSelectedUnion(sub.unionName);
    setForm((prev) => ({
      ...prev,
      quantity: prev.quantity || (sub.allocationQty ? String(sub.allocationQty) : ''),
      expectedAmount:
        scanRole === 'tax'
          ? prev.expectedAmount
          : String(sub.totalAmount || prev.expectedAmount || ''),
      expectedTaxAmount: String(sub.taxAmount || prev.expectedTaxAmount || ''),
    }));
  }

  function selectMatchedLicenseCandidate(item: {
    id: string;
    name: string;
    address: string;
    licenseNo: string;
  }) {
    setSelectedAllocId('');
    setSelectedDealerId(item.id);
    setSelectedDealerName(item.name);
    if (item.address) setSelectedUnion(item.address);
    if (item.licenseNo) {
      setForm((prev) => ({ ...prev, licenseNo: item.licenseNo }));
    }
  }

  function handleSelectEconomicCode(opt: EconomicOption) {
    setForm((prev) => ({
      ...prev,
      new37Code: opt.code,
      amount: opt.amount && toNumericValue(opt.amount) > 0 && economicOptions.length > 1
        ? opt.amount
        : prev.amount,
    }));
  }

  async function handlePreSaveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedKhat) return;

    const no = cleanChallanNo(form.challanNo);
    if (!no) {
      setSaveFeedback({
        tone: 'error',
        text: 'সঠিক ১১-অঙ্কের চালান নম্বর দিন ("11" বা অসম্পূর্ণ নম্বর গ্রহণযোগ্য নয়)।',
      });
      return;
    }

    const effectiveMode =
      scanRole === 'vat'
        ? 'vat'
        : scanRole === 'tax'
        ? 'tax'
        : selectedKhat.hasIncomeTax || selectedKhat.hasVat
        ? 'main'
        : 'single';
    const checkModeConflict = (list: ChallanRecord[]) =>
      findChallanConflictInRecords(
        list,
        {
          main:
            effectiveMode === 'main' || effectiveMode === 'single'
              ? no
              : mergeTargetRecord?.challanNo,
          tax:
            effectiveMode === 'tax'
              ? no
              : mergeTargetRecord?.incomeTaxChallanNo,
          vat:
            effectiveMode === 'vat'
              ? no
              : mergeTargetRecord?.vatChallanNo,
        },
        mergeTargetRecord?.recordId
      );

    let conflict = liveChallanConflict || checkModeConflict(records);
    if (conflict && onSyncFromSheetNow && settings.spreadsheetId.trim()) {
      const freshRecords = await onSyncFromSheetNow();
      conflict = checkModeConflict(freshRecords);
    }
    if (conflict) {
      setSaveFeedback({
        tone: 'error',
        text: conflict.message,
      });
      return;
    }

    const rawDate = form.challanDate.trim();
    if (rawDate) {
      const normalizedDate = normalizeChallanDate(rawDate);
      if (!parseInputDate(normalizedDate)) {
        setSaveFeedback({
          tone: 'error',
          text: 'জমার তারিখ সঠিকভাবে লিখুন (বছর-মাস-তারিখ, যেমন ২০২৬-১১-১৬)।',
        });
        return;
      }
      if (normalizedDate !== form.challanDate) {
        setForm((prev) => ({ ...prev, challanDate: normalizedDate }));
      }
    }

    setSaveFeedback(null);
    setConfirmOpen(true);
  }

  async function executeSaveAndSync() {
    if (!selectedKhat || saving) return;
    const normalized11 = cleanChallanNo(form.challanNo);
    if (!normalized11) {
      setConfirmOpen(false);
      setSaveFeedback({
        tone: 'error',
        text: 'সঠিক চালান নম্বর দিন।',
      });
      return;
    }

    const effectiveMode =
      scanRole === 'vat'
        ? 'vat'
        : scanRole === 'tax'
        ? 'tax'
        : selectedKhat.hasIncomeTax || selectedKhat.hasVat
        ? 'main'
        : 'single';

    const checkSaveConflict = (list: ChallanRecord[]) =>
      findChallanConflictInRecords(
        list,
        {
          main:
            effectiveMode === 'main' || effectiveMode === 'single'
              ? normalized11
              : mergeTargetRecord?.challanNo,
          tax:
            effectiveMode === 'tax'
              ? normalized11
              : mergeTargetRecord?.incomeTaxChallanNo,
          vat:
            effectiveMode === 'vat'
              ? normalized11
              : mergeTargetRecord?.vatChallanNo,
        },
        mergeTargetRecord?.recordId
      );

    let conflict = checkSaveConflict(records);
    if (conflict && onSyncFromSheetNow && settings.spreadsheetId.trim()) {
      const freshRecords = await onSyncFromSheetNow();
      conflict = checkSaveConflict(freshRecords);
    }
    if (conflict) {
      setConfirmOpen(false);
      setSaveFeedback({
        tone: 'error',
        text: conflict.message,
      });
      return;
    }

    setSaving(true);
    setConfirmOpen(false);

    const chlId =
      mergeTargetRecord?.id ||
      `CHL-${Date.now()}-${Math.floor(10000 + Math.random() * 89999)}`;
    const nowIso = new Date().toISOString();

    const effectiveExpected =
      form.expectedAmount ||
      computeReferenceFee(selectedKhat, licenseActionType, scanRole);

    const isTaxOrVatMode = effectiveMode === 'tax' || effectiveMode === 'vat';
    const allCodes = [
      form.new37Code,
      ...economicOptions.map((o) => o.code),
    ].filter(Boolean);
    const normalizedFormDate =
      normalizeChallanDate(form.challanDate) || form.challanDate.trim();
    const deptTrim = stripEconomicCodeText(form.department.trim(), allCodes);
    const descTrim = stripEconomicCodeText(form.description.trim(), allCodes);
    const taxSplit = isTaxOrVatMode
      ? splitTaxDepartmentAndExtra(deptTrim, form.new37Code)
      : { institution: '', extra: '' };
    const taxDepartmentText = isTaxOrVatMode ? taxSplit.institution : '';
    const taxExtraText = isTaxOrVatMode ? taxSplit.extra : '';
    const providerName =
      form.submittedThrough.trim() || form.submittedOnBehalfOf.trim();
    const defaultTaxRuleComment =
      effectiveMode === 'tax'
        ? buildDefaultCommissionTaxComment(
            selectedKhat.name,
            normalizedFormDate,
            normalized11
          )
        : '';
    const cleanCommentText = descTrim
      ? descTrim
      : defaultTaxRuleComment ||
        stripEconomicCodeText(
          [
            licenseActionType ? `${licenseActionType}` : '',
            providerName ? `প্রদানকারী: ${providerName}` : '',
          ]
            .filter(Boolean)
            .join(' | '),
          allCodes
        );

    try {
      // 1. Save / Merge locally
      const res = await apiFetch('/api/challans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanMode: effectiveMode,
          mergeExisting: effectiveMode !== 'single',
          unionName: selectedUnion,
          dealerName: selectedDealerName,
          dealerId: selectedDealerId,
          dealerAllocationId: selectedAllocId,
          challanCategory: selectedKhat.name,
          licenseActionType,
          licenseNo: form.licenseNo,
          new37Code: form.new37Code.trim(),
          taxCode: effectiveMode === 'tax' ? form.new37Code.trim() : '',
          vatCode: effectiveMode === 'vat' ? form.new37Code.trim() : '',
          expectedAmount: effectiveExpected,
          expectedTaxAmount: form.expectedTaxAmount,
          department: isTaxOrVatMode ? '' : deptTrim,
          toOrganization: isTaxOrVatMode ? '' : deptTrim,
          taxDepartment: taxDepartmentText,
          submittedThrough: form.submittedThrough,
          submittedOnBehalfOf: form.submittedOnBehalfOf,
          challanNo: effectiveMode === 'main' || effectiveMode === 'single' ? normalized11 : '',
          incomeTaxChallanNo: effectiveMode === 'tax' ? normalized11 : '',
          vatChallanNo: effectiveMode === 'vat' ? normalized11 : '',
          challanDate: effectiveMode === 'main' || effectiveMode === 'single' ? normalizedFormDate : '',
          incomeTaxDate: effectiveMode === 'tax' ? normalizedFormDate : '',
          vatDate: effectiveMode === 'vat' ? normalizedFormDate : '',
          rate: form.rate || effectiveExpected,
          quantity: form.quantity,
          amount: effectiveMode === 'main' || effectiveMode === 'single' ? form.amount : '',
          incomeTaxAmount: effectiveMode === 'tax' ? form.amount : '',
          vatAmount: effectiveMode === 'vat' ? form.amount : '',
          description: '',
          comment: isTaxOrVatMode ? '' : cleanCommentText,
          taxComment: isTaxOrVatMode ? cleanCommentText : '',
          taxExtra: taxExtraText,
          sourceMemo: taxDepartmentText || form.sourceMemo,
          dcMemo: form.dcMemo,
          customFields: isTaxOrVatMode ? undefined : customFieldValues,
          taxCustomFields: effectiveMode === 'tax' ? customFieldValues : undefined,
          vatCustomFields: effectiveMode === 'vat' ? customFieldValues : undefined,
          pdfUrl: form.pdfUrl,
        }),
      });

      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        record?: ChallanRecord;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'সংরক্ষণ ব্যর্থ হয়েছে।');
      }

      // 1B. Always store immediately in Browser Safety Vault & Firebase Cloud (if signed in)
      let cloudSynced = false;
      let cloudWarning = '';
      if (json.record) {
        recordSavedInVault(json.record, false, false);
        if (cloudUser?.uid && cloudUser.emailVerified) {
          try {
            await upsertChallanToFirestore(cloudUser.uid, json.record, settings);
            cloudSynced = true;
            recordSavedInVault(json.record, false, true);
          } catch {
            cloudWarning = 'ক্লাউড সিঙ্ক অপেক্ষমাণ';
          }
        }
      }
      setSessionSavedCount((c) => c + 1);

      // 2. Sync to Google Sheets (OAuth + Apps Script Bridge)
      const sheetSuccessNotes: string[] = [];
      const sheetErrorNotes: string[] = [];
      let oauthOk = false;
      let gasOk = false;

      const resolvedAllocId =
        selectedAllocId ||
        json.record?.dealerAllocationId ||
        mergeTargetRecord?.dealerAllocationId ||
        '';
      const resolvedLicenseNo =
        form.licenseNo ||
        json.record?.licenseNo ||
        mergeTargetRecord?.licenseNo ||
        '';
      const mergedRef = json.record || mergeTargetRecord;

      const sheetEntry: SheetChallanEntry = {
        scanType: effectiveMode as 'main' | 'tax' | 'vat' | 'single',
        id: json.record?.id || chlId,
        date: normalizedFormDate,
        department: isTaxOrVatMode ? '' : deptTrim,
        taxDepartment: taxDepartmentText,
        category: selectedKhat.name,
        sourceMemo: taxDepartmentText || form.sourceMemo,
        dcMemo: form.dcMemo,
        dealerAllocationId: resolvedAllocId,
        dealerName: selectedDealerName || json.record?.dealerName || '',
        unionName: selectedUnion || json.record?.unionName || '',
        licenseActionType,
        expectedAmount: effectiveExpected,
        expectedTaxAmount: form.expectedTaxAmount,
        challanNo:
          effectiveMode === 'main' || effectiveMode === 'single'
            ? normalized11
            : '',
        challanDate:
          effectiveMode === 'main' || effectiveMode === 'single'
            ? normalizedFormDate
            : '',
        rate: form.rate || effectiveExpected,
        quantity: form.quantity,
        totalAmount:
          effectiveMode === 'main' || effectiveMode === 'single'
            ? form.amount
            : '',
        incomeTaxChallanNo: effectiveMode === 'tax' ? normalized11 : '',
        incomeTaxDate: effectiveMode === 'tax' ? normalizedFormDate : '',
        incomeTaxAmount: effectiveMode === 'tax' ? form.amount : '',
        vatChallanNo: effectiveMode === 'vat' ? normalized11 : '',
        vatDate: effectiveMode === 'vat' ? normalizedFormDate : '',
        vatAmount: effectiveMode === 'vat' ? form.amount : '',
        licenseNo: resolvedLicenseNo,
        new37Code:
          effectiveMode === 'main' || effectiveMode === 'single'
            ? form.new37Code.trim()
            : json.record?.new37Code || form.new37Code.trim(),
        taxCode: effectiveMode === 'tax' ? form.new37Code.trim() : json.record?.taxCode || '',
        vatCode: effectiveMode === 'vat' ? form.new37Code.trim() : json.record?.vatCode || '',
        customFields: isTaxOrVatMode
          ? json.record?.customFields || mergeTargetRecord?.customFields || {}
          : customFieldValues,
        taxCustomFields:
          effectiveMode === 'tax'
            ? customFieldValues
            : json.record?.taxCustomFields || mergeTargetRecord?.taxCustomFields || {},
        vatCustomFields:
          effectiveMode === 'vat'
            ? customFieldValues
            : json.record?.vatCustomFields || mergeTargetRecord?.vatCustomFields || {},
        comment: isTaxOrVatMode ? '' : cleanCommentText,
        taxComment: isTaxOrVatMode ? cleanCommentText : '',
        taxExtra: taxExtraText,
        createdAt: nowIso,
        srcRecordId: json.record?.recordId || mergeTargetRecord?.recordId || '',
        ...(mergedRef
          ? {
              matchHints: {
                id: mergedRef.id,
                srcRecordId: mergedRef.recordId,
                challanNo: mergedRef.challanNo || '',
                incomeTaxChallanNo:
                  mergedRef.incomeTaxChallanNo ||
                  (effectiveMode === 'tax' ? normalized11 : ''),
                vatChallanNo:
                  mergedRef.vatChallanNo ||
                  (effectiveMode === 'vat' ? normalized11 : ''),
                dealerAllocationId: resolvedAllocId,
                licenseNo: resolvedLicenseNo,
                category: selectedKhat.name,
              },
            }
          : {}),
      };

      if (pushToSheet) {
        const token = getGoogleAccessToken();
        const useOAuth =
          (settings.syncMethod === 'oauth' || settings.syncMethod === 'both') &&
          Boolean(token) &&
          Boolean(settings.spreadsheetId.trim());

        const useGas =
          settings.syncMethod !== 'oauth' &&
          Boolean(settings.gasWebAppUrl.trim());

        if (!useOAuth && !useGas) {
          sheetErrorNotes.push(
            'Apps Script ব্রিজ বা Google সাইন-ইন সক্রিয় নয়'
          );
        } else {
          if (useOAuth) {
            try {
              const sheetRes = await writeChallanToGoogleSheetOAuth(
                settings,
                sheetEntry
              );
              oauthOk = true;
              sheetSuccessNotes.push(
                sheetRes.mode === 'updated'
                  ? `Google Sheet সারি ${sheetRes.rowNumber} আপডেট`
                  : `Google Sheet নতুন সারি ${sheetRes.rowNumber} যোগ`
              );
            } catch (err) {
              setGoogleAuthNonce((n) => n + 1);
              sheetErrorNotes.push(
                err instanceof Error ? err.message : String(err)
              );
            }
          }

          if (useGas && !oauthOk) {
            try {
              await pushToAppsScriptBridge(
                settings.gasWebAppUrl,
                sheetEntry as unknown as Record<string, unknown>
              );
              gasOk = true;
              sheetSuccessNotes.push('Apps Script-এ পুশ সম্পন্ন');
            } catch (err) {
              sheetErrorNotes.push(
                err instanceof Error ? err.message : String(err)
              );
            }
          }
        }
      }

      const sheetAnySucceeded = oauthOk || gasOk;
      if (json.record && (sheetAnySucceeded || cloudSynced)) {
        recordSavedInVault(json.record, sheetAnySucceeded, cloudSynced);
      }

      if (pushToSheet && !sheetAnySucceeded) {
        setPendingSheetEntry(sheetEntry);
        setSaveFeedback({
          tone: 'warning',
          text: `অ্যাপ${cloudSynced ? ', ক্লাউড' : ''} ও ব্রাউজার ভল্টে সেভ হয়েছে, কিন্তু Google Sheet-এ জমা হয়নি: ${sheetErrorNotes.join(' · ')}`,
        });
      } else {
        setPendingSheetEntry(null);
        setSaveFeedback({
          tone: 'success',
          text: [
            json.message,
            cloudSynced ? 'ক্লাউড (Firestore)-এ সুরক্ষিত' : 'ব্রাউজার ভল্টে সুরক্ষিত',
            ...sheetSuccessNotes,
            ...(cloudWarning ? [cloudWarning] : []),
            ...(sheetErrorNotes.length > 0
              ? [`অন্য চ্যানেলে সতর্কতা: ${sheetErrorNotes.join(' · ')}`]
              : []),
          ]
            .filter(Boolean)
            .join(' · '),
        });
      }

      setForm({
        ...EMPTY_FORM,
        expectedAmount: computeReferenceFee(
          selectedKhat,
          licenseActionType,
          scanRole
        ),
      });
      setEconomicOptions([]);
      setSelectedAllocId('');
      setSelectedDealerId('');
      setSelectedDealerName('');
      setSelectedUnion('');
      onSaved();
    } catch (err) {
      setSaveFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : 'সংরক্ষণ ব্যর্থ হয়েছে।',
      });
    } finally {
      setSaving(false);
    }
  }

  // =========================================================================
  // VIEW 1: CATEGORY HUB + PAGINATED LATEST-DATE DASHBOARD FEED
  // =========================================================================
  if (!selectedKhat) {
    const activeDashCategories = [
      'সকল',
      ...settings.khats.filter((k) => k.active).map((k) => k.name),
    ];

    return (
      <div className="space-y-5">
        {!cloudUser?.emailVerified && onConnectCloudBackup && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/90 px-3.5 py-2.5 text-xs font-bold text-emerald-950">
            <div className="flex items-center gap-2 min-w-0">
              <Cloud className="h-4 w-4 shrink-0 text-emerald-700" />
              <span className="truncate">
                এন্ট্রি স্থায়ীভাবে ক্লাউডে সেভ রাখতে Google দিয়ে ক্লাউড ব্যাকআপ চালু করুন
              </span>
            </div>
            <button
              type="button"
              disabled={cloudSyncing}
              onClick={() => void onConnectCloudBackup()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-700 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-800 disabled:opacity-60 cursor-pointer"
            >
              {cloudSyncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Cloud className="h-3.5 w-3.5" />
              )}
              ক্লাউড সেভ চালু করুন
            </button>
          </div>
        )}

        {pendingSheetCount > 0 && onFlushPendingSheet && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50/90 px-3.5 py-2.5 text-xs font-bold text-amber-950">
            <div className="flex items-center gap-2 min-w-0">
              <CloudUpload className="h-4 w-4 shrink-0 text-amber-700" />
              <span className="truncate">
                {toBengaliDigits(pendingSheetCount)}টি চালান অ্যাপে সেভ আছে — Google Sheet-এ পাঠানো বাকি আছে
              </span>
            </div>
            <button
              type="button"
              onClick={() => void onFlushPendingSheet()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-amber-900 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-amber-800 cursor-pointer"
            >
              <CloudUpload className="h-3.5 w-3.5" />
              এখনই শিটে পাঠান
            </button>
          </div>
        )}

        <CategoryHub
          khats={settings.khats}
          unlinkedSuballocationCount={unlinkedSuballocations.length}
          dealersCount={dealers.length}
          canOpenSettings={canOpenSettings}
          onSelectKhat={startCategoryScan}
          onOpenSettings={onOpenSettings}
        />

        {/* Bottom Dashboard: Latest Deposit Date First + Configurable Pagination + Swipe */}
        <section
          className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
          onTouchStart={(e) => {
            dashTouchStartX.current = e.changedTouches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            const endX = e.changedTouches[0]?.clientX;
            if (dashTouchStartX.current === null || typeof endX !== 'number') {
              return;
            }
            const dx = endX - dashTouchStartX.current;
            dashTouchStartX.current = null;
            if (Math.abs(dx) < 55) return;
            if (dx < 0 && safeDashPage < totalDashPages - 1) {
              setDashPage((p) => p + 1);
            } else if (dx > 0 && safeDashPage > 0) {
              setDashPage((p) => p - 1);
            }
          }}
        >
          {(() => {
            const dashBreakdown = countChallanBreakdown(sortedDashboardRecords);
            return (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Receipt className="h-4 w-4 text-rose-700" />
                  <h2 className="text-sm font-bold text-slate-900">
                    সাম্প্রতিক চালান ({toBengaliDigits(dashBreakdown.totalChallans)}টি)
                  </h2>
                  <span className="text-[11px] font-semibold text-slate-500 tabular-nums">
                    · মূল: {toBengaliDigits(dashBreakdown.mainCount)} · আয়কর:{' '}
                    {toBengaliDigits(dashBreakdown.taxCount)} · ভ্যাট:{' '}
                    {toBengaliDigits(dashBreakdown.vatCount)}
                  </span>
                  {sessionSavedCount > 0 && (
                    <span className="rounded-lg bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                      এই সেশনে সেভ: {toBengaliDigits(sessionSavedCount)}টি
                    </span>
                  )}
                </div>

            <div className="flex items-center gap-2">
              <select
                value={dashCategoryFilter}
                onChange={(e) => {
                  setDashCategoryFilter(e.target.value);
                  setDashPage(0);
                }}
                className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none"
              >
                {activeDashCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={onOpenAllRecords}
                className="text-xs font-bold text-rose-700 hover:underline whitespace-nowrap cursor-pointer"
              >
                সব দেখুন →
              </button>
            </div>
          </div>
            );
          })()}

          <div className="mt-3 relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={dashSearch}
              onChange={(e) => {
                setDashSearch(e.target.value);
                setDashPage(0);
              }}
              placeholder="নম্বর, কোড বা নাম খুঁজুন..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-8 pr-3 text-xs text-slate-900 focus:border-slate-900 focus:bg-white focus:outline-none"
            />
          </div>

          <div className="mt-3 divide-y divide-slate-100">
            {pagedDashboardRecords.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                কোনো চালান নেই
              </div>
            ) : (
              pagedDashboardRecords.map((r) => {
                const displayDate =
                  normalizeChallanDate(
                    r.challanDate || r.incomeTaxDate || r.vatDate || r.date
                  ) || '—';
                return (
                  <div
                    key={r.recordId}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-slate-900">
                        {r.dealerName || r.submittedThrough || 'অনির্ধারিত'}
                        {r.licenseNo ? ` (${r.licenseNo})` : ''}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 font-mono-num">
                        <span className="font-sans text-slate-700 font-medium">
                          খাত: {r.challanCategory}
                        </span>
                        <span>·</span>
                        <span>{displayDate}</span>
                        {r.challanNo && (
                          <>
                            <span>·</span>
                            <span>{normalizeChallanNo(r.challanNo)}</span>
                          </>
                        )}
                        {r.new37Code && (
                          <>
                            <span>·</span>
                            <span className="text-slate-700 font-semibold">
                              কোড: {toBengaliDigits(r.new37Code)}
                            </span>
                          </>
                        )}
                        {r.taxCode && (
                          <>
                            <span>·</span>
                            <span className="text-amber-800 font-semibold">
                              আয়কর কোড: {toBengaliDigits(r.taxCode)}
                            </span>
                          </>
                        )}
                        {r.vatCode && (
                          <>
                            <span>·</span>
                            <span className="text-indigo-800 font-semibold">
                              ভ্যাট কোড: {toBengaliDigits(r.vatCode)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="text-right shrink-0 font-mono-num">
                      <div className="text-xs font-bold text-slate-900">
                        ৳ {formatMoney(r.amount || r.incomeTaxAmount || r.vatAmount)}
                      </div>
                      {(toNumericValue(r.incomeTaxAmount) > 0 ||
                        toNumericValue(r.vatAmount) > 0) && (
                        <div className="text-[10px] text-amber-700">
                          {[
                            toNumericValue(r.incomeTaxAmount) > 0
                              ? `কর ৳${formatMoney(r.incomeTaxAmount)}`
                              : '',
                            toNumericValue(r.vatAmount) > 0
                              ? `ভ্যাট ৳${formatMoney(r.vatAmount)}`
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {sortedDashboardRecords.length > 0 && (
            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs tabular-nums">
              <button
                type="button"
                disabled={safeDashPage <= 0}
                onClick={() => setDashPage((p) => Math.max(0, p - 1))}
                className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
              >
                <ChevronLeft className="h-4 w-4" />
                আগের
              </button>

              <span className="text-xs font-semibold text-slate-600">
                পৃষ্ঠা {safeDashPage + 1} / {totalDashPages} ({pageSize}টি/পৃষ্ঠা)
              </span>

              <button
                type="button"
                disabled={safeDashPage >= totalDashPages - 1}
                onClick={() =>
                  setDashPage((p) => Math.min(totalDashPages - 1, p + 1))
                }
                className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
              >
                পরের
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </section>
      </div>
    );
  }

  // =========================================================================
  // VIEW 2: FULL-SCREEN FOCUSED CATEGORY / SUBMENU WORKSPACE
  // =========================================================================
  const verificationUrl = form.challanNo.trim()
    ? getOfficialVerificationUrl(form.challanNo)
    : '';
  const isLicenseGroup = selectedKhat.group === 'license';
  const sameGroupKhats = settings.khats.filter(
    (k) => k.active && k.group === selectedKhat.group
  );
  const licenseChipExpectedFee = isLicenseGroup
    ? computeReferenceFee(selectedKhat, licenseActionType, scanRole)
    : '';

  return (
    <div className="space-y-1.5 pb-1">
      <div id="qr-photo-decode-hidden" className="hidden" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileQrUpload}
      />

      {/* Compact Single-Row Workspace Top Header */}
      <div className="flex items-center justify-between gap-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => setSelectedKhat(null)}
            aria-label="পিছনে যান"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100 cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-700 border border-rose-200">
            {renderKhatIcon(selectedKhat.iconKey, 'h-3.5 w-3.5')}
          </span>

          <div className="min-w-0">
            <div className="truncate text-xs font-extrabold text-slate-900 sm:text-sm">
              {selectedKhat.name}
            </div>
            {isLicenseGroup && licenseActionType && (
              <div className="text-[10px] leading-tight font-bold text-rose-700">
                {licenseActionType}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isLicenseGroup &&
            (selectedKhat.subGroup === 'new' ||
              selectedKhat.subGroup === 'renewal' ||
              selectedKhat.name.includes('লাইসেন্স')) && (
              <div className="flex items-center rounded-lg bg-slate-100 p-0.5">
                {(['নতুন', 'নবায়ন'] as const).map((act) => (
                  <button
                    key={act}
                    type="button"
                    onClick={() => setLicenseActionType(act)}
                    className={`rounded-md px-1.5 py-1 text-[10px] font-bold transition-colors cursor-pointer ${
                      licenseActionType === act
                        ? 'bg-white text-rose-800 shadow-2xs'
                        : 'text-slate-600'
                    }`}
                  >
                    {act}
                  </button>
                ))}
              </div>
            )}

          <select
            value={selectedKhat.id}
            onChange={(e) => {
              const next = settings.khats.find((k) => k.id === e.target.value);
              if (next) startCategoryScan(next, licenseActionType || undefined);
            }}
            aria-label="ক্যাটেগরি পরিবর্তন"
            className="h-8 max-w-[110px] truncate rounded-lg border border-slate-200 bg-slate-50 px-1.5 text-[11px] font-bold text-slate-800 focus:outline-none"
          >
            {sameGroupKhats.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="ছবি থেকে QR"
            aria-label="ছবি থেকে QR"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Compact Single-Row Scan Trigger Buttons */}
      {isLicenseGroup ? (
        <div
          className={`grid gap-1.5 ${
            selectedKhat.hasVat && selectedKhat.hasIncomeTax
              ? 'grid-cols-3'
              : selectedKhat.hasIncomeTax || selectedKhat.hasVat
              ? 'grid-cols-2'
              : 'grid-cols-1'
          }`}
        >
          <button
            type="button"
            onClick={() => triggerScanWithRole('main')}
            className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 text-xs font-bold transition-all cursor-pointer ${
              scanRole === 'main'
                ? 'bg-teal-700 text-white ring-2 ring-teal-700/40'
                : 'border border-teal-200 bg-teal-50 text-teal-900'
            }`}
          >
            <Camera className="h-4 w-4 shrink-0" />
            <span>মূল চালান</span>
          </button>

          {selectedKhat.hasIncomeTax && (
            <button
              type="button"
              onClick={() => triggerScanWithRole('tax')}
              className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 text-xs font-bold transition-all cursor-pointer ${
                scanRole === 'tax'
                  ? 'bg-amber-700 text-white ring-2 ring-amber-700/40'
                  : 'border border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              <Receipt className="h-4 w-4 shrink-0" />
              <span>আয়কর</span>
            </button>
          )}

          {selectedKhat.hasVat && (
            <button
              type="button"
              onClick={() => triggerScanWithRole('vat')}
              className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 text-xs font-bold transition-all cursor-pointer ${
                scanRole === 'vat'
                  ? 'bg-indigo-700 text-white ring-2 ring-indigo-700/40'
                  : 'border border-indigo-200 bg-indigo-50 text-indigo-900'
              }`}
            >
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>ভ্যাট</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => triggerScanWithRole('main')}
            className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold transition-all cursor-pointer ${
              scanRole === 'main'
                ? 'bg-teal-700 text-white ring-2 ring-teal-700/40'
                : 'border border-teal-200 bg-teal-50 text-teal-900'
            }`}
          >
            <Camera className="h-4 w-4 shrink-0" />
            <span>মূল চালান</span>
          </button>

          <button
            type="button"
            onClick={() => triggerScanWithRole('tax')}
            className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold transition-all cursor-pointer ${
              scanRole === 'tax'
                ? 'bg-amber-700 text-white ring-2 ring-amber-700/40'
                : 'border border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            <Camera className="h-4 w-4 shrink-0" />
            <span>আয়কর চালান</span>
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div
          className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-bold ${
            sheetCapability.anyReady
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-amber-50 text-amber-900 border border-amber-200'
          }`}
        >
          <CloudUpload className="h-3.5 w-3.5 shrink-0" />
          <span>
            {sheetCapability.anyReady
              ? 'ব্রাউজার ভল্ট + অটো Google Sheet সিঙ্ক চালু'
              : 'ব্রাউজার ভল্টে সেভ হবে (শিটে ব্যাকআপের জন্য সেটিংস দেখুন)'}
          </span>
        </div>
        {sessionSavedCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2 py-1 font-bold text-white">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            এই সেশনে সেভ: {toBengaliDigits(sessionSavedCount)}টি
          </span>
        )}
      </div>

      {!isLicenseGroup && ucfMemoOptions.length > 0 && (
        <div className="flex items-center gap-1.5 rounded-xl border border-teal-200 bg-teal-50/70 px-2 py-1">
          <span className="shrink-0 text-[10px] font-extrabold text-teal-900">
            ইউসিএফ স্মারক
          </span>
          <select
            value={selectedUcfMemoKey}
            onChange={(e) => {
              setSelectedUcfMemoKey(e.target.value);
              setSelectedAllocId('');
              setSelectedDealerId('');
              setSelectedDealerName('');
              setSelectedUnion('');
            }}
            aria-label="ইউসিএফ উপ-বরাদ্দ স্মারক নির্বাচন"
            className="h-7 min-w-0 flex-1 rounded-lg border border-teal-300 bg-white px-2 text-[11px] font-bold text-slate-900 focus:border-teal-700 focus:outline-none truncate"
          >
            <option value="">
              সকল স্মারক (অবশিষ্ট {toBengaliDigits(
                categorySuballocations.filter(
                  (s) => !linkedAllocationIds.has(s.id)
                ).length
              )}টি)
            </option>
            {ucfMemoOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                স্মারক: {opt.unoMemo || '—'}
                {opt.sourceMemo ? ` (উৎস: ${opt.sourceMemo})` : ''}
                {opt.allocationDate ? ` · ${toBengaliDigits(opt.allocationDate)}` : ''}
                {` — বাকি ${toBengaliDigits(opt.remainingCount)}/${toBengaliDigits(opt.totalCount)}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {scanStatus && (
        <div
          role="status"
          className={`flex items-center justify-between rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
            scanStatus.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : scanStatus.tone === 'error'
              ? 'border-red-200 bg-red-50 text-red-900'
              : 'border-slate-200 bg-slate-50 text-slate-800'
          }`}
        >
          <span className="truncate">{scanStatus.text}</span>
          {fetchingOfficial && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
        </div>
      )}

      {!isLicenseGroup && selectedUcfMemoKey && matchedSuballocations.length === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-bold text-amber-900">
          নির্বাচিত ইউসিএফ স্মারকের সব উপ-বরাদ্দের চালান যুক্ত হয়ে গেছে (অবশিষ্ট ০টি)।
        </div>
      )}

      {/* Single-Line Closest Suggestion Carousel (1 visible at a time, swipe/scroll left for next) */}
      {!isLicenseGroup && matchedSuballocations.length > 0 && (
        <div className="flex items-stretch overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div
            ref={suggestionStripRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.clientWidth > 0) {
                const idx = Math.round(el.scrollLeft / el.clientWidth);
                setActiveSuggestionIdx(
                  Math.max(0, Math.min(matchedSuballocations.length - 1, idx))
                );
              }
            }}
            className="flex min-w-0 flex-1 overflow-x-auto snap-x snap-mandatory scroll-smooth [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
          >
            {matchedSuballocations.map(({ sub, targetAmt, exact }) => {
              const isSelected = selectedAllocId === sub.id;
              const shortDate = formatCompactShortDate(
                sub.allocationDate || sub.createdAt
              );
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => selectMatchedSuballocation(sub)}
                  className={`flex w-full shrink-0 snap-start items-center gap-2 px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-teal-50/90'
                      : exact
                      ? 'bg-emerald-50/50 hover:bg-emerald-50'
                      : 'hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                      isSelected
                        ? 'bg-teal-700 text-white'
                        : exact
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <UserIcon className="h-3.5 w-3.5" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="truncate text-[11px] font-extrabold text-slate-900">
                        {sub.dealerName || 'ডিলার'}
                      </span>
                      <span className="shrink-0 font-mono-num text-[11px] font-extrabold text-teal-800 tabular-nums">
                        ৳{formatMoney(targetAmt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 truncate text-[10px] text-slate-600">
                      <MapPin className="h-2.5 w-2.5 shrink-0 text-rose-600" />
                      <span className="truncate">
                        {sub.unionName || 'ইউনিয়ন নেই'}
                      </span>
                      <span className="shrink-0 font-mono-num text-slate-400">
                        · {sub.allocationQty}ট
                      </span>
                      {sub.unoMemo && (
                        <span className="shrink-0 font-mono-num font-bold text-teal-700">
                          · স্মারক {sub.unoMemo}
                        </span>
                      )}
                      {shortDate && (
                        <span className="shrink-0 font-mono-num text-slate-400">
                          · {shortDate}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {matchedSuballocations.length > 1 && (
            <div className="flex shrink-0 items-center gap-0.5 border-l border-slate-200 bg-slate-50/80 px-1">
              <button
                type="button"
                disabled={activeSuggestionIdx <= 0}
                onClick={() =>
                  scrollToSuggestion(
                    activeSuggestionIdx - 1,
                    matchedSuballocations.length
                  )
                }
                aria-label="আগের সাজেশন"
                className="flex h-7 w-6 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-200/70 disabled:opacity-30 cursor-pointer"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-0.5 font-mono-num text-[10px] font-bold text-slate-600 tabular-nums">
                {activeSuggestionIdx + 1}/{matchedSuballocations.length}
              </span>
              <button
                type="button"
                disabled={
                  activeSuggestionIdx >= matchedSuballocations.length - 1
                }
                onClick={() =>
                  scrollToSuggestion(
                    activeSuggestionIdx + 1,
                    matchedSuballocations.length
                  )
                }
                aria-label="পরের সাজেশন দেখুন"
                className="inline-flex h-7 items-center gap-0.5 rounded-lg bg-slate-900 px-1.5 text-[10px] font-bold text-white hover:bg-slate-800 disabled:bg-slate-300 cursor-pointer"
              >
                <span>পরের</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {isLicenseGroup && matchedLicenseCandidates.length > 0 && (
        <div className="flex items-stretch overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div
            ref={suggestionStripRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.clientWidth > 0) {
                const idx = Math.round(el.scrollLeft / el.clientWidth);
                setActiveSuggestionIdx(
                  Math.max(0, Math.min(matchedLicenseCandidates.length - 1, idx))
                );
              }
            }}
            className="flex min-w-0 flex-1 overflow-x-auto snap-x snap-mandatory scroll-smooth [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
          >
            {matchedLicenseCandidates.map((cand) => {
              const isSelected =
                selectedDealerId === cand.id ||
                (selectedDealerName && selectedDealerName === cand.name);
              const chipFee = toNumericValue(
                form.expectedAmount || licenseChipExpectedFee
              );
              return (
                <button
                  key={cand.id}
                  type="button"
                  onClick={() => selectMatchedLicenseCandidate(cand)}
                  className={`flex w-full shrink-0 snap-start items-center gap-2 px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    isSelected ? 'bg-teal-50/90' : 'hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                      isSelected
                        ? 'bg-teal-700 text-white'
                        : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <FileBadge2 className="h-3.5 w-3.5" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="truncate text-[11px] font-extrabold text-slate-900">
                        {cand.name}
                      </span>
                      {chipFee > 0 && (
                        <span className="shrink-0 font-mono-num text-[11px] font-extrabold text-teal-800 tabular-nums">
                          ৳{formatMoney(chipFee)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 truncate text-[10px] text-slate-600">
                      <MapPin className="h-2.5 w-2.5 shrink-0 text-rose-600" />
                      <span className="truncate">
                        {cand.address ||
                          (cand.licenseNo ? `লাই: ${cand.licenseNo}` : '—')}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {matchedLicenseCandidates.length > 1 && (
            <div className="flex shrink-0 items-center gap-0.5 border-l border-slate-200 bg-slate-50/80 px-1">
              <button
                type="button"
                disabled={activeSuggestionIdx <= 0}
                onClick={() =>
                  scrollToSuggestion(
                    activeSuggestionIdx - 1,
                    matchedLicenseCandidates.length
                  )
                }
                aria-label="আগের সাজেশন"
                className="flex h-7 w-6 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-200/70 disabled:opacity-30 cursor-pointer"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-0.5 font-mono-num text-[10px] font-bold text-slate-600 tabular-nums">
                {activeSuggestionIdx + 1}/{matchedLicenseCandidates.length}
              </span>
              <button
                type="button"
                disabled={
                  activeSuggestionIdx >= matchedLicenseCandidates.length - 1
                }
                onClick={() =>
                  scrollToSuggestion(
                    activeSuggestionIdx + 1,
                    matchedLicenseCandidates.length
                  )
                }
                aria-label="পরের সাজেশন দেখুন"
                className="inline-flex h-7 items-center gap-0.5 rounded-lg bg-slate-900 px-1.5 text-[10px] font-bold text-white hover:bg-slate-800 disabled:bg-slate-300 cursor-pointer"
              >
                <span>পরের</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Compact Structured Form Card */}
      <form
        onSubmit={handlePreSaveSubmit}
        className="rounded-xl border border-slate-200 bg-white p-2.5 space-y-2"
      >
        {/* Row 1: Challan No (11-digit), Date, Amount */}
        <div className="grid grid-cols-12 gap-1.5">
          <div className="col-span-5">
            <div className="mb-0.5 flex items-center justify-between">
              <label className="text-[10px] font-bold text-slate-600">
                চালান নং
              </label>
              {verificationUrl && (
                <a
                  href={verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] font-bold text-teal-700 hover:underline"
                >
                  যাচাই
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={form.challanNo}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, challanNo: e.target.value }))
                }
                placeholder="১১ অঙ্ক"
                className="font-mono-num h-8 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-[11px] font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
              />
              <button
                type="button"
                disabled={fetchingOfficial}
                onClick={() => void fetchOfficialChallan(form.challanNo)}
                aria-label="তথ্য আনুন"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60 cursor-pointer"
              >
                {fetchingOfficial ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="col-span-3">
            <label className="mb-0.5 block text-[10px] font-bold text-slate-600">
              তারিখ
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              value={form.challanDate}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  challanDate: maskDateInput(e.target.value),
                }))
              }
              placeholder="yyyy-MM-dd"
              className="font-mono-num h-8 w-full rounded-lg border border-slate-300 px-1.5 text-[11px] text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <div className="col-span-4">
            <label className="mb-0.5 block text-[10px] font-bold text-slate-600">
              {scanRole === 'tax'
                ? 'আয়কর (৳)'
                : scanRole === 'vat'
                ? 'ভ্যাট (৳)'
                : 'জমা টাকা (৳)'}
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, amount: e.target.value }))
              }
              placeholder="0.00"
              className="font-mono-num h-8 w-full rounded-lg border border-slate-300 px-2 text-[11px] font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>
        </div>

        {/* Row 2: Economic / Deposit Code + Quick Chips */}
        <div className="space-y-1">
          {economicOptions.length > 0 && (
            <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
              {economicOptions.map((opt) => {
                const active = form.new37Code.trim() === opt.code.trim();
                return (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => handleSelectEconomicCode(opt)}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold transition-colors cursor-pointer ${
                      active
                        ? 'border-teal-700 bg-teal-700 text-white'
                        : 'border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100'
                    }`}
                  >
                    <span className="font-mono-num">{opt.code}</span>
                    {opt.amount && toNumericValue(opt.amount) > 0 && (
                      <span className="font-mono-num opacity-90">
                        (৳{formatMoney(opt.amount)})
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-slate-100 px-2 text-[10px] font-bold text-slate-700">
              <Hash className="h-3 w-3 text-rose-700" />
              জমা কোড
            </span>
            <input
              type="text"
              value={form.new37Code}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, new37Code: e.target.value }))
              }
              placeholder="যেমন: 1422319 (বিবরণের নিচে বসবে)"
              className="font-mono-num h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-[11px] font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>
        </div>

        {/* Row 3: Union & Dealer / Licensee Selector + Inline Manual Toggle */}
        <div className="flex items-center gap-1.5">
          {manualEntryOpen ? (
            <>
              <input
                type="text"
                value={selectedDealerName}
                onChange={(e) => {
                  setSelectedDealerName(e.target.value);
                  setSelectedDealerId('');
                  setSelectedAllocId('');
                }}
                placeholder="ডিলার/নাম লিখুন"
                className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-[11px] text-slate-900 focus:border-slate-900 focus:outline-none"
              />
              <input
                type="text"
                value={selectedUnion}
                onChange={(e) => setSelectedUnion(e.target.value)}
                placeholder="ইউনিয়ন / ঠিকানা"
                className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-[11px] text-slate-900 focus:border-slate-900 focus:outline-none"
              />
            </>
          ) : (
            <>
              <select
                value={selectedUnion}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedUnion(val);
                  if (isMemoFilterActive) {
                    setSelectedAllocId('');
                    setSelectedDealerId('');
                    setSelectedDealerName('');
                  }
                }}
                aria-label="ইউনিয়ন"
                className="h-8 w-[38%] shrink-0 rounded-lg border border-slate-300 bg-white px-1.5 text-[11px] text-slate-900 focus:outline-none truncate"
              >
                <option value="">
                  {isMemoFilterActive
                    ? `সব ইউনিয়ন (${toBengaliDigits(dropdownMemoSuballocations.length)}টি)`
                    : 'সব ইউনিয়ন'}
                </option>
                {dropdownUnions.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>

              {isMemoFilterActive ? (
                <select
                  value={selectedAllocId}
                  onChange={(e) => {
                    const allocId = e.target.value;
                    if (!allocId) {
                      setSelectedAllocId('');
                      setSelectedDealerId('');
                      setSelectedDealerName('');
                      return;
                    }
                    const picked = memoFilteredUnlinkedSuballocations.find(
                      (s) => s.id === allocId
                    );
                    if (picked) {
                      selectMatchedSuballocation(picked);
                    }
                  }}
                  aria-label="স্মারকের অবশিষ্ট উপ-বরাদ্দ ডিলার"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-teal-400 bg-teal-50/40 px-1.5 text-[11px] font-semibold text-slate-900 focus:border-teal-700 focus:outline-none truncate"
                >
                  <option value="">
                    {dropdownMemoSuballocations.length > 0
                      ? `ডিলার নির্বাচন (${toBengaliDigits(dropdownMemoSuballocations.length)}টি বাকি)`
                      : 'অবশিষ্ট উপ-বরাদ্দ নেই'}
                  </option>
                  {dropdownMemoSuballocations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.dealerName}
                      {s.unionName ? ` — ${s.unionName}` : ''} (
                      {toBengaliDigits(s.allocationQty)}ট · ৳
                      {formatMoney(scanRole === 'tax' ? s.taxAmount : s.totalAmount)}
                      )
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={selectedDealerName}
                  onChange={(e) => {
                    const name = e.target.value;
                    setSelectedDealerName(name);
                    setSelectedAllocId('');
                    const found = dealers.find((d) => d.dealerName === name);
                    if (found) {
                      setSelectedDealerId(found.id);
                      if (found.unionName) setSelectedUnion(found.unionName);
                    } else {
                      const lic = licensees.find((l) => l.licenseeName === name);
                      if (lic) {
                        setSelectedDealerId(lic.id);
                        setSelectedUnion(lic.address);
                        setForm((prev) => ({
                          ...prev,
                          licenseNo: lic.licenseNo,
                        }));
                      } else {
                        setSelectedDealerId('');
                      }
                    }
                  }}
                  aria-label="ডিলার"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-1.5 text-[11px] text-slate-900 focus:outline-none truncate"
                >
                  <option value="">ডিলার নির্বাচন</option>
                  {filteredDealers.map((d) => (
                    <option key={d.id} value={d.dealerName}>
                      {d.dealerName}
                      {d.unionName ? ` — ${d.unionName}` : ''}
                    </option>
                  ))}
                  {isLicenseGroup &&
                    licensees.map((l) => (
                      <option key={l.id} value={l.licenseeName}>
                        {l.licenseeName} ({l.licenseNo})
                      </option>
                    ))}
                </select>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => {
              setSelectedAllocId('');
              setManualEntryOpen((v) => !v);
            }}
            title="হাতে লিখুন"
            aria-label="হাতে লিখুন"
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
              manualEntryOpen
                ? 'border-rose-700 bg-rose-50 text-rose-800'
                : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
            }`}
          >
            {manualEntryOpen ? (
              <Pencil className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        {/* Row 4: 4 Compact Columns Always on 1 Row */}
        {selectedKhat.showQuantityRate && scanRole === 'main' ? (
          <div className="grid grid-cols-4 gap-1.5">
            <div>
              <label className="mb-0.5 block truncate text-[10px] font-bold text-slate-600">
                পরিমাণ (টন)
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={form.quantity}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, quantity: e.target.value }))
                }
                placeholder="0.00"
                className="font-mono-num h-8 w-full rounded-lg border border-slate-300 px-1.5 text-[11px] text-slate-900"
              />
            </div>
            <div>
              <label className="mb-0.5 block truncate text-[10px] font-bold text-slate-600">
                দর
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={form.rate}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, rate: e.target.value }))
                }
                placeholder="13000"
                className="font-mono-num h-8 w-full rounded-lg border border-slate-300 px-1.5 text-[11px] text-slate-900"
              />
            </div>
            <div>
              <label className="mb-0.5 block truncate text-[10px] font-bold text-slate-600">
                প্রাপ্য (৳)
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={form.expectedAmount}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, expectedAmount: e.target.value }))
                }
                placeholder="0.00"
                className="font-mono-num h-8 w-full rounded-lg border border-slate-300 bg-slate-50 px-1.5 text-[11px] font-bold text-slate-900"
              />
            </div>
            <div>
              <label className="mb-0.5 block truncate text-[10px] font-bold text-slate-600">
                প্রদানকারী
              </label>
              <input
                type="text"
                value={form.submittedThrough}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    submittedThrough: e.target.value,
                  }))
                }
                placeholder="আইবাস নাম"
                className="h-8 w-full rounded-lg border border-slate-300 px-1.5 text-[11px] text-slate-900"
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            <div>
              <label className="mb-0.5 block truncate text-[10px] font-bold text-slate-600">
                লাইসেন্স নং
              </label>
              <input
                type="text"
                value={form.licenseNo}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, licenseNo: e.target.value }))
                }
                placeholder="লাইসেন্স"
                className="font-mono-num h-8 w-full rounded-lg border border-slate-300 px-1.5 text-[11px] text-slate-900"
              />
            </div>
            <div>
              <label className="mb-0.5 block truncate text-[10px] font-bold text-slate-600">
                প্রাপ্য (৳)
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={form.expectedAmount}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    expectedAmount: e.target.value,
                  }))
                }
                placeholder="0"
                className="font-mono-num h-8 w-full rounded-lg border border-slate-300 bg-slate-50 px-1.5 text-[11px] font-bold text-slate-900"
              />
            </div>
            <div>
              <label className="mb-0.5 block truncate text-[10px] font-bold text-slate-600">
                প্রাপ্য কর
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={form.expectedTaxAmount}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    expectedTaxAmount: e.target.value,
                  }))
                }
                placeholder="0"
                className="font-mono-num h-8 w-full rounded-lg border border-slate-300 bg-slate-50 px-1.5 text-[11px] font-bold text-slate-900"
              />
            </div>
            <div>
              <label className="mb-0.5 block truncate text-[10px] font-bold text-slate-600">
                প্রদানকারী
              </label>
              <input
                type="text"
                value={form.submittedThrough}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    submittedThrough: e.target.value,
                  }))
                }
                placeholder="আইবাস নাম"
                className="h-8 w-full rounded-lg border border-slate-300 px-1.5 text-[11px] text-slate-900"
              />
            </div>
          </div>
        )}

        {/* Custom Register Columns configured in Settings */}
        {settings.customColumns && settings.customColumns.length > 0 && (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {settings.customColumns.map((colDef) => (
              <div key={colDef.id}>
                <input
                  type="text"
                  aria-label={colDef.label}
                  placeholder={`${colDef.label} (${colDef.sheetColumn})`}
                  value={customFieldValues[colDef.id] || ''}
                  onChange={(e) =>
                    setCustomFieldValues((prev) => ({
                      ...prev,
                      [colDef.id]: e.target.value,
                    }))
                  }
                  className="h-8 w-full rounded-lg border border-slate-300 px-2 text-[11px] text-slate-900"
                />
              </div>
            ))}
          </div>
        )}

        {/* Verbatim Challan Remarks (Economic Code Stripped) */}
        <div>
          <label className="mb-0.5 block text-[10px] font-bold text-slate-600">
            মন্তব্য (চালান থেকে হুবহু — কোড নম্বর ছাড়া)
          </label>
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, description: e.target.value }))
            }
            placeholder="চালান স্ক্যান করলে মূল মন্তব্য এখানে হুবহু আসবে (অর্থনৈতিক কোড বাদ দিয়ে)"
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-900 focus:border-slate-900 focus:outline-none"
          />
        </div>

        {liveChallanConflict && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] font-bold text-red-900">
            {liveChallanConflict.message}
          </div>
        )}

        {mergeTargetRecord && !liveChallanConflict && (
          <div className="rounded-lg border border-teal-200 bg-teal-50 px-2 py-1 text-[11px] font-bold text-teal-900">
            পূর্বের সারি (ক্রমিক {mergeTargetRecord.serialNo})-এ আপডেট হবে
          </div>
        )}

        {/* Compact Google Sheet Push Toggle + Inline OAuth Connect */}
        <div
          className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1 text-[11px] ${
            sheetCapability.oauthReady
              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
              : 'border-amber-200 bg-amber-50/70 text-amber-900'
          }`}
        >
          <label className="inline-flex min-w-0 items-center gap-1.5 font-bold cursor-pointer">
            <input
              type="checkbox"
              checked={pushToSheet}
              onChange={(e) => {
                pushToggledManuallyRef.current = true;
                setPushToSheet(e.target.checked);
              }}
              className="h-3.5 w-3.5 shrink-0 rounded border-slate-300"
            />
            <CloudUpload className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              Sheet-এ পুশ (
              {sheetCapability.oauthReady
                ? 'Google OAuth সক্রিয়'
                : sheetCapability.gasReady
                ? 'Google সাইন-ইন নেই · শুধু ব্রিজ'
                : 'সংযুক্ত নয় — শুধু অ্যাপে সেভ হবে'}
              )
            </span>
          </label>
          {!sheetCapability.oauthReady &&
            settings.syncMethod !== 'apps_script' &&
            Boolean(settings.spreadsheetId?.trim()) && (
              <button
                type="button"
                disabled={googleConnecting}
                onClick={async () => {
                  setGoogleConnecting(true);
                  try {
                    const res = await googleSignIn();
                    if (res) {
                      setGoogleAuthNonce((n) => n + 1);
                    }
                  } catch (err) {
                    setSaveFeedback({
                      tone: 'error',
                      text:
                        err instanceof Error
                          ? err.message
                          : 'Google সাইন-ইন ব্যর্থ হয়েছে।',
                    });
                  } finally {
                    setGoogleConnecting(false);
                  }
                }}
                className="shrink-0 rounded-md bg-teal-700 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
              >
                {googleConnecting ? 'সংযোগ...' : 'Google সাইন-ইন'}
              </button>
            )}
          {!sheetCapability.anyReady &&
            canOpenSettings &&
            !settings.spreadsheetId?.trim() && (
              <button
                type="button"
                onClick={onOpenSheetSettings || onOpenSettings}
                className="shrink-0 rounded-md bg-amber-900 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-amber-800 cursor-pointer"
              >
                সংযোগ
              </button>
            )}
        </div>

        {saveFeedback && (
          <div
            ref={saveFeedbackRef}
            role="status"
            className={`space-y-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold ${
              saveFeedback.tone === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : saveFeedback.tone === 'warning'
                ? 'border-amber-300 bg-amber-50 text-amber-950'
                : 'border-red-200 bg-red-50 text-red-900'
            }`}
          >
            <div className="flex items-start gap-1.5">
              {saveFeedback.tone === 'success' && (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span className="leading-snug">{saveFeedback.text}</span>
            </div>

            {pendingSheetEntry && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {getSheetPushCapability(settings).gasReady && (
                  <button
                    type="button"
                    disabled={googleConnecting}
                    onClick={async () => {
                      setGoogleConnecting(true);
                      try {
                        await pushToAppsScriptBridge(
                          settings.gasWebAppUrl,
                          pendingSheetEntry as unknown as Record<string, unknown>
                        );
                        if (pendingSheetEntry.srcRecordId) {
                          markRecordsSheetSyncedInVault([pendingSheetEntry.srcRecordId]);
                          onSaved();
                        }
                        setPendingSheetEntry(null);
                        setSaveFeedback({
                          tone: 'success',
                          text: 'Apps Script ব্রিজের মাধ্যমে Google Sheet-এ সংরক্ষিত হয়েছে!',
                        });
                      } catch (err) {
                        setSaveFeedback({
                          tone: 'warning',
                          text:
                            err instanceof Error
                              ? `Apps Script দিয়ে শিটে পাঠানো যায়নি: ${err.message}`
                              : 'Apps Script দিয়ে শিটে পাঠানো যায়নি।',
                        });
                      } finally {
                        setGoogleConnecting(false);
                      }
                    }}
                    className="inline-flex min-h-[36px] items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-800 disabled:opacity-60 cursor-pointer"
                  >
                    {googleConnecting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CloudUpload className="h-3 w-3" />
                    )}
                    Apps Script দিয়ে শিটে পাঠান (বিনা লগইন)
                  </button>
                )}

                <button
                  type="button"
                  disabled={googleConnecting}
                  onClick={async () => {
                    setGoogleConnecting(true);
                    try {
                      if (!getGoogleAccessToken()) {
                        await googleSignIn();
                      }
                      setGoogleAuthNonce((n) => n + 1);
                      const sheetRes = await writeChallanToGoogleSheetOAuth(
                        settings,
                        pendingSheetEntry
                      );
                      if (pendingSheetEntry.srcRecordId) {
                        markRecordsSheetSyncedInVault([pendingSheetEntry.srcRecordId]);
                        onSaved();
                      }
                      setPendingSheetEntry(null);
                      setSaveFeedback({
                        tone: 'success',
                        text:
                          sheetRes.mode === 'updated'
                            ? `Google Sheet সারি ${sheetRes.rowNumber} আপডেট সম্পন্ন!`
                            : `Google Sheet নতুন সারি ${sheetRes.rowNumber} সংরক্ষিত হয়েছে!`,
                      });
                    } catch (err) {
                      setSaveFeedback({
                        tone: 'warning',
                        text:
                          err instanceof Error
                            ? `Google Sheet-এ পাঠানো যায়নি: ${err.message}`
                            : 'Google Sheet-এ পাঠানো যায়নি।',
                      });
                    } finally {
                      setGoogleConnecting(false);
                    }
                  }}
                  className="inline-flex min-h-[36px] items-center gap-1 rounded-md bg-teal-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                >
                  {googleConnecting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CloudUpload className="h-3 w-3" />
                  )}
                  Google সাইন-ইন করে এখনই শিটে পাঠান
                </button>

                {!getSheetPushCapability(settings).gasReady &&
                  canOpenSettings && (
                    <button
                      type="button"
                      onClick={() => (onOpenSheetSettings || onOpenSettings)()}
                      className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-amber-400 bg-white px-2.5 py-1 text-[11px] font-bold text-amber-950 hover:bg-amber-100 cursor-pointer"
                    >
                      লগইন ছাড়া Apps Script সেটআপ করুন
                    </button>
                  )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={() => {
              setForm({
                ...EMPTY_FORM,
                expectedAmount: computeReferenceFee(
                  selectedKhat,
                  licenseActionType,
                  scanRole
                ),
              });
              setEconomicOptions([]);
              setSelectedAllocId('');
              setSelectedDealerId('');
              setSelectedDealerName('');
              setScanStatus(null);
            }}
            className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            রিসেট
          </button>

          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-[38px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-700 px-4 py-1.5 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-60 cursor-pointer"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {mergeTargetRecord ? 'আপডেট ও সেভ' : 'সেভ করুন'}
          </button>
        </div>
      </form>

      {/* Pre-Save Confirmation Dialog */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5">
            <h3 className="text-base font-bold text-slate-900">
              নিশ্চিত করুন
            </h3>

            <div className="mt-3 space-y-1.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
              <div>
                <span className="font-semibold text-slate-500">খাত:</span>{' '}
                {selectedKhat.name}{' '}
                {licenseActionType ? `(${licenseActionType})` : ''}
              </div>
              <div>
                <span className="font-semibold text-slate-500">নাম:</span>{' '}
                {selectedDealerName || form.submittedThrough || 'অনির্ধারিত'}
                {form.licenseNo ? ` · ${form.licenseNo}` : ''}
              </div>
              <div className="font-mono-num">
                <span className="font-sans font-semibold text-slate-500">
                  চালান:
                </span>{' '}
                {normalizeChallanNo(form.challanNo)}
              </div>
              {form.new37Code && (
                <div className="font-mono-num">
                  <span className="font-sans font-semibold text-slate-500">
                    জমা কোড:
                  </span>{' '}
                  {form.new37Code}
                </div>
              )}
              <div className="font-mono-num">
                <span className="font-sans font-semibold text-slate-500">
                  টাকা:
                </span>{' '}
                ৳ {formatMoney(form.amount)} ·{' '}
                {normalizeChallanDate(form.challanDate) || form.challanDate || '—'}
              </div>
              {form.description.trim() && (
                <div>
                  <span className="font-semibold text-slate-500">মন্তব্য:</span>{' '}
                  <span className="whitespace-pre-line">
                    {stripEconomicCodeText(form.description.trim(), [
                      form.new37Code,
                      ...economicOptions.map((o) => o.code),
                    ])}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="min-h-[44px] rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 cursor-pointer"
              >
                বাতিল
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void executeSaveAndSync()}
                className="min-h-[44px] rounded-xl bg-rose-700 px-5 py-2 text-sm font-bold text-white hover:bg-rose-800 disabled:opacity-60 cursor-pointer"
              >
                সেভ করুন
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enhanced Live Camera Modal */}
      <QrScannerModal
        open={cameraOpen}
        targetLabel={`${selectedKhat.name} — ${
          scanRole === 'tax'
            ? 'আয়কর চালান'
            : scanRole === 'vat'
            ? 'ভ্যাট চালান'
            : 'মূল চালান'
        }`}
        onClose={() => setCameraOpen(false)}
        onDetected={handleLiveQrDetected}
        onPickFileFallback={() => fileInputRef.current?.click()}
      />
    </div>
  );
}



