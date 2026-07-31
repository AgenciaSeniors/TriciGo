// ============================================================
// TriciGo — Public B2B pre-registration form (PR-CORP-5, Gap 8)
//
// Mirror of apps/client/src/components/CorporateRequestForm.tsx but
// as a Next.js page accessible at /empresas/registro. Requires the
// user to be logged in — if not, redirect to /login with return URL.
//
// Submits via corporateService.submitClientRequest which creates a
// corporate_accounts row in status='pending'. Admin reviews it from
// the admin panel.
// ============================================================

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, corporateService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';

const SECTORS = [
  { id: 'tourism', label: 'Turismo' },
  { id: 'gastronomy', label: 'Gastronomia' },
  { id: 'health', label: 'Salud' },
  { id: 'education', label: 'Educacion' },
  { id: 'tech', label: 'Tecnologia' },
  { id: 'logistics', label: 'Logistica' },
  { id: 'other', label: 'Otro' },
];

const SIZE_RANGES = [
  { id: '1-10', label: '1 – 10' },
  { id: '11-50', label: '11 – 50' },
  { id: '51-200', label: '51 – 200' },
  { id: '200+', label: '200+' },
];

const PAYMENT_OPTIONS: Array<{
  id: 'cash' | 'tricicoin' | 'mixed' | 'card';
  label: string;
}> = [
  { id: 'cash', label: 'Efectivo' },
  { id: 'tricicoin', label: 'TriciCoin' },
  { id: 'mixed', label: 'Mixto' },
  { id: 'card', label: 'Tarjeta' },
];

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.82rem',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '0.4rem',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.65rem 0.85rem',
  border: '1px solid var(--border-light)',
  borderRadius: '0.5rem',
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  color: 'var(--text-primary)',
  background: 'var(--bg-card)',
};

function Chip({
  selected,
  onClick,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.45rem 0.85rem',
        borderRadius: '999px',
        fontSize: '0.85rem',
        fontWeight: 600,
        cursor: 'pointer',
        background: selected ? 'var(--primary)' : 'transparent',
        color: selected ? '#fff' : 'var(--text-primary)',
        border: `1px solid ${selected ? 'var(--primary)' : 'var(--border-light)'}`,
      }}
    >
      {label}
    </button>
  );
}

