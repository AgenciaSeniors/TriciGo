'use client';

// Web port of apps/client/src/components/CorporateRequestForm.tsx.
// Rendered by /profile/corporate when the user has no corporate membership
// and no in-flight request. Submits via corporateService.submitClientRequest.
// Web keeps its own (inline-style) design; the fields + payload match the
// native form exactly.

import { useState } from 'react';
import { corporateService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';

const SECTORS = [
  { id: 'tourism', label: 'Turismo' },
  { id: 'gastronomy', label: 'Gastronomía' },
  { id: 'health', label: 'Salud' },
  { id: 'education', label: 'Educación' },
  { id: 'tech', label: 'Tecnología' },
  { id: 'logistics', label: 'Logística' },
  { id: 'other', label: 'Otro' },
];

const SIZE_RANGES = [
  { id: '1-10', label: '1 – 10' },
  { id: '11-50', label: '11 – 50' },
  { id: '51-200', label: '51 – 200' },
  { id: '200+', label: '200+' },
];

const PAYMENT_OPTIONS: Array<{ id: 'cash' | 'tricicoin' | 'mixed' | 'card'; label: string }> = [
  { id: 'cash', label: 'Efectivo' },
  { id: 'tricicoin', label: 'TriciCoin' },
  { id: 'mixed', label: 'Mixto' },
  { id: 'card', label: 'Tarjeta' },
];

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  border: '1px solid var(--border-light)',
  borderRadius: '0.5rem',
  fontSize: '0.9rem',
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: 'var(--text-tertiary)',
  marginBottom: '0.35rem',
};

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-light)',
  borderRadius: '0.75rem',
  padding: '1.25rem',
  marginBottom: '1rem',
};

const sectionTitle: React.CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '0.95rem',
  fontWeight: 700,
  color: 'var(--text-primary)',
};

interface Props {
  userId: string;
  onSubmitted: () => void;
  initialError?: string;
}

