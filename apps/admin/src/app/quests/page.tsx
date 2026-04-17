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

const QUEST_TYPE_LABEL: Record<string, string> = {
  trip_count: 'Número de viajes',
  earnings: 'Ganancias',
  rating: 'Calificación',
  hours_online: 'Horas en línea',
  peak_hours: 'Horas pico',
};

const PAGE_SIZE = 20;

type Filter = 'all' | 'active' | 'expired' | 'inactive';

const TABS: StatusTab<Filter>[] = [
  { id: 'all', label: 'Todas' },
  { id: 'active', label: 'Activas', tone: 'success' },
  { id: 'inactive', label: 'Inactivas', tone: 'warning' },
  { id: 'expired', label: 'Expiradas' },
];

type QuestState = 'active' | 'expired' | 'inactive';

function questState(q: Quest): QuestState {
  const expired = new Date(q.end_date) < new Date();
  if (expired) return 'expired';
  return q.is_active ? 'active' : 'inactive';
}

const STATE_META: Record<QuestState, { label: string; className: string }> = {
  active: { label: 'Activa', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  expired: { label: 'Expirada', className: 'bg-surface-sunken text-ink-muted' },
  inactive: { label: 'Inactiva', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
};

export default function QuestsPage() {
  const { t: _t } = useTranslation('admin');
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
      setError(err instanceof Error ? err.message : 'No pudimos cargar las misiones.');
    } finally {
      setLoading(false);
    }
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
      showToast('success', 'Misión creada');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos crear la misión.');
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (q: Quest) => {
    try {
      await questService.toggleQuest(q.id, !q.is_active);
      setQuests((prev) => prev.map((x) => (x.id === q.id ? { ...x, is_active: !q.is_active } : x)));
      showToast('success', q.is_active ? 'Misión desactivada' : 'Misión activada');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos cambiar el estado.');
    }
  };

  function formatCurrency(centavos: number): string {
    return `${(centavos / 100).toLocaleString('es-CU', { minimumFractionDigits: 2 })} CUP`;
  }

  const columns: DataColumn<Quest>[] = useMemo(
    () => [
      {
        id: 'title_es',
        header: 'Misión',
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
        header: 'Tipo',
        cell: (q) => (
          <span className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
            {QUEST_TYPE_LABEL[q.quest_type] ?? q.quest_type}
          </span>
        ),
        width: '160px',
      },
      {
        id: 'state',
        header: 'Estado',
        cell: (q) => {
          const s = questState(q);
          const meta = STATE_META[s];
          return (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.className}`}>
              {meta.label}
            </span>
          );
        },
        width: '110px',
      },
      {
        id: 'target_value',
        header: 'Objetivo',
        cell: (q) => q.target_value,
        align: 'right',
        mono: true,
        hideBelow: 'md',
        width: '100px',
      },
      {
        id: 'reward_cup',
        header: 'Recompensa',
        cell: (q) => <span className="font-medium text-ink">{formatCurrency(q.reward_cup)}</span>,
        align: 'right',
        mono: true,
        width: '150px',
        secondary: true,
      },
      {
        id: 'start_date',
        header: 'Periodo',
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
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            Crecimiento · misiones
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            Misiones
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            Desafíos con recompensa para conductores. Ganá retención con metas claras.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90"
        >
          {showCreate ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showCreate ? 'Cancelar' : 'Nueva misión'}
        </button>
      </div>

      {showCreate && (
        <div className="admin-card p-5 animate-fade-in">
          <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            Nueva misión
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Título (ES)</span>
              <input
                value={titleEs}
                onChange={(e) => setTitleEs(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Title (EN)</span>
              <input
                value={titleEn}
                onChange={(e) => setTitleEn(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Descripción (ES)</span>
              <textarea
                value={descEs}
                onChange={(e) => setDescEs(e.target.value)}
                rows={2}
                className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Description (EN)</span>
              <textarea
                value={descEn}
                onChange={(e) => setDescEn(e.target.value)}
                rows={2}
                className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Tipo</span>
              <select
                value={questType}
                onChange={(e) => setQuestType(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              >
                {QUEST_TYPES.map((qt) => (
                  <option key={qt} value={qt}>
                    {QUEST_TYPE_LABEL[qt] ?? qt}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Objetivo</span>
              <input
                type="number"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder="20"
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Recompensa (centavos CUP)</span>
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
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Inicio</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Fin</span>
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
              {creating ? 'Creando…' : 'Crear misión'}
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
          title: 'Sin misiones',
          body: 'Creá la primera para motivar a los conductores con recompensas.',
          action: { label: 'Nueva misión', onClick: () => setShowCreate(true) },
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: quests.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
        rowActions={[
          {
            label: 'Activar/Desactivar',
            onClick: (q) => void handleToggle(q),
          },
        ]}
      />
    </div>
  );
}
