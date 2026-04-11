'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, corporateService, paymentService, invoiceService } from '@tricigo/api';
import type { CorporateAccount, CorporateEmployeeRole, EmployeeReport } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

const ALL_SERVICE_TYPES = [
  'triciclo_basico', 'triciclo_premium', 'triciclo_cargo',
  'moto_standard', 'auto_standard', 'auto_confort', 'mensajeria',
] as const;

const SERVICE_LABELS: Record<string, string> = {
  triciclo_basico: 'Triciclo Básico',
  triciclo_premium: 'Triciclo Premium',
  triciclo_cargo: 'Triciclo Cargo',
  moto_standard: 'Moto',
  auto_standard: 'Auto',
  auto_confort: 'Confort',
  mensajeria: 'Mensajería',
};

type AccountWithMeta = CorporateAccount & {
  role: CorporateEmployeeRole | null;
};

export default function CorporatePage() {
  const router = useRouter();
  const { t } = useTranslation('web');
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Policy editor state per account
  const [editingId, setEditingId] = useState<string | null>(null);
  const [policyForm, setPolicyForm] = useState({
    monthly_budget_trc: 0,
    per_ride_cap_trc: 0,
    allowed_service_types: [] as string[],
    allowed_hours_start: '',
    allowed_hours_end: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  // Recharge state
  const [rechargeAccountId, setRechargeAccountId] = useState<string | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [recharging, setRecharging] = useState(false);
  const [corporateBalances, setCorporateBalances] = useState<Record<string, number>>({});

  // Employee reports state
  const [reportsAccountId, setReportsAccountId] = useState<string | null>(null);
  const [reportMonth, setReportMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [employeeReports, setEmployeeReports] = useState<EmployeeReport[]>([]);
  const [loadingReports, setLoadingReports] = useState(false);

  // Invoice state
  const [invoiceMonth, setInvoiceMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [generatingInvoice, setGeneratingInvoice] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  const loadAccounts = useCallback(async (uid: string) => {
    try {
      const data = await corporateService.getMyAccounts(uid);
      const withRoles = await Promise.all(
        data.map(async (acc) => {
          const role = await corporateService.getEmployeeRole(acc.id, uid);
          return { ...acc, role };
        }),
      );
      setAccounts(withRoles);
      // Load balances for admin accounts
      const balances: Record<string, number> = {};
      await Promise.all(
        withRoles.filter((a) => a.role === 'admin').map(async (acc) => {
          balances[acc.id] = await corporateService.getCorporateBalance(acc.id);
        }),
      );
      setCorporateBalances(balances);
    } catch {
      setError(t('corporate_load_error', { defaultValue: 'No se pudieron cargar las cuentas corporativas' }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!userId) return;
    loadAccounts(userId);
  }, [userId, loadAccounts]);

  const startEditing = (acc: AccountWithMeta) => {
    setEditingId(acc.id);
    setPolicyForm({
      monthly_budget_trc: acc.monthly_budget_trc,
      per_ride_cap_trc: acc.per_ride_cap_trc,
      allowed_service_types: [...acc.allowed_service_types],
      allowed_hours_start: acc.allowed_hours_start ?? '',
      allowed_hours_end: acc.allowed_hours_end ?? '',
    });
    setSaveSuccess(null);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setSaveSuccess(null);
  };

  const toggleServiceType = (svc: string) => {
    setPolicyForm((prev) => ({
      ...prev,
      allowed_service_types: prev.allowed_service_types.includes(svc)
        ? prev.allowed_service_types.filter((s) => s !== svc)
        : [...prev.allowed_service_types, svc],
    }));
  };

  const savePolicies = async (accountId: string) => {
    setSaving(true);
    setSaveSuccess(null);
    try {
      await corporateService.updateAccount(accountId, {
        monthly_budget_trc: policyForm.monthly_budget_trc,
        per_ride_cap_trc: policyForm.per_ride_cap_trc,
        allowed_service_types: policyForm.allowed_service_types,
        allowed_hours_start: policyForm.allowed_hours_start || null,
        allowed_hours_end: policyForm.allowed_hours_end || null,
      });
      // Update local state
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                monthly_budget_trc: policyForm.monthly_budget_trc,
                per_ride_cap_trc: policyForm.per_ride_cap_trc,
                allowed_service_types: policyForm.allowed_service_types,
                allowed_hours_start: policyForm.allowed_hours_start || null,
                allowed_hours_end: policyForm.allowed_hours_end || null,
              }
            : a,
        ),
      );
      setSaveSuccess(accountId);
      setEditingId(null);
    } catch {
      setError(t('corporate_save_error', { defaultValue: 'Error al guardar las políticas' }));
    } finally {
      setSaving(false);
    }
  };

  // TODO: Replace with Stripe PaymentIntent creation
  const handleRecharge = async (_accountId: string) => {
    setError(t('common:wallet.recharge_coming_soon', { defaultValue: 'Coming soon' }));
  };

  const loadReports = async (accountId: string, monthStr: string) => {
    setLoadingReports(true);
    try {
      const [y, m] = monthStr.split('-').map(Number);
      const data = await corporateService.getEmployeeReport(accountId, y, m);
      setEmployeeReports(data);
    } catch {
      setEmployeeReports([]);
    } finally {
      setLoadingReports(false);
    }
  };

  const handleDownloadInvoice = async (accountId: string) => {
    setGeneratingInvoice(true);
    try {
      const [y, m] = invoiceMonth.split('-').map(Number);
      const data = await invoiceService.generateMonthlyInvoice(accountId, y, m);

      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();

      // Header
      doc.setFontSize(18);
      doc.text('TriciGo', 14, 20);
      doc.setFontSize(10);
      doc.text('Factura Corporativa', 14, 27);

      // Company info
      doc.setFontSize(11);
      doc.text(data.account_name, 14, 40);
      if (data.tax_id) doc.text(`RUC/NIT: ${data.tax_id}`, 14, 46);
      doc.text(`Contacto: ${data.contact_phone}`, 14, data.tax_id ? 52 : 46);

      // Period
      doc.setFontSize(12);
      doc.text(`Período: ${data.period}`, 130, 40);
      doc.setFontSize(9);
      doc.text(`Generada: ${new Date(data.generated_at).toLocaleDateString('es-CU')}`, 130, 46);

      // Table header
      const startY = 62;
      doc.setFillColor(240, 240, 240);
      doc.rect(14, startY, 182, 8, 'F');
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text('Fecha', 16, startY + 5.5);
      doc.text('Empleado', 50, startY + 5.5);
      doc.text('Teléfono', 110, startY + 5.5);
      doc.text('Monto TRC', 160, startY + 5.5);

      // Table rows
      doc.setFont('helvetica', 'normal');
      let rowY = startY + 14;
      for (const item of data.items) {
        if (rowY > 270) {
          doc.addPage();
          rowY = 20;
        }
        doc.text(new Date(item.date).toLocaleDateString('es-CU', { day: '2-digit', month: 'short' }), 16, rowY);
        doc.text(item.employee_name.substring(0, 30), 50, rowY);
        doc.text(item.employee_phone, 110, rowY);
        doc.text(item.fare_trc.toFixed(2), 160, rowY);
        rowY += 7;
      }

      // Totals
      rowY += 5;
      doc.setDrawColor(200, 200, 200);
      doc.line(14, rowY, 196, rowY);
      rowY += 8;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text(`Total viajes: ${data.total_rides}`, 14, rowY);
      doc.text(`Total: ${data.total_trc.toFixed(2)} TRC`, 130, rowY);
      if (data.budget_trc > 0) {
        rowY += 7;
        doc.setFont('helvetica', 'normal');
        doc.text(`Presupuesto mensual: ${data.budget_trc.toFixed(2)} TRC`, 14, rowY);
      }

      doc.save(`factura-${data.account_name.replace(/\s/g, '_')}-${data.period.replace(/\s/g, '_')}.pdf`);
    } catch {
      setError(t('corporate_invoice_error', { defaultValue: 'Error al generar la factura' }));
    } finally {
      setGeneratingInvoice(false);
    }
  };

  const toggleReports = (accountId: string) => {
    if (reportsAccountId === accountId) {
      setReportsAccountId(null);
    } else {
      setReportsAccountId(accountId);
      loadReports(accountId, reportMonth);
    }
  };

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('loading', { defaultValue: 'Cargando...' })}</p>
      </div>
    );
  }

  if (!userId) {
    router.replace('/login');
    return null;
  }

  const statusColor = (status: string) => {
    if (status === 'approved') return { bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' };
    if (status === 'suspended') return { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' };
    return { bg: '#fffbeb', color: '#d97706', border: '#fde68a' };
  };

  const inputStyle = {
    width: '100%',
    padding: '0.6rem 0.75rem',
    border: '1px solid var(--border-light)',
    borderRadius: '0.5rem',
    fontSize: '0.9rem',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    boxSizing: 'border-box' as const,
  };

  const labelStyle = {
    display: 'block',
    fontSize: '0.8rem',
    fontWeight: 600 as const,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '0.35rem',
  };

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" aria-label={t('back_to_profile', { defaultValue: 'Volver al perfil' })} style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('corporate_title', { defaultValue: 'Cuentas corporativas' })}</h1>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.75rem', padding: '1rem', marginBottom: '1.5rem' }}>
          <p style={{ color: '#c53030', margin: 0, fontSize: '0.9rem' }}>{error}</p>
        </div>
      )}

      {loading ? (
        <WebSkeletonList count={2} />
      ) : accounts.length === 0 ? (
        <WebEmptyState
          icon="🏢"
          title={t('corporate_empty_title', { defaultValue: 'No tienes cuentas corporativas' })}
          description={t('corporate_empty_desc', { defaultValue: 'Contacta a tu empresa para vincular tu cuenta de TriciGo.' })}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {accounts.map((acc) => {
            const sc = statusColor(acc.status);
            const budgetRemaining = acc.monthly_budget_trc - acc.current_month_spent;
            const budgetPercent = acc.monthly_budget_trc > 0
              ? Math.max(0, Math.min(100, (budgetRemaining / acc.monthly_budget_trc) * 100))
              : 0;
            const isAdmin = acc.role === 'admin';
            const isEditing = editingId === acc.id;
            const justSaved = saveSuccess === acc.id;

            return (
              <div key={acc.id} style={{
                background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.5rem',
              }}>
                {/* Name & Status */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                  <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{acc.name}</h2>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {isAdmin && (
                      <span style={{
                        fontSize: '0.7rem', fontWeight: 600, padding: '0.15rem 0.5rem', borderRadius: '999px',
                        background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe',
                      }}>Admin</span>
                    )}
                    <span style={{
                      fontSize: '0.75rem', fontWeight: 600, padding: '0.2rem 0.6rem', borderRadius: '999px',
                      background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`,
                    }}>
                      {acc.status === 'approved' ? t('status_active', { defaultValue: 'Activa' }) : acc.status === 'suspended' ? t('status_suspended', { defaultValue: 'Suspendida' }) : acc.status}
                    </span>
                  </div>
                </div>

                {/* Contact */}
                <div style={{ marginBottom: '0.75rem' }}>
                  <p style={labelStyle}>{t('corporate_contact', { defaultValue: 'Contacto' })}</p>
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{acc.contact_phone}</p>
                  {acc.contact_email && (
                    <p style={{ margin: '0.15rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{acc.contact_email}</p>
                  )}
                </div>

                {/* Budget bar (read-only view) */}
                {acc.monthly_budget_trc > 0 && !isEditing && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <p style={labelStyle}>{t('corporate_budget', { defaultValue: 'Presupuesto' })}</p>
                    <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginTop: '0.4rem', background: 'var(--border-light)' }}>
                      <div style={{ width: `${budgetPercent}%`, background: budgetPercent < 20 ? '#dc2626' : 'var(--primary)', borderRadius: 3 }} />
                    </div>
                    <p style={{ margin: '0.3rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {budgetRemaining.toFixed(2)} / {acc.monthly_budget_trc.toFixed(2)} {t('corporate_remaining', { defaultValue: 'TRC restante' })}
                    </p>
                  </div>
                )}

                {/* Corporate balance & recharge (admin only) */}
                {isAdmin && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <p style={labelStyle}>{t('corporate_balance', { defaultValue: 'Balance corporativo' })}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <p style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {(corporateBalances[acc.id] ?? 0).toFixed(2)} TRC
                      </p>
                      <button
                        onClick={() => setRechargeAccountId(rechargeAccountId === acc.id ? null : acc.id)}
                        style={{
                          padding: '0.35rem 0.75rem', background: '#16a34a', color: '#fff',
                          border: 'none', borderRadius: '0.4rem', fontSize: '0.78rem',
                          fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {t('corporate_recharge_btn', { defaultValue: 'Recargar' })}
                      </button>
                    </div>
                    {rechargeAccountId === acc.id && (
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', alignItems: 'center' }}>
                        <input
                          type="number"
                          min={500}
                          placeholder="Monto CUP"
                          value={rechargeAmount}
                          onChange={(e) => setRechargeAmount(e.target.value)}
                          style={{ ...inputStyle, flex: 1 }}
                        />
                        <button
                          onClick={() => handleRecharge(acc.id)}
                          disabled={recharging || !rechargeAmount}
                          style={{
                            padding: '0.6rem 1rem', background: 'var(--primary)', color: '#fff',
                            border: 'none', borderRadius: '0.5rem', fontSize: '0.85rem',
                            fontWeight: 600, cursor: recharging ? 'not-allowed' : 'pointer',
                            opacity: recharging ? 0.7 : 1, whiteSpace: 'nowrap',
                          }}
                        >
                          {recharging
                            ? t('corporate_generating', { defaultValue: 'Generando...' })
                            : t('corporate_generate_link', { defaultValue: 'Generar link' })}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Policies read-only (when not editing) */}
                {!isEditing && (
                  <>
                    {acc.per_ride_cap_trc > 0 && (
                      <div style={{ marginBottom: '0.75rem' }}>
                        <p style={labelStyle}>{t('corporate_per_ride', { defaultValue: 'Máximo por viaje' })}</p>
                        <p style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{acc.per_ride_cap_trc.toFixed(2)} TRC</p>
                      </div>
                    )}
                    {acc.allowed_service_types.length > 0 && (
                      <div style={{ marginBottom: '0.75rem' }}>
                        <p style={labelStyle}>{t('corporate_services', { defaultValue: 'Servicios permitidos' })}</p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.25rem' }}>
                          {acc.allowed_service_types.map((svc) => (
                            <span key={svc} style={{
                              fontSize: '0.78rem', padding: '0.2rem 0.5rem', borderRadius: '0.35rem',
                              background: 'var(--border-light)', color: 'var(--text-secondary)',
                            }}>{SERVICE_LABELS[svc] || svc}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {acc.allowed_hours_start && acc.allowed_hours_end && (
                      <div style={{ marginBottom: '0.75rem' }}>
                        <p style={labelStyle}>{t('corporate_hours', { defaultValue: 'Horario permitido' })}</p>
                        <p style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{acc.allowed_hours_start} - {acc.allowed_hours_end}</p>
                      </div>
                    )}
                  </>
                )}

                {/* Success banner */}
                {justSaved && (
                  <div style={{
                    background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '0.5rem',
                    padding: '0.6rem 1rem', marginBottom: '0.75rem',
                  }}>
                    <p style={{ margin: 0, fontSize: '0.85rem', color: '#16a34a', fontWeight: 500 }}>
                      {t('corporate_saved', { defaultValue: 'Políticas guardadas correctamente' })}
                    </p>
                  </div>
                )}

                {/* ─── Policy Editor (admin only) ─── */}
                {isEditing && (
                  <div style={{
                    background: '#f8fafc', borderRadius: '0.75rem', padding: '1.25rem',
                    border: '1px solid var(--border-light)', marginBottom: '1rem',
                  }}>
                    <h3 style={{ margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {t('corporate_edit_policies', { defaultValue: 'Editar políticas' })}
                    </h3>

                    {/* Monthly budget */}
                    <div style={{ marginBottom: '1rem' }}>
                      <label style={labelStyle}>{t('corporate_monthly_budget', { defaultValue: 'Presupuesto mensual (TRC)' })}</label>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={policyForm.monthly_budget_trc}
                        onChange={(e) => setPolicyForm((p) => ({ ...p, monthly_budget_trc: parseFloat(e.target.value) || 0 }))}
                        style={inputStyle}
                      />
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {t('corporate_budget_hint', { defaultValue: '0 = sin límite de presupuesto' })}
                      </p>
                    </div>

                    {/* Per-ride cap */}
                    <div style={{ marginBottom: '1rem' }}>
                      <label style={labelStyle}>{t('corporate_ride_cap', { defaultValue: 'Tope por viaje (TRC)' })}</label>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={policyForm.per_ride_cap_trc}
                        onChange={(e) => setPolicyForm((p) => ({ ...p, per_ride_cap_trc: parseFloat(e.target.value) || 0 }))}
                        style={inputStyle}
                      />
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {t('corporate_ride_cap_hint', { defaultValue: '0 = sin tope por viaje' })}
                      </p>
                    </div>

                    {/* Allowed service types */}
                    <div style={{ marginBottom: '1rem' }}>
                      <label style={labelStyle}>{t('corporate_allowed_services', { defaultValue: 'Tipos de servicio permitidos' })}</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.25rem' }}>
                        {ALL_SERVICE_TYPES.map((svc) => {
                          const checked = policyForm.allowed_service_types.includes(svc);
                          return (
                            <button
                              key={svc}
                              type="button"
                              onClick={() => toggleServiceType(svc)}
                              style={{
                                padding: '0.35rem 0.7rem',
                                borderRadius: '0.4rem',
                                border: checked ? '1.5px solid var(--primary)' : '1px solid var(--border-light)',
                                background: checked ? 'var(--primary)' : 'var(--bg-card)',
                                color: checked ? '#fff' : 'var(--text-secondary)',
                                fontSize: '0.8rem',
                                fontWeight: 500,
                                cursor: 'pointer',
                              }}
                            >
                              {SERVICE_LABELS[svc] || svc}
                            </button>
                          );
                        })}
                      </div>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {t('corporate_services_hint', { defaultValue: 'Ninguno seleccionado = todos permitidos' })}
                      </p>
                    </div>

                    {/* Allowed hours */}
                    <div style={{ marginBottom: '1.25rem' }}>
                      <label style={labelStyle}>{t('corporate_allowed_hours', { defaultValue: 'Horario permitido' })}</label>
                      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                        <input
                          type="time"
                          value={policyForm.allowed_hours_start}
                          onChange={(e) => setPolicyForm((p) => ({ ...p, allowed_hours_start: e.target.value }))}
                          style={{ ...inputStyle, width: 'auto', flex: 1 }}
                        />
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>—</span>
                        <input
                          type="time"
                          value={policyForm.allowed_hours_end}
                          onChange={(e) => setPolicyForm((p) => ({ ...p, allowed_hours_end: e.target.value }))}
                          style={{ ...inputStyle, width: 'auto', flex: 1 }}
                        />
                      </div>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {t('corporate_hours_hint', { defaultValue: 'Vacío = sin restricción horaria' })}
                      </p>
                    </div>

                    {/* Save / Cancel */}
                    <div style={{ display: 'flex', gap: '0.75rem' }}>
                      <button
                        onClick={() => savePolicies(acc.id)}
                        disabled={saving}
                        style={{
                          flex: 1, padding: '0.65rem', background: 'var(--primary)', color: '#fff',
                          border: 'none', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600,
                          cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
                        }}
                      >
                        {saving ? t('corporate_saving', { defaultValue: 'Guardando...' }) : t('corporate_save', { defaultValue: 'Guardar cambios' })}
                      </button>
                      <button
                        onClick={cancelEditing}
                        disabled={saving}
                        style={{
                          padding: '0.65rem 1.25rem', background: 'transparent', color: 'var(--text-secondary)',
                          border: '1px solid var(--border-light)', borderRadius: '0.5rem', fontSize: '0.9rem',
                          fontWeight: 500, cursor: 'pointer',
                        }}
                      >
                        {t('corporate_cancel', { defaultValue: 'Cancelar' })}
                      </button>
                    </div>
                  </div>
                )}

                {/* Edit policies button (admin only, when not editing) */}
                {isAdmin && !isEditing && (
                  <button
                    onClick={() => startEditing(acc)}
                    style={{
                      width: '100%', padding: '0.65rem', marginTop: '0.5rem',
                      background: 'transparent', color: 'var(--primary)',
                      border: '1px solid var(--primary)', borderRadius: '0.5rem',
                      fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    {t('corporate_edit_policies_btn', { defaultValue: 'Editar políticas' })}
                  </button>
                )}

                {/* Employee Reports (admin only) */}
                {isAdmin && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <button
                      onClick={() => toggleReports(acc.id)}
                      style={{
                        width: '100%', padding: '0.65rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        background: 'transparent', border: 'none', borderTop: '1px solid var(--border-light)',
                        cursor: 'pointer', color: 'var(--text-primary)',
                      }}
                    >
                      <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                        {t('corporate_employee_reports', { defaultValue: 'Reportes por empleado' })}
                      </span>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        style={{ transform: reportsAccountId === acc.id ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    {reportsAccountId === acc.id && (
                      <div style={{ padding: '0.75rem 0' }}>
                        {/* Month selector */}
                        <div style={{ marginBottom: '0.75rem' }}>
                          <input
                            type="month"
                            value={reportMonth}
                            onChange={(e) => {
                              setReportMonth(e.target.value);
                              loadReports(acc.id, e.target.value);
                            }}
                            style={{ ...inputStyle, width: 'auto' }}
                          />
                        </div>

                        {loadingReports ? (
                          <p style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
                            {t('loading', { defaultValue: 'Cargando...' })}
                          </p>
                        ) : employeeReports.length === 0 ? (
                          <p style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.85rem', padding: '1rem 0' }}>
                            {t('corporate_no_reports', { defaultValue: 'Sin viajes en este período' })}
                          </p>
                        ) : (
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-light)' }}>
                                  <th style={{ textAlign: 'left', padding: '0.5rem 0.4rem', color: 'var(--text-tertiary)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>
                                    {t('corporate_report_employee', { defaultValue: 'Empleado' })}
                                  </th>
                                  <th style={{ textAlign: 'right', padding: '0.5rem 0.4rem', color: 'var(--text-tertiary)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>
                                    {t('corporate_report_rides', { defaultValue: 'Viajes' })}
                                  </th>
                                  <th style={{ textAlign: 'right', padding: '0.5rem 0.4rem', color: 'var(--text-tertiary)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>
                                    {t('corporate_report_total', { defaultValue: 'Total' })}
                                  </th>
                                  <th style={{ textAlign: 'right', padding: '0.5rem 0.4rem', color: 'var(--text-tertiary)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>
                                    {t('corporate_report_avg', { defaultValue: 'Promedio' })}
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {employeeReports.map((r) => (
                                  <tr key={r.user_id} style={{ borderBottom: '1px solid var(--border-light)' }}>
                                    <td style={{ padding: '0.5rem 0.4rem' }}>
                                      <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{r.name}</span>
                                      <br />
                                      <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{r.phone}</span>
                                    </td>
                                    <td style={{ textAlign: 'right', padding: '0.5rem 0.4rem', color: 'var(--text-primary)' }}>{r.total_rides}</td>
                                    <td style={{ textAlign: 'right', padding: '0.5rem 0.4rem', color: 'var(--text-primary)', fontWeight: 500 }}>{r.total_spent_trc.toFixed(2)}</td>
                                    <td style={{ textAlign: 'right', padding: '0.5rem 0.4rem', color: 'var(--text-secondary)' }}>{r.avg_fare_trc.toFixed(2)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Invoice Download (admin only) */}
                {isAdmin && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{
                      borderTop: '1px solid var(--border-light)', paddingTop: '0.75rem',
                      display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                    }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {t('corporate_invoice', { defaultValue: 'Descargar factura' })}
                      </span>
                      <input
                        type="month"
                        value={invoiceMonth}
                        onChange={(e) => setInvoiceMonth(e.target.value)}
                        style={{ ...inputStyle, width: 'auto', flex: 'none' }}
                      />
                      <button
                        onClick={() => handleDownloadInvoice(acc.id)}
                        disabled={generatingInvoice}
                        style={{
                          padding: '0.5rem 1rem', background: 'var(--primary)', color: '#fff',
                          border: 'none', borderRadius: '0.5rem', fontSize: '0.82rem',
                          fontWeight: 600, cursor: generatingInvoice ? 'not-allowed' : 'pointer',
                          opacity: generatingInvoice ? 0.7 : 1,
                        }}
                      >
                        {generatingInvoice
                          ? t('corporate_generating_invoice', { defaultValue: 'Generando...' })
                          : 'PDF'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
