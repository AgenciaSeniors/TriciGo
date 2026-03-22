'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminService, reviewService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import type { User, UserLevel, ReviewTagSummaryItem } from '@tricigo/types';
import { AdminBreadcrumb } from '@/components/ui/AdminBreadcrumb';
import { formatAdminDate } from '@/lib/formatDate';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';

type UserDetail = Awaited<ReturnType<typeof adminService.getUserDetail>>;

const levelBadgeClasses: Record<UserLevel, string> = {
  bronce: 'bg-amber-100 text-amber-800',
  plata: 'bg-neutral-200 text-neutral-700',
  oro: 'bg-yellow-100 text-yellow-800',
};

const LEVEL_LABEL_KEY: Record<UserLevel, string> = {
  bronce: 'users.level_bronze',
  plata: 'users.level_silver',
  oro: 'users.level_gold',
};

const LANG_KEY: Record<string, string> = {
  es: 'users.lang_es',
  en: 'users.lang_en',
};

const roleBadgeClasses: Record<string, string> = {
  customer: 'bg-blue-50 text-blue-700',
  driver: 'bg-amber-50 text-amber-700',
  admin: 'bg-purple-50 text-purple-700',
  super_admin: 'bg-red-50 text-red-700',
};

function formatCurrency(centavos: number): string {
  return `${(centavos / 100).toLocaleString('es-CU', { minimumFractionDigits: 2 })} CUP`;
}

