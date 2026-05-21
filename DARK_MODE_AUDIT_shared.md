# packages compartidos — Dark Mode Contrast Audit

Auditoría manual de `packages/ui` (42 componentes) + `packages/theme`. Un bug aquí se
multiplica en las 4 apps.

## Summary
- Revisado: 42 componentes (`packages/ui/src`) + tokens (`packages/theme/src`).
- FIX: 7  |  REVIEW: 6  |  el resto correcto.

## Findings

| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| `ui/Button.tsx:36` | `ghost` → `text: 'text-neutral-900'` (sin `dark:`) | 1 | **FIX** | `text-neutral-900 dark:text-neutral-100` — hoy el label del botón ghost queda invisible en modo oscuro |
| `ui/BottomSheet.tsx:33` | `className="bg-white rounded-t-2xl..."` | 1 | **FIX** | `bg-white dark:bg-neutral-900` — hoy TODA hoja BottomSheet es blanca en modo oscuro |
| `ui/BottomSheet.tsx:36` | handle `bg-neutral-300` | 1 | **FIX** | `bg-neutral-300 dark:bg-neutral-700` |
| `ui/Input.tsx:21-33` | `isDark = variant === 'dark'` — depende de un prop manual, no del tema real | estructural | **FIX** | derivar de `useColorScheme()` de nativewind; mantener `variant` como override opcional. Hoy todo `<Input>` sin `variant="dark"` queda claro sobre pantalla oscura |
| `ui/ServiceTypeCard.tsx:53` | no seleccionado → `'border-neutral-200 bg-white'` (sin `dark:`) | 1 | **FIX** | `dark:border-neutral-700 dark:bg-neutral-800` |
| `ui/TripProgressBar.tsx:24-27` | consts de módulo `#1F2937` texto / `#E5E7EB` track | 2 | **FIX** | hacer theme-aware (`useColorScheme`) — hoy texto gris oscuro + track claro fijos |
| `ui/IconButton.tsx:20` | `'bg-neutral-200 active:bg-neutral-300'` (sin `dark:`) | 1 | **FIX** | `dark:bg-neutral-700 dark:active:bg-neutral-600` |
| `ui/Text.tsx:44` | `inverse: 'text-white'` (sin `dark:`) | 1 | REVIEW | "inverse" asume superficie oscura; documentar el contrato o blindar el uso |
| `ui/Button.tsx:27` | `secondary` → `bg-neutral-900` | 1 | REVIEW | el botón se funde con un fondo oscuro (el label sigue legible, la forma no) |
| `ui/ErrorBoundary.tsx:58,62,69,74` | `bg-white` / `text-neutral-900` (sin `dark:`) | 1 | REVIEW | pantalla de crash — legible pero blanca en una app oscura; agregar `dark:` |
| `ui/Card.tsx:23-27`, `ui/StatCard.tsx:57-69`, `EmptyState`/`ErrorState`/`MenuRow` | `forceDark` con hex inline `#1a1a2e`/`#252540`/`#f5f5f5` | 2 | REVIEW | ruta opt-in; reemplazar hex por tokens (code-smell, no un flip-bug) |
| `theme/colors.ts:169` | `driverDarkColors.text.tertiary = '#666666'` ≈3.6:1 sobre `#0a0a0a` | 3 | REVIEW | paleta legacy; subir si todavía se usa para texto que deba leerse |
| `theme/midnight-ember.ts:75` | `midnightEmberScreen.text.tertiary = '#94A3B8'` ≈2.6:1 sobre `#F8FAFC` | 3 | REVIEW | tertiary = meta/placeholder; subir si se usa para texto legible |

## Notas
- `Text.tsx` `tertiary` ya está OK en `master` (`dark:text-[#8a8a8a]` ≈5.5:1, pasa AA) — NO es bug.
- Correctos, NO tocar: `Card` variantes default (`bg-white dark:bg-neutral-800` pareado), `Screen` (`white/neutral/cuban` pareados; `dark/mapDark` fijos a propósito), `Skeleton`, `RouteSummary`, `StatusStepper`, `ETABadge` (theme-aware), `Toast`/`BalanceBadge`/`StopMarker`/`Avatar` (apariencia fija intencional).
- Componentes prop-driven (`Card theme=`, `DraggableSheet theme=`, `HistoryFilters dark=`, `QuickReplyBar variant=`, `ScreenHeader light=`): no son bugs en sí — el bug sería el caller pasando el valor equivocado, eso se cataloga en las apps. `Input` es el peor del grupo porque su `variant` por defecto es `'light'`.
