import { isCapacitorRuntime } from './api.ts';

interface AndroidNativeBridge {
  printWebView?: (jobName: string) => void;
  saveToDownloads?: (
    base64Data: string,
    fileName: string,
    mimeType: string
  ) => string;
}

interface CapacitorPluginsShape {
  Filesystem?: {
    writeFile: (options: {
      path: string;
      data: string;
      directory?: string;
    }) => Promise<{ uri?: string }>;
  };
  Share?: {
    share: (options: {
      title?: string;
      text?: string;
      url?: string;
      dialogTitle?: string;
    }) => Promise<unknown>;
  };
}

function getAndroidNativeBridge(): AndroidNativeBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AndroidNative?: AndroidNativeBridge };
  return w.AndroidNative || null;
}

function getCapacitorPlugins(): CapacitorPluginsShape | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    Capacitor?: { Plugins?: CapacitorPluginsShape };
  };
  return w.Capacitor?.Plugins || null;
}

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

export type SaveFileResult = 'web' | 'native-downloads' | 'capacitor-share';

export async function saveBlobFile(
  blob: Blob,
  filename: string,
  mimeType?: string
): Promise<SaveFileResult> {
  const resolvedMime =
    mimeType || blob.type || 'application/octet-stream';
  const safeFilename = filename.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'download';

  if (!isCapacitorRuntime()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFilename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    return 'web';
  }

  const base64 = arrayBufferToBase64(await blob.arrayBuffer());

  // 1. Prefer native Android MediaStore Downloads + FileProvider opener
  const androidBridge = getAndroidNativeBridge();
  if (androidBridge && typeof androidBridge.saveToDownloads === 'function') {
    const savedResult = androidBridge.saveToDownloads(
      base64,
      safeFilename,
      resolvedMime
    );
    if (savedResult && !savedResult.startsWith('ERROR:')) {
      return 'native-downloads';
    }
  }

  // 2. Fallback to Capacitor Filesystem + Share plugins
  const plugins = getCapacitorPlugins();
  if (plugins?.Filesystem?.writeFile) {
    let fileUri = '';
    for (const dir of ['DOCUMENTS', 'CACHE']) {
      try {
        const res = await plugins.Filesystem.writeFile({
          path: safeFilename,
          data: base64,
          directory: dir,
        });
        if (res?.uri) {
          fileUri = res.uri;
          break;
        }
      } catch {
        // Try next directory
      }
    }

    if (fileUri) {
      if (plugins.Share?.share) {
        try {
          await plugins.Share.share({
            title: safeFilename,
            text: safeFilename,
            url: fileUri,
            dialogTitle: safeFilename,
          });
        } catch {
          // User may dismiss share sheet after saving to Documents
        }
      }
      return 'capacitor-share';
    }
  }

  throw new Error(
    'APK-তে ফাইল ডাউনলোড করতে সেটিংস থেকে নতুন আপডেটেড APK বিল্ড করে ইনস্টল করুন।'
  );
}

export async function triggerPrint(
  jobTitle = 'Challan_Report',
  onApkFallback?: () => Promise<void>
): Promise<void> {
  if (!isCapacitorRuntime()) {
    window.print();
    return;
  }

  const androidBridge = getAndroidNativeBridge();
  if (androidBridge && typeof androidBridge.printWebView === 'function') {
    androidBridge.printWebView(jobTitle);
    return;
  }

  if (onApkFallback) {
    await onApkFallback();
    return;
  }

  window.print();
}
