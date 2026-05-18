# TriciGo — Modelo de Negocio (Contexto para Claude Code)

> **Propósito de este documento**: Establecer la fuente única de verdad sobre QUÉ ES TriciGo, para que cualquier instancia de Claude Code (u otra herramienta de IA) que trabaje en este repositorio razone correctamente sobre el modelo de negocio, el flujo de fondos, y las implicaciones de compliance.
>
> Lee este documento al inicio de cada sesión antes de tomar cualquier decisión sobre lenguaje, copy, T&C, integración de pagos, o documentación regulatoria.

---

## 1. Resumen en una línea

**TriciGo es un marketplace de software que conecta pasajeros con conductores de transporte informal en Cuba. NO es una empresa de remesas, NO es un servicio de transferencia de dinero, NO es e-money.**

El modelo es estructuralmente equivalente a Uber 2014-2017 en mercados con pago en efectivo, o a Airbnb en general: la plataforma conecta a dos personas privadas que transaccionan entre sí, y la plataforma se monetiza vendiendo créditos de acceso a la plataforma misma.

---

## 2. Identidad legal

- **Razón social**: MACH DIGITAL TECH S.R.L.
- **Jurisdicción**: Rumanía
- **Tipo de entidad**: Societate cu Răspundere Limitată (equivalente a LLC)
- **"TriciGo"**: nombre comercial / marca de producto de MACH DIGITAL TECH
- **Statement descriptor** (cómo aparece en el extracto del pagador): por definir, propuesta inicial: `MACH DIGITAL MOBILITY` o `TRICIGO MOBILITY RO`

Cuando se redactan documentos legales o se aplica a procesadores de pago, la entidad contractante es **MACH DIGITAL TECH S.R.L.**, no "TriciGo SRL" (que no existe como entidad legal).

---

## 3. Los dos lados del marketplace

### Lado A — Pasajeros (demanda de transporte)

- Personas en Cuba que necesitan transporte urbano (tricitaxis, motos, autos informales).
- Acceden a la plataforma vía app móvil o web.
- Para usar la plataforma necesitan **créditos prepagos llamados TriciCoin**.
- Los créditos los pueden adquirir:
  - **Personalmente** (si tienen tarjeta extranjera o algún otro medio)
  - **Recibirlos de familia/amigos en el exterior** que los compran en nombre del pasajero (USA, España, México, EU, etc.)
- Una vez que tienen TriciCoin, lo usan para pagar viajes en la plataforma.

### Lado B — Conductores (oferta de transporte)

- Trabajadores **independientes** en Cuba con sus propios vehículos (tricitaxis, motos, autos).
- **NO son empleados ni contratistas de TriciGo.** Son empresarios individuales que usan la plataforma para conseguir clientes.
- Para operar en la plataforma necesitan tener un **saldo prepago de comisiones** (TriciCoin del lado del conductor): un crédito interno **no retirable, no reembolsable y no convertible a dinero**, que solo sirve para pagar comisiones de plataforma.
- Cada viaje completado les descuenta automáticamente una comisión de plataforma de ese saldo.
- Los conductores recargan su saldo de múltiples maneras (ver Sección 5).

---

## 4. Flujo de fondos (CRÍTICO para compliance)

### El único flujo que TriciGo procesa:

```
Pagador (cualquier país) → Tarjeta → Procesador rumano → Cuenta bancaria de MACH DIGITAL TECH S.R.L. (Rumanía)
                                                                                                            ↓
                                                                                          (los fondos se quedan en Rumanía)
```

**Lo que ese dinero financia:**
- Servidores e infraestructura técnica (Supabase, hosting)
- Salarios y operaciones en la UE
- Impuestos rumanos (CIT 16%, dividendos, etc.)
- Marketing y desarrollo del producto
- Reservas operativas

### Lo que TriciGo NO hace:

- ❌ TriciGo NO envía dinero a Cuba.
- ❌ TriciGo NO le paga a los conductores en efectivo en Cuba.
- ❌ TriciGo NO transfiere fondos a operadores cubanos.
- ❌ TriciGo NO acredita saldos en Cubacel, ETECSA, ni redes bancarias cubanas.
- ❌ TriciGo NO procesa el pago del pasajero al conductor.

### La transacción entre pasajero y conductor:

Cuando un pasajero toma un viaje, paga al conductor por uno de dos canales:

