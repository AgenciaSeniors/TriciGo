'use client';

import { useEffect, useState } from 'react';
import { lostItemService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import { formatCUP } from '@tricigo/utils';
import type { LostItem, LostItemStatus } from '@tricigo/types';
import { formatAdminDate } from '@/lib/formatDate';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';

const statusBadge: Record<string, string> = {
  reported: 'bg-blue-50 text-blue-700',
  driver_notified: 'bg-yellow-50 text-yellow-700',
  found: 'bg-green-50 text-green-700',
  not_found: 'bg-red-50 text-red-700',
  return_arranged: 'bg-purple-50 text-purple-700',
  returned: 'bg-green-100 text-green-800',
  closed: 'bg-neutral-100 text-neutral-500',
};

const categoryIcons: Record<string, string> = {
  phone: '📱',
  wallet: '👛',
  bag: '🎒',
  clothing: '👕',
  electronics: '💻',
  documents: '📄',
  keys: '🔑',
  other: '❓',
};

export default function LostFoundPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [items, setItems] = useState<LostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<LostItemStatus | 'all'>('reported');
  const [selected, setSelected] = useState<LostItem | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [closing, setClosing] = useState(false);

  const fetchItems = async () => {
    setLoading(true);
    try {
      const data = await lostItemService.getAllLostItems({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });
      setItems(data);
    } catch (err) {
      console.error('Error fetching lost items:', err);
      setError(err instanceof Error ? err.message : 'Error al cargar objetos perdidos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchItems();
  }, [statusFilter]);

  const handleSelect = (item: LostItem) => {
    setSelected(item);
    setAdminNotes(item.admin_notes ?? '');
  };

  const handleSaveNotes = async () => {
    if (!selected) return;
    try {
      await lostItemService.addAdminNotes(selected.id, adminNotes);
      setSelected((prev) => prev ? { ...prev, admin_notes: adminNotes } : null);
    } catch (err) {
      console.error('Error saving notes:', err);
    }
  };

  const handleClose = async () => {
    if (!selected) return;
    setClosing(true);
    try {
      const updated = await lostItemService.closeLostItem(
        selected.id,
        adminUserId,
        adminNotes || undefined,
      );
      setItems((prev) => prev.map((i) => (i.id === selected.id ? updated : i)));
      setSelected(updated);
    } catch (err) {
      console.error('Error closing item:', err);
    } finally {
      setClosing(false);
    }
  };

  const FILTER_TABS = ['all', 'reported', 'found', 'not_found', 'return_arranged', 'returned', 'closed'] as const;

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6">{t('lost_found.title')}</h1>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); fetchItems(); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {FILTER_TABS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {t(`lost_found.filter_${s}`)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Item list */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
          <div className="max-h-[650px] overflow-y-auto">
            {loading ? (
              <div className="px-4 py-4">
                <AdminTableSkeleton rows={5} columns={4} />
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-12 text-neutral-400">
                {t('lost_found.no_items')}
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item)}
                  className={`w-full text-left px-4 py-3 border-b border-neutral-50 hover:bg-neutral-50 transition-colors ${
                    selected?.id === item.id ? 'bg-amber-50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium truncate pr-2">
                      {categoryIcons[item.category] ?? '❓'} {item.description.slice(0, 50)}{item.description.length > 50 ? '…' : ''}
                    </span>
                    <span className={`shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                      statusBadge[item.status] ?? 'bg-neutral-100'
                    }`}>
                      {t(`lost_found.filter_${item.status}`, { defaultValue: item.status })}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-400">
                      Ride: {item.ride_id.slice(0, 8)}…
                    </span>
                    <span className="text-xs text-neutral-400 ml-auto">
                      {formatAdminDate(item.created_at)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Item detail */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          {selected ? (
            <div className="max-h-[650px] overflow-y-auto space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  {categoryIcons[selected.category]} {t('lost_found.item_category')}: {selected.category}
                </h2>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  statusBadge[selected.status] ?? ''
                }`}>
                  {t(`lost_found.filter_${selected.status}`, { defaultValue: selected.status })}
                </span>
              </div>

              <div className="text-xs text-neutral-400">
                Ride: {selected.ride_id}
              </div>

              {/* Rider report */}
              <div className="border border-neutral-100 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-2">{t('lost_found.rider_side')}</h3>
                <p className="text-sm text-neutral-700">{selected.description}</p>
                {selected.photo_urls.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-neutral-400 mb-1">{t('lost_found.item_photos')}</p>
                    <div className="flex gap-2 flex-wrap">
                      {selected.photo_urls.map((url, i) => (
                        <a key={i} href={url} target="_blank" rel="noopener" className="text-xs text-primary-500 underline">
                          Photo {i + 1}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Driver response */}
              <div className="border border-neutral-100 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-2">{t('lost_found.driver_side')}</h3>
                {selected.driver_found !== null ? (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        selected.driver_found ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                      }`}>
                        {selected.driver_found ? '✓ Found' : '✗ Not found'}
                      </span>
                    </div>
                    {selected.driver_response && (
                      <p className="text-sm text-neutral-700">{selected.driver_response}</p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-neutral-400 italic">{t('lost_found.no_driver_response')}</p>
                )}
              </div>

              {/* Return details */}
              {selected.status === 'return_arranged' || selected.status === 'returned' ? (
                <div className="border border-green-200 rounded-lg p-4 bg-green-50">
                  <h3 className="text-sm font-semibold mb-2">{t('lost_found.return_details')}</h3>
                  {selected.return_fee_cup != null && selected.return_fee_cup > 0 && (
                    <p className="text-sm text-green-700">
                      {t('lost_found.return_fee')}: {formatCUP(selected.return_fee_cup)}
                    </p>
                  )}
                  {selected.return_location && (
                    <p className="text-sm text-neutral-600">
                      {t('lost_found.return_location')}: {selected.return_location}
                    </p>
                  )}
                  {selected.return_notes && (
                    <p className="text-sm text-neutral-500 mt-1">{selected.return_notes}</p>
                  )}
                </div>
              ) : null}

              {/* Close button (non-resolved items) */}
              {selected.status !== 'returned' && selected.status !== 'closed' && (
                <button
                  onClick={handleClose}
                  disabled={closing}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-600 text-white hover:bg-neutral-700 disabled:opacity-50"
                >
                  {t('lost_found.close_item')}
                </button>
              )}

              {/* Admin notes */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t('lost_found.admin_notes')}</h3>
                <textarea
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 min-h-[60px]"
                  placeholder={t('lost_found.admin_notes_placeholder')}
                />
                <button
                  onClick={handleSaveNotes}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                >
                  {t('common.save')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[650px] text-neutral-400">
              {t('lost_found.select_item')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
