'use client';

import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import {
  Activity,
  ArrowRight,
  ArrowLeftRight,
  Bot,
  Building2,
  Car,
  DollarSign,
  Flag,
  FlaskConical,
  Gift,
  Map,
  MapPin,
  Sliders,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type GroupKey = 'catalogo' | 'dinero' | 'geografia' | 'automatizacion' | 'experimentos';

type Section = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  group: GroupKey;
};

export default function SettingsPage() {
  const { t } = useTranslation('admin');

  const sections: Section[] = [
    { href: '/settings/service-types', title: t('settings_hub.section_service_types_title', { defaultValue: 'Tipos de servicio' }), description: t('settings_hub.section_service_types_desc', { defaultValue: 'Triciclo, moto, auto, mensajería y sus reglas' }), icon: Car, group: 'catalogo' },
    { href: '/settings/cities', title: t('settings_hub.section_cities_title', { defaultValue: 'Ciudades activas' }), description: t('settings_hub.section_cities_desc', { defaultValue: 'En qué municipios opera TriciGo' }), icon: Building2, group: 'geografia' },
    { href: '/settings/zones', title: t('settings_hub.section_zones_title', { defaultValue: 'Zonas operativas' }), description: t('settings_hub.section_zones_desc', { defaultValue: 'Delimitaciones dentro de cada ciudad' }), icon: Map, group: 'geografia' },
    { href: '/settings/live-map', title: t('settings_hub.section_live_map_title', { defaultValue: 'Mapa en vivo' }), description: t('settings_hub.section_live_map_desc', { defaultValue: 'Visualización operativa en tiempo real' }), icon: MapPin, group: 'geografia' },
    { href: '/settings/pricing', title: t('settings_hub.section_pricing_title', { defaultValue: 'Reglas de tarifa' }), description: t('settings_hub.section_pricing_desc', { defaultValue: 'Base, por km, por minuto, mínimos y cargos' }), icon: DollarSign, group: 'dinero' },
    { href: '/settings/exchange-rate', title: t('settings_hub.section_exchange_title', { defaultValue: 'Tasa de cambio' }), description: t('settings_hub.section_exchange_desc', { defaultValue: 'CUP ↔ TriciCoin y reglas de conversión' }), icon: ArrowLeftRight, group: 'dinero' },
    { href: '/settings/promotions', title: t('settings_hub.section_promotions_title', { defaultValue: 'Promociones' }), description: t('settings_hub.section_promotions_desc', { defaultValue: 'Códigos de descuento y cupones' }), icon: Gift, group: 'dinero' },
    { href: '/settings/surge-zones', title: t('settings_hub.section_surge_zones_title', { defaultValue: 'Zonas de surge' }), description: t('settings_hub.section_surge_zones_desc', { defaultValue: 'Polígonos con multiplicador dinámico' }), icon: Zap, group: 'dinero' },
    { href: '/settings/surge-dashboard', title: t('settings_hub.section_surge_dashboard_title', { defaultValue: 'Dashboard de surge' }), description: t('settings_hub.section_surge_dashboard_desc', { defaultValue: 'Actividad actual del pricing dinámico' }), icon: Activity, group: 'dinero' },
    { href: '/settings/automation', title: t('settings_hub.section_automation_title', { defaultValue: 'Automatización' }), description: t('settings_hub.section_automation_desc', { defaultValue: 'Reglas del motor auto-accept y auto-nav' }), icon: Bot, group: 'automatizacion' },
    { href: '/settings/feature-flags', title: t('settings_hub.section_feature_flags_title', { defaultValue: 'Feature flags' }), description: t('settings_hub.section_feature_flags_desc', { defaultValue: 'Activar o desactivar features en caliente' }), icon: Flag, group: 'experimentos' },
    { href: '/settings/experiments', title: t('settings_hub.section_experiments_title', { defaultValue: 'Experimentos' }), description: t('settings_hub.section_experiments_desc', { defaultValue: 'A/B tests activos y resultados' }), icon: FlaskConical, group: 'experimentos' },
    { href: '/settings/platform-config', title: t('settings_hub.section_platform_config_title', { defaultValue: 'Configuración de plataforma' }), description: t('settings_hub.section_platform_config_desc', { defaultValue: 'Valores internos del sistema' }), icon: Sliders, group: 'automatizacion' },
  ];

  const groups: GroupKey[] = ['catalogo', 'geografia', 'dinero', 'automatizacion', 'experimentos'];
  const groupLabel = (g: GroupKey): string => {
    const fallbacks: Record<GroupKey, string> = {
      catalogo: 'Catálogo', dinero: 'Dinero', geografia: 'Geografía',
      automatizacion: 'Automatización', experimentos: 'Experimentos',
    };
    return t(`settings_hub.group_${g}`, { defaultValue: fallbacks[g] });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('settings_hub.page_eyebrow', { defaultValue: 'Sistema · ajustes' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('settings_hub.title', { defaultValue: 'Ajustes' })}
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          {t('settings_hub.page_description', { defaultValue: 'Palancas centrales de TriciGo. Cada sección controla un aspecto específico del servicio.' })}
        </p>
      </div>

      {groups.map((g) => {
        const groupSections = sections.filter((s) => s.group === g);
        if (groupSections.length === 0) return null;
        return (
          <section key={g}>
            <div className="mb-3 flex items-baseline gap-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
                {groupLabel(g)}
              </span>
              <span className="flex-1 border-t border-dashed border-line" aria-hidden="true" />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {groupSections.map((s) => {
                const Icon = s.icon;
                return (
                  <Link
                    key={s.href}
                    href={s.href}
                    className="admin-card group flex items-start gap-3 p-4 transition-colors hover:bg-surface-sunken/50"
                  >
                    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-500">
                      <Icon className="h-4.5 w-4.5" strokeWidth={1.8} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-display text-[14px] font-semibold text-ink">{s.title}</h3>
                      <p className="mt-0.5 text-[11.5px] text-ink-muted">{s.description}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 flex-shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
