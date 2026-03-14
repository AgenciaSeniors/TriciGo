'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { cmsService } from '@tricigo/api/services/cms';
import { sanitizeHtml } from '@/lib/sanitize';

export default function TermsOfServicePage() {
  const { t, i18n } = useTranslation('web');
  const [cmsBody, setCmsBody] = useState<string | null>(null);
  const [cmsTitle, setCmsTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const content = await cmsService.getContent('terms');
        if (!cancelled && content) {
          const lang = i18n.language?.startsWith('en') ? 'en' : 'es';
          setCmsTitle(lang === 'en' ? content.title_en : content.title_es);
          setCmsBody(lang === 'en' ? content.body_en : content.body_es);
        }
      } catch {
        // Fallback to i18n
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [i18n.language]);

  if (loading) {
    return (
      <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
        <p style={{ textAlign: 'center', color: '#999' }}>{t('blog.loading')}</p>
      </main>
    );
  }

  // If CMS content is available, render it
  if (cmsBody) {
    return (
      <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '2rem' }}>
          {cmsTitle ?? t('terms.title')}
        </h1>
        <div
          style={{ color: '#444', lineHeight: 1.7, fontSize: '0.95rem' }}
          className="prose prose-neutral max-w-none"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(cmsBody.replace(/\n/g, '<br />')) }}
        />
      </main>
    );
  }

  // Fallback: i18n-based rendering
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>
        {t('terms.title')}
      </h1>
      <p style={{ color: '#999', fontSize: '0.875rem', marginBottom: '2.5rem' }}>
        {t('terms.last_updated')}
      </p>

      <Section title={t('terms.acceptance_title')}>
        <p>{t('terms.acceptance_text')}</p>
      </Section>
      <Section title={t('terms.service_desc_title')}>
        <p>{t('terms.service_desc_text')}</p>
      </Section>
      <Section title={t('terms.eligibility_title')}>
        <p>{t('terms.eligibility_text')}</p>
      </Section>
      <Section title={t('terms.accounts_title')}>
        <p>{t('terms.accounts_text')}</p>
      </Section>
      <Section title={t('terms.rides_title')}>
        <p>{t('terms.rides_text')}</p>
      </Section>
      <Section title={t('terms.payments_title')}>
        <p>{t('terms.payments_text')}</p>
      </Section>
      <Section title={t('terms.cancellations_title')}>
        <p>{t('terms.cancellations_text')}</p>
      </Section>
      <Section title={t('terms.conduct_title')}>
        <p>{t('terms.conduct_intro')}</p>
        <ul style={{ paddingLeft: '1.25rem', marginTop: '0.5rem' }}>
          <li>{t('terms.conduct_respectful')}</li>
          <li>{t('terms.conduct_laws')}</li>
          <li>{t('terms.conduct_no_fraud')}</li>
          <li>{t('terms.conduct_no_damage')}</li>
        </ul>
      </Section>
      <Section title={t('terms.liability_title')}>
        <p>{t('terms.liability_text')}</p>
      </Section>
      <Section title={t('terms.ip_title')}>
        <p>{t('terms.ip_text')}</p>
      </Section>
      <Section title={t('terms.termination_title')}>
        <p>{t('terms.termination_text')}</p>
      </Section>
      <Section title={t('terms.modifications_title')}>
        <p>{t('terms.modifications_text')}</p>
      </Section>
      <Section title={t('terms.governing_law_title')}>
        <p>{t('terms.governing_law_text')}</p>
      </Section>
      <Section title={t('terms.contact_title')}>
        <p>{t('terms.contact_text')}</p>
        <p style={{ marginTop: '0.5rem', fontWeight: 600 }}>
          {t('terms.contact_email')}
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.75rem' }}>
        {title}
      </h2>
      <div style={{ color: '#444', lineHeight: 1.7, fontSize: '0.95rem' }}>
        {children}
      </div>
    </section>
  );
}
