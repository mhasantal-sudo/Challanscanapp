import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { toBengaliDigits } from '../utils/challan.ts';

export type PaperOrientation = 'portrait' | 'landscape';

export function getA4PixelWidth(orientation: PaperOrientation): number {
  return orientation === 'portrait' ? 794 : 1123;
}

export function getA4PixelHeight(orientation: PaperOrientation): number {
  return orientation === 'portrait' ? 1122 : 793;
}

/**
 * Resets preview CSS transform inside html2canvas clone so downloaded PDFs
 * always render crisp 1:1 A4 pages regardless of mobile screen width.
 */
export function prepareA4PdfClone(
  clonedDoc: Document,
  orientation: PaperOrientation
) {
  const mmWidth = orientation === 'portrait' ? '210mm' : '297mm';

  clonedDoc
    .querySelectorAll<HTMLElement>('.a4-pdf-staging')
    .forEach((el) => {
      el.style.position = 'static';
      el.style.left = 'auto';
      el.style.top = 'auto';
      el.style.zIndex = 'auto';
      el.style.overflow = 'visible';
      el.style.width = mmWidth;
    });

  clonedDoc
    .querySelectorAll<HTMLElement>('.a4-preview-frame')
    .forEach((el) => {
      el.style.width = mmWidth;
      el.style.height = 'auto';
      el.style.overflow = 'visible';
      el.style.margin = '0';
    });

  clonedDoc
    .querySelectorAll<HTMLElement>('.a4-preview-scaler')
    .forEach((el) => {
      el.style.transform = 'none';
      el.style.width = mmWidth;
    });

  clonedDoc
    .querySelectorAll<HTMLElement>('.a4-sheet-page')
    .forEach((el) => {
      el.style.width = mmWidth;
      el.style.margin = '0';
      el.style.border = 'none';
      el.style.boxShadow = 'none';
    });
}

interface A4FitPreviewProps {
  orientation: PaperOrientation;
  children: ReactNode;
  leftSlot?: ReactNode;
  hidePaper?: boolean;
  hideToolbar?: boolean;
}

export function A4FitPreview({
  orientation,
  children,
  leftSlot,
  hidePaper = false,
  hideToolbar = false,
}: A4FitPreviewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [availWidth, setAvailWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [manualScale, setManualScale] = useState<number | null>(null);

  const paperWidth = getA4PixelWidth(orientation);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const updateWidth = () => {
      const w = vp.clientWidth;
      if (w > 0) setAvailWidth(w);
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(vp);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const inner = contentRef.current;
    if (!inner || hidePaper) return;
    const updateHeight = () => {
      const h = inner.scrollHeight;
      if (h > 0) setContentHeight(h);
    };
    updateHeight();
    const ro = new ResizeObserver(updateHeight);
    ro.observe(inner);
    const mo = new MutationObserver(updateHeight);
    mo.observe(inner, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [orientation, hidePaper, children]);

  // Reset to fit mode when orientation changes
  useEffect(() => {
    setManualScale(null);
  }, [orientation]);

  const fitScale =
    availWidth > 0 ? Math.min(1, Math.max(0.2, (availWidth - 2) / paperWidth)) : 1;
  const activeScale = manualScale ?? fitScale;
  const isScaledDown = activeScale < 0.999;

  const scaledWidth = Math.floor(paperWidth * activeScale);
  const scaledHeight =
    contentHeight > 0 ? Math.ceil(contentHeight * activeScale) : undefined;

  const pct = Math.round(activeScale * 100);

  function stepZoom(delta: number) {
    const next = Math.min(1.25, Math.max(0.2, Number((activeScale + delta).toFixed(2))));
    setManualScale(next);
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-100/90 p-2 sm:p-4">
      {!hideToolbar && (leftSlot || !hidePaper) && (
        <div className="no-print mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{leftSlot}</div>

          {!hidePaper && (
            <div className="flex items-center gap-1 rounded-xl border border-slate-300 bg-white p-0.5 shadow-2xs">
              <button
                type="button"
                onClick={() => stepZoom(-0.1)}
                title="জুম কমান"
                aria-label="জুম কমান"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                <ZoomOut className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => setManualScale(null)}
                title="স্ক্রিন অনুযায়ী ফিট করুন"
                className={`inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-xs font-bold transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${
                  manualScale === null
                    ? 'bg-rose-700 text-white'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <Maximize2 className="h-3.5 w-3.5" />
                <span>ফিট ({toBengaliDigits(pct)}%)</span>
              </button>

              <button
                type="button"
                onClick={() => stepZoom(0.1)}
                title="জুম বাড়ান"
                aria-label="জুম বাড়ান"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Measured Viewport */}
      <div
        ref={viewportRef}
        className={`w-full ${
          manualScale !== null && scaledWidth > availWidth
            ? 'overflow-x-auto'
            : 'overflow-x-hidden'
        }`}
      >
        {!hidePaper && (
          <div
            className="a4-preview-frame mx-auto"
            style={{
              width: `${scaledWidth}px`,
              height: scaledHeight ? `${scaledHeight}px` : 'auto',
              overflow: 'hidden',
            }}
          >
            <div
              ref={contentRef}
              className="a4-preview-scaler"
              style={{
                width: `${paperWidth}px`,
                transformOrigin: 'top left',
                transform: isScaledDown || activeScale > 1.001 ? `scale(${activeScale})` : 'none',
              }}
            >
              {children}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
