# admin — Dark Mode Contrast Audit

## Summary
- Files scanned: 84 `.tsx` files under `apps/admin/src`. Files with raw-palette / inline-color usage: 46. Files with FIX-verdict findings: 18.
- FIX: 168  |  KEEP: 36  |  REVIEW: 4

Scope reminder: admin uses Tailwind v4 `darkMode:'class'` plus semantic RGB tokens in `apps/admin/src/app/globals.css` (`--surface`, `--surface-elevated`, `--surface-sunken`, `--ink`, `--ink-muted`, `--ink-subtle`, `--line`, `--line-strong`), exposed via the `@tricigo/theme` preset as `bg-surface`, `bg-surface-elevated`, `bg-surface-sunken`, `text-ink`, `text-ink-muted`, `text-ink-subtle`, `border-line`, `border-line-strong`. The correct fix is to migrate raw palette classes to those tokens (they flip automatically); when a token does not fit, add a `dark:` variant.

The newer shell — `components/layout/*`, `components/ui/AdjustWalletModal`, `components/data/FilterBar`, `components/dashboard/KpiCard|PulseMap|SosAlertBanner`, `app/page.tsx`, and the recently-redesigned `funnel`, `notifications`, `quests`, `campaigns`, `fraud`, `wallet/receipts` pages — is already fully token-based and is **not** a source of findings. The bugs are concentrated in the older operational pages and detail views that never migrated off the raw `neutral`/`white` palette.

## Findings

Grouped by file. Verdict legend: FIX = unreadable / harshly mismatched in dark mode; KEEP = intentionally fixed regardless of theme; REVIEW = unsure.

### apps/admin/src/components/FleetReview.tsx  (shared component — renders inside businesses/[id])
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| FleetReview.tsx:28 | `inactive: 'bg-neutral-200 text-neutral-600'` | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| FleetReview.tsx:131 | `<h4 className="text-sm font-medium text-neutral-700 mb-2">` | 1 | FIX | `text-ink` |
| FleetReview.tsx:133 | `<p className="text-sm text-neutral-400">` | 1 | FIX | `text-ink-subtle` |
| FleetReview.tsx:137 | `<tr className="border-b text-left text-neutral-500">` | 1 | FIX | `text-ink-muted` (border is theme-default `border-b`) |
| FleetReview.tsx:150 | `<div className="text-xs text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| FleetReview.tsx:152 | `<td className="py-2 pr-2 text-neutral-600">` | 1 | FIX | `text-ink-muted` |
| FleetReview.tsx:153 | `<td className="py-2 pr-2 text-neutral-600">` | 1 | FIX | `text-ink-muted` |
| FleetReview.tsx:197 | `<div ... className="bg-white rounded-xl p-6 ...">` (modal) | 1 | FIX | `bg-surface-elevated` |
| FleetReview.tsx:208 | `<button className="px-4 py-2 text-sm bg-neutral-100 rounded-lg">` | 1 | FIX | `bg-surface-sunken text-ink` |
| FleetReview.tsx:230 | `<div className="bg-neutral-50 border rounded-lg p-3">` | 1 | FIX | `bg-surface-sunken` |
| FleetReview.tsx:232 | `<div className="font-medium text-neutral-800 mt-0.5">` | 1 | FIX | `text-ink` |
| FleetReview.tsx:231 | `<div className="text-[11px] ... text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| FleetReview.tsx:107,111 | `<p className="text-sm text-neutral-500">Cargando…</p>` (×2 loading/empty states) | 1 | FIX | `text-ink-muted` |
| FleetReview.tsx:171 | `bg-green-600 text-white` (Aprobar btn) | 1 | KEEP | white on green action button |
| FleetReview.tsx:178,214 | `bg-red-600 text-white` (Rechazar btn ×2) | 1 | KEEP | white on red action button |
| FleetReview.tsx:196 | `bg-black/50` (modal scrim) | 1 | KEEP | translucent scrim, intentional |
| FleetReview.tsx:23-27 | status badge map `bg-yellow-100 text-yellow-800` etc. | 1 | KEEP | semantic status badges |

### apps/admin/src/components/FilterPanel.tsx  (shared component)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| FilterPanel.tsx:43 | `... bg-white border border-neutral-200 hover:border-neutral-300` (toggle btn) | 1 | FIX | `bg-surface-elevated border-line hover:border-line-strong` |
| FilterPanel.tsx:58 | `<div className="mt-3 p-4 bg-white rounded-xl border border-neutral-200 shadow-sm">` | 1 | FIX | `bg-surface-elevated border-line` |
| FilterPanel.tsx:62 | `<label className="block text-xs font-medium text-neutral-500 mb-1">` | 1 | FIX | `text-ink-muted` |
| FilterPanel.tsx:70 | `<select className="... border border-neutral-200 ... bg-white ...">` | 1 | FIX | `border-line bg-surface` + add `text-ink` |
| FilterPanel.tsx:85 | `<input type="date" className="... border border-neutral-200 ... bg-white ...">` | 1 | FIX | `border-line bg-surface` + add `text-ink` |
| FilterPanel.tsx:94 | `<input type="text" className="... border border-neutral-200 ... bg-white ...">` | 1 | FIX | `border-line bg-surface` + add `text-ink` |
| FilterPanel.tsx:103 | `<div className="... border-t border-neutral-100">` | 1 | FIX | `border-line` |
| FilterPanel.tsx:130 | `<button className="text-xs text-neutral-500 hover:text-neutral-700 underline ...">` | 1 | FIX | `text-ink-muted hover:text-ink` |
| FilterPanel.tsx:50 | `bg-primary-500 text-white` (count badge) | 1 | KEEP | white on brand badge |
| FilterPanel.tsx:114 | `bg-primary-50 text-primary-700` (active filter chip) | 1 | KEEP | brand-tinted chip, paired tones |

