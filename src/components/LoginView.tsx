import React, { useState, useEffect } from 'react';
import { Lock, Mail, User, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import type { UserAccount } from '../types';
import { apiFetch, setAuthToken } from '../utils/api';

interface LoginViewProps {
  onLoginSuccess: (user: UserAccount) => void;
  lockEnabled?: boolean;
}

export const LoginView: React.FC<LoginViewProps> = ({
  onLoginSuccess,
  lockEnabled = false,
}) => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showIdentifierField, setShowIdentifierField] = useState(false);
  const [loading, setLoading] = useState(false);
  const [quickLoading, setQuickLoading] = useState<'admin' | 'operator' | null>(null);
  const [error, setError] = useState('');
  const [invitedNotice, setInvitedNotice] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteEmail = params.get('inviteEmail');
    if (inviteEmail) {
      setIdentifier(inviteEmail);
      setShowIdentifierField(true);
      setInvitedNotice(
        `আপনাকে ${inviteEmail} ইমেইলের মাধ্যমে এই অ্যাপে এক্সেস দেওয়া হয়েছে। এডমিন প্রদত্ত পাসওয়ার্ড দিয়ে লগইন করুন।`
      );
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: showIdentifierField ? identifier.trim() : '',
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'লগইন ব্যর্থ হয়েছে।');
        return;
      }
      if (data.token) {
        setAuthToken(data.token);
      }
      onLoginSuccess(data.user);
    } catch {
      setError('সার্ভারের সাথে সংযোগ স্থাপন করা যায়নি।');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickLogin = async (target: 'admin' | 'operator') => {
    setError('');
    setQuickLoading(target);
    try {
      const res = await apiFetch('/api/auth/quick-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'লগইন ব্যর্থ হয়েছে।');
        return;
      }
      if (data.token) {
        setAuthToken(data.token);
      }
      onLoginSuccess(data.user);
    } catch {
      setError('সার্ভারের সাথে সংযোগ স্থাপন করা যায়নি।');
    } finally {
      setQuickLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-7 sm:p-8 shadow-sm">
        <div className="mb-6">
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-rose-700 text-white mb-4">
            {lockEnabled ? (
              <Lock className="w-5 h-5" />
            ) : (
              <ShieldCheck className="w-5 h-5" />
            )}
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
            {lockEnabled ? 'পোর্টাল লক করা আছে' : 'চালান স্ক্যান ও ব্যবস্থাপনা'}
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-1">
            {lockEnabled
              ? 'প্রবেশ করতে নির্ধারিত লক পাসওয়ার্ড দিন'
              : 'ট্রেজারি চালান, আয়কর প্রাপ্য ও অফিসিয়াল রিপোর্ট পোর্টাল'}
          </p>
        </div>

        {invitedNotice && (
          <div className="mb-5 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 leading-relaxed">
            {invitedNotice}
          </div>
        )}

        {error && (
          <div className="mb-5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Instant One-Tap Access (only shown when Lock System is OFF) */}
        {!lockEnabled && (
          <>
            <div className="mb-6 p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                <Sparkles className="w-3.5 h-3.5 text-emerald-700" />
                <span>সরাসরি প্রবেশ করুন</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={quickLoading !== null}
                  onClick={() => handleQuickLogin('admin')}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-colors disabled:opacity-60 cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  <span>{quickLoading === 'admin' ? 'প্রবেশ হচ্ছে...' : 'এডমিন প্রবেশ'}</span>
                </button>
                <button
                  type="button"
                  disabled={quickLoading !== null}
                  onClick={() => handleQuickLogin('operator')}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-60 cursor-pointer"
                >
                  <User className="w-3.5 h-3.5 shrink-0 text-slate-600" />
                  <span>{quickLoading === 'operator' ? 'প্রবেশ হচ্ছে...' : 'সীমিত ইউজার'}</span>
                </button>
              </div>
            </div>

            <div className="relative flex items-center justify-center mb-5">
              <div className="border-t border-slate-200 w-full" />
              <span className="bg-white px-3 text-[11px] text-slate-400 whitespace-nowrap">
                অথবা পাসওয়ার্ড দিয়ে লগইন
              </span>
              <div className="border-t border-slate-200 w-full" />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          {showIdentifierField && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                ইউজার আইডি বা ইমেইল অ্যাড্রেস (ঐচ্ছিক)
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  name="challan_identifier"
                  autoComplete="off"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="ইউজার আইডি বা ইমেইল"
                  className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-600 focus:border-rose-600"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              পাসওয়ার্ড
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                name="challan_access_code"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="পাসওয়ার্ড লিখুন"
                required
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-600 focus:border-rose-600"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex min-h-[44px] items-center justify-center gap-2 py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 cursor-pointer"
          >
            <span>{loading ? 'যাচাই করা হচ্ছে...' : lockEnabled ? 'আনলক করুন' : 'লগইন করুন'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => setShowIdentifierField((v) => !v)}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800 hover:underline cursor-pointer"
            >
              {showIdentifierField
                ? 'শুধু পাসওয়ার্ড দিয়ে প্রবেশ করুন'
                : 'অন্য ইউজার আইডি / ইমেইল দিয়ে লগইন'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