export default function CorporateRequestForm({ userId, onSubmitted, initialError }: Props) {
  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [sector, setSector] = useState('');
  const [size, setSize] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [estimatedRides, setEstimatedRides] = useState('');
  const [hoursStart, setHoursStart] = useState('');
  const [hoursEnd, setHoursEnd] = useState('');
  const [payment, setPayment] = useState<'cash' | 'tricicoin' | 'mixed' | 'card' | ''>('');
  const [requiresInvoice, setRequiresInvoice] = useState(false);
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const canSubmit = !!name.trim() && !!contactPhone.trim() && !!sector && !!size && !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await corporateService.submitClientRequest({
        name: name.trim(),
        contact_phone: contactPhone.trim(),
        contact_email: contactEmail.trim() || undefined,
        tax_id: taxId.trim() || undefined,
        created_by: userId,
        sector,
        employees_count_range: size,
        estimated_rides_per_month: estimatedRides ? parseInt(estimatedRides, 10) : undefined,
        operating_hours_start: hoursStart.trim() || undefined,
        operating_hours_end: hoursEnd.trim() || undefined,
        preferred_payment: payment || undefined,
        requires_invoice: requiresInvoice,
        comments: comments.trim() || undefined,
      });
      onSubmitted();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const Chip = ({ selected, onClick, label }: { selected: boolean; onClick: () => void; label: string }) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.4rem 0.75rem',
        borderRadius: '0.5rem',
        border: selected ? '1.5px solid var(--primary)' : '1px solid var(--border-light)',
        background: selected ? 'var(--primary)' : 'var(--bg-card)',
        color: selected ? '#fff' : 'var(--text-secondary)',
        fontSize: '0.8rem',
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ marginTop: '1rem' }}>
      {error && (
        <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.75rem', padding: '0.85rem 1rem', marginBottom: '1rem' }}>
          <p style={{ color: '#c53030', margin: 0, fontSize: '0.88rem' }}>{error}</p>
        </div>
      )}

      <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
        Completa los datos de tu empresa para solicitar una cuenta corporativa. Te contactaremos en 1–2 días hábiles.
      </p>

      {/* Empresa */}
      <div style={cardStyle}>
        <h3 style={sectionTitle}>Empresa</h3>
        <label style={labelStyle}>Nombre comercial *</label>
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Hotel Palmares S.A." />
        <div style={{ height: '0.75rem' }} />
        <label style={labelStyle}>RUC / Tax ID</label>
        <input style={inputStyle} value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="Opcional" />

        <p style={{ ...labelStyle, marginTop: '0.85rem' }}>Sector *</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {SECTORS.map((s) => (
            <Chip key={s.id} selected={sector === s.id} onClick={() => setSector(s.id)} label={s.label} />
          ))}
        </div>

        <p style={{ ...labelStyle, marginTop: '0.85rem' }}>Tamaño (empleados) *</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {SIZE_RANGES.map((s) => (
            <Chip key={s.id} selected={size === s.id} onClick={() => setSize(s.id)} label={s.label} />
          ))}
        </div>
      </div>

      {/* Contacto */}
      <div style={cardStyle}>
        <h3 style={sectionTitle}>Contacto</h3>
        <label style={labelStyle}>Nombre del responsable</label>
        <input style={inputStyle} value={contactName} onChange={(e) => setContactName(e.target.value)} />
        <div style={{ height: '0.75rem' }} />
        <label style={labelStyle}>Teléfono *</label>
        <input style={inputStyle} type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+53 5XXXXXXX" />
        <div style={{ height: '0.75rem' }} />
        <label style={labelStyle}>Email</label>
        <input style={inputStyle} type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
      </div>

      {/* Operación */}
      <div style={cardStyle}>
        <h3 style={sectionTitle}>Operación</h3>
        <label style={labelStyle}>Viajes estimados por mes</label>
        <input style={inputStyle} type="number" value={estimatedRides} onChange={(e) => setEstimatedRides(e.target.value)} placeholder="Ej: 200" />
        <p style={{ ...labelStyle, marginTop: '0.85rem' }}>Horarios habituales (HH:MM)</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input style={{ ...inputStyle, flex: 1 }} type="time" value={hoursStart} onChange={(e) => setHoursStart(e.target.value)} />
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
          <input style={{ ...inputStyle, flex: 1 }} type="time" value={hoursEnd} onChange={(e) => setHoursEnd(e.target.value)} />
        </div>
      </div>

      {/* Pago / Facturación */}
      <div style={cardStyle}>
        <h3 style={sectionTitle}>Pago / Facturación</h3>
        <p style={labelStyle}>Método de pago preferido</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {PAYMENT_OPTIONS.map((o) => (
            <Chip key={o.id} selected={payment === o.id} onClick={() => setPayment(o.id)} label={o.label} />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setRequiresInvoice((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.85rem', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <span style={{
            width: 20, height: 20, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            border: requiresInvoice ? '2px solid var(--primary)' : '2px solid var(--border-light)',
            background: requiresInvoice ? 'var(--primary)' : 'transparent', color: '#fff', fontSize: '0.7rem',
          }}>{requiresInvoice ? '✓' : ''}</span>
          <span style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>Requiero factura mensual</span>
        </button>
      </div>

      {/* Comentarios */}
      <div style={cardStyle}>
        <h3 style={sectionTitle}>Comentarios</h3>
        <textarea
          style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          placeholder="Cualquier detalle adicional…"
          rows={4}
        />
      </div>

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={{
          width: '100%', padding: '0.8rem', background: 'var(--primary)', color: '#fff',
          border: 'none', borderRadius: '0.5rem', fontSize: '0.95rem', fontWeight: 700,
          cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.55,
        }}
      >
        {submitting ? 'Enviando…' : 'Enviar solicitud'}
      </button>
    </div>
  );
}