### apps/admin/src/app/drivers/page.tsx  (hotspot)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| drivers/page.tsx:188 | `<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">` | 1 | FIX | `text-ink` |
| drivers/page.tsx:191 | `<p className="mt-1 text-sm text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:200 | `... border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300` (export btn) | 1 | FIX | `border-line bg-surface-elevated text-ink hover:bg-surface-sunken hover:border-line-strong` |
| drivers/page.tsx:211 | `<Search ... className="... text-neutral-400 ...">` | 1 | FIX | `text-ink-subtle` |
| drivers/page.tsx:217 | `... border-neutral-200 bg-white text-neutral-900 placeholder:text-neutral-400` (search input) | 1 | FIX | `border-line bg-surface text-ink placeholder:text-ink-subtle` |
| drivers/page.tsx:224,237,248,259 | `h-9 px-3 ... border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300` (4 select filters) | 1 | FIX | `border-line bg-surface text-ink hover:border-line-strong` |
| drivers/page.tsx:270 | `<button className="... text-neutral-600 hover:text-neutral-900 ...">` (clear) | 1 | FIX | `text-ink-muted hover:text-ink` |
| drivers/page.tsx:279 | `<div className="hidden md:block bg-white rounded-xl border border-neutral-200/80 ...">` | 1 | FIX | `bg-surface-elevated border-line` |
| drivers/page.tsx:283 | `<tr className="border-b border-neutral-100 bg-neutral-50/50">` | 1 | FIX | `border-line bg-surface-sunken/50` |
| drivers/page.tsx:285,288,297,305,313 | `<th className="... text-neutral-500 ...">` (table headers ×5) | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:325 | `<Users size={28} className="text-neutral-300" />` (empty icon) | 1 | FIX | `text-ink-subtle` |
| drivers/page.tsx:326 | `<p className="text-sm font-medium text-neutral-700">` (empty text) | 1 | FIX | `text-ink` |
| drivers/page.tsx:346 | `<tr className="... border-b border-neutral-50 ... hover:bg-neutral-50 ...">` | 1 | FIX | `border-line hover:bg-surface-sunken` |
| drivers/page.tsx:354 | `<div className="font-medium text-sm text-neutral-900 leading-tight">` | 1 | FIX | `text-ink` |
| drivers/page.tsx:357 | `<div className="text-xs text-neutral-500 mt-0.5">` | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:362 | `<VIcon size={16} className="text-neutral-400" />` | 1 | FIX | `text-ink-subtle` |
| drivers/page.tsx:364 | `<div className="text-sm text-neutral-700 capitalize">` | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:365 | `<div className="text-xs text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:369,392 | `<span className="text-sm text-neutral-400">—</span>` (×2) | 1 | FIX | `text-ink-subtle` |
| drivers/page.tsx:387 | `<span className="text-sm text-neutral-700 tabular-nums">` | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:395 | `<td className="px-4 text-sm text-neutral-500 tabular-nums">` | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:399 | `<ChevronRight ... className="text-neutral-300 group-hover:text-neutral-500 ...">` | 1 | FIX | `text-ink-subtle group-hover:text-ink-muted` |
| drivers/page.tsx:413 | `<div className="bg-white rounded-xl border border-neutral-200 p-4">` | 1 | FIX | `bg-surface-elevated border-line` |
| drivers/page.tsx:417 | `<div className="bg-white rounded-xl border border-neutral-200 p-8 text-center">` | 1 | FIX | `bg-surface-elevated border-line` |
| drivers/page.tsx:418 | `<Users size={28} className="text-neutral-300 mx-auto mb-2" />` | 1 | FIX | `text-ink-subtle` |
| drivers/page.tsx:419 | `<p className="text-sm font-medium text-neutral-700">` | 1 | FIX | `text-ink` |
| drivers/page.tsx:429 | `<button className="... bg-white rounded-xl border border-neutral-200 ... hover:bg-neutral-50 ...">` | 1 | FIX | `bg-surface-elevated border-line hover:bg-surface-sunken` |
| drivers/page.tsx:435 | `<div className="font-medium text-sm text-neutral-900 truncate">` | 1 | FIX | `text-ink` |
| drivers/page.tsx:438 | `<div className="text-xs text-neutral-500 truncate mt-0.5">` | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:446 | `<ChevronRight size={16} className="text-neutral-300 shrink-0" />` | 1 | FIX | `text-ink-subtle` |
| drivers/page.tsx:455,473 | `<p className="text-sm text-neutral-500 tabular-nums">` / pagination span (×2) | 1 | FIX | `text-ink-muted` |
| drivers/page.tsx:468,478 | `... border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50` (pagination btns ×2) | 1 | FIX | `border-line bg-surface-elevated text-ink hover:bg-surface-sunken` |
| drivers/page.tsx:34-38 | `STATUS_STYLES` (`text-yellow-700`, `from-green-400`, etc.) | 1 | KEEP | semantic status colours / gradient avatars |
| drivers/page.tsx:349,431 | `text-white` on `bg-gradient-to-br ${status.gradient}` avatar (×2) | 1 | KEEP | white initials on coloured avatar |
| drivers/page.tsx:378 | `bg-amber-50 text-amber-700` (on-break chip) | 1 | KEEP | semantic status chip |

