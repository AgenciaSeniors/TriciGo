'use client';

import { useTranslation } from '@tricigo/i18n';
import { getStatusMeta, type StatusDomain, type StatusTone } from '@/lib/status-registry';

type Props = {
  domain: StatusDomain;
  status: string | null | undefined;
  /** Hides the icon, showing only the label */
  labelOnly?: boolean;
  size?: 'sm' | 'md';
};

const TONE_CLASS: Record<StatusTone, string> = {
  default: 'bg-surface-sunken text-ink-muted',
  primary: 'bg-primary-500/10 text-primary-600 dark:text-primary-400',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'bg-red-500/10 text-red-600 dark:text-red-400',
  info: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
};

export function StatusBadge({ domain, status, labelOnly, size = 'sm' }: Props) {
  const { t } = useTranslation('admin');
  const meta = getStatusMeta(domain, status);
  const label = t(meta.i18nKey, { defaultValue: meta.label });
  const Icon = meta.icon;
  const sizeCls =
    size === 'md'
      ? 'px-2.5 py-1 text-[11.5px] gap-1.5'
      : 'px-2 py-0.5 text-[10px] gap-1';

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${TONE_CLASS[meta.tone]} ${sizeCls}`}
      data-status={status ?? 'unknown'}
    >
      {!labelOnly && Icon && <Icon className={size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'} strokeWidth={2} />}
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}
