# Client home redesign — "Cuban modern"

**Fecha:** 2026-04-18
**Scope:** `apps/client/app/(tabs)/index.tsx` — pantalla de inicio del pasajero.
**Pain real (reportado por usuario):** "No se siente cubano / no refleja la marca".
**Objetivo:** que el home sea **lo primero que diga TriciGo** sin necesidad del logo — personalidad, tono, jerarquía.

> Este documento es el **moodboard + dirección de diseño**. NO código. Cuando lo apruebes, se escribe un plan de implementación aparte.

---

## 1. Brand vision

Una ride-hailing app para Cuba que:

- **No se siente gringa** (no es Uber-copy, no es azul corporativo, no es minimal frío).
- **No es caricatura**: evita clichés baratos (palmeras vectorizadas, vintage cars, letra art déco).
- **Se siente cubano moderno**: la energía de La Habana al caer el sol — calor sin saturación, orgullo sin folclore, simple sin ser vacío.

**Referencias conceptuales** (no visuales directas):
- El sereno de una tarde de septiembre en el Malecón.
- La tipografía de los letreros de los cines Yara, Acapulco, Astral — geometría con carácter.
- La paleta de un atardecer cubano: naranja quemado + azul ceniza + crema.

---

## 2. Paleta expandida

Base conservada (matching brand actual):