export default function UserDetailPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [levelUpdating, setLevelUpdating] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState<UserLevel>('bronce');
  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [blockUpdating, setBlockUpdating] = useState(false);
  const [topTags, setTopTags] = useState<ReviewTagSummaryItem[]>([]);
  const [confirmModal, setConfirmModal] = useState<{open: boolean; action: () => void; title: string; message: string}>({open: false, action: () => {}, title: '', message: ''});

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      try {
        const [data, reviewSummary] = await Promise.all([
          adminService.getUserDetail(id),
          reviewService.getReviewSummary(id).catch(() => null),
        ]);
        if (!cancelled) {
          setDetail(data);
          setSelectedLevel(data.user.level ?? 'bronce');
          if (reviewSummary?.top_tags) setTopTags(reviewSummary.top_tags);
        }
      } catch (err) {
        // Error handled by UI
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  const handleLevelChange = async () => {
    if (!id || !detail || selectedLevel === detail.user.level) return;
    setConfirmModal({open: true, title: t('users.change_level'), message: `${detail.user.level} → ${selectedLevel}`, action: async () => {
      setConfirmModal(prev => ({...prev, open: false}));
      setLevelUpdating(true);
      try {
        await adminService.updateUserLevel(id, selectedLevel);
        setDetail((prev) =>
          prev
            ? { ...prev, user: { ...prev.user, level: selectedLevel } }
            : null,
        );
        showToast('success', t('users.level_updated', { defaultValue: 'Nivel actualizado' }));
      } catch {
        // Error handled silently
      } finally {
        setLevelUpdating(false);
      }
    }});
  };

  const handleToggleActive = async () => {
    if (!id || !detail) return;
    const newActive = !detail.user.is_active;
    if (!newActive && !blockReason.trim()) return; // Require reason to block
    setBlockUpdating(true);
    try {
      await adminService.toggleUserActive(id, newActive, id, blockReason || undefined);
      setDetail((prev) =>
        prev
          ? { ...prev, user: { ...prev.user, is_active: newActive } }
          : null,
      );
      setBlockModalOpen(false);
      setBlockReason('');
      showToast('success', newActive ? t('users.unblocked', { defaultValue: 'Usuario desbloqueado' }) : t('users.blocked', { defaultValue: 'Usuario bloqueado' }));
    } catch (err) {
      // Error handled by UI
    } finally {
      setBlockUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-neutral-400">{t('common.loading')}</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-neutral-400">{t('users.user_not_found')}</p>
      </div>
    );
  }

  const { user, wallet, transfers, penalties } = detail;
  const currentLevel = (user.level ?? 'bronce') as UserLevel;

  return (
    <div className="max-w-4xl">
      <AdminBreadcrumb items={[{ label: 'Usuarios', href: '/users' }, { label: user.full_name || user.phone }]} />

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">{user.full_name || '—'}</h1>
          <div className="flex items-center gap-2 mt-2">
            <span
              className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                roleBadgeClasses[user.role] ?? 'bg-neutral-100 text-neutral-600'
              }`}
            >
              {user.role}
            </span>
            <span
              className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${levelBadgeClasses[currentLevel]}`}
            >
              {LEVEL_LABEL_KEY[currentLevel] ? t(LEVEL_LABEL_KEY[currentLevel]!) : currentLevel}
            </span>
            <span
              className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                user.is_active
                  ? 'bg-green-50 text-green-700'
                  : 'bg-neutral-100 text-neutral-500'
              }`}
            >
              {user.is_active ? t('common.active') : t('common.inactive')}
            </span>
          </div>
        </div>
        <div>
          {user.is_active ? (
            <button
              onClick={() => setBlockModalOpen(true)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
            >
              {t('users.block_user')}
            </button>
          ) : (
            <button
              onClick={handleToggleActive}
              disabled={blockUpdating}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
            >
              {blockUpdating ? t('common.processing') : t('users.unblock_user')}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Personal Info */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">{t('users.personal_info')}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_name')}</dt>
              <dd className="text-sm font-medium">{user.full_name || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_phone')}</dt>
              <dd className="text-sm font-medium">{user.phone}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_email')}</dt>
              <dd className="text-sm font-medium">{user.email || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_language')}</dt>
              <dd className="text-sm font-medium">{LANG_KEY[user.preferred_language] ? t(LANG_KEY[user.preferred_language]!) : user.preferred_language}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_registered')}</dt>
              <dd className="text-sm font-medium">{formatAdminDate(user.created_at)}</dd>
            </div>
          </dl>
        </div>

        {/* Stats & Level */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">{t('users.stats_section')}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_current_level')}</dt>
              <dd>
                <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${levelBadgeClasses[currentLevel]}`}>
                  {LEVEL_LABEL_KEY[currentLevel] ? t(LEVEL_LABEL_KEY[currentLevel]!) : currentLevel}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_completed_rides')}</dt>
              <dd className="text-sm font-medium">{user.total_rides ?? 0}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_total_spent')}</dt>
              <dd className="text-sm font-medium">{formatCurrency(user.total_spent ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('users.label_cancellations')}</dt>
              <dd className="text-sm font-medium">{user.cancellation_count ?? 0}</dd>
            </div>
            {topTags.length > 0 && (
              <div>
                <dt className="text-sm text-neutral-500 mb-1">{t('users.top_review_tags')}</dt>
                <dd className="flex flex-wrap gap-1">
                  {topTags.slice(0, 5).map((tag) => (
                    <span
                      key={tag.tag_key}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-100 text-xs text-neutral-600"
                    >
                      {t(`drivers.tag_${tag.tag_key}`, { defaultValue: tag.tag_key })}
                      <span className="text-neutral-400">({tag.count})</span>
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>

          {/* Level override */}
          <div className="mt-6 pt-4 border-t border-neutral-100">
            <p className="text-sm font-semibold text-neutral-700 mb-2">{t('users.change_level')}</p>
            <div className="flex items-center gap-2">
              <select
                value={selectedLevel}
                onChange={(e) => setSelectedLevel(e.target.value as UserLevel)}
                className="border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
              >
                <option value="bronce">{t('users.level_bronze')}</option>
                <option value="plata">{t('users.level_silver')}</option>
                <option value="oro">{t('users.level_gold')}</option>
              </select>
              <button
                onClick={handleLevelChange}
                disabled={levelUpdating || selectedLevel === currentLevel}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50"
              >
                {levelUpdating ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Wallet */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">{t('users.wallet_section')}</h2>
        {wallet ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="bg-neutral-50 rounded-lg p-4">
              <p className="text-xs text-neutral-500 mb-1">{t('users.label_available_balance')}</p>
              <p className="text-lg font-bold text-primary-500">{formatCurrency(wallet.balance)}</p>
            </div>
            <div className="bg-neutral-50 rounded-lg p-4">
              <p className="text-xs text-neutral-500 mb-1">{t('users.label_held_balance')}</p>
              <p className="text-lg font-bold text-neutral-700">{formatCurrency(wallet.held_balance)}</p>
            </div>
            <div className="bg-neutral-50 rounded-lg p-4">
              <p className="text-xs text-neutral-500 mb-1">{t('users.label_wallet_status')}</p>
              <p className={`text-lg font-bold ${wallet.is_active ? 'text-green-600' : 'text-red-600'}`}>
                {wallet.is_active ? t('users.wallet_active') : t('users.wallet_inactive')}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-neutral-400">{t('users.no_wallet')}</p>
        )}
      </div>

      {/* Transfers */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
        <h2 className="text-lg font-bold mb-4">{t('users.transfers_section')}</h2>
        {transfers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('users.col_date')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('users.col_type')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('users.col_amount')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('users.col_note')}</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((tx) => {
                  const isSender = tx.from_user_id === id;
                  return (
                    <tr key={tx.id} className="border-b border-neutral-50">
                      <td className="px-4 py-3 text-sm text-neutral-600">
                        {formatAdminDate(tx.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            isSender
                              ? 'bg-red-50 text-red-700'
                              : 'bg-green-50 text-green-700'
                          }`}
                        >
                          {isSender ? t('users.transfer_sent') : t('users.transfer_received')}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-sm font-medium ${isSender ? 'text-red-600' : 'text-green-600'}`}>
                        {isSender ? '-' : '+'}{formatCurrency(tx.amount)}
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-500">
                        {tx.note || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-400">{t('users.no_transfers')}</p>
        )}
      </div>

      {/* Cancellation Penalties */}
      {penalties.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mt-8">
          <h2 className="text-lg font-bold mb-4">{t('users.penalties_section')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('users.col_date')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('users.col_amount')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('users.col_reason')}</th>
                </tr>
              </thead>
              <tbody>
                {penalties.map((p) => (
                  <tr key={p.id} className="border-b border-neutral-50">
                    <td className="px-4 py-3 text-sm text-neutral-600">
                      {formatAdminDate(p.created_at)}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-red-600">
                      {p.amount > 0 ? `-${formatCurrency(p.amount)}` : t('users.no_charge')}
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-500">
                      {p.reason || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AdminConfirmModal
        open={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        onConfirm={confirmModal.action}
        onCancel={() => setConfirmModal(prev => ({...prev, open: false}))}
      />

      {/* Block User Modal */}
      {blockModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold mb-4">{t('users.block_user')}</h3>
            <p className="text-sm text-neutral-600 mb-4">{t('users.block_confirm')}</p>
            <textarea
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
              placeholder={t('users.block_reason')}
              className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:border-primary-500"
              rows={3}
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setBlockModalOpen(false); setBlockReason(''); }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-100 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleToggleActive}
                disabled={blockUpdating || !blockReason.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {blockUpdating ? t('common.processing') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
