import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Ban,
  CheckCircle2,
  Clock,
  HelpCircle,
  Radio,
  Scale,
  ShieldCheck,
  ShieldX,
  XCircle,
} from 'lucide-react';

export type StatusTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export type StatusMeta = {
  /**
   * Neutral Cuban Spanish label. Used as the default when no `t` function
   * is provided. Components that render StatusBadge should prefer
   * `getStatusLabel(domain, status, t)` so users see translated copy.
   */
  label: string;
  /**
   * i18n key under `admin.status_registry.<domain>.<status>`. Resolved
   * against the 'admin' namespace. The `label` above is kept as fallback
   * when the key is missing (e.g. when a t() function isn't wired in).
   */
  i18nKey: string;
  tone: StatusTone;
  icon?: LucideIcon;
};

type Domain =
  | 'ride'
  | 'driver'
  | 'incident'
  | 'dispute'
  | 'payment'
  | 'verification'
  | 'lost_item'
  | 'support'
  | 'corporate'
  | 'campaign'
  | 'quest'
  | 'referral';

type TFunction = (key: string, options?: { defaultValue?: string }) => string;

/**
 * Central registry for status metadata across the admin app.
 * Pages should not re-declare status → color mappings; they should
 * call `getStatusMeta(domain, status)` or use `<StatusBadge domain status />`.
 *
 * Labels are Spanish (Cuban neutral) — keys match the DB values.
 * When a `t` function is passed to `getStatusLabel`, the registry resolves
 * `admin.status_registry.<domain>.<status>` for i18n; otherwise falls
 * back to the hardcoded Spanish label.
 */