### apps/admin/src/app/drivers/[id]/page.tsx  (hotspot)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| drivers/[id]/page.tsx:302 | `<div className="flex items-center gap-2 text-neutral-400">` (loading) | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:313 | `<AlertTriangle size={32} className="text-neutral-300" />` | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:314 | `<p className="text-sm text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| drivers/[id]/page.tsx:343 | `<button className="... text-neutral-500 hover:text-neutral-900 ...">` (back) | 1 | FIX | `text-ink-muted hover:text-ink` |
| drivers/[id]/page.tsx:356 | `<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">` | 1 | FIX | `text-ink` |
| drivers/[id]/page.tsx:364 | `<p className="text-sm text-neutral-500 mt-1 ...">` | 1 | FIX | `text-ink-muted` |
| drivers/[id]/page.tsx:368,372 | `<span className="text-neutral-300">·</span>` (separators ×2) | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:383 | `... border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50` (actions btn) | 1 | FIX | `border-line bg-surface-elevated text-ink hover:bg-surface-sunken` |
| drivers/[id]/page.tsx:389 | `<div className="... border border-neutral-200 bg-white shadow-lg ...">` (menu) | 1 | FIX | `border-line bg-surface-elevated` |
| drivers/[id]/page.tsx:399 | `<span className="ml-auto text-xs text-neutral-400">` | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:424 | `<div className="border-t border-neutral-100 my-1" />` | 1 | FIX | `border-line` |
| drivers/[id]/page.tsx:452,607,670,711,755,789,869 | `<section className="bg-white rounded-xl border border-neutral-200/80 p-5">` (×7) | 1 | FIX | `bg-surface-elevated border-line` |
| drivers/[id]/page.tsx:454,457,608,615-618,671,712,735,756,790,844 | `text-neutral-500` headers / meta (≈12 occurrences) | 1 | FIX | `text-ink-muted` |
| drivers/[id]/page.tsx:475 | `'border-neutral-200/80 bg-white'` (doc card default branch) | 1 | FIX | `border-line bg-surface-elevated` |
| drivers/[id]/page.tsx:481 | `<FileText size={14} className="text-neutral-400" />` | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:482,764,905 | `<p className="text-sm font-medium text-neutral-900 ...">` (×3) | 1 | FIX | `text-ink` |
| drivers/[id]/page.tsx:508 | `... bg-neutral-100 border border-neutral-200 ... hover:bg-neutral-200` (PDF preview btn) | 1 | FIX | `bg-surface-sunken border-line hover:bg-surface-sunken` |
| drivers/[id]/page.tsx:511 | `<span className="text-[10px] text-neutral-600 ...">` | 1 | FIX | `text-ink-muted` |
| drivers/[id]/page.tsx:535 | `<div className="w-full h-28 bg-neutral-100 rounded-md ...">` | 1 | FIX | `bg-surface-sunken` |
| drivers/[id]/page.tsx:536 | `<Clock size={14} className="text-neutral-400 ...">` | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:541 | `<div className="... text-[10px] text-neutral-500 mb-2">` | 1 | FIX | `text-ink-muted` |
| drivers/[id]/page.tsx:570 | `<input className="... border border-neutral-200 ...">` (doc-note input) | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| drivers/[id]/page.tsx:594 | `<div className="... bg-neutral-50 border border-dashed border-neutral-200 ...">` | 1 | FIX | `bg-surface-sunken border-line` |
| drivers/[id]/page.tsx:595 | `<FileText size={20} className="text-neutral-300 mb-1" />` | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:596 | `<span className="text-[10px] text-neutral-400">` | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:614 | `<tr className="border-b border-neutral-100">` | 1 | FIX | `border-line` |
| drivers/[id]/page.tsx:623,676 | `<tr className="border-b border-neutral-50 last:border-0 ...">` (×2) | 1 | FIX | `border-line` |
| drivers/[id]/page.tsx:624,681 | `<td className="text-sm text-neutral-700">` / score-event text (×2) | 1 | FIX | `text-ink-muted` |
| drivers/[id]/page.tsx:648,657 | `<span className="text-sm text-neutral-400">—</span>` (×2) | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:684 | `<p className="text-[10px] text-neutral-400">` | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:734,759,809,904 | `border-t/-b border-neutral-100` dividers (×4) | 1 | FIX | `border-line` |
| drivers/[id]/page.tsx:742 | `<span className="... bg-neutral-100 text-[10px] text-neutral-700">` (tag chip) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| drivers/[id]/page.tsx:745 | `<span className="text-neutral-400">{tag.count}</span>` | 1 | FIX | `text-ink-subtle` |
| drivers/[id]/page.tsx:770 | `<p className="text-xs text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| drivers/[id]/page.tsx:819 | `<div className="mt-1.5 h-1.5 w-full bg-neutral-100 rounded-full ...">` (progress track) | 1 | FIX | `bg-surface-sunken` |
| drivers/[id]/page.tsx:858,1071,1079 | `text-neutral-900` big-number / dd values (×3) | 1 | FIX | `text-ink` |
| drivers/[id]/page.tsx:861 | `<p className="text-xs text-neutral-600">` | 1 | FIX | `text-ink-muted` |
| drivers/[id]/page.tsx:896,989 | `bg-black/50` (modal scrim ×2) | 1 | KEEP | translucent scrim |
| drivers/[id]/page.tsx:903 | `<div className="bg-white rounded-xl w-full max-w-lg shadow-xl">` (modal) | 1 | FIX | `bg-surface-elevated` |
| drivers/[id]/page.tsx:936 | `<textarea className="... border border-neutral-200 ...">` | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| drivers/[id]/page.tsx:945 | `<div className="... border-t border-neutral-100 bg-neutral-50/50 ...">` (modal footer) | 1 | FIX | `border-line bg-surface-sunken/50` |
| drivers/[id]/page.tsx:948 | `<button className="... text-neutral-700 hover:bg-neutral-100 ...">` | 1 | FIX | `text-ink hover:bg-surface-sunken` |
| drivers/[id]/page.tsx:351 | `text-white` on gradient avatar | 1 | KEEP | white initials on coloured avatar |
| drivers/[id]/page.tsx:576,584 | `bg-green-600 text-white` / `bg-red-600 text-white` (verify/reject) | 1 | KEEP | white on action buttons |
| drivers/[id]/page.tsx:955,1039 | `text-white` on conditional / `bg-sky-600` action buttons | 1 | KEEP | white on action buttons |
| drivers/[id]/page.tsx:473-474,488-490,627-631 | `bg-green-100 text-green-700` etc. doc/check status badges | 1 | KEEP | semantic status badges |

### apps/admin/src/app/users/[id]/page.tsx  (hotspot)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| users/[id]/page.tsx:18 | `plata: 'bg-neutral-200 text-neutral-700'` (level badge) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| users/[id]/page.tsx:160,342,392,418 (also 86,160) | `<p className="text-neutral-400">…</p>` loading/not-found/empty (×4+) | 1 | FIX | `text-ink-subtle` |
| users/[id]/page.tsx:178,192,204 | `bg-neutral-100 text-neutral-600` / `bg-neutral-100 text-neutral-500` fallback badges | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| users/[id]/page.tsx:227,254,322,347,398 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">` (cards ×5) | 1 | FIX | `bg-surface-elevated border-line` |
| users/[id]/page.tsx:231,235,239,243,247,258,266,270,274 | `<dt className="text-sm text-neutral-500">` field labels (≈9) | 1 | FIX | `text-ink-muted` |
| users/[id]/page.tsx:284 | `<span className="... bg-neutral-100 text-xs text-neutral-600">` (tag chip) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| users/[id]/page.tsx:287 | `<span className="text-neutral-400">({tag.count})</span>` | 1 | FIX | `text-ink-subtle` |
| users/[id]/page.tsx:296 | `<div className="mt-6 pt-4 border-t border-neutral-100">` | 1 | FIX | `border-line` |
| users/[id]/page.tsx:297 | `<p className="text-sm font-semibold text-neutral-700 mb-2">` | 1 | FIX | `text-ink` |
| users/[id]/page.tsx:303 | `<select className="border border-neutral-200 ...">` | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| users/[id]/page.tsx:326,330,334 | `<div className="bg-neutral-50 rounded-lg p-4">` (wallet stat cards ×3) | 1 | FIX | `bg-surface-sunken` |
| users/[id]/page.tsx:327,331,335 | `<p className="text-xs text-neutral-500 mb-1">` (×3) | 1 | FIX | `text-ink-muted` |
| users/[id]/page.tsx:332 | `<p className="text-lg font-bold text-neutral-700">` | 1 | FIX | `text-ink` |
| users/[id]/page.tsx:353,403 | `<tr className="border-b border-neutral-100">` (table head ×2) | 1 | FIX | `border-line` |
| users/[id]/page.tsx:354-357,404-406 | `<th className="... text-neutral-500">` table headers (≈7) | 1 | FIX | `text-ink-muted` |
| users/[id]/page.tsx:364,411 | `<tr className="border-b border-neutral-50">` body rows (×2) | 1 | FIX | `border-line` |
| users/[id]/page.tsx:365,382,412,418 | `<td className="... text-neutral-600">` / `text-neutral-500` cells (×4) | 1 | FIX | `text-ink-muted` |
| users/[id]/page.tsx:449 | `<div className="fixed inset-0 bg-black/50 ...">` (modal scrim) | 1 | KEEP | translucent scrim |
| users/[id]/page.tsx:450 | `<div ... className="bg-white rounded-xl p-6 w-full max-w-md mx-4">` (modal) | 1 | FIX | `bg-surface-elevated` |
| users/[id]/page.tsx:452 | `<p className="text-sm text-neutral-600 mb-4">` | 1 | FIX | `text-ink-muted` |
| users/[id]/page.tsx:458 | `<textarea className="... border border-neutral-200 ...">` | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| users/[id]/page.tsx:464 | `<button className="... text-neutral-600 hover:bg-neutral-100 ...">` | 1 | FIX | `text-ink-muted hover:bg-surface-sunken` |
| users/[id]/page.tsx:202,209,217,312,471 | `bg-primary-500/red-500/green-500 + text-white` action buttons | 1 | KEEP | white on action buttons |
| users/[id]/page.tsx:17,19 | `bronce: 'bg-amber-100 text-amber-800'`, `oro: 'bg-yellow-100 text-yellow-800'` | 1 | KEEP | semantic level badges |
| users/[id]/page.tsx:34-37 | `roleBadgeClasses` (`bg-blue-50 text-blue-700`, etc.) | 1 | KEEP | semantic role badges |
| users/[id]/page.tsx:191,336,372-373,379,415 | green/red status & amount colours | 1 | KEEP | semantic status / +- amount colours |

### apps/admin/src/app/businesses/[id]/page.tsx  (hotspot)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| businesses/[id]/page.tsx:24 | `rejected: 'bg-neutral-200 text-neutral-600'` (status badge) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| businesses/[id]/page.tsx:138,142 | `<div className="... text-neutral-500">…loading/not-found</div>` (×2) | 1 | FIX | `text-ink-muted` |
| businesses/[id]/page.tsx:208,217,241,267,307,314,353 | `<div className="bg-white border rounded-xl p-5">` (cards ×7) | 1 | FIX | `bg-surface-elevated border-line` |
| businesses/[id]/page.tsx:209,218,242,270,308,315,354 | `<h3 className="text-sm font-medium text-neutral-500 ...">` card headers (×7) | 1 | FIX | `text-ink-muted` |
| businesses/[id]/page.tsx:211,220,233 | `<p className="text-sm text-neutral-600">` / `text-neutral-500` (×3) | 1 | FIX | `text-ink-muted` |
| businesses/[id]/page.tsx:212,213,223,271,288 | `text-neutral-500` / `text-neutral-400` meta text (≈5) | 1 | FIX | `text-ink-muted` / `text-ink-subtle` |
| businesses/[id]/page.tsx:227 | `<div className="h-2 bg-neutral-200 rounded-full overflow-hidden">` (budget track) | 1 | FIX | `bg-surface-sunken` |
| businesses/[id]/page.tsx:245,251,258 | `<span className="text-neutral-500">…policy labels</span>` (×3) | 1 | FIX | `text-ink-muted` |
| businesses/[id]/page.tsx:272 | `<span className="font-medium text-neutral-700">15%</span>` | 1 | FIX | `text-ink` |
| businesses/[id]/page.tsx:319,356 | `<p className="text-sm text-neutral-400">…empty</p>` (×2) | 1 | FIX | `text-ink-subtle` |
| businesses/[id]/page.tsx:323,360 | `<tr className="border-b text-left text-neutral-500">` (×2) | 1 | FIX | `text-ink-muted` |
| businesses/[id]/page.tsx:334,368 | `<td className="py-2 text-neutral-600">` (×2) | 1 | FIX | `text-ink-muted` |
| businesses/[id]/page.tsx:341 | `bg-neutral-200 text-neutral-500` (inactive employee badge) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| businesses/[id]/page.tsx:379,411 | `<div className="fixed inset-0 bg-black/50 ...">` (modal scrim ×2) | 1 | KEEP | translucent scrim |
| businesses/[id]/page.tsx:380,412 | `<div ... className="bg-white rounded-xl p-6 w-full max-w-md">` (modal ×2) | 1 | FIX | `bg-surface-elevated` |
| businesses/[id]/page.tsx:392,424 | `<button className="px-4 py-2 text-sm bg-neutral-100 rounded-lg">` (cancel ×2) | 1 | FIX | `bg-surface-sunken text-ink` |
| businesses/[id]/page.tsx:169,176,186,195,398,430 | `bg-green-600/red-600 text-white` action buttons | 1 | KEEP | white on action buttons |
| businesses/[id]/page.tsx:21-23 | `pending/approved/suspended` status badges | 1 | KEEP | semantic status badges |
| businesses/[id]/page.tsx:336 | `bg-purple-100 text-purple-700` / `bg-blue-50 text-blue-700` role badge | 1 | KEEP | semantic role badges |

