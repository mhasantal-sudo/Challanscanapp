import React, { useState, useEffect } from 'react';
import {
  UserPlus,
  Share2,
  Copy,
  Check,
  Trash2,
  Shield,
  Mail,
  KeyRound,
  UserCheck,
  UserX,
  Pencil,
} from 'lucide-react';
import type { PermissionKey, PermissionsMap, UserAccount } from '../types';
import { PERMISSION_LABELS } from '../utils/bengali';
import { apiFetch } from '../utils/api';

const DEFAULT_PERMS: PermissionsMap = {
  scan: true,
  records: true,
  recordEdit: false,
  recordDelete: false,
  report: true,
  templates: true,
  dealers: false,
  settings: false,
  adminUsers: false,
};

const ALL_PERM_KEYS = Object.keys(PERMISSION_LABELS) as PermissionKey[];

export const AdminPanelView: React.FC = () => {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form state for create / edit user
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userIdInput, setUserIdInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [roleInput, setRoleInput] = useState<'operator' | 'admin'>('operator');
  const [permissions, setPermissions] = useState<PermissionsMap>(DEFAULT_PERMS);

  // Share Modal state
  const [shareUser, setShareUser] = useState<UserAccount | null>(null);
  const [copiedId, setCopiedId] = useState(false);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/users');
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const resetForm = () => {
    setEditingUserId(null);
    setUserIdInput('');
    setNameInput('');
    setEmailInput('');
    setPasswordInput('');
    setRoleInput('operator');
    setPermissions({ ...DEFAULT_PERMS });
  };

  const startEdit = (u: UserAccount) => {
    setEditingUserId(u.id);
    setUserIdInput(u.userId);
    setNameInput(u.name);
    setEmailInput(u.email);
    setPasswordInput('');
    setRoleInput(u.role);
    setPermissions({ ...u.permissions });
    setError('');
    setSuccess('');
  };

  const togglePerm = (key: PermissionKey) => {
    setPermissions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (editingUserId) {
      const res = await apiFetch(`/api/users/${editingUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nameInput,
          email: emailInput,
          role: roleInput,
          permissions,
          ...(passwordInput.trim() ? { password: passwordInput.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'আপডেট ব্যর্থ হয়েছে।');
        return;
      }
      setUsers((prev) => prev.map((u) => (u.id === editingUserId ? data.user : u)));
      setSuccess(`"${data.user.name}" এর পাওয়ার ও তথ্য আপডেট করা হয়েছে।`);
      resetForm();
    } else {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: userIdInput,
          name: nameInput,
          email: emailInput,
          password: passwordInput,
          role: roleInput,
          permissions,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'ইউজার তৈরি ব্যর্থ হয়েছে।');
        return;
      }
      setUsers((prev) => [...prev, data.user]);
      setSuccess(`নতুন ইউজার "${data.user.userId}" তৈরি হয়েছে। এখন শেয়ার বাটনে ক্লিক করে অ্যাপ শেয়ার করুন।`);
      resetForm();
    }
  };

  const toggleActive = async (u: UserAccount) => {
    const res = await apiFetch(`/api/users/${u.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !u.active }),
    });
    if (res.ok) {
      const data = await res.json();
      setUsers((prev) => prev.map((item) => (item.id === u.id ? data.user : item)));
    }
  };

  const deleteUser = async (id: string) => {
    const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setUsers((prev) => prev.filter((u) => u.id !== id));
    }
  };

  const getShareUrl = (u: UserAccount) => {
    const origin = window.location.origin;
    return `${origin}/?inviteEmail=${encodeURIComponent(u.email)}`;
  };

  const copyShareMessage = (u: UserAccount) => {
    const grantedList = ALL_PERM_KEYS.filter((k) => u.role === 'admin' || u.permissions[k])
      .map((k) => `• ${PERMISSION_LABELS[k].label}`)
      .join('\n');
    const msg = `চালান স্ক্যান ও ব্যবস্থাপনা অ্যাপ এক্সেস:\nলিঙ্ক: ${getShareUrl(u)}\nইমেইল: ${u.email}\nইউজার আইডি: ${u.userId}\n\nঅনুমোদিত বাটন ও কাজ:\n${grantedList}`;
    navigator.clipboard.writeText(msg);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left: Create / Edit User & Button Power Assignment */}
      <form
        onSubmit={handleSubmit}
        className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 space-y-4"
      >
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-emerald-700" />
            <h2 className="text-base font-bold text-slate-900">
              {editingUserId ? 'ইউজার ও পাওয়ার সংশোধন' : 'নতুন ইউজার ও ইমেইল এক্সেস'}
            </h2>
          </div>
          {editingUserId && (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              নতুন ফর্ম
            </button>
          )}
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
            {error}
          </div>
        )}
        {success && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
            {success}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">ইউজার আইডি</label>
            <input
              type="text"
              required
              disabled={Boolean(editingUserId)}
              placeholder="operator2"
              value={userIdInput}
              onChange={(e) => setUserIdInput(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl disabled:bg-slate-100"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">নাম / পদবি</label>
            <input
              type="text"
              required
              placeholder="মোঃ করিম (অপারেটর)"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-slate-700 mb-1">
              <Mail className="w-3.5 h-3.5 text-emerald-700" />
              <span>এক্সেস ইমেইল অ্যাড্রেস</span>
            </label>
            <input
              type="email"
              required
              placeholder="user@gmail.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
            />
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-slate-700 mb-1">
              <KeyRound className="w-3.5 h-3.5 text-emerald-700" />
              <span>{editingUserId ? 'নতুন পাসওয়ার্ড (ঐচ্ছিক)' : 'পাসওয়ার্ড'}</span>
            </label>
            <input
              type="password"
              required={!editingUserId}
              placeholder="••••••••"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">ইউজার ধরন</label>
          <select
            value={roleInput}
            onChange={(e) => setRoleInput(e.target.value as 'operator' | 'admin')}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white"
          >
            <option value="operator">সীমিত ইউজার (শুধু অনুমোদিত বাটন দেখবে)</option>
            <option value="admin">সুপার এডমিন (সকল এক্সেস)</option>
          </select>
        </div>

        {roleInput === 'operator' && (
          <div className="pt-2 border-t border-slate-200">
            <label className="block text-xs font-bold text-slate-800 mb-2">
              কোন কোন বাটনে কাজ করার পাওয়ার পাবে:
            </label>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {ALL_PERM_KEYS.map((key) => {
                const info = PERMISSION_LABELS[key];
                return (
                  <label
                    key={key}
                    className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-colors ${
                      permissions[key]
                        ? 'bg-emerald-50/70 border-emerald-300'
                        : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(permissions[key])}
                      onChange={() => togglePerm(key)}
                      className="mt-0.5 rounded text-emerald-700 focus:ring-emerald-600"
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900">{info.label}</div>
                      <div className="text-[11px] text-slate-500">{info.desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <button
          type="submit"
          className="w-full py-2.5 px-4 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold rounded-xl transition-colors cursor-pointer"
        >
          {editingUserId ? 'ইউজার আপডেট করুন' : 'ইউজার তৈরি ও এক্সেস দিন'}
        </button>
      </form>

      {/* Right: Existing Users & App Share List */}
      <div className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">অনুমোদিত ইউজার ও শেয়ার তালিকা</h2>
            <p className="text-xs text-slate-500">
              শেয়ার বাটনে ক্লিক করে নির্দিষ্ট ইমেইল অ্যাড্রেস ও লিংক ইউজারকে পাঠান
            </p>
          </div>
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs text-slate-500">লোড হচ্ছে...</div>
        ) : (
          <div className="space-y-3">
            {users.map((u) => {
              const activePerms = ALL_PERM_KEYS.filter(
                (k) => u.role === 'admin' || u.permissions[k]
              );
              return (
                <div
                  key={u.id}
                  className="p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-900">{u.name}</span>
                      <span className="text-xs text-slate-500 font-mono">({u.userId})</span>
                      {!u.active && (
                        <span className="text-[11px] font-semibold text-red-600">· নিষ্ক্রিয়</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-600 flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-slate-400" />
                      <span>{u.email}</span>
                    </div>
                    <div className="text-[11px] text-emerald-800 pt-0.5">
                      পাওয়ার:{' '}
                      {u.role === 'admin'
                        ? 'সকল বাটন (সুপার এডমিন)'
                        : activePerms.map((k) => PERMISSION_LABELS[k].label).join(' · ') ||
                          'কোনো পাওয়ার নেই'}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setShareUser(u)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-semibold cursor-pointer"
                      title="অ্যাপ শেয়ার করুন"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      <span>শেয়ার</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(u)}
                      className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                      title="এডিট"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleActive(u)}
                      className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                      title={u.active ? 'নিষ্ক্রিয় করুন' : 'সক্রিয় করুন'}
                    >
                      {u.active ? (
                        <UserCheck className="w-4 h-4 text-emerald-700" />
                      ) : (
                        <UserX className="w-4 h-4 text-red-600" />
                      )}
                    </button>
                    {u.userId !== 'admin' && (
                      <button
                        type="button"
                        onClick={() => deleteUser(u.id)}
                        className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 cursor-pointer"
                        title="মুছুন"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Share App & Email Access Modal */}
      {shareUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 p-6 space-y-4 shadow-xl">
            <div className="flex items-center gap-2 text-emerald-800">
              <Shield className="w-5 h-5" />
              <h3 className="text-base font-bold text-slate-900">
                অ্যাপ শেয়ার ও ইমেইল এক্সেস কার্ড
              </h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              এই লিংকটি <strong>{shareUser.name}</strong> কে পাঠালে তিনি তার অনুমোদিত ইমেইল (
              <span className="font-mono">{shareUser.email}</span>) ও পাসওয়ার্ড দিয়ে লগইন করে শুধু
              অনুমোদিত বাটনগুলোতে কাজ করতে পারবেন।
            </p>

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs font-mono break-all text-slate-700">
              {getShareUrl(shareUser)}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShareUser(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                বন্ধ করুন
              </button>
              <button
                type="button"
                onClick={() => copyShareMessage(shareUser)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold cursor-pointer"
              >
                {copiedId ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copiedId ? 'কপি হয়েছে!' : 'লিংক ও বিবরণ কপি করুন'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