const REGISTRY: Record<Domain, Record<string, StatusMeta>> = {
  ride: {
    searching: { label: 'Buscando conductor', i18nKey: 'status_registry.ride.searching', tone: 'warning', icon: Radio },
    accepted: { label: 'Aceptado', i18nKey: 'status_registry.ride.accepted', tone: 'info', icon: CheckCircle2 },
    driver_en_route: { label: 'En camino', i18nKey: 'status_registry.ride.driver_en_route', tone: 'info', icon: ArrowLeftRight },
    arrived_at_pickup: { label: 'En origen', i18nKey: 'status_registry.ride.arrived_at_pickup', tone: 'info', icon: Clock },
    in_progress: { label: 'En curso', i18nKey: 'status_registry.ride.in_progress', tone: 'primary', icon: ArrowLeftRight },
    completed: { label: 'Completado', i18nKey: 'status_registry.ride.completed', tone: 'success', icon: CheckCircle2 },
    canceled: { label: 'Cancelado', i18nKey: 'status_registry.ride.canceled', tone: 'danger', icon: XCircle },
    disputed: { label: 'En disputa', i18nKey: 'status_registry.ride.disputed', tone: 'warning', icon: Scale },
  },
  driver: {
    pending_verification: { label: 'Verificación pendiente', i18nKey: 'status_registry.driver.pending_verification', tone: 'warning', icon: Clock },
    verified: { label: 'Verificado', i18nKey: 'status_registry.driver.verified', tone: 'success', icon: ShieldCheck },
    rejected: { label: 'Rechazado', i18nKey: 'status_registry.driver.rejected', tone: 'danger', icon: ShieldX },
    suspended: { label: 'Suspendido', i18nKey: 'status_registry.driver.suspended', tone: 'danger', icon: Ban },
    online: { label: 'En línea', i18nKey: 'status_registry.driver.online', tone: 'success', icon: Radio },
    offline: { label: 'Desconectado', i18nKey: 'status_registry.driver.offline', tone: 'default', icon: Radio },
  },
  incident: {
    open: { label: 'Abierto', i18nKey: 'status_registry.incident.open', tone: 'danger', icon: AlertTriangle },
    investigating: { label: 'En investigación', i18nKey: 'status_registry.incident.investigating', tone: 'warning', icon: Clock },
    in_review: { label: 'En revisión', i18nKey: 'status_registry.incident.in_review', tone: 'info', icon: Clock },
    resolved: { label: 'Resuelto', i18nKey: 'status_registry.incident.resolved', tone: 'success', icon: CheckCircle2 },
    dismissed: { label: 'Descartado', i18nKey: 'status_registry.incident.dismissed', tone: 'default', icon: XCircle },
    closed: { label: 'Cerrado', i18nKey: 'status_registry.incident.closed', tone: 'default', icon: XCircle },
  },
  dispute: {
    open: { label: 'Abierta', i18nKey: 'status_registry.dispute.open', tone: 'info', icon: Scale },
    under_review: { label: 'En revisión', i18nKey: 'status_registry.dispute.under_review', tone: 'warning', icon: Clock },
    awaiting_response: { label: 'Esperando respuesta', i18nKey: 'status_registry.dispute.awaiting_response', tone: 'warning', icon: Clock },
    resolved: { label: 'Resuelta', i18nKey: 'status_registry.dispute.resolved', tone: 'success', icon: CheckCircle2 },
    denied: { label: 'Denegada', i18nKey: 'status_registry.dispute.denied', tone: 'danger', icon: XCircle },
    rejected: { label: 'Rechazada', i18nKey: 'status_registry.dispute.rejected', tone: 'danger', icon: XCircle },
    closed: { label: 'Cerrada', i18nKey: 'status_registry.dispute.closed', tone: 'default', icon: XCircle },
  },
  payment: {
    pending: { label: 'Pendiente', i18nKey: 'status_registry.payment.pending', tone: 'warning', icon: Clock },
    completed: { label: 'Completado', i18nKey: 'status_registry.payment.completed', tone: 'success', icon: CheckCircle2 },
    failed: { label: 'Fallido', i18nKey: 'status_registry.payment.failed', tone: 'danger', icon: XCircle },
    refunded: { label: 'Reembolsado', i18nKey: 'status_registry.payment.refunded', tone: 'info', icon: ArrowLeftRight },
  },
  verification: {
    pending: { label: 'Pendiente', i18nKey: 'status_registry.verification.pending', tone: 'warning', icon: Clock },
    approved: { label: 'Aprobada', i18nKey: 'status_registry.verification.approved', tone: 'success', icon: ShieldCheck },
    rejected: { label: 'Rechazada', i18nKey: 'status_registry.verification.rejected', tone: 'danger', icon: ShieldX },
  },
  lost_item: {
    reported: { label: 'Reportado', i18nKey: 'status_registry.lost_item.reported', tone: 'info', icon: AlertTriangle },
    driver_notified: { label: 'Conductor notificado', i18nKey: 'status_registry.lost_item.driver_notified', tone: 'warning', icon: Clock },
    found: { label: 'Encontrado', i18nKey: 'status_registry.lost_item.found', tone: 'success', icon: CheckCircle2 },
    not_found: { label: 'No encontrado', i18nKey: 'status_registry.lost_item.not_found', tone: 'danger', icon: XCircle },
    return_arranged: { label: 'Entrega agendada', i18nKey: 'status_registry.lost_item.return_arranged', tone: 'info', icon: Clock },
    returned: { label: 'Devuelto', i18nKey: 'status_registry.lost_item.returned', tone: 'success', icon: CheckCircle2 },
    closed: { label: 'Cerrado', i18nKey: 'status_registry.lost_item.closed', tone: 'default', icon: XCircle },
  },
  support: {
    open: { label: 'Abierto', i18nKey: 'status_registry.support.open', tone: 'info', icon: Clock },
    in_progress: { label: 'En progreso', i18nKey: 'status_registry.support.in_progress', tone: 'warning', icon: Clock },
    waiting_user: { label: 'Esperando usuario', i18nKey: 'status_registry.support.waiting_user', tone: 'warning', icon: Clock },
    resolved: { label: 'Resuelto', i18nKey: 'status_registry.support.resolved', tone: 'success', icon: CheckCircle2 },
    closed: { label: 'Cerrado', i18nKey: 'status_registry.support.closed', tone: 'default', icon: XCircle },
  },
  corporate: {
    pending: { label: 'Pendiente', i18nKey: 'status_registry.corporate.pending', tone: 'warning', icon: Clock },
    approved: { label: 'Aprobada', i18nKey: 'status_registry.corporate.approved', tone: 'success', icon: CheckCircle2 },
    suspended: { label: 'Suspendida', i18nKey: 'status_registry.corporate.suspended', tone: 'danger', icon: Ban },
    rejected: { label: 'Rechazada', i18nKey: 'status_registry.corporate.rejected', tone: 'default', icon: XCircle },
  },
  campaign: {
    draft: { label: 'Borrador', i18nKey: 'status_registry.campaign.draft', tone: 'default', icon: Clock },
    scheduled: { label: 'Programada', i18nKey: 'status_registry.campaign.scheduled', tone: 'info', icon: Clock },
    sent: { label: 'Enviada', i18nKey: 'status_registry.campaign.sent', tone: 'success', icon: CheckCircle2 },
    active: { label: 'Activa', i18nKey: 'status_registry.campaign.active', tone: 'success', icon: Radio },
    paused: { label: 'Pausada', i18nKey: 'status_registry.campaign.paused', tone: 'warning', icon: Clock },
    cancelled: { label: 'Cancelada', i18nKey: 'status_registry.campaign.cancelled', tone: 'danger', icon: XCircle },
    completed: { label: 'Finalizada', i18nKey: 'status_registry.campaign.completed', tone: 'default', icon: CheckCircle2 },
    archived: { label: 'Archivada', i18nKey: 'status_registry.campaign.archived', tone: 'default', icon: XCircle },
  },
  quest: {
    draft: { label: 'Borrador', i18nKey: 'status_registry.quest.draft', tone: 'default', icon: Clock },
    active: { label: 'Activa', i18nKey: 'status_registry.quest.active', tone: 'success', icon: Radio },
    paused: { label: 'Pausada', i18nKey: 'status_registry.quest.paused', tone: 'warning', icon: Clock },
    completed: { label: 'Finalizada', i18nKey: 'status_registry.quest.completed', tone: 'default', icon: CheckCircle2 },
    archived: { label: 'Archivada', i18nKey: 'status_registry.quest.archived', tone: 'default', icon: XCircle },
  },
  referral: {
    pending: { label: 'Pendiente', i18nKey: 'status_registry.referral.pending', tone: 'warning', icon: Clock },
    rewarded: { label: 'Premiado', i18nKey: 'status_registry.referral.rewarded', tone: 'success', icon: CheckCircle2 },
    invalidated: { label: 'Invalidado', i18nKey: 'status_registry.referral.invalidated', tone: 'danger', icon: XCircle },
  },
};