### apps/admin/src/app/reports/page.tsx  (hotspot)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| reports/page.tsx:174 | `{ ..., color: 'text-neutral-900', ... }` (KPI desc colour) | 1 | FIX | `text-ink` |
| reports/page.tsx:407,431,497,524,557,591,625,693,697,701 | `<section/div className="bg-white rounded-xl ... border border-neutral-100">` (cards ×10) | 1 | FIX | `bg-surface-elevated border-line` |
| reports/page.tsx:408,433,498,525,558,592,626,691 | `<h2 className="text-lg font-bold text-neutral-800 ...">` section titles (×8) | 1 | FIX | `text-ink` |
| reports/page.tsx:423,461,475,579 | `<div className="... text-xs text-neutral-400">` chart axis labels (×4) | 1 | FIX | `text-ink-subtle` |
| reports/page.tsx:505,537 | `<span className="text-neutral-700 font-medium">` (bar labels ×2) | 1 | FIX | `text-ink` |
| reports/page.tsx:506,538 | `<span className="text-neutral-500">` (bar counts ×2) | 1 | FIX | `text-ink-muted` |
| reports/page.tsx:508,540 | `<div className="w-full bg-neutral-100 rounded-full h-2.5">` (bar tracks ×2) | 1 | FIX | `bg-surface-sunken` |
| reports/page.tsx:518,550,616 | `<p / td className="... text-neutral-400">` no-data text (×3) | 1 | FIX | `text-ink-subtle` |
| reports/page.tsx:596 | `<tr className="border-b border-neutral-100">` (table head) | 1 | FIX | `border-line` |
| reports/page.tsx:597-601 | `<th className="... text-neutral-500 ...">` headers (×5) | 1 | FIX | `text-ink-muted` |
| reports/page.tsx:606 | `<tr className="border-b border-neutral-50">` body rows | 1 | FIX | `border-line` |
| reports/page.tsx:607 | `<td className="py-2 text-neutral-400">{i + 1}</td>` | 1 | FIX | `text-ink-subtle` |
| reports/page.tsx:608 | `<td className="py-2 text-neutral-900 font-medium">` | 1 | FIX | `text-ink` |
| reports/page.tsx:609,610,611 | `<td className="... text-neutral-600">` (×3) | 1 | FIX | `text-ink-muted` |
| reports/page.tsx:659,666,673 | `<span className="text-neutral-600">…util labels</span>` (×3) | 1 | FIX | `text-ink-muted` |
| reports/page.tsx:679 | `<div className="pt-2 border-t border-neutral-100">` | 1 | FIX | `border-line` |
| reports/page.tsx:680,694,698,702 | `<p className="text-xs text-neutral-400">` / `text-sm text-neutral-500` (×4) | 1 | FIX | `text-ink-subtle` / `text-ink-muted` |
| reports/page.tsx:703 | `<p className="text-2xl font-bold text-neutral-900">` | 1 | FIX | `text-ink` |
| reports/page.tsx:672 | `<span className="w-3 h-3 rounded-full bg-neutral-300" />` (offline legend dot) | 1 | REVIEW | data-viz "offline" legend dot; pairs with semantic dots — consider `bg-ink-subtle` so it stays visible on dark |
| reports/page.tsx:56 | `BAR_COLORS = [... 'bg-red-400']` | 1 | KEEP | chart bar colour palette |
| reports/page.tsx:60 | `UTIL_COLORS.offline: 'bg-neutral-300'` | 1 | REVIEW | chart-bar fill for "offline" segment; on dark a light bar glows — consider `bg-ink-subtle` |

### apps/admin/src/app/settings/pricing/page.tsx  (hotspot)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| pricing/page.tsx:49 | `<span className="text-neutral-400 text-xs">…24h</span>` | 1 | FIX | `text-ink-subtle` |
| pricing/page.tsx:82,343,498 | `<div className="bg-white rounded-xl ... border border-neutral-100 ...">` (cards ×3) | 1 | FIX | `bg-surface-elevated border-line` |
| pricing/page.tsx:83 | `<h3 className="text-sm font-semibold text-neutral-700 mb-3">` | 1 | FIX | `text-ink` |
| pricing/page.tsx:87,500 | `<tr/thead className="... border-b border-neutral-100">` / `bg-neutral-50 border-b` (×2) | 1 | FIX | `border-line` / `bg-surface-sunken border-line` |
| pricing/page.tsx:88,90,502-511 | `<th className="... text-neutral-500">` matrix + table headers (≈12) | 1 | FIX | `text-ink-muted` |
| pricing/page.tsx:98,523 | `<tr className="border-b border-neutral-50 hover:bg-neutral-50">` (×2) | 1 | FIX | `border-line hover:bg-surface-sunken` |
| pricing/page.tsx:99 | `<td className="... font-semibold text-neutral-700">` | 1 | FIX | `text-ink` |
| pricing/page.tsx:107 | `<td className="... text-neutral-300">—</td>` | 1 | FIX | `text-ink-subtle` |
| pricing/page.tsx:111,598 | `<div className="text-neutral-400">…/km</div>` (×2) | 1 | FIX | `text-ink-subtle` |
| pricing/page.tsx:288,305,349,361,375,386,397,408,419,428,557,565 | `<input/select className="... border-neutral-300 ...">` form fields (≈12) | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| pricing/page.tsx:347,359,372,383,394,405,416,425,434 | `<label className="... text-neutral-600 ...">` form labels (≈9) | 1 | FIX | `text-ink-muted` |
| pricing/page.tsx:445,471,491,580,628 | `bg-neutral-100 text-neutral-500/600` (day toggles off-state, cancel btns, tab inactive) (≈5) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| pricing/page.tsx:490 | tab inactive `bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300` | 1 | FIX | `bg-surface-elevated text-ink-muted border-line hover:border-line-strong` |
| pricing/page.tsx:517,524,667 | `<td/span className="... text-neutral-400/500">` no-rules / zone / page (≈3) | 1 | FIX | `text-ink-subtle` / `text-ink-muted` |
| pricing/page.tsx:524 | `<td className="px-4 py-3 text-neutral-500">` (zone cell) | 1 | FIX | `text-ink-muted` |
| pricing/page.tsx:663,673 | `<button className="... border border-neutral-200 ...">` (pagination ×2) | 1 | FIX | `border-line` + add `text-ink` |
| pricing/page.tsx:332,445(on),465,489(active),580(on),622 | `bg-primary-500 text-white` buttons / active states | 1 | KEEP | white on brand buttons |
| pricing/page.tsx:53-56 | `TimeBandBadge` config colours (`bg-amber-100 text-amber-700`, etc.) | 1 | KEEP | semantic time-band badges |
| pricing/page.tsx:60,610 | `bg-green-100 text-green-700` active badge | 1 | KEEP | semantic status badge |