| Token | Hex | Uso |
|---|---|---|
| `primary.orange` | `#FF4D00` | Accent principal (CTA, highlights) |
| `ink.dark` | `#0A0E1A` | Background principal (más azulado que el puro negro #111) |

Nuevos tokens propuestos:

| Token | Hex | Uso |
|---|---|---|
| `accent.warm` | `#FFB547` | Secondary accent — precios, badges, glow del CTA |
| `accent.dusk` | `#4A6278` | Azul ceniza — dividers, secondary text en dark mode |
| `surface.cream` | `#F4F0EA` | Texto en dark bg (en vez de puro blanco clínico) |
| `surface.paper` | `#FFFBF5` | Light mode background — crema tibia, NO blanco puro |

Idea clave: **los naranjas y los cálidos nunca tocan a pleno 100%** — siempre hay un overlay sutil que los "ensucia" levemente para que se sientan vividos, no sintéticos.

---

## 3. Typography system

Actual (Montserrat) es funcional pero genérica. Propuesta:

| Rol | Fuente | Uso |
|---|---|---|
| **Display** | `Bricolage Grotesque` | Headings grandes. Geométrica pero con carácter, variable weight, open source. Ya instalada en admin. |
| **Body** | `Inter` | Labels + párrafos. Neutra, excelente legibilidad. Ya usada. |
| **Mono** | `JetBrains Mono` | Precios, tiempos, datos numéricos. Da un toque "técnico/honesto" a los números. |
| **Accent (opcional)** | `Instrument Serif` | Para frases cortas tipo "¿A dónde vamos?" — italic cursivo. Le da alma sin ser caricaturesco. |

Patrón de escala:
- Display XL: 42pt, tight tracking -2%
- Display L: 28pt
- Body: 15pt, line-height 1.45
- Caption/mono: 11pt uppercase tracking +14%

---

## 4. Wireframe layout (dark mode, default)

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│  A                              EN/ES   🔔  [avatar] │   ← App bar minimal
│                                                      │
│  ◆ SALDO DISPONIBLE                                  │   ← label mono, subtle
│  ┌─────────────────────────────────────────────┐    │
│  │ $24,890  TRICICOIN              ↗ $47 USD   │    │   ← balance card
│  └─────────────────────────────────────────────┘    │       con glow sutil
│                                                      │
│                                                      │
│  ¿A dónde vamos hoy?                                 │   ← serif italic, 28pt
│  ━━━━━━━━━━━━━━━━━━━━                                │   ← divider naranja
│                                                      │
│  ┌─ 📍 Buscar dirección o lugar ─────────────┐      │   ← input oversized
│  │                                             │      │       rounded-full
│  └─────────────────────────────────────────────┘      │       focus = glow
│                                                      │
│  RECIENTES                                           │   ← mono label
│  ⊙ Aeropuerto José Martí            2h ago  →       │
│  ⊙ Centro Habana Vieja              Ayer    →       │
│                                                      │
│                                                      │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━      │
│                                                      │
│  SERVICIOS                                           │   ← mono label
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐                       │
│  │ 🛺 │ │ 🏍 │ │ 🚗 │ │ 📦 │                       │   ← iconos custom line-art
│  │tric│ │moto│ │auto│ │envío│                      │       no emoji genérico
│  └────┘ └────┘ └────┘ └────┘                       │
│                                                      │
│                                                      │
│  🎁  TU PRIMERA VIAJE GRATIS                        │   ← promo card
│      Código NUEVO20                                  │       warm accent
│                                                      │
│                                                      │
│  ═══════════════════════════════════════════         │
│  [mapa Mapbox real — al fondo, con fade]             │   ← nunca dominante
│  ═══════════════════════════════════════════         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Principios del layout:**

1. **El saludo es personalizado** (no "Hola Cliente", sino "A" inicial + nombre si lo tenemos en secundaria discreta).
2. **Balance arriba, no escondido** — la gente abre la app para ver si tiene plata.
3. **La pregunta "¿A dónde vamos?"** es la ancla emocional — serif itálica, tamaño grande, se siente humano.
4. **Input de destino grande y redondeado** (no un rectángulo genérico), con focus state que brilla naranja.
5. **Recientes inline debajo del search** (no escondido tras un botón) — velocidad para el 70% de casos repetidos.
6. **Iconos de servicios custom line-art** (no emoji, no stock) — el dibujo del triciclo es la firma visual.
7. **Mapa al fondo, con fade al borde inferior** — presente pero sin robar foco. Aparece al tap en el input de destino.
8. **Promo banner cálido** antes de secciones "muertas" para incentivar primera acción.

---

## 5. Iconografía custom (placeholder, a producir)

Los iconos de servicios deben ser **line-art mono-weight** (2px) en paleta naranja/cream. Estilo:

- `triciclo.svg` — vista 3/4, 3 ruedas visibles, líneas simples
- `moto.svg` — side view, manillar destacado
- `auto-standard.svg` — compacto, cubano (LADA-ish silueta)
- `auto-confort.svg` — sedan moderno
- `mensajeria.svg` — triciclo con caja

Producción: te paso specs a tu diseñador, o uso un set open source (Tabler, Phosphor line) como placeholder mientras llegan los custom.

---

## 6. Micro-interacciones / animations

- **Balance card**: entrada con slide-up + fade, 300ms ease-out.
- **CTA principal** (search bar focus): glow naranja pulsating (breathing) 2s cycle.
- **Iconos servicios**: hover/press = scale 0.95 + subtle color shift.
- **Recientes**: scroll horizontal con momentum, snap a cards.
- **Mapa fade**: mask gradient de alpha 0 → 0.4 en el borde top/bottom.
- **Transiciones**: cuando el usuario toca "Buscar destino", la pantalla hace un "pull up" suave donde el mapa se expande y el home se compacta arriba (no un modal abrupto).

---

## 7. Tono de copy

Todo en castellano neutro con toque cubano sutil:

- ❌ "Pedir viaje"
- ✅ "¿A dónde vamos?"

- ❌ "Error. Vuelva a intentar."
- ✅ "Se enredó la cosa. Probá de nuevo."

- ❌ "Saldo actual"
- ✅ "Tu saldo" o "Disponible"

- ❌ "Destino guardado"
- ✅ "Tu lugar"

---

## 8. Mockup visual (follow-up)

Si aprobás esta dirección, siguiente paso es **un mockup visual** — opciones:
- Yo te genero un HTML estático con la paleta + tipografía aplicada al wireframe para que veas el look real.
- Tu diseñador hace un Figma y me lo pasás como referencia.
- Vos me pasás una app cubana/latina de referencia que te guste y modelamos sobre ella.

Después del mockup aprobado, viene el plan de implementación con archivos concretos:
- Nuevos componentes en `packages/ui/`: `DisplayHeading`, `BalanceHeroCard`, `ServiceIconButton`, `PromoStrip`, `RecentPlacesList`.
- Refactor de `apps/client/app/(tabs)/index.tsx` (actualmente 3600 líneas — dividimos en sub-componentes).
- Update de `packages/theme/src/colors.ts` con los nuevos tokens.
- Update de `apps/client/tailwind.config.ts` para exponer los tokens.

---

## 9. Lo que NO cambia (por ahora)

- **Flujo funcional**: elegir pickup, destino, tipo de vehículo, confirmar viaje → queda igual.
- **Mapbox styles**: mantenemos `mapbox/light-v11` en light mode y `mapbox/navigation-night-v1` en dark.
- **Bottom sheet pattern**: seguimos usando `@gorhom/bottom-sheet` para los estados "selecting", "reviewing", "searching".

Cambiamos **cómo se ve** y **qué siente el usuario en los primeros 3 segundos**, no el flujo completo.

---

## 10. Respuestas del usuario (2026-04-18)

1. **Balance siempre visible** (no condicional al saldo).
2. **Sí, mostrar historial reciente** en el home (últimos 2-3 viajes).
3. **Logo wordmark** en top bar (no solo la inicial).
4. **Silueta cubana sí, sutil** — Malecón o Capitolio como elemento decorativo (no folclórico).
5. **Light mode default + toggle a dark mode** (ambos soportados).

### Decisiones derivadas

- **Pattern cubano**: silueta line-art del **Malecón al atardecer** como divider sutil entre secciones (línea con farola + edificios Vedado). No Capitolio (riesgo turístico). No colores de bandera (lo haría caricatura).
- **Top bar**: wordmark TriciGo compacto (altura 20px) + toggle light/dark + avatar/notificaciones.
- **Paleta light mode**:
  - `bg.paper` `#FFFBF5` (crema tibia, no blanco puro)
  - `ink.primary` `#1A1414` (casi negro, cálido)
  - `accent.orange` `#FF4D00` (sin cambio)
  - `accent.warm` `#FFB547` (sin cambio)
  - `accent.dusk` `#6B7F8F` (azul ceniza más claro para light bg)
- **Paleta dark mode** (toggle): usa los valores definidos en §2 arriba.

## 11. Mockup HTML

Archivo: `docs/mockups/client-home-v1.html` — abrir en cualquier browser para ver la propuesta renderizada en ambos modos (light/dark con toggle). Probado con la paleta + typography + layout de este doc.