**Canal A — Efectivo (mayoritario en Cuba)**
- El pasajero le da al conductor billetes (CUP, USD, MLC, lo que sea).
- Es una transacción **100% entre dos personas privadas dentro de Cuba**.
- TriciGo no procesa ese dinero, no lo toca, no lo registra como flujo propio.
- TriciGo solo registra que el viaje ocurrió y descuenta la comisión correspondiente del saldo prepago del conductor.

**Canal B — TriciCoin (cuando el pasajero tiene saldo cargado)**
- El pasajero usa su TriciCoin. Su saldo baja.
- Una porción de ese TriciCoin se transfiere al saldo del conductor (que el conductor puede usar para sus próximas comisiones).
- Otra porción es la comisión de plataforma, que se queda como ingreso de TriciGo.
- **Esto sigue siendo movimiento de créditos dentro del sistema, no movimiento de dinero hacia Cuba.**

---

## 5. ¿Qué es TriciCoin exactamente?

### Definición formal:

**TriciCoin es un crédito prepago digital, closed-loop, denominado en unidades internas de TriciGo, canjeable exclusivamente por servicios de la plataforma TriciGo.**

### Propiedades obligatorias (NO se pueden romper):

- ✅ **Closed-loop**: solo se puede usar dentro de la plataforma TriciGo.
- ✅ **Prepago**: el usuario compra el crédito por adelantado.
- ✅ **No reembolsable**: una vez comprado, no se devuelve a tarjeta ni a efectivo.
- ✅ **No transferible a terceros fuera del sistema**: no se puede mandar TriciCoin a otra app, a otro servicio, a una cuenta bancaria, a una billetera externa.
- ✅ **No convertible a efectivo**: ni el pasajero ni el conductor pueden retirar TriciCoin como dinero.
- ✅ **No es moneda**, no es e-money, no es criptomoneda, no es valor mobiliario.

### Por qué importa esta clasificación:

Bajo la Directiva UE 2009/110/EC (e-Money Directive), un instrumento NO es e-money cuando es **closed-loop**: solo se acepta por el emisor mismo, no por terceros, y no se puede reembolsar como dinero. Esto es la misma estructura que tiene una **tarjeta Starbucks**, un **crédito de Spotify**, un **gift card de Amazon**, o los créditos prepagos de **Uber Cash en algunos mercados**.

Bajo esta estructura, MACH DIGITAL TECH **NO necesita licencia EMI** (Electronic Money Institution) del Banco Nacional de Rumanía, y opera como una SRL comercial estándar emitiendo créditos para su propio servicio.

### Implicación operativa para el código y el copy:

- **NUNCA** llamar a TriciCoin "wallet", "billetera", "monedero", "moneda", "crypto", "token".
- **SIEMPRE** llamarlo "crédito", "credit", "credit balance", "saldo de viajes", "trip credits".
- **NUNCA** mostrar TriciCoin como balance en USD o EUR como si fuera dinero. Mostrar como "X créditos" o "saldo de TriciCoin".
- **NUNCA** ofrecer "retirar saldo", "transferir saldo a otro usuario fuera del sistema", "convertir saldo a dinero".

---

## 6. Cómo recargan los conductores su saldo

Esta es una pregunta abierta con múltiples respuestas válidas, todas compatibles con el modelo closed-loop:

1. **Recarga vía familiar en el exterior**: mismo flujo que los pasajeros. La familia/conocido del conductor en USA/EU/MX compra TriciCoin con tarjeta y se lo asigna al conductor.
2. **Acumulación por viajes pagados con TriciCoin**: cuando un pasajero paga con TriciCoin, una porción va al saldo del conductor.
3. **Bonos promocionales de TriciGo**: la plataforma puede regalar saldo inicial a conductores nuevos (onboarding) o por hitos (5 viajes, 50 viajes, etc.).
4. **Recarga propia del conductor**: si el conductor tiene acceso a una tarjeta internacional, puede recargar él mismo.

Lo que importa para compliance: **ninguno de estos métodos implica que TriciGo mueva dinero hacia Cuba**. Todos son transacciones de tarjeta hacia la cuenta rumana de MACH DIGITAL TECH, o transferencias internas de créditos dentro del sistema.

---

## 7. ¿Por qué TriciGo NO es una empresa de remesas?

Esta es la distinción regulatoria más importante y la fuente de la mayoría de los malentendidos previos.

### Una empresa de remesas (ej. Western Union, Hablalo Remesas, Cubamax) hace esto:

