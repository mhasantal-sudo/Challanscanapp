import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CloudUpload,
  Code2,
  Coins,
  Copy,
  Database,
  Download,
  FileText,
  ImagePlus,
  Italic,
  KeyRound,
  LayoutTemplate,
  Loader2,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  TableProperties,
  Trash2,
  Underline,
  Unlock,
  Upload,
  UserCheck,
  Wheat,
} from 'lucide-react';
import type {
  AppSettings,
  ChallanRecord,
  CustomRegisterColumn,
  KhatColorKey,
  KhatConfig,
  KhatGroup,
  KhatIconKey,
  LicenseFeeConfig,
  ReportTemplate,
  TemplateEditableFieldsConfig,
} from '../types.ts';
import { apiFetch, setAuthToken } from '../utils/api.ts';
import { saveBlobFile } from '../utils/nativeExport.ts';
import {
  DEFAULT_LICENSE_FEES,
  extractSpreadsheetId,
} from '../utils/challan.ts';
import { googleLogout, googleSignIn } from '../services/googleAuth.ts';
import {
  cleanupDuplicatesInGoogleSheet,
  generateExternalAndroidSheetGuardCode,
  generateGoogleAppsScriptCode,
  getSheetPushCapability,
  pullFromAppsScriptBridge,
  pullFromGoogleSheetsOAuth,
  pullFromPublicSheetBackend,
  pushRecordsToGoogleSheet,
} from '../services/googleSheets.ts';
import {
  loadLocalVault,
  reconcileSheetRemovedIdsInVault,
} from '../utils/localVault.ts';
import { deleteChallanFromFirestore } from '../services/firestoreSync.ts';
import { renderKhatIcon } from './CategoryHub.tsx';

export type SettingsSectionKey =
  | 'sync'
  | 'office'
  | 'templates'
  | 'khats'
  | 'fees'
  | 'backup';

interface SettingsViewProps {
  settings: AppSettings;
  templates?: ReportTemplate[];
  initialSection?: SettingsSectionKey;
  googleUser: User | null;
  hasGoogleToken: boolean;
  onSaveSettings: (next: AppSettings) => Promise<void>;
  onSyncedFromSheet: () => void;
  onRefreshTemplates?: () => void;
  onOpenDealersManager: () => void;
}

const ICON_OPTIONS: Array<{ value: KhatIconKey; label: string }> = [
  { value: 'wheat', label: 'খাদ্যশস্য' },
  { value: 'bag', label: 'ব্যাগ / ওএমএস' },
  { value: 'flame', label: 'ইপি / জরুরি' },
  { value: 'license', label: 'লাইসেন্স' },
  { value: 'refresh', label: 'নবায়ন' },
  { value: 'alert', label: 'জরিমানা' },
  { value: 'receipt', label: 'চালান রসিদ' },
  { value: 'shield', label: 'ভেরিফিকেশন' },
];

const COLOR_OPTIONS: Array<{ value: KhatColorKey; label: string }> = [
  { value: 'rose', label: 'গোলাপি' },
  { value: 'sky', label: 'নীল' },
  { value: 'indigo', label: 'ইন্ডিগো' },
  { value: 'purple', label: 'বেগুনি' },
  { value: 'amber', label: 'সোনালি' },
  { value: 'orange', label: 'কমলা' },
  { value: 'teal', label: 'টিল' },
  { value: 'emerald', label: 'সবুজ' },
  { value: 'red', label: 'লাল' },
];

const SETTINGS_MENU: Array<{
  key: SettingsSectionKey;
  label: string;
  desc: string;
  icon: typeof RefreshCw;
  accent: string;
}> = [
  {
    key: 'sync',
    label: 'সংযোগ ও শিট',
    desc: 'Google Sheet ও সিঙ্ক',
    icon: RefreshCw,
    accent: 'text-rose-700 bg-rose-50 border-rose-200',
  },
  {
    key: 'office',
    label: 'কার্যালয় ও স্বাক্ষর',
    desc: 'অফিস তথ্য ও PNG স্বাক্ষর',
    icon: Building2,
    accent: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  },
  {
    key: 'templates',
    label: 'টেমপ্লেট এডিটর',
    desc: '.docx ও ফর্ম পারমিশন',
    icon: LayoutTemplate,
    accent: 'text-teal-700 bg-teal-50 border-teal-200',
  },
  {
    key: 'khats',
    label: 'খাত ও ক্যাটেগরি',
    desc: 'খাদ্যশস্য ও লাইসেন্স খাত',
    icon: Wheat,
    accent: 'text-amber-700 bg-amber-50 border-amber-200',
  },
  {
    key: 'fees',
    label: 'ফি ও শিট কলাম',
    desc: 'লাইসেন্স ফি ও X/Y কলাম',
    icon: Coins,
    accent: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  },
  {
    key: 'backup',
    label: 'ব্যাকআপ ও সোর্স',
    desc: 'ডিলার ও সোর্স ডাউনলোড',
    icon: Code2,
    accent: 'text-slate-700 bg-slate-100 border-slate-300',
  },
];

const DEFAULT_MASTER_HTML = `<div style="text-align:center;font-weight:bold;">
  <div style="font-size:16px;">গণপ্রজাতন্ত্রী বাংলাদেশ সরকার</div>
  <div style="font-size:14px;">{{অফিস}}</div>
</div>
<div style="display:flex;justify-content:space-between;margin:10px 0;font-size:13px;">
  <span>স্মারক নং: {{স্মারক}}</span>
  <span>তারিখ: {{তারিখ}}</span>
</div>
<p><strong>বরাবর:</strong> {{প্রাপক}}</p>
<p><strong>বিষয়:</strong> মাসিক প্রতিবেদন / প্রত্যয়নপত্র।</p>
<table>
  <thead>
    <tr>
      <th>ক্রমিক</th>
      <th>বিবরণ</th>
      <th>পরিমাণ</th>
      <th>টাকা</th>
      <th>মন্তব্য</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>১</td>
      <td>&nbsp;</td>
      <td>&nbsp;</td>
      <td>&nbsp;</td>
      <td>&nbsp;</td>
    </tr>
  </tbody>
</table>
<div style="margin-top:28px;text-align:right;">{{স্বাক্ষর}}</div>`;

