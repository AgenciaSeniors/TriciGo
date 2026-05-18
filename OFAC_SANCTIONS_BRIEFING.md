# Briefing de riesgo de sanciones — material para consulta con abogado

> ## ⚠️ ESTO NO ES ASESORÍA LEGAL
> Documento informativo preparado por un asistente de IA (Claude) como **material de preparación** para una consulta con un abogado de sanciones colegiado. **No es** una opinión legal, una revisión de compliance, ni una certificación.
> - **No puede** presentarse a NETOPIA, EuPlătesc, ningún banco adquirente ni ningún regulador como "revisión legal", "dictamen" o "due diligence legal". Hacerlo sería una tergiversación.
> - El estado vigente de la ley de sanciones —incluida la **OE 14404 (mayo 2026)**, posterior a la fecha de corte de conocimiento del asistente— debe establecerlo el abogado a partir de fuentes primarias.
> - Su único uso válido es ayudarte a tener una consulta legal **corta, enfocada y bien preparada**.

---

## 1. El hecho a evaluar (resumen para el abogado)

- **Entidad merchant:** MACH DIGITAL TECH S.R.L., constituida en Rumanía en 2026 — CUI 54552055, Nr. RegCom J2026027319006, domicilio en Brașov.
- **Operación real:** plataforma de movilidad / ride-hailing que presta servicio **íntegramente en La Habana, Cuba** — conductores y pasajeros en Cuba, tarifas en CUP.
- **Modelo de pago:** personas en el exterior (EE.UU., España, México y otros) compran, con **tarjeta de crédito/débito**, créditos de viaje prepagos ("TriciCoin") que el beneficiario en Cuba consume en viajes.
- **Flujo de fondos:** tarjeta del pagador → procesador rumano (NETOPIA Payments o EuPlătesc, regulados por el BNR) → cuenta de MACH DIGITAL TECH S.R.L. en ING Rumanía → liquidación a conductores en Cuba.
- **Rieles:** las transacciones de tarjeta circulan por las redes Visa / Mastercard.

## 2. Por qué esto es sensible a sanciones (factores que el abogado examinará)

Lo siguiente son **factores de riesgo, no conclusiones** — el abogado determinará cómo aplican:

1. **El lado del pagador estadounidense.** Cuba está sujeta a sanciones integrales de EE.UU. Un titular de tarjeta que es "US person" pagando un servicio consumido en Cuba puede caer dentro o fuera de las licencias generales de la OFAC (existen licencias para ciertas categorías y la aplicabilidad depende de la categoría exacta y de quién recibe el beneficio).
2. **Las redes de tarjeta son estadounidenses.** Visa y Mastercard aplican OFAC a toda su red, sin importar dónde estén el merchant y el adquirente. Un merchant rumano no neutraliza esto.
3. **Tensión EE.UU. ↔ UE.** La UE no sanciona Cuba y tiene un Reglamento de Bloqueo (Blocking Statute) que, en ciertos casos, restringe a empresas de la UE cumplir sanciones extraterritoriales de EE.UU. Esto crea una posible contradicción legal que solo un abogado puede mapear.
4. **OE 14404 (mayo 2026).** Según indicó el cliente, introdujo sanciones secundarias sobre bancos extranjeros que faciliten ciertos flujos Cuba-asociados. De ser así, podría afectar la disposición y exposición de NETOPIA/EuPlătesc y de ING Rumanía. El abogado debe leer el texto vigente.
5. **El beneficiario del pago en Cuba.** Quién recibe finalmente los fondos (conductores y cualquier intermediario) debe cribarse contra la SDN List y la Cuba Restricted List.
6. **Caracterización del producto.** El Sprint 1 ya hizo que TriciCoin sea, en sustancia, crédito prepago closed-loop de un servicio de transporte (no transferible, no convertible a efectivo). Eso ayuda a la caracterización (no es remesa ni e-money) pero **no resuelve** la pregunta de sanciones del punto 1.

## 3. Preguntas concretas para el abogado de sanciones

Llevá esta lista a la consulta:

1. ¿La compra, por un US person con tarjeta estadounidense, de crédito de transporte consumido por un tercero en Cuba, está cubierta por alguna licencia general de la OFAC (p. ej. 31 CFR Parte 515)? ¿Bajo qué categoría exactamente?
2. ¿Cambia la respuesta si el pagador está en España o México (no-US persons) pero la transacción circula por Visa/Mastercard?
3. ¿Qué obligaciones de OFAC recaen sobre MACH DIGITAL TECH S.R.L. como merchant, dado que no es US person pero usa rieles estadounidenses?
4. ¿La OE 14404 (mayo 2026) afecta la capacidad o exposición de NETOPIA/EuPlătesc o de ING Rumanía para procesar/recibir estos fondos?
5. ¿El Reglamento de Bloqueo de la UE impone o impide algo a MACH DIGITAL TECH S.R.L. en este flujo?
6. ¿Qué nivel de screening (SDN / Cuba Restricted List) de conductores y beneficiarios finales es exigible, y con qué frecuencia?
7. ¿Cómo debe describirse el negocio en la solicitud de merchant a NETOPIA/EuPlătesc para que sea **exacta y completa** (no minimizada)?
8. ¿Existe una estructura o un procesador alternativo que sirva legalmente este flujo si el actual no es viable?

## 4. Qué cubre — y qué NO cubre — el trabajo ya hecho (Sprint 1)

**Cubre** (mejoras de exactitud del frontend, ya implementadas):
- TriciCoin reposicionado como crédito de viaje closed-loop real (sin transferencia P2P entre usuarios, sin presentación como "moneda virtual"/"billetera").
- Identidad del merchant correcta y verificable (MACH DIGITAL TECH S.R.L.).
- Cláusula closed-loop en los Términos.

**NO cubre:**
- La pregunta de sanciones de las Secciones 2 y 3 — **eso es lo que requiere al abogado**.
- La solicitud a NETOPIA/EuPlătesc **no debe presentarse** hasta tener la opinión legal.
- El backend debe deshabilitar el RPC `transfer_wallet_p2p` (pendiente del equipo backend).

## 5. Recomendación

Consultar, **antes de aplicar a cualquier procesador**, con: (a) un abogado con práctica de sanciones de EE.UU. (OFAC) y (b) un abogado rumano/UE de servicios de pago. Es una consulta acotada — esta lista de preguntas debería permitir resolverla en una o dos sesiones.

---
*Preparado: 2026-05-17 · Documento de trabajo interno · No versionado en el repositorio.*