export function getStatusMeta(domain: Domain, status: string | null | undefined): StatusMeta {
  if (!status) {
    return {
      label: 'Sin estado',
      i18nKey: 'status_registry.unknown',
      tone: 'default',
      icon: HelpCircle,
    };
  }
  const entry = REGISTRY[domain]?.[status];
  if (entry) return entry;
  return {
    label: status.replace(/_/g, ' '),
    i18nKey: `status_registry.${domain}.${status}`,
    tone: 'default',
    icon: HelpCircle,
  };
}

/**
 * Resolve the label of a status via a translation function. Use this
 * from components that have access to `useTranslation('admin')`.
 * Falls back to the registry's Spanish label when no `t` is provided
 * or the key isn't in the locale file.
 */
export function getStatusLabel(
  domain: Domain,
  status: string | null | undefined,
  t?: TFunction,
): string {
  const meta = getStatusMeta(domain, status);
  if (!t) return meta.label;
  return t(meta.i18nKey, { defaultValue: meta.label });
}

/**
 * Escape hatch for pages that need a domain not listed above.
 * Mutates the registry at runtime. Prefer adding to the registry directly
 * in this file when possible.
 */
export function registerStatus(domain: Domain, status: string, meta: StatusMeta) {
  REGISTRY[domain][status] = meta;
}

export type { Domain as StatusDomain };