export function SettingsView({
  settings,
  templates = [],
  initialSection = 'sync',
  googleUser,
  hasGoogleToken,
  onSaveSettings,
  onSyncedFromSheet,
  onRefreshTemplates,
  onOpenDealersManager,
}: SettingsViewProps) {
  const [activeSection, setActiveSection] =
    useState<SettingsSectionKey>(initialSection);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  const [draft, setDraft] = useState<AppSettings>({
    ...settings,
    allowedEmails:
      settings.allowedEmails && settings.allowedEmails.length > 0
        ? settings.allowedEmails
        : ['foodchannelregister@gmail.com'],
    hideDealerIds:
      typeof settings.hideDealerIds === 'boolean'
        ? settings.hideDealerIds
        : true,
    doIssueTabName: settings.doIssueTabName || 'DO_Issue',
    licenseFees:
      settings.licenseFees && settings.licenseFees.length > 0
        ? settings.licenseFees
        : DEFAULT_LICENSE_FEES,
    customColumns: settings.customColumns || [],
    lockEnabled: Boolean(settings.lockEnabled),
  });

  useEffect(() => {
    setDraft({
      ...settings,
      allowedEmails:
        settings.allowedEmails && settings.allowedEmails.length > 0
          ? settings.allowedEmails
          : ['foodchannelregister@gmail.com'],
      hideDealerIds:
        typeof settings.hideDealerIds === 'boolean'
          ? settings.hideDealerIds
          : true,
      doIssueTabName: settings.doIssueTabName || 'DO_Issue',
      licenseFees:
        settings.licenseFees && settings.licenseFees.length > 0
          ? settings.licenseFees
          : DEFAULT_LICENSE_FEES,
      customColumns: settings.customColumns || [],
      lockEnabled: Boolean(settings.lockEnabled),
    });
  }, [settings]);

  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pushingAll, setPushingAll] = useState(false);
  const [cleaningSheet, setCleaningSheet] = useState(false);
  const [showGasGuide, setShowGasGuide] = useState(
    !settings.gasWebAppUrl?.trim()
  );
  const [gasCopied, setGasCopied] = useState(false);
  const [showAndroidGuardGuide, setShowAndroidGuardGuide] = useState(false);
  const [androidGuardCopied, setAndroidGuardCopied] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [downloadingSource, setDownloadingSource] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [copiedWorkflow, setCopiedWorkflow] = useState<'extract' | 'apk' | null>(
    null
  );
  const [lockPasswordInput, setLockPasswordInput] = useState('');
  const [lockBusy, setLockBusy] = useState(false);
  const [lockMsg, setLockMsg] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  const [newEmailInput, setNewEmailInput] = useState('');

  // Master Word Template Editor states
  const [tplId, setTplId] = useState('');
  const [tplTitle, setTplTitle] = useState('');
  const [tplCategory, setTplCategory] = useState('রিপোর্ট');
  const [tplDefaultMemo, setTplDefaultMemo] = useState('১৩.০১.০৬৮৬.০০০.০০.০০১.২৬-');
  const [tplDefaultRecipient, setTplDefaultRecipient] = useState(
    'জেলা খাদ্য নিয়ন্ত্রক'
  );
  const [tplOrientation, setTplOrientation] = useState<'portrait' | 'landscape'>(
    'portrait'
  );
  const [tplEditableFields, setTplEditableFields] =
    useState<TemplateEditableFieldsConfig>({
      allowDate: true,
      allowMemo: true,
      allowRecipient: true,
      allowTableEdit: true,
    });
  const [tplHtmlContent, setTplHtmlContent] = useState(DEFAULT_MASTER_HTML);
  const [tplSaving, setTplSaving] = useState(false);
  const [tplUploading, setTplUploading] = useState(false);

  const masterEditorRef = useRef<HTMLDivElement | null>(null);
  const docxInputRef = useRef<HTMLInputElement | null>(null);
  const sigImgInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (activeSection === 'templates' && masterEditorRef.current) {
      masterEditorRef.current.innerHTML = tplHtmlContent || DEFAULT_MASTER_HTML;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, tplId]);

  const [newKhatName, setNewKhatName] = useState('');
  const [newKhatGroup, setNewKhatGroup] = useState<KhatGroup>('grain');
  const [newKhatIcon, setNewKhatIcon] = useState<KhatIconKey>('wheat');
  const [newKhatColor, setNewKhatColor] = useState<KhatColorKey>('rose');
  const [newKhatHasTax, setNewKhatHasTax] = useState(true);
  const [newKhatHasVat, setNewKhatHasVat] = useState(false);
  const [newKhatShowQty, setNewKhatShowQty] = useState(true);

  const [newColLabel, setNewColLabel] = useState('');
  const [newColLetter, setNewColLetter] = useState('X');
  const [newColGrain, setNewColGrain] = useState(false);
  const [newColLicense, setNewColLicense] = useState(true);

  const [statusMsg, setStatusMsg] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  async function handleSaveAll(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      await onSaveSettings(draft);
      setStatusMsg({
        tone: 'success',
        text: 'সেটিংস, লাইসেন্স মূল্য ও কলাম কনফিগারেশন সংরক্ষিত হয়েছে।',
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'সেটিংস সংরক্ষণ ব্যর্থ।',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleGoogleLogin() {
    setAuthBusy(true);
    setStatusMsg(null);
    try {
      const res = await googleSignIn();
      if (res) {
        setStatusMsg({
          tone: 'success',
          text: `${res.user.email || 'Google'} সংযুক্ত হয়েছে।`,
        });
      }
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Google সাইন-ইন সম্পন্ন করা যায়নি।',
      });
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleGoogleSignOut() {
    await googleLogout();
    setStatusMsg({
      tone: 'success',
      text: 'Google অ্যাকাউন্ট থেকে সাইন-আউট করা হয়েছে।',
    });
  }

  async function syncCleanupRemovedIds(removedIds?: string[]) {
    if (!removedIds || removedIds.length === 0) return;
    reconcileSheetRemovedIdsInVault(removedIds);
    if (googleUser?.uid && googleUser.emailVerified) {
      await Promise.allSettled(
        removedIds.map((rid) => deleteChallanFromFirestore(googleUser.uid, rid))
      );
    }
  }

  async function handleSyncPublicSheet() {
    setSyncing(true);
    setStatusMsg(null);
    try {
      await onSaveSettings(draft);
      const res = await pullFromPublicSheetBackend(draft);
      await syncCleanupRemovedIds(res.counts?.removedIds);
      onSyncedFromSheet();
      setStatusMsg({
        tone: 'success',
        text:
          res.message ||
          `সিঙ্ক সম্পন্ন: ডিলার ${res.counts?.dealers ?? 0}, উপ-বরাদ্দ ${
            res.counts?.suballocations ?? 0
          }, চালান ${res.counts?.records ?? 0}`,
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Google Sheet থেকে তথ্য আনা যায়নি।',
      });
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncOAuth() {
    setSyncing(true);
    setStatusMsg(null);
    try {
      await onSaveSettings(draft);
      const payload = await pullFromGoogleSheetsOAuth(draft);
      const vault = loadLocalVault();
      const saveRes = await apiFetch('/api/sync/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          pendingRecordIds: vault.pendingSheetIds,
          deletedRecordIds: vault.deletedRecordIds,
        }),
      });
      const json = (await saveRes.json()) as {
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
      if (!saveRes.ok || !json.success) {
        throw new Error(json.message || 'সিঙ্ক সংরক্ষণ ব্যর্থ');
      }
      await syncCleanupRemovedIds(json.counts?.removedIds);
      onSyncedFromSheet();
      const removedNote =
        json.counts?.removedRecords && json.counts.removedRecords > 0
          ? ` (শিট থেকে মোছা ${json.counts.removedRecords}টি সরানো হয়েছে)`
          : '';
      const extNote =
        json.counts?.extShadowCount && json.counts.extShadowCount > 0
          ? ` · শিটে ${json.counts.extShadowCount}টি বাড়তি ch-ext সারি পাওয়া গেছে (পরিষ্কার বাটনে চাপুন)`
          : '';
      setStatusMsg({
        tone: 'success',
        text: `সিঙ্ক সম্পন্ন: ডিলার ${json.counts?.dealers ?? 0}, উপ-বরাদ্দ ${
          json.counts?.suballocations ?? 0
        }, চালান ${json.counts?.records ?? 0}${removedNote}${extNote}`,
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Google Sheet থেকে তথ্য আনা যায়নি।',
      });
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncAppsScript() {
    if (!draft.gasWebAppUrl.trim()) {
      setStatusMsg({
        tone: 'error',
        text: 'আগে Apps Script Web App URL লিখুন।',
      });
      return;
    }
    setSyncing(true);
    setStatusMsg(null);
    try {
      await onSaveSettings(draft);
      const payload = await pullFromAppsScriptBridge(
        draft.gasWebAppUrl.trim(),
        draft
      );
      const vault = loadLocalVault();
      const saveRes = await apiFetch('/api/sync/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          pendingRecordIds: vault.pendingSheetIds,
          deletedRecordIds: vault.deletedRecordIds,
        }),
      });
      const json = (await saveRes.json()) as {
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
      };
      if (!saveRes.ok || !json.success) {
        throw new Error('ব্রিজ সিঙ্ক ডেটা সংরক্ষণ করা যায়নি।');
      }
      await syncCleanupRemovedIds(json.counts?.removedIds);
      onSyncedFromSheet();
      const removedNote =
        json.counts?.removedRecords && json.counts.removedRecords > 0
          ? ` (শিট থেকে মোছা ${json.counts.removedRecords}টি সরানো হয়েছে)`
          : '';
      const extNote =
        json.counts?.extShadowCount && json.counts.extShadowCount > 0
          ? ` · শিটে ${json.counts.extShadowCount}টি বাড়তি ch-ext সারি পাওয়া গেছে (পরিষ্কার বাটনে চাপুন)`
          : '';
      setStatusMsg({
        tone: 'success',
        text: `ব্রিজ সিঙ্ক সম্পন্ন: ডিলার ${json.counts?.dealers ?? 0}, উপ-বরাদ্দ ${
          json.counts?.suballocations ?? 0
        }, চালান ${json.counts?.records ?? 0}${removedNote}${extNote}`,
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Apps Script সিঙ্ক ব্যর্থ।',
      });
    } finally {
      setSyncing(false);
    }
  }

  async function handlePushAllToSheet() {
    setPushingAll(true);
    setStatusMsg(null);
    try {
      await onSaveSettings(draft);
      const res = await apiFetch('/api/challans');
      const json = (await res.json()) as {
        success: boolean;
        records?: ChallanRecord[];
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'চালান তালিকা পড়া যায়নি।');
      }
      const list = json.records || [];
      if (list.length === 0) {
        throw new Error('শিটে পাঠানোর জন্য কোনো সংরক্ষিত চালান নেই।');
      }
      const summary = await pushRecordsToGoogleSheet(draft, list);
      setStatusMsg({
        tone: 'success',
        text: `Google Sheet পুশ সম্পন্ন (${summary.total}টি): ${summary.notes.join(' · ')}`,
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'শিটে পুশ করা যায়নি।',
      });
    } finally {
      setPushingAll(false);
    }
  }

  async function handleCleanupSheetDuplicates() {
    setCleaningSheet(true);
    setStatusMsg(null);
    try {
      await onSaveSettings(draft);
      await apiFetch('/api/maintenance/cleanup-duplicates', { method: 'POST' });
      const res = await cleanupDuplicatesInGoogleSheet(draft);
      onSyncedFromSheet();
      setStatusMsg({
        tone: 'success',
        text: res.notes.join(' · '),
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'শিটের ডুপ্লিকেট পরিষ্কার করা যায়নি।',
      });
    } finally {
      setCleaningSheet(false);
    }
  }

  async function handleCopyGasCode() {
    const code = generateGoogleAppsScriptCode(draft);
    try {
      await navigator.clipboard.writeText(code);
      setGasCopied(true);
      setTimeout(() => setGasCopied(false), 2500);
    } catch {
      setStatusMsg({
        tone: 'error',
        text: 'স্বয়ংক্রিয় কপি হয়নি — নিচের কোড বক্স থেকে ম্যানুয়ালি কপি করুন।',
      });
    }
  }

  async function handleCopyAndroidGuardCode() {
    const code = generateExternalAndroidSheetGuardCode(draft);
    try {
      await navigator.clipboard.writeText(code);
      setAndroidGuardCopied(true);
      setTimeout(() => setAndroidGuardCopied(false), 2500);
    } catch {
      setStatusMsg({
        tone: 'error',
        text: 'স্বয়ংক্রিয় কপি হয়নি — নিচের অ্যান্ড্রয়েড গার্ড কোড বক্স থেকে ম্যানুয়ালি কপি করুন।',
      });
    }
  }

  async function handleDownloadSourceZip() {
    setDownloadingZip(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch('/api/export/source-zip');
      if (!res.ok) {
        throw new Error('ZIP ফাইল ডাউনলোড করা যায়নি।');
      }
      const blob = await res.blob();
      await saveBlobFile(
        blob,
        'Challan_Portal_GitHub_Source.zip',
        'application/zip'
      );
      setStatusMsg({
        tone: 'success',
        text: 'GitHub-এর জন্য সম্পূর্ণ প্রোজেক্ট (.zip) ডাউনলোড শুরু হয়েছে।',
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'ZIP ডাউনলোড ব্যর্থ হয়েছে।',
      });
    } finally {
      setDownloadingZip(false);
    }
  }

  async function handleDownloadSourceBundle() {
    setDownloadingSource(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch('/api/export/source-bundle');
      if (!res.ok) {
        throw new Error('সোর্স কোড ডাউনলোড করা যায়নি।');
      }
      const blob = await res.blob();
      await saveBlobFile(
        blob,
        'Challan_Portal_Full_Source_Code.txt',
        'text/plain;charset=utf-8'
      );
      setStatusMsg({
        tone: 'success',
        text: 'সোর্স কোড (.txt) ডাউনলোড শুরু হয়েছে।',
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'ডাউনলোড ব্যর্থ হয়েছে।',
      });
    } finally {
      setDownloadingSource(false);
    }
  }

  const githubExtractWorkflowYaml = `name: Extract Uploaded ZIP

on:
  push:
    paths:
      - '*.zip'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  extract-zip:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Extract ZIP and commit files
        run: |
          ZIP_FILE=$(ls -1 *.zip 2>/dev/null | head -n 1 || true)
          if [ -z "$ZIP_FILE" ]; then
            echo "কোনো .zip ফাইল পাওয়া যায়নি!"
            exit 0
          fi
          unzip -o "$ZIP_FILE" -x ".github/workflows/*" -d .
          rm -f "$ZIP_FILE"
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git reset HEAD -- .github/workflows/ 2>/dev/null || true
          if ! git diff --cached --quiet; then
            git commit -m "Extract $ZIP_FILE into repository"
            git push
          fi`;

  const githubApkWorkflowYaml = `name: Build Android APK

on:
  workflow_dispatch:

jobs:
  build-apk:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Setup Java 21
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'

      - name: Install & Build Web Assets
        env:
          VITE_API_BASE_URL: \${{ vars.APP_URL || '' }}
        run: |
          npm install --legacy-peer-deps
          npm run build

      - name: Setup Capacitor Android & Build APK
        env:
          CI: 'true'
        run: |
          npm install --legacy-peer-deps @capacitor/core @capacitor/cli @capacitor/android @capacitor/filesystem @capacitor/share
          if [ ! -f capacitor.config.ts ] && [ ! -f capacitor.config.json ]; then
            npx cap init "Challan Scan" "com.foodoffice.challanscan" --web-dir=dist
          fi
          if [ ! -d android ]; then
            npx cap add android
          fi
          npx cap sync android
          MANIFEST="android/app/src/main/AndroidManifest.xml"
          if [ -f "$MANIFEST" ] && ! grep -q "android.permission.CAMERA" "$MANIFEST"; then
            sed -i 's|<application|<uses-permission android:name="android.permission.CAMERA" />\\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />\\n    <application|' "$MANIFEST"
          fi
          MAIN_ACT="android/app/src/main/java/com/foodoffice/challanscan/MainActivity.java"
          mkdir -p "$(dirname "$MAIN_ACT")"
          cat <<'EOF' > "$MAIN_ACT"
          package com.foodoffice.challanscan;

          import android.content.ContentResolver;
          import android.content.ContentValues;
          import android.content.Context;
          import android.content.Intent;
          import android.net.Uri;
          import android.os.Build;
          import android.os.Bundle;
          import android.os.Environment;
          import android.print.PrintAttributes;
          import android.print.PrintDocumentAdapter;
          import android.print.PrintManager;
          import android.provider.MediaStore;
          import android.util.Base64;
          import android.webkit.JavascriptInterface;
          import android.webkit.WebView;
          import android.widget.Toast;
          import androidx.core.content.FileProvider;
          import com.getcapacitor.BridgeActivity;
          import java.io.File;
          import java.io.FileOutputStream;
          import java.io.OutputStream;

          public class MainActivity extends BridgeActivity {

              private void attachNativeBridge() {
                  if (getBridge() != null && getBridge().getWebView() != null) {
                      getBridge().getWebView().addJavascriptInterface(new AndroidNativeBridge(), "AndroidNative");
                  }
              }

              @Override
              public void onCreate(Bundle savedInstanceState) {
                  super.onCreate(savedInstanceState);
                  attachNativeBridge();
              }

              @Override
              public void onStart() {
                  super.onStart();
                  attachNativeBridge();
              }

              private class AndroidNativeBridge {

                  @JavascriptInterface
                  public void printWebView(final String jobName) {
                      MainActivity.this.runOnUiThread(() -> {
                          try {
                              WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                              if (webView == null) return;
                              PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                              if (printManager == null) return;
                              String safeJob = (jobName != null && !jobName.trim().isEmpty())
                                  ? jobName.trim()
                                  : "Challan_Report";
                              PrintDocumentAdapter printAdapter = webView.createPrintDocumentAdapter(safeJob);
                              PrintAttributes.Builder builder = new PrintAttributes.Builder();
                              builder.setMediaSize(PrintAttributes.MediaSize.ISO_A4);
                              printManager.print(safeJob, printAdapter, builder.build());
                          } catch (Exception e) {
                              Toast.makeText(MainActivity.this, "Print failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                          }
                      });
                  }

                  @JavascriptInterface
                  public String saveToDownloads(String base64Data, String fileName, String mimeType) {
                      try {
                          String cleanBase64 = base64Data != null ? base64Data : "";
                          int commaIdx = cleanBase64.indexOf(',');
                          if (cleanBase64.startsWith("data:") && commaIdx > 0) {
                              cleanBase64 = cleanBase64.substring(commaIdx + 1);
                          }
                          byte[] bytes = Base64.decode(cleanBase64, Base64.DEFAULT);
                          String safeName = (fileName != null && !fileName.trim().isEmpty())
                              ? fileName.trim().replaceAll("[/:*?<>|]+", "_")
                              : "challan_export";
                          String resolvedMime = (mimeType != null && !mimeType.trim().isEmpty())
                              ? mimeType.trim()
                              : "application/octet-stream";

                          Uri savedUri = null;
                          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                              ContentValues values = new ContentValues();
                              values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                              values.put(MediaStore.Downloads.MIME_TYPE, resolvedMime);
                              values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                              values.put(MediaStore.Downloads.IS_PENDING, 1);

                              ContentResolver resolver = getContentResolver();
                              savedUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                              if (savedUri != null) {
                                  try (OutputStream os = resolver.openOutputStream(savedUri)) {
                                      if (os != null) {
                                          os.write(bytes);
                                          os.flush();
                                      }
                                  }
                                  values.clear();
                                  values.put(MediaStore.Downloads.IS_PENDING, 0);
                                  resolver.update(savedUri, values, null, null);
                              }
                          } else {
                              File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                              if (dir == null || (!dir.exists() && !dir.mkdirs())) {
                                  dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                              }
                              if (dir == null) {
                                  dir = getCacheDir();
                              }
                              if (!dir.exists()) {
                                  dir.mkdirs();
                              }
                              File outFile = new File(dir, safeName);
                              try (FileOutputStream fos = new FileOutputStream(outFile)) {
                                  fos.write(bytes);
                                  fos.flush();
                              }
                              savedUri = FileProvider.getUriForFile(
                                  MainActivity.this,
                                  getPackageName() + ".fileprovider",
                                  outFile
                              );
                          }

                          if (savedUri == null) {
                              return "ERROR:Could not create file";
                          }

                          final Uri finalUri = savedUri;
                          MainActivity.this.runOnUiThread(() -> {
                              Toast.makeText(
                                  MainActivity.this,
                                  "Downloads ফোল্ডারে সেভ হয়েছে: " + safeName,
                                  Toast.LENGTH_LONG
                              ).show();
                              try {
                                  Intent viewIntent = new Intent(Intent.ACTION_VIEW);
                                  viewIntent.setDataAndType(finalUri, resolvedMime);
                                  viewIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                  startActivity(Intent.createChooser(viewIntent, safeName));
                              } catch (Exception ignored) {
                                  try {
                                      Intent shareIntent = new Intent(Intent.ACTION_SEND);
                                      shareIntent.setType(resolvedMime);
                                      shareIntent.putExtra(Intent.EXTRA_STREAM, finalUri);
                                      shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                      startActivity(Intent.createChooser(shareIntent, safeName));
                                  } catch (Exception ignored2) {}
                              }
                          });
                          return savedUri.toString();
                      } catch (Exception e) {
                          return "ERROR:" + e.getMessage();
                      }
                  }
              }
          }
          EOF
          cd android
          chmod +x gradlew
          ./gradlew assembleDebug

      - name: Upload APK Artifact
        uses: actions/upload-artifact@v4
        with:
          name: Challan-Scan-Android-APK
          path: android/app/build/outputs/apk/debug/app-debug.apk`;

  async function handleCopyWorkflow(type: 'extract' | 'apk', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedWorkflow(type);
      setTimeout(() => setCopiedWorkflow(null), 2500);
    } catch {
      setStatusMsg({
        tone: 'error',
        text: 'স্বয়ংক্রিয় কপি হয়নি — নিচের কোড বক্স থেকে ম্যানুয়ালি কপি করুন।',
      });
    }
  }

  function updateLicenseFee(
    khatName: string,
    field: keyof Omit<LicenseFeeConfig, 'khatName'>,
    val: string
  ) {
    const num = Number(val) || 0;
    setDraft((prev) => ({
      ...prev,
      licenseFees: prev.licenseFees.map((f) =>
        f.khatName === khatName ? { ...f, [field]: num } : f
      ),
    }));
  }

  function handleAddCustomColumn() {
    const label = newColLabel.trim();
    const sheetColumn = newColLetter
      .trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    if (!label || !sheetColumn) return;
    const nextCol: CustomRegisterColumn = {
      id: `col-${Date.now()}`,
      label,
      sheetColumn,
      includeInGrainRegister: newColGrain,
      includeInLicenseRegister: newColLicense,
    };
    setDraft((prev) => ({
      ...prev,
      customColumns: [...(prev.customColumns || []), nextCol],
    }));
    setNewColLabel('');
  }

  function removeCustomColumn(id: string) {
    setDraft((prev) => ({
      ...prev,
      customColumns: (prev.customColumns || []).filter((c) => c.id !== id),
    }));
  }

  function handleAddKhat() {
    const name = newKhatName.trim();
    if (!name) return;
    if (draft.khats.some((k) => k.name === name)) {
      setStatusMsg({ tone: 'error', text: 'এই নামের খাত ইতিমধ্যে আছে।' });
      return;
    }
    const nextKhat: KhatConfig = {
      id: `khat-${Date.now()}`,
      name,
      group: newKhatGroup,
      subGroup: newKhatGroup === 'license' ? 'new' : undefined,
      iconKey: newKhatIcon,
      colorKey: newKhatColor,
      hasIncomeTax: newKhatHasTax,
      hasVat: newKhatHasVat,
      showQuantityRate: newKhatShowQty,
      active: true,
    };
    setDraft((prev) => ({ ...prev, khats: [...prev.khats, nextKhat] }));
    setNewKhatName('');
  }

  function toggleKhatActive(id: string) {
    setDraft((prev) => ({
      ...prev,
      khats: prev.khats.map((k) =>
        k.id === id ? { ...k, active: !k.active } : k
      ),
    }));
  }

  function removeKhat(id: string) {
    setDraft((prev) => ({
      ...prev,
      khats: prev.khats.filter((k) => k.id !== id),
    }));
  }

  function handleAddAllowedEmail() {
    const email = newEmailInput.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    setDraft((prev) => ({
      ...prev,
      allowedEmails: Array.from(
        new Set([...(prev.allowedEmails || []), email])
      ),
    }));
    setNewEmailInput('');
  }

  function removeAllowedEmail(email: string) {
    setDraft((prev) => ({
      ...prev,
      allowedEmails: (prev.allowedEmails || []).filter((e) => e !== email),
    }));
  }

  function handleSignatureImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setDraft((prev) => ({
          ...prev,
          officerSignatureImageDataUrl: reader.result as string,
        }));
      }
    };
    reader.readAsDataURL(file);
  }

  function execMasterCmd(command: string, value?: string) {
    masterEditorRef.current?.focus();
    document.execCommand(command, false, value);
    if (masterEditorRef.current) {
      setTplHtmlContent(masterEditorRef.current.innerHTML);
    }
  }

  function insertFieldToken(token: string) {
    masterEditorRef.current?.focus();
    document.execCommand('insertText', false, token);
    if (masterEditorRef.current) {
      setTplHtmlContent(masterEditorRef.current.innerHTML);
    }
  }

  function insertMasterTable() {
    const html =
      '<table><thead><tr><th>ক্রমিক</th><th>বিবরণ</th><th>পরিমাণ</th><th>মন্তব্য</th></tr></thead><tbody><tr><td>১</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br/></p>';
    masterEditorRef.current?.focus();
    document.execCommand('insertHTML', false, html);
    if (masterEditorRef.current) {
      setTplHtmlContent(masterEditorRef.current.innerHTML);
    }
  }

  function appendMasterTableRow() {
    const root = masterEditorRef.current;
    if (!root) return;
    const table = root.querySelector('table');
    if (!table) {
      insertMasterTable();
      return;
    }
    const tbody = table.querySelector('tbody') || table;
    const rows = tbody.querySelectorAll('tr');
    const cols = rows.length > 0 ? rows[rows.length - 1].children.length || 4 : 4;
    const tr = document.createElement('tr');
    for (let i = 0; i < cols; i++) {
      const td = document.createElement('td');
      td.innerHTML = '&nbsp;';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    setTplHtmlContent(root.innerHTML);
  }

  async function handleMasterDocxUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setTplUploading(true);
    setStatusMsg(null);
    try {
      const mammoth = await import('mammoth');
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      const baseTitle = file.name.replace(/\.docx?$/i, '').trim();
      if (!tplTitle.trim()) setTplTitle(baseTitle);
      const nextHtml = result.value || DEFAULT_MASTER_HTML;
      setTplHtmlContent(nextHtml);
      if (masterEditorRef.current) {
        masterEditorRef.current.innerHTML = nextHtml;
      }
      setStatusMsg({
        tone: 'success',
        text: `"${file.name}" ইমপোর্ট হয়েছে — এখন পরিবর্তন করে সংরক্ষণ করুন।`,
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Word ফাইলটি পড়া যায়নি (.docx ফরম্যাট ব্যবহার করুন)।',
      });
    } finally {
      setTplUploading(false);
    }
  }

  function loadTemplateIntoMaster(tpl: ReportTemplate) {
    setTplId(tpl.id);
    setTplTitle(tpl.title);
    setTplCategory(tpl.category || 'রিপোর্ট');
    setTplDefaultMemo(tpl.defaultMemoNo || '');
    setTplDefaultRecipient(tpl.defaultRecipient || '');
    setTplOrientation(tpl.orientation === 'landscape' ? 'landscape' : 'portrait');
    setTplEditableFields(
      tpl.editableFields || {
        allowDate: true,
        allowMemo: true,
        allowRecipient: true,
        allowTableEdit: true,
      }
    );
    setTplHtmlContent(tpl.htmlContent);
    if (masterEditorRef.current) {
      masterEditorRef.current.innerHTML = tpl.htmlContent;
    }
  }

  function resetNewTemplate() {
    setTplId('');
    setTplTitle('');
    setTplCategory('রিপোর্ট');
    setTplDefaultRecipient('জেলা খাদ্য নিয়ন্ত্রক');
    setTplEditableFields({
      allowDate: true,
      allowMemo: true,
      allowRecipient: true,
      allowTableEdit: true,
    });
    setTplHtmlContent(DEFAULT_MASTER_HTML);
    if (masterEditorRef.current) {
      masterEditorRef.current.innerHTML = DEFAULT_MASTER_HTML;
    }
  }

  async function handleSaveMasterTemplate() {
    const title = tplTitle.trim();
    const htmlContent =
      masterEditorRef.current?.innerHTML.trim() || tplHtmlContent.trim();
    if (!title) {
      setStatusMsg({ tone: 'error', text: 'টেম্পলেটের টাইটেল লিখুন।' });
      return;
    }
    setTplSaving(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: tplId || undefined,
          title,
          category: tplCategory.trim() || 'রিপোর্ট',
          htmlContent,
          defaultMemoNo: tplDefaultMemo,
          defaultRecipient: tplDefaultRecipient,
          officerName: draft.officerName,
          officerDesignation: draft.officerSignatureText,
          signatureImageDataUrl: draft.officerSignatureImageDataUrl,
          orientation: tplOrientation,
          editableFields: tplEditableFields,
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        template?: ReportTemplate;
        message?: string;
      };
      if (!res.ok || !json.success || !json.template) {
        throw new Error(json.message || 'টেম্পলেট সেভ ব্যর্থ');
      }
      setTplId(json.template.id);
      onRefreshTemplates?.();
      setStatusMsg({
        tone: 'success',
        text: `"${json.template.title}" টেম্পলেট সংরক্ষিত হয়েছে।`,
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'টেম্পলেট সেভ হয়নি।',
      });
    } finally {
      setTplSaving(false);
    }
  }

  async function handleDeleteTemplate(id: string) {
    const res = await apiFetch(`/api/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      if (tplId === id) resetNewTemplate();
      onRefreshTemplates?.();
    }
  }

  async function handleToggleLockSystem() {
    const nextEnabled = !draft.lockEnabled;
    setLockBusy(true);
    setLockMsg(null);
    try {
      const nextDraft: AppSettings = { ...draft, lockEnabled: nextEnabled };
      setDraft(nextDraft);
      await onSaveSettings(nextDraft);
      setLockMsg({
        tone: 'success',
        text: nextEnabled
          ? 'লক সিস্টেম চালু হয়েছে। এখন অ্যাপে প্রবেশ করতে পাসওয়ার্ড লাগবে।'
          : 'লক সিস্টেম বন্ধ (আনলক) করা হয়েছে। এখন পাসওয়ার্ড ছাড়া প্রবেশ করা যাবে।',
      });
    } catch (err) {
      setDraft((prev) => ({ ...prev, lockEnabled: !nextEnabled }));
      setLockMsg({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'লক স্ট্যাটাস পরিবর্তন করা যায়নি।',
      });
    } finally {
      setLockBusy(false);
    }
  }

  async function handleSaveLockPassword() {
    if (lockPasswordInput.trim().length < 4) {
      setLockMsg({
        tone: 'error',
        text: 'কমপক্ষে ৪ অক্ষরের পাসওয়ার্ড লিখুন।',
      });
      return;
    }
    setLockBusy(true);
    setLockMsg(null);
    try {
      const res = await apiFetch('/api/auth/lock-password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: lockPasswordInput.trim(),
          lockEnabled: draft.lockEnabled,
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        token?: string;
        lockEnabled?: boolean;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'পাসওয়ার্ড সংরক্ষণ করা যায়নি।');
      }
      if (json.token) {
        setAuthToken(json.token);
      }
      setLockPasswordInput('');
      setLockMsg({
        tone: 'success',
        text: draft.lockEnabled
          ? 'নতুন লক পাসওয়ার্ড সংরক্ষিত হয়েছে।'
          : 'লক পাসওয়ার্ড সংরক্ষিত হয়েছে (এখন চাইলে লক সিস্টেম চালু করতে পারেন)।',
      });
    } catch (err) {
      setLockMsg({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'পাসওয়ার্ড সংরক্ষণ ব্যর্থ হয়েছে।',
      });
    } finally {
      setLockBusy(false);
    }
  }

  return (
    <form onSubmit={handleSaveAll} className="space-y-4">
      {/* Graphical Small-Icon Settings Navigation Grid */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-xs font-bold text-slate-500">
            যেকোনো আইকনে ক্লিক করে বিস্তারিত সেটিংস দেখুন
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {SETTINGS_MENU.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setStatusMsg(null);
                  setActiveSection(item.key);
                }}
                className={`flex flex-col items-center gap-1.5 rounded-2xl border p-3 text-center transition-all ${
                  active
                    ? 'border-rose-700 bg-rose-50/70 ring-2 ring-rose-700/20 shadow-xs'
                    : 'border-slate-200 bg-slate-50/50 hover:bg-white hover:border-slate-300'
                }`}
              >
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
                    active ? 'bg-rose-700 text-white border-rose-700' : item.accent
                  }`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <div className="text-xs font-extrabold text-slate-900">
                  {item.label}
                </div>
                <div className="text-[10px] text-slate-500 leading-tight">
                  {item.desc}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* App Lock System Panel (Default Unlocked; Password Only When Enabled) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                draft.lockEnabled
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700'
              }`}
            >
              {draft.lockEnabled ? (
                <Lock className="h-5 w-5" />
              ) : (
                <Unlock className="h-5 w-5" />
              )}
            </span>
            <div>
              <h2 className="text-sm font-extrabold text-slate-900 sm:text-base">
                অ্যাপ লক সিস্টেম (পাসওয়ার্ড সুরক্ষা)
              </h2>
              <p className="text-xs text-slate-600">
                {draft.lockEnabled
                  ? 'চালু আছে — অ্যাপে প্রবেশ করতে কেবল পাসওয়ার্ড লাগবে।'
                  : 'ডিফল্ট আনলক — কোনো পাসওয়ার্ড ছাড়াই সরাসরি প্রবেশ করা যাবে।'}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={lockBusy}
            onClick={() => void handleToggleLockSystem()}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold text-white transition-colors disabled:opacity-60 ${
              draft.lockEnabled
                ? 'bg-emerald-700 hover:bg-emerald-800'
                : 'bg-rose-700 hover:bg-rose-800'
            }`}
          >
            {lockBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : draft.lockEnabled ? (
              <Unlock className="h-4 w-4" />
            ) : (
              <Lock className="h-4 w-4" />
            )}
            {draft.lockEnabled ? 'লক বন্ধ করুন (আনলক)' : 'লক চালু করুন'}
          </button>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-center">
          <label className="flex flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <KeyRound className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              type="password"
              value={lockPasswordInput}
              onChange={(e) => setLockPasswordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSaveLockPassword();
                }
              }}
              placeholder="লক পাসওয়ার্ড সেট / পরিবর্তন করুন (কমপক্ষে ৪ অক্ষর)"
              className="w-full bg-transparent text-xs font-semibold text-slate-900 placeholder:text-slate-400 focus:outline-none"
            />
          </label>
          <button
            type="button"
            disabled={lockBusy || lockPasswordInput.trim().length < 4}
            onClick={() => void handleSaveLockPassword()}
            className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-800 hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap"
          >
            <Save className="h-3.5 w-3.5" />
            পাসওয়ার্ড সেভ করুন
          </button>
        </div>

        {lockMsg && (
          <div
            className={`rounded-xl px-3 py-2 text-xs font-semibold ${
              lockMsg.tone === 'success'
                ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border border-rose-200 bg-rose-50 text-rose-800'
            }`}
          >
            {lockMsg.text}
          </div>
        )}
      </section>

      {/* SECTION 1: Google Sheets & Apps Script Sync */}
      {activeSection === 'sync' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <h2 className="text-base font-bold text-slate-900">
              Google Sheet ও Apps Script সংযোগ
            </h2>

            <button
              type="button"
              onClick={onOpenDealersManager}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Database className="h-3.5 w-3.5" />
              ডিলার ও লাইসেন্স তালিকা
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  পদ্ধতি ১: Google অ্যাকাউন্ট ও সরাসরি শিট
                </h3>
                <p className="text-xs text-slate-500">
                  {hasGoogleToken && googleUser
                    ? `সংযুক্ত: ${googleUser.email || googleUser.displayName}`
                    : 'সরাসরি স্প্রেডশিটে পড়তে ও লিখতে সাইন-ইন করুন'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={syncing}
                  onClick={() => void handleSyncPublicSheet()}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-60 whitespace-nowrap"
                >
                  {syncing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  সরাসরি শিট সিঙ্ক (আনুন)
                </button>

                <button
                  type="button"
                  disabled={pushingAll}
                  onClick={() => void handlePushAllToSheet()}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                >
                  {pushingAll ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CloudUpload className="h-4 w-4" />
                  )}
                  সব চালান শিটে পুশ করুন
                </button>

                <button
                  type="button"
                  disabled={cleaningSheet}
                  onClick={() => void handleCleanupSheetDuplicates()}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                >
                  {cleaningSheet ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  শিট ডুপ্লিকেট পরিষ্কার
                </button>

                {hasGoogleToken && googleUser ? (
                  <>
                    <button
                      type="button"
                      disabled={syncing}
                      onClick={() => void handleSyncOAuth()}
                      className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800 disabled:opacity-60"
                    >
                      {syncing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      OAuth সিঙ্ক
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleGoogleSignOut()}
                      className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      সাইন-আউট
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={() => void handleGoogleLogin()}
                    className="gsi-material-button"
                  >
                    <div className="gsi-material-button-state" />
                    <div className="gsi-material-button-content-wrapper">
                      <div className="gsi-material-button-icon">
                        <svg
                          version="1.1"
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 48 48"
                          className="block"
                        >
                          <path
                            fill="#EA4335"
                            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                          />
                          <path
                            fill="#4285F4"
                            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                          />
                          <path
                            fill="#FBBC05"
                            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                          />
                          <path
                            fill="#34A853"
                            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                          />
                          <path fill="none" d="M0 0h48v48H0z" />
                        </svg>
                      </div>
                      <span className="gsi-material-button-contents">
                        {authBusy ? 'সংযোগ হচ্ছে...' : 'Sign in with Google'}
                      </span>
                    </div>
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  Spreadsheet ID বা Google Sheet লিংক
                </label>
                <input
                  type="text"
                  value={draft.spreadsheetId}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const normalized = raw.includes('/spreadsheets/d/')
                      ? extractSpreadsheetId(raw)
                      : raw.trim();
                    setDraft((prev) => ({
                      ...prev,
                      spreadsheetId: normalized,
                    }));
                  }}
                  placeholder="শিট আইডি বা https://docs.google.com/spreadsheets/d/... লিংক পেস্ট করুন"
                  className="font-mono-num w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  সরাসরি Sheet লিংক/ID বসালে লগইন ছাড়াই শিট থেকে ডেটা আনা (Sync) যাবে। লগইন ছাড়া শিটে পুশ/এডিট/ডিলিট করতে নিচের পদ্ধতি ২ সেটআপ করুন।
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  Challan ট্যাব
                </label>
                <input
                  type="text"
                  value={draft.challanTabName}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      challanTabName: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  Suballocation ট্যাব
                </label>
                <input
                  type="text"
                  value={draft.suballocationTabName}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      suballocationTabName: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  Food Dealer ট্যাব
                </label>
                <input
                  type="text"
                  value={draft.foodDealerTabName}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      foodDealerTabName: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  OMS Dealer ট্যাব
                </label>
                <input
                  type="text"
                  value={draft.omsDealerTabName}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      omsDealerTabName: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  DO_Issue ট্যাব
                </label>
                <input
                  type="text"
                  value={draft.doIssueTabName || 'DO_Issue'}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      doIssueTabName: e.target.value,
                    }))
                  }
                  placeholder="DO_Issue"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  আলাদা VAT ট্যাব (ঐচ্ছিক)
                </label>
                <input
                  type="text"
                  value={draft.separateVatTabName || ''}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      separateVatTabName: e.target.value,
                    }))
                  }
                  placeholder="যেমন: VAT_Challans"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-teal-700" />
              <h3 className="text-sm font-bold text-slate-900">
                শেয়ার্ড Google ইমেইল অ্যাক্সেস তালিকা
              </h3>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(draft.allowedEmails || []).map((em) => (
                <span
                  key={em}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800"
                >
                  {em}
                  {em !== 'foodchannelregister@gmail.com' && (
                    <button
                      type="button"
                      onClick={() => removeAllowedEmail(em)}
                      className="text-slate-400 hover:text-red-700"
                      aria-label="মুছুন"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="email"
                value={newEmailInput}
                onChange={(e) => setNewEmailInput(e.target.value)}
                placeholder="শেয়ারকৃত সহকর্মীর Gmail লিখুন..."
                className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
              <button
                type="button"
                onClick={handleAddAllowedEmail}
                className="inline-flex items-center gap-1 rounded-xl bg-teal-700 px-3 py-2 text-xs font-bold text-white hover:bg-teal-800 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                ইমেইল যোগ
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  পদ্ধতি ২: লগইন ছাড়া Apps Script (অ্যাপ থেকে শিটে পুশ, এডিট ও ডিলিট)
                </h3>
                <p className="text-[11px] text-slate-600">
                  স্ট্যাটাস: {getSheetPushCapability(draft).methodLabel}
                </p>
              </div>

              <select
                value={draft.syncMethod}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    syncMethod: e.target.value as AppSettings['syncMethod'],
                  }))
                }
                className="min-h-[38px] rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800"
              >
                <option value="both">উভয় পদ্ধতি সক্রিয় (লগইন ও Apps Script)</option>
                <option value="apps_script">শুধু Apps Script (লগইন ছাড়া)</option>
                <option value="oauth">শুধু Google লগইন</option>
              </select>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="url"
                value={draft.gasWebAppUrl}
                onChange={(e) => {
                  const val = e.target.value.trim();
                  setDraft((prev) => ({
                    ...prev,
                    gasWebAppUrl: val,
                    syncMethod:
                      val && prev.syncMethod === 'oauth'
                        ? 'both'
                        : prev.syncMethod,
                  }));
                }}
                placeholder="https://script.google.com/macros/s/.../exec"
                className="flex-1 min-h-[42px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleSyncAppsScript()}
                className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                ব্রিজ সিঙ্ক ও টেস্ট
              </button>
              <button
                type="button"
                disabled={pushingAll}
                onClick={() => void handlePushAllToSheet()}
                className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {pushingAll ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudUpload className="h-3.5 w-3.5" />
                )}
                সব চালান পুশ (বিনা লগইন)
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700 space-y-1.5">
              <div className="font-bold text-slate-900">
                লগইন ছাড়া Google Sheet-এ ডেটা পাঠানো, এডিট ও ডিলিটের ধাপ:
              </div>
              <ol className="list-decimal pl-4 space-y-1 text-[11px] leading-relaxed">
                <li>
                  যদি আপনার শিটের{' '}
                  <span className="font-mono-num font-bold text-slate-900">
                    Code.gs
                  </span>{' '}
                  ফাইলে আগে থেকেই অন্য কোড থাকে, তাহলে সেটি{' '}
                  <span className="font-bold text-rose-700">মুছবেন না</span>—সরাসরি{' '}
                  <span className="font-mono-num font-bold text-slate-900">
                    script.google.com
                  </span>{' '}
                  এ গিয়ে <span className="font-bold">New project</span> খুলুন। (আর আগের কোড ফাঁকা থাকলে বা নতুন শিট হলে <span className="font-bold">Extensions → Apps Script</span> ব্যবহার করুন।)
                </li>
                <li>
                  নতুন প্রজেক্টের{' '}
                  <span className="font-mono-num font-bold text-slate-900">
                    Code.gs
                  </span>{' '}
                  ফাইলে নিচের{' '}
                  <span className="font-bold text-teal-800">
                    Apps Script কোড কপি করুন
                  </span>{' '}
                  বাটনে ক্লিক করে পুরো কোডটি পেস্ট করুন।
                </li>
                <li>
                  পেস্ট করা কোডের{' '}
                  <span className="font-mono-num font-bold text-rose-700">
                    ১ নম্বর লাইনে
                  </span>{' '}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono-num text-[10px]">
                    const SPREADSHEET_ID = "{extractSpreadsheetId(draft.spreadsheetId) || 'আপনার_শিটের_আইডি'}";
                  </code>{' '}
                  সঠিক আছে কি না দেখে সেভ (<span className="font-bold">Ctrl+S</span>) করুন।
                </li>
                <li>
                  ওপরের ডানে{' '}
                  <span className="font-bold text-slate-900">
                    Deploy → New deployment → Web app
                  </span>{' '}
                  নির্বাচন করে <b>Execute as: Me</b> এবং{' '}
                  <b>Who has access: Anyone</b> দিয়ে <b>Deploy</b> করুন। (নতুন Edit/Delete ফিচারের জন্য কোড আপডেট করলে অবশ্যই{' '}
                  <b>Deploy → Manage deployments → Edit → New version → Deploy</b> করবেন।) পাওয়া{' '}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono-num text-[10px]">
                    .../exec
                  </code>{' '}
                  লিংকটি ওপরের বক্সে বসিয়ে নিচের <b>সব সেটিংস সংরক্ষণ করুন</b> চাপুন।
                </li>
                <li className="text-amber-900 font-semibold">
                  ডুপ্লিকেট কপি স্থায়ীভাবে বন্ধ করতে: আপনার শিটের{' '}
                  <span className="font-bold">Extensions → Apps Script → Triggers</span>{' '}
                  (ঘড়ির আইকন) অংশে আগে থেকে কোনো অটো-ট্রিগার থাকলে তা মুছে দিন এবং ওপরের নতুন{' '}
                  <span className="font-mono-num font-bold">LockService</span>-যুক্ত{' '}
                  <span className="font-mono-num font-bold">Code.gs</span> আপডেট করে{' '}
                  <span className="font-bold">New version</span> ডিপ্লয় করুন।
                </li>
              </ol>
            </div>

            <div className="border-t border-slate-200 pt-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowGasGuide((v) => !v)}
                  className="inline-flex min-h-[36px] items-center gap-1.5 text-xs font-bold text-rose-700 hover:underline cursor-pointer"
                >
                  {showGasGuide ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                  Google Apps Script (Code.gs) ও নির্ধারিত ছকের কলাম কাঠামো দেখুন
                </button>

                <button
                  type="button"
                  onClick={() => void handleCopyGasCode()}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-teal-800 cursor-pointer"
                >
                  {gasCopied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {gasCopied ? 'কোড কপি হয়েছে!' : 'Apps Script কোড কপি করুন'}
                </button>
              </div>

              {showGasGuide && (
                <div className="mt-3 space-y-2.5">
                  <div className="rounded-xl border border-slate-200 bg-white p-3 text-[11px] text-slate-700">
                    <div className="font-bold text-slate-900 mb-1.5">
                      {draft.challanTabName || 'Challan'} ট্যাবের নির্ধারিত কলাম কাঠামো (মূল লাইন + নিচে আয়কর লাইন, পাশাপাশি A–AA + কাস্টম X+):
                    </div>
                    <div className="grid grid-cols-2 gap-1 sm:grid-cols-4 text-[10px]">
                      <span><b>A:</b> id (মূল / -TAX / -VAT)</span>
                      <span><b>B:</b> date (yyyy-MM-dd)</span>
                      <span><b>C:</b> department</span>
                      <span><b>D:</b> category (খাত)</span>
                      <span><b>E:</b> taxDepartment (আয়কর/ভ্যাট প্রতিষ্ঠান)</span>
                      <span><b>F:</b> dcMemo</span>
                      <span><b>G:</b> dealerAllocationId (একই বরাদ্দ)</span>
                      <span><b>H:</b> challanNo (শুধু মূল চালান)</span>
                      <span><b>I:</b> challanDate (শুধু মূল তারিখ)</span>
                      <span><b>J:</b> rate</span>
                      <span><b>K:</b> quantity</span>
                      <span><b>L:</b> totalAmount (শুধু মূল টাকা)</span>
                      <span><b>M:</b> incomeTaxChallanNo (-TAX লাইনে)</span>
                      <span><b>N:</b> incomeTaxDate (-TAX লাইনে)</span>
                      <span><b>O:</b> incomeTaxAmount (-TAX লাইনে)</span>
                      <span><b>P:</b> comment (মূল মন্তব্য)</span>
                      <span><b>Q:</b> taxComment (আয়কর/ভ্যাট মন্তব্য)</span>
                      <span><b>R:</b> createdAt</span>
                      <span><b>S:</b> vatChallanNo (-VAT লাইনে)</span>
                      <span><b>T:</b> vatDate (-VAT লাইনে)</span>
                      <span><b>U:</b> vatAmount (-VAT লাইনে)</span>
                      <span><b>V:</b> licenseNo</span>
                      <span><b>W:</b> new37Code</span>
                      <span><b>X:</b> srcRecordId (অথবা কাস্টম কলাম)</span>
                      <span><b>Y:</b> taxExtra (কর/ভ্যাট অতিরিক্ত অংশ)</span>
                      <span><b>Z:</b> taxCode (আয়কর কোড)</span>
                      <span><b>AA:</b> vatCode (ভ্যাট কোড)</span>
                      {(draft.customColumns || []).map((c) => (
                        <span key={c.id}>
                          <b>{c.sheetColumn}:</b> {c.label}
                        </span>
                      ))}
                    </div>
                  </div>

                  <pre className="max-h-64 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100 font-mono-num">
                    {generateGoogleAppsScriptCode(draft)}
                  </pre>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-amber-300 bg-amber-50/60 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-700 text-white">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    অন্য অ্যান্ড্রয়েড অ্যাপের লিংক করা শিট সুরক্ষা (আলাদা লাইন + পাশাপাশি রো এক্সচেঞ্জ)
                  </h3>
                  <p className="text-[11px] text-slate-700">
                    মূল চালান (লাইন ১, <span className="font-mono-num font-bold">H/I/L</span>) ও আয়কর চালান (লাইন ২, <span className="font-mono-num font-bold">-TAX</span>, শুধু <span className="font-mono-num font-bold">M/N/O</span>; <span className="font-mono-num font-bold">H/L</span> খালি) আলাদা সারিতে সংরক্ষিত হবে—যাতে অন্য অ্যাপের কোড না বদলেও কখনো আয়করকে মূল চালান বা মূল টাকা না ধরে।
                  </p>
                </div>
              </div>

              <button
                type="button"
                disabled={cleaningSheet}
                onClick={() => void handleCleanupSheetDuplicates()}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-amber-800 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-amber-900 disabled:opacity-60 whitespace-nowrap cursor-pointer"
              >
                {cleaningSheet ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                এখনই শিট পরিষ্কার ও সুরক্ষা চালান
              </button>
            </div>

            <div className="rounded-xl border border-amber-200 bg-white p-3 text-xs text-slate-700 space-y-1.5">
              <div className="font-bold text-slate-900">
                অন্য অ্যান্ড্রয়েড অ্যাপের Google Sheet-এ গার্ড সেটআপের ৪ ধাপ (<span className="font-mono-num">ChallanGuard.gs</span>):
              </div>
              <ol className="list-decimal pl-4 space-y-1 text-[11px] leading-relaxed">
                <li>
                  আপনার অন্য অ্যান্ড্রয়েড অ্যাপটি যে Google Sheet-এর সাথে লিংক করা, সেই শিট খুলুন → <span className="font-bold">Extensions → Apps Script</span>-এ যান।
                </li>
                <li>
                  বামের Files পাশে <span className="font-bold">+ (Add a file) → Script</span>-এ ক্লিক করে নাম দিন{' '}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono-num text-[10px]">ChallanGuard</code> (আগের কোনো কোড বা <span className="font-mono-num">doGet/doPost</span> নষ্ট হবে না)।
                </li>
                <li>
                  নিচের <b>Android Sheet Guard কোড কপি করুন</b> বাটনে ক্লিক করে পুরো কোডটি পেস্ট করে সেভ (<span className="font-bold">Ctrl+S</span>) করুন।
                </li>
                <li>
                  ওপরের ফাংশন লিস্ট থেকে{' '}
                  <code className="rounded bg-amber-100 px-1 py-0.5 font-mono-num text-[10px] font-bold">installAndroidChallanRowGuard</code> বেছে <b>Run</b> দিন (১ বার অনুমতি দিন)। আগের কোনো অটো-সিঙ্ক (<span className="font-mono-num">Sync_Log</span> / <span className="font-mono-num">ch-ext-t-</span>) ট্রিগার বন্ধ করতে চাইলে{' '}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono-num text-[10px] font-bold">disableLegacySyncTriggers</code>-ও Run দিন। এতে প্রতি মিনিটে শিট স্বয়ংক্রিয়ভাবে বাড়তি সারি মুছে আসল চালান সুরক্ষিত রাখবে।
                </li>
              </ol>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowAndroidGuardGuide((v) => !v)}
                className="inline-flex min-h-[36px] items-center gap-1.5 text-xs font-bold text-amber-900 hover:underline cursor-pointer"
              >
                {showAndroidGuardGuide ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
                Android Sheet Guard কোড (ChallanGuard.gs) দেখুন
              </button>

              <button
                type="button"
                onClick={() => void handleCopyAndroidGuardCode()}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-slate-800 cursor-pointer"
              >
                {androidGuardCopied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {androidGuardCopied
                  ? 'Guard কোড কপি হয়েছে!'
                  : 'Android Sheet Guard কোড কপি করুন'}
              </button>
            </div>

            {showAndroidGuardGuide && (
              <pre className="max-h-64 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100 font-mono-num">
                {generateExternalAndroidSheetGuardCode(draft)}
              </pre>
            )}
          </div>
        </section>
      )}

      {/* SECTION 2: Office Header, Pagination, Hide IDs & Signature */}
      {activeSection === 'office' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <input
            ref={sigImgInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleSignatureImageUpload}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <h2 className="text-base font-bold text-slate-900">
              কার্যালয়, কর্মকর্তার নাম ও স্বাক্ষর সেটিংস
            </h2>

            <label className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-800">
              <input
                type="checkbox"
                checked={draft.hideDealerIds}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    hideDealerIds: e.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-slate-300"
              />
              ডিলার আইডি (DF/DLR) UI-তে হাইড রাখুন
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                উপজেলা ও জেলা
              </label>
              <input
                type="text"
                value={draft.officeTitle}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, officeTitle: e.target.value }))
                }
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                কার্যালয়ের নাম
              </label>
              <input
                type="text"
                value={draft.officeSubtitle}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    officeSubtitle: e.target.value,
                  }))
                }
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                ড্যাশবোর্ড প্রতি পৃষ্ঠায়
              </label>
              <select
                value={draft.dashboardPageSize || 15}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    dashboardPageSize: Number(e.target.value) as 10 | 15 | 20,
                  }))
                }
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-900"
              >
                <option value={10}>১০টি</option>
                <option value={15}>১৫টি</option>
                <option value={20}>২০টি</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                কর্মকর্তার নাম
              </label>
              <input
                type="text"
                value={draft.officerName || ''}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    officerName: e.target.value,
                  }))
                }
                placeholder="স্বাক্ষরকারীর নাম"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                পদবি (স্বাক্ষরের নিচে)
              </label>
              <input
                type="text"
                value={draft.officerSignatureText || ''}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    officerSignatureText: e.target.value,
                  }))
                }
                placeholder="উপজেলা খাদ্য নিয়ন্ত্রক"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => sigImgInputRef.current?.click()}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-slate-800"
              >
                <ImagePlus className="h-4 w-4" />
                স্বাক্ষরের ছবি (PNG)
              </button>
              {draft.officerSignatureImageDataUrl && (
                <button
                  type="button"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      officerSignatureImageDataUrl: '',
                    }))
                  }
                  className="rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-700"
                >
                  ছবি সরান
                </button>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white px-5 py-2 text-center min-w-[180px]">
              {draft.officerSignatureImageDataUrl ? (
                <img
                  src={draft.officerSignatureImageDataUrl}
                  alt="স্বাক্ষর প্রিভিউ"
                  className="mx-auto mb-1 h-9 max-w-[140px] object-contain"
                />
              ) : (
                <div className="mb-1 text-[11px] text-slate-400">
                  (স্বাক্ষরের স্থান)
                </div>
              )}
              <div className="border-t border-slate-400 pt-1 text-xs font-bold text-slate-900">
                {draft.officerName ||
                  draft.officerSignatureText ||
                  'কর্মকর্তার নাম'}
              </div>
              {draft.officerName && (
                <div className="text-[11px] text-slate-600">
                  {draft.officerSignatureText}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* SECTION 3: Master Word (.docx) Report Template Editor */}
      {activeSection === 'templates' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <input
            ref={docxInputRef}
            type="file"
            accept=".docx"
            className="hidden"
            onChange={(e) => void handleMasterDocxUpload(e)}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-rose-700" />
              <h2 className="text-base font-bold text-slate-900">
                মাস্টার রিপোর্ট টেম্পলেট এডিটর (.docx ও ফর্ম পারমিশন)
              </h2>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={tplUploading}
                onClick={() => docxInputRef.current?.click()}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-teal-700 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-teal-800"
              >
                {tplUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                Word (.docx) আপলোড
              </button>
              <button
                type="button"
                onClick={resetNewTemplate}
                className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                <Plus className="h-3.5 w-3.5" />
                নতুন
              </button>
            </div>
          </div>

          {templates.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {templates.map((t) => (
                <div
                  key={t.id}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold ${
                    tplId === t.id
                      ? 'border-rose-700 bg-rose-50 text-rose-900'
                      : 'border-slate-200 bg-slate-50 text-slate-800'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => loadTemplateIntoMaster(t)}
                    className="hover:underline"
                  >
                    {t.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteTemplate(t.id)}
                    className="text-slate-400 hover:text-red-700"
                    aria-label="মুছুন"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5 sm:items-end">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                টেম্পলেট টাইটেল (Title)
              </label>
              <input
                type="text"
                value={tplTitle}
                onChange={(e) => setTplTitle(e.target.value)}
                placeholder="যেমন: মাসিক চালান প্রত্যয়ন / চাহিদাপত্র"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                বিভাগ / খাত
              </label>
              <input
                type="text"
                value={tplCategory}
                onChange={(e) => setTplCategory(e.target.value)}
                placeholder="যেমন: খাদ্যশস্য / প্রত্যয়ন"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                ডিফল্ট স্মারক নং
              </label>
              <input
                type="text"
                value={tplDefaultMemo}
                onChange={(e) => setTplDefaultMemo(e.target.value)}
                className="font-mono-num w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                পেজ মোড
              </label>
              <select
                value={tplOrientation}
                onChange={(e) =>
                  setTplOrientation(
                    e.target.value === 'landscape' ? 'landscape' : 'portrait'
                  )
                }
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-900"
              >
                <option value="portrait">পোর্ট্রেট (Portrait)</option>
                <option value="landscape">ল্যান্ডস্কেপ (Landscape)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 sm:items-center">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                ডিফল্ট প্রাপক ({"{{প্রাপক}}"})
              </label>
              <input
                type="text"
                value={tplDefaultRecipient}
                onChange={(e) => setTplDefaultRecipient(e.target.value)}
                placeholder="জেলা খাদ্য নিয়ন্ত্রক / সংশ্লিষ্ট ডিলার"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
            </div>

            <div>
              <div className="mb-1 text-xs font-semibold text-slate-600">
                টেমপ্লেট ব্যবহারকারী যা এডিট করতে পারবেন (অন্য লেখা লক থাকবে):
              </div>
              <div className="flex flex-wrap gap-3 text-xs font-semibold text-slate-700">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={tplEditableFields.allowDate}
                    onChange={(e) =>
                      setTplEditableFields((p) => ({
                        ...p,
                        allowDate: e.target.checked,
                      }))
                    }
                    className="h-3.5 w-3.5"
                  />
                  তারিখ
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={tplEditableFields.allowMemo}
                    onChange={(e) =>
                      setTplEditableFields((p) => ({
                        ...p,
                        allowMemo: e.target.checked,
                      }))
                    }
                    className="h-3.5 w-3.5"
                  />
                  স্মারক নং
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={tplEditableFields.allowRecipient}
                    onChange={(e) =>
                      setTplEditableFields((p) => ({
                        ...p,
                        allowRecipient: e.target.checked,
                      }))
                    }
                    className="h-3.5 w-3.5"
                  />
                  প্রাপক
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={tplEditableFields.allowTableEdit}
                    onChange={(e) =>
                      setTplEditableFields((p) => ({
                        ...p,
                        allowTableEdit: e.target.checked,
                      }))
                    }
                    className="h-3.5 w-3.5"
                  />
                  টেবিলের ঘর পূরণ
                </label>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1.5">
            <button
              type="button"
              onClick={() => execMasterCmd('bold')}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white"
              title="Bold"
            >
              <Bold className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => execMasterCmd('italic')}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white"
              title="Italic"
            >
              <Italic className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => execMasterCmd('underline')}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white"
              title="Underline"
            >
              <Underline className="h-4 w-4" />
            </button>
            <div className="h-5 w-px bg-slate-300 mx-1" />
            <button
              type="button"
              onClick={() => execMasterCmd('justifyLeft')}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white"
              title="বামে"
            >
              <AlignLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => execMasterCmd('justifyCenter')}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white"
              title="মাঝে"
            >
              <AlignCenter className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => execMasterCmd('justifyRight')}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white"
              title="ডানে"
            >
              <AlignRight className="h-4 w-4" />
            </button>
            <div className="h-5 w-px bg-slate-300 mx-1" />
            <button
              type="button"
              onClick={insertMasterTable}
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-white border border-slate-200 px-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
            >
              <TableProperties className="h-3.5 w-3.5" />
              টেবিল
            </button>
            <button
              type="button"
              onClick={appendMasterTableRow}
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-white border border-slate-200 px-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
            >
              <Plus className="h-3.5 w-3.5" />
              সারি
            </button>
            <div className="h-5 w-px bg-slate-300 mx-1" />
            {[
              '{{তারিখ}}',
              '{{স্মারক}}',
              '{{প্রাপক}}',
              '{{অফিস}}',
              '{{কর্মকর্তা}}',
              '{{স্বাক্ষর}}',
            ].map((tok) => (
              <button
                key={tok}
                type="button"
                onClick={() => insertFieldToken(tok)}
                className="rounded-lg bg-rose-50 border border-rose-200 px-2 py-1 text-[11px] font-bold text-rose-800 hover:bg-rose-100"
              >
                {tok}
              </button>
            ))}
          </div>

          <div
            ref={masterEditorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={(e) => setTplHtmlContent(e.currentTarget.innerHTML)}
            className="template-doc-body font-nikosh min-h-[260px] rounded-xl border border-slate-300 bg-white p-5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
          />

          <div className="flex justify-end">
            <button
              type="button"
              disabled={tplSaving}
              onClick={() => void handleSaveMasterTemplate()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-60"
            >
              {tplSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              টেম্পলেট সেভ করুন
            </button>
          </div>
        </section>
      )}

      {/* SECTION 4: Khat (Category) Manager */}
      {activeSection === 'khats' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="border-b border-slate-200 pb-3">
            <h2 className="text-base font-bold text-slate-900">
              খাতের নাম ও ক্যাটেগরি সেটিংস
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-6 sm:items-end">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                নতুন খাতের নাম
              </label>
              <input
                type="text"
                value={newKhatName}
                onChange={(e) => setNewKhatName(e.target.value)}
                placeholder="যেমন: ভিজিএফ ঈদ"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                গ্রুপ
              </label>
              <select
                value={newKhatGroup}
                onChange={(e) => setNewKhatGroup(e.target.value as KhatGroup)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              >
                <option value="grain">খাদ্যশস্য</option>
                <option value="license">লাইসেন্স ও অন্যান্য</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                আইকন
              </label>
              <select
                value={newKhatIcon}
                onChange={(e) => setNewKhatIcon(e.target.value as KhatIconKey)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              >
                {ICON_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                রঙ
              </label>
              <select
                value={newKhatColor}
                onChange={(e) => setNewKhatColor(e.target.value as KhatColorKey)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              >
                {COLOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={handleAddKhat}
              className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl bg-rose-700 px-3 py-2 text-xs font-bold text-white hover:bg-rose-800 whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              যোগ করুন
            </button>

            <div className="sm:col-span-6 flex flex-wrap gap-4 pt-1 text-xs text-slate-700">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={newKhatHasTax}
                  onChange={(e) => setNewKhatHasTax(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                আয়কর স্ক্যান বাটন
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={newKhatHasVat}
                  onChange={(e) => setNewKhatHasVat(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                ভ্যাট স্ক্যান বাটন
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={newKhatShowQty}
                  onChange={(e) => setNewKhatShowQty(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                পরিমাণ (মে. টন) ও দর
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {draft.khats.map((khat) => (
              <div
                key={khat.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                    {renderKhatIcon(khat.iconKey, 'h-4 w-4')}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-slate-900">
                      {khat.name}
                    </div>
                    <div className="text-xs text-slate-500">
                      {khat.group === 'grain'
                        ? 'খাদ্যশস্য'
                        : 'লাইসেন্স ও অন্যান্য'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => toggleKhatActive(khat.id)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                      khat.active
                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                        : 'bg-slate-100 text-slate-500 border border-slate-200'
                    }`}
                  >
                    {khat.active ? 'সক্রিয়' : 'বন্ধ'}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeKhat(khat.id)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700"
                    aria-label="খাত মুছুন"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* SECTION 5: License Fees & Custom Sheet Columns */}
      {activeSection === 'fees' && (
        <div className="space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
            <div className="border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">
                লাইসেন্সের মূল্য, নবায়ন, ভ্যাট ও আয়কর সেটিংস
              </h2>
              <p className="text-xs text-slate-500">
                স্ক্যান ও রেজিস্টারে সরকারি নির্ধারিত মূল্য হিসেবে এই হার ব্যবহৃত হবে
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 font-bold text-slate-600">
                    <th className="px-3 py-2.5">লাইসেন্স খাত</th>
                    <th className="px-3 py-2.5 text-right">নতুন মূল্য (৳)</th>
                    <th className="px-3 py-2.5 text-right">নবায়ন মূল্য (৳)</th>
                    <th className="px-3 py-2.5 text-right">ভ্যাট (৳)</th>
                    <th className="px-3 py-2.5 text-right">আয়কর (৳)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {draft.licenseFees.map((fee) => (
                    <tr key={fee.khatName}>
                      <td className="px-3 py-2 font-bold text-slate-900 whitespace-nowrap">
                        {fee.khatName}
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="number"
                          min={0}
                          value={fee.newFee}
                          onChange={(e) =>
                            updateLicenseFee(fee.khatName, 'newFee', e.target.value)
                          }
                          className="font-mono-num w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-right text-xs font-bold"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="number"
                          min={0}
                          value={fee.renewalFee}
                          onChange={(e) =>
                            updateLicenseFee(
                              fee.khatName,
                              'renewalFee',
                              e.target.value
                            )
                          }
                          className="font-mono-num w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-right text-xs font-bold"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="number"
                          min={0}
                          value={fee.vatAmount}
                          onChange={(e) =>
                            updateLicenseFee(
                              fee.khatName,
                              'vatAmount',
                              e.target.value
                            )
                          }
                          className="font-mono-num w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-right text-xs font-bold"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="number"
                          min={0}
                          value={fee.taxAmount}
                          onChange={(e) =>
                            updateLicenseFee(
                              fee.khatName,
                              'taxAmount',
                              e.target.value
                            )
                          }
                          className="font-mono-num w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-right text-xs font-bold"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">
                কাস্টম রেজিস্টার ও শিট কলাম যোগ করুন
              </h2>
              <p className="text-xs text-slate-500">
                R কলামের পরে S (ভ্যাট নং), T (ভ্যাট তারিখ), U (ভ্যাট টাকা), V
                (লাইসেন্স নং), W (জমা কোড) সংরক্ষিত আছে — X, Y, Z... কলামে বাড়তি
                তথ্য যুক্ত করুন
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-5 sm:items-end">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  কলামের শিরোনাম
                </label>
                <input
                  type="text"
                  value={newColLabel}
                  onChange={(e) => setNewColLabel(e.target.value)}
                  placeholder="যেমন: মোবাইল নং / স্মারক"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  Sheet কলাম (X, Y, Z...)
                </label>
                <input
                  type="text"
                  maxLength={2}
                  value={newColLetter}
                  onChange={(e) => setNewColLetter(e.target.value.toUpperCase())}
                  className="font-mono-num w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-900"
                />
              </div>

              <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-700">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={newColGrain}
                    onChange={(e) => setNewColGrain(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  খাদ্যশস্য রেজিস্টার
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={newColLicense}
                    onChange={(e) => setNewColLicense(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  লাইসেন্স রেজিস্টার
                </label>
              </div>

              <button
                type="button"
                onClick={handleAddCustomColumn}
                className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl bg-rose-700 px-3 py-2 text-xs font-bold text-white hover:bg-rose-800"
              >
                <Plus className="h-4 w-4" />
                কলাম যোগ
              </button>
            </div>

            {(draft.customColumns || []).length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(draft.customColumns || []).map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  >
                    <div>
                      <span className="font-bold text-slate-900">{c.label}</span>
                      <span className="font-mono-num ml-2 text-slate-500">
                        Col {c.sheetColumn}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeCustomColumn(c.id)}
                      className="rounded-lg p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* SECTION 6: Full Source Code ZIP / Bundle & GitHub Workflows */}
      {activeSection === 'backup' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
                <Code2 className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  সম্পূর্ণ সোর্স কোড (.zip / .txt) ও GitHub / Android APK
                </h2>
                <p className="text-xs text-slate-500">
                  ZIP ফাইল ডাউনলোড করে সরাসরি GitHub-এ আপলোড করুন এবং নিচের কোড দিয়ে স্বয়ংক্রিয়ভাবে Extract ও APK বিল্ড করুন
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={downloadingZip}
                onClick={() => void handleDownloadSourceZip()}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-60 whitespace-nowrap cursor-pointer"
              >
                {downloadingZip ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                সোর্স কোড (.zip) ডাউনলোড
              </button>

              <button
                type="button"
                disabled={downloadingSource}
                onClick={() => void handleDownloadSourceBundle()}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-indigo-700 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-800 disabled:opacity-60 whitespace-nowrap cursor-pointer"
              >
                {downloadingSource ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                সোর্স কোড (.txt) ডাউনলোড
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-extrabold text-slate-900">
                    ১. GitHub-এ ZIP এক্সট্রাক্ট করার কোড
                  </h3>
                  <p className="text-[11px] text-slate-600">
                    ফাইলের নাম দিন: <code className="font-mono-num font-bold">.github/workflows/extract-zip.yml</code>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void handleCopyWorkflow('extract', githubExtractWorkflowYaml)
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-800 hover:bg-slate-100 shrink-0 cursor-pointer"
                >
                  {copiedWorkflow === 'extract' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                      কপি হয়েছে
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      কপি করুন
                    </>
                  )}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-900 p-3 font-mono text-[11px] text-slate-100">
                {githubExtractWorkflowYaml}
              </pre>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-extrabold text-slate-900">
                    ২. GitHub থেকে Android APK বিল্ড করার কোড
                  </h3>
                  <p className="text-[11px] text-slate-600">
                    ফাইলের নাম দিন: <code className="font-mono-num font-bold">.github/workflows/build-apk.yml</code>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void handleCopyWorkflow('apk', githubApkWorkflowYaml)
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-800 hover:bg-slate-100 shrink-0 cursor-pointer"
                >
                  {copiedWorkflow === 'apk' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                      কপি হয়েছে
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      কপি করুন
                    </>
                  )}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-900 p-3 font-mono text-[11px] text-slate-100">
                {githubApkWorkflowYaml}
              </pre>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
            <div>
              <div className="text-sm font-bold text-slate-900">
                ডিলার, উপ-বরাদ্দ ও লাইসেন্স ডেটাবেস
              </div>
              <div className="text-xs text-slate-500">
                সকল ডিলার ও ফুড গ্রেইন লাইসেন্সধারীদের তালিকা পরিচালনা করুন
              </div>
            </div>

            <button
              type="button"
              onClick={onOpenDealersManager}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-300 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-800 hover:bg-slate-100"
            >
              <Database className="h-4 w-4" />
              ডিলার ও লাইসেন্স ব্যবস্থাপনা
            </button>
          </div>
        </section>
      )}

      {statusMsg && (
        <div
          role="status"
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium ${
            statusMsg.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {statusMsg.tone === 'success' && (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          )}
          <span>{statusMsg.text}</span>
        </div>
      )}

      {activeSection !== 'templates' && activeSection !== 'backup' && (
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-slate-900 px-6 py-3 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            সকল সেটিংস সংরক্ষণ করুন
          </button>
        </div>
      )}
    </form>
  );
}