1. Recibe dinero del remitente en país A.
2. **Entrega dinero (en efectivo o crédito bancario) al beneficiario en país B.**
3. Su producto es el servicio de mover valor de A a B.
4. MCC asociado: 6051 (quasi-cash), 4829 (money transfer).
5. Requiere licencia de Money Transfer Operator o Payment Institution.
6. Sujeta a regulación AML específica de remesas, reporte FinCEN/ONPCSB, etc.

### TriciGo NO hace eso:

1. Recibe dinero del pagador (en Rumanía).
2. **NO entrega dinero a nadie en Cuba.** Ni efectivo, ni crédito bancario, ni saldo móvil, ni nada que sea convertible a dinero local cubano.
3. Lo que entrega al beneficiario en Cuba es **acceso a un servicio de software** (créditos para usar la plataforma de movilidad).
4. MCC asociado: 4121 (Taxicabs/Limousines) o 4789 (Transportation Services NEC).
5. Como SaaS/marketplace, no requiere licencia de payment institution.
6. Sujeta a regulación AML estándar de e-commerce + sanciones EU.

### Analogías reales para entender:

- **Spotify Premium gift card comprada para alguien en Cuba**: no es remesa, es servicio de software.
- **Suscripción a Netflix pagada por alguien en USA para un familiar en Cuba**: no es remesa, es servicio.
- **Uber Cash recargado por un familiar para alguien que está en otro país**: no es remesa, es crédito de plataforma.
- **Airbnb experiences pagadas por una persona para otra en un país sancionado**: no es remesa, es servicio.

TriciGo es estructuralmente equivalente a estos casos. **Nuestro producto es el software/plataforma, no la transferencia de valor.**

---

## 8. Implicaciones de compliance derivadas del modelo

### Sanciones OFAC / Cuba:

- TriciGo NO transfiere fondos a Cuba → no hay flujo financiero sujeto a sanciones de remesa.
- Bajo 31 CFR 515.578, los servicios de internet, comunicaciones y software a Cuba están explícitamente **exentos** del embargo. TriciGo califica como servicio de información/software.
- La Cuba Restricted List (entidades militares/seguridad cubanas) sigue aplicando: TriciGo debe asegurarse de que ningún conductor o pasajero esté en esa lista (SDN screening).

### Sanciones EU:

- La UE no sanciona a Cuba como país. TriciGo opera dentro del marco normal de comercio internacional UE.
- AMLD5/AMLD6 aplican: necesidad de KYC del pagador a partir de cierto umbral, screening contra listas EU/UN, programa AML interno.

### Reglas Visa/Mastercard:

- Aplican a todo procesador del mundo.
- Prohíben transacciones que beneficien a entidades sancionadas específicas.
- TriciGo cumple haciendo SDN screening de conductores y procedimientos AML estándar.

### Romania / BNR:

- Como SRL emitiendo créditos closed-loop para su propio servicio, MACH DIGITAL TECH no necesita licencia EMI ni Payment Institution.
- Sujeta a Ley 129/2019 (AML rumana), Reglamento ONPCSB, GDPR / ANSPDCP.

---

## 9. Lenguaje permitido y prohibido en el repo

### ✅ Lenguaje correcto:

- "Marketplace de movilidad"
- "Plataforma de transporte"
- "Créditos prepagos de viaje" / "trip credits"
- "Conductores independientes" / "independent operators"
- "Comisión de plataforma"
- "Saldo de viajes"
- "Acceso a la plataforma"
- "Conectamos pasajeros con conductores"

### ❌ Lenguaje prohibido (gatilla MCC incorrecto o asunciones regulatorias erróneas):

- "Remesa" / "remittance"
- "Envío de dinero" / "money transfer"
- "Transferencia internacional"
- "Wallet" / "Billetera" / "Monedero" (para TriciCoin)
- "Moneda" / "Currency" / "Crypto" (para TriciCoin)
- "Retirar saldo" / "Cashout"
- "Pagar a tu familia en Cuba" / "Send money to your family"

### ⚠️ Lenguaje que sí se puede usar pero con cuidado:

- "Cuba", "La Habana", nombres de ciudades cubanas → permitidos. TriciGo opera abiertamente en Cuba.
- "Familia" → permitido en marketing emocional, pero enmarcar como "permite el viaje de tu familia", NO como "envía dinero a tu familia".

---

## 10. Cómo Claude Code debe razonar usando este documento

Cuando recibas una tarea relacionada con TriciGo:

