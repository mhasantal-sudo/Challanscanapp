import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import type { User } from 'firebase/auth';
import {
  FileText,
  Home,
  LayoutTemplate,
  ListChecks,
  Loader2,
  Lock,
  QrCode,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Unlock,
  Users,
  Wheat,
} from 'lucide-react';
import type {
  AppSettings,
  ChallanRecord,
  DealerRecord,
  LicenseeRecord,
  PermissionKey,
  ReportTemplate,
  SuballocationRecord,
  UserAccount,
} from './types.ts';
import { apiFetch, clearAuthToken, setAuthToken } from './utils/api.ts';
import { DEFAULT_SETTINGS, toBengaliDigits } from './utils/challan.ts';
import { initGoogleAuth } from './services/googleAuth.ts';
import {
  pullFromAppsScriptBridge,
  pullFromGoogleSheetsOAuth,
  pullFromPublicSheetBackend,
} from './services/googleSheets.ts';
import { LoginView } from './components/LoginView.tsx';
import { AdminPanelView } from './components/AdminPanelView.tsx';
import { ScanEntryView } from './components/ScanEntryView.tsx';
import { RecordsView } from './components/RecordsView.tsx';
import { ReportView } from './components/ReportView.tsx';
import { TemplatesView } from './components/TemplatesView.tsx';
import { DealersView } from './components/DealersView.tsx';
import {
  SettingsView,
  type SettingsSectionKey,
} from './components/SettingsView.tsx';

type ActiveTab =
  | 'scan'
  | 'records'
  | 'report'
  | 'templates'
  | 'dealers'
  | 'settings'
  | 'adminUsers';