### apps/admin/src/app/settings/promotions/page.tsx  (hotspot)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| promotions/page.tsx:206,330 | `<div className="bg-white rounded-xl ... border border-neutral-100 ...">` (×2) | 1 | FIX | `bg-surface-elevated border-line` |
| promotions/page.tsx:209,219,233,247,262,273,282 | `<label className="... text-neutral-700 ...">` form labels (×7) | 1 | FIX | `text-ink-muted` |
| promotions/page.tsx:211,221,236,250,265,276,285 | `<input/select className="... border-neutral-300 ...">` form fields (≈7) | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| promotions/page.tsx:302 | cancel btn `bg-neutral-100 text-neutral-600 hover:bg-neutral-200` | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| promotions/page.tsx:321 | tab inactive `bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300` | 1 | FIX | `bg-surface-elevated text-ink-muted border-line hover:border-line-strong` |
| promotions/page.tsx:332 | `<thead className="bg-neutral-50 border-b border-neutral-100">` | 1 | FIX | `bg-surface-sunken border-line` |
| promotions/page.tsx:334-340 | `<th className="... text-neutral-500">` headers (×7) | 1 | FIX | `text-ink-muted` |
| promotions/page.tsx:346 | `<td className="... text-neutral-400">…no-data</td>` | 1 | FIX | `text-ink-subtle` |
| promotions/page.tsx:352 | `<tr className="border-b border-neutral-50 hover:bg-neutral-50">` | 1 | FIX | `border-line hover:bg-surface-sunken` |
| promotions/page.tsx:355 | `<span className="... bg-neutral-100 text-neutral-700">` (type chip) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| promotions/page.tsx:360,363 | `<td className="... text-neutral-500">` (×2) | 1 | FIX | `text-ink-muted` |
| promotions/page.tsx:402,413 | `<button className="... border border-neutral-200 ...">` (pagination ×2) | 1 | FIX | `border-line` + add `text-ink` |
| promotions/page.tsx:406 | `<span className="text-sm text-neutral-500">` (page) | 1 | FIX | `text-ink-muted` |
| promotions/page.tsx:296,321(active) | `bg-primary-500 text-white` buttons | 1 | KEEP | white on brand buttons |
| promotions/page.tsx:373 | `bg-green-100 text-green-700` / `bg-neutral-100 text-neutral-500` active toggle | 1 | REVIEW | inactive branch `bg-neutral-100 text-neutral-500` should be `bg-surface-sunken text-ink-muted`; active green branch KEEP |

### apps/admin/src/app/settings/cities/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| cities/page.tsx:138 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 ...">` | 1 | FIX | `bg-surface-elevated border-line` |
| cities/page.tsx:140 | `<thead className="bg-neutral-50 border-b border-neutral-100">` | 1 | FIX | `bg-surface-sunken border-line` |
| cities/page.tsx:142-148 | `<th className="... text-neutral-500">` headers (×7) | 1 | FIX | `text-ink-muted` |
| cities/page.tsx:154 | `<td className="... text-neutral-400">…no-cities</td>` | 1 | FIX | `text-ink-subtle` |
| cities/page.tsx:160 | `<tr className="border-b border-neutral-50 hover:bg-neutral-50">` | 1 | FIX | `border-line hover:bg-surface-sunken` |
| cities/page.tsx:166,180 | `<input className="... border border-neutral-300 ...">` (×2) | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| cities/page.tsx:171 | `<span className="font-medium text-neutral-900">` | 1 | FIX | `text-ink` |
| cities/page.tsx:174,185,188 | `<td/span className="... text-neutral-500/600">` (×3) | 1 | FIX | `text-ink-muted` |
| cities/page.tsx:189 | `<td className="... text-neutral-400 text-xs">` | 1 | FIX | `text-ink-subtle` |
| cities/page.tsx:209 | `bg-primary-500 text-white` (save btn) | 1 | KEEP | white on brand button |
| cities/page.tsx:215 | cancel btn `bg-neutral-100 text-neutral-600 hover:bg-neutral-200` | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| cities/page.tsx:197 | `bg-green-100 text-green-700` / `bg-neutral-100 text-neutral-500` active toggle | 1 | REVIEW | inactive branch should be `bg-surface-sunken text-ink-muted`; active green branch KEEP |

### apps/admin/src/app/settings/zones/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| zones/page.tsx:96 | `<p className="text-sm text-neutral-500 mb-4">` | 1 | FIX | `text-ink-muted` |
| zones/page.tsx:100 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 ...">` | 1 | FIX | `bg-surface-elevated border-line` |
| zones/page.tsx:102 | `<thead className="bg-neutral-50 border-b border-neutral-100">` | 1 | FIX | `bg-surface-sunken border-line` |
| zones/page.tsx:104-108 | `<th className="... text-neutral-500">` headers (×5) | 1 | FIX | `text-ink-muted` |
| zones/page.tsx:114 | `<td className="... text-neutral-400">…no-zones</td>` | 1 | FIX | `text-ink-subtle` |
| zones/page.tsx:120 | `<tr className="border-b border-neutral-50 hover:bg-neutral-50">` | 1 | FIX | `border-line hover:bg-surface-sunken` |
| zones/page.tsx:125,141 | `<input className="... border border-neutral-300 ...">` (×2) | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| zones/page.tsx:132 | `... ?? 'bg-neutral-100 text-neutral-700'` (zone-type badge fallback) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| zones/page.tsx:171 | `bg-primary-500 text-white` (save btn) | 1 | KEEP | white on brand button |
| zones/page.tsx:177 | cancel btn `bg-neutral-100 text-neutral-600 hover:bg-neutral-200` | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| zones/page.tsx:159 | `bg-green-100 text-green-700` / `bg-neutral-100 text-neutral-500` active toggle | 1 | REVIEW | inactive branch should be `bg-surface-sunken text-ink-muted`; active green branch KEEP |

### apps/admin/src/app/settings/service-types/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| service-types/page.tsx:88,140,163 | `<input className="... border border-neutral-300 ...">` (×3) | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| service-types/page.tsx:110 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 ...">` | 1 | FIX | `bg-surface-elevated border-line` |
| service-types/page.tsx:112 | `<thead className="bg-neutral-50 border-b border-neutral-100">` | 1 | FIX | `bg-surface-sunken border-line` |
| service-types/page.tsx:114-122 | `<th className="... text-neutral-500">` headers (×9) | 1 | FIX | `text-ink-muted` |
| service-types/page.tsx:128 | `<td className="... text-neutral-400">…no-service-types</td>` | 1 | FIX | `text-ink-subtle` |
| service-types/page.tsx:134 | `<tr className="border-b border-neutral-50 hover:bg-neutral-50">` | 1 | FIX | `border-line hover:bg-surface-sunken` |
| service-types/page.tsx:188 | `bg-primary-500 text-white` (save btn) | 1 | KEEP | white on brand button |
| service-types/page.tsx:194 | cancel btn `bg-neutral-100 text-neutral-600 hover:bg-neutral-200` | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| service-types/page.tsx:176 | `bg-green-100 text-green-700` / `bg-neutral-100 text-neutral-500` active toggle | 1 | REVIEW | inactive branch should be `bg-surface-sunken text-ink-muted`; active green branch KEEP |

### apps/admin/src/app/settings/surge-zones/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| surge-zones/page.tsx:119,182 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 ...">` (×2) | 1 | FIX | `bg-surface-elevated border-line` |
| surge-zones/page.tsx:123,132,144,153,162 | `<label className="text-sm text-neutral-500 ...">` form labels (×5) | 1 | FIX | `text-ink-muted` |
| surge-zones/page.tsx:125,135,146,156,165 | `<input className="... border border-neutral-200 ...">` form fields (×5) | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| surge-zones/page.tsx:184 | `<thead className="bg-neutral-50 border-b border-neutral-100">` | 1 | FIX | `bg-surface-sunken border-line` |
| surge-zones/page.tsx:186-191 | `<th className="... text-neutral-500">` headers (×6) | 1 | FIX | `text-ink-muted` |
| surge-zones/page.tsx:197 | `<td className="... text-neutral-400">…no-rules</td>` | 1 | FIX | `text-ink-subtle` |
| surge-zones/page.tsx:203 | `<tr className="border-b border-neutral-50 hover:bg-neutral-50">` | 1 | FIX | `border-line hover:bg-surface-sunken` |
| surge-zones/page.tsx:207 | `<td className="... text-neutral-600">` | 1 | FIX | `text-ink-muted` |
| surge-zones/page.tsx:208,209 | `<td className="... text-neutral-500 text-xs">` (×2) | 1 | FIX | `text-ink-muted` |
| surge-zones/page.tsx:111,174 | `bg-primary-500 text-white` (buttons ×2) | 1 | KEEP | white on brand buttons |
| surge-zones/page.tsx:215 | `bg-green-100 text-green-700` / `bg-neutral-100 text-neutral-500` active toggle | 1 | REVIEW | inactive branch should be `bg-surface-sunken text-ink-muted`; active green branch KEEP |

