'use client';

import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { Car, DollarSign, Map, Zap, Gift, Flag, Sliders, ArrowLeftRight, Activity, Bot } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Section = {
  href: string;
  titleKey: string;
  descKey: string;
  icon: LucideIcon;
};

export default function SettingsPage() {
  const { t } = useTranslation('admin');

  const sections: Section[] = [
    {
      href: '/settings/service-types',
      titleKey: 'settings.service_types',
      descKey: 'settings.service_types_desc',
      icon: Car,
    },
    {
      href: '/settings/pricing',
      titleKey: 'settings.pricing_rules',
      descKey: 'settings.pricing_desc',
      icon: DollarSign,
    },
    {
      href: '/settings/zones',
      titleKey: 'settings.zones',
      descKey: 'settings.zones_desc',
      icon: Map,
    },
    {
      href: '/settings/surge-zones',
      titleKey: 'settings.surge_zones',
      descKey: 'settings.surge_zones_desc',
      icon: Zap,
    },
    {
      href: '/settings/surge-dashboard',
      titleKey: 'settings.surge_dashboard',
      descKey: 'settings.surge_dashboard_desc',
      icon: Activity,
    },
    {
      href: '/settings/promotions',
      titleKey: 'settings.promotions',
      descKey: 'settings.promotions_desc',
      icon: Gift,
    },
    {
      href: '/settings/feature-flags',
      titleKey: 'settings.feature_flags',
      descKey: 'settings.flags_desc',
      icon: Flag,
    },
    {
      href: '/settings/exchange-rate',
      titleKey: 'exchange_rate.title',
      descKey: 'exchange_rate.subtitle',
      icon: ArrowLeftRight,
    },
    {
      href: '/settings/platform-config',
      titleKey: 'platform_config.title',
      descKey: 'platform_config.subtitle',
      icon: Sliders,
    },
    {
      href: '/settings/automation',
      titleKey: 'settings.automation',
      descKey: 'settings.automation_desc',
      icon: Bot,
    },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">{t('settings.title')}</h1>

      <div className="space-y-4">
        {sections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 flex items-center justify-between hover:border-primary-500/30 transition-colors block"
          >
            <div className="flex items-center gap-4">
              <section.icon className="w-6 h-6 text-primary-500" />
              <div>
                <h3 className="font-bold text-lg">{t(section.titleKey)}</h3>
                <p className="text-sm text-neutral-500 mt-1">{t(section.descKey)}</p>
              </div>
            </div>
            <svg className="w-5 h-5 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        ))}
      </div>
    </div>
  );
}
