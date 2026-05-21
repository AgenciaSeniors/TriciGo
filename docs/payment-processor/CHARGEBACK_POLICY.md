# Política de Chargebacks — TriciGo

> Procedimiento técnico de manejo de contracargos (chargebacks) de pagos con
> tarjeta. Establecido en la Fase B7 del plan de cierre de pagos.
> Entidad merchant: MACH DIGITAL TECH S.R.L.

## Contexto

Un chargeback ocurre cuando el titular de una tarjeta disputa un cargo ante su
banco. El procesador notifica al comercio, que tiene un plazo acotado para
responder con *compelling evidence* — evidencia que demuestre que la transacción
fue legítima y que el servicio se entregó.

El modelo de TriciGo facilita esta defensa: cada recarga compra créditos
closed-loop que solo se gastan en viajes dentro de la plataforma. Si el titular
recargó y luego tomó viajes, el historial de viajes **es** la prueba de la
entrega del servicio.

## Evidencia disponible

Para una recarga disputada (un `payment_intent`), el RPC
`build_chargeback_evidence(p_payment_intent_id)` arma automáticamente un bundle
JSON con:

- **Recarga:** monto, fechas, estado, id del PaymentIntent de Stripe, y la IP, el
  user-agent y el fingerprint del dispositivo desde el que se hizo la recarga
  (Fase B6).
- **Cuenta:** antigüedad de la cuenta, teléfono, estado — una cuenta con
  historial es señal de legitimidad.
- **Crédito:** la transacción del libro mayor que acreditó los créditos.
- **Servicio entregado:** los viajes que el usuario tomó después de la recarga
  (conteo, tarifa total, fechas) — la prueba central de que el titular recibió el
  servicio que pagó.

## Controles que previenen chargebacks fraudulentos

- **3DS2 / SCA obligatorio** (Fase B4): cada cobro pasa por autenticación fuerte
  del titular, lo que traslada gran parte de la responsabilidad por fraude al
  emisor de la tarjeta.
- **Velocity controls** (Fase B1): límites de frecuencia y monto por usuario.
- **Audit trail** (Fase B5): cada cambio de un `payment_intent` queda registrado.
- **Device fingerprinting** (Fase B6): IP + dispositivo de cada recarga.
- **PCI-DSS SAQ-A:** los datos de tarjeta nunca tocan los servidores de TriciGo.

## Procedimiento

1. Al recibir la notificación de chargeback del procesador, el equipo identifica
   el `payment_intent` disputado.
2. Se ejecuta `build_chargeback_evidence` para armar el bundle de evidencia.
3. Se responde al procesador dentro del plazo con la evidencia: el comprobante de
   la recarga, la autenticación 3DS, el match de IP/dispositivo y —sobre todo— el
   historial de viajes que demuestra la entrega del servicio.
4. Las recargas no consumidas se manejan según la política de `/refunds`.

## Pendiente

- **Auto-submisión al procesador:** hoy la respuesta al chargeback se arma con el
  bundle del RPC y se envía manualmente. La submisión automática requiere la API
  de disputas del procesador (se evaluará al integrar NETOPIA / EuPlătesc).
- **Surface en el panel admin:** exponer `build_chargeback_evidence` con un botón
  en el panel admin es un follow-up.

---
**Última actualización:** 2026-05-18