### apps/admin/src/app/settings/surge-dashboard/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| surge-dashboard/page.tsx:127,148 | `<label className="... text-neutral-500">` (auto-refresh ×2) | 1 | FIX | `text-ink-muted` |
| surge-dashboard/page.tsx:146 | `<p className="text-xs text-neutral-400 mb-4">` (last-updated) | 1 | FIX | `text-ink-subtle` |
| surge-dashboard/page.tsx:171 | `<h3 className="font-semibold text-neutral-800">` | 1 | FIX | `text-ink` |
| surge-dashboard/page.tsx:172 | `<p className="text-sm text-neutral-600 capitalize">` | 1 | FIX | `text-ink-muted` |
| surge-dashboard/page.tsx:174,195,223,250 | `<p className="text-xs text-neutral-400 ...">` meta text (×4) | 1 | FIX | `text-ink-subtle` |
| surge-dashboard/page.tsx:212 | `<div className="... bg-white rounded-lg px-3 py-2">` (prediction row) | 1 | FIX | `bg-surface-elevated` |
| surge-dashboard/page.tsx:217 | `<span className="text-sm text-neutral-600">` (day) | 1 | FIX | `text-ink-muted` |
| surge-dashboard/page.tsx:235,239,243,247 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4">` (metric cards ×4) | 1 | FIX | `bg-surface-elevated border-line` |
| surge-dashboard/page.tsx:236,240,244,248 | `<div className="text-xs font-medium text-neutral-500 mb-1">` metric labels (×4) | 1 | FIX | `text-ink-muted` |
| surge-dashboard/page.tsx:237,241,245,249 | `<div className="text-3xl font-bold text-neutral-800">` metric values (×4) | 1 | FIX | `text-ink` |
| surge-dashboard/page.tsx:260,261 | `<div className="col-span-full text-center text-neutral-400 ...">` (loading/empty ×2) | 1 | FIX | `text-ink-subtle` |
| surge-dashboard/page.tsx:285 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4">` | 1 | FIX | `bg-surface-elevated border-line` |
| surge-dashboard/page.tsx:288 | `<h3 className="font-semibold text-neutral-700">` | 1 | FIX | `text-ink` |
| surge-dashboard/page.tsx:289 | `<p className="text-sm text-neutral-400">` | 1 | FIX | `text-ink-subtle` |
| surge-dashboard/page.tsx:293 | link `bg-neutral-100 text-neutral-600 hover:bg-neutral-200` | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| surge-dashboard/page.tsx:138 | `bg-primary-500 text-white` (refresh btn) | 1 | KEEP | white on brand button |
| surge-dashboard/page.tsx:155-157 | weather card `bg-blue-50 border-blue-200` / `bg-green-50 border-green-200` | 1 | KEEP | semantic weather-status card |
| surge-dashboard/page.tsx:206 | predictions card `bg-amber-50 border-2 border-amber-200` | 1 | KEEP | semantic prediction card |

### apps/admin/src/app/settings/exchange-rate/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| exchange-rate/page.tsx:87,103 | `<p className="text-neutral-500 mb-6">` / subtitle (×2) | 1 | FIX | `text-ink-muted` |
| exchange-rate/page.tsx:90,113 | `<p className="text-neutral-400">…loading/no-rate</p>` (×2) | 1 | FIX | `text-ink-subtle` |
| exchange-rate/page.tsx:94,118,156 | `<div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 ...">` (cards ×3) | 1 | FIX | `bg-surface-elevated border-line` |
| exchange-rate/page.tsx:101 | `<div className="text-neutral-500">` (rate detail block) | 1 | FIX | `text-ink-muted` |
| exchange-rate/page.tsx:104,107 | `<p className="text-xs text-neutral-400 ...">` (×2) | 1 | FIX | `text-ink-subtle` |
| exchange-rate/page.tsx:120 | `<p className="text-sm text-neutral-500 mb-4">` | 1 | FIX | `text-ink-muted` |
| exchange-rate/page.tsx:122,133 | `<span className="text-sm text-neutral-600 ...">` (×2) | 1 | FIX | `text-ink-muted` |
| exchange-rate/page.tsx:128 | `<input className="... border border-neutral-300 ...">` | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| exchange-rate/page.tsx:159 | `<p className="text-neutral-400 text-center py-4">` (no-history) | 1 | FIX | `text-ink-subtle` |
| exchange-rate/page.tsx:164 | `<tr className="border-b border-neutral-200 ...">` (table head) | 1 | FIX | `border-line` |
| exchange-rate/page.tsx:165-168 | `<th className="... text-neutral-600">` headers (×4) | 1 | FIX | `text-ink-muted` |
| exchange-rate/page.tsx:173 | `<tr className="border-b border-neutral-100 hover:bg-neutral-50">` | 1 | FIX | `border-line hover:bg-surface-sunken` |
| exchange-rate/page.tsx:174 | `<td className="... text-neutral-700">` | 1 | FIX | `text-ink-muted` |
| exchange-rate/page.tsx:137 | `bg-primary-500 text-white` (set-rate btn) | 1 | KEEP | white on brand button |
| exchange-rate/page.tsx:180-182 | `bg-blue-100 text-blue-700` / `bg-amber-100 text-amber-700` source badge | 1 | KEEP | semantic source badges |
| exchange-rate/page.tsx:189 | `bg-green-100 text-green-700` active badge | 1 | KEEP | semantic status badge |

### apps/admin/src/app/settings/feature-flags/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| feature-flags/page.tsx:95,135,143 | `<div className="bg-white rounded-xl ... border border-neutral-100 ...">` (×3) | 1 | FIX | `bg-surface-elevated border-line` |
| feature-flags/page.tsx:98,107 | `<label className="... text-neutral-700 ...">` (×2) | 1 | FIX | `text-ink-muted` |
| feature-flags/page.tsx:100,109 | `<input className="... border border-neutral-300 ...">` (×2) | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| feature-flags/page.tsx:124 | cancel btn `bg-neutral-100 text-neutral-600 hover:bg-neutral-200` | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| feature-flags/page.tsx:133,136 | `<p className="text-neutral-400">…loading/no-flags</p>` (×2) | 1 | FIX | `text-ink-subtle` |
| feature-flags/page.tsx:146 | `<p className="font-mono text-sm font-medium text-neutral-900">` | 1 | FIX | `text-ink` |
| feature-flags/page.tsx:147 | `<p className="text-sm text-neutral-500 mt-0.5">` | 1 | FIX | `text-ink-muted` |
| feature-flags/page.tsx:159 | `<span className="... w-5 h-5 bg-white rounded-full shadow ...">` (toggle knob) | 1 | REVIEW | white knob on a coloured/grey track; reads on both themes — likely KEEP, but on dark a pure-white knob is slightly harsh; consider `bg-surface-elevated` |
| feature-flags/page.tsx:88,118 | `bg-primary-500 text-white` (buttons ×2) | 1 | KEEP | white on brand buttons |
| feature-flags/page.tsx:155 | toggle track `bg-primary-500` / `bg-neutral-300` | 1 | FIX | off-state `bg-neutral-300` → `bg-line-strong` (a light track glows on dark); on-state KEEP |

### apps/admin/src/app/settings/experiments/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| experiments/page.tsx:61 | `<p className="text-neutral-500 mb-6">` (subtitle) | 1 | FIX | `text-ink-muted` |
| experiments/page.tsx:66,69 | `<p className="text-neutral-400 ...">…loading/no-experiments</p>` (×2) | 1 | FIX | `text-ink-subtle` |
| experiments/page.tsx:68,75 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 ...">` (×2) | 1 | FIX | `bg-surface-elevated border-line` |
| experiments/page.tsx:70 | `<p className="text-sm text-neutral-300">` (create hint) | 1 | FIX | `text-ink-subtle` |
| experiments/page.tsx:79 | `<p className="text-sm text-neutral-500">` (description) | 1 | FIX | `text-ink-muted` |
| experiments/page.tsx:107 | `<p className="text-xs text-neutral-400 mt-3">` (service) | 1 | FIX | `text-ink-subtle` |
| experiments/page.tsx:27 | `draft: 'bg-neutral-100 text-neutral-600'` (status badge) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| experiments/page.tsx:88,97 | variant cards `bg-blue-50` / `bg-orange-50` + blue/orange text | 1 | KEEP | A/B variant colour-coding, paired tones |

