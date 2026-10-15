'use client';

import { useCallback, useEffect, useState } from 'react';
import { panelReadService, type PanelUserDetail } from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';
import { Field } from './RideDetailReadOnly';

const LEVEL_LABEL_KEY: Record<string, { key: string; fallback: string }> = {
  bronce: { key: 'users.level_bronze', fallback: 'Bronce' },
  plata: { key: 'users.level_silver', fallback: 'Plata' },
  oro: { key: 'users.level_gold', fallback: 'Oro' },
  platino: { key: 'users.level_platinum', fallback: 'Platino' },
  diamante: { key: 'users.level_diamond', fallback: 'Diamante' },
};

/** A user as marketing sees it (00663): no wallet, transfers, penalties or actions. */
export function UserDetailReadOnly({ userId }: { userId: string }) {
  const { t } = useTranslation('admin');
  const [data, setData] = useState<PanelUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await panelReadService.getUserDetail(userId));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <AdminErrorBanner message={error} onRetry={() => void load()} />;
  if (!data) return <AdminTableSkeleton rows={5} columns={2} />;

  const { user: u } = data;
  const level = u.level ? LEVEL_LABEL_KEY[u.level] : undefined;
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-ink">{u.full_name || '—'}</h1>
        <span className="text-[12.5px] text-ink-muted">{t(`users.role_${u.role}`, { defaultValue: u.role })}</span>
      </header>
      <SectionCard title={t('panel_view.user_profile', { defaultValue: 'Datos' })}>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('panel_view.user_phone', { defaultValue: 'Teléfono' })}>{u.phone ?? '—'}</Field>
          <Field label={t('panel_view.user_email', { defaultValue: 'Correo' })}>{u.email ?? '—'}</Field>
          <Field label={t('panel_view.user_signed_up', { defaultValue: 'Alta' })}>{formatAdminDate(u.created_at)}</Field>
          <Field label={t('panel_view.user_level', { defaultValue: 'Nivel' })}>
            {level ? t(level.key, { defaultValue: level.fallback }) : (u.level ?? '—')}
          </Field>
          <Field label={t('panel_view.user_active', { defaultValue: 'Cuenta activa' })}>
            {u.is_active ? t('panel_view.yes', { defaultValue: 'Sí' }) : t('panel_view.no', { defaultValue: 'No' })}
          </Field>
        </dl>
      </SectionCard>
      <SectionCard title={t('panel_view.user_rides', { defaultValue: 'Viajes como pasajero' })}>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label={t('panel_view.user_rides_total', { defaultValue: 'Pedidos' })}>{data.ridesAsCustomer}</Field>
          <Field label={t('panel_view.user_rides_completed', { defaultValue: 'Completados' })}>{data.completedAsCustomer}</Field>
          <Field label={t('panel_view.user_rides_canceled', { defaultValue: 'Cancelados' })}>{data.canceledAsCustomer}</Field>
          <Field label={t('panel_view.user_spent', { defaultValue: 'Gastado en viajes' })}>{formatCUP(data.totalSpentCup)}</Field>
        </dl>
      </SectionCard>
    </div>
  );
}
