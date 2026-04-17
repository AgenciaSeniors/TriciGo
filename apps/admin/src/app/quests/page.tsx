'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trophy, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { questService } from '@tricigo/api/services/quest';
import type { Quest } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';

const QUEST_TYPES = ['trip_count', 'earnings', 'rating', 'hours_online', 'peak_hours'] as const;

const PAGE_SIZE = 20;

type Filter = 'all' | 'active' | 'expired' | 'inactive';

type QuestState = 'active' | 'expired' | 'inactive';

function questState(q: Quest): QuestState {
  const expired = new Date(q.end_date) < new Date();
  if (expired) return 'expired';
  return q.is_active ? 'active' : 'inactive';
}

const STATE_CLASS: Record<QuestState, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  expired: 'bg-surface-sunken text-ink-muted',
  inactive: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

export default function QuestsPage() {
  const { t } = useTranslation('admin');
  const questTypeLabel = (type: string): string => {
    const fallbacks: Record<string, string> = {
      trip_count: 'Número de viajes', earnings: 'Ganancias', rating: 'Calificación',
      hours_online: 'Horas en línea', peak_hours: 'Horas pico',
    };
    return t(`quests.type_${type}`, { defaultValue: fallbacks[type] ?? type });
  };
  const stateLabel = (s: QuestState): string => {
    const fallbacks: Record<QuestState, string> = { active: 'Activa', expired: 'Expirada', inactive: 'Inactiva' };
    return t(`quests.state_${s}`, { defaultValue: fallbacks[s] });
  };
  const TABS: StatusTab<Filter>[] = [
    { id: 'all', label: t('quests.filter_all', { defaultValue: 'Todas' }) },
    { id: 'active', label: t('quests.filter_active', { defaultValue: 'Activas' }), tone: 'success' },
    { id: 'inactive', label: t('quests.filter_inactive', { defaultValue: 'Inactivas' }), tone: 'warning' },
    { id: 'expired', label: t('quests.filter_expired', { defaultValue: 'Expiradas' }) },
  ];
  const { showToast } = useToast();
  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'start_date', direction: 'desc' });

  const [titleEs, setTitleEs] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [descEs, setDescEs] = useState('');
  const [descEn, setDescEn] = useState('');
  const [questType, setQuestType] = useState<string>('trip_count');
  const [targetValue, setTargetValue] = useState('');
  const [rewardCup, setRewardCup] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const loadQuests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await questService.getAllQuests(page, PAGE_SIZE);
      setQuests(data);
    } catch (err) {
      setQuests([]);
      setError(err instanceof Error ? err.message : t('quests.load_error', { defaultValue: 'No pudimos cargar las misiones.' }));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    void loadQuests();
  }, [loadQuests]);

  const filteredQuests = useMemo(() => {
    let rows = quests;
    if (filter !== 'all') {
      rows = rows.filter((q) => questState(q) === filter);
    }
    if (!sort) return rows;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof Quest;
    return [...rows].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [quests, filter, sort]);

  const resetForm = () => {
    setTitleEs('');
    setTitleEn('');
    setDescEs('');
    setDescEn('');
    setQuestType('trip_count');
    setTargetValue('');
    setRewardCup('');
    setStartDate('');
    setEndDate('');
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
      await loadQuests();
      showToast('success', t('quests.toast_created', { defaultValue: 'Misión creada' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('quests.create_error', { defaultValue: 'No pudimos crear la misión.' }));
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (q: Quest) => {
    try {
      await questService.toggleQuest(q.id, !q.is_active);
      setQuests((prev) => prev.map((x) => (x.id === q.id ? { ...x, is_active: !q.is_active } : x)));
      showToast('success', q.is_active
        ? t('quests.toast_deactivated', { defaultValue: 'Misión desactivada' })
        : t('quests.toast_activated', { defaultValue: 'Misión activada' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('quests.toggle_error', { defaultValue: 'No pudimos cambiar el estado.' }));
    }
  };

  function formatCurrency(centavos: number): string {
    return `${(centavos / 100).toLocaleString('es-CU', { minimumFractionDigits: 2 })} CUP`;
  }

  const columns: DataColumn<Quest>[] = useMemo(
    () => [
      {
        id: 'title_es',
        header: t('quests.col_quest', { defaultValue: 'Misión' }),
        cell: (q) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink">{q.title_es}</span>
            {q.description_es && (
              <span className="truncate text-[11.5px] text-ink-muted">{q.description_es}</span>
            )}
          </span>
        ),
        primary: true,
        sortKey: 'title_es',
      },
      {
        id: 'quest_type',
        header: t('quests.col_type', { defaultValue: 'Tipo' }),
        cell: (q) => (
          <span className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
            {questTypeLabel(q.quest_type)}
          </span>
        ),
        width: '160px',
      },
      {
        id: 'state',
        header: t('quests.col_state', { defaultValue: 'Estado' }),
        cell: (q) => {
          const s = questState(q);
          return (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATE_CLASS[s]}`}>
              {stateLabel(s)}
            </span>
          );
        },
        width: '110px',
      },
      {
        id: 'target_value',
        header: t('quests.col_target', { defaultValue: 'Objetivo' }),
        cell: (q) => q.target_value,
        align: 'right',
        mono: true,
        hideBelow: 'md',
        width: '100px',
      },
      {
        id: 'reward_cup',
        header: t('quests.col_reward', { defaultValue: 'Recompensa' }),
        cell: (q) => <span className="font-medium text-ink">{formatCurrency(q.reward_cup)}</span>,
        align: 'right',
        mono: true,
        width: '150px',
        secondary: true,
      },
      {
        id: 'start_date',
        header: t('quests.col_period', { defaultValue: 'Periodo' }),
        cell: (q) => (
          <span className="text-ink-muted">
            {q.start_date} → {q.end_date}
          </span>
        ),
        mono: true,
        hideBelow: 'lg',
        width: '200px',
        sortKey: 'start_date',
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('quests.page_eyebrow', { defaultValue: 'Crecimiento · misiones' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('quests.title', { defaultValue: 'Misiones' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('quests.page_description', { defaultValue: 'Desafíos con recompensa para conductores. Ganá retención con metas claras.' })}
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90"
        >
          {showCreate ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showCreate
            ? t('quests.cancel', { defaultValue: 'Cancelar' })
            : t('quests.new_quest', { defaultValue: 'Nueva misión' })}
        </button>
      </div>

      {showCreate && (
        <div className="admin-card p-5 animate-fade-in">
          <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('quests.new_quest', { defaultValue: 'Nueva misión' })}
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('quests.form_title_es', { defaultValue: 'Título (ES)' })}
              </span>
              <input
                value={titleEs}
                onChange={(e) => setTitleEs(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('quests.form_title_en', { defaultValue: 'Title (EN)' })}
              </span>
              <input
                value={titleEn}
                onChange={(e) => setTitleEn(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('quests.form_desc_es', { defaultValue: 'Descripción (ES)' })}
              </span>
              <textarea
                value={descEs}
                onChange={(e) => setDescEs(e.target.value)}
                rows={2}
                className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('quests.form_desc_en', { defaultValue: 'Description (EN)' })}
              </span>
              <textarea
                value={descEn}
                onChange={(e) => setDescEn(e.target.value)}
                rows={2}
                className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('quests.form_type', { defaultValue: 'Tipo' })}
              </span>
              <select
                value={questType}
                onChange={(e) => setQuestType(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              >
                {QUEST_TYPES.map((qt) => (
                  <option key={qt} value={qt}>
                    {questTypeLabel(qt)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('quests.form_target', { defaultValue: 'Objetivo' })}
              </span>
              <input
                type="number"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder="20"
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('quests.form_reward', { defaultValue: 'Recompensa (centavos CUP)' })}
              </span>
              <input
                type="number"
                value={rewardCup}
                onChange={(e) => setRewardCup(e.target.value)}
                placeholder="50000"
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                  {t('quests.form_start', { defaultValue: 'Inicio' })}
                </span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                  {t('quests.form_end', { defaultValue: 'Fin' })}
                </span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
                />
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => void handleCreate()}
              disabled={creating || !titleEs || !targetValue || !rewardCup || !startDate || !endDate}
              className="rounded-full bg-primary-500 px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {creating
                ? t('quests.creating', { defaultValue: 'Creando…' })
                : t('quests.create', { defaultValue: 'Crear misión' })}
            </button>
          </div>
        </div>
      )}

      <FilterBar<Filter>
        sticky
        tabs={TABS}
        activeTab={filter}
        onTabChange={setFilter}
      />

      <DataTable<Quest>
        columns={columns}
        rows={filteredQuests}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void loadQuests()}
        empty={{
          icon: Trophy,
          title: t('quests.empty_title', { defaultValue: 'Sin misiones' }),
          body: t('quests.empty_body', { defaultValue: 'Creá la primera para motivar a los conductores con recompensas.' }),
          action: { label: t('quests.new_quest', { defaultValue: 'Nueva misión' }), onClick: () => setShowCreate(true) },
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: quests.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
        rowActions={[
          {
            label: t('quests.action_toggle', { defaultValue: 'Activar/Desactivar' }),
            onClick: (q) => void handleToggle(q),
          },
        ]}
      />
    </div>
  );
}