1. **Releé las secciones 4 y 5** antes de modificar cualquier flujo de pagos, lenguaje de copy, o política legal.
2. **Si una tarea te parece presentar TriciGo como remesa o servicio financiero, alertá al usuario** y propone reformulación.
3. **Si una tarea te pide afirmar controles compliance que no existen aún en el código, pedí confirmación** sobre si esos controles están implementados o son planeados.
4. **Si una tarea menciona TriciCoin como wallet/dinero/moneda, alertá**: probable inconsistencia con el modelo closed-loop.
5. **Si una tarea implica mover dinero desde TriciGo hacia Cuba, alertá**: probable inconsistencia con el modelo marketplace.

Este documento es la **fuente de verdad** del modelo de negocio. Si encontrás contradicciones entre este documento y otros archivos del repo (T&C, /refunds, copy del sitio), **este documento prevalece** y los demás deben actualizarse.

---

## 11. Estado actual de implementación de controles (honesto, sin maquillar)

> Sección a mantener actualizada por el equipo. Refleja lo que existe HOY, no lo que se planea.

| Control | Estado | Notas |
|---|---|---|
| 3DS2 en checkout | ⬜ No implementado | Fase B4 — lo provee el procesador rumano; falta hacerlo explícito y no evitable |
| KYC pagador >€100/mes | ⬜ No implementado | Fase B2 — proveedor por definir (Sumsub / Veriff / Onfido) |
| SDN screening de conductores | ⬜ No implementado | Fase B3 — existe el procedimiento documentado (`docs/SANCTIONS_SCREENING_PROCEDURE.md`); falta el código |
| Velocity controls | ⬜ No implementado | Fase B1 — hoy solo hay rate-limiting por IP; falta el control por usuario |
| AML policy escrita | 🟡 Parcial | Cláusula AML / uso aceptable añadida a los Términos (Sprint 2); falta la página `/aml` dedicada (Fase C1) |
| T&C con cláusula closed-loop | ✅ Hecho | Sprint 1/2 — cláusula "Naturaleza de los créditos TriciCoin" en los Términos |
| Footer con datos de MACH DIGITAL TECH | ✅ Hecho | Sprint 1 — razón social, CUI, RegCom, domicilio RO |
| Página /about | ✅ Hecho | Sprint 1 — datos corporativos de MACH DIGITAL TECH S.R.L. |
| Página /contact | ✅ Hecho | Sprint 2 — creada; falta el teléfono real (Fase C4) |
| Política GDPR | ✅ Hecho | Sprint 2 — base legal Art. 6 GDPR, ANSPDCP, encargados del tratamiento |
| Statement descriptor declarado | ✅ Hecho | Sprint 2 — "TRICIGO MOBILITY RO" en Términos y pantalla de recarga |

**Cambio de modelo (2026-05-18):** se ELIMINÓ del código el sistema de cashout/redención del conductor (`wallet_redemptions` + `approve_redemption` + auto-aprobación) — migración `00273_remove_driver_cashout.sql`. El TriciCoin del conductor deja de ser convertible a dinero: ahora es crédito de comisión closed-loop.

**Cambio de modelo (2026-05-18):** se eliminó del backend la transferencia de TriciCoin entre usuarios — migración `00274_remove_p2p_transfer.sql` revoca el RPC `transfer_wallet_p2p` y el helper `find_user_by_phone` (la UI ya se había quitado en el Sprint 1). TriciCoin ya no es transferible entre usuarios por ningún camino.

**Nota (2026-05-18):** las cláusulas legales del Sprint 2 (closed-loop, AML, GDPR, statement descriptor) viven en el bundle i18n; el contenido live de `/terms` y `/privacy` se sirve desde la tabla `cms_content`. La migración `00275_sync_legal_cms_content.sql` sincroniza ese contenido. Las tres migraciones (`00273`, `00274`, `00275`) quedan escritas en el repo; aplicarlas a producción es paso del pipeline de deploy.

**Última actualización**: 2026-05-18

---

## 12. Documentos relacionados

- `AUDIT_PAYMENT_APPROVAL.md` — auditoría del repo contra requisitos de procesador (generar con prompt de auditoría)
- `docs/payment-processor/` — paquete de documentación para onboarding
- `tricigo_roadmap_procesador.md` — roadmap completo de aprobación con prompts

---

**Fin del documento**

> Si algo en este documento contradice la realidad operativa de TriciGo, **es este documento el que debe corregirse**, no la realidad. Las modificaciones a este archivo son una decisión del fundador y deben quedar registradas en el historial de git con un commit message explicando el cambio de modelo.
