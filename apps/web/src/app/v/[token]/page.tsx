'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { partnerPlaceService } from '@tricigo/api';
import type { CouponValidation } from '@tricigo/types';

/**
 * Public coupon validation for partner businesses. No login, no account, no
 * app — validate_partner_coupon / redeem_partner_coupon are granted to `anon`
 * (00533) precisely so the person at the counter never has to sign in.
 *
 * Spanish only on purpose: the reader is a shop employee in Cuba. Cuban
 * Spanish uses tú, never voseo — "Escribe", not "Escribí".
 *
 * Built for a cheap phone on a weak connection: large type, no images, no
 * downloaded fonts, minimal payload.
 */
export default function ValidatePage() {
  // The business's secret link. Everything on this page is scoped to it: the
  // rate-limit bucket, and which coupons can be validated at all — so a coupon
  // only validates at the business that issued it. Nothing here reads a
  // request header; the per-IP version of this control was abandoned because
  // X-Forwarded-For is written by the client.
  const params = useParams<{ token: string }>();
  const token = String(params?.token ?? '');

  const [code, setCode] = useState('');
  const [result, setResult] = useState<CouponValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const check = async () => {
    setBusy(true);
    setFailed(false);
    try {
      setResult(await partnerPlaceService.validateCode(token, code.trim()));
    } catch {
      // Never fall through to a green screen: the shop would give away a
      // coffee because the network hiccuped. validateCode throws by design.
      setResult(null);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setFailed(false);
    try {
      // redeem_partner_coupon returns the real verdict, which may well NOT be
      // 'redeemed' — another counter may have spent it in the seconds since we
      // validated. Render whatever it says rather than assuming success.
      setResult(await partnerPlaceService.redeemCode(token, code.trim()));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setCode('');
    setResult(null);
    setFailed(false);
  };

  /**
   * HH:MM in Havana time. Returns '' for a missing or unparseable timestamp:
   * Intl throws RangeError on an Invalid Date, and an uncaught throw here
   * would replace a correct verdict with a blank screen at the counter.
   */
  const hhmm = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('es', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Havana',
    }).format(d);
  };

  // Both sentences degrade to a timeless variant rather than reading
  // "se canjeó a las ." when the verdict arrives without a timestamp.
  //
  // Neither one states how long a coupon lasts: coupon_ttl_minutes is set per
  // business (00531 allows 15 minutes to 7 days), so a hardcoded "dura 2
  // horas" would have TriciGo's own page contradicting the shop's actual deal.
  const usedBody = () => {
    const at = hhmm(result?.redeemed_at);
    return at
      ? `Este cupón se canjeó a las ${at}. No entregues el beneficio.`
      : 'Este cupón ya se canjeó. No entregues el beneficio.';
  };

  const expiredBody = () => {
    const at = hhmm(result?.expires_at);
    return at
      ? `Venció a las ${at}. Ya no puedes entregar el beneficio.`
      : 'Este cupón venció. Ya no puedes entregar el beneficio.';
  };

  return (
    <main
      style={{
        maxWidth: 420,
        margin: '0 auto',
        padding: '20px 16px 60px',
        fontFamily: 'system-ui, sans-serif',
        color: '#1A1414',
      }}
    >
      <div
        style={{
          background: '#1A1414',
          color: '#FFFBF5',
          borderRadius: 12,
          padding: '11px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 15 }}>TriciGo</strong>
        <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>VALIDAR CUPÓN</span>
      </div>

      {!result && (
        <>
          <h1 style={{ fontSize: 15, fontWeight: 400, color: '#4A5A66', margin: '18px 0 12px', lineHeight: 1.45 }}>
            Escribe el código que te muestra el cliente en su teléfono.
          </h1>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.trim() && !busy) void check();
            }}
            placeholder="K7M2QX"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={12}
            aria-label="Código del cupón"
            style={{
              width: '100%',
              border: '2px solid rgba(26,20,20,.14)',
              borderRadius: 13,
              padding: 14,
              textAlign: 'center',
              fontSize: 26,
              letterSpacing: 4,
              fontWeight: 700,
              boxSizing: 'border-box',
            }}
          />
          <button
            type="button"
            onClick={() => void check()}
            disabled={busy || code.trim().length === 0}
            style={{
              width: '100%',
              marginTop: 12,
              background: '#FF4D00',
              color: '#fff',
              border: 0,
              borderRadius: 13,
              padding: 14,
              fontSize: 16,
              fontWeight: 700,
              opacity: busy || !code.trim() ? 0.55 : 1,
            }}
          >
            {busy ? 'Validando…' : 'Validar'}
          </button>
          {failed && (
            <p role="alert" style={{ marginTop: 14, fontSize: 13, color: '#B3261E', textAlign: 'center' }}>
              No se pudo conectar. Revisa la señal e intenta de nuevo.
            </p>
          )}
        </>
      )}

      <div aria-live="polite">
        {result?.status === 'valid' && (
          <>
            <div
              style={{
                borderRadius: 16,
                padding: '20px 16px',
                textAlign: 'center',
                marginTop: 18,
                background: '#E8F6EC',
                border: '1px solid #9FD8B0',
              }}
            >
              <div style={{ fontSize: 40 }}>✅</div>
              <div style={{ fontWeight: 800, fontSize: 19, color: '#1B7A3D', marginTop: 6 }}>
                CUPÓN VÁLIDO
              </div>
              <div style={{ fontSize: 13, color: '#4A5A66', marginTop: 5 }}>
                Entrega el beneficio y confirma abajo.
              </div>
            </div>
            <dl style={{ marginTop: 16, fontSize: 13 }}>
              <Row k="NEGOCIO" v={result.place_name ?? '—'} />
              <Row k="BENEFICIO" v={result.benefit_title ?? '—'} accent />
              <Row k="CLIENTE" v={result.customer || '—'} />
              <Row k="LLEGÓ" v={hhmm(result.arrived_at) || '—'} />
              <Row k="VENCE" v={hhmm(result.expires_at) || '—'} />
            </dl>
            {result.terms && (
              <p style={{ fontSize: 12, color: '#6B7F8F', marginTop: 10 }}>{result.terms}</p>
            )}
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              style={{
                width: '100%',
                marginTop: 16,
                background: '#FF4D00',
                color: '#fff',
                border: 0,
                borderRadius: 13,
                padding: 14,
                fontSize: 16,
                fontWeight: 700,
                opacity: busy ? 0.55 : 1,
              }}
            >
              {busy ? 'Confirmando…' : 'Confirmar entrega'}
            </button>
            {failed && (
              <p role="alert" style={{ marginTop: 12, fontSize: 13, color: '#B3261E', textAlign: 'center' }}>
                No se pudo confirmar. El cupón sigue sin canjear — intenta de nuevo.
              </p>
            )}
            {/* Without this the employee is trapped on the valid screen: if the
                customer walks away, or the code turned out to belong to someone
                else in the queue, the only other way out is reloading the page. */}
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              style={{
                width: '100%',
                marginTop: 10,
                background: 'transparent',
                color: '#6B7F8F',
                border: '1px solid rgba(26,20,20,.14)',
                borderRadius: 13,
                padding: 13,
                fontSize: 15,
              }}
            >
              Cancelar
            </button>
          </>
        )}

        {result?.status === 'redeemed' && (
          <Verdict
            icon="🎉"
            title="CANJEADO"
            tone="ok"
            body="Listo. Entrega el beneficio al cliente."
            onReset={reset}
          />
        )}
        {result?.status === 'used' && (
          <Verdict icon="🚫" title="YA FUE USADO" tone="bad" onReset={reset} body={usedBody()} />
        )}
        {result?.status === 'expired' && (
          <Verdict icon="⌛" title="CUPÓN VENCIDO" tone="bad" onReset={reset} body={expiredBody()} />
        )}
        {result?.status === 'not_found' && (
          <Verdict
            icon="❌"
            title="CÓDIGO NO VÁLIDO"
            tone="bad"
            onReset={reset}
            // Not "son 6 caracteres": the customer's screen shows TG-K7M2QX, and
            // the server accepts it with or without that prefix.
            body="Revisa que esté bien escrito. Es el código que aparece en el teléfono del cliente."
          />
        )}
        {result?.status === 'rate_limited' && (
          <Verdict
            icon="🐢"
            title="DEMASIADOS INTENTOS"
            tone="bad"
            onReset={reset}
            body="Espera unos minutos antes de volver a intentar."
          />
        )}
        {result?.status === 'invalid_link' && (
          <Verdict
            icon="🔗"
            title="ENLACE NO VÁLIDO"
            tone="bad"
            onReset={reset}
            body="Este enlace no corresponde a ningún negocio activo. Pídele a TriciGo el enlace de tu negocio."
          />
        )}
      </div>
    </main>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '9px 0',
        borderBottom: '1px solid rgba(26,20,20,.07)',
      }}
    >
      <dt style={{ color: '#6B7F8F' }}>{k}</dt>
      <dd style={{ margin: 0, fontWeight: 600, textAlign: 'right', color: accent ? '#FF4D00' : '#1A1414' }}>
        {v}
      </dd>
    </div>
  );
}

function Verdict({
  icon,
  title,
  body,
  tone,
  onReset,
}: {
  icon: string;
  title: string;
  body: string;
  tone: 'ok' | 'bad';
  onReset: () => void;
}) {
  const ok = tone === 'ok';
  return (
    <>
      <div
        style={{
          borderRadius: 16,
          padding: '20px 16px',
          textAlign: 'center',
          marginTop: 18,
          background: ok ? '#E8F6EC' : '#FDECEC',
          border: `1px solid ${ok ? '#9FD8B0' : '#F0B4B4'}`,
        }}
      >
        <div style={{ fontSize: 40 }}>{icon}</div>
        <div style={{ fontWeight: 800, fontSize: 19, marginTop: 6, color: ok ? '#1B7A3D' : '#B3261E' }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: '#4A5A66', marginTop: 6, lineHeight: 1.45 }}>{body}</div>
      </div>
      <button
        type="button"
        onClick={onReset}
        style={{
          width: '100%',
          marginTop: 14,
          background: 'transparent',
          color: '#6B7F8F',
          border: '1px solid rgba(26,20,20,.14)',
          borderRadius: 13,
          padding: 13,
          fontSize: 15,
        }}
      >
        Validar otro código
      </button>
    </>
  );
}
