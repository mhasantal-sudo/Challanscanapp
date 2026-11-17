import type { PermissionKey } from '../types.ts';

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBnDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) => BN_DIGITS[Number(d)] ?? d);
}

export function formatBnCurrency(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(safe);
  return toBnDigits(formatted);
}

export function formatBnDate(isoDate: string): string {
  if (!isoDate) return '—';
  const parts = isoDate.split('-');
  if (parts.length !== 3) return toBnDigits(isoDate);
  const [y, m, d] = parts;
  return toBnDigits(`${d}/${m}/${y}`);
}

export const PERMISSION_LABELS: Record<PermissionKey, { label: string; desc: string }> = {
  scan: {
    label: 'চালান স্ক্যান ও এন্ট্রি',
    desc: 'ক্যামেরা/ছবি আপলোড করে চালান স্ক্যান ও নতুন তথ্য সেভ করা',
  },
  records: {
    label: 'চালান তালিকা দেখা',
    desc: 'সংরক্ষিত চালান তালিকা সার্চ ও দেখার এক্সেস',
  },
  recordEdit: {
    label: 'চালান তথ্য সংশোধন',
    desc: 'সংরক্ষিত চালানের টাকা, কোড বা বিবরণ এডিট করা',
  },
  recordDelete: {
    label: 'চালান মুছে ফেলা',
    desc: 'ভুল বা ডুপ্লিকেট এন্ট্রি মুছে ফেলা',
  },
  report: {
    label: 'রিপোর্ট ও পিডিএফ প্রিভিউ',
    desc: 'নিকশ ফন্টে A4 রেজিস্টার রিপোর্ট প্রিভিউ ও পিডিএফ ডাউনলোড',
  },
  templates: {
    label: 'টেমপ্লেট ও রিপোর্ট পূরণ',
    desc: 'নির্ধারিত ফরম্যাটে তারিখ, স্মারক ও প্রাপক পূরণ এবং প্রিন্ট',
  },
  dealers: {
    label: 'ডিলার ও লাইসেন্সধারী',
    desc: 'খাদ্য বান্ধব, ওএমএস ডিলার ও লাইসেন্সধারী তালিকা পরিচালনা',
  },
  settings: {
    label: 'সেটিংস ও কনফিগারেশন',
    desc: 'অফিস তথ্য, স্বাক্ষর, Google Sheet, খাত ও টেমপ্লেট সেটিং',
  },
  adminUsers: {
    label: 'এডমিন ও ইউজার অ্যাক্সেস',
    desc: 'নতুন ইউজার তৈরি, ইমেইল/বাটন পাওয়ার ও অ্যাপ শেয়ার করা',
  },
};
