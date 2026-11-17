import { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Download,
  FileBadge2,
  Plus,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import type {
  DealerRecord,
  KhatConfig,
  LicenseeRecord,
  SuballocationRecord,
} from '../types.ts';
import { apiFetch } from '../utils/api.ts';
import { formatMoney, toNumericValue } from '../utils/challan.ts';

interface DealersViewProps {
  dealers: DealerRecord[];
  unions: string[];
  licensees?: LicenseeRecord[];
  suballocations?: SuballocationRecord[];
  khats?: KhatConfig[];
  hideDealerIds?: boolean;
  onRefresh: () => void;
}

type InnerTab = 'dealers' | 'suballocations' | 'licensees';

export function DealersView({
  dealers,
  unions,
  licensees = [],
  suballocations = [],
  khats = [],
  hideDealerIds = true,
  onRefresh,
}: DealersViewProps) {
  const [innerTab, setInnerTab] = useState<InnerTab>('dealers');
  const [unionName, setUnionName] = useState('');
  const [dealerName, setDealerName] = useState('');
  const [salesCenter, setSalesCenter] = useState('');
  const [category, setCategory] = useState('');
  const [filterUnion, setFilterUnion] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [showBulk, setShowBulk] = useState(false);

  const [subBulkText, setSubBulkText] = useState('');
  const [showSubBulk, setShowSubBulk] = useState(false);

  const [licName, setLicName] = useState('');
  const [licAddress, setLicAddress] = useState('');
  const [licType, setLicType] = useState('ফুড গ্রেইন লাইসেন্স (খুচরা)');
  const [licNo, setLicNo] = useState('');
  const [licFirstDate, setLicFirstDate] = useState('');
  const [licNid, setLicNid] = useState('');
  const [licBulkText, setLicBulkText] = useState('');
  const [showLicBulk, setShowLicBulk] = useState(false);
  const licFileInputRef = useRef<HTMLInputElement | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  const visibleDealers = useMemo(() => {
    if (!filterUnion) return dealers;
    return dealers.filter((d) => d.unionName === filterUnion);
  }, [dealers, filterUnion]);

  function downloadLicenseeTemplateCsv() {
    const headers = [
      'ক্রমিক নং',
      'লাইসেন্সধারীর নাম ও ঠিকানা',
      'লাইসেন্সের ধরণ',
      'লাইসেন্স নং',
      'প্রথম লাইসেন্স গ্রহণের তারিখ',
      'এনআইডি (ঐচ্ছিক)',
    ];
    const sampleRows = [
      [
        '1',
        'মোঃ আবুল কালাম, শিকারপুর বাজার, উজিরপুর',
        'ফুড গ্রেইন লাইসেন্স (খুচরা)',
        'UZP-RET-1001',
        '15/01/2024',
        '1985123456789',
      ],
      [
        '2',
        'মেসার্স রিয়াদ এন্টারপ্রাইজ, ইচলাদী, উজিরপুর',
        'ফুড গ্রেইন লাইসেন্স (পাইকারি)',
        'UZP-WHL-2001',
        '20/03/2023',
        '',
      ],
    ];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv =
      '\uFEFF' +
      [headers.map(esc).join(','), ...sampleRows.map((r) => r.map(esc).join(','))].join(
        '\r\n'
      );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Licensee_Upload_Template.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function parseCsvLine(line: string, sep: string): string[] {
    if (sep === '\t') return line.split('\t').map((c) => c.trim());
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  async function importLicenseesRawText(rawText: string) {
    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed: Array<Record<string, string>> = [];
    for (let i = 0; i < lines.length; i++) {
      const sep = lines[i].includes('\t') ? '\t' : ',';
      const cols = parseCsvLine(lines[i], sep);
      const joined = cols.join(' ').toLowerCase();
      if (
        i === 0 &&
        (joined.includes('ক্রমিক') ||
          joined.includes('লাইসেন্সধারীর') ||
          joined.includes('licenseno'))
      ) {
        continue;
      }
      if (cols.length >= 4) {
        const nameAndAddr = (cols[1] || '').trim();
        const commaIdx = nameAndAddr.indexOf(',');
        const licenseeName =
          commaIdx > 0 ? nameAndAddr.slice(0, commaIdx).trim() : nameAndAddr;
        const address =
          commaIdx > 0 ? nameAndAddr.slice(commaIdx + 1).trim() : '';
        parsed.push({
          licenseeName,
          address,
          licenseType: (cols[2] || '').trim() || 'ফুড গ্রেইন লাইসেন্স (খুচরা)',
          licenseNo: (cols[3] || '').trim(),
          firstIssueDate: (cols[4] || '').trim(),
          nid: (cols[5] || '').trim(),
        });
      }
    }

    if (parsed.length === 0) {
      setStatusMsg({
        tone: 'error',
        text: 'টেমপ্লেট কলাম অনুযায়ী বৈধ কোনো সারি পাওয়া যায়নি।',
      });
      return;
    }

    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch('/api/licensees/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licensees: parsed }),
      });
      const json = (await res.json()) as {
        success: boolean;
        added?: number;
        skipped?: number;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'লাইসেন্সধারী ইমপোর্ট ব্যর্থ');
      }
      setLicBulkText('');
      setShowLicBulk(false);
      setStatusMsg({
        tone: 'success',
        text: `নতুন লাইসেন্সধারী যুক্ত: ${json.added ?? 0} জন (বাদ: ${
          json.skipped ?? 0
        })।`,
      });
      onRefresh();
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'ইমপোর্ট ব্যর্থ হয়েছে।',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleLicenseeFileUpload(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    await importLicenseesRawText(text);
  }

  async function handleAddLicensee(e: React.FormEvent) {
    e.preventDefault();
    if (!licName.trim() || !licNo.trim()) {
      setStatusMsg({
        tone: 'error',
        text: 'লাইসেন্সধারীর নাম ও লাইসেন্স নং দিন।',
      });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch('/api/licensees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseeName: licName.trim(),
          address: licAddress.trim(),
          licenseType: licType,
          licenseNo: licNo.trim(),
          firstIssueDate: licFirstDate.trim(),
          nid: licNid.trim(),
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'যোগ করা যায়নি');
      }
      setLicName('');
      setLicAddress('');
      setLicNo('');
      setLicFirstDate('');
      setLicNid('');
      setStatusMsg({
        tone: 'success',
        text: 'লাইসেন্সধারী তালিকাভুক্ত হয়েছে।',
      });
      onRefresh();
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'যোগ করা যায়নি।',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteLicensee(id: string) {
    const res = await apiFetch(`/api/licensees/${id}`, { method: 'DELETE' });
    if (res.ok) onRefresh();
  }

  async function handleAddDealer(e: React.FormEvent) {
    e.preventDefault();
    if (!unionName.trim() || !dealerName.trim()) {
      setStatusMsg({
        tone: 'error',
        text: 'ইউনিয়নের নাম এবং ডিলারের নাম অবশ্যই দিতে হবে।',
      });
      return;
    }

    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch('/api/dealers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unionName: unionName.trim(),
          dealerName: dealerName.trim(),
          salesCenter: salesCenter.trim(),
          category: category.trim(),
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'ডিলার যোগ করা যায়নি');
      }
      setDealerName('');
      setSalesCenter('');
      setStatusMsg({
        tone: 'success',
        text: 'ডিলার সফলভাবে তালিকাভুক্ত হয়েছে।',
      });
      onRefresh();
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'ডিলার যোগ করা যায়নি।',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkImportDealers() {
    const raw = bulkText.trim();
    if (!raw) {
      setStatusMsg({
        tone: 'error',
        text: 'Food_Dealer শিট থেকে কপি করা সারি অথবা JSON পেস্ট করুন।',
      });
      return;
    }

    let parsedDealers: Array<{
      id?: string;
      unionName: string;
      dealerName: string;
      salesCenter: string;
      category?: string;
    }> = [];

    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        const obj = JSON.parse(raw) as
          | { dealers?: Array<Record<string, unknown>> }
          | Array<Record<string, unknown>>;
        const list = Array.isArray(obj)
          ? obj
          : Array.isArray(obj.dealers)
          ? obj.dealers
          : [];
        parsedDealers = list.map((d) => ({
          id: String(d.id || ''),
          unionName: String(d.unionName || '').trim(),
          dealerName: String(d.dealerName || '').trim(),
          salesCenter: String(d.salesCenter || '').trim(),
          category: String(d.category || '').trim(),
        }));
      } catch {
        setStatusMsg({
          tone: 'error',
          text: 'JSON ফরম্যাট সঠিক নয়।',
        });
        return;
      }
    } else {
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const cols = lines[i].includes('\t')
          ? lines[i].split('\t')
          : lines[i].split(',');
        const first = (cols[0] || '').trim().toLowerCase();
        if (
          i === 0 &&
          (first === 'id' || first.includes('ইউনিয়ন') || first === 'unionname')
        ) {
          continue;
        }
        if (
          cols.length >= 6 &&
          (/^(df|fd|dlr)-/i.test(cols[0].trim()) || cols[0].trim().length > 10)
        ) {
          parsedDealers.push({
            id: cols[0].trim(),
            dealerName: (cols[1] || '').trim(),
            unionName: (cols[5] || '').trim() || 'অন্যান্য',
            salesCenter: (cols[6] || '').trim(),
            category: 'খাদ্য বান্ধব',
          });
        } else if (cols.length >= 2) {
          parsedDealers.push({
            unionName: cols[0].trim(),
            dealerName: cols[1].trim(),
            salesCenter: (cols[2] || '').trim(),
            category: (cols[3] || '').trim(),
          });
        }
      }
    }

    if (parsedDealers.length === 0) {
      setStatusMsg({
        tone: 'error',
        text: 'কোনো বৈধ ডিলার তথ্য পাওয়া যায়নি।',
      });
      return;
    }

    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch('/api/dealers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealers: parsedDealers }),
      });
      const json = (await res.json()) as {
        success: boolean;
        added?: number;
        skipped?: number;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'ইমপোর্ট ব্যর্থ হয়েছে');
      }
      setBulkText('');
      setShowBulk(false);
      setStatusMsg({
        tone: 'success',
        text: `নতুন ডিলার ${json.added ?? 0} জন, বাদ ${json.skipped ?? 0}টি।`,
      });
      onRefresh();
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'ইমপোর্ট ব্যর্থ হয়েছে।',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkImportSuballocations() {
    const raw = subBulkText.trim();
    if (!raw) {
      setStatusMsg({
        tone: 'error',
        text: 'Dealer_Suballocation শিট থেকে কপি করা সারি পেস্ট করুন।',
      });
      return;
    }

    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed: Array<Record<string, unknown>> = [];
    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].includes('\t')
        ? lines[i].split('\t')
        : lines[i].split(',');
      const joinedHeader = cols.join(' ').toLowerCase();
      if (
        i === 0 &&
        (joinedHeader.includes('cardcount') ||
          joinedHeader.includes('totalamount') ||
          joinedHeader.includes('allocationqty'))
      ) {
        continue;
      }

      if (cols.length >= 14) {
        parsed.push({
          dealerName: (cols[1] || cols[2] || cols[3] || '').trim(),
          unionName: (cols[4] || cols[5] || '').trim(),
          category: (cols[6] || '').trim(),
          cardCount: toNumericValue(cols[7]),
          unusedCards: toNumericValue(cols[8]),
          allocationQty: toNumericValue(cols[9]),
          totalAmount: toNumericValue(cols[10]),
          taxAmount: toNumericValue(cols[11]),
          createdAt: (cols[12] || '').trim(),
          id: (cols[13] || '').trim(),
        });
      } else if (cols.length >= 7) {
        parsed.push({
          dealerName: '',
          cardCount: toNumericValue(cols[0]),
          unusedCards: toNumericValue(cols[1]),
          allocationQty: toNumericValue(cols[2]),
          totalAmount: toNumericValue(cols[3]),
          taxAmount: toNumericValue(cols[4]),
          createdAt: (cols[5] || '').trim(),
          id: (cols[6] || '').trim(),
        });
      }
    }

    if (parsed.length === 0) {
      setStatusMsg({
        tone: 'error',
        text: 'Dealer_Suballocation কলাম ফরম্যাট অনুযায়ী সারি পাওয়া যায়নি।',
      });
      return;
    }

    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch('/api/suballocations/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suballocations: parsed }),
      });
      const json = (await res.json()) as {
        success: boolean;
        added?: number;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'উপ-বরাদ্দ ইমপোর্ট ব্যর্থ হয়েছে।');
      }
      setSubBulkText('');
      setShowSubBulk(false);
      setStatusMsg({
        tone: 'success',
        text: `Dealer_Suballocation থেকে নতুন ${json.added ?? 0}টি সারি ইমপোর্ট হয়েছে।`,
      });
      onRefresh();
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'উপ-বরাদ্দ ইমপোর্ট ব্যর্থ হয়েছে।',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteDealer(id: string) {
    try {
      const res = await apiFetch(`/api/dealers/${id}`, { method: 'DELETE' });
      if (res.ok) onRefresh();
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => {
              setInnerTab('dealers');
              setStatusMsg(null);
            }}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
              innerTab === 'dealers'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            ডিলার ({dealers.length})
          </button>

          <button
            type="button"
            onClick={() => {
              setInnerTab('suballocations');
              setStatusMsg(null);
            }}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
              innerTab === 'suballocations'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Database className="h-3.5 w-3.5" />
            উপ-বরাদ্দ ({suballocations.length})
          </button>

          <button
            type="button"
            onClick={() => {
              setInnerTab('licensees');
              setStatusMsg(null);
            }}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
              innerTab === 'licensees'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileBadge2 className="h-3.5 w-3.5" />
            খুচরা ও পাইকারি লাইসেন্স ({licensees.length})
          </button>
        </div>
      </div>

      {innerTab === 'dealers' && (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  ডিলার ও ইউনিয়ন মাস্টার
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  ইউনিয়ন: {unions.length}টি · ডিলার: {dealers.length} জন
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowBulk(!showBulk)}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <Upload className="h-3.5 w-3.5" />
                {showBulk ? 'বন্ধ করুন' : 'বাল্ক ইমপোর্ট'}
              </button>
            </div>

            <form
              onSubmit={handleAddDealer}
              className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-5 sm:items-end"
            >
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ইউনিয়ন
                </label>
                <input
                  type="text"
                  list="existing-unions-list"
                  value={unionName}
                  onChange={(e) => setUnionName(e.target.value)}
                  placeholder="ইউনিয়ন"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                />
                <datalist id="existing-unions-list">
                  {unions.map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  ডিলারের নাম
                </label>
                <input
                  type="text"
                  value={dealerName}
                  onChange={(e) => setDealerName(e.target.value)}
                  placeholder="নাম"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  খাত
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">সাধারণ</option>
                  {khats.map((k) => (
                    <option key={k.id} value={k.name}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  বিক্রয় কেন্দ্র
                </label>
                <input
                  type="text"
                  value={salesCenter}
                  onChange={(e) => setSalesCenter(e.target.value)}
                  placeholder="বাজার / কেন্দ্র"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={saving}
                className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
              >
                <Plus className="h-4 w-4" />
                যোগ করুন
              </button>
            </form>

            {showBulk && (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <textarea
                  rows={4}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder="Food_Dealer শিট থেকে সারি বা JSON পেস্ট করুন..."
                  className="w-full rounded-xl border border-slate-300 bg-white p-3 text-xs text-slate-900"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleBulkImportDealers}
                    className="rounded-xl bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
                  >
                    ইমপোর্ট করুন
                  </button>
                </div>
              </div>
            )}

            {statusMsg && (
              <div
                role="status"
                className={`mt-4 flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${
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
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-slate-900">ডিলার তালিকা</h3>
              <select
                value={filterUnion}
                onChange={(e) => setFilterUnion(e.target.value)}
                className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium"
              >
                <option value="">সব ইউনিয়ন ({dealers.length})</option>
                {unions.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
              {visibleDealers.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  কোনো ডিলার নেই
                </div>
              ) : (
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="px-3 py-2.5 w-14 text-center">ক্রমিক</th>
                      {!hideDealerIds && <th className="px-3 py-2.5">আইডি</th>}
                      <th className="px-3 py-2.5">ডিলারের নাম</th>
                      <th className="px-3 py-2.5">ইউনিয়ন</th>
                      <th className="px-3 py-2.5">খাত / কেন্দ্র</th>
                      <th className="px-3 py-2.5 text-right w-16">মুছুন</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {visibleDealers.map((d, idx) => (
                      <tr key={d.id} className="hover:bg-slate-50">
                        <td className="font-mono-num px-3 py-2.5 text-center text-xs text-slate-500">
                          {idx + 1}
                        </td>
                        {!hideDealerIds && (
                          <td className="font-mono-num px-3 py-2.5 text-[11px] text-slate-500">
                            {d.id}
                          </td>
                        )}
                        <td className="px-3 py-2.5 text-xs font-semibold text-slate-900">
                          {d.dealerName}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-700">
                          {d.unionName || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-600">
                          {[d.category, d.salesCenter]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteDealer(d.id)}
                            className="rounded-md p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}

      {innerTab === 'suballocations' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <h2 className="text-base font-bold text-slate-900">
              ডিলার উপ-বরাদ্দ (Dealer_Suballocation)
            </h2>

            <button
              type="button"
              onClick={() => setShowSubBulk(!showSubBulk)}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {showSubBulk ? 'বন্ধ করুন' : 'Sheet থেকে পেস্ট'}
            </button>
          </div>

          {showSubBulk && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <textarea
                rows={4}
                value={subBulkText}
                onChange={(e) => setSubBulkText(e.target.value)}
                placeholder="Dealer_Suballocation A:N বা H:N কপি করে পেস্ট করুন..."
                className="w-full rounded-xl border border-slate-300 bg-white p-3 text-xs"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleBulkImportSuballocations()}
                  className="rounded-xl bg-teal-700 px-4 py-2 text-xs font-semibold text-white"
                >
                  ইমপোর্ট করুন
                </button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            {suballocations.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                কোনো উপ-বরাদ্দ নেই
              </div>
            ) : (
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    {!hideDealerIds && <th className="px-3 py-2.5">আইডি</th>}
                    <th className="px-3 py-2.5">ডিলার ও ইউনিয়ন</th>
                    <th className="px-3 py-2.5 text-right">বরাদ্দ (টন)</th>
                    <th className="px-3 py-2.5 text-right">মূল টাকা</th>
                    <th className="px-3 py-2.5 text-right">আয়কর</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {suballocations.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      {!hideDealerIds && (
                        <td className="font-mono-num px-3 py-2.5 text-[11px] text-slate-500">
                          {s.id}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-xs">
                        <div className="font-semibold text-slate-900">
                          {s.dealerName || '—'}
                        </div>
                        {s.unionName && (
                          <div className="text-[11px] text-slate-500">
                            {s.unionName}
                          </div>
                        )}
                      </td>
                      <td className="font-mono-num px-3 py-2.5 text-right text-xs">
                        {s.allocationQty}
                      </td>
                      <td className="font-mono-num px-3 py-2.5 text-right text-xs font-bold text-teal-800">
                        ৳ {formatMoney(s.totalAmount)}
                      </td>
                      <td className="font-mono-num px-3 py-2.5 text-right text-xs font-bold text-amber-800">
                        ৳ {formatMoney(s.taxAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {innerTab === 'licensees' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
          <input
            ref={licFileInputRef}
            type="file"
            accept=".csv,.tsv,.txt"
            className="hidden"
            onChange={(e) => void handleLicenseeFileUpload(e)}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                ফুড গ্রেইন লাইসেন্সধারী (খুচরা ও পাইকারি)
              </h2>
              <p className="text-xs text-slate-500">
                এক্সেল/CSV টেমপ্লেট ডাউনলোড করে নাম, ঠিকানা ও লাইসেন্স নং পূরণ
                করে আপলোড করুন
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={downloadLicenseeTemplateCsv}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" />
                টেমপ্লেট ডাউনলোড
              </button>

              <button
                type="button"
                onClick={() => licFileInputRef.current?.click()}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-teal-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-teal-800"
              >
                <Upload className="h-3.5 w-3.5" />
                ফাইল আপলোড (CSV)
              </button>

              <button
                type="button"
                onClick={() => setShowLicBulk(!showLicBulk)}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
              >
                পেস্ট করুন
              </button>
            </div>
          </div>

          <form
            onSubmit={handleAddLicensee}
            className="grid grid-cols-1 gap-3 sm:grid-cols-6 sm:items-end"
          >
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                লাইসেন্সধারীর নাম
              </label>
              <input
                type="text"
                value={licName}
                onChange={(e) => setLicName(e.target.value)}
                placeholder="নাম"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                ঠিকানা
              </label>
              <input
                type="text"
                value={licAddress}
                onChange={(e) => setLicAddress(e.target.value)}
                placeholder="ঠিকানা"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                ধরণ
              </label>
              <select
                value={licType}
                onChange={(e) => setLicType(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-2.5 py-2 text-xs"
              >
                <option value="ফুড গ্রেইন লাইসেন্স (খুচরা)">খুচরা</option>
                <option value="ফুড গ্রেইন লাইসেন্স (পাইকারি)">পাইকারি</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                লাইসেন্স নং
              </label>
              <input
                type="text"
                value={licNo}
                onChange={(e) => setLicNo(e.target.value)}
                placeholder="লাইসেন্স নং"
                className="font-mono-num w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex min-h-[38px] items-center justify-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white"
            >
              <Plus className="h-4 w-4" />
              যোগ
            </button>
          </form>

          {showLicBulk && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <textarea
                rows={4}
                value={licBulkText}
                onChange={(e) => setLicBulkText(e.target.value)}
                placeholder="ক্রমিক নং [Tab] নাম ও ঠিকানা [Tab] লাইসেন্সের ধরণ [Tab] লাইসেন্স নং [Tab] প্রথম তারিখ [Tab] এনআইডি"
                className="w-full rounded-xl border border-slate-300 bg-white p-3 text-xs"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void importLicenseesRawText(licBulkText)}
                  className="rounded-xl bg-teal-700 px-4 py-2 text-xs font-semibold text-white"
                >
                  ইমপোর্ট করুন
                </button>
              </div>
            </div>
          )}

          {statusMsg && (
            <div
              role="status"
              className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${
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

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            {licensees.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                কোনো লাইসেন্সধারী যুক্ত হয়নি
              </div>
            ) : (
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                    <th className="px-3 py-2.5 text-center w-14">ক্রমিক</th>
                    <th className="px-3 py-2.5">নাম ও ঠিকানা</th>
                    <th className="px-3 py-2.5">লাইসেন্সের ধরণ</th>
                    <th className="px-3 py-2.5">লাইসেন্স নং</th>
                    <th className="px-3 py-2.5">প্রথম তারিখ</th>
                    <th className="px-3 py-2.5 text-right w-16">মুছুন</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {licensees.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50">
                      <td className="font-mono-num px-3 py-2 text-center text-slate-500">
                        {l.serialNo}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-bold text-slate-900">
                          {l.licenseeName}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {l.address || '—'}
                          {l.nid ? ` · NID: ${l.nid}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {l.licenseType}
                      </td>
                      <td className="font-mono-num px-3 py-2 font-bold text-teal-800">
                        {l.licenseNo}
                      </td>
                      <td className="font-mono-num px-3 py-2 text-slate-600">
                        {l.firstIssueDate || '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => void handleDeleteLicensee(l.id)}
                          className="rounded-md p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
