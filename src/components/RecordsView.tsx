import { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Archive,
  CalendarCheck,
  CheckCircle2,
  Cloud,
  CloudUpload,
  Download,
  FileSpreadsheet,
  Loader2,
  Pencil,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AppSettings,
  ChallanRecord,
  CustomRegisterColumn,
  DateBackupRecord,
  DuplicateBackupRecord,
  KhatConfig,
} from '../types.ts';
import { apiFetch } from '../utils/api.ts';
import { saveBlobFile } from '../utils/nativeExport.ts';
import {
  markRecordDeletedInVault,
  markRecordsSheetSyncedInVault,
  recordSavedInVault,
} from '../utils/localVault.ts';
import {
  CHALLAN_CATEGORIES,
  DEFAULT_SETTINGS,
  cleanChallanNo,
  countChallanBreakdown,
  extractEconomicCodeFromText,
  findChallanConflictInRecords,
  formatMoney,
  getChallanDepositSortKey,
  getChallanMonth,
  getOfficialVerificationUrl,
  maskDateInput,
  normalizeChallanDate,
  normalizeChallanNo,
  splitTaxDepartmentAndExtra,
  stripEconomicCodeText,
  toBengaliDigits,
  toEnglishDigits,
  toNumericValue,
} from '../utils/challan.ts';
import {
  cleanupDuplicatesInGoogleSheet,
  deleteChallanFromGoogleSheet,
  fixDatesViaAppsScript,
  getSheetPushCapability,
  pushRecordsToGoogleSheet,
  updateChallanInGoogleSheet,
} from '../services/googleSheets.ts';
import {
  deleteChallanFromFirestore,
  upsertChallanToFirestore,
} from '../services/firestoreSync.ts';
import { getGoogleAccessToken, googleSignIn } from '../services/googleAuth.ts';

interface RecordsViewProps {
  records: ChallanRecord[];
  loading: boolean;
  settings?: AppSettings;
  khats?: KhatConfig[];
  customColumns?: CustomRegisterColumn[];
  hideDealerIds?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canImport?: boolean;
  cloudUser?: User | null;
  cloudSyncing?: boolean;
  onConnectCloudBackup?: () => Promise<void>;
  onSyncFromSheetNow?: () => Promise<ChallanRecord[]>;
  onRefresh: () => void;
}

type ToolTab = 'none' | 'dates' | 'cleanup' | 'import' | 'backups';

interface CleanupPreviewData {
  totalRecords: number;
  duplicateRowsToRemove: number;
  junkValuesCleared: number;
  extShadowRows: number;
  alreadyBackedUp: number;
}

const BENGALI_MONTH_NAMES: Record<string, string> = {
  '01': 'জানুয়ারি (০১)',
  '02': 'ফেব্রুয়ারি (০২)',
  '03': 'মার্চ (০৩)',
  '04': 'এপ্রিল (০৪)',
  '05': 'মে (০৫)',
  '06': 'জুন (০৬)',
  '07': 'জুলাই (০৭)',
  '08': 'আগস্ট (০৮)',
  '09': 'সেপ্টেম্বর (০৯)',
  '10': 'অক্টোবর (১০)',
  '11': 'নভেম্বর (১১)',
  '12': 'ডিসেম্বর (১২)',
};

type PendingSheetOp =
  | { type: 'push'; records: ChallanRecord[] }
  | { type: 'dedupe' }
  | {
      type: 'update';
      record: ChallanRecord;
      previousRecord: ChallanRecord | null;
    }
  | { type: 'delete'; record: ChallanRecord }
  | null;

