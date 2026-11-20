import {
  getA4PixelWidth,
  prepareA4PdfClone,
  type PaperOrientation,
} from '../components/A4FitPreview.tsx';
import { isCapacitorRuntime } from './api.ts';
import { saveBlobFile } from './nativeExport.ts';

let cachedNikoshDataUrl: string | null = null;
let cachedNikoshBanDataUrl: string | null = null;
let fontsPreloaded = false;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fetchFontAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) return null;
    const buf = await res.arrayBuffer();
    return `data:font/ttf;base64,${arrayBufferToBase64(buf)}`;
  } catch {
    return null;
  }
}

export async function ensureNikoshFontsReady(): Promise<{
  nikoshDataUrl: string;
  nikoshBanDataUrl: string;
}> {
  if (!cachedNikoshDataUrl || !cachedNikoshBanDataUrl) {
    const [nikoshUrl, nikoshBanUrl] = await Promise.all([
      cachedNikoshDataUrl
        ? Promise.resolve(cachedNikoshDataUrl)
        : fetchFontAsDataUrl('/fonts/Nikosh.ttf'),
      cachedNikoshBanDataUrl
        ? Promise.resolve(cachedNikoshBanDataUrl)
        : fetchFontAsDataUrl('/fonts/NikoshBAN.ttf'),
    ]);
    if (nikoshUrl) cachedNikoshDataUrl = nikoshUrl;
    if (nikoshBanUrl) cachedNikoshBanDataUrl = nikoshBanUrl;
  }

  if (
    cachedNikoshDataUrl &&
    !fontsPreloaded &&
    typeof FontFace !== 'undefined' &&
    document.fonts
  ) {
    try {
      const banUrl = cachedNikoshBanDataUrl || cachedNikoshDataUrl;
      const faces = [
        new FontFace('Nikosh', `url("${cachedNikoshDataUrl}")`, {
          weight: '400',
          style: 'normal',
        }),
        new FontFace('Nikosh', `url("${cachedNikoshDataUrl}")`, {
          weight: '700',
          style: 'normal',
        }),
        new FontFace('NikoshBAN', `url("${banUrl}")`, {
          weight: '400',
          style: 'normal',
        }),
        new FontFace('NikoshBAN', `url("${banUrl}")`, {
          weight: '700',
          style: 'normal',
        }),
      ];
      await Promise.all(faces.map((f) => f.load()));
      for (const f of faces) {
        document.fonts.add(f);
      }
      await Promise.all([
        document.fonts.load('400 13px "Nikosh"'),
        document.fonts.load('700 13px "Nikosh"'),
        document.fonts.load('400 13px "NikoshBAN"'),
      ]);
      fontsPreloaded = true;
    } catch {
      // Fall back to stylesheet @font-face
    }
  }

  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  return {
    nikoshDataUrl: cachedNikoshDataUrl || '',
    nikoshBanDataUrl: cachedNikoshBanDataUrl || cachedNikoshDataUrl || '',
  };
}

function sanitizeUnsupportedCssColors(clonedDoc: Document) {
  clonedDoc.querySelectorAll('style').forEach((styleNode) => {
    const css = styleNode.textContent || '';
    if (
      css.includes('oklch(') ||
      css.includes('oklab(') ||
      css.includes('color-mix(')
    ) {
      styleNode.textContent = css
        .replace(/oklch\([^)]*\)/g, '#0f172a')
        .replace(/oklab\([^)]*\)/g, '#0f172a')
        .replace(/color-mix\([^)]*\)/g, '#e2e8f0');
    }
  });
}

