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

type Section = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  group: 'Catálogo' | 'Dinero' | 'Geografía' | 'Automatización' | 'Experimentos';
};

export default function SettingsPage() {
  const { t: _t } = useTranslation('admin');

  const sections: Section[] = [
    { href: '/settings/service-types', title: 'Tipos de servicio', description: 'Triciclo, moto, auto, mensajería y sus reglas', icon: Car, group: 'Catálogo' },
    { href: '/settings/cities', title: 'Ciudades activas', description: 'En qué municipios opera TriciGo', icon: Building2, group: 'Geografía' },
    { href: '/settings/zones', title: 'Zonas operativas', description: 'Delimitaciones dentro de cada ciudad', icon: Map, group: 'Geografía' },
    { href: '/settings/live-map', title: 'Mapa en vivo', description: 'Visualización operativa en tiempo real', icon: MapPin, group: 'Geografía' },
    { href: '/settings/pricing', title: 'Reglas de tarifa', description: 'Base, por km, por minuto, mínimos y cargos', icon: DollarSign, group: 'Dinero' },
    { href: '/settings/exchange-rate', title: 'Tasa de cambio', description: 'CUP ↔ TriciCoin y reglas de conversión', icon: ArrowLeftRight, group: 'Dinero' },
    { href: '/settings/promotions', title: 'Promociones', description: 'Códigos de descuento y cupones', icon: Gift, group: 'Dinero' },
    { href: '/settings/surge-zones', title: 'Zonas de surge', description: 'Polígonos con multiplicador dinámico', icon: Zap, group: 'Dinero' },
    { href: '/settings/surge-dashboard', title: 'Dashboard de surge', description: 'Actividad actual del pricing dinámico', icon: Activity, group: 'Dinero' },
    { href: '/settings/automation', title: 'Automatización', description: 'Reglas del motor auto-accept y auto-nav', icon: Bot, group: 'Automatización' },
    { href: '/settings/feature-flags', title: 'Feature flags', description: 'Activar o desactivar features en caliente', icon: Flag, group: 'Experimentos' },
    { href: '/settings/experiments', title: 'Experimentos', description: 'A/B tests activos y resultados', icon: FlaskConical, group: 'Experimentos' },
    { href: '/settings/platform-config', title: 'Configuración de plataforma', description: 'Valores internos del sistema', icon: Sliders, group: 'Automatización' },
  ];

  const groups = ['Catálogo', 'Geografía', 'Dinero', 'Automatización', 'Experimentos'] as const;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          Sistema · ajustes
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          Ajustes
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Palancas centrales de TriciGo. Cada sección controla un aspecto específico del servicio.
        </p>
      </div>

      {groups.map((g) => {
        const groupSections = sections.filter((s) => s.group === g);
        if (groupSections.length === 0) return null;
        return (
          <section key={g}>
            <div className="mb-3 flex items-baseline gap-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
                {g}
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
