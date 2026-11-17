import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  FileDown,
  FileText,
  ImagePlus,
  Loader2,
  Lock,
  Plus,
  Printer,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  Save,
  Settings,
  TableProperties,
  Trash2,
} from 'lucide-react';
import type { AppSettings, ReportTemplate, SavedReport } from '../types.ts';
import { apiFetch } from '../utils/api.ts';
import { maskDateInput, toBengaliDigits } from '../utils/challan.ts';
import { downloadNikoshPdf } from '../utils/pdfExport.ts';
import { A4FitPreview } from './A4FitPreview.tsx';

interface TemplatesViewProps {
  templates: ReportTemplate[];
  settings: AppSettings;
  canEditMaster?: boolean;
  onRefreshTemplates: () => void;
  onOpenMasterEditor: () => void;
}

type PageOrientation = 'portrait' | 'landscape';
type ViewMode = 'fill' | 'saved';

function getTodayDisplay(): string {
  const now = new Date();
  return toBengaliDigits(
    `${String(now.getDate()).padStart(2, '0')}/${String(
      now.getMonth() + 1
    ).padStart(2, '0')}/${now.getFullYear()}`
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildSignatureHtml(
  sigImage: string,
  officerName: string,
  designation: string
): string {
  const imgTag = sigImage
    ? `<img src="${sigImage}" alt="স্বাক্ষর" style="height:36px;max-width:140px;object-fit:contain;margin:0 auto 3px auto;display:block;" />`
    : '';
  const nameLine = officerName
    ? `<div style="font-weight:bold;font-size:12px;">${escapeHtml(officerName)}</div>`
    : '';
  const desigLine = designation
    ? `<div style="font-size:11px;">${escapeHtml(designation)}</div>`
    : '';
  return `<div style="display:inline-block;text-align:center;min-width:155px;">${imgTag}<div style="border-top:1px solid #334155;padding-top:3px;">${nameLine}${desigLine}</div></div>`;
}

function applyTemplateFields(
  rawHtml: string,
  fields: {
    dateVal: string;
    memoNo: string;
    recipient: string;
    officeTitle: string;
    officeSubtitle: string;
    officerName: string;
    designation: string;
    sigImage: string;
  }
): string {
  const sigBlock = buildSignatureHtml(
    fields.sigImage,
    fields.officerName,
    fields.designation
  );
  let out = rawHtml;
  out = out.replace(/\{\{\s*তারিখ\s*\}\}/g, escapeHtml(fields.dateVal || ''));
  out = out.replace(/\{\{\s*স্মারক\s*\}\}/g, escapeHtml(fields.memoNo || ''));
  out = out.replace(/\{\{\s*প্রাপক\s*\}\}/g, escapeHtml(fields.recipient || ''));
  out = out.replace(
    /\{\{\s*অফিস\s*\}\}/g,
    escapeHtml(
      [fields.officeSubtitle, fields.officeTitle].filter(Boolean).join(', ')
    )
  );
  out = out.replace(
    /\{\{\s*কর্মকর্তা\s*\}\}/g,
    escapeHtml(fields.officerName || '')
  );
  out = out.replace(
    /\{\{\s*পদবি\s*\}\}/g,
    escapeHtml(fields.designation || '')
  );
  out = out.replace(/\{\{\s*স্বাক্ষর\s*\}\}/g, sigBlock);
  return out;
}

export function TemplatesView({
  templates,
  settings,
  canEditMaster = false,
  onOpenMasterEditor,
}: TemplatesViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('fill');
  const [selectedCategory, setSelectedCategory] = useState<string>('সব বিভাগ');
  const [selectedId, setSelectedId] = useState<string>('');
  const [orientation, setOrientation] = useState<PageOrientation>('portrait');

  const [dateVal, setDateVal] = useState(getTodayDisplay);
  const [memoNo, setMemoNo] = useState('১৩.০১.০৬৮৬.০০০.০০.০০১.২৬-');
  const [recipient, setRecipient] = useState('');
  const [officerName, setOfficerName] = useState(settings.officerName || '');
  const [designation, setDesignation] = useState(
    settings.officerSignatureText || 'উপজেলা খাদ্য নিয়ন্ত্রক'
  );
  const [signatureImg, setSignatureImg] = useState(
    settings.officerSignatureImageDataUrl || ''
  );

  const [renderedHtml, setRenderedHtml] = useState<string>('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [savingReport, setSavingReport] = useState(false);
  const [savedReports, setSavedReports] = useState<SavedReport[]>([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [activeSavedReport, setActiveSavedReport] = useState<SavedReport | null>(
    null
  );
  const [statusMsg, setStatusMsg] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  const editorRef = useRef<HTMLDivElement | null>(null);
  const printAreaRef = useRef<HTMLDivElement | null>(null);
  const sigUploadRef = useRef<HTMLInputElement | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    templates.forEach((t) => set.add((t.category || 'রিপোর্ট').trim() || 'রিপোর্ট'));
    return ['সব বিভাগ', ...Array.from(set)];
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    if (selectedCategory === 'সব বিভাগ') return templates;
    return templates.filter(
      (t) => ((t.category || 'রিপোর্ট').trim() || 'রিপোর্ট') === selectedCategory
    );
  }, [templates, selectedCategory]);

  const activeTemplate = useMemo(
    () =>
      filteredTemplates.find((t) => t.id === selectedId) ||
      filteredTemplates[0] ||
      templates[0] ||
      null,
    [filteredTemplates, templates, selectedId]
  );

  const editable = useMemo(
    () => ({
      allowDate: activeTemplate?.editableFields?.allowDate ?? true,
      allowMemo: activeTemplate?.editableFields?.allowMemo ?? true,
      allowRecipient: activeTemplate?.editableFields?.allowRecipient ?? true,
      allowTableEdit: activeTemplate?.editableFields?.allowTableEdit ?? true,
    }),
    [activeTemplate]
  );

  async function loadSavedReports() {
    setLoadingReports(true);
    try {
      const res = await apiFetch('/api/reports');
      const json = (await res.json()) as {
        success: boolean;
        reports?: SavedReport[];
      };
      if (res.ok && json.success) {
        setSavedReports(json.reports || []);
      }
    } catch {
      // ignore initial history load error
    } finally {
      setLoadingReports(false);
    }
  }

  useEffect(() => {
    void loadSavedReports();
  }, []);

  useEffect(() => {
    if (!selectedId && filteredTemplates.length > 0) {
      setSelectedId(filteredTemplates[0].id);
    } else if (
      selectedId &&
      filteredTemplates.length > 0 &&
      !filteredTemplates.some((t) => t.id === selectedId)
    ) {
      setSelectedId(filteredTemplates[0].id);
    }
  }, [filteredTemplates, selectedId]);

  useEffect(() => {
    if (!activeTemplate) {
      setRenderedHtml('');
      return;
    }
    setActiveSavedReport(null);
    setOrientation(
      activeTemplate.orientation === 'landscape' ? 'landscape' : 'portrait'
    );
    setDateVal(activeTemplate.defaultDate || getTodayDisplay());
    setMemoNo(activeTemplate.defaultMemoNo || '১৩.০১.০৬৮৬.০০০.০০.০০১.২৬-');
    setRecipient(activeTemplate.defaultRecipient || '');
    setOfficerName(activeTemplate.officerName || settings.officerName || '');
    setDesignation(
      activeTemplate.officerDesignation ||
        settings.officerSignatureText ||
        'উপজেলা খাদ্য নিয়ন্ত্রক'
    );
    setSignatureImg(
      activeTemplate.signatureImageDataUrl ||
        settings.officerSignatureImageDataUrl ||
        ''
    );
  }, [
    activeTemplate?.id,
    settings.officerName,
    settings.officerSignatureImageDataUrl,
    settings.officerSignatureText,
  ]);

  // Re-populate template whenever fields or activeTemplate change (preserving locked prose)
  useEffect(() => {
    if (!activeTemplate || activeSavedReport) return;
    const html = applyTemplateFields(activeTemplate.htmlContent, {
      dateVal,
      memoNo,
      recipient,
      officeTitle: settings.officeTitle,
      officeSubtitle: settings.officeSubtitle,
      officerName,
      designation,
      sigImage: signatureImg,
    });
    setRenderedHtml(html);
    if (editorRef.current) {
      editorRef.current.innerHTML = html;
    }
  }, [
    activeTemplate,
    activeSavedReport,
    dateVal,
    memoNo,
    recipient,
    officerName,
    designation,
    signatureImg,
    settings.officeTitle,
    settings.officeSubtitle,
  ]);

  // Lock fixed template prose while allowing ONLY table cells (td) to be edited when allowTableEdit=true
  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const allowEditCells = !activeSavedReport && editable.allowTableEdit;
    const cells = root.querySelectorAll<HTMLElement>('table tbody td, td[data-fillable], span[data-fillable]');
    cells.forEach((cell) => {
      cell.contentEditable = allowEditCells ? 'true' : 'false';
      if (allowEditCells) {
        cell.classList.add('outline-none', 'focus:bg-amber-50/70');
      } else {
        cell.classList.remove('outline-none', 'focus:bg-amber-50/70');
      }
    });
  }, [renderedHtml, editable.allowTableEdit, activeSavedReport, viewMode]);

  function resetToTemplate() {
    if (!activeTemplate) return;
    setActiveSavedReport(null);
    const html = applyTemplateFields(activeTemplate.htmlContent, {
      dateVal,
      memoNo,
      recipient,
      officeTitle: settings.officeTitle,
      officeSubtitle: settings.officeSubtitle,
      officerName,
      designation,
      sigImage: signatureImg,
    });
    setRenderedHtml(html);
    if (editorRef.current) {
      editorRef.current.innerHTML = html;
    }
    setStatusMsg(null);
  }

  function addRowToFirstTable() {
    if (!editable.allowTableEdit) return;
    const root = editorRef.current;
    if (!root) return;
    const table = root.querySelector('table');
    if (!table) {
      setStatusMsg({ tone: 'error', text: 'এই টেমপ্লেটে কোনো টেবিল নেই।' });
      return;
    }
    const tbody = table.querySelector('tbody') || table;
    const rows = tbody.querySelectorAll('tr');
    const colCount =
      rows.length > 0 ? rows[rows.length - 1].children.length || 4 : 4;
    const tr = document.createElement('tr');
    for (let i = 0; i < colCount; i++) {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.className = 'outline-none focus:bg-amber-50/70';
      td.innerHTML = i === 0 ? toBengaliDigits(rows.length + 1) : '&nbsp;';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  function handleSigFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setSignatureImg(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleSaveReport() {
    if (!activeTemplate || !editorRef.current) return;
    setSavingReport(true);
    setStatusMsg(null);
    try {
      // Clone DOM without contentEditable attributes for clean archived HTML
      const clone = editorRef.current.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[contenteditable]').forEach((el) => {
        el.removeAttribute('contenteditable');
      });
      const finalHtml = clone.innerHTML.trim();

      const res = await apiFetch(
        `/api/templates/${encodeURIComponent(activeTemplate.id)}/reports`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateValue: dateVal,
            memoNo,
            recipient,
            renderedHtml: finalHtml,
          }),
        }
      );
      const json = (await res.json()) as {
        success: boolean;
        reports?: SavedReport[];
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'রিপোর্ট সংরক্ষণ করা যায়নি।');
      }
      setSavedReports(json.reports || []);
      setStatusMsg({
        tone: 'success',
        text: `"${activeTemplate.title}" রিপোর্ট সংরক্ষিত হয়েছে।`,
      });
    } catch (err) {
      setStatusMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'সংরক্ষণ ব্যর্থ হয়েছে।',
      });
    } finally {
      setSavingReport(false);
    }
  }

  async function handleDeleteSavedReport(id: string) {
    try {
      const res = await apiFetch(`/api/reports/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as {
        success: boolean;
        reports?: SavedReport[];
      };
      if (res.ok && json.success) {
        setSavedReports(json.reports || []);
        if (activeSavedReport?.id === id) {
          setActiveSavedReport(null);
        }
      }
    } catch {
      // ignore delete error
    }
  }

  function openSavedReportInPreview(rpt: SavedReport) {
    setActiveSavedReport(rpt);
    setOrientation(rpt.orientation === 'landscape' ? 'landscape' : 'portrait');
    setDateVal(rpt.dateValue || '');
    setMemoNo(rpt.memoNo || '');
    setRecipient(rpt.recipient || '');
    setRenderedHtml(rpt.renderedHtml);
    if (editorRef.current) {
      editorRef.current.innerHTML = rpt.renderedHtml;
    }
    setViewMode('fill');
  }

  function downloadWordDoc() {
    const title =
      activeSavedReport?.templateTitle || activeTemplate?.title || 'Report';
    const bodyHtml = editorRef.current?.innerHTML || renderedHtml;
    const footerHtml = !hasInlineSigPlaceholder
      ? `<div style="margin-top:24px;display:flex;justify-content:space-between;align-items:flex-end;font-size:12px;">
          <div>${memoNo ? `স্মারক: ${escapeHtml(memoNo)} · ` : ''}তারিখ: ${escapeHtml(dateVal)}</div>
          ${buildSignatureHtml(signatureImg, officerName, designation)}
        </div>`
      : '';

    const docHtml = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="bn">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 ${orientation}; margin: 12mm; }
  body { font-family: "Nikosh", "NikoshBAN", "Hind Siliguri", Arial, sans-serif; color: #0f172a; line-height: 1.45; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #334155; padding: 5px 7px; font-size: 12pt; }
</style>
</head>
<body>${bodyHtml}${footerHtml}</body>
</html>`;

    const blob = new Blob(['\ufeff', docHtml], {
      type: 'application/msword;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\w\u0980-\u09FF-]+/g, '_')}.doc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadPdf() {
    const el = printAreaRef.current;
    const docTitle =
      activeSavedReport?.templateTitle || activeTemplate?.title || 'Report';
    if (!el) return;
    setPdfLoading(true);
    try {
      const safeName = docTitle.replace(/[^\w\u0980-\u09FF-]+/g, '_');
      await downloadNikoshPdf(el, `${safeName || 'Report'}.pdf`, orientation);
    } finally {
      setPdfLoading(false);
    }
  }

  const hasInlineSigPlaceholder = Boolean(
    activeTemplate?.htmlContent &&
      /\{\{\s*স্বাক্ষর\s*\}\}/.test(activeTemplate.htmlContent)
  );

  const hasRecipientPlaceholder = Boolean(
    activeTemplate?.htmlContent &&
      /\{\{\s*প্রাপক\s*\}\}/.test(activeTemplate.htmlContent)
  );

  return (
    <div className="space-y-4 pb-20">
      <style>{`@media print { @page { size: A4 ${orientation}; margin: 9mm; } }`}</style>

      <input
        ref={sigUploadRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleSigFile}
      />

      {/* Top Mode & Template Title Selector */}
      <section className="no-print rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setViewMode('fill')}
              className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                viewMode === 'fill'
                  ? 'bg-rose-700 text-white'
                  : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              রিপোর্ট ও টেমপ্লেট ({toBengaliDigits(templates.length)})
            </button>

            <button
              type="button"
              onClick={() => {
                setViewMode('saved');
                void loadSavedReports();
              }}
              className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                viewMode === 'saved'
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <Archive className="h-3.5 w-3.5" />
              সংরক্ষিত রিপোর্ট ({toBengaliDigits(savedReports.length)})
            </button>
          </div>

          {canEditMaster && (
            <button
              type="button"
              onClick={onOpenMasterEditor}
              title="সেটিংস থেকে টেমপ্লেট মাস্টার এডিট"
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <Settings className="h-3.5 w-3.5" />
              মাস্টার সেটিংস
            </button>
          )}
        </div>

        {viewMode === 'fill' && (
          <>
            {/* Category Filter Pills (if multiple categories exist) */}
            {categories.length > 2 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors ${
                      selectedCategory === cat
                        ? 'bg-slate-800 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            )}

            {/* Clickable Template Titles */}
            <div className="flex flex-wrap items-center gap-1.5">
              {filteredTemplates.map((tpl) => {
                const active = tpl.id === activeTemplate?.id && !activeSavedReport;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      setActiveSavedReport(null);
                      setSelectedId(tpl.id);
                    }}
                    className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition-colors whitespace-nowrap ${
                      active
                        ? 'border-rose-700 bg-rose-700 text-white shadow-xs'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>{tpl.title}</span>
                    {tpl.category && (
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] ${
                          active
                            ? 'bg-white/20 text-white'
                            : 'bg-slate-200/70 text-slate-600'
                        }`}
                      >
                        {tpl.category}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Active Saved Report Banner OR Admin-Permitted Fillable Fields */}
            {activeSavedReport ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-900">
                <span>
                  সংরক্ষিত রিপোর্ট প্রিভিউ: {activeSavedReport.templateTitle} (তারিখ:{' '}
                  {activeSavedReport.dateValue || '—'})
                </span>
                <button
                  type="button"
                  onClick={resetToTemplate}
                  className="rounded-lg bg-white px-2.5 py-1 text-[11px] text-indigo-800 border border-indigo-200 hover:bg-indigo-100"
                >
                  মূল টেমপ্লেটে ফিরুন
                </button>
              </div>
            ) : (
              activeTemplate && (
                <div className="space-y-2.5 border-t border-slate-100 pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                      <Lock className="h-3.5 w-3.5 text-slate-400" />
                      মূল টেমপ্লেট লক করা — শুধু অনুমোদিত তথ্য ও ঘর পূরণ করুন
                    </span>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {editable.allowTableEdit && (
                        <button
                          type="button"
                          onClick={addRowToFirstTable}
                          title="টেবিলে নতুন সারি যোগ করুন"
                          className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50"
                        >
                          <TableProperties className="h-3.5 w-3.5" />
                          <Plus className="h-3 w-3" />
                          সারি যোগ
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={resetToTemplate}
                        title="রিসেট"
                        className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        রিসেট
                      </button>
                      <button
                        type="button"
                        onClick={downloadWordDoc}
                        className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-800 hover:bg-blue-100"
                      >
                        <FileDown className="h-3.5 w-3.5" />
                        Word (.doc)
                      </button>
                      <button
                        type="button"
                        disabled={savingReport}
                        onClick={() => void handleSaveReport()}
                        className="inline-flex min-h-[32px] items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-60"
                      >
                        {savingReport ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        সেভ রিপোর্ট
                      </button>
                    </div>
                  </div>

                  {/* Permitted Input Controls Only */}
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-6 sm:items-end">
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-bold text-slate-500">
                        তারিখ
                        {!editable.allowDate && (
                          <Lock className="h-3 w-3 text-slate-400" />
                        )}
                      </label>
                      <input
                        type="text"
                        value={dateVal}
                        readOnly={!editable.allowDate}
                        onChange={(e) =>
                          editable.allowDate &&
                          setDateVal(maskDateInput(e.target.value) || e.target.value)
                        }
                        className={`font-mono-num w-full rounded-xl border px-2.5 py-1.5 text-xs ${
                          editable.allowDate
                            ? 'border-slate-300 bg-white text-slate-900'
                            : 'border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed'
                        }`}
                      />
                    </div>

                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-bold text-slate-500">
                        স্মারক নং
                        {!editable.allowMemo && (
                          <Lock className="h-3 w-3 text-slate-400" />
                        )}
                      </label>
                      <input
                        type="text"
                        value={memoNo}
                        readOnly={!editable.allowMemo}
                        onChange={(e) =>
                          editable.allowMemo && setMemoNo(e.target.value)
                        }
                        className={`font-mono-num w-full rounded-xl border px-2.5 py-1.5 text-xs ${
                          editable.allowMemo
                            ? 'border-slate-300 bg-white text-slate-900'
                            : 'border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed'
                        }`}
                      />
                    </div>

                    {(editable.allowRecipient || hasRecipientPlaceholder) && (
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-[11px] font-bold text-slate-500">
                          প্রাপক
                          {!editable.allowRecipient && (
                            <Lock className="h-3 w-3 text-slate-400" />
                          )}
                        </label>
                        <input
                          type="text"
                          value={recipient}
                          readOnly={!editable.allowRecipient}
                          placeholder="প্রাপকের নাম/পদবি"
                          onChange={(e) =>
                            editable.allowRecipient && setRecipient(e.target.value)
                          }
                          className={`w-full rounded-xl border px-2.5 py-1.5 text-xs ${
                            editable.allowRecipient
                              ? 'border-slate-300 bg-white text-slate-900'
                              : 'border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed'
                          }`}
                        />
                      </div>
                    )}

                    <div>
                      <label className="mb-1 block text-[11px] font-bold text-slate-500">
                        কর্মকর্তার নাম
                      </label>
                      <input
                        type="text"
                        value={officerName}
                        onChange={(e) => setOfficerName(e.target.value)}
                        placeholder="নাম"
                        className="w-full rounded-xl border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] font-bold text-slate-500">
                        পদবি
                      </label>
                      <input
                        type="text"
                        value={designation}
                        onChange={(e) => setDesignation(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
                      />
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={() => sigUploadRef.current?.click()}
                        className="inline-flex min-h-[34px] w-full items-center justify-center gap-1 rounded-xl border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100"
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                        স্বাক্ষর ছবি
                      </button>
                    </div>
                  </div>
                </div>
              )
            )}
          </>
        )}

        {statusMsg && (
          <div
            className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold ${
              statusMsg.tone === 'success'
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            {statusMsg.tone === 'success' && (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>{statusMsg.text}</span>
          </div>
        )}
      </section>

      {/* SAVED REPORTS ARCHIVE TAB */}
      {viewMode === 'saved' && (
        <section className="no-print rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
            <h3 className="text-sm font-bold text-slate-900">
              সংরক্ষিত রিপোর্ট সমূহ
            </h3>
            {loadingReports && (
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            )}
          </div>

          {savedReports.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">
              এখনো কোনো পূরণকৃত রিপোর্ট সংরক্ষণ করা হয়নি।
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {savedReports.map((rpt) => (
                <div
                  key={rpt.id}
                  className="flex flex-col justify-between gap-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-bold text-sm text-slate-900">
                        {rpt.templateTitle}
                      </div>
                      <span className="rounded-md bg-white border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                        {rpt.category || 'রিপোর্ট'}
                      </span>
                    </div>
                    <div className="mt-1.5 space-y-0.5 text-xs text-slate-600">
                      {rpt.memoNo && <div>স্মারক: {rpt.memoNo}</div>}
                      {rpt.dateValue && <div>তারিখ: {rpt.dateValue}</div>}
                      {rpt.recipient && <div>প্রাপক: {rpt.recipient}</div>}
                      <div className="text-[11px] text-slate-400">
                        তৈরি: {rpt.createdBy}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-slate-200/70 pt-2">
                    <button
                      type="button"
                      onClick={() => openSavedReportInPreview(rpt)}
                      className="flex-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800"
                    >
                      ওপেন ও প্রিন্ট
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteSavedReport(rpt.id)}
                      className="rounded-lg border border-red-200 bg-white p-1.5 text-red-600 hover:bg-red-50"
                      aria-label="মুছুন"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* FILLABLE / PRINTABLE A4 NIKOSH PREVIEW */}
      {viewMode === 'fill' &&
        (!activeTemplate && !activeSavedReport ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center space-y-3">
            <FileText className="mx-auto h-10 w-10 text-slate-400" />
            <div className="text-sm font-bold text-slate-800">
              এখনো কোনো রিপোর্ট টেম্পলেট সেট করা হয়নি
            </div>
            <p className="text-xs text-slate-500">
              {canEditMaster
                ? 'সেটিংস > টেমপ্লেট এডিটর থেকে Word (.docx) আপলোড বা নতুন টেমপ্লেট তৈরি করুন।'
                : 'অ্যাডমিন সেটিংস থেকে টেমপ্লেট সেট করলে এখানে সব টাইটেল দেখা যাবে।'}
            </p>
            {canEditMaster && (
              <button
                type="button"
                onClick={onOpenMasterEditor}
                className="inline-flex items-center gap-1.5 rounded-xl bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800"
              >
                <Settings className="h-4 w-4" />
                সেটিংস ও টেমপ্লেট এডিটর
              </button>
            )}
          </div>
        ) : (
          <A4FitPreview orientation={orientation}>
            <div id="templateReportPrintArea" ref={printAreaRef}>
              <div
                className={`a4-sheet-page font-nikosh ${
                  orientation === 'portrait'
                    ? 'a4-page-portrait'
                    : 'a4-page-landscape'
                }`}
              >
                <div className="a4-page-content">
                  {/* Prose locked; table cells dynamically editable only when allowTableEdit=true */}
                  <div
                    ref={editorRef}
                    className="template-doc-body font-nikosh outline-none"
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                  />
                </div>

                {/* Clean Footer with Signature Above Officer Name */}
                {!activeSavedReport && (
                  <div className="a4-page-footer">
                    <div style={{ fontSize: '10.5px', color: '#334155' }}>
                      {memoNo ? `স্মারক: ${memoNo} · ` : ''}
                      তারিখ: {dateVal}
                    </div>

                    {!hasInlineSigPlaceholder && (
                      <div style={{ textAlign: 'center', minWidth: '160px' }}>
                        {signatureImg && (
                          <img
                            src={signatureImg}
                            alt="স্বাক্ষর"
                            style={{
                              height: '36px',
                              maxWidth: '140px',
                              objectFit: 'contain',
                              margin: '0 auto 2px auto',
                              display: 'block',
                            }}
                          />
                        )}
                        <div
                          style={{
                            borderTop: signatureImg
                              ? '1px solid #475569'
                              : '1px dashed #64748b',
                            paddingTop: '2px',
                            fontSize: '11.5px',
                            fontWeight: 'bold',
                          }}
                        >
                          {officerName || designation}
                        </div>
                        {officerName && (
                          <div style={{ fontSize: '10.5px', color: '#334155' }}>
                            {designation}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </A4FitPreview>
        ))}

      {/* 4-Symbol Floating Action Bar */}
      {viewMode === 'fill' && (activeTemplate || activeSavedReport) && (
        <div
          className="no-print fixed bottom-20 right-4 z-40 flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-xl backdrop-blur md:bottom-6"
          role="toolbar"
          aria-label="টেম্পলেট প্রিন্ট ও পেজ নিয়ন্ত্রণ"
        >
          <button
            type="button"
            onClick={() => setOrientation('portrait')}
            title="পোর্ট্রেট মোড"
            aria-label="পোর্ট্রেট মোড"
            className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
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
            title="ল্যান্ডস্কেপ মোড"
            aria-label="ল্যান্ডস্কেপ মোড"
            className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
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
            disabled={pdfLoading}
            onClick={() => void downloadPdf()}
            title="PDF ডাউনলোড (Nikosh A4)"
            aria-label="PDF ডাউনলোড"
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
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
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white hover:bg-slate-800"
          >
            <Printer className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
