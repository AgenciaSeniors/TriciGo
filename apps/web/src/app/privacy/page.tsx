'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { cmsService } from '@tricigo/api/services/cms';
import { sanitizeHtml } from '@/lib/sanitize';

export default function PrivacyPolicyPage() {
  const { t, i18n } = useTranslation('web');
  const [cmsBody, setCmsBody] = useState<string | null>(null);
  const [cmsTitle, setCmsTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const content = await cmsService.getContent('privacy');
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

  if (cmsBody) {
    return (
      <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '2rem' }}>
          {cmsTitle ?? t('privacy.title')}
        </h1>
        <div
          style={{ color: '#444', lineHeight: 1.7, fontSize: '0.95rem' }}
          className="prose prose-neutral max-w-none"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(cmsBody.replace(/\n/g, '<br />')) }}
        />
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>
        {t('privacy.title')}
      </h1>
      <p style={{ color: '#999', fontSize: '0.875rem', marginBottom: '2.5rem' }}>
        {t('privacy.last_updated')}
      </p>

      <Section title={t('privacy.intro_title')}>
        <p>{t('privacy.intro_text')}</p>
      </Section>
      <Section title={t('privacy.data_collected_title')}>
        <p>{t('privacy.data_collected_intro')}</p>
        <ul style={{ paddingLeft: '1.25rem', marginTop: '0.5rem' }}>
          <li>{t('privacy.data_name_phone')}</li>
          <li>{t('privacy.data_location')}</li>
          <li>{t('privacy.data_ride_history')}</li>
          <li>{t('privacy.data_payment')}</li>
          <li>{t('privacy.data_device')}</li>
        </ul>
      </Section>
      <Section title={t('privacy.data_use_title')}>
        <p>{t('privacy.data_use_intro')}</p>
        <ul style={{ paddingLeft: '1.25rem', marginTop: '0.5rem' }}>
          <li>{t('privacy.use_provide_service')}</li>
          <li>{t('privacy.use_improve')}</li>
          <li>{t('privacy.use_safety')}</li>
          <li>{t('privacy.use_communications')}</li>
          <li>{t('privacy.use_legal')}</li>
        </ul>
      </Section>
      <Section title={t('privacy.sharing_title')}>
        <p>{t('privacy.sharing_text')}</p>
      </Section>
      <Section title={t('privacy.retention_title')}>
        <p>{t('privacy.retention_text')}</p>
      </Section>
      <Section title={t('privacy.rights_title')}>
        <p>{t('privacy.rights_intro')}</p>
        <ul style={{ paddingLeft: '1.25rem', marginTop: '0.5rem' }}>
          <li>{t('privacy.right_access')}</li>
          <li>{t('privacy.right_correction')}</li>
          <li>{t('privacy.right_deletion')}</li>
          <li>{t('privacy.right_portability')}</li>
        </ul>
      </Section>
      <Section title={t('privacy.security_title')}>
        <p>{t('privacy.security_text')}</p>
      </Section>
      <Section title={t('privacy.children_title')}>
        <p>{t('privacy.children_text')}</p>
      </Section>
      <Section title={t('privacy.changes_title')}>
        <p>{t('privacy.changes_text')}</p>
      </Section>
      <Section title={t('privacy.contact_title')}>
        <p>{t('privacy.contact_text')}</p>
        <p style={{ marginTop: '0.5rem', fontWeight: 600 }}>
          {t('privacy.contact_email')}
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
