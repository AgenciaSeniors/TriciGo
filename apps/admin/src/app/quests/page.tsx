'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { questService } from '@tricigo/api/services/quest';
import type { Quest } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { AdminEmptyState } from '@/components/ui/AdminEmptyState';
import { Trophy } from 'lucide-react';
import { useSortableTable } from '@/hooks/useSortableTable';
import { SortableHeader } from '@/components/ui/SortableHeader';

const QUEST_TYPES = ['trip_count', 'earnings', 'rating', 'hours_online', 'peak_hours'] as const;

const QUEST_TYPE_LABELS: Record<string, { es: string; en: string }> = {
  trip_count: { es: 'Numero de viajes', en: 'Trip count' },
  earnings: { es: 'Ganancias', en: 'Earnings' },
  rating: { es: 'Calificacion', en: 'Rating' },
  hours_online: { es: 'Horas en linea', en: 'Hours online' },
  peak_hours: { es: 'Horas pico', en: 'Peak hours' },
};

const PAGE_SIZE = 20;

export default function QuestsPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  // Create form state
  const [titleEs, setTitleEs] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [descEs, setDescEs] = useState('');
  const [descEn, setDescEn] = useState('');
  const [questType, setQuestType] = useState<string>('trip_count');
  const [targetValue, setTargetValue] = useState('');
  const [rewardCup, setRewardCup] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    loadQuests();
  }, [page]);

  const loadQuests = async () => {
    setLoading(true);
    try {
      const data = await questService.getAllQuests(page, PAGE_SIZE);
      setQuests(data);
    } catch (err) {
      // Error handled by UI
      setError(err instanceof Error ? err.message : 'Error al cargar misiones');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!titleEs || !targetValue || !rewardCup || !startDate || !endDate) return;
    setCreating(true);
    try {
      await questService.createQuest({
        title_es: titleEs,
        title_en: titleEn || titleEs,
        description_es: descEs,
        description_en: descEn || descEs,
        quest_type: questType as Quest['quest_type'],
        target_value: parseFloat(targetValue),
        reward_cup: parseInt(rewardCup, 10),
        start_date: startDate,
        end_date: endDate,
        is_active: true,
      });
      setShowCreate(false);
      resetForm();
      setPage(0);
      loadQuests();
    } catch (err) {
      // Error handled by UI
      showToast('error', 'Error al crear misión');
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (id: string, current: boolean) => {
    try {
      await questService.toggleQuest(id, !current);
      loadQuests();
    } catch (err) {
      // Error handled by UI
    }
  };

  const resetForm = () => {
    setTitleEs(''); setTitleEn(''); setDescEs(''); setDescEn('');
    setQuestType('trip_count'); setTargetValue(''); setRewardCup('');
    setStartDate(''); setEndDate('');
  };

  function formatCurrency(centavos: number): string {
    return `${(centavos / 100).toLocaleString('es-CU', { minimumFractionDigits: 2 })} CUP`;
  }

  const { sortedData, toggleSort, sortKey, sortDirection } = useSortableTable(quests, 'start_date');

  const canGoPrev = page > 0;
  const canGoNext = quests.length === PAGE_SIZE;

  const isExpired = (q: Quest) => new Date(q.end_date) < new Date();
  const isActive = (q: Quest) => q.is_active && !isExpired(q);

  return (
    <div className="max-w-5xl">
      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); loadQuests(); }}
          onDismiss={() => setError(null)}
        />
      )}

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">{t('quests.title', { defaultValue: 'Misiones' })}</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600"
        >
          {showCreate ? t('common.cancel') : t('quests.create', { defaultValue: '+ Crear mision' })}
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">{t('quests.new_quest', { defaultValue: 'Nueva mision' })}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Titulo (ES)</label>
              <input type="text" value={titleEs} onChange={(e) => setTitleEs(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Title (EN)</label>
              <input type="text" value={titleEn} onChange={(e) => setTitleEn(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Descripcion (ES)</label>
              <textarea value={descEs} onChange={(e) => setDescEs(e.target.value)} rows={2}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Description (EN)</label>
              <textarea value={descEn} onChange={(e) => setDescEn(e.target.value)} rows={2}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('quests.type', { defaultValue: 'Tipo' })}</label>
              <select value={questType} onChange={(e) => setQuestType(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500">
                {QUEST_TYPES.map((qt) => (
                  <option key={qt} value={qt}>{QUEST_TYPE_LABELS[qt]?.es ?? qt}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('quests.target', { defaultValue: 'Objetivo' })}</label>
              <input type="number" value={targetValue} onChange={(e) => setTargetValue(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                placeholder="20" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('quests.reward', { defaultValue: 'Recompensa (centavos CUP)' })}</label>
              <input type="number" value={rewardCup} onChange={(e) => setRewardCup(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                placeholder="50000" />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-neutral-700 mb-1">{t('quests.start_date', { defaultValue: 'Inicio' })}</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                  className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500" />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-neutral-700 mb-1">{t('quests.end_date', { defaultValue: 'Fin' })}</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                  className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500" />
              </div>
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={creating || !titleEs || !targetValue || !rewardCup || !startDate || !endDate}
            className="mt-4 px-6 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
          >
            {creating ? t('common.processing') : t('quests.create_btn', { defaultValue: 'Crear mision' })}
          </button>
        </div>
      )}

      {/* Quests List */}
      {loading ? (
        <AdminTableSkeleton rows={5} columns={4} />
      ) : quests.length === 0 ? (
        <AdminEmptyState icon={<Trophy className="w-10 h-10 text-neutral-300 dark:text-neutral-500" />} title={t('quests.no_quests', { defaultValue: 'No hay misiones creadas' })} />
      ) : (
        <>
        <div className="flex gap-2 mb-4">
          <SortableHeader label={t('quests.sort_date', { defaultValue: 'Fecha' })} sortKey="start_date" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600" />
          <SortableHeader label={t('quests.sort_status', { defaultValue: 'Estado' })} sortKey="is_active" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600" />
        </div>
        <div className="space-y-3">
          {sortedData.map((q) => (
            <div key={q.id} className="bg-white rounded-xl shadow-sm border border-neutral-100 p-5 flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-bold">{q.title_es}</h3>
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                    isActive(q) ? 'bg-green-50 text-green-700'
                    : isExpired(q) ? 'bg-neutral-100 text-neutral-500'
                    : 'bg-red-50 text-red-700'
                  }`}>
                    {isActive(q) ? 'Activa' : isExpired(q) ? 'Expirada' : 'Inactiva'}
                  </span>
                  <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                    {QUEST_TYPE_LABELS[q.quest_type]?.es ?? q.quest_type}
                  </span>
                </div>
                <p className="text-sm text-neutral-500">{q.description_es}</p>
                <p className="text-xs text-neutral-400 mt-1">
                  Objetivo: {q.target_value} | Recompensa: {formatCurrency(q.reward_cup)} | {q.start_date} → {q.end_date}
                </p>
              </div>
              <button
                onClick={() => handleToggle(q.id, q.is_active)}
                aria-label={q.is_active ? `Desactivar ${q.title_es}` : `Activar ${q.title_es}`}
                className={`ml-4 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  q.is_active
                    ? 'bg-red-50 text-red-700 hover:bg-red-100'
                    : 'bg-green-50 text-green-700 hover:bg-green-100'
                }`}
              >
                {q.is_active ? 'Desactivar' : 'Activar'}
              </button>
            </div>
          ))}
        </div>
        </>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canGoPrev}
          aria-label={t('common.previous')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoPrev
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          {t('common.previous')}
        </button>
        <span className="text-sm text-neutral-500" aria-live="polite">
          {t('common.page')} {page + 1}
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
          aria-label={t('common.next')}
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
