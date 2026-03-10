'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { User } from '@tricigo/types';
import type { UserRole } from '@tricigo/types';

const PAGE_SIZE = 20;

const ROLE_FILTERS: { labelKey: string; value: UserRole | 'all' }[] = [
  { labelKey: 'users.filter_all', value: 'all' },
  { labelKey: 'users.filter_customer', value: 'customer' },
  { labelKey: 'users.filter_driver', value: 'driver' },
  { labelKey: 'users.filter_admin', value: 'admin' },
];

const roleBadgeClasses: Record<UserRole, string> = {
  customer: 'bg-blue-50 text-blue-700',
  driver: 'bg-amber-50 text-amber-700',
  admin: 'bg-purple-50 text-purple-700',
  super_admin: 'bg-red-50 text-red-700',
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('es-CU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function UsersPage() {
  const { t } = useTranslation('admin');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [roleFilter, setRoleFilter] = useState<UserRole | 'all'>('all');

  useEffect(() => {
    let cancelled = false;

    async function fetchUsers() {
      setLoading(true);
      try {
        const data = await adminService.getUsers(page, PAGE_SIZE);
        if (!cancelled) {
          setUsers(data);
        }
      } catch (err) {
        console.error('Error fetching users:', err);
        if (!cancelled) {
          setUsers([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchUsers();
    return () => {
      cancelled = true;
    };
  }, [page]);

  const filteredUsers =
    roleFilter === 'all'
      ? users
      : users.filter((u) => u.role === roleFilter);

  const canGoPrev = page > 0;
  const canGoNext = users.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">{t('users.title')}</h1>

      {/* Role filter buttons */}
      <div className="flex gap-2 mb-6">
        {ROLE_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => setRoleFilter(filter.value)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              roleFilter === filter.value
                ? 'bg-[#FF4D00] text-white'
                : 'bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300'
            }`}
          >
            {t(filter.labelKey)}
          </button>
        ))}
      </div>

      {/* Users table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                {t('users.col_name')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                {t('users.col_phone')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                {t('users.col_role')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                {t('users.col_status')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                {t('users.col_registered')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                {t('common.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={6}
                  className="text-center py-12 text-neutral-400"
                >
                  {t('common.loading')}
                </td>
              </tr>
            ) : filteredUsers.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="text-center py-12 text-neutral-400"
                >
                  {t('users.no_users')}
                </td>
              </tr>
            ) : (
              filteredUsers.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-neutral-50 hover:bg-neutral-50/50 transition-colors"
                >
                  <td className="px-6 py-4 text-sm text-neutral-900 font-medium">
                    {user.full_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-600">
                    {user.phone}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        roleBadgeClasses[user.role] ?? 'bg-neutral-100 text-neutral-600'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        user.is_active
                          ? 'bg-green-50 text-green-700'
                          : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {user.is_active ? t('common.active') : t('common.inactive')}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-600">
                    {formatDate(user.created_at)}
                  </td>
                  <td className="px-6 py-4">
                    <Link
                      href={`/users/${user.id}`}
                      className="text-sm font-medium text-[#FF4D00] hover:text-[#e04400] transition-colors"
                    >
                      {t('common.view')}
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canGoPrev}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoPrev
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          {t('common.previous')}
        </button>
        <span className="text-sm text-neutral-500">
          {t('common.page')} {page + 1}
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoNext
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}