### apps/admin/src/app/settings/platform-config/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| platform-config/page.tsx:103 | `<p className="text-neutral-500 mb-6">` (subtitle) | 1 | FIX | `text-ink-muted` |
| platform-config/page.tsx:106,109 | `<p className="text-neutral-400 ...">…loading/empty</p>` (×2) | 1 | FIX | `text-ink-subtle` |
| platform-config/page.tsx:108,120 | `<div className="bg-white rounded-xl ... border border-neutral-100 ...">` (×2) | 1 | FIX | `bg-surface-elevated border-line` |
| platform-config/page.tsx:124 | `<p className="font-semibold text-neutral-900">` | 1 | FIX | `text-ink` |
| platform-config/page.tsx:127 | `<p className="font-mono text-xs text-neutral-400 mt-0.5">` | 1 | FIX | `text-ink-subtle` |
| platform-config/page.tsx:131 | `<p className="text-sm text-neutral-500 mt-1">` | 1 | FIX | `text-ink-muted` |
| platform-config/page.tsx:141 | `<input className="... border border-neutral-300 ...">` | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| platform-config/page.tsx:153 | `bg-primary-500 text-white` (save btn) | 1 | KEEP | white on brand button |

### apps/admin/src/app/settings/automation/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| automation/page.tsx:115,126 | `<p className="text-neutral-400/500 ...">…loading/subtitle</p>` (×2) | 1 | FIX | `text-ink-subtle` / `text-ink-muted` |
| automation/page.tsx:136-140 | rule card — `enabled ? 'bg-green-50 border-green-200' : 'bg-white border-neutral-100'` | 1 | FIX | disabled branch → `bg-surface-elevated border-line`; enabled green branch KEEP |
| automation/page.tsx:144 | `<h3 className="font-bold text-lg text-neutral-900">` | 1 | FIX | `text-ink` |
| automation/page.tsx:147 | `<p className="text-sm text-neutral-500 mt-1">` | 1 | FIX | `text-ink-muted` |
| automation/page.tsx:173 | `<label className="text-sm text-neutral-600">` | 1 | FIX | `text-ink-muted` |
| automation/page.tsx:179 | `<input className="... border border-neutral-300 ...">` | 1 | FIX | `border-line` + add `bg-surface text-ink` |
| automation/page.tsx:164 | `<span className="... w-6 h-6 rounded-full bg-white shadow ...">` (toggle knob) | 1 | REVIEW | white knob on coloured/grey track; reads on both — likely KEEP, consider `bg-surface-elevated` on dark |
| automation/page.tsx:161 | toggle track `bg-green-500` / `bg-neutral-300` | 1 | FIX | off-state `bg-neutral-300` → `bg-line-strong` (light track glows on dark); on-state KEEP |
| automation/page.tsx:186 | `bg-primary-500 text-white` (save btn) | 1 | KEEP | white on brand button |
| automation/page.tsx:198,200 | `bg-green-100 text-green-700` / `bg-neutral-100 text-neutral-500` status pill + `bg-neutral-400` dot | 1 | FIX | inactive branches → `bg-surface-sunken text-ink-muted` / `bg-ink-subtle`; active green branch KEEP |

### apps/admin/src/app/live-map/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| live-map/page.tsx:107 | `<div className="... border-b border-neutral-100">` | 1 | FIX | `border-line` |
| live-map/page.tsx:143,174,194 | `<p className="text-neutral-400 ...">…loading/no-rides</p>` (×3) | 1 | FIX | `text-ink-subtle` |
| live-map/page.tsx:175,176 | `<p className="text-neutral-500/400 ...">` popup detail (×2) | 1 | FIX | `text-ink-muted` / `text-ink-subtle` |
| live-map/page.tsx:187 | `<div className="h-48 border-t border-neutral-100 ... bg-white">` (sidebar) | 1 | FIX | `border-line bg-surface-elevated` |
| live-map/page.tsx:189 | `<p className="text-xs font-semibold text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| live-map/page.tsx:200 | `<tr className="border-b border-neutral-100">` | 1 | FIX | `border-line` |
| live-map/page.tsx:201-203 | `<th className="... text-neutral-500">` headers (×3) | 1 | FIX | `text-ink-muted` |
| live-map/page.tsx:208 | `<tr className="border-b border-neutral-50 hover:bg-neutral-50">` | 1 | FIX | `border-line hover:bg-surface-sunken` |
| live-map/page.tsx:220,223 | `<td className="... text-neutral-600 ...">` (×2) | 1 | FIX | `text-ink-muted` |
| live-map/page.tsx:122-125,127,210-215 | `style={{ backgroundColor: ..., color: STATUS_COLORS[s] }}` (Class 2 inline) | 2 | KEEP | ride-status colour pills driven by the `STATUS_COLORS` data map — intentional status colours, readable on both themes |
| live-map/page.tsx:165-168 | `pathOptions={{ color: '#fff', ... }}` (Leaflet CircleMarker) | 2 | KEEP | white stroke around coloured marker on a map tile, not a themed surface |

### apps/admin/src/app/settings/live-map/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| settings/live-map/page.tsx:142 | `<p className="text-sm text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| settings/live-map/page.tsx:148 | `<label className="... text-sm text-neutral-500">` | 1 | FIX | `text-ink-muted` |
| settings/live-map/page.tsx:169 | `<div className="... rounded-full bg-neutral-100">` (vehicle-type chip) | 1 | FIX | `bg-surface-sunken` |
| settings/live-map/page.tsx:175 | `<span className="text-sm text-neutral-500">{count}</span>` | 1 | FIX | `text-ink-muted` |
| settings/live-map/page.tsx:159 | `bg-primary-500 text-white` (refresh btn) | 1 | KEEP | white on brand button |
| settings/live-map/page.tsx:36-43,172 | inline-`style` Mapbox marker (`background:${color}`, `border:3px solid white`, `color:white`) + chip dot `style={{ background: VEHICLE_COLORS[type] }}` | 2 | KEEP | map markers rendered over Mapbox tiles, driven by `VEHICLE_COLORS` data map — not themed surfaces |

### apps/admin/src/app/rides/[id]/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| rides/[id]/page.tsx:78,86 | `<p className="text-neutral-400">…loading/not-found</p>` (×2) | 1 | FIX | `text-ink-subtle` |
| rides/[id]/page.tsx:101 | `STATUS_BADGE[ride.status] ?? 'bg-neutral-100 text-neutral-700'` (fallback badge) | 1 | FIX | `bg-surface-sunken text-ink-muted` |
| rides/[id]/page.tsx:108 | `<p className="text-sm text-neutral-400 line-through">` | 1 | FIX | `text-ink-subtle` |
| rides/[id]/page.tsx:115,154,175,203,225 | `<div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">` (cards ×5) | 1 | FIX | `bg-surface-elevated border-line` |
| rides/[id]/page.tsx:119,123,128,138,147,158,164,179,183,187,191,229,235,241,247,253,259 | `<dt/p className="text-sm text-neutral-500">` field labels (≈17) | 1 | FIX | `text-ink-muted` |
| rides/[id]/page.tsx:214,217,261 | `<span className="text-xs text-neutral-400">` transition meta (×3) | 1 | FIX | `text-ink-subtle` |
| rides/[id]/page.tsx:13-22 | `STATUS_BADGE` map (`bg-yellow-100 text-yellow-700`, etc.) | 1 | KEEP | semantic ride-status badges |
| rides/[id]/page.tsx:196 | `text-green-600` discount note | 1 | KEEP | semantic positive colour |

### apps/admin/src/app/not-found.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| not-found.tsx:6 | `<h1 className="text-6xl font-extrabold text-neutral-900">404</h1>` | 1 | FIX | `text-ink` |
| not-found.tsx:7 | `<p className="mt-4 text-lg text-neutral-600">Pagina no encontrada</p>` | 1 | FIX | `text-ink-muted` |
| not-found.tsx:10 | `<Link className="... bg-neutral-900 text-white ... hover:bg-neutral-800 ...">` | 1 | FIX | use `bg-ink text-surface hover:bg-ink/90` (inverse-on-surface), or pair `dark:bg-neutral-100 dark:text-neutral-900` |

