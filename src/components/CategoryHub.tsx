import { useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  FileBadge2,
  Flame,
  Receipt,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Wheat,
} from 'lucide-react';
import type {
  KhatColorKey,
  KhatConfig,
  KhatGroup,
  KhatIconKey,
  LicenseSubGroup,
} from '../types.ts';

interface CategoryHubProps {
  khats: KhatConfig[];
  unlinkedSuballocationCount: number;
  dealersCount: number;
  canOpenSettings?: boolean;
  onSelectKhat: (
    khat: KhatConfig,
    licenseActionType?: 'নতুন' | 'নবায়ন' | 'জরিমানা' | 'অন্যান্য'
  ) => void;
  onOpenSettings: () => void;
}

const COLOR_MAP: Record<
  KhatColorKey,
  { bg: string; ring: string; text: string }
> = {
  rose: {
    bg: 'bg-rose-50',
    ring: 'border-rose-200',
    text: 'text-rose-600',
  },
  sky: {
    bg: 'bg-sky-50',
    ring: 'border-sky-200',
    text: 'text-sky-700',
  },
  indigo: {
    bg: 'bg-indigo-50',
    ring: 'border-indigo-200',
    text: 'text-indigo-700',
  },
  purple: {
    bg: 'bg-purple-50',
    ring: 'border-purple-200',
    text: 'text-purple-700',
  },
  amber: {
    bg: 'bg-amber-50',
    ring: 'border-amber-200',
    text: 'text-amber-700',
  },
  orange: {
    bg: 'bg-orange-50',
    ring: 'border-orange-200',
    text: 'text-orange-700',
  },
  teal: {
    bg: 'bg-teal-50',
    ring: 'border-teal-200',
    text: 'text-teal-700',
  },
  emerald: {
    bg: 'bg-emerald-50',
    ring: 'border-emerald-200',
    text: 'text-emerald-700',
  },
  red: {
    bg: 'bg-red-50',
    ring: 'border-red-200',
    text: 'text-red-700',
  },
};

export function renderKhatIcon(iconKey: KhatIconKey, className: string) {
  switch (iconKey) {
    case 'wheat':
      return <Wheat className={className} />;
    case 'bag':
      return <ShoppingBag className={className} />;
    case 'flame':
      return <Flame className={className} />;
    case 'license':
      return <FileBadge2 className={className} />;
    case 'refresh':
      return <RefreshCw className={className} />;
    case 'alert':
      return <AlertCircle className={className} />;
    case 'shield':
      return <ShieldCheck className={className} />;
    case 'receipt':
    default:
      return <Receipt className={className} />;
  }
}

const LICENSE_SUBGROUPS: Array<{
  id: LicenseSubGroup;
  label: string;
  actionType: 'নতুন' | 'নবায়ন' | 'জরিমানা' | 'অন্যান্য';
}> = [
  { id: 'new', label: 'নতুন লাইসেন্স', actionType: 'নতুন' },
  { id: 'renewal', label: 'নবায়ন', actionType: 'নবায়ন' },
  { id: 'fine', label: 'জরিমানা', actionType: 'জরিমানা' },
  { id: 'other', label: 'অন্যান্য', actionType: 'অন্যান্য' },
];

