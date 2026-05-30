'use client';

// ============================================================
// /account/delete — public account deletion landing page
//
// BUG-Store-Readiness-Client (B2): Google Play Store User Data Policy
// (May 2023+) requires apps with account creation to provide a publicly
// accessible URL — outside the app — that explains how to delete the
// account, in addition to the in-app deletion flow.
//
// This page satisfies that requirement. It does NOT perform the actual
// deletion (that requires authentication and lives inside the mobile
// app + edge function). Instead, it:
//   1. Explains what the in-app flow does and where to find it.
//   2. Lists the data that gets removed vs. anonymized (audit trail
//      stays per AML compliance).
//   3. Provides a mailto: fallback for users who have already deleted
//      the app or lost access to their phone — support manually
//      verifies identity and triggers the same edge function.
//
// Linked from `apps/web/src/app/web-footer.tsx` Legal section, and
// declared in `apps/client/store-metadata/data-safety.md` as the
// public deletion URL for Play Console.
// ============================================================

import { useTranslation } from '@tricigo/i18n';

const SUPPORT_EMAIL = 'soporte@tricigo.com';

export default function AccountDeletePage() {
  const { t } = useTranslation('web');

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    t('account_delete.mail_subject', { defaultValue: 'Solicitud de eliminación de cuenta' }),
  )}&body=${encodeURIComponent(
    t('account_delete.mail_body', {
      defaultValue:
        'Hola TriciGo,\n\nQuiero eliminar mi cuenta. Mis datos de identificación:\n\nTeléfono registrado: +53...\nNombre completo:\n\nMotivo (opcional):\n\nGracias.',
    }),
  )}`;

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem', lineHeight: 1.7 }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>
        {t('account_delete.title', { defaultValue: 'Eliminar tu cuenta de TriciGo' })}
      </h1>
      <p style={{ color: 'var(--text-tertiary)', marginBottom: '2rem' }}>
        {t('account_delete.subtitle', {
          defaultValue:
            'Tenés derecho a solicitar la eliminación de tu cuenta y de los datos personales asociados en cualquier momento.',
        })}
      </p>

      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          {t('account_delete.in_app_title', { defaultValue: 'Opción recomendada — desde la app' })}
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          {t('account_delete.in_app_body', {
            defaultValue:
              'Si tenés la app TriciGo instalada, abrila e ingresá a Perfil → Configuración → Zona de peligro → "Eliminar cuenta". El borrado es inmediato e irreversible.',
          })}
        </p>
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          {t('account_delete.mail_title', {
            defaultValue: 'Si no tenés la app o no podés acceder',
          })}
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          {t('account_delete.mail_body_help', {
            defaultValue:
              'Escribinos a soporte con tu teléfono registrado y nombre completo. Verificamos tu identidad y procesamos la eliminación dentro de 5 días hábiles.',
          })}
        </p>
        <a
          href={mailto}
          style={{
            display: 'inline-block',
            padding: '0.75rem 1.5rem',
            background: 'var(--primary, #FF4D00)',
            color: '#fff',
            borderRadius: '8px',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          {t('account_delete.mail_cta', { defaultValue: 'Escribir a soporte' })}
        </a>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginTop: '0.5rem' }}>
          {SUPPORT_EMAIL}
        </p>
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          {t('account_delete.what_deletes_title', { defaultValue: 'Qué se elimina' })}
        </h2>
        <ul style={{ color: 'var(--text-secondary)', paddingLeft: '1.5rem' }}>
          <li>{t('account_delete.what_deletes_1', { defaultValue: 'Tu cuenta y sesiones activas (no podés volver a iniciar sesión con el mismo número).' })}</li>
          <li>{t('account_delete.what_deletes_2', { defaultValue: 'Tu perfil: nombre, email, foto, idioma preferido.' })}</li>
          <li>{t('account_delete.what_deletes_3', { defaultValue: 'Saldo TriciCoin (no es reembolsable salvo solicitud previa por escrito).' })}</li>
          <li>{t('account_delete.what_deletes_4', { defaultValue: 'Contactos de confianza, notificaciones, preferencias.' })}</li>
          <li>{t('account_delete.what_deletes_5', { defaultValue: 'Métodos de pago guardados.' })}</li>
        </ul>
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          {t('account_delete.what_keeps_title', { defaultValue: 'Qué se conserva anonimizado' })}
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          {t('account_delete.what_keeps_intro', {
            defaultValue:
              'Por requisitos de auditoría financiera y antilavado (AML), conservamos algunos registros sin tus datos personales:',
          })}
        </p>
        <ul style={{ color: 'var(--text-secondary)', paddingLeft: '1.5rem' }}>
          <li>{t('account_delete.what_keeps_1', { defaultValue: 'Historial de viajes con identificador anónimo (no es posible vincularlos a vos).' })}</li>
          <li>{t('account_delete.what_keeps_2', { defaultValue: 'Transacciones financieras (recargas, pagos, comisiones) anonimizadas.' })}</li>
          <li>{t('account_delete.what_keeps_3', { defaultValue: 'Calificaciones y reseñas dadas o recibidas, con identidad reemplazada por "Usuario eliminado".' })}</li>
        </ul>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginTop: '0.5rem' }}>
          {t('account_delete.what_keeps_note', {
            defaultValue:
              'Esta retención cumple con la normativa de transporte de Cuba y estándares internacionales AML.',
          })}
        </p>
      </section>

      <section>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
          {t('account_delete.operator_note', {
            defaultValue: 'TriciGo es un servicio operado por MACH DIGITAL TECH S.R.L. (Brașov, Rumanía).',
          })}
        </p>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>
          {t('account_delete.see_also', { defaultValue: 'Más detalles en nuestra' })}{' '}
          <a href="/privacy" style={{ color: 'var(--primary, #FF4D00)', textDecoration: 'underline' }}>
            {t('account_delete.privacy_link', { defaultValue: 'Política de privacidad' })}
          </a>
          .
        </p>
      </section>
    </main>
  );
}
