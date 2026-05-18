# Procedimiento de screening de sanciones — conductores

> Procedimiento operativo de compliance. Cubre el Paso 2.7 del `REMEDIATION_PLAN.md`.
> Estado: **procedimiento documentado; el mecanismo automatizado está pendiente de build (equipo backend).**

## 1. Propósito

Las reglas globales de Visa y Mastercard prohíben procesar transacciones que beneficien a personas o entidades en la **OFAC SDN List** o la **Cuba Restricted List**. Para evitar que un conductor sancionado reciba pagos a través de la plataforma, TriciGo criba a cada conductor contra esas listas.

Este control aplica con independencia de que el merchant sea rumano: las redes de tarjeta son estadounidenses y aplican OFAC a toda la red.

## 2. A quién se criba

- **Conductores**, en el momento de la aprobación de sus documentos (onboarding).
- Cualquier **persona o empresa que reciba pagos/payouts** a través de la plataforma.

## 3. Cuándo

- **En el onboarding:** antes de activar la cuenta del conductor (al aprobar sus documentos).
- **Re-screening periódico:** sugerido trimestral, y además cada vez que la OFAC actualice las listas.

## 4. Qué se compara

- Nombre legal completo del conductor (y nombre comercial, si opera bajo uno).
- Contra: OFAC SDN List + Cuba Restricted List (fuentes primarias de la OFAC).

## 5. Cómo (mecanismo — pendiente de build)

El mecanismo automatizado **aún no está construido**. Opciones evaluadas (ver `REMEDIATION_PLAN.md` §2.7): lista descargable de la OFAC + chequeo programático, o API de screening de terceros. La elección y el umbral de coincidencia (matching exacto vs. fuzzy) deben confirmarse con la asesoría legal de sanciones — ver `OFAC_SANCTIONS_BRIEFING.md`.

Mientras tanto, el chequeo se realiza de forma **manual** en la revisión de documentos del conductor.

## 6. Ante una posible coincidencia

1. **Retener** la aprobación del conductor — la cuenta NO se activa.
2. Escalar a un revisor de compliance para verificar si la coincidencia es real (homonimia vs. coincidencia confirmada).
3. Si se confirma: rechazar el onboarding y documentar el caso.
4. Si es un falso positivo: documentar la verificación y continuar.

## 7. Registro

Cada screening se registra (conductor, fecha, listas consultadas, resultado, revisor) y se conserva para el expediente de underwriting del procesador.

## 8. Pendiente

- **[BUILD — backend]** Construir el mecanismo automatizado de screening y re-screening.
- **[REVISIÓN LEGAL]** Confirmar con el abogado de sanciones qué listas exactas y qué umbral de matching son exigibles, y la frecuencia de re-screening.
- Designar a la persona responsable del control.

---
*Preparado: 2026-05-17 · Documento de trabajo de compliance.*