export function CategoryHub({
  khats,
  unlinkedSuballocationCount,
  dealersCount,
  canOpenSettings = true,
  onSelectKhat,
  onOpenSettings,
}: CategoryHubProps) {
  const [group, setGroup] = useState<KhatGroup>('grain');
  const [licenseSubGroup, setLicenseSubGroup] =
    useState<LicenseSubGroup>('new');
  const touchStartX = useRef<number | null>(null);
  const subTouchStartX = useRef<number | null>(null);

  const grainKhats = khats.filter((k) => k.active && k.group === 'grain');

  const licenseSubKhats = khats.filter((k) => {
    if (!k.active || k.group !== 'license') return false;
    if (licenseSubGroup === 'new' || licenseSubGroup === 'renewal') {
      return (
        k.subGroup === 'new' ||
        k.subGroup === 'renewal' ||
        (!k.subGroup && k.name.includes('লাইসেন্স'))
      );
    }
    if (licenseSubGroup === 'fine') {
      return k.subGroup === 'fine' || k.name.includes('জরিমানা');
    }
    return k.subGroup === 'other' || k.name.includes('অন্যান্য');
  });

  const visibleKhats = group === 'grain' ? grainKhats : licenseSubKhats;
  const activeActionType =
    LICENSE_SUBGROUPS.find((s) => s.id === licenseSubGroup)?.actionType ||
    'নতুন';

  function handleMainSwipeEnd(endX: number) {
    if (touchStartX.current === null) return;
    const dx = endX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 48) return;
    if (dx < 0 && group === 'grain') setGroup('license');
    if (dx > 0 && group === 'license') setGroup('grain');
  }

  function handleSubSwipeEnd(endX: number) {
    if (subTouchStartX.current === null) return;
    const dx = endX - subTouchStartX.current;
    subTouchStartX.current = null;
    if (Math.abs(dx) < 42) return;
    const idx = LICENSE_SUBGROUPS.findIndex((s) => s.id === licenseSubGroup);
    if (dx < 0 && idx < LICENSE_SUBGROUPS.length - 1) {
      setLicenseSubGroup(LICENSE_SUBGROUPS[idx + 1].id);
    } else if (dx > 0 && idx > 0) {
      setLicenseSubGroup(LICENSE_SUBGROUPS[idx - 1].id);
    }
  }

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 select-none"
      onTouchStart={(e) => {
        touchStartX.current = e.changedTouches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const endX = e.changedTouches[0]?.clientX;
        if (typeof endX === 'number') handleMainSwipeEnd(endX);
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="grid flex-1 grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setGroup('grain')}
            className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors sm:text-sm whitespace-nowrap ${
              group === 'grain'
                ? 'bg-rose-700 text-white shadow-xs'
                : 'text-slate-700 hover:text-slate-900'
            }`}
          >
            <Wheat className="h-4 w-4 shrink-0" />
            <span>খাদ্যশস্য</span>
          </button>

          <button
            type="button"
            onClick={() => setGroup('license')}
            className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors sm:text-sm whitespace-nowrap ${
              group === 'license'
                ? 'bg-rose-700 text-white shadow-xs'
                : 'text-slate-700 hover:text-slate-900'
            }`}
          >
            <FileBadge2 className="h-4 w-4 shrink-0" />
            <span>লাইসেন্স ও অন্যান্য</span>
          </button>
        </div>

        {canOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="সেটিংস"
            title="খাত ও শিট সেটিংস"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
        )}
      </div>

      {group === 'license' && (
        <div
          className="mt-3 flex items-center gap-1 rounded-xl border border-rose-100 bg-rose-50/50 p-1 overflow-x-auto"
          onTouchStart={(e) => {
            e.stopPropagation();
            subTouchStartX.current = e.changedTouches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            e.stopPropagation();
            const endX = e.changedTouches[0]?.clientX;
            if (typeof endX === 'number') handleSubSwipeEnd(endX);
          }}
        >
          {LICENSE_SUBGROUPS.map((sub) => {
            const active = licenseSubGroup === sub.id;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => setLicenseSubGroup(sub.id)}
                className={`flex-1 min-h-[38px] rounded-lg px-2.5 py-1.5 text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-white text-rose-800 shadow-xs border border-rose-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sub.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-5 grid grid-cols-3 gap-x-2 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
        {visibleKhats.map((khat) => {
          const palette = COLOR_MAP[khat.colorKey] || COLOR_MAP.rose;
          return (
            <button
              key={`${group}-${licenseSubGroup}-${khat.id}`}
              type="button"
              onClick={() =>
                onSelectKhat(
                  khat,
                  group === 'license' ? activeActionType : undefined
                )
              }
              className="group flex flex-col items-center gap-2 rounded-xl p-1.5 text-center transition-transform active:scale-95 hover:bg-slate-50"
            >
              <span
                className={`flex h-16 w-16 items-center justify-center rounded-full border-2 transition-transform group-hover:scale-105 ${palette.bg} ${palette.ring}`}
              >
                {renderKhatIcon(khat.iconKey, `h-7 w-7 ${palette.text}`)}
              </span>
              <span className="text-xs font-bold text-slate-800 leading-tight">
                {khat.name}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-500 tabular-nums">
        <div className="flex items-center gap-2">
          <span>বরাদ্দ বাকি: {unlinkedSuballocationCount}</span>
          <span aria-hidden="true">·</span>
          <span>ডিলার: {dealersCount}</span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setGroup('grain')}
            aria-label="খাদ্যশস্য"
            className={`rounded-md p-1 ${
              group === 'grain' ? 'text-rose-700' : 'text-slate-400'
            }`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span
            className={`h-1.5 w-4 rounded-full ${
              group === 'grain' ? 'bg-rose-600' : 'bg-slate-200'
            }`}
          />
          <span
            className={`h-1.5 w-4 rounded-full ${
              group === 'license' ? 'bg-rose-600' : 'bg-slate-200'
            }`}
          />
          <button
            type="button"
            onClick={() => setGroup('license')}
            aria-label="লাইসেন্স"
            className={`rounded-md p-1 ${
              group === 'license' ? 'text-rose-700' : 'text-slate-400'
            }`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}