### apps/admin/src/app/global-error.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| global-error.tsx:21 | `style={{ ..., color: '#171717' }}` (Error heading) | 2 | REVIEW | Renders inside its own `<html>`, outside the app theme; the `<body>` sets no background so it inherits browser default (white) → `#171717` is readable. Hard to theme reliably. If a fix is wanted, add `@media (prefers-color-scheme: dark)` styles or set explicit light bg + dark text. |
| global-error.tsx:22 | `style={{ ..., color: '#525252' }}` (body text) | 2 | REVIEW | Same as above. |
| global-error.tsx:25 | `style={{ ..., background: '#171717', color: 'white' }}` (retry button) | 2 | KEEP | dark button with white text — self-consistent regardless of theme |

### apps/admin/src/app/login/page.tsx · forgot-password/page.tsx · reset-password/page.tsx (the 3 auth screens)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| login/page.tsx:61, forgot-password:41, reset-password:110 | `<div className="min-h-screen bg-neutral-950 ...">` | 1 | KEEP | auth screen is intentionally always-dark by design (standalone, no admin shell, no theme toggle) |
| login:74,134, forgot-password:54,70, reset-password:123,136 | `bg-neutral-900` / `bg-neutral-800` cards & inputs | 1 | KEEP | consistently dark surfaces inside the always-dark auth screen |
| login:85,100,118,134, forgot-password:56,71,88,100, reset-password:137,155,171,193 | `text-white` / `bg-neutral-800 border-neutral-700 text-white` inputs & buttons | 1 | KEEP | white text on the always-dark auth surfaces — contrast is correct |
| login:70,76,91,125,126, forgot-password:50,59,74,79, reset-password:119,125,140,145,161,179 | `text-neutral-300` / `text-neutral-400` / `text-neutral-500` labels & helper text | 1 | KEEP | light-grey text on the always-dark auth surfaces — contrast is correct |
| login:118,134, forgot-password:100, reset-password:193 | `bg-primary-500 text-white` submit buttons | 1 | KEEP | white on brand button |

## Hotspot files

Ranked by FIX count:

1. **apps/admin/src/app/drivers/[id]/page.tsx** — ~46 FIX. Entire driver-detail view (7 white card `<section>`s, every label/meta, doc cards, tables, modal) uses raw `neutral`/`white` with no `dark:`. The single biggest offender.
2. **apps/admin/src/app/settings/pricing/page.tsx** — ~43 FIX. Pricing matrix card, create form (~12 inputs), tabs, table, pagination.
3. **apps/admin/src/app/reports/page.tsx** — ~33 FIX. 10 white card sections, all section titles, chart axis labels, bar tracks, tables.
4. **apps/admin/src/app/users/[id]/page.tsx** — ~30 FIX. 5 white cards, all `<dt>` field labels, wallet stat cards, two tables, block modal.
5. **apps/admin/src/app/businesses/[id]/page.tsx** — ~28 FIX. 7 white `border` cards, all card headers, two tables, two modals.
6. **apps/admin/src/app/drivers/page.tsx** — ~28 FIX. Page header, search/filter bar (5 white inputs/selects), desktop table, mobile cards, pagination.
7. **apps/admin/src/app/settings/promotions/page.tsx** — ~22 FIX. Create form, tabs, table, pagination.
8. **apps/admin/src/app/settings/surge-dashboard/page.tsx** — ~24 FIX. 4 metric cards + the surge-zones-link card, prediction rows, all labels/values.

**Shared-component offenders (a bug here repeats on every page that uses it):**
- **apps/admin/src/components/FleetReview.tsx** — 13 FIX. Renders inside `businesses/[id]` for fleet-owner accounts: status-badge map, table, reject modal, the `Meta` sub-component card.
- **apps/admin/src/components/FilterPanel.tsx** — 8 FIX. A reusable filter panel (white toggle button, white expanded panel, 3 white form inputs, divider, clear link). Any page importing it inherits all 8.

The `components/ui/*` shared primitives (`AdminConfirmModal`, `AdminEmptyState`, `AdminTableSkeleton`, `SortableHeader`, `AdminBreadcrumb`) all **already pair every raw class with a `dark:` variant** — they are correct and are NOT offenders. Likewise `components/layout/*`, `components/data/FilterBar`, and `components/dashboard/*` are fully token-based.

## Notes

Systemic patterns observed:

1. **Two generations of code.** The admin shell and recently-redesigned pages (`page.tsx` dashboard, `funnel`, `notifications`, `quests`, `campaigns`, `fraud`, `pois`, `wallet/receipts`, all `components/layout`, `components/ui`, `components/data`, `components/dashboard`) are fully migrated to semantic tokens (`bg-surface*`, `text-ink*`, `border-line`) and flip correctly. The older operational pages — every `settings/*` page, all three detail pages (`drivers/[id]`, `users/[id]`, `businesses/[id]`, `rides/[id]`), the two `live-map` pages, `drivers`, `reports`, `not-found` — were written against the raw `neutral`/`white` palette and never migrated. All 168 FIX findings live in that older set.

2. **The single dominant bug is the white card.** `bg-white rounded-xl ... border border-neutral-100/200` (or `... shadow-sm border border-neutral-100`) appears ~55 times across the old pages. In dark mode the card stays bright white and glows against the dark `--surface-sunken` body — the most visually jarring failure. Canonical fix: `bg-surface-elevated border-line`, which is exactly what the existing `.admin-card` component primitive in `globals.css` already does — several pages could simply adopt `className="admin-card"`.

3. **Body text invisibility.** `text-neutral-500`/`-600`/`-700`/`-800`/`-900` for headings, labels, table cells, and `<dt>` elements is the second pattern (~90 occurrences). On a dark surface this dark text is unreadable. Maps cleanly: `900/800 → text-ink`, `700/600/500 → text-ink-muted`, `400/300 → text-ink-subtle`.

4. **Form inputs are doubly broken.** Old-page `<input>`/`<select>`/`<textarea>` use `border-neutral-200/300` and sometimes `bg-white` but almost never set a text colour — so in dark mode the input has a light border, possibly a white fill, and inherits dark body text that is invisible if the fill flips. Fix needs both `border-line bg-surface` AND an explicit `text-ink` (the token-based inputs in `AdjustWalletModal`/`FilterBar` show the correct pattern).

5. **Toggle/switch tracks.** `automation` and `feature-flags` build custom switches with an off-state track of `bg-neutral-300` and a knob of `bg-white`. On dark, a `bg-neutral-300` track is a light-grey bar that glows; `bg-line-strong` is the themed equivalent. The white knob is borderline (REVIEW) — readable on both, but `bg-surface-elevated` would be cleaner.

6. **Correctly-KEPT cases are consistent.** Brand-orange buttons with `text-white`, semantic status badges (`bg-green-100 text-green-700` and family), gradient avatars with white initials, and `bg-black/NN` modal scrims are all intentionally theme-independent and were excluded. The three auth screens (`login`, `forgot-password`, `reset-password`) are a deliberate always-dark standalone layout (`bg-neutral-950` page, no theme toggle, no admin shell) and are KEEP in full — their dark surfaces + light text are internally consistent.

7. **Inline-style hex (Class 2) is rare and mostly legitimate.** Only `live-map`, `settings/live-map`, and `global-error` use inline color/background. The two `live-map` files drive colours from data maps (`STATUS_COLORS`, `VEHICLE_COLORS`) for map markers/pills — intentional and theme-independent (KEEP). `global-error.tsx` is the one genuinely awkward case (REVIEW): it renders its own `<html>` outside the app's CSS-var theming, so it can't use the tokens; it's readable today only because the `<body>` inherits the browser-default white background.

8. **A `dark:`-variant-or-token migration, file by file, is the remedy.** Because the offenders are concentrated and the token names map 1:1 onto the raw classes, the fix is mechanical. Migrating `FleetReview.tsx` and `FilterPanel.tsx` first gives the widest blast-radius win per change.
