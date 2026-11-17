import { useMemo, useState } from 'react';
import {
  Archive,
  CalendarCheck,
  CheckCircle2,
  CloudUpload,
  Download,
  FileSpreadsheet,
  Loader2,
  Pencil,
  Search,
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
import {
  CHALLAN_CATEGORIES,
  DEFAULT_SETTINGS,
  formatMoney,
  getOfficialVerificationUrl,
  maskDateInput,
  normalizeChallanNo,
  toEnglishDigits,
  toNumericValue,
} from '../utils/challan.ts';
import {
  deleteChallanFromGoogleSheet,
  getSheetPushCapability,
  pushRecordsToGoogleSheet,
  updateChallanInGoogleSheet,
} from '../services/googleSheets.ts';
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
  onRefresh: () => void;
}

type ToolTab = 'none' | 'dates' | 'import' | 'backups';

type PendingSheetOp =
  | { type: 'push'; records: ChallanRecord[] }
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
  onRefresh,
}: RecordsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('সব ক্যাটেগরি');
  const [groupByDealer, setGroupByDealer] = useState(false);
  const [activeTool, setActiveTool] = useState<ToolTab>('none');
  const [toolMessage, setToolMessage] = useState<{
    tone: 'success' | 'error' | 'neutral';
    text: string;
  } | null>(null);
  const [sheetPushBusy, setSheetPushBusy] = useState(false);
  const [pushingRowId, setPushingRowId] = useState<string | null>(null);
  const [pendingSheetOp, setPendingSheetOp] = useState<PendingSheetOp>(null);

  const [swapAmbiguous, setSwapAmbiguous] = useState(false);
  const [dateFixBusy, setDateFixBusy] = useState(false);

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

  const filteredRecords = useMemo(() => {
    const q = toEnglishDigits(searchQuery).trim().toLowerCase();
    const list = records.filter((r) => {
      const catOk =
        categoryFilter === 'সব ক্যাটেগরি' ||
        r.challanCategory === categoryFilter;
      if (!catOk) return false;
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

    if (groupByDealer) {
      return [...list].sort(
        (a, b) =>
          (a.dealerName || 'zzz').localeCompare(b.dealerName || 'zzz', 'bn') ||
          (a.challanDate || '').localeCompare(b.challanDate || '') ||
          a.serialNo - b.serialNo
      );
    }
    return list;
  }, [records, searchQuery, categoryFilter, groupByDealer]);

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

  async function runFixDates() {
    setDateFixBusy(true);
    setToolMessage(null);
    setPendingSheetOp(null);
    try {
      const res = await apiFetch('/api/maintenance/fix-dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swapAmbiguous }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'তারিখ সংশোধন ব্যর্থ হয়েছে');
      }
      setToolMessage({
        tone: 'success',
        text: json.message || 'তারিখ ফরম্যাট ঠিক করা হয়েছে।',
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
          r.challanDate,
          r.quantity,
          r.rate,
          r.expectedAmount || '',
          r.amount,
          r.incomeTaxChallanNo
            ? normalizeChallanNo(r.incomeTaxChallanNo)
            : '',
          r.incomeTaxDate || '',
          r.incomeTaxAmount || '',
          r.vatChallanNo ? normalizeChallanNo(r.vatChallanNo) : '',
          r.vatDate || '',
          r.vatAmount || '',
          r.doNo || '',
          r.doIssueDate || '',
          r.description || r.comment || '',
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
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Challan_Records.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
        setPendingSheetOp(null);
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
        setPendingSheetOp(null);
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
    setEditSaving(true);
    setPendingSheetOp(null);
    try {
      const res = await apiFetch(`/api/challans/${editingRecord.recordId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingRecord),
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
      setEditingRecord(null);
      setOriginalEditingRecord(null);
      onRefresh();

      const cap = getSheetPushCapability(settings);
      if (json.record && cap.anyReady) {
        try {
          const pushRes = await updateChallanInGoogleSheet(
            settings,
            json.record,
            prevSnapshot
          );
          setToolMessage({
            tone: 'success',
            text: ['চালান রেকর্ড আপডেট করা হয়েছে।', ...pushRes.notes].join(
              ' · '
            ),
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
          text: 'চালান রেকর্ড আপডেট করা হয়েছে।',
        });
      }
    } catch (err) {
      setToolMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'আপডেট ব্যর্থ হয়েছে।',
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
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
              <span>মোট সারি: {filteredRecords.length}টি</span>
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
                onClick={() => {
                  setToolMessage(null);
                  setPendingSheetOp(null);
                  setActiveTool(activeTool === 'dates' ? 'none' : 'dates');
                }}
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
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
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
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
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'backups'
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Archive className="h-3.5 w-3.5" />
              ব্যাকআপ আর্কাইভ
            </button>

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
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              CSV ডাউনলোড
            </button>
          </div>
        </div>

        {activeTool === 'dates' && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  চালান জমার তারিখ ফরম্যাট সংশোধন (dd/MM/yyyy)
                </h3>
                <p className="mt-1 text-xs text-slate-600">
                  টেক্সট বা yyyy-MM-dd তারিখগুলোকে dd/MM/yyyy ফরম্যাটে রূপান্তর
                  করে এবং পরিবর্তনের আগে ব্যাকআপে সংরক্ষণ করে।
                </p>
                <label className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={swapAmbiguous}
                    onChange={(e) => setSwapAmbiguous(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  আগে থেকে মাস/দিন উল্টে যাওয়া (MM/dd → dd/MM) তারিখও ঠিক করুন
                </label>
              </div>
              <button
                type="button"
                disabled={dateFixBusy}
                onClick={runFixDates}
                className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                {dateFixBusy ? 'চলছে...' : 'তারিখ ঠিক করুন'}
              </button>
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

            <button
              type="button"
              onClick={() => setGroupByDealer((prev) => !prev)}
              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                groupByDealer
                  ? 'border-rose-700 bg-rose-50 text-rose-800'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {groupByDealer
                ? 'ডিলার অনুযায়ী একসাথে সাজানো'
                : 'ডিলার অনুযায়ী সাজান'}
            </button>
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
                  <th className="px-3 py-2.5 whitespace-nowrap">খাত (Col D)</th>
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
                            {r.challanDate || r.date || '—'}
                          </div>
                          {r.doNo && (
                            <div className="font-mono-num mt-0.5 text-[10px] font-bold text-indigo-800">
                              ডিও: {r.doNo}
                              {r.doIssueDate ? ` (${r.doIssueDate})` : ''}
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
                            {r.incomeTaxDate || '—'}
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
                            {r.vatDate || '—'}
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

                    <td className="max-w-[200px] px-3 py-2.5">
                      <div className="text-xs font-semibold text-slate-800">
                        {r.challanCategory}
                        {r.licenseActionType ? ` (${r.licenseActionType})` : ''}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">
                        {r.new37Code ? `কোড: ${r.new37Code} · ` : ''}
                        {r.department || r.toOrganization || '—'}
                      </div>
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
                                setOriginalEditingRecord(r);
                                setEditingRecord({
                                  ...r,
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
            </div>

            <div className="mt-5 flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => {
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
