'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient } from '@tricigo/api';

interface Experiment {
  id: string;
  name: string;
  description: string;
  status: string;
  variant_a_name: string;
  variant_a_multiplier: number;
  variant_b_name: string;
  variant_b_multiplier: number;
  variant_a_rides: number;
  variant_a_conversions: number;
  variant_b_rides: number;
  variant_b_conversions: number;
  service_type: string | null;
  started_at: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-neutral-100 text-neutral-600',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-amber-100 text-amber-700',
  completed: 'bg-blue-100 text-blue-700',
};

export default function ExperimentsPage() {
  const { t } = useTranslation('admin');
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabaseClient();
    supabase
      .from('pricing_experiments')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (data) setExperiments(data as Experiment[]);
        setLoading(false);
      });
  }, []);

  const convRate = (conversions: number, rides: number) =>
    rides > 0 ? `${((conversions / rides) * 100).toFixed(1)}%` : '—';

  return (
    <div>
      <Link href="/settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <h1 className="text-3xl font-bold mb-2">
        {t('experiments.title', { defaultValue: 'Experimentos de Precios' })}
      </h1>
      <p className="text-neutral-500 mb-6">
        {t('experiments.subtitle', { defaultValue: 'A/B testing para optimizar tarifas y conversión' })}
      </p>

      {loading ? (
        <p className="text-neutral-400">{t('common.loading')}</p>
      ) : experiments.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-8 text-center">
          <p className="text-neutral-400 mb-2">{t('experiments.no_experiments', { defaultValue: 'Sin experimentos activos' })}</p>
          <p className="text-sm text-neutral-300">{t('experiments.create_hint', { defaultValue: 'Crea un experimento desde la base de datos (pricing_experiments table)' })}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {experiments.map((exp) => (
            <div key={exp.id} className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-lg">{exp.name}</h3>
                  {exp.description && <p className="text-sm text-neutral-500">{exp.description}</p>}
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-semibold ${STATUS_COLORS[exp.status] ?? STATUS_COLORS.draft}`}>
                  {exp.status.toUpperCase()}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Variant A */}
                <div className="bg-blue-50 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-blue-700 mb-2">{exp.variant_a_name}</h4>
                  <p className="text-2xl font-bold text-blue-800">{exp.variant_a_multiplier}x</p>
                  <div className="mt-2 text-xs text-blue-600">
                    <p>{exp.variant_a_rides} rides · {convRate(exp.variant_a_conversions, exp.variant_a_rides)} conv</p>
                  </div>
                </div>

                {/* Variant B */}
                <div className="bg-orange-50 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-orange-700 mb-2">{exp.variant_b_name}</h4>
                  <p className="text-2xl font-bold text-orange-800">{exp.variant_b_multiplier}x</p>
                  <div className="mt-2 text-xs text-orange-600">
                    <p>{exp.variant_b_rides} rides · {convRate(exp.variant_b_conversions, exp.variant_b_rides)} conv</p>
                  </div>
                </div>
              </div>

              {exp.service_type && (
                <p className="text-xs text-neutral-400 mt-3">Servicio: {exp.service_type}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