function injectNikoshIntoClone(
  clonedDoc: Document,
  orientation: PaperOrientation,
  nikoshDataUrl: string,
  nikoshBanDataUrl: string,
  sanitizeColors = false
) {
  prepareA4PdfClone(clonedDoc, orientation);

  clonedDoc
    .querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"]')
    .forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('http://') || href.startsWith('https://')) {
        link.remove();
      }
    });

  if (sanitizeColors) {
    sanitizeUnsupportedCssColors(clonedDoc);
  }

  const mmWidth = orientation === 'portrait' ? '210mm' : '297mm';
  const mmHeight = orientation === 'portrait' ? '297mm' : '210mm';
  const banFontUrl = nikoshBanDataUrl || nikoshDataUrl;

  const styleEl = clonedDoc.createElement('style');
  const fontFaceCss = nikoshDataUrl
    ? `
    @font-face {
      font-family: "Nikosh";
      src: url("${nikoshDataUrl}") format("truetype");
      font-weight: 400;
      font-style: normal;
    }
    @font-face {
      font-family: "Nikosh";
      src: url("${nikoshDataUrl}") format("truetype");
      font-weight: 700;
      font-style: normal;
    }
    @font-face {
      font-family: "NikoshBAN";
      src: url("${banFontUrl}") format("truetype");
      font-weight: 400;
      font-style: normal;
    }
    @font-face {
      font-family: "NikoshBAN";
      src: url("${banFontUrl}") format("truetype");
      font-weight: 700;
      font-style: normal;
    }
    .font-nikosh, .font-nikosh *,
    .font-mono-num, .font-mono-num *,
    .a4-sheet-page, .a4-sheet-page *,
    #challanReportPrintArea, #challanReportPrintArea *,
    #templateReportPrintArea, #templateReportPrintArea * {
      font-family: "Nikosh", "NikoshBAN", serif !important;
    }`
    : '';
  styleEl.textContent = `${fontFaceCss}
    .html2pdf__container {
      width: ${mmWidth} !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #ffffff !important;
    }
    .a4-sheet-page {
      width: ${mmWidth} !important;
      min-height: ${mmHeight} !important;
      margin: 0 !important;
      padding: 6mm 6.5mm 7mm 6.5mm !important;
      background: #ffffff !important;
      border: none !important;
      box-shadow: none !important;
      display: flex !important;
      flex-direction: column !important;
      justify-content: space-between !important;
      box-sizing: border-box !important;
    }
    .a4-register-page {
      height: ${mmHeight} !important;
      min-height: ${mmHeight} !important;
      max-height: ${mmHeight} !important;
      overflow: hidden !important;
    }
    .a4-page-content {
      flex: 1 1 auto !important;
      min-height: 0 !important;
      display: flex !important;
      flex-direction: column !important;
    }
    .a4-register-page .a4-page-content {
      overflow: hidden !important;
      padding-bottom: 6px !important;
      margin-bottom: 4px !important;
    }
    .a4-sheet-page table,
    #challanReportPrintArea table,
    .template-doc-body table {
      width: 100% !important;
      border-collapse: collapse !important;
      table-layout: fixed !important;
      border: 1px solid #000000 !important;
    }
    .a4-sheet-page th,
    .a4-sheet-page td,
    #challanReportPrintArea th,
    #challanReportPrintArea td,
    .template-doc-body th,
    .template-doc-body td {
      border: 1px solid #000000 !important;
      color: #000000 !important;
      vertical-align: middle !important;
      overflow: visible !important;
      line-height: 1.32 !important;
      box-sizing: border-box !important;
    }
    .a4-sheet-page th,
    #challanReportPrintArea th,
    .template-doc-body th {
      font-weight: bold !important;
      background-color: #f1f5f9 !important;
    }
    .a4-page-footer {
      flex-shrink: 0 !important;
      position: relative !important;
      z-index: 2 !important;
      background: #ffffff !important;
      margin-top: auto !important;
      padding-top: 6px !important;
      padding-bottom: 1px !important;
      border-top: 1px solid #475569 !important;
    }
  `;
  clonedDoc.head.appendChild(styleEl);
}

interface MinimalJsPdf {
  addPage: (format?: string, orientation?: string) => void;
  addImage: (
    imageData: string,
    format: string,
    x: number,
    y: number,
    w: number,
    h: number
  ) => void;
  output: (type: 'blob' | 'arraybuffer') => Blob | ArrayBuffer;
  save: (filename?: string) => void;
}

