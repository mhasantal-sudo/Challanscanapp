import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  Camera,
  Flashlight,
  FlashlightOff,
  Focus,
  RefreshCw,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';

interface ExtendedCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  zoom?: { min: number; max: number; step?: number };
  focusMode?: string[];
}

interface ExtendedConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
  zoom?: number;
  focusMode?: string;
}

interface BarcodeDetectorInstance {
  detect: (
    source: ImageBitmapSource
  ) => Promise<Array<{ rawValue?: string }>>;
}

interface QrScannerModalProps {
  open: boolean;
  targetLabel: string;
  onClose: () => void;
  onDetected: (decodedText: string) => void;
  onPickFileFallback: () => void;
}

function playSuccessTone() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046.5, ctx.currentTime);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // ignore audio block
  }
}

export function QrScannerModal({
  open,
  targetLabel,
  onClose,
  onDetected,
  onPickFileFallback,
}: QrScannerModalProps) {
  const decodeRegionId = `qr_canvas_decode_${useId().replace(/:/g, '_')}`;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const handledRef = useRef(false);
  const html5DecoderRef = useRef<Html5Qrcode | null>(null);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const [zoomRange, setZoomRange] = useState<{
    min: number;
    max: number;
    step: number;
    hardware: boolean;
  }>({ min: 1, max: 3, step: 0.25, hardware: false });
  const [zoomValue, setZoomValue] = useState(1);

  const [focusSupported, setFocusSupported] = useState(false);
  const [decoderMode, setDecoderMode] = useState<'native' | 'canvas'>(
    'canvas'
  );

  const stopStream = useCallback(() => {
    if (trackRef.current) {
      try {
        trackRef.current.stop();
      } catch {
        // ignore
      }
      trackRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setTorchOn(false);
  }, []);

  useEffect(() => {
    if (!open) {
      stopStream();
      return;
    }

    handledRef.current = false;
    setErrorMsg('');
    setStarting(true);
    setZoomValue(1);

    let cancelled = false;
    let rafTimer: number | null = null;
    let fallbackBusy = false;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const BarcodeDetectorCtor = (
      window as unknown as {
        BarcodeDetector?: new (opts: {
          formats: string[];
        }) => BarcodeDetectorInstance;
      }
    ).BarcodeDetector;

    const nativeDetector = BarcodeDetectorCtor
      ? new BarcodeDetectorCtor({ formats: ['qr_code'] })
      : null;

    setDecoderMode(nativeDetector ? 'native' : 'canvas');

    if (!html5DecoderRef.current) {
      try {
        html5DecoderRef.current = new Html5Qrcode(decodeRegionId);
      } catch {
        // ignore
      }
    }

    async function startCamera() {
      try {
        const videoConstraints: MediaTrackConstraints = selectedDeviceId
          ? {
              deviceId: { exact: selectedDeviceId },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            }
          : {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            };

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        const videoTrack = stream.getVideoTracks()[0] || null;
        trackRef.current = videoTrack;

        try {
          const allDevices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = allDevices.filter((d) => d.kind === 'videoinput');
          if (!cancelled) setCameras(videoInputs);
        } catch {
          // ignore
        }

        if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
          const caps = videoTrack.getCapabilities() as ExtendedCapabilities;
          setTorchSupported(Boolean(caps.torch));

          const supportsContinuous =
            Array.isArray(caps.focusMode) &&
            caps.focusMode.includes('continuous');
          setFocusSupported(
            Boolean(Array.isArray(caps.focusMode) && caps.focusMode.length > 0)
          );

          if (supportsContinuous) {
            try {
              const c: ExtendedConstraintSet = { focusMode: 'continuous' };
              await videoTrack.applyConstraints({
                advanced: [c as MediaTrackConstraintSet],
              });
            } catch {
              // ignore
            }
          }

          if (caps.zoom && caps.zoom.max > caps.zoom.min) {
            setZoomRange({
              min: caps.zoom.min,
              max: Math.min(caps.zoom.max, 5),
              step: caps.zoom.step || 0.1,
              hardware: true,
            });
            setZoomValue(caps.zoom.min);
          } else {
            setZoomRange({ min: 1, max: 3, step: 0.25, hardware: false });
          }
        }

        const videoEl = videoRef.current;
        if (videoEl) {
          videoEl.srcObject = stream;
          await videoEl.play();
        }

        if (!cancelled) {
          setStarting(false);
          scheduleScanTick();
        }
      } catch (err) {
        if (!cancelled) {
          setStarting(false);
          const msg =
            err instanceof Error ? err.message : 'ক্যামেরা চালু করা যায়নি।';
          setErrorMsg(
            `ক্যামেরা চালু করা যায়নি (${msg})। নিচের "ছবি তুলে স্ক্যান" ব্যবহার করুন।`
          );
        }
      }
    }

    function handleSuccess(rawText: string) {
      if (handledRef.current || !rawText.trim()) return;
      handledRef.current = true;
      playSuccessTone();
      stopStream();
      onDetected(rawText.trim());
    }

    async function scanFrame() {
      if (cancelled || handledRef.current) return;
      const videoEl = videoRef.current;
      if (
        !videoEl ||
        videoEl.readyState < 2 ||
        videoEl.videoWidth === 0 ||
        videoEl.videoHeight === 0
      ) {
        scheduleScanTick();
        return;
      }

      if (nativeDetector) {
        try {
          const barcodes = await nativeDetector.detect(videoEl);
          if (barcodes.length > 0 && barcodes[0].rawValue) {
            handleSuccess(barcodes[0].rawValue);
            return;
          }
        } catch {
          // fallback
        }
      }

      if (!fallbackBusy && ctx && html5DecoderRef.current) {
        fallbackBusy = true;
        try {
          const vw = videoEl.videoWidth;
          const vh = videoEl.videoHeight;
          const side = Math.min(vw, vh);
          const cropSize = Math.floor(side * 0.78);
          const sx = Math.floor((vw - cropSize) / 2);
          const sy = Math.floor((vh - cropSize) / 2);

          const outSize = Math.min(cropSize, 720);
          canvas.width = outSize;
          canvas.height = outSize;
          ctx.drawImage(
            videoEl,
            sx,
            sy,
            cropSize,
            cropSize,
            0,
            0,
            outSize,
            outSize
          );

          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', 0.9)
          );
          if (blob && !cancelled && !handledRef.current) {
            const file = new File([blob], 'frame.jpg', {
              type: 'image/jpeg',
            });
            const decoded = await html5DecoderRef.current.scanFile(
              file,
              false
            );
            if (decoded) {
              handleSuccess(decoded);
              return;
            }
          }
        } catch {
          // ignore
        } finally {
          fallbackBusy = false;
        }
      }

      scheduleScanTick();
    }

    function scheduleScanTick() {
      if (cancelled || handledRef.current) return;
      rafTimer = window.setTimeout(() => {
        void scanFrame();
      }, nativeDetector ? 110 : 220);
    }

    void startCamera();

    return () => {
      cancelled = true;
      if (rafTimer !== null) clearTimeout(rafTimer);
      stopStream();
    };
  }, [open, selectedDeviceId, decodeRegionId, onDetected, stopStream]);

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track || !torchSupported) return;
    const nextState = !torchOn;
    try {
      const c: ExtendedConstraintSet = { torch: nextState };
      await track.applyConstraints({
        advanced: [c as MediaTrackConstraintSet],
      });
      setTorchOn(nextState);
    } catch {
      // ignore
    }
  }

  async function handleZoomChange(nextZoom: number) {
    setZoomValue(nextZoom);
    const track = trackRef.current;
    if (track && zoomRange.hardware) {
      try {
        const c: ExtendedConstraintSet = { zoom: nextZoom };
        await track.applyConstraints({
          advanced: [c as MediaTrackConstraintSet],
        });
      } catch {
        // ignore
      }
    }
  }

  async function triggerRefocus() {
    const track = trackRef.current;
    if (!track || !focusSupported) return;
    try {
      const single: ExtendedConstraintSet = { focusMode: 'single-shot' };
      await track.applyConstraints({
        advanced: [single as MediaTrackConstraintSet],
      });
      setTimeout(async () => {
        try {
          const cont: ExtendedConstraintSet = { focusMode: 'continuous' };
          await track.applyConstraints({
            advanced: [cont as MediaTrackConstraintSet],
          });
        } catch {
          // ignore
        }
      }, 450);
    } catch {
      // ignore
    }
  }

  function cycleCamera() {
    if (cameras.length < 2) return;
    const currentIdx = cameras.findIndex(
      (c) => c.deviceId === selectedDeviceId
    );
    const nextIdx = (currentIdx + 1) % cameras.length;
    setSelectedDeviceId(cameras[nextIdx].deviceId);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
    >
      <div id={decodeRegionId} className="hidden" />

      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Camera className="h-5 w-5 shrink-0 text-rose-700" />
            <div className="min-w-0">
              <h3
                id="qr-modal-title"
                className="truncate text-sm font-bold text-slate-900"
              >
                {targetLabel} — লাইভ QR স্ক্যানার
              </h3>
              <p className="text-xs text-slate-500">
                {decoderMode === 'native'
                  ? 'উচ্চগতির অটোফোকাস স্ক্যান সক্রিয়'
                  : 'স্মার্ট ফ্রেম ডিকোডার সক্রিয়'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              stopStream();
              onClose();
            }}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            aria-label="বন্ধ করুন"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div
            onClick={triggerRefocus}
            className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-slate-950 cursor-pointer"
          >
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              style={
                !zoomRange.hardware && zoomValue > 1
                  ? { transform: `scale(${zoomValue})` }
                  : undefined
              }
              className="h-full w-full object-cover transition-transform duration-150"
            />

            {!starting && !errorMsg && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative h-52 w-52 sm:h-56 sm:w-56">
                  <span className="absolute left-0 top-0 h-7 w-7 rounded-tl-xl border-l-4 border-t-4 border-emerald-400" />
                  <span className="absolute right-0 top-0 h-7 w-7 rounded-tr-xl border-r-4 border-t-4 border-emerald-400" />
                  <span className="absolute bottom-0 left-0 h-7 w-7 rounded-bl-xl border-b-4 border-l-4 border-emerald-400" />
                  <span className="absolute bottom-0 right-0 h-7 w-7 rounded-br-xl border-b-4 border-r-4 border-emerald-400" />
                </div>
              </div>
            )}

            {starting && !errorMsg && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-sm font-semibold text-white">
                ক্যামেরা ও অটোফোকাস চালু হচ্ছে...
              </div>
            )}

            {!starting && !errorMsg && (
              <div
                className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2">
                  {torchSupported && (
                    <button
                      type="button"
                      onClick={toggleTorch}
                      className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold backdrop-blur-md transition-colors ${
                        torchOn
                          ? 'bg-amber-400 text-slate-950'
                          : 'bg-slate-900/75 text-white hover:bg-slate-900'
                      }`}
                    >
                      {torchOn ? (
                        <FlashlightOff className="h-4 w-4" />
                      ) : (
                        <Flashlight className="h-4 w-4" />
                      )}
                      ফ্ল্যাশ
                    </button>
                  )}

                  {focusSupported && (
                    <button
                      type="button"
                      onClick={triggerRefocus}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-slate-900/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-md hover:bg-slate-900"
                    >
                      <Focus className="h-4 w-4" />
                      ফোকাস
                    </button>
                  )}
                </div>

                {cameras.length > 1 && (
                  <button
                    type="button"
                    onClick={cycleCamera}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-slate-900/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-md hover:bg-slate-900"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    ক্যামেরা বদলান
                  </button>
                )}
              </div>
            )}
          </div>

          {!starting && !errorMsg && (
            <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <ZoomIn className="h-4 w-4 shrink-0 text-slate-600" />
              <span className="text-xs font-semibold text-slate-600 whitespace-nowrap">
                জুম
              </span>
              <input
                type="range"
                min={zoomRange.min}
                max={zoomRange.max}
                step={zoomRange.step}
                value={zoomValue}
                onChange={(e) => void handleZoomChange(Number(e.target.value))}
                className="h-2 flex-1 accent-rose-700"
              />
              <span className="font-mono-num w-10 text-right text-xs font-semibold text-slate-800">
                {zoomValue.toFixed(1)}x
              </span>
            </div>
          )}

          {errorMsg ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {errorMsg}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              চালানের উপরের ডান কোণের QR কোড ফ্রেমে ধরুন। ফোকাস ঠিক করতে ভিডিওতে
              ট্যাপ করুন অথবা কাছাকাছি জুম ব্যবহার করুন।
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={() => {
              stopStream();
              onClose();
              onPickFileFallback();
            }}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Upload className="h-4 w-4" />
            ছবি তুলে স্ক্যান
          </button>
          <button
            type="button"
            onClick={() => {
              stopStream();
              onClose();
            }}
            className="min-h-[44px] rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            বন্ধ করুন
          </button>
        </div>
      </div>
    </div>
  );
}
