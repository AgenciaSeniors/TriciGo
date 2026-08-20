// ============================================================
// qpSafeUrl — blinda URLs embebidas en correos contra el decodificador
// quoted-printable espurio de la cadena de entrega (Resend→SES).
//
// BUG VERIFICADO (E2E 2026-08-18). El HTML que entregamos a Resend estaba
// perfecto (`?token=42f8bcff…`, confirmado en el copy que Resend almacena),
// pero el correo ENTREGADO decía `?tokenBf8bcff…`: algo río abajo decodificó
// `=42` como escape quoted-printable → byte 0x42 = 'B'. Segunda víctima en el
// mismo correo: `width=device-width` llegó como `width�vice-width` (`=de` →
// 0xDE). La cadena QP-decodifica un cuerpo que nunca fue QP-codificado, y se
// come todo `=XX` donde XX sean dos hex válidos.
//
// Impacto sin este blindaje: cualquier enlace con `token=<hex>` llega roto —
// el de verificación de correo (token propio, hex puro), el magic link de
// acceso y el de reset de contraseña (hashed_token de GoTrue, hex puro).
// Los enlaces con `=pkce_`/`=ma`/`=ht` sobreviven de casualidad porque el
// segundo carácter no es hex.
//
// LA ARMADURA: percent-encodear el primer carácter cuando a un `=` le siguen
// dos hex. `?token=42f8…` → `?token=%3442f8…`. Semánticamente idéntico (el
// navegador y GoTrue URL-decodifican `%34` → '4') e inmune al QP-eater
// (`=%3` no es escape válido → lo deja pasar). Funciona igual en la parte
// HTML y en la de texto plano.
//
// Aplicar a TODA URL que viaje dentro de un correo. El bug de fondo es de
// Resend/SES (ticket con los message IDs como evidencia); esto es la defensa
// nuestra mientras tanto — y después: no depender de que lo arreglen.
// ============================================================

export function qpSafeUrl(url: string): string {
  return url.replace(
    /=([0-9a-fA-F])(?=[0-9a-fA-F])/g,
    (_m, c: string) => `=%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}