export default function EmpresasRegistroPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Form state — same fields as CorporateRequestForm
  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [sector, setSector] = useState<string>('');
  const [size, setSize] = useState<string>('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [estimatedRides, setEstimatedRides] = useState('');
  const [hoursStart, setHoursStart] = useState('');
  const [hoursEnd, setHoursEnd] = useState('');
  const [payment, setPayment] = useState<'cash' | 'tricicoin' | 'mixed' | 'card' | ''>('');
  const [requiresInvoice, setRequiresInvoice] = useState(false);
  const [comments, setComments] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient()
      .auth.getSession()
      .then(({ data: { session } }) => {
        if (!session?.user?.id) {
          // Not logged in — send to /login with return URL
          router.replace('/login?return=/empresas/registro');
          return;
        }
        setUserId(session.user.id);
        setAuthLoading(false);
      });
  }, [router]);

  const canSubmit =
    !!name.trim() &&
    !!contactPhone.trim() &&
    !!sector &&
    !!size &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await corporateService.submitClientRequest({
        name: name.trim(),
        contact_phone: contactPhone.trim(),
        contact_email: contactEmail.trim() || undefined,
        tax_id: taxId.trim() || undefined,
        created_by: userId,
        sector,
        employees_count_range: size,
        estimated_rides_per_month: estimatedRides
          ? parseInt(estimatedRides, 10)
          : undefined,
        operating_hours_start: hoursStart.trim() || undefined,
        operating_hours_end: hoursEnd.trim() || undefined,
        preferred_payment: payment || undefined,
        requires_invoice: requiresInvoice,
        comments: comments.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <main
        style={{
          maxWidth: 600,
          margin: '0 auto',
          padding: '4rem 1.5rem',
          textAlign: 'center',
        }}
      >
        <p style={{ color: 'var(--text-secondary)' }}>Verificando sesion...</p>
      </main>
    );
  }

  if (submitted) {
    return (
      <main
        style={{
          maxWidth: 600,
          margin: '0 auto',
          padding: '4rem 1.5rem',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✅</div>
        <h1
          style={{
            fontSize: '1.75rem',
            fontWeight: 800,
            marginBottom: '0.5rem',
            color: 'var(--text-primary)',
          }}
        >
          Solicitud enviada
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '1rem',
            lineHeight: 1.6,
            marginBottom: '2rem',
          }}
        >
          Recibimos tu solicitud para <strong>{name}</strong>. Un administrador
          la revisara en menos de 24 horas habiles y recibiras una notificacion
          cuando este aprobada.
        </p>
        <Link
          href="/profile/corporate"
          style={{
            display: 'inline-block',
            padding: '0.75rem 1.5rem',
            background: 'var(--primary)',
            color: '#fff',
            borderRadius: '0.6rem',
            fontWeight: 700,
            fontSize: '0.9rem',
            textDecoration: 'none',
          }}
        >
          Ver mi solicitud
        </Link>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1
        style={{
          fontSize: '2rem',
          fontWeight: 800,
          marginBottom: '0.5rem',
          color: 'var(--text-primary)',
        }}
      >
        Registra tu empresa
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: '0.95rem',
          marginBottom: '2.5rem',
          lineHeight: 1.6,
        }}
      >
        Llena este formulario para solicitar tu cuenta corporativa TriciGo. Un
        admin revisa cada solicitud en menos de 24 horas habiles. Si tenes
        dudas antes,{' '}
        <Link href="/contact" style={{ color: 'var(--primary)' }}>
          contáctanos
        </Link>
        .
      </p>

      <form onSubmit={handleSubmit}>
        {/* Company name */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={labelStyle} htmlFor="name">
            Nombre de la empresa *
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Ej: Hotel Habana Libre"
            style={inputStyle}
          />
        </div>

        {/* Tax ID */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={labelStyle} htmlFor="taxId">
            ID fiscal / CUIT (opcional)
          </label>
          <input
            id="taxId"
            type="text"
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            placeholder="Si tu empresa esta registrada"
            style={inputStyle}
          />
        </div>

        {/* Sector chips */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={labelStyle}>Sector *</label>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}
          >
            {SECTORS.map((s) => (
              <Chip
                key={s.id}
                selected={sector === s.id}
                onClick={() => setSector(s.id)}
                label={s.label}
              />
            ))}
          </div>
        </div>

        {/* Size chips */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={labelStyle}>Cantidad de empleados *</label>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}
          >
            {SIZE_RANGES.map((s) => (
              <Chip
                key={s.id}
                selected={size === s.id}
                onClick={() => setSize(s.id)}
                label={s.label}
              />
            ))}
          </div>
        </div>

        {/* Contact phone */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={labelStyle} htmlFor="phone">
            Telefono de contacto *
          </label>
          <input
            id="phone"
            type="tel"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            required
            placeholder="+53 5XXXXXXX o 6XXXXXXX"
            style={inputStyle}
          />
        </div>

        {/* Contact email */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={labelStyle} htmlFor="email">
            Correo de contacto (opcional)
          </label>
          <input
            id="email"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="ceo@empresa.com"
            style={inputStyle}
          />
        </div>

        {/* Estimated rides */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={labelStyle} htmlFor="rides">
            Viajes estimados por mes (opcional)
          </label>
          <input
            id="rides"
            type="number"
            min={0}
            value={estimatedRides}
            onChange={(e) => setEstimatedRides(e.target.value)}
            placeholder="Ej: 80"
            style={inputStyle}
          />
        </div>

        {/* Operating hours */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0.85rem',
            marginBottom: '1.25rem',
          }}
        >
          <div>
            <label style={labelStyle} htmlFor="hstart">
              Horario inicio (opcional)
            </label>
            <input
              id="hstart"
              type="time"
              value={hoursStart}
              onChange={(e) => setHoursStart(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="hend">
              Horario fin (opcional)
            </label>
            <input
              id="hend"
              type="time"
              value={hoursEnd}
              onChange={(e) => setHoursEnd(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>

        {/* Payment chips */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={labelStyle}>Metodo de pago preferido (opcional)</label>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}
          >
            {PAYMENT_OPTIONS.map((p) => (
              <Chip
                key={p.id}
                selected={payment === p.id}
                onClick={() => setPayment(payment === p.id ? '' : p.id)}
                label={p.label}
              />
            ))}
          </div>
        </div>

        {/* Requires invoice */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              cursor: 'pointer',
              fontSize: '0.9rem',
              color: 'var(--text-primary)',
            }}
          >
            <input
              type="checkbox"
              checked={requiresInvoice}
              onChange={(e) => setRequiresInvoice(e.target.checked)}
            />
            Necesito factura mensual con razon social
          </label>
        </div>

        {/* Comments */}
        <div style={{ marginBottom: '1.5rem' }}>
          <label style={labelStyle} htmlFor="comments">
            Comentarios adicionales (opcional)
          </label>
          <textarea
            id="comments"
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Cualquier info que nos ayude a entender tu caso"
            rows={4}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        {error && (
          <div
            style={{
              padding: '0.75rem 1rem',
              background: '#fee',
              color: '#c00',
              borderRadius: '0.5rem',
              marginBottom: '1rem',
              fontSize: '0.875rem',
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            width: '100%',
            padding: '0.95rem',
            background: canSubmit ? 'var(--primary)' : 'var(--border-light)',
            color: '#fff',
            border: 'none',
            borderRadius: '0.75rem',
            fontSize: '0.95rem',
            fontWeight: 700,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            opacity: canSubmit ? 1 : 0.7,
          }}
        >
          {submitting ? 'Enviando solicitud...' : 'Enviar solicitud'}
        </button>

        <p
          style={{
            marginTop: '1.5rem',
            fontSize: '0.8rem',
            color: 'var(--text-tertiary)',
            textAlign: 'center',
          }}
        >
          Al enviar aceptas los{' '}
          <Link href="/terms" style={{ color: 'var(--primary)' }}>
            terminos
          </Link>{' '}
          y la{' '}
          <Link href="/privacy" style={{ color: 'var(--primary)' }}>
            politica de privacidad
          </Link>
          .
        </p>
      </form>
    </main>
  );
}
