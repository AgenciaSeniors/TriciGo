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
  label: string;
  tone: StatusTone;
  icon?: LucideIcon;
};

type Domain = 'ride' | 'driver' | 'incident' | 'dispute' | 'payment' | 'verification' | 'lost_item';

/**
 * Central registry for status metadata across the admin app.
 * Pages should not re-declare status → color mappings; they should
 * call `getStatusMeta(domain, status)` or use `<StatusBadge domain status />`.
 *
 * Labels are Spanish (Cuban neutral) — keys match the DB values.
 */
const REGISTRY: Record<Domain, Record<string, StatusMeta>> = {
  ride: {
    searching: { label: 'Buscando conductor', tone: 'warning', icon: Radio },
    accepted: { label: 'Aceptado', tone: 'info', icon: CheckCircle2 },
    driver_en_route: { label: 'En camino', tone: 'info', icon: ArrowLeftRight },
    arrived_at_pickup: { label: 'En origen', tone: 'info', icon: Clock },
    in_progress: { label: 'En curso', tone: 'primary', icon: ArrowLeftRight },
    completed: { label: 'Completado', tone: 'success', icon: CheckCircle2 },
    canceled: { label: 'Cancelado', tone: 'danger', icon: XCircle },
    disputed: { label: 'En disputa', tone: 'warning', icon: Scale },
  },
  driver: {
    pending_verification: { label: 'Verificación pendiente', tone: 'warning', icon: Clock },
    verified: { label: 'Verificado', tone: 'success', icon: ShieldCheck },
    rejected: { label: 'Rechazado', tone: 'danger', icon: ShieldX },
    suspended: { label: 'Suspendido', tone: 'danger', icon: Ban },
    online: { label: 'En línea', tone: 'success', icon: Radio },
    offline: { label: 'Desconectado', tone: 'default', icon: Radio },
  },
  incident: {
    open: { label: 'Abierto', tone: 'danger', icon: AlertTriangle },
    investigating: { label: 'En investigación', tone: 'warning', icon: Clock },
    in_review: { label: 'En revisión', tone: 'info', icon: Clock },
    resolved: { label: 'Resuelto', tone: 'success', icon: CheckCircle2 },
    dismissed: { label: 'Descartado', tone: 'default', icon: XCircle },
    closed: { label: 'Cerrado', tone: 'default', icon: XCircle },
  },
  dispute: {
    open: { label: 'Abierta', tone: 'info', icon: Scale },
    under_review: { label: 'En revisión', tone: 'warning', icon: Clock },
    awaiting_response: { label: 'Esperando respuesta', tone: 'warning', icon: Clock },
    resolved: { label: 'Resuelta', tone: 'success', icon: CheckCircle2 },
    denied: { label: 'Denegada', tone: 'danger', icon: XCircle },
    rejected: { label: 'Rechazada', tone: 'danger', icon: XCircle },
    closed: { label: 'Cerrada', tone: 'default', icon: XCircle },
  },
  payment: {
    pending: { label: 'Pendiente', tone: 'warning', icon: Clock },
    completed: { label: 'Completado', tone: 'success', icon: CheckCircle2 },
    failed: { label: 'Fallido', tone: 'danger', icon: XCircle },
    refunded: { label: 'Reembolsado', tone: 'info', icon: ArrowLeftRight },
  },
  verification: {
    pending: { label: 'Pendiente', tone: 'warning', icon: Clock },
    approved: { label: 'Aprobada', tone: 'success', icon: ShieldCheck },
    rejected: { label: 'Rechazada', tone: 'danger', icon: ShieldX },
  },
  lost_item: {
    reported: { label: 'Reportado', tone: 'info', icon: AlertTriangle },
    driver_notified: { label: 'Conductor notificado', tone: 'warning', icon: Clock },
    found: { label: 'Encontrado', tone: 'success', icon: CheckCircle2 },
    not_found: { label: 'No encontrado', tone: 'danger', icon: XCircle },
    return_arranged: { label: 'Entrega agendada', tone: 'info', icon: Clock },
    returned: { label: 'Devuelto', tone: 'success', icon: CheckCircle2 },
    closed: { label: 'Cerrado', tone: 'default', icon: XCircle },
  },
};

export function getStatusMeta(domain: Domain, status: string | null | undefined): StatusMeta {
  if (!status) {
    return { label: 'Sin estado', tone: 'default', icon: HelpCircle };
  }
  const entry = REGISTRY[domain]?.[status];
  if (entry) return entry;
  return {
    label: status.replace(/_/g, ' '),
    tone: 'default',
    icon: HelpCircle,
  };
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
