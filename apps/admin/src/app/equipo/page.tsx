'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, RefreshCw, UserPlus, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  teamService,
  type InvitationSent,
  type TeamInvitation,
  type TeamListing,
  type TeamMember,
  type TeamRole,
} from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';

const ROLES: TeamRole[] = ['super_admin', 'admin', 'marketing'];

/**
 * Equipo (00660): who has access to the panel, the invitations on their way, and
 * the form to invite someone. Super admins only (middleware and every function).
 */
export default function TeamPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [listing, setListing] = useState<TeamListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<TeamRole>('admin');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<(InvitationSent & { email: string }) | null>(null);
  const [roleChange, setRoleChange] = useState<{ member: TeamMember; role: TeamRole; reason: string } | null>(null);
  const [removal, setRemoval] = useState<{ member: TeamMember; reason: string } | null>(null);

  const roleLabel = useCallback((r: string) => t(`team.role_${r}`, { defaultValue: r }), [t]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setListing(await teamService.list());
    } catch (err) {
      setLoadError(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      showToast('success', t('team.link_copied', { defaultValue: 'Enlace copiado.' }));
    } catch {
      showToast('warning', link);
    }
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      const result = await teamService.invite(email, role, name);
      setSent({ ...result, email: email.trim().toLowerCase() });
      showToast(
        result.email_queued ? 'success' : 'warning',
        result.email_queued
          ? t('team.invite_sent', { defaultValue: 'Invitación enviada.' })
          : t('team.invite_no_email', { defaultValue: 'La invitación quedó creada, pero el correo no salió. Copia el enlace y mándalo por WhatsApp.' }),
      );
      setEmail('');
      setName('');
      await load();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const resend = async (inv: TeamInvitation) => {
    try {
      const result = await teamService.resend(inv.id);
      showToast(
        result.email_queued ? 'success' : 'warning',
        result.email_queued
          ? t('team.invite_resent', { defaultValue: 'Invitación reenviada. Vence en 7 días.' })
          : t('team.invite_no_email', { defaultValue: 'La invitación quedó creada, pero el correo no salió. Copia el enlace y mándalo por WhatsApp.' }),
      );
      await load();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };

  const cancel = async (inv: TeamInvitation) => {
    try {
      await teamService.cancel(inv.id);
      showToast('success', t('team.invite_canceled', { defaultValue: 'Invitación cancelada.' }));
      await load();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };

  const confirmRoleChange = async () => {
    if (!roleChange) return;
    try {
      await teamService.setRole(roleChange.member.user_id, roleChange.role, roleChange.reason);
      showToast('success', t('team.role_changed', { defaultValue: 'Rol actualizado.' }));
      setRoleChange(null);
      await load();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };

  const confirmRemoval = async () => {
    if (!removal) return;
    try {
      await teamService.remove(removal.member.user_id, removal.reason);
      showToast('success', t('team.member_removed', { defaultValue: 'Acceso quitado.' }));
      setRemoval(null);
      await load();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };

  const memberColumns: DataColumn<TeamMember>[] = [
    {
      id: 'name',
      header: t('team.col_name', { defaultValue: 'Nombre' }),
      primary: true,
      cell: (m) => (
        <span className="font-medium text-ink">
          {m.full_name || '—'}
          {m.is_me && <span className="ml-2 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted">{t('team.you', { defaultValue: 'Tú' })}</span>}
        </span>
      ),
    },
    { id: 'email', header: t('team.col_email', { defaultValue: 'Correo' }), secondary: true, cell: (m) => m.email ?? '—' },
    { id: 'role', header: t('team.col_role', { defaultValue: 'Rol' }), cell: (m) => roleLabel(m.role) },
    {
      id: 'last',
      header: t('team.col_last_sign_in', { defaultValue: 'Último ingreso' }),
      hideBelow: 'md',
      cell: (m) => (m.last_sign_in_at ? formatAdminDate(m.last_sign_in_at) : '—'),
    },
    {
      id: 'digest',
      header: t('team.col_digest', { defaultValue: 'Resumen diario' }),
      hideBelow: 'lg',
      cell: (m) => (m.gets_digest ? t('team.yes', { defaultValue: 'Sí' }) : t('team.no', { defaultValue: 'No' })),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (m) =>
        m.is_me ? null : (
          <span className="inline-flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setRoleChange({ member: m, role: m.role, reason: '' })}
              className="whitespace-nowrap rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:bg-surface-sunken"
            >
              {t('team.change_role', { defaultValue: 'Cambiar rol' })}
            </button>
            <button
              type="button"
              onClick={() => setRemoval({ member: m, reason: '' })}
              className="whitespace-nowrap rounded-full border border-red-500/40 px-3 py-1 text-[12px] text-red-700 hover:bg-red-500/10 dark:text-red-400"
            >
              {t('team.remove', { defaultValue: 'Quitar acceso' })}
            </button>
          </span>
        ),
    },
  ];

  const invitationColumns: DataColumn<TeamInvitation>[] = [
    { id: 'email', header: t('team.col_email', { defaultValue: 'Correo' }), primary: true, cell: (i) => i.email },
    { id: 'role', header: t('team.col_role', { defaultValue: 'Rol' }), cell: (i) => roleLabel(i.role) },
    { id: 'by', header: t('team.col_invited_by', { defaultValue: 'Invitó' }), hideBelow: 'md', cell: (i) => i.invited_by_name || '—' },
    {
      id: 'expires',
      header: t('team.col_expires', { defaultValue: 'Vence' }),
      cell: (i) =>
        i.expired ? (
          <span className="text-amber-800 dark:text-amber-400">{t('team.expired', { defaultValue: 'Vencida' })}</span>
        ) : (
          formatAdminDate(i.expires_at)
        ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (i) => (
        <span className="inline-flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => copy(i.link)} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:bg-surface-sunken">
            <Copy className="h-3 w-3" /> {t('team.copy_link', { defaultValue: 'Copiar enlace' })}
          </button>
          <button type="button" onClick={() => resend(i)} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:bg-surface-sunken">
            <RefreshCw className="h-3 w-3" /> {t('team.resend', { defaultValue: 'Reenviar' })}
          </button>
          <button type="button" onClick={() => cancel(i)} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-red-500/40 px-3 py-1 text-[12px] text-red-700 hover:bg-red-500/10 dark:text-red-400">
            <X className="h-3 w-3" /> {t('team.cancel', { defaultValue: 'Cancelar' })}
          </button>
        </span>
      ),
    },
  ];

  const inputCls = 'h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none';

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('team.eyebrow', { defaultValue: 'Sistema · equipo' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('team.title', { defaultValue: 'Equipo' })}
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          {t('team.description', { defaultValue: 'Quién entra al panel y con qué rol. La invitación llega por correo y la persona entra con la cuenta de Google de esa dirección.' })}
        </p>
      </div>

      <form onSubmit={invite} className="admin-card flex flex-col gap-3 p-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('team.invite_title', { defaultValue: 'Invitar a alguien' })}
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('team.email_placeholder', { defaultValue: 'correo@gmail.com' })} aria-label={t('team.col_email', { defaultValue: 'Correo' })} className={`${inputCls} md:col-span-2`} />
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t('team.name_placeholder', { defaultValue: 'Nombre (opcional)' })} aria-label={t('team.col_name', { defaultValue: 'Nombre' })} className={inputCls} />
          <select value={role} onChange={(e) => setRole(e.target.value as TeamRole)} aria-label={t('team.col_role', { defaultValue: 'Rol' })} className={inputCls}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{roleLabel(r)}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={sending} className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50">
            <UserPlus className="h-3.5 w-3.5" /> {t('team.invite', { defaultValue: 'Invitar' })}
          </button>
          {sent && (
            <button type="button" onClick={() => copy(sent.link)} className="inline-flex items-center gap-1 text-[12.5px] text-ink-muted underline">
              <Copy className="h-3 w-3" /> {t('team.copy_link_for', { defaultValue: 'Copiar el enlace de {{email}}', email: sent.email })}
            </button>
          )}
        </div>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="font-display text-[18px] font-semibold text-ink">{t('team.members', { defaultValue: 'Miembros' })}</h2>
        <DataTable
          columns={memberColumns}
          rows={listing?.members ?? []}
          keyField="user_id"
          loading={!listing && !loadError}
          error={loadError}
          onRetry={load}
          empty={{ icon: UserPlus, title: t('team.no_members', { defaultValue: 'Nadie todavía.' }) }}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-display text-[18px] font-semibold text-ink">{t('team.invitations', { defaultValue: 'Invitaciones pendientes' })}</h2>
        <DataTable
          columns={invitationColumns}
          rows={listing?.invitations ?? []}
          keyField="id"
          loading={!listing && !loadError}
          error={loadError}
          onRetry={load}
          empty={{ icon: UserPlus, title: t('team.no_invitations', { defaultValue: 'No hay invitaciones pendientes.' }) }}
        />
      </section>

      {roleChange && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setRoleChange(null)}>
          <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-neutral-800" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-lg font-semibold text-ink">
              {t('team.change_role_title', { defaultValue: 'Cambiar el rol de {{name}}', name: roleChange.member.full_name || roleChange.member.email || '' })}
            </h3>
            <select value={roleChange.role} onChange={(e) => setRoleChange({ ...roleChange, role: e.target.value as TeamRole })} aria-label={t('team.col_role', { defaultValue: 'Rol' })} className={`${inputCls} mb-3 w-full`}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
            <input value={roleChange.reason} onChange={(e) => setRoleChange({ ...roleChange, reason: e.target.value })} placeholder={t('team.reason_placeholder', { defaultValue: 'Motivo' })} aria-label={t('team.reason_placeholder', { defaultValue: 'Motivo' })} className={`${inputCls} mb-4 w-full`} />
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setRoleChange(null)} className="rounded-lg border border-line px-4 py-2 text-sm text-ink">
                {t('team.cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button
                type="button"
                onClick={confirmRoleChange}
                disabled={roleChange.reason.trim().length < 5 || roleChange.role === roleChange.member.role}
                className="rounded-lg bg-primary-500 px-4 py-2 text-sm text-white hover:bg-primary-600 disabled:opacity-50"
              >
                {t('team.save', { defaultValue: 'Guardar' })}
              </button>
            </div>
          </div>
        </div>
      )}

      <AdminConfirmModal
        open={!!removal}
        title={t('team.remove_title', { defaultValue: 'Quitar acceso al panel' })}
        message={t('team.remove_message', {
          defaultValue: '{{name}} deja de entrar al panel. Su cuenta sigue funcionando como pasajero o conductor.',
          name: removal?.member.full_name || removal?.member.email || '',
        })}
        confirmLabel={t('team.remove', { defaultValue: 'Quitar acceso' })}
        cancelLabel={t('team.cancel', { defaultValue: 'Cancelar' })}
        variant="danger"
        inputValue={removal?.reason ?? ''}
        onInputChange={(reason) => removal && setRemoval({ ...removal, reason })}
        inputPlaceholder={t('team.reason_placeholder', { defaultValue: 'Motivo' })}
        onConfirm={confirmRemoval}
        onCancel={() => setRemoval(null)}
      />
    </div>
  );
}