export default function App() {
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [lockEnabled, setLockEnabled] = useState(false);

  const [activeTab, setActiveTab] = useState<ActiveTab>('scan');
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionKey>('sync');
  const [isFocusedScanMode, setIsFocusedScanMode] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [records, setRecords] = useState<ChallanRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const [dealers, setDealers] = useState<DealerRecord[]>([]);
  const [unions, setUnions] = useState<string[]>([]);
  const [licensees, setLicensees] = useState<LicenseeRecord[]>([]);
  const [suballocations, setSuballocations] = useState<SuballocationRecord[]>(
    []
  );
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [scanTriggerNonce, setScanTriggerNonce] = useState(0);

  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [hasGoogleToken, setHasGoogleToken] = useState(false);
  const [quickSyncing, setQuickSyncing] = useState(false);
  const [bannerStatus, setBannerStatus] = useState<string | null>(null);

  const navTouchStartXRef = useRef<number | null>(null);
  const didAutoSyncRef = useRef(false);

  const hasPerm = useCallback(
    (key: PermissionKey): boolean => {
      if (!currentUser) return false;
      if (currentUser.role === 'admin') return true;
      return Boolean(currentUser.permissions?.[key]);
    },
    [currentUser]
  );

  // Check existing session on mount (always clear loading even on 401/error)
  useEffect(() => {
    let active = true;
    async function checkSession() {
      try {
        const res = await apiFetch('/api/auth/me');
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          user?: UserAccount | null;
          lockEnabled?: boolean;
        };
        if (active && typeof data.lockEnabled === 'boolean') {
          setLockEnabled(data.lockEnabled);
        }
        if (res.ok && active && data.user) {
          setCurrentUser(data.user);
        } else if (res.status === 401) {
          clearAuthToken();
          if (active) {
            setCurrentUser(null);
          }
        }
      } catch {
        // Not logged in or server unavailable -> render LoginView
      } finally {
        if (active) {
          setAuthLoading(false);
        }
      }
    }
    void checkSession();

    const handleAuthExpired = () => {
      clearAuthToken();
      void checkSession();
    };
    window.addEventListener('challan-auth-expired', handleAuthExpired);
    return () => {
      active = false;
      window.removeEventListener('challan-auth-expired', handleAuthExpired);
    };
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings');
      const json = (await res.json()) as {
        success: boolean;
        settings?: AppSettings;
      };
      if (res.ok && json.success && json.settings) {
        setSettings(json.settings);
        setLockEnabled(Boolean(json.settings.lockEnabled));
      }
    } catch {
      // keep default settings
    }
  }, []);

  const fetchRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      const res = await apiFetch('/api/challans');
      const json = (await res.json()) as {
        success: boolean;
        records?: ChallanRecord[];
      };
      if (res.ok && json.success) {
        setRecords(json.records || []);
      }
    } catch {
      // ignore initial fetch error
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  const fetchDealers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/dealers');
      const json = (await res.json()) as {
        success: boolean;
        unions?: string[];
        dealers?: DealerRecord[];
      };
      if (res.ok && json.success) {
        setUnions(json.unions || []);
        setDealers(json.dealers || []);
      }
    } catch {
      // ignore initial fetch error
    }
  }, []);

  const fetchLicensees = useCallback(async () => {
    try {
      const res = await apiFetch('/api/licensees');
      const json = (await res.json()) as {
        success: boolean;
        licensees?: LicenseeRecord[];
      };
      if (res.ok && json.success) {
        setLicensees(json.licensees || []);
      }
    } catch {
      // ignore initial fetch error
    }
  }, []);

  const fetchSuballocations = useCallback(async () => {
    try {
      const res = await apiFetch('/api/suballocations');
      const json = (await res.json()) as {
        success: boolean;
        suballocations?: SuballocationRecord[];
      };
      if (res.ok && json.success) {
        setSuballocations(json.suballocations || []);
      }
    } catch {
      // ignore initial fetch error
    }
  }, []);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await apiFetch('/api/templates');
      const json = (await res.json()) as {
        success: boolean;
        templates?: ReportTemplate[];
      };
      if (res.ok && json.success) {
        setTemplates(json.templates || []);
      }
    } catch {
      // ignore initial fetch error
    }
  }, []);

  const refreshAllData = useCallback(() => {
    if (!currentUser) return;
    if (hasPerm('records') || hasPerm('scan')) {
      void fetchRecords();
    }
    void fetchDealers();
    void fetchLicensees();
    void fetchSuballocations();
    if (hasPerm('templates') || hasPerm('settings')) {
      void fetchTemplates();
    }
  }, [
    currentUser,
    hasPerm,
    fetchRecords,
    fetchDealers,
    fetchLicensees,
    fetchSuballocations,
    fetchTemplates,
  ]);

  useEffect(() => {
    if (!currentUser) {
      didAutoSyncRef.current = false;
      return;
    }
    void fetchSettings();
    refreshAllData();
  }, [currentUser, fetchSettings, refreshAllData]);

  const performSheetSync = useCallback(async (): Promise<string> => {
    const formatRemoved = (n?: number) =>
      n && n > 0 ? ` (শিট থেকে মোছা ${n}টি সরানো হয়েছে)` : '';

    if (hasGoogleToken) {
      try {
        const payload = await pullFromGoogleSheetsOAuth(settings);
        const res = await apiFetch('/api/sync/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            counts?: {
              dealers: number;
              suballocations: number;
              records: number;
              removedRecords?: number;
            };
          };
          refreshAllData();
          return `সিঙ্কড: ডিলার ${json.counts?.dealers ?? 0}, উপ-বরাদ্দ ${json.counts?.suballocations ?? 0}, চালান ${json.counts?.records ?? 0}${formatRemoved(json.counts?.removedRecords)}`;
        }
      } catch {
        // fall through to backend / Apps Script sync
      }
    }

    if (settings.gasWebAppUrl.trim() && settings.syncMethod === 'apps_script') {
      const payload = await pullFromAppsScriptBridge(
        settings.gasWebAppUrl.trim(),
        settings
      );
      const res = await apiFetch('/api/sync/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          counts?: {
            dealers: number;
            suballocations: number;
            records: number;
            removedRecords?: number;
          };
        };
        refreshAllData();
        return `Apps Script সিঙ্কড: চালান ${json.counts?.records ?? 0}${formatRemoved(json.counts?.removedRecords)}`;
      }
    }

    try {
      const pub = await pullFromPublicSheetBackend(settings);
      refreshAllData();
      return `সিঙ্কড: ডিলার ${pub.counts?.dealers ?? 0}, উপ-বরাদ্দ ${pub.counts?.suballocations ?? 0}, চালান ${pub.counts?.records ?? 0}${formatRemoved(pub.counts?.removedRecords)}`;
    } catch (pubErr) {
      if (settings.gasWebAppUrl.trim()) {
        const payload = await pullFromAppsScriptBridge(
          settings.gasWebAppUrl.trim(),
          settings
        );
        const res = await apiFetch('/api/sync/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            counts?: {
              dealers: number;
              suballocations: number;
              records: number;
              removedRecords?: number;
            };
          };
          refreshAllData();
          return `Apps Script সিঙ্কড: চালান ${json.counts?.records ?? 0}${formatRemoved(json.counts?.removedRecords)}`;
        }
      }
      throw pubErr;
    }
  }, [hasGoogleToken, settings, refreshAllData]);

  useEffect(() => {
    if (!currentUser || !settings.spreadsheetId.trim()) return;
    if (didAutoSyncRef.current) return;
    didAutoSyncRef.current = true;
    void performSheetSync().catch(() => {
      // background auto-sync should fail silently without interrupting navigation
    });
  }, [currentUser, settings.spreadsheetId, performSheetSync]);

  useEffect(() => {
    const unsubscribe = initGoogleAuth(
      (user) => {
        setGoogleUser(user);
        setHasGoogleToken(true);
      },
      (user) => {
        setGoogleUser(user);
        setHasGoogleToken(false);
      }
    );
    return () => unsubscribe();
  }, []);

  const navItems = useMemo(() => {
    const all: Array<{
      id: ActiveTab;
      perm: PermissionKey;
      label: string;
      shortLabel: string;
      icon: typeof Home;
    }> = [
      {
        id: 'scan',
        perm: 'scan',
        label: 'হোম ও স্ক্যান',
        shortLabel: 'হোম',
        icon: Home,
      },
      {
        id: 'records',
        perm: 'records',
        label: 'চালান তালিকা',
        shortLabel: 'তালিকা',
        icon: ListChecks,
      },
      {
        id: 'report',
        perm: 'report',
        label: 'রেজিস্টার',
        shortLabel: 'রেজিস্টার',
        icon: FileText,
      },
      {
        id: 'templates',
        perm: 'templates',
        label: 'টেম্পলেট',
        shortLabel: 'টেম্পলেট',
        icon: LayoutTemplate,
      },
      {
        id: 'dealers',
        perm: 'dealers',
        label: 'ডিলার ও লাইসেন্স',
        shortLabel: 'ডিলার',
        icon: Users,
      },
      {
        id: 'settings',
        perm: 'settings',
        label: 'সেটিংস',
        shortLabel: 'সেটিংস',
        icon: Settings,
      },
      {
        id: 'adminUsers',
        perm: 'adminUsers',
        label: 'এডমিন',
        shortLabel: 'এডমিন',
        icon: ShieldCheck,
      },
    ];
    return all.filter((item) => hasPerm(item.perm));
  }, [hasPerm]);

  // Keep activeTab always on a permitted tab
  useEffect(() => {
    if (!currentUser || navItems.length === 0) return;
    if (!navItems.some((item) => item.id === activeTab)) {
      setActiveTab(navItems[0].id);
    }
  }, [currentUser, navItems, activeTab]);

  function switchTab(next: ActiveTab, nextSettingsSec?: SettingsSectionKey) {
    const allowed = navItems.some((item) => item.id === next);
    if (!allowed) return;
    if (next !== 'scan') {
      setIsFocusedScanMode(false);
    }
    if (next === 'settings' && nextSettingsSec) {
      setSettingsSection(nextSettingsSec);
    }
    setActiveTab(next);
  }

  async function handleLogout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // clear local session regardless
    }
    clearAuthToken();
    setCurrentUser(null);
    setBannerStatus(null);
  }

  async function handleSaveSettings(next: AppSettings) {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    const json = (await res.json()) as {
      success: boolean;
      settings?: AppSettings;
      token?: string;
      message?: string;
    };
    if (!res.ok || !json.success || !json.settings) {
      throw new Error(json.message || 'সেটিংস সংরক্ষণ করা যায়নি।');
    }
    if (json.token) {
      setAuthToken(json.token);
    }
    setSettings(json.settings);
    setLockEnabled(Boolean(json.settings.lockEnabled));
  }

  async function handleQuickSyncFromHeader() {
    setQuickSyncing(true);
    setBannerStatus(null);
    try {
      const msg = await performSheetSync();
      setBannerStatus(msg);
    } catch {
      if (hasPerm('settings')) {
        switchTab('settings', 'sync');
      }
    } finally {
      setQuickSyncing(false);
    }
  }

  function handleQuickScan() {
    if (!hasPerm('scan')) return;
    switchTab('scan');
    setScanTriggerNonce((n) => n + 1);
  }

  function handleNavTouchStart(e: TouchEvent<HTMLElement>) {
    navTouchStartXRef.current = e.changedTouches[0]?.clientX ?? null;
  }

  function handleNavTouchEnd(e: TouchEvent<HTMLElement>) {
    if (navTouchStartXRef.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? navTouchStartXRef.current;
    const dx = endX - navTouchStartXRef.current;
    navTouchStartXRef.current = null;
    if (Math.abs(dx) < 55) return;
    const order = navItems.map((n) => n.id);
    const idx = order.indexOf(activeTab);
    if (dx < 0 && idx < order.length - 1) {
      switchTab(order[idx + 1]);
    } else if (dx > 0 && idx > 0) {
      switchTab(order[idx - 1]);
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 text-slate-700">
        <Loader2 className="h-8 w-8 animate-spin text-rose-700" />
        <p className="text-sm font-bold">পোর্টাল লোড হচ্ছে...</p>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginView
        onLoginSuccess={(user) => setCurrentUser(user)}
        lockEnabled={lockEnabled}
      />
    );
  }

  const isEmailAuthorized =
    !hasGoogleToken ||
    !googleUser?.email ||
    settings.allowedEmails.length === 0 ||
    settings.allowedEmails.some(
      (em) => em.trim().toLowerCase() === googleUser.email!.toLowerCase()
    );

  const syncSummaryText = hasGoogleToken
    ? 'Google Sheet সংযুক্ত'
    : settings.gasWebAppUrl.trim()
      ? 'Apps Script সক্রিয়'
      : bannerStatus || 'Sheet সংযোগ';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Vibrant Rose-Magenta Office Banner Header (minimized in focused scan mode) */}
      <header className="no-print bg-gradient-to-br from-rose-700 via-rose-600 to-pink-600 text-white">
        {!(activeTab === 'scan' && isFocusedScanMode) && (
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
            <button
              type="button"
              onClick={() => navItems[0] && switchTab(navItems[0].id)}
              className="flex items-center gap-3 text-left min-w-0"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-800/95 ring-2 ring-white/40">
                <Wheat className="h-5 w-5 text-amber-300" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-lg font-extrabold tracking-tight sm:text-xl">
                  {settings.officeTitle}
                </div>
                <div className="truncate text-xs font-medium text-rose-100">
                  {bannerStatus || settings.officeSubtitle}
                </div>
              </div>
            </button>

            <div className="flex items-center gap-2 shrink-0">
              <div className="hidden sm:flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white">
                <span className="truncate max-w-[130px]">{currentUser.name}</span>
                <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px]">
                  {currentUser.role === 'admin' ? 'এডমিন' : 'অপারেটর'}
                </span>
              </div>

              {hasPerm('settings') && (
                <button
                  type="button"
                  onClick={() => void handleQuickSyncFromHeader()}
                  disabled={quickSyncing}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-rose-700 hover:bg-rose-50 transition-colors"
                  aria-label={syncSummaryText}
                  title={syncSummaryText}
                >
                  {quickSyncing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </button>
              )}

              {hasPerm('scan') && (
                <button
                  type="button"
                  onClick={handleQuickScan}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <QrCode className="h-4 w-4" />
                  <span>স্ক্যান</span>
                </button>
              )}

              {lockEnabled ? (
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  title="পাসওয়ার্ড লক করুন"
                  aria-label="পাসওয়ার্ড লক করুন"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-rose-900/50 text-white hover:bg-rose-900 transition-colors"
                >
                  <Lock className="h-4 w-4" />
                </button>
              ) : (
                hasPerm('settings') && (
                  <button
                    type="button"
                    onClick={() => switchTab('settings', 'sync')}
                    title="লক বন্ধ (আনলক অবস্থায় আছে) — সেটিংসে গিয়ে চালু করুন"
                    aria-label="লক সিস্টেম সেটিংস"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 transition-colors"
                  >
                    <Unlock className="h-4 w-4" />
                  </button>
                )
              )}
            </div>
          </div>
        )}

        {/* Desktop Sub-Navigation Bar */}
        <nav
          aria-label="প্রধান নেভিগেশন"
          className="hidden md:block border-t border-white/15 bg-rose-800/35"
        >
          <div className="mx-auto flex max-w-6xl items-center gap-5 overflow-x-auto px-6">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => switchTab(item.id)}
                  className={`inline-flex items-center gap-2 border-b-2 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'border-white text-white'
                      : 'border-transparent text-rose-100 hover:text-white'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-4 pt-4 pb-24 sm:px-6 md:pb-8">
        {!isEmailAuthorized && (
          <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-bold text-amber-900">
            <span className="inline-flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4 text-amber-700" />
              {googleUser?.email} অনুমতি তালিকায় নেই।
            </span>
            {hasPerm('settings') && (
              <button
                type="button"
                onClick={() => switchTab('settings', 'sync')}
                className="rounded-xl bg-amber-900 px-3 py-1 text-[11px] text-white"
              >
                পারমিশন যোগ করুন
              </button>
            )}
          </div>
        )}

        {!(activeTab === 'scan' && isFocusedScanMode) && (
          <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
            <h1 className="text-base font-bold text-slate-900 sm:text-lg">
              {activeTab === 'scan' && 'খাত নির্বাচন ও চালান স্ক্যান'}
              {activeTab === 'records' && 'সংরক্ষিত চালান তালিকা'}
              {activeTab === 'report' && 'চালান রেজিস্টার ও প্রিন্ট'}
              {activeTab === 'templates' && 'প্রতিবেদন ও টেম্পলেট'}
              {activeTab === 'dealers' && 'ডিলার, উপ-বরাদ্দ ও লাইসেন্স তালিকা'}
              {activeTab === 'settings' && 'সেটিংস, টেমপ্লেট ও Google Sheet'}
              {activeTab === 'adminUsers' && 'এডমিন ও ইউজার এক্সেস কন্ট্রোল'}
            </h1>

            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
              <span>চালান: {toBengaliDigits(records.length)}টি</span>
              <span aria-hidden="true">·</span>
              <span>ডিলার: {toBengaliDigits(dealers.length)}</span>
              <span aria-hidden="true">·</span>
              <span>লাইসেন্স: {toBengaliDigits(licensees.length)}</span>
            </div>
          </div>
        )}

        {navItems.length === 0 ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 text-center text-sm font-bold text-amber-900">
            আপনার অ্যাকাউন্টে এখনো কোনো বাটনের অনুমতি দেওয়া হয়নি। এডমিনের সাথে যোগাযোগ করুন।
          </div>
        ) : (
          <>
            {activeTab === 'scan' && hasPerm('scan') && (
              <ScanEntryView
                settings={settings}
                dealers={dealers}
                unions={unions}
                licensees={licensees}
                suballocations={suballocations}
                records={records}
                canOpenSettings={hasPerm('settings')}
                onSaved={refreshAllData}
                onOpenSettings={() => switchTab('settings', 'khats')}
                onOpenSheetSettings={() => switchTab('settings', 'sync')}
                onOpenAllRecords={() => switchTab('records')}
                onFocusModeChange={setIsFocusedScanMode}
                externalScanRequestNonce={scanTriggerNonce}
              />
            )}

            {activeTab === 'records' && hasPerm('records') && (
              <RecordsView
                records={records}
                loading={recordsLoading}
                settings={settings}
                khats={settings.khats}
                customColumns={settings.customColumns}
                hideDealerIds={settings.hideDealerIds}
                canEdit={hasPerm('recordEdit')}
                canDelete={hasPerm('recordDelete')}
                canImport={hasPerm('scan') || hasPerm('recordEdit')}
                onRefresh={refreshAllData}
              />
            )}

            {activeTab === 'report' && hasPerm('report') && (
              <ReportView
                unions={unions}
                khats={settings.khats}
                settings={settings}
                recordsCount={records.length}
                onSyncSheet={handleQuickSyncFromHeader}
                syncing={quickSyncing}
              />
            )}

            {activeTab === 'templates' && hasPerm('templates') && (
              <TemplatesView
                templates={templates}
                settings={settings}
                canEditMaster={hasPerm('settings')}
                onRefreshTemplates={() => void fetchTemplates()}
                onOpenMasterEditor={() => switchTab('settings', 'templates')}
              />
            )}

            {activeTab === 'dealers' && hasPerm('dealers') && (
              <DealersView
                dealers={dealers}
                unions={unions}
                licensees={licensees}
                suballocations={suballocations}
                khats={settings.khats}
                hideDealerIds={settings.hideDealerIds}
                onRefresh={refreshAllData}
              />
            )}

            {activeTab === 'settings' && hasPerm('settings') && (
              <SettingsView
                settings={settings}
                templates={templates}
                initialSection={settingsSection}
                googleUser={googleUser}
                hasGoogleToken={hasGoogleToken}
                onSaveSettings={handleSaveSettings}
                onSyncedFromSheet={refreshAllData}
                onRefreshTemplates={() => void fetchTemplates()}
                onOpenDealersManager={() => switchTab('dealers')}
              />
            )}

            {activeTab === 'adminUsers' && hasPerm('adminUsers') && (
              <AdminPanelView />
            )}
          </>
        )}
      </main>

      {/* Mobile Fixed Bottom Tab Bar */}
      {navItems.length > 0 && (
        <nav
          aria-label="মোবাইল নিচের নেভিগেশন"
          onTouchStart={handleNavTouchStart}
          onTouchEnd={handleNavTouchEnd}
          className="no-print fixed inset-x-0 bottom-0 z-30 flex h-16 items-center justify-around border-t border-slate-200 bg-white px-0.5 md:hidden"
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => switchTab(item.id)}
                className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 py-1 text-[10px] font-semibold transition-colors whitespace-nowrap ${
                  isActive
                    ? 'text-rose-700'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <Icon
                  className={`h-[18px] w-[18px] ${
                    isActive ? 'text-rose-700' : ''
                  }`}
                />
                <span>{item.shortLabel}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