export function RecordsView({
  records,
  loading,
  settings = DEFAULT_SETTINGS,
  khats = [],
  customColumns = [],
  hideDealerIds = true,
  canEdit = true,
  canDelete = true,
  canImport = true,
  cloudUser = null,
  cloudSyncing = false,
  onConnectCloudBackup,
  onSyncFromSheetNow,
  onRefresh,
}: RecordsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('সব ক্যাটেগরি');
  const [monthFilter, setMonthFilter] = useState('সব মাস');
  const [sortMode, setSortMode] = useState<
    'date-asc' | 'date-desc' | 'serial' | 'dealer'
  >('serial');
  const [activeTool, setActiveTool] = useState<ToolTab>('none');
  const [toolMessage, setToolMessage] = useState<{
    tone: 'success' | 'error' | 'neutral';
    text: string;
  } | null>(null);
  const [sheetPushBusy, setSheetPushBusy] = useState(false);
  const [pushingRowId, setPushingRowId] = useState<string | null>(null);
  const [pendingSheetOp, setPendingSheetOp] = useState<PendingSheetOp>(null);

  const [swapAmbiguous, setSwapAmbiguous] = useState(false);
  const [sheetJulySeptOnly, setSheetJulySeptOnly] = useState(true);
  const [sortChronologicalOnFix, setSortChronologicalOnFix] = useState(true);
  const [dateFixBusy, setDateFixBusy] = useState(false);
  const [sortPersistBusy, setSortPersistBusy] = useState(false);

  const [cleanupPreviewBusy, setCleanupPreviewBusy] = useState(false);
  const [cleanupRunBusy, setCleanupRunBusy] = useState(false);
  const [cleanupPreview, setCleanupPreview] =
    useState<CleanupPreviewData | null>(null);

  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);

  const [duplicateBackups, setDuplicateBackups] = useState<
    DuplicateBackupRecord[]
  >([]);
  const [dateBackups, setDateBackups] = useState<DateBackupRecord[]>([]);

  const [editingRecord, setEditingRecord] = useState<ChallanRecord | null>(
    null
  );
  const [originalEditingRecord, setOriginalEditingRecord] =
    useState<ChallanRecord | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [deletingRecord, setDeletingRecord] = useState<ChallanRecord | null>(
    null
  );
  const [alsoDeleteFromSheet, setAlsoDeleteFromSheet] = useState(true);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const hasSheetTarget = Boolean(
    settings.spreadsheetId?.trim() || settings.gasWebAppUrl?.trim()
  );

  const categoryOptions = useMemo(() => {
    const dynamicNames = khats.map((k) => k.name);
    const existingNames = records.map((r) => r.challanCategory).filter(Boolean);
    return Array.from(
      new Set([...dynamicNames, ...existingNames, ...CHALLAN_CATEGORIES])
    );
  }, [khats, records]);

  const monthOptions = useMemo(() => {
    const months = new Set<string>();
    for (const r of records) {
      const m = getChallanMonth(r);
      if (m) months.add(m);
    }
    return Array.from(months).sort();
  }, [records]);

  const filteredRecords = useMemo(() => {
    const q = toEnglishDigits(searchQuery).trim().toLowerCase();
    const list = records.filter((r) => {
      const catOk =
        categoryFilter === 'সব ক্যাটেগরি' ||
        r.challanCategory === categoryFilter;
      if (!catOk) return false;
      if (monthFilter !== 'সব মাস' && getChallanMonth(r) !== monthFilter) {
        return false;
      }
      if (!q) return true;
      const hay = [
        r.challanNo,
        r.incomeTaxChallanNo,
        r.vatChallanNo,
        r.licenseNo,
        r.new37Code,
        r.dealerAllocationId,
        r.dealerName,
        r.unionName,
        r.department,
        r.toOrganization,
        r.submittedThrough,
        r.submittedOnBehalfOf,
        r.description,
        r.comment,
        r.doNo,
        r.challanDate,
        r.incomeTaxDate,
        r.vatDate,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    if (sortMode === 'dealer') {
      return [...list].sort(
        (a, b) =>
          (a.dealerName || 'zzz').localeCompare(b.dealerName || 'zzz', 'bn') ||
          getChallanDepositSortKey(a).localeCompare(getChallanDepositSortKey(b)) ||
          a.serialNo - b.serialNo
      );
    }
    if (sortMode === 'date-asc') {
      return [...list].sort(
        (a, b) =>
          getChallanDepositSortKey(a).localeCompare(getChallanDepositSortKey(b)) ||
          (a.challanNo || '').localeCompare(b.challanNo || '') ||
          a.serialNo - b.serialNo
      );
    }
    if (sortMode === 'date-desc') {
      return [...list].sort(
        (a, b) =>
          getChallanDepositSortKey(b).localeCompare(getChallanDepositSortKey(a)) ||
          (a.challanNo || '').localeCompare(b.challanNo || '') ||
          a.serialNo - b.serialNo
      );
    }
    return list;
  }, [records, searchQuery, categoryFilter, monthFilter, sortMode]);

  const totals = useMemo(() => {
    let amount = 0;
    let taxAmount = 0;
    let vatAmount = 0;
    let quantity = 0;
    for (const r of filteredRecords) {
      amount += toNumericValue(r.amount);
      taxAmount += toNumericValue(r.incomeTaxAmount);
      vatAmount += toNumericValue(r.vatAmount);
      quantity += toNumericValue(r.quantity);
    }
    return { amount, taxAmount, vatAmount, quantity };
  }, [filteredRecords]);

  const breakdown = useMemo(
    () => countChallanBreakdown(filteredRecords),
    [filteredRecords]
  );

  async function loadCleanupPreview() {
    setCleanupPreviewBusy(true);
    try {
      const res = await apiFetch('/api/maintenance/cleanup-preview');
      const json = (await res.json()) as {
        success: boolean;
        totalRecords?: number;
        duplicateRowsToRemove?: number;
        junkValuesCleared?: number;
        extShadowRows?: number;
        alreadyBackedUp?: number;
      };
      if (res.ok && json.success) {
        setCleanupPreview({
          totalRecords: json.totalRecords ?? 0,
          duplicateRowsToRemove: json.duplicateRowsToRemove ?? 0,
          junkValuesCleared: json.junkValuesCleared ?? 0,
          extShadowRows: json.extShadowRows ?? 0,
          alreadyBackedUp: json.alreadyBackedUp ?? 0,
        });
      }
    } catch {
      // ignore preview error
    } finally {
      setCleanupPreviewBusy(false);
    }
  }

  function openCleanupTool() {
    if (activeTool === 'cleanup') {
      setActiveTool('none');
      return;
    }
    setToolMessage(null);
    setPendingSheetOp(null);
    setActiveTool('cleanup');
    void loadCleanupPreview();
  }

  async function runDuplicateCleanup() {
    setCleanupRunBusy(true);
    setToolMessage(null);
    setPendingSheetOp(null);
    try {
      const res = await apiFetch('/api/maintenance/cleanup-duplicates', {
        method: 'POST',
      });
      const json = (await res.json()) as {
        success: boolean;
        removedCount?: number;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'ডুপ্লিকেট পরিষ্কার ব্যর্থ হয়েছে।');
      }

      const cap = getSheetPushCapability(settings);
      if (cap.anyReady) {
        try {
          const sheetRes = await cleanupDuplicatesInGoogleSheet(settings);
          setToolMessage({
            tone: 'success',
            text: [json.message, ...sheetRes.notes].filter(Boolean).join(' · '),
          });
        } catch (err) {
          setPendingSheetOp({ type: 'dedupe' });
          setToolMessage({
            tone: 'error',
            text: `অ্যাপে ডুপ্লিকেট পরিষ্কার হয়েছে, কিন্তু Google Sheet-এ পরিষ্কার হয়নি: ${
              err instanceof Error ? err.message : 'শিট পরিষ্কার ব্যর্থ'
            }`,
          });
        }
      } else if (hasSheetTarget) {
        setPendingSheetOp({ type: 'dedupe' });
        setToolMessage({
          tone: 'error',
          text: `${json.message || 'অ্যাপে পরিষ্কার হয়েছে।'} Google Sheet-এর বাড়তি কপিও মুছতে ডানের বাটনে Google সাইন-ইন করুন।`,
        });
      } else {
        setToolMessage({
          tone: 'success',
          text: json.message || 'ডুপ্লিকেট পরিষ্কার সম্পন্ন।',
        });
      }
      void loadCleanupPreview();
      onRefresh();
    } catch (err) {
      setToolMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'ডুপ্লিকেট পরিষ্কার ব্যর্থ।',
      });
    } finally {
      setCleanupRunBusy(false);
    }
  }

  async function runFixDates() {
    setDateFixBusy(true);
    setToolMessage(null);
    setPendingSheetOp(null);
    try {
      const res = await apiFetch('/api/maintenance/fix-dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          swapAmbiguous,
          sortOrder: sortChronologicalOnFix ? 'asc' : 'none',
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'তারিখ সংশোধন ব্যর্থ হয়েছে');
      }

      const notes: string[] = [
        json.message || 'অ্যাপ তারিখ ফরম্যাট ঠিক করা হয়েছে।',
      ];
      if (settings.gasWebAppUrl.trim()) {
        try {
          const gasRes = await fixDatesViaAppsScript(
            settings.gasWebAppUrl.trim(),
            {
              allowedMonths: sheetJulySeptOnly ? ['07', '09'] : undefined,
              sortOrder: sortChronologicalOnFix ? 'asc' : 'none',
            }
          );
          notes.push(`Google Sheet: ${gasRes.message}`);
        } catch (err) {
          notes.push(
            `Google Sheet সতর্কতা: ${
              err instanceof Error ? err.message : 'শিটের তারিখ সংশোধন ব্যর্থ'
            }`
          );
        }
      }

      setToolMessage({
        tone: 'success',
        text: notes.join(' · '),
      });
      onRefresh();
    } catch (err) {
      setToolMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'তারিখ সংশোধন ব্যর্থ হয়েছে।',
      });
    } finally {
      setDateFixBusy(false);
    }
  }

  async function runPersistSort(order: 'asc' | 'desc') {
    setSortPersistBusy(true);
    setToolMessage(null);
    setPendingSheetOp(null);
    try {
      const res = await apiFetch('/api/maintenance/sort-challans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'চালান সাজানো ব্যর্থ হয়েছে');
      }
      setSortMode(order === 'asc' ? 'date-asc' : 'date-desc');
      setToolMessage({
        tone: 'success',
        text: json.message || 'জমার তারিখ অনুযায়ী সাজানো সম্পন্ন।',
      });
      onRefresh();
    } catch (err) {
      setToolMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'চালান সাজানো ব্যর্থ হয়েছে।',
      });
    } finally {
      setSortPersistBusy(false);
    }
  }

  async function openBackupsTool() {
    if (activeTool === 'backups') {
      setActiveTool('none');
      return;
    }
    setActiveTool('backups');
    setToolMessage(null);
    setPendingSheetOp(null);
    try {
      const res = await apiFetch('/api/backups');
      const json = (await res.json()) as {
        success: boolean;
        duplicateBackups: DuplicateBackupRecord[];
        dateBackups: DateBackupRecord[];
      };
      if (res.ok && json.success) {
        setDuplicateBackups(json.duplicateBackups || []);
        setDateBackups(json.dateBackups || []);
      }
    } catch {
      setToolMessage({
        tone: 'error',
        text: 'ব্যাকআপ তালিকা লোড করা যায়নি।',
      });
    }
  }

  async function handleBulkImport() {
    const raw = importText.trim();
    if (!raw) {
      setToolMessage({
        tone: 'error',
        text: 'ইমপোর্ট করার জন্য Google Sheet থেকে কপি করা সারি পেস্ট করুন।',
      });
      return;
    }

    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const parsedRows: Array<Record<string, string>> = [];

    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].includes('\t')
        ? lines[i].split('\t')
        : lines[i].split(',');

      if (
        i === 0 &&
        (cols[0]?.includes('ক্রমিক') ||
          cols[0]?.toLowerCase() === 'id' ||
          cols[7]?.toLowerCase() === 'challanno' ||
          cols[7]?.includes('চালান'))
      ) {
        continue;
      }

      if (/^CHL-/i.test((cols[0] || '').trim()) && cols.length >= 12) {
        parsedRows.push({
          dealerAllocationId: (cols[6] || '').trim(),
          challanCategory: (cols[3] || '').trim() || 'খাদ্য বান্ধব',
          toOrganization: (cols[2] || '').trim(),
          challanNo: (cols[7] || '').trim(),
          challanDate: (cols[8] || '').trim(),
          rate: (cols[9] || '').trim(),
          quantity: (cols[10] || '').trim(),
          amount: (cols[11] || '').trim(),
          incomeTaxChallanNo: (cols[12] || '').trim(),
          incomeTaxDate: (cols[13] || '').trim(),
          incomeTaxAmount: (cols[14] || '').trim(),
          description: (cols[15] || '').trim(),
          entryTime: (cols[16] || '').trim(),
          recordId: (cols[17] || '').trim(),
        });
      } else if (cols.length >= 13) {
        parsedRows.push({
          unionName: (cols[1] || '').trim(),
          dealerName: (cols[2] || '').trim(),
          challanCategory: (cols[3] || '').trim() || 'মূল চালান',
          toOrganization: (cols[4] || '').trim(),
          submittedThrough: (cols[5] || '').trim(),
          submittedOnBehalfOf: (cols[6] || '').trim(),
          challanNo: (cols[7] || '').trim(),
          description: (cols[8] || '').trim(),
          quantity: (cols[9] || '').trim(),
          rate: (cols[10] || '').trim(),
          amount: (cols[11] || '').trim(),
          challanDate: (cols[12] || '').trim(),
          recordId: (cols[13] || '').trim(),
          pdfUrl: (cols[14] || '').trim(),
          entryTime: (cols[15] || '').trim(),
        });
      } else if (cols.length >= 9) {
        parsedRows.push({
          unionName: '',
          dealerName: '',
          challanCategory: 'মূল চালান',
          toOrganization: (cols[0] || '').trim(),
          submittedThrough: (cols[1] || '').trim(),
          submittedOnBehalfOf: (cols[2] || '').trim(),
          challanNo: (cols[3] || '').trim(),
          description: (cols[4] || '').trim(),
          quantity: (cols[5] || '').trim(),
          rate: (cols[6] || '').trim(),
          amount: (cols[7] || '').trim(),
          challanDate: (cols[8] || '').trim(),
          recordId: (cols[9] || '').trim(),
          pdfUrl: (cols[10] || '').trim(),
          entryTime: (cols[11] || '').trim(),
        });
      }
    }

    if (parsedRows.length === 0) {
      setToolMessage({
        tone: 'error',
        text: 'বৈধ কলাম ফরম্যাটে কোনো সারি পাওয়া যায়নি। Google Sheet থেকে সারি কপি করে পেস্ট করুন।',
      });
      return;
    }

    setImportBusy(true);
    setToolMessage(null);
    setPendingSheetOp(null);
    try {
      const res = await apiFetch('/api/challans/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: parsedRows }),
      });
      const json = (await res.json()) as {
        success: boolean;
        added?: number;
        skippedDuplicates?: number;
        skippedInvalid?: number;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'ইমপোর্ট ব্যর্থ হয়েছে');
      }
      setToolMessage({
        tone: 'success',
        text: `ইমপোর্ট সম্পন্ন: নতুন যোগ ${json.added ?? 0}টি, ডুপ্লিকেট বাদ ${
          json.skippedDuplicates ?? 0
        }টি, অকার্যকর ${json.skippedInvalid ?? 0}টি।`,
      });
      setImportText('');
      onRefresh();
      if (cloudUser?.uid && cloudUser.emailVerified && onConnectCloudBackup) {
        void onConnectCloudBackup();
      }
    } catch (err) {
      setToolMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'ইমপোর্ট ব্যর্থ হয়েছে।',
      });
    } finally {
      setImportBusy(false);
    }
  }

  function exportCsv() {
    const headers = [
      'ক্রমিক নং',
      'id',
      'ইউনিয়নের নাম / ঠিকানা',
      'ডিলার / লাইসেন্সধারীর নাম',
      'dealerAllocationId',
      'খাত (category)',
      'ধরণ (নতুন/নবায়ন)',
      'লাইসেন্স নং',
      'চালান কোড (New37)',
      'প্রতিষ্ঠান (department)',
      'যার মাধ্যমে জমা',
      'যার পক্ষে প্রদত্ত',
      'মূল চালান নম্বর (১১ অঙ্ক)',
      'মূল চালান তারিখ',
      'পরিমাণ (মে. টন)',
      'দর',
      'প্রাপ্য / নির্ধারিত টাকা',
      'মূল টাকা',
      'আয়কর চালান নম্বর (১১ অঙ্ক)',
      'আয়কর তারিখ',
      'আয়কর টাকা',
      'ভ্যাট চালান নম্বর (১১ অঙ্ক)',
      'ভ্যাট তারিখ',
      'ভ্যাট টাকা',
      'ডিও নং',
      'ডিও তারিখ',
      'বিবরণ / মন্তব্য',
      'রেকর্ড আইডি',
      'এন্ট্রি সময়',
      ...customColumns.map((c) => c.label),
    ];

    const escapeCsv = (val: unknown) =>
      `"${String(val ?? '').replace(/"/g, '""')}"`;

    const lines = [
      headers.map(escapeCsv).join(','),
      ...filteredRecords.map((r) =>
        [
          r.serialNo,
          r.id || '',
          r.unionName,
          r.dealerName,
          r.dealerAllocationId || '',
          r.challanCategory,
          r.licenseActionType || '',
          r.licenseNo || '',
          r.new37Code || '',
          r.department || r.toOrganization,
          r.submittedThrough,
          r.submittedOnBehalfOf,
          r.challanNo ? normalizeChallanNo(r.challanNo) : '',
          normalizeChallanDate(r.challanDate),
          r.quantity,
          r.rate,
          r.expectedAmount || '',
          r.amount,
          r.incomeTaxChallanNo
            ? normalizeChallanNo(r.incomeTaxChallanNo)
            : '',
          normalizeChallanDate(r.incomeTaxDate),
          r.incomeTaxAmount || '',
          r.vatChallanNo ? normalizeChallanNo(r.vatChallanNo) : '',
          normalizeChallanDate(r.vatDate),
          r.vatAmount || '',
          r.doNo || '',
          normalizeChallanDate(r.doIssueDate),
          stripEconomicCodeText(
            r.comment || r.description || '',
            [r.new37Code || '', r.taxCode || '', r.vatCode || ''].filter(
              Boolean
            )
          ),
          r.recordId,
          r.entryTime,
          ...customColumns.map((c) => r.customFields?.[c.id] || ''),
        ]
          .map(escapeCsv)
          .join(',')
      ),
    ];

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    void saveBlobFile(blob, 'Challan_Records.csv', 'text/csv;charset=utf-8').catch(
      (err) => {
        setToolMessage({
          tone: 'error',
          text:
            err instanceof Error ? err.message : 'CSV ডাউনলোড ব্যর্থ হয়েছে।',
        });
      }
    );
  }

  async function handlePushRecordsToSheet(
    targetRecords: ChallanRecord[],
    singleRowId?: string
  ) {
    if (singleRowId) {
      setPushingRowId(singleRowId);
    } else {
      setSheetPushBusy(true);
    }
    setToolMessage(null);
    setPendingSheetOp(null);
    try {
      const summary = await pushRecordsToGoogleSheet(settings, targetRecords);
      markRecordsSheetSyncedInVault(targetRecords.map((r) => r.recordId));
      onRefresh();
      setToolMessage({
        tone: 'success',
        text: `Google Sheet পুশ সম্পন্ন (${summary.total}টি): ${summary.notes.join(' · ')}`,
      });
    } catch (err) {
      setPendingSheetOp({ type: 'push', records: targetRecords });
      setToolMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Google Sheet পুশ ব্যর্থ হয়েছে।',
      });
    } finally {
      setPushingRowId(null);
      setSheetPushBusy(false);
    }
  }

  async function handleSignInAndRetrySheetOp() {
    const op = pendingSheetOp;
    if (!op && filteredRecords.length === 0) return;
    setSheetPushBusy(true);
    setToolMessage(null);
    try {
      if (!getGoogleAccessToken()) {
        await googleSignIn();
      }
      const effectiveSettings: AppSettings = {
        ...settings,
        syncMethod:
          settings.syncMethod === 'apps_script' ? 'both' : settings.syncMethod,
      };

      if (!op || op.type === 'push') {
        const target = op?.records || filteredRecords;
        const summary = await pushRecordsToGoogleSheet(effectiveSettings, target);
        markRecordsSheetSyncedInVault(target.map((r) => r.recordId));
        setPendingSheetOp(null);
        onRefresh();
        setToolMessage({
          tone: 'success',
          text: `Google Sheet পুশ সম্পন্ন (${summary.total}টি): ${summary.notes.join(' · ')}`,
        });
      } else if (op.type === 'update') {
        const summary = await updateChallanInGoogleSheet(
          effectiveSettings,
          op.record,
          op.previousRecord
        );
        markRecordsSheetSyncedInVault([op.record.recordId]);
        setPendingSheetOp(null);
        onRefresh();
        setToolMessage({
          tone: 'success',
          text: `Google Sheet আপডেট সম্পন্ন: ${summary.notes.join(' · ')}`,
        });
      } else if (op.type === 'delete') {
        const summary = await deleteChallanFromGoogleSheet(
          effectiveSettings,
          op.record
        );
        setPendingSheetOp(null);
        setToolMessage({
          tone: 'success',
          text: `Google Sheet থেকে মোছা সম্পন্ন: ${summary.notes.join(' · ')}`,
        });
      } else if (op.type === 'dedupe') {
        const summary = await cleanupDuplicatesInGoogleSheet(effectiveSettings);
        setPendingSheetOp(null);
        setToolMessage({
          tone: 'success',
          text: summary.notes.join(' · '),
        });
      }
    } catch (err) {
      setToolMessage({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Google Sheet অপারেশন ব্যর্থ হয়েছে।',
      });
    } finally {
      setSheetPushBusy(false);
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingRecord) return;
    setEditError(null);

    const rawMain = String(editingRecord.challanNo || '').trim();
    const rawTax = String(editingRecord.incomeTaxChallanNo || '').trim();
    const rawVat = String(editingRecord.vatChallanNo || '').trim();

    const cleanMain = rawMain ? cleanChallanNo(rawMain) : '';
    const cleanTax = rawTax ? cleanChallanNo(rawTax) : '';
    const cleanVat = rawVat ? cleanChallanNo(rawVat) : '';

    if (rawMain && !cleanMain) {
      setEditError(
        `মূল চালান নম্বর "${rawMain}" অবৈধ (কমপক্ষে ৫ অঙ্কের সঠিক চালান নম্বর দিন)।`
      );
      return;
    }
    if (rawTax && !cleanTax) {
      setEditError(
        `আয়কর চালান নম্বর "${rawTax}" অবৈধ (কমপক্ষে ৫ অঙ্কের সঠিক চালান নম্বর দিন)।`
      );
      return;
    }
    if (rawVat && !cleanVat) {
      setEditError(
        `ভ্যাট চালান নম্বর "${rawVat}" অবৈধ (কমপক্ষে ৫ অঙ্কের সঠিক চালান নম্বর দিন)।`
      );
      return;
    }

    let conflict = findChallanConflictInRecords(
      records,
      { main: cleanMain, tax: cleanTax, vat: cleanVat },
      editingRecord.recordId
    );
    if (conflict && onSyncFromSheetNow && settings.spreadsheetId.trim()) {
      const freshRecords = await onSyncFromSheetNow();
      conflict = findChallanConflictInRecords(
        freshRecords,
        { main: cleanMain, tax: cleanTax, vat: cleanVat },
        editingRecord.recordId
      );
    }
    if (conflict) {
      setEditError(conflict.message);
      return;
    }

    setEditSaving(true);
    setPendingSheetOp(null);
    try {
      const editCodes = [
        editingRecord.new37Code || '',
        editingRecord.taxCode || '',
        editingRecord.vatCode || '',
      ].filter(Boolean);
      const payload: ChallanRecord = {
        ...editingRecord,
        challanNo: cleanMain,
        incomeTaxChallanNo: cleanTax,
        vatChallanNo: cleanVat,
        challanDate: normalizeChallanDate(editingRecord.challanDate),
        incomeTaxDate: normalizeChallanDate(editingRecord.incomeTaxDate),
        vatDate: normalizeChallanDate(editingRecord.vatDate),
        doIssueDate: normalizeChallanDate(editingRecord.doIssueDate),
        comment: editingRecord.comment
          ? stripEconomicCodeText(editingRecord.comment, editCodes)
          : '',
        taxComment: editingRecord.taxComment
          ? stripEconomicCodeText(editingRecord.taxComment, editCodes)
          : '',
      };
      const res = await apiFetch(`/api/challans/${editingRecord.recordId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as {
        success: boolean;
        record?: ChallanRecord;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'আপডেট ব্যর্থ হয়েছে');
      }

      const prevSnapshot = originalEditingRecord;
      let cloudSynced = false;
      const cloudNotes: string[] = [];
      if (cloudUser?.uid && cloudUser.emailVerified && json.record) {
        try {
          await upsertChallanToFirestore(cloudUser.uid, json.record, settings);
          cloudSynced = true;
          cloudNotes.push('ক্লাউডে আপডেট হয়েছে');
        } catch {
          cloudNotes.push('ক্লাউড সিঙ্ক অপেক্ষমাণ');
        }
      }

      let sheetSynced = false;
      const cap = getSheetPushCapability(settings);
      if (json.record && cap.anyReady) {
        try {
          const pushRes = await updateChallanInGoogleSheet(
            settings,
            json.record,
            prevSnapshot
          );
          sheetSynced = true;
          setToolMessage({
            tone: 'success',
            text: [
              'চালান রেকর্ড আপডেট করা হয়েছে।',
              ...cloudNotes,
              ...pushRes.notes,
            ]
              .filter(Boolean)
              .join(' · '),
          });
        } catch (err) {
          setPendingSheetOp({
            type: 'update',
            record: json.record,
            previousRecord: prevSnapshot,
          });
          setToolMessage({
            tone: 'error',
            text: `অ্যাপে আপডেট হয়েছে, কিন্তু Google Sheet-এ পাঠানো যায়নি: ${
              err instanceof Error ? err.message : 'শিট আপডেট ব্যর্থ'
            }`,
          });
        }
      } else if (json.record && settings.spreadsheetId?.trim()) {
        setPendingSheetOp({
          type: 'update',
          record: json.record,
          previousRecord: prevSnapshot,
        });
        setToolMessage({
          tone: 'error',
          text: 'অ্যাপে আপডেট হয়েছে। Google Sheet-এও আপডেট করতে নিচের বাটনে ক্লিক করে Google সাইন-ইন করুন।',
        });
      } else {
        setToolMessage({
          tone: 'success',
          text: ['চালান রেকর্ড আপডেট করা হয়েছে।', ...cloudNotes]
            .filter(Boolean)
            .join(' · '),
        });
      }

      if (json.record) {
        recordSavedInVault(json.record, sheetSynced, cloudSynced);
      }

      setEditingRecord(null);
      setOriginalEditingRecord(null);
      setEditError(null);
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'আপডেট ব্যর্থ হয়েছে।';
      setEditError(msg);
      setToolMessage({
        tone: 'error',
        text: msg,
      });
    } finally {
      setEditSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deletingRecord) return;
    const target = deletingRecord;
    const shouldSyncSheet = alsoDeleteFromSheet && hasSheetTarget;
    setDeleteBusy(true);
    setPendingSheetOp(null);
    try {
      const res = await apiFetch(`/api/challans/${target.recordId}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'মুছে ফেলা যায়নি');
      }
      markRecordDeletedInVault(target.recordId);
      if (cloudUser?.uid && cloudUser.emailVerified) {
        try {
          await deleteChallanFromFirestore(cloudUser.uid, target.recordId);
        } catch {
          // non-fatal cloud deletion warning
        }
      }
      setDeletingRecord(null);
      onRefresh();

      if (shouldSyncSheet) {
        const cap = getSheetPushCapability(settings);
        if (!cap.anyReady) {
          setPendingSheetOp({ type: 'delete', record: target });
          setToolMessage({
            tone: 'error',
            text: 'অ্যাপ থেকে মুছে ফেলা হয়েছে। সংযুক্ত Google Sheet থেকেও সারিটি মুছতে নিচের বাটনে Google সাইন-ইন করুন।',
          });
        } else {
          try {
            const delRes = await deleteChallanFromGoogleSheet(settings, target);
            setToolMessage({
              tone: 'success',
              text: [
                'রেকর্ড মুছে ফেলা হয়েছে এবং ক্রমিক নং পুনর্গঠন করা হয়েছে।',
                ...delRes.notes,
              ].join(' · '),
            });
          } catch (err) {
            setPendingSheetOp({ type: 'delete', record: target });
            setToolMessage({
              tone: 'error',
              text: `অ্যাপ থেকে মোছা হয়েছে, কিন্তু Google Sheet থেকে মোছা যায়নি: ${
                err instanceof Error ? err.message : 'শিট ডিলিট ব্যর্থ'
              }`,
            });
          }
        }
      } else {
        setToolMessage({
          tone: 'success',
          text: 'রেকর্ড মুছে ফেলা হয়েছে এবং ক্রমিক নং পুনর্গঠন করা হয়েছে।',
        });
      }
    } catch (err) {
      setToolMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'মুছে ফেলা যায়নি।',
      });
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              সংরক্ষিত চালান রেকর্ড (Challan Ledger)
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 tabular-nums">
              <span className="font-bold text-slate-900">
                মোট চালান: {toBengaliDigits(breakdown.totalChallans)}টি
              </span>
              <span>
                (মূল চালান: {toBengaliDigits(breakdown.mainCount)} · আয়কর চালান:{' '}
                {toBengaliDigits(breakdown.taxCount)} · ভ্যাট চালান:{' '}
                {toBengaliDigits(breakdown.vatCount)} · সারি:{' '}
                {toBengaliDigits(breakdown.rowCount)})
              </span>
              <span aria-hidden="true">·</span>
              <span>পরিমাণ: {formatMoney(totals.quantity)} মে. টন</span>
              <span aria-hidden="true">·</span>
              <span>মূল: ৳ {formatMoney(totals.amount)}</span>
              <span aria-hidden="true">·</span>
              <span>আয়কর: ৳ {formatMoney(totals.taxAmount)}</span>
              <span aria-hidden="true">·</span>
              <span>ভ্যাট: ৳ {formatMoney(totals.vatAmount)}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <button
                type="button"
                onClick={openCleanupTool}
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTool === 'cleanup'
                    ? 'border-rose-700 bg-rose-700 text-white'
                    : 'border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100'
                }`}
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                ডুপ্লিকেট পরিষ্কার
              </button>
            )}

            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  setToolMessage(null);
                  setPendingSheetOp(null);
                  setActiveTool(activeTool === 'dates' ? 'none' : 'dates');
                }}
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTool === 'dates'
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <CalendarCheck className="h-3.5 w-3.5" />
                তারিখ ঠিক করুন
              </button>
            )}

            {canImport && (
              <button
                type="button"
                onClick={() => {
                  setToolMessage(null);
                  setPendingSheetOp(null);
                  setActiveTool(activeTool === 'import' ? 'none' : 'import');
                }}
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTool === 'import'
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Sheet ইমপোর্ট
              </button>
            )}

            <button
              type="button"
              onClick={openBackupsTool}
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTool === 'backups'
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Archive className="h-3.5 w-3.5" />
              ব্যাকআপ আর্কাইভ
            </button>

            {onConnectCloudBackup && (
              <button
                type="button"
                disabled={cloudSyncing}
                onClick={() => void onConnectCloudBackup()}
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  cloudUser?.emailVerified
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {cloudSyncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Cloud className="h-3.5 w-3.5" />
                )}
                {cloudUser?.emailVerified ? 'ক্লাউড সিঙ্ক' : 'ক্লাউড ব্যাকআপ'}
              </button>
            )}

            {canEdit && (
              <button
                type="button"
                disabled={sheetPushBusy || filteredRecords.length === 0}
                onClick={() => void handlePushRecordsToSheet(filteredRecords)}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-teal-700 px-3 py-2 text-xs font-bold text-white hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {sheetPushBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudUpload className="h-3.5 w-3.5" />
                )}
                শিটে পুশ ({filteredRecords.length})
              </button>
            )}

            <button
              type="button"
              onClick={exportCsv}
              disabled={filteredRecords.length === 0}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              CSV ডাউনলোড
            </button>
          </div>
        </div>

        {activeTool === 'cleanup' && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  ডুপ্লিকেট চালান ও অবৈধ &quot;11&quot; সারি পরিষ্কার (অ্যাপ + Google Sheet)
                </h3>
                <p className="mt-1 text-xs text-slate-600">
                  সম্পূর্ণ শিটের মূল, আয়কর ও ভ্যাট—এই তিনটি কলাম মিলিয়ে প্রতিটি চালান নম্বর কেবল একবার রাখা হবে। অতিরিক্ত কপি ও ch-ext সারিগুলো{' '}
                  <span className="font-mono-num font-semibold">
                    Challan_Duplicate_Backup
                  </span>
                  -এ নিরাপদে সরিয়ে ফেলা হবে।
                </p>
                {cleanupPreviewBusy ? (
                  <p className="mt-2 text-xs font-semibold text-slate-500">
                    হিসাব দেখা হচ্ছে...
                  </p>
                ) : (
                  cleanupPreview && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold tabular-nums">
                      <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-slate-700">
                        মোট সারি: {cleanupPreview.totalRecords}টি
                      </span>
                      <span className="rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-rose-800">
                        ডুপ্লিকেট বাদ যাবে: {cleanupPreview.duplicateRowsToRemove}টি
                      </span>
                      <span className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-amber-800">
                        অবৈধ &quot;11&quot; পরিষ্কার: {cleanupPreview.junkValuesCleared}টি
                      </span>
                      <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-slate-600">
                        অটো ch-ext সারি: {cleanupPreview.extShadowRows}টি
                      </span>
                    </div>
                  )
                )}
              </div>

              <button
                type="button"
                disabled={cleanupRunBusy}
                onClick={() => void runDuplicateCleanup()}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {cleanupRunBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldAlert className="h-3.5 w-3.5" />
                )}
                {cleanupRunBusy
                  ? 'পরিষ্কার হচ্ছে...'
                  : 'এখনই ডুপ্লিকেট পরিষ্কার করুন'}
              </button>
            </div>
          </div>
        )}

        {activeTool === 'dates' && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2">
                <h3 className="text-sm font-bold text-slate-900">
                  তারিখ ও ক্রম সংশোধন — অ্যাপ ও Google Sheet (yyyy-MM-dd)
                </h3>
                <p className="text-xs text-slate-600">
                  তারিখ ১২ বা তার কম হলে দিন/মাস উল্টে যাওয়ার সমস্যা সমাধান করে এবং সব তারিখ নিরাপদ বছর-মাস-তারিখ (yyyy-MM-dd) ফরম্যাটে সংরক্ষণ করে। পরিবর্তনের আগে সব মান ব্যাকআপে রাখা হয়।
                </p>
                <div className="flex flex-col gap-1.5 pt-1">
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={sheetJulySeptOnly}
                      onChange={(e) => setSheetJulySeptOnly(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Google Sheet-এ কেবল ০৭ (জুলাই) ও ০৯ (সেপ্টেম্বর) মাস রেখে উল্টে যাওয়া তারিখ (যেমন 2026-10-09 → 2026-09-10) ঠিক করুন
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={sortChronologicalOnFix}
                      onChange={(e) =>
                        setSortChronologicalOnFix(e.target.checked)
                      }
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    জমার তারিখ অনুযায়ী (পুরোনো → নতুন) সাজিয়ে ক্রমিক নম্বর হালনাগাদ করুন
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={swapAmbiguous}
                      onChange={(e) => setSwapAmbiguous(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    অ্যাপের ভেতরে আগে থেকে মাস/দিন উল্টে যাওয়া (yyyy-dd-MM → yyyy-MM-dd) তারিখও ঠিক করুন
                  </label>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={sortPersistBusy}
                  onClick={() => void runPersistSort('asc')}
                  className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {sortPersistBusy ? 'সাজানো হচ্ছে...' : 'তারিখ অনুযায়ী সাজান'}
                </button>
                <button
                  type="button"
                  disabled={dateFixBusy}
                  onClick={runFixDates}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {dateFixBusy ? 'চলছে...' : 'তারিখ ঠিক করুন'}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTool === 'import' && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-bold text-slate-900">
              Google Sheet (Challan A:R বা Challan_Records) থেকে সারি পেস্ট করে
              ইমপোর্ট
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              Google Sheet থেকে সারিগুলো কপি (Ctrl+C) করে নিচে পেস্ট করুন। নতুন
              Challan (A:R) ও পুরোনো ১৬/১২ কলাম—সব ফরম্যাটই সমর্থিত।
            </p>
            <textarea
              rows={4}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="Google Sheet থেকে কপি করা ট্যাব-সেপারেটেড (TSV) বা CSV ডেটা এখানে পেস্ট করুন..."
              className="mt-2.5 w-full rounded-xl border border-slate-300 bg-white p-3 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
            />
            <div className="mt-2.5 flex justify-end">
              <button
                type="button"
                disabled={importBusy}
                onClick={handleBulkImport}
                className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                {importBusy ? 'ইমপোর্ট হচ্ছে...' : 'ডেটাবেজে ইমপোর্ট করুন'}
              </button>
            </div>
          </div>
        )}

        {activeTool === 'backups' && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                ডুপ্লিকেট ব্যাকআপ (Challan_Duplicate_Backup) —{' '}
                {duplicateBackups.length}টি
              </h3>
              {duplicateBackups.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">
                  এখনো কোনো ডুপ্লিকেট চালান মুছে ব্যাকআপ করা হয়নি।
                </p>
              ) : (
                <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2">আগের সারি</th>
                        <th className="px-3 py-2">চালান নম্বর</th>
                        <th className="px-3 py-2">ডিলার</th>
                        <th className="px-3 py-2 text-right">টাকা</th>
                        <th className="px-3 py-2">মোছার সময়</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {duplicateBackups.map((b, i) => (
                        <tr key={`${b.recordId}-${i}`}>
                          <td className="font-mono-num px-3 py-2">
                            {b.originalRowNo}
                          </td>
                          <td className="font-mono-num px-3 py-2">
                            {b.challanNo}
                          </td>
                          <td className="px-3 py-2">{b.dealerName || '—'}</td>
                          <td className="font-mono-num px-3 py-2 text-right">
                            {formatMoney(b.amount)}
                          </td>
                          <td className="font-mono-num px-3 py-2 text-slate-500">
                            {new Date(b.deletedAt).toLocaleString('bn-BD')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <h3 className="text-sm font-bold text-slate-900">
                তারিখ সংশোধন ব্যাকআপ (Challan_Date_Backup) —{' '}
                {dateBackups.length}টি
              </h3>
              {dateBackups.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">
                  এখনো কোনো তারিখ পরিবর্তনের ব্যাকআপ নেই।
                </p>
              ) : (
                <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2">সারি</th>
                        <th className="px-3 py-2">চালান নম্বর</th>
                        <th className="px-3 py-2">আগের মান</th>
                        <th className="px-3 py-2">নতুন মান</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {dateBackups.map((d, i) => (
                        <tr key={`${d.challanNo}-${i}`}>
                          <td className="font-mono-num px-3 py-2">{d.rowNo}</td>
                          <td className="font-mono-num px-3 py-2">
                            {d.challanNo}
                          </td>
                          <td className="font-mono-num px-3 py-2">
                            {d.previousValue}
                          </td>
                          <td className="font-mono-num px-3 py-2">
                            {d.newValue}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {toolMessage && (
          <div
            role="status"
            className={`mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${
              toolMessage.tone === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : toolMessage.tone === 'error'
                  ? 'border-red-200 bg-red-50 text-red-900'
                  : 'border-slate-200 bg-slate-50 text-slate-800'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {toolMessage.tone === 'success' && (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              )}
              <span>{toolMessage.text}</span>
            </div>
            {toolMessage.tone === 'error' && pendingSheetOp && (
              <button
                type="button"
                disabled={sheetPushBusy}
                onClick={() => void handleSignInAndRetrySheetOp()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-teal-800 disabled:opacity-60 cursor-pointer shrink-0"
              >
                {sheetPushBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudUpload className="h-3.5 w-3.5" />
                )}
                {pendingSheetOp.type === 'delete'
                  ? 'Google সাইন-ইন করে শিট থেকে মুছুন'
                  : pendingSheetOp.type === 'update'
                    ? 'Google সাইন-ইন করে শিট আপডেট করুন'
                    : pendingSheetOp.type === 'dedupe'
                      ? 'Google সাইন-ইন করে শিট ডুপ্লিকেট মুছুন'
                      : 'Google সাইন-ইন করে শিটে পুশ করুন'}
              </button>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative flex-1 md:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="১১-অঙ্কের চালান, আয়কর চালান, ডিলার বা আইডি খুঁজুন..."
              className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none"
            >
              <option value="সব মাস">সব মাস</option>
              {monthOptions.map((m) => (
                <option key={m} value={m}>
                  {BENGALI_MONTH_NAMES[m] || `মাস (${m})`}
                </option>
              ))}
            </select>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none"
            >
              <option value="সব ক্যাটেগরি">সব খাত / ক্যাটেগরি</option>
              {categoryOptions.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>

            <select
              value={sortMode}
              onChange={(e) =>
                setSortMode(
                  e.target.value as
                    | 'serial'
                    | 'date-asc'
                    | 'date-desc'
                    | 'dealer'
                )
              }
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none"
            >
              <option value="serial">ক্রম: সংরক্ষিত সিরিয়াল</option>
              <option value="date-asc">তারিখ: পুরোনো → নতুন</option>
              <option value="date-desc">তারিখ: নতুন → পুরোনো</option>
              <option value="dealer">ডিলার অনুযায়ী</option>
            </select>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">
              রেকর্ড লোড হচ্ছে...
            </div>
          ) : filteredRecords.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-semibold text-slate-800">
                কোনো চালান রেকর্ড পাওয়া যায়নি
              </p>
              <p className="mt-1 text-xs text-slate-500">
                &ldquo;স্ক্যান ও এন্ট্রি&rdquo; থেকে নতুন চালান সংরক্ষণ করুন অথবা
                সেটিংস থেকে Google Sheet সিঙ্ক করুন।
              </p>
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-3 py-2.5 text-center whitespace-nowrap">
                    ক্রমিক
                  </th>
                  <th className="px-3 py-2.5 whitespace-nowrap">
                    মূল চালান (Col H-L)
                  </th>
                  <th className="px-3 py-2.5 whitespace-nowrap">
                    আয়কর ও ভ্যাট চালান
                  </th>
                  <th className="px-3 py-2.5 whitespace-nowrap">
                    {hideDealerIds
                      ? 'ডিলার / লাইসেন্সধারী'
                      : 'ডিলার / লাইসেন্সধারী ও আইডি'}
                  </th>
                  <th className="px-3 py-2.5 whitespace-nowrap">
                    প্রতিষ্ঠান ও বিবরণ
                  </th>
                  <th className="px-3 py-2.5 text-right whitespace-nowrap">
                    পরিমাণ (মে. টন)
                  </th>
                  <th className="px-3 py-2.5 text-right whitespace-nowrap">
                    টাকা (মূল / আয়কর / ভ্যাট)
                  </th>
                  {(canEdit || canDelete) && (
                    <th className="px-3 py-2.5 text-right whitespace-nowrap">
                      অ্যাকশন
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredRecords.map((r) => (
                  <tr
                    key={r.recordId}
                    className="transition-colors hover:bg-slate-50/80"
                  >
                    <td className="font-mono-num px-3 py-2.5 text-center text-xs text-slate-600">
                      {r.serialNo}
                    </td>

                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {r.challanNo ? (
                        <div>
                          <a
                            href={getOfficialVerificationUrl(r.challanNo)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono-num text-xs font-semibold text-teal-800 hover:underline"
                            title="সরকারি যাচাই পেজে দেখুন"
                          >
                            {normalizeChallanNo(r.challanNo)}
                          </a>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {normalizeChallanDate(r.challanDate || r.date) || '—'}
                          </div>
                          {r.doNo && (
                            <div className="font-mono-num mt-0.5 text-[10px] font-bold text-indigo-800">
                              ডিও: {r.doNo}
                              {r.doIssueDate
                                ? ` (${normalizeChallanDate(r.doIssueDate)})`
                                : ''}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 whitespace-nowrap space-y-1">
                      {r.incomeTaxChallanNo ? (
                        <div>
                          <a
                            href={getOfficialVerificationUrl(
                              r.incomeTaxChallanNo
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono-num text-xs font-semibold text-amber-800 hover:underline"
                            title="সরকারি যাচাই পেজে দেখুন"
                          >
                            আয়কর: {normalizeChallanNo(r.incomeTaxChallanNo)}
                          </a>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {normalizeChallanDate(r.incomeTaxDate) || '—'}
                          </div>
                        </div>
                      ) : null}
                      {r.vatChallanNo ? (
                        <div>
                          <a
                            href={getOfficialVerificationUrl(r.vatChallanNo)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono-num text-xs font-semibold text-indigo-800 hover:underline"
                            title="সরকারি যাচাই পেজে দেখুন"
                          >
                            ভ্যাট: {normalizeChallanNo(r.vatChallanNo)}
                          </a>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {normalizeChallanDate(r.vatDate) || '—'}
                          </div>
                        </div>
                      ) : null}
                      {!r.incomeTaxChallanNo && !r.vatChallanNo && (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="text-xs font-semibold text-slate-900">
                        {r.dealerName || '—'}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {r.unionName || (!hideDealerIds ? '' : r.licenseNo ? '' : '—')}
                        {r.licenseNo && (
                          <span className="font-mono-num">
                            {r.unionName ? ' · ' : ''}লাইঃ {r.licenseNo}
                          </span>
                        )}
                        {!hideDealerIds && !r.licenseNo && r.dealerAllocationId && (
                          <span className="font-mono-num">
                            {' '}
                            · {r.dealerAllocationId}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="max-w-[270px] px-3 py-2.5">
                      {(() => {
                        const mainCode =
                          String(r.new37Code || '').trim() ||
                          extractEconomicCodeFromText(
                            [r.toOrganization, r.department, r.description, r.comment]
                              .filter(Boolean)
                              .join(' ')
                          );
                        const mainOrg =
                          stripEconomicCodeText(
                            r.department || r.toOrganization || '',
                            mainCode
                          ) ||
                          r.department ||
                          r.toOrganization;
                        const hasTaxRow = Boolean(
                          r.incomeTaxChallanNo || toNumericValue(r.incomeTaxAmount) > 0
                        );
                        const hasVatRow = Boolean(
                          r.vatChallanNo || toNumericValue(r.vatAmount) > 0
                        );
                        const rawTaxOrg = r.taxDepartment || r.sourceMemo || '';
                        const taxSplit = splitTaxDepartmentAndExtra(
                          rawTaxOrg,
                          r.taxCode || r.vatCode || undefined
                        );
                        const resolvedTaxCode =
                          String(r.taxCode || '').trim() ||
                          taxSplit.code ||
                          (!r.challanNo ? mainCode : '');
                        const resolvedVatCode =
                          String(r.vatCode || '').trim() ||
                          taxSplit.code ||
                          (!r.challanNo && !r.incomeTaxChallanNo ? mainCode : '');
                        const cleanTaxOrg =
                          stripEconomicCodeText(
                            taxSplit.institution || rawTaxOrg,
                            resolvedTaxCode || resolvedVatCode
                          ) || 'কর অঞ্চল বরিশাল';

                        return (
                          <div className="space-y-1">
                            {(r.challanNo || (!hasTaxRow && !hasVatRow)) && (
                              <div>
                                {mainOrg && (
                                  <div className="text-[11px] font-medium text-slate-700">
                                    {mainOrg}
                                  </div>
                                )}
                                <div className="text-xs font-semibold text-slate-900">
                                  খাত: {r.challanCategory}
                                  {r.licenseActionType ? ` (${r.licenseActionType})` : ''}
                                </div>
                                {mainCode && (
                                  <div className="font-mono-num text-[11px] font-bold text-teal-800">
                                    কোড: {toBengaliDigits(mainCode)}
                                  </div>
                                )}
                              </div>
                            )}
                            {hasTaxRow && (
                              <div className={r.challanNo ? 'border-t border-slate-100 pt-1' : ''}>
                                <div className="text-[11px] font-medium text-slate-700">
                                  {cleanTaxOrg}
                                </div>
                                <div className="text-xs font-semibold text-amber-900">
                                  খাত: আয়কর
                                </div>
                                {resolvedTaxCode && (
                                  <div className="font-mono-num text-[11px] font-bold text-amber-800">
                                    কোড: {toBengaliDigits(resolvedTaxCode)}
                                  </div>
                                )}
                              </div>
                            )}
                            {hasVatRow && (
                              <div
                                className={
                                  r.challanNo || hasTaxRow
                                    ? 'border-t border-slate-100 pt-1'
                                    : ''
                                }
                              >
                                <div className="text-[11px] font-medium text-slate-700">
                                  {cleanTaxOrg || 'ভ্যাট'}
                                </div>
                                <div className="text-xs font-semibold text-indigo-900">
                                  খাত: ভ্যাট
                                </div>
                                {resolvedVatCode && (
                                  <div className="font-mono-num text-[11px] font-bold text-indigo-800">
                                    কোড: {toBengaliDigits(resolvedVatCode)}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    <td className="font-mono-num px-3 py-2.5 text-right text-xs text-slate-700">
                      {r.quantity ? formatMoney(r.quantity) : '0.00'}
                    </td>

                    <td className="font-mono-num px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="text-xs font-bold text-slate-900">
                        ৳ {formatMoney(r.amount)}
                      </div>
                      {toNumericValue(r.incomeTaxAmount) > 0 && (
                        <div className="text-[11px] font-semibold text-amber-800">
                          আয়কর: ৳ {formatMoney(r.incomeTaxAmount)}
                        </div>
                      )}
                      {toNumericValue(r.vatAmount) > 0 && (
                        <div className="text-[11px] font-semibold text-indigo-800">
                          ভ্যাট: ৳ {formatMoney(r.vatAmount)}
                        </div>
                      )}
                    </td>

                    {(canEdit || canDelete) && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {canEdit && (
                            <button
                              type="button"
                              disabled={pushingRowId === r.recordId}
                              onClick={() => void handlePushRecordsToSheet([r], r.recordId)}
                              title="এই সারি Google Sheet-এ পুশ করুন"
                              aria-label="শিটে পুশ"
                              className="rounded-md p-1.5 text-teal-700 hover:bg-teal-50 disabled:opacity-50 cursor-pointer"
                            >
                              {pushingRowId === r.recordId ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CloudUpload className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditError(null);
                                setOriginalEditingRecord(r);
                                setEditingRecord({
                                  ...r,
                                  challanDate: normalizeChallanDate(r.challanDate),
                                  incomeTaxDate: normalizeChallanDate(
                                    r.incomeTaxDate
                                  ),
                                  vatDate: normalizeChallanDate(r.vatDate),
                                  doIssueDate: normalizeChallanDate(r.doIssueDate),
                                  customFields: { ...(r.customFields || {}) },
                                });
                              }}
                              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                              aria-label="সম্পাদনা"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => {
                                setAlsoDeleteFromSheet(hasSheetTarget);
                                setDeletingRecord(r);
                              }}
                              className="rounded-md p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700 cursor-pointer"
                              aria-label="মুছে ফেলুন"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {editingRecord && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={handleSaveEdit}
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  চালান রেকর্ড সম্পাদনা — ক্রমিক {editingRecord.serialNo}
                </h3>
                {getSheetPushCapability(settings).anyReady && (
                  <p className="mt-0.5 text-[11px] font-medium text-teal-700">
                    সংরক্ষণ করলে সংযুক্ত Google Sheet-এও স্বয়ংক্রিয়ভাবে আপডেট হবে
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditError(null);
                  setEditingRecord(null);
                  setOriginalEditingRecord(null);
                }}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ইউনিয়নের নাম
                </label>
                <input
                  type="text"
                  value={editingRecord.unionName}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      unionName: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ডিলারের নাম
                </label>
                <input
                  type="text"
                  value={editingRecord.dealerName}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      dealerName: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ডিলার / বরাদ্দ আইডি (Col G)
                </label>
                <input
                  type="text"
                  value={editingRecord.dealerAllocationId || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      dealerAllocationId: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  খাত / ক্যাটেগরি (Col D)
                </label>
                <select
                  value={editingRecord.challanCategory}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      challanCategory: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ধরণ (নতুন / নবায়ন / জরিমানা)
                </label>
                <select
                  value={editingRecord.licenseActionType || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      licenseActionType: e.target
                        .value as ChallanRecord['licenseActionType'],
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">সাধারণ / নির্ধারিত নয়</option>
                  <option value="নতুন">নতুন</option>
                  <option value="নবায়ন">নবায়ন</option>
                  <option value="জরিমানা">জরিমানা</option>
                  <option value="অন্যান্য">অন্যান্য</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  সরকারি প্রতিষ্ঠানের অনুকূলে জমা (Col C)
                </label>
                <input
                  type="text"
                  value={
                    editingRecord.department || editingRecord.toOrganization
                  }
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      department: e.target.value,
                      toOrganization: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  আয়কর / ভ্যাট প্রতিষ্ঠান ও বিবরণ (Col E)
                </label>
                <input
                  type="text"
                  value={
                    editingRecord.taxDepartment ?? editingRecord.sourceMemo ?? ''
                  }
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      taxDepartment: e.target.value,
                      sourceMemo: e.target.value,
                    })
                  }
                  placeholder="যেমন: কর অঞ্চল / ভ্যাট অফিসের নাম"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  মূল চালান নম্বর (১১ অঙ্ক — Col H)
                </label>
                <input
                  type="text"
                  value={editingRecord.challanNo}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      challanNo: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  মূল চালানের তারিখ (Col I)
                </label>
                <input
                  type="text"
                  maxLength={10}
                  placeholder="yyyy-MM-dd"
                  value={editingRecord.challanDate}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      challanDate: maskDateInput(e.target.value),
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  পরিমাণ (মে. টন — Col K)
                </label>
                <input
                  type="text"
                  value={editingRecord.quantity}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      quantity: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  দর (Col J)
                </label>
                <input
                  type="text"
                  value={editingRecord.rate}
                  onChange={(e) =>
                    setEditingRecord({ ...editingRecord, rate: e.target.value })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  মূল টাকা (৳ — Col L)
                </label>
                <input
                  type="text"
                  value={editingRecord.amount}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      amount: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  আয়কর চালান নম্বর (১১ অঙ্ক — Col M)
                </label>
                <input
                  type="text"
                  value={editingRecord.incomeTaxChallanNo || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      incomeTaxChallanNo: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  আয়কর তারিখ (Col N)
                </label>
                <input
                  type="text"
                  maxLength={10}
                  placeholder="yyyy-MM-dd"
                  value={editingRecord.incomeTaxDate || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      incomeTaxDate: maskDateInput(e.target.value),
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  আয়কর টাকা (৳ — Col O)
                </label>
                <input
                  type="text"
                  value={editingRecord.incomeTaxAmount || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      incomeTaxAmount: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ভ্যাট চালান নম্বর (১১ অঙ্ক — Col S)
                </label>
                <input
                  type="text"
                  value={editingRecord.vatChallanNo || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      vatChallanNo: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ভ্যাট তারিখ (Col T)
                </label>
                <input
                  type="text"
                  maxLength={10}
                  placeholder="yyyy-MM-dd"
                  value={editingRecord.vatDate || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      vatDate: maskDateInput(e.target.value),
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ভ্যাট টাকা (৳ — Col U)
                </label>
                <input
                  type="text"
                  value={editingRecord.vatAmount || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      vatAmount: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  লাইসেন্স নম্বর (Col V)
                </label>
                <input
                  type="text"
                  value={editingRecord.licenseNo || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      licenseNo: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  চালান কোড / New37 (Col W)
                </label>
                <input
                  type="text"
                  value={editingRecord.new37Code || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      new37Code: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  আয়কর কোড (Col Z)
                </label>
                <input
                  type="text"
                  value={editingRecord.taxCode || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      taxCode: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ভ্যাট কোড (Col AA)
                </label>
                <input
                  type="text"
                  value={editingRecord.vatCode || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      vatCode: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ডিও নম্বর (DO No)
                </label>
                <input
                  type="text"
                  value={editingRecord.doNo || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      doNo: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ডিও তারিখ (DO Date)
                </label>
                <input
                  type="text"
                  maxLength={10}
                  placeholder="yyyy-MM-dd"
                  value={editingRecord.doIssueDate || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      doIssueDate: maskDateInput(e.target.value),
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  প্রাপ্য / নির্ধারিত টাকা (৳)
                </label>
                <input
                  type="text"
                  value={editingRecord.expectedAmount || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      expectedAmount: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  প্রাপ্য আয়কর (৳)
                </label>
                <input
                  type="text"
                  value={editingRecord.expectedTaxAmount || ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      expectedTaxAmount: e.target.value,
                    })
                  }
                  className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              {customColumns.map((col) => (
                <div key={col.id}>
                  <label className="mb-1 block text-xs font-semibold text-slate-600">
                    {col.label} (Col {col.sheetColumn})
                  </label>
                  <input
                    type="text"
                    value={editingRecord.customFields?.[col.id] || ''}
                    onChange={(e) =>
                      setEditingRecord({
                        ...editingRecord,
                        customFields: {
                          ...(editingRecord.customFields || {}),
                          [col.id]: e.target.value,
                        },
                      })
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              ))}

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  বিবরণ
                </label>
                <textarea
                  rows={2}
                  value={editingRecord.description}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      description: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  মন্তব্য (Sheet Col P)
                </label>
                <textarea
                  rows={2}
                  value={editingRecord.comment ?? editingRecord.description ?? ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      comment: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  আয়কর ও ভ্যাটের মন্তব্য (Sheet Col Q)
                </label>
                <textarea
                  rows={2}
                  value={editingRecord.taxComment ?? ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      taxComment: e.target.value,
                    })
                  }
                  placeholder="আয়কর বা ভ্যাট চালানের আলাদা মন্তব্য"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  কর/ভ্যাট অতিরিক্ত বিবরণ (Sheet Col Y)
                </label>
                <input
                  type="text"
                  value={editingRecord.taxExtra ?? ''}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      taxExtra: e.target.value,
                    })
                  }
                  placeholder="কর অঞ্চল বরিশালের পরের অংশ (মন্তব্যের নিচে দেখাবে)"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>

            {editError && (
              <div
                role="alert"
                className="mt-4 rounded-xl border border-red-300 bg-red-50 px-3.5 py-2.5 text-xs font-bold text-red-900"
              >
                {editError}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => {
                  setEditError(null);
                  setEditingRecord(null);
                  setOriginalEditingRecord(null);
                }}
                className="min-h-[42px] rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                বাতিল
              </button>
              <button
                type="submit"
                disabled={editSaving}
                className="min-h-[42px] rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {editSaving ? 'সংরক্ষণ হচ্ছে...' : 'পরিবর্তন সংরক্ষণ'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deletingRecord && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5">
            <h3 className="text-base font-bold text-slate-900">
              রেকর্ড মুছে ফেলার নিশ্চিতকরণ
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              আপনি কি নিশ্চিতভাবে চালান নম্বর{' '}
              <span className="font-mono-num font-semibold text-slate-900">
                {deletingRecord.challanNo ||
                  deletingRecord.incomeTaxChallanNo ||
                  deletingRecord.vatChallanNo}
              </span>{' '}
              (ক্রমিক {deletingRecord.serialNo}) মুছে ফেলতে চান?
            </p>
            {hasSheetTarget && (
              <label className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs font-semibold text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={alsoDeleteFromSheet}
                  onChange={(e) => setAlsoDeleteFromSheet(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>সংযুক্ত Google Sheet থেকেও এই সারিটি মুছে ফেলুন</span>
              </label>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeletingRecord(null)}
                className="min-h-[42px] rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                বাতিল
              </button>
              <button
                type="button"
                disabled={deleteBusy}
                onClick={confirmDelete}
                className="min-h-[42px] rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {deleteBusy ? 'মুছছে...' : 'হ্যাঁ, মুছে ফেলুন'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



