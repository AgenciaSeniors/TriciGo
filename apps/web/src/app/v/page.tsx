/**
 * Bare /v — reached by someone who trimmed their business's link, or by an
 * employee who was simply told "entra a tricigo.com/v".
 *
 * Deliberately has NO code field. A bare /v carries no business identity, so a
 * validator here could neither scope a coupon to the shop that issued it nor
 * key the rate limiter on anything but something the caller sends — which is
 * exactly the forgeable design this feature already rejected. An explainer
 * that ends in "ask us for your link" is the honest answer.
 *
 * Server component on purpose: no state, no effects, nothing to hydrate. The
 * reader is on a cheap phone on a weak connection.
 */
export default function ValidationHelpPage() {
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

      <h1 style={{ fontSize: 21, fontWeight: 800, margin: '22px 0 10px', lineHeight: 1.25 }}>
        Cada negocio tiene su propio enlace
      </h1>

      <p style={{ fontSize: 15, color: '#4A5A66', lineHeight: 1.55, margin: '0 0 14px' }}>
        Para validar los cupones de tus clientes necesitas el enlace de tu negocio. Se ve así:
      </p>

      <div
        style={{
          background: '#F4F6F7',
          border: '1px solid rgba(26,20,20,.10)',
          borderRadius: 12,
          padding: '13px 14px',
          fontSize: 15,
          fontWeight: 700,
          textAlign: 'center',
          wordBreak: 'break-all',
        }}
      >
        tricigo.com/v/<span style={{ color: '#FF4D00' }}>tu-enlace</span>
      </div>

      <p style={{ fontSize: 15, color: '#4A5A66', lineHeight: 1.55, margin: '16px 0 0' }}>
        Guárdalo en el teléfono del mostrador para tenerlo a mano. Esta página, sin tu enlace, no
        puede validar códigos.
      </p>

      <p style={{ fontSize: 15, color: '#4A5A66', lineHeight: 1.55, margin: '14px 0 0' }}>
        ¿No lo tienes? Escríbenos a{' '}
        <a href="mailto:soporte@tricigo.com" style={{ color: '#FF4D00', fontWeight: 700 }}>
          soporte@tricigo.com
        </a>{' '}
        y te lo enviamos.
      </p>
    </main>
  );
}
