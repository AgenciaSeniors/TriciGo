'use client';

import { useCallback, useEffect, useState } from 'react';
import { panelReadService, type PanelUserDetail } from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminBreadcrumb } from '@/components/ui/AdminBreadcrumb';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';
import { USER_LEVEL_LABEL, labelFor } from '@/lib/labels';
import { Field } from './Field';
import { ReviewsReadOnly } from './ReviewsReadOnly';

/** A user as marketing sees it (00663): no wallet, transfers, penalties or actions. */
export function UserDetailReadOnly({ userId }: { userId: string }) {
  const { t } = useTranslation('admin');
  // undefined while loading, null when there is no such user.
  const [data, setData] = useState<PanelUserDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(undefined);
    try {
      setData(await panelReadService.getUserDetail(userId));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // As the admin user page: the list, then the person (a generic word until they load).
  const usersCrumb = { label: t('panel_view.breadcrumb_users', { defaultValue: 'Usuarios' }), href: '/users' };
  const userWord = t('panel_view.breadcrumb_user', { defaultValue: 'Usuario' });
  const placeholderBreadcrumb = <AdminBreadcrumb items={[usersCrumb, { label: userWord }]} />;

  if (error) return <>{placeholderBreadcrumb}<AdminErrorBanner message={error} onRetry={() => void load()} /></>;
  if (data === undefined) return <>{placeholderBreadcrumb}<AdminTableSkeleton rows={5} columns={2} /></>;
  if (data === null) {
    return (
      <>
        {placeholderBreadcrumb}
        <p className="py-24 text-center text-ink-subtle">{t('users.user_not_found', { defaultValue: 'Usuario no encontrado' })}</p>
      </>
    );
  }

  const { user: u } = data;
  return (
    <div>
      <AdminBreadcrumb items={[usersCrumb, { label: u.full_name || u.email || u.phone || userWord }]} />
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
              {u.level ? labelFor(t, USER_LEVEL_LABEL, u.level) : '—'}
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
        <ReviewsReadOnly userId={u.id} />
      </div>
    </div>
  );
}
