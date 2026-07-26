'use client';

// ============================================================
// /account/delete — public account deletion landing page
//
// BUG-Store-Readiness-Client (B2): Google Play Store User Data Policy
// (May 2023+) requires apps with account creation to provide a publicly
// accessible URL — outside the app — that explains how to delete the
// account, in addition to the in-app deletion flow.
//
// This page satisfies that requirement. It:
//   1. Deletes the account directly when the visitor is signed in
//      (see below).
//   2. Explains the equivalent in-app flow.
//   3. Lists the data that gets removed vs. anonymized (audit trail
//      stays per AML compliance).
//   4. Provides a mailto: fallback for users who have already deleted
//      the app or lost access to their phone — support manually
//      verifies identity and triggers the same edge function.
//
// (1) was missing until the 2026-07 settings audit: the page said
// deletion "requires authentication and lives inside the mobile app",
// and `/profile/settings` linked here as its "Eliminar mi cuenta"
// action. So a signed-in web user who asked to delete their account was
// handed an explainer and told to email support — while the mobile app
// did it in one tap. `deleteAccount()` needs nothing the browser lacks:
// the edge function derives the user from the JWT.
//
// Linked from `apps/web/src/app/web-footer.tsx` Legal section, and
// declared in `apps/client/store-metadata/data-safety.md` as the
// public deletion URL for Play Console.
// ============================================================

import { useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { useAuth } from '../../providers';

const SUPPORT_EMAIL = 'soporte@tricigo.com';

/** Typed confirmation, mirroring the driver app's Alert.prompt flow. */
const CONFIRM_WORD = 'ELIMINAR';

export default function AccountDeletePage() {
  const { t } = useTranslation('web');
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const canDelete = confirmText.trim().toUpperCase() === CONFIRM_WORD && !deleting;

  async function handleDelete() {
    if (!canDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      // Same edge function the mobile app calls. It resolves the user
      // from the JWT, so the browser cannot delete anyone else.
      await authService.deleteAccount();
      window.location.href = '/';
    } catch {
      setDeleting(false);
      setDeleteError(
        t('account_delete.delete_error', {
          defaultValue: 'No pudimos eliminar la cuenta. Intentá de nuevo o escribinos a soporte.',
        }),
      );
    }
  }

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

      {/* Signed-in visitors delete here, no detour through support. */}
      {!authLoading && isAuthenticated && (
        <section
          style={{
            marginBottom: '2rem',
            padding: '1.25rem',
            border: '1px solid rgba(239,68,68,0.4)',
            background: 'rgba(239,68,68,0.08)',
            borderRadius: 12,
          }}
        >
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.75rem' }}>
            {t('account_delete.now_title', { defaultValue: 'Eliminar mi cuenta ahora' })}
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            {t('account_delete.now_body', {
              defaultValue:
                'Estás con la sesión abierta, así que podés eliminarla desde acá. La acción es inmediata e irreversible.',
            })}
          </p>
          <label
            htmlFor="confirm-delete"
            style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontSize: '0.9375rem' }}
          >
            {t('account_delete.now_confirm_label', {
              defaultValue: 'Para confirmar, escribí ELIMINAR:',
            })}
          </label>
          <input
            id="confirm-delete"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
            disabled={deleting}
            style={{
              width: '100%',
              maxWidth: 280,
              padding: '0.625rem 0.75rem',
              borderRadius: 8,
              border: '1px solid var(--border, rgba(0,0,0,0.2))',
              background: 'var(--bg-card, #fff)',
              color: 'var(--text-primary, #111)',
              marginBottom: '1rem',
            }}
          />
          <div>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!canDelete}
              style={{
                padding: '0.75rem 1.5rem',
                background: canDelete ? '#EF4444' : 'rgba(239,68,68,0.4)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontWeight: 600,
                cursor: canDelete ? 'pointer' : 'not-allowed',
              }}
            >
              {deleting
                ? t('account_delete.now_deleting', { defaultValue: 'Eliminando…' })
                : t('account_delete.now_cta', { defaultValue: 'Eliminar mi cuenta' })}
            </button>
          </div>
          {deleteError && (
            <p role="alert" style={{ color: '#EF4444', marginTop: '0.75rem', fontSize: '0.9375rem' }}>
              {deleteError}
            </p>
          )}
        </section>
      )}

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
