'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { corporateService, walletService } from '@tricigo/api';
import { formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import { AdminBreadcrumb } from '@/components/ui/AdminBreadcrumb';
import { formatAdminDate } from '@/lib/formatDate';
import type {
  CorporateAccount,
  CorporateAccountStatus,
  CorporateEmployeeWithUser,
  CorporateRide,
} from '@tricigo/types';

const statusClasses: Record<CorporateAccountStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  suspended: 'bg-red-100 text-red-800',
  rejected: 'bg-neutral-200 text-neutral-600',
};

export default function BusinessDetailPage() {
  const { t } = useTranslation('admin');
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { userId: adminUserId } = useAdminUser();

  const [account, setAccount] = useState<CorporateAccount | null>(null);
  const [employees, setEmployees] = useState<CorporateEmployeeWithUser[]>([]);
  const [rides, setRides] = useState<CorporateRide[]>([]);
  const [balance, setBalance] = useState<{ available: number; held: number }>({ available: 0, held: 0 });
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [suspendReason, setSuspendReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showSuspendModal, setShowSuspendModal] = useState(false);

  async function fetchData() {
    if (!id) return;
    setLoading(true);
    try {
      const [acc, emps, rds, bal] = await Promise.all([
        corporateService.getAccount(id),
        corporateService.getEmployees(id, 0, 50),
        corporateService.getCorporateRides(id, 0, 20),
        walletService.getCorporateBalance(id),
      ]);
      setAccount(acc);
      setEmployees(emps);
      setRides(rds);
      setBalance(bal);
    } catch (err) {
      console.error('Error loading business detail:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, [id]);

  async function handleApprove() {
    if (!id || !adminUserId) return;
    setActionLoading(true);
    try {
      await corporateService.approveAccount(id, adminUserId);
      await fetchData();
    } finally { setActionLoading(false); }
  }

  async function handleReject() {
    if (!id || !adminUserId) return;
    setActionLoading(true);
    try {
      await corporateService.rejectAccount(id, adminUserId, rejectReason);
      setShowRejectModal(false);
      await fetchData();
    } finally { setActionLoading(false); }
  }

  async function handleSuspend() {
    if (!id || !adminUserId) return;
    setActionLoading(true);
    try {
      await corporateService.suspendAccount(id, adminUserId, suspendReason);
      setShowSuspendModal(false);
      await fetchData();
    } finally { setActionLoading(false); }
  }

  async function handleReactivate() {
    if (!id || !adminUserId) return;
    setActionLoading(true);
    try {
      await corporateService.approveAccount(id, adminUserId);
      await fetchData();
    } finally { setActionLoading(false); }
  }

  if (loading) {
    return <div className="text-center py-12 text-neutral-500">{t('common.loading', { defaultValue: 'Cargando...' })}</div>;
  }

  if (!account) {
    return <div className="text-center py-12 text-neutral-500">{t('businesses.not_found', { defaultValue: 'Empresa no encontrada' })}</div>;
  }

  const budgetPct = account.monthly_budget_trc > 0
    ? Math.round((account.current_month_spent / account.monthly_budget_trc) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <AdminBreadcrumb items={[{ label: 'Empresas', href: '/businesses' }, { label: account.name }]} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            {account.name}
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusClasses[account.status]}`}>
              {t(`businesses.filter_${account.status}`)}
            </span>
          </h1>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          {account.status === 'pending' && (
            <>
              <button
                className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                onClick={handleApprove}
                disabled={actionLoading}
              >
                {t('businesses.approve')}
              </button>
              <button
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                onClick={() => setShowRejectModal(true)}
                disabled={actionLoading}
              >
                {t('businesses.reject')}
              </button>
            </>
          )}
          {account.status === 'approved' && (
            <button
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              onClick={() => setShowSuspendModal(true)}
              disabled={actionLoading}
            >
              {t('businesses.suspend')}
            </button>
          )}
          {account.status === 'suspended' && (
            <button
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              onClick={handleReactivate}
              disabled={actionLoading}
            >
              {t('businesses.reactivate')}
            </button>
          )}
        </div>
      </div>

      {/* Info cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Contact */}
        <div className="bg-white border rounded-xl p-5">
          <h3 className="text-sm font-medium text-neutral-500 mb-3">{t('businesses.contact', { defaultValue: 'Contacto' })}</h3>
          <p className="font-medium">{account.contact_phone}</p>
          {account.contact_email && <p className="text-sm text-neutral-600">{account.contact_email}</p>}
          {account.tax_id && <p className="text-sm text-neutral-500 mt-1">RIF: {account.tax_id}</p>}
          <p className="text-xs text-neutral-400 mt-2">{t('common.created_at', { defaultValue: 'Creado' })}: {formatAdminDate(account.created_at)}</p>
        </div>

        {/* Wallet */}
        <div className="bg-white border rounded-xl p-5">
          <h3 className="text-sm font-medium text-neutral-500 mb-3">{t('businesses.wallet_title')}</h3>
          <p className="text-2xl font-bold">{formatTriciCoin(balance.available)}</p>
          <p className="text-xs text-neutral-500">{t('businesses.held', { defaultValue: 'Retenido' })}: {formatTriciCoin(balance.held)}</p>
          {account.monthly_budget_trc > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-neutral-500 mb-1">
                <span>{t('businesses.budget_usage')}</span>
                <span>{budgetPct}%</span>
              </div>
              <div className="h-2 bg-neutral-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${budgetPct > 90 ? 'bg-red-500' : 'bg-primary-500'}`}
                  style={{ width: `${Math.min(100, budgetPct)}%` }}
                />
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                {formatTriciCoin(account.current_month_spent)} / {formatTriciCoin(account.monthly_budget_trc)}
              </p>
            </div>
          )}
        </div>

        {/* Policies */}
        <div className="bg-white border rounded-xl p-5">
          <h3 className="text-sm font-medium text-neutral-500 mb-3">{t('businesses.policy_title')}</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-neutral-500">{t('businesses.per_ride_cap', { defaultValue: 'Máximo/viaje' })}</span>
              <span className="font-medium">
                {account.per_ride_cap_trc > 0 ? formatTriciCoin(account.per_ride_cap_trc) : t('businesses.unlimited', { defaultValue: 'Ilimitado' })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">{t('businesses.services', { defaultValue: 'Servicios' })}</span>
              <span className="font-medium">
                {account.allowed_service_types.length > 0 ? account.allowed_service_types.join(', ') : t('businesses.all', { defaultValue: 'Todos' })}
              </span>
            </div>
            {account.allowed_hours_start && account.allowed_hours_end && (
              <div className="flex justify-between">
                <span className="text-neutral-500">{t('businesses.hours', { defaultValue: 'Horario' })}</span>
                <span className="font-medium">{account.allowed_hours_start} - {account.allowed_hours_end}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Employees */}
      <div className="bg-white border rounded-xl p-5">
        <h3 className="text-sm font-medium text-neutral-500 mb-3">
          {t('businesses.employees_title')} ({employees.length})
        </h3>
        {employees.length === 0 ? (
          <p className="text-sm text-neutral-400">{t('businesses.no_employees', { defaultValue: 'Sin empleados' })}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <th className="pb-2">{t('common.name', { defaultValue: 'Nombre' })}</th>
                <th className="pb-2">{t('common.phone', { defaultValue: 'Teléfono' })}</th>
                <th className="pb-2">{t('common.role', { defaultValue: 'Rol' })}</th>
                <th className="pb-2">{t('common.status', { defaultValue: 'Estado' })}</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <tr key={emp.id} className="border-b last:border-0">
                  <td className="py-2">{emp.users?.full_name ?? '-'}</td>
                  <td className="py-2 text-neutral-600">{emp.users?.phone ?? '-'}</td>
                  <td className="py-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${emp.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-blue-50 text-blue-700'}`}>
                      {emp.role}
                    </span>
                  </td>
                  <td className="py-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${emp.is_active ? 'bg-green-100 text-green-700' : 'bg-neutral-200 text-neutral-500'}`}>
                      {emp.is_active ? t('common.active', { defaultValue: 'Activo' }) : t('common.inactive', { defaultValue: 'Inactivo' })}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent corporate rides */}
      <div className="bg-white border rounded-xl p-5">
        <h3 className="text-sm font-medium text-neutral-500 mb-3">{t('businesses.rides_title')}</h3>
        {rides.length === 0 ? (
          <p className="text-sm text-neutral-400">{t('businesses.no_rides', { defaultValue: 'Sin viajes corporativos' })}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <th className="pb-2">{t('common.date', { defaultValue: 'Fecha' })}</th>
                <th className="pb-2">{t('businesses.fare', { defaultValue: 'Tarifa' })}</th>
              </tr>
            </thead>
            <tbody>
              {rides.map((ride) => (
                <tr key={ride.id} className="border-b last:border-0">
                  <td className="py-2 text-neutral-600">{formatAdminDate(ride.created_at)}</td>
                  <td className="py-2 font-mono">{formatTriciCoin(ride.fare_trc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reject modal */}
      {showRejectModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-bold mb-4">{t('businesses.reject')}</h3>
            <textarea
              className="w-full border rounded-lg p-3 text-sm mb-4"
              rows={3}
              placeholder={t('businesses.reject_reason', { defaultValue: 'Motivo del rechazo' })}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 text-sm bg-neutral-100 rounded-lg"
                onClick={() => setShowRejectModal(false)}
              >
                {t('common.cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg disabled:opacity-50"
                onClick={handleReject}
                disabled={actionLoading}
              >
                {t('businesses.reject')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Suspend modal */}
      {showSuspendModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-bold mb-4">{t('businesses.suspend')}</h3>
            <textarea
              className="w-full border rounded-lg p-3 text-sm mb-4"
              rows={3}
              placeholder={t('businesses.suspend_reason', { defaultValue: 'Motivo de la suspensión' })}
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
            />
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 text-sm bg-neutral-100 rounded-lg"
                onClick={() => setShowSuspendModal(false)}
              >
                {t('common.cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg disabled:opacity-50"
                onClick={handleSuspend}
                disabled={actionLoading}
              >
                {t('businesses.suspend')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