export async function downloadNikoshPdf(
  element: HTMLElement,
  filename: string,
  orientation: PaperOrientation
): Promise<void> {
  const { nikoshDataUrl, nikoshBanDataUrl } = await ensureNikoshFontsReady();
  const html2pdfModule = await import('html2pdf.js');
  const html2pdf = html2pdfModule.default;

  const foundPages = Array.from(
    element.querySelectorAll<HTMLElement>('.a4-sheet-page')
  );
  const pageNodes = foundPages.length > 0 ? foundPages : [element];

  const a4W = orientation === 'portrait' ? 210 : 297;
  const a4H = orientation === 'portrait' ? 297 : 210;
  const a4Ratio = a4H / a4W;

  const renderPageToCanvas = async (
    target: HTMLElement,
    useForeignObject: boolean
  ): Promise<HTMLCanvasElement> => {
    const worker = html2pdf().set({
      margin: [0, 0, 0, 0],
      filename,
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
        imageTimeout: 4000,
        foreignObjectRendering: useForeignObject,
        backgroundColor: '#ffffff',
        scrollX: 0,
        scrollY: 0,
        windowWidth: getA4PixelWidth(orientation),
        onclone: (clonedDoc: Document) =>
          injectNikoshIntoClone(
            clonedDoc,
            orientation,
            nikoshDataUrl,
            nikoshBanDataUrl,
            !useForeignObject
          ),
      },
      jsPDF: {
        unit: 'mm',
        format: 'a4',
        orientation,
      },
      pagebreak: { mode: [] },
    } as Record<string, unknown>);

    const timeoutMs = useForeignObject ? 14000 : 20000;
    const canvas = await Promise.race<HTMLCanvasElement>([
      worker.from(target).toCanvas().get('canvas') as Promise<HTMLCanvasElement>,
      new Promise<HTMLCanvasElement>((_, reject) =>
        window.setTimeout(() => reject(new Error('PDF canvas timeout')), timeoutMs)
      ),
    ]);

    if (!canvas || canvas.width < 10 || canvas.height < 10) {
      throw new Error('Empty canvas rendered');
    }
    return canvas;
  };

  const seedCanvas = document.createElement('canvas');
  seedCanvas.width = 100;
  seedCanvas.height = Math.floor(100 * a4Ratio);
  const seedCtx = seedCanvas.getContext('2d');
  if (seedCtx) {
    seedCtx.fillStyle = '#ffffff';
    seedCtx.fillRect(0, 0, seedCanvas.width, seedCanvas.height);
  }

  const pdf = (await html2pdf()
    .set({
      margin: [0, 0, 0, 0],
      filename,
      image: { type: 'jpeg', quality: 0.96 },
      jsPDF: { unit: 'mm', format: 'a4', orientation },
      pagebreak: { mode: [] },
    } as Record<string, unknown>)
    .from(seedCanvas)
    .toPdf()
    .get('pdf')) as MinimalJsPdf;

  let pdfPageCount = 0;

  for (const pageEl of pageNodes) {
    let pageCanvas: HTMLCanvasElement;
    try {
      pageCanvas = await renderPageToCanvas(pageEl, true);
    } catch {
      pageCanvas = await renderPageToCanvas(pageEl, false);
    }

    const canvasRatio = pageCanvas.height / pageCanvas.width;

    if (canvasRatio <= a4Ratio * 1.18) {
      const scale = Math.min(a4W / pageCanvas.width, a4H / pageCanvas.height);
      const drawW = pageCanvas.width * scale;
      const drawH = pageCanvas.height * scale;
      const offsetX = Math.max(0, (a4W - drawW) / 2);

      if (pdfPageCount > 0) {
        pdf.addPage('a4', orientation);
      }
      const imgData = pageCanvas.toDataURL('image/jpeg', 0.96);
      pdf.addImage(imgData, 'JPEG', offsetX, 0, drawW, drawH);
      pdfPageCount += 1;
    } else {
      const slicePxHeight = Math.floor(pageCanvas.width * a4Ratio);
      const sliceCanvas = document.createElement('canvas');
      const sliceCtx = sliceCanvas.getContext('2d');
      sliceCanvas.width = pageCanvas.width;

      for (let y = 0; y < pageCanvas.height; y += slicePxHeight) {
        const remaining = pageCanvas.height - y;
        if (remaining < 16 && pdfPageCount > 0) break;
        const h = Math.min(slicePxHeight, remaining);
        sliceCanvas.height = h;
        if (sliceCtx) {
          sliceCtx.fillStyle = '#ffffff';
          sliceCtx.fillRect(0, 0, sliceCanvas.width, h);
          sliceCtx.drawImage(
            pageCanvas,
            0,
            y,
            pageCanvas.width,
            h,
            0,
            0,
            pageCanvas.width,
            h
          );
        }
        const drawH = (h * a4W) / pageCanvas.width;
        if (pdfPageCount > 0) {
          pdf.addPage('a4', orientation);
        }
        pdf.addImage(
          sliceCanvas.toDataURL('image/jpeg', 0.96),
          'JPEG',
          0,
          0,
          a4W,
          drawH
        );
        pdfPageCount += 1;
      }
    }
  }

  if (isCapacitorRuntime()) {
    const pdfOutput = pdf.output('blob');
    const pdfBlob =
      pdfOutput instanceof Blob
        ? pdfOutput
        : new Blob([pdfOutput], { type: 'application/pdf' });
    await saveBlobFile(pdfBlob, filename, 'application/pdf');
    return;
  }

  pdf.save(filename);
}



