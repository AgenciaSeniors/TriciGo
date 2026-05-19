# web — Dark Mode Contrast Audit

## Summary
- Files scanned: 57 .tsx files under `apps/web/src` + `apps/web/src/app/globals.css`. Files with findings: 24.
- FIX: 56  |  KEEP: 71  |  REVIEW: 17
- web has **no Tailwind** — `bg-white` / `text-gray-*` etc. in `className` are 100% inert (Class 1 dead-code findings, counted under FIX as misleading code that must be removed/replaced).
- Dark mode flips via `[data-theme="dark"]` on `<html>`; correct colors come from `var(--text-*)`, `var(--bg-*)`, `var(--border*)`. Hardcoded literals (Class 2) never flip.

## Findings

### apps/web/src/app/globals.css
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| globals.css:797 | `.booking-fare-details { color: #666; }` | 2 | FIX | `color: var(--text-secondary)` — fare-detail text invisible-ish on dark bg. |
| globals.css:1221 | `.booking-cta-fixed { background: white; }` | 2 | KEEP | Has explicit dark override at line 203 (`[data-theme="dark"] .booking-cta-fixed { background: var(--bg-card) }`). |
| globals.css:216,218 | `[data-theme="dark"] .btn-store { background:#f5f5f5; color:#111 } / :hover{background:#ddd}` | 2 | KEEP | Intentional: dark-mode store button is a deliberately light pill. |
| globals.css:283,498,629,649,665 | `.btn-primary-solid/.step-number/.btn-primary color:#fff`, `.btn-store background:#111`, `.btn-store--white background:#fff;color:#111` | 2 | KEEP | White text on permanent brand/orange surfaces or fixed store-badge styling. |
| globals.css:313 | `.modal-overlay { background: rgba(0,0,0,0.5); }` | 2 | KEEP | Scrim — intentionally dark in both themes. |
| globals.css:1315 | `.wallet-balance-card::after { background: rgba(255,255,255,0.08); }` | 2 | KEEP | Decorative gloss on permanent gradient card. |
| globals.css:1464,1469 | `.header-glass background: rgba(255,255,255,0.85)` + `[data-theme="dark"]` override `rgba(13,13,26,0.85)` | 2 | KEEP | Dark override present. |

### apps/web/src/app/global-error.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| global-error.tsx:34 | `<p style={{ color: '#666' }}>` | 2 | REVIEW | Top-level `global-error` renders its own `<html>`/`<body>` with no theme attr/CSS vars loaded — vars unavailable here. Light-gray on default white body; acceptable as a hard fallback, but unreadable if the OS/browser forces dark. Consider an explicit `background:#fff` on body or a media-query fallback. |
| global-error.tsx:40,41 | `background:'#FF4D00'`, `color:'white'` | 2 | KEEP | Brand-orange button, white text — fixed by design. |

### apps/web/src/app/book/error.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| book/error.tsx:33 | `<p style={{ color: '#666' }}>` | 2 | FIX | This route renders inside the themed app shell — vars available. `color: var(--text-secondary)`. |
| book/error.tsx:40,41 | `background:'#FF4D00'`, `color:'white'` | 2 | KEEP | Brand-orange CTA, white text. |
| book/error.tsx:56,57 | `color:'#FF4D00'`, `border:'2px solid #FF4D00'` | 2 | KEEP | Brand-orange outline button — intentional. |

### apps/web/src/app/privacy/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| privacy/page.tsx:36 | `<p style={{ color: '#999' }}>` loading text | 2 | FIX | `color: var(--text-tertiary)`. |
| privacy/page.tsx:48 | `<div style={{ color: '#444' }}>` CMS body | 2 | FIX | `color: var(--text-secondary)` — long body text, dark-gray on dark = unreadable. |
| privacy/page.tsx:61 | `<p style={{ color: '#999' }}>` last-updated | 2 | FIX | `color: var(--text-tertiary)`. |
| privacy/page.tsx:128 | `<div style={{ color: '#444' }}>` Section body | 2 | FIX | `color: var(--text-secondary)`. |

### apps/web/src/app/terms/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| terms/page.tsx:36 | `<p style={{ color: '#999' }}>` loading text | 2 | FIX | `color: var(--text-tertiary)`. |
| terms/page.tsx:49 | `<div style={{ color: '#444' }}>` CMS body | 2 | FIX | `color: var(--text-secondary)`. |
| terms/page.tsx:63 | `<p style={{ color: '#999' }}>` last-updated | 2 | FIX | `color: var(--text-tertiary)`. |
| terms/page.tsx:128 | `<div style={{ color: '#444' }}>` Section body | 2 | FIX | `color: var(--text-secondary)`. |

### apps/web/src/app/blog/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| blog/page.tsx:23 | `<p style={{ color: '#888' }}>` subtitle | 2 | FIX | `color: var(--text-secondary)`. |
| blog/page.tsx:25 | `<p style={{ color: '#888' }}>` loading | 2 | FIX | `color: var(--text-secondary)`. |
| blog/page.tsx:27 | `<p style={{ color: '#888' }}>` no-posts | 2 | FIX | `color: var(--text-secondary)`. |
| blog/page.tsx:34 | `<article style={{ border: '1px solid #eee' }}>` | 2 | FIX | `border: 1px solid var(--border-light)` — near-invisible card edge on dark. |
| blog/page.tsx:50 | `<p style={{ color: '#666' }}>` excerpt | 2 | FIX | `color: var(--text-secondary)`. |
| blog/page.tsx:54 | `<time style={{ color: '#aaa' }}>` date | 2 | FIX | `color: var(--text-tertiary)`. |

### apps/web/src/app/blog/[slug]/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| blog/[slug]/page.tsx:34 | `<p style={{ color: '#888' }}>` loading | 2 | FIX | `color: var(--text-secondary)`. |
| blog/[slug]/page.tsx:42 | `<p style={{ color: '#888' }}>` not-found | 2 | FIX | `color: var(--text-secondary)`. |
| blog/[slug]/page.tsx:76 | `<p style={{ color: '#aaa' }}>` date | 2 | FIX | `color: var(--text-tertiary)`. |
| blog/[slug]/page.tsx:86 | `<div style={{ color: '#333' }}>` article body | 2 | FIX | `color: var(--text-primary)` — full article body, dark-on-dark = unreadable. |

### apps/web/src/app/notifications/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| notifications/page.tsx:26,34,42,52 | SVG `stroke="#38a169" / #d69e2e / #e53e3e / #718096"` (status icons) | 2 | KEEP | Semantic status icon colors (success/warning/error/neutral). The neutral `#718096` is borderline but reads on both themes. |
| notifications/page.tsx:266 | unread-count badge `color:'#fff'` on `var(--primary)` | 2 | KEEP | White on orange badge. |
| notifications/page.tsx:329 | error box `background:'#fef2f2'` | 2 | FIX | Pale-pink error panel never flips; on dark `#0d0d1a` it is a glaring light block. Use `background: rgba(239,68,68,0.12)` (matches the dark-aware pattern already used for `.ride-status-badge--canceled`). |
| notifications/page.tsx:334 | error text `color:'#e53e3e'` | 2 | REVIEW | Semantic red; on the pink box it works, but if box bg is fixed see above. Red text on dark bg is acceptable — keep color, fix the box. |
| notifications/page.tsx:309 | chip `color: filter===option ? 'white' : 'var(--text-primary)'` | 2 | KEEP | White only on the selected `var(--primary)` chip. |

### apps/web/src/app/HomeClient.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| HomeClient.tsx:261 | testimonial avatar `background:'var(--gradient-primary)', color:'#fff'` | 2 | KEEP | White initials on permanent gradient avatar. |

### apps/web/src/app/book/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| book/page.tsx:30 | offline/fallback box `background:'#1a1a2e'` | 2 | REVIEW | `#1a1a2e` equals the dark-theme `--bg-card`; in light mode this is a dark slab. Likely a map-shell placeholder meant to look dark always — verify; if it should match the page use `var(--bg-card)`. |
| book/page.tsx:730 | loading wrapper `color:'#999'` | 2 | FIX | `color: var(--text-tertiary)`. |
| book/page.tsx:732 | `Trici<span style={{color:'#00C853'}}>Go</span>` | 2 | KEEP | Brand wordmark green — fixed brand color. |
| book/page.tsx:807 | `onMouseOver` sets `style.color = '#fff'` on `var(--primary)` bg | 2 | KEEP | White text on orange hover state. |
| book/page.tsx:898,899 | saved-pickup pill `background:'#f0fdf4'`, `border:'1px solid #86efac'` | 2 | FIX | Pale-green pill never flips. Use `background: rgba(34,197,94,0.12)` + `border-color: rgba(34,197,94,0.3)`. |
| book/page.tsx:928,929 | saved-dropoff pill `background:'#fef2f2'`, `border:'1px solid #fca5a5'` | 2 | FIX | Pale-red pill never flips. Use `background: rgba(239,68,68,0.12)` + matching border. |
| book/page.tsx:961,962 | waypoint pill `background:'#fffbeb'`, `border:'1px solid #fcd34d'` | 2 | FIX | Pale-amber pill never flips. Use `background: rgba(245,158,11,0.12)` + matching border. |
| book/page.tsx:975 | waypoint dot `background:'#f59e0b'` | 2 | KEEP | Semantic amber marker dot. |
| book/page.tsx:1128 | savings span `color:'#16a34a'` | 2 | KEEP | Semantic green (savings). |
| book/page.tsx:1228,1236 | input border `'2px solid #ef4444'` (invalid state) | 2 | KEEP | Semantic error border. |
| book/page.tsx:1238,1665 | error span `color:'#ef4444'` / promo result `'#22c55e':'#ef4444'` | 2 | KEEP | Semantic error/success text. |
| book/page.tsx:1301 | toggle track `background: client_accompanies ? 'var(--primary)' : '#ccc'` | 2 | FIX | Off-state `#ccc` invisible-ish on dark. Use `var(--border)`. |
| book/page.tsx:1305 | toggle knob `background:'white'` | 2 | KEEP | Knob stays white in both themes (standard switch). |
| book/page.tsx:1373 | discounted price `color:'#22c55e'` | 2 | KEEP | Semantic green price. |
| book/page.tsx:1401,1402 | promo-applied tag `color:'white'`, `background:'var(--primary)'` | 2 | KEEP | White on orange tag. |
| book/page.tsx:1420 | hint `<p style={{ color:'#bbb' }}>` | 2 | FIX | `color: var(--text-tertiary)`. |
| book/page.tsx:1438,1456,1472,1511,1532,1558 | corporate/payment selected bg `'#FFF5F0'` | 2 | FIX | Pale-orange selected-state never flips → washed-out light block on dark. Use `var(--primary-alpha-10)`. |
| book/page.tsx:1569 | mixed-payment slider box `background:'#f9fafb'` | 2 | FIX | Pale-gray panel never flips. Use `var(--bg-light)` or `var(--bg-hover)`. |
| book/page.tsx:1570 | slider label `color:'#6b7280'` | 2 | FIX | `color: var(--text-secondary)`. |
| book/page.tsx:1588 | slider helper `<p style={{ color:'#374151' }}>` | 2 | FIX | `color: var(--text-secondary)` (dark-gray, unreadable on dark). |
| book/page.tsx:1621 | promo input border `'2px solid #22c55e'/'#ef4444'` | 2 | KEEP | Semantic success/error border. |
| book/page.tsx:1652,1684,1716 | button disabled bg `'#ccc'` (else `var(--primary)`) | 2 | REVIEW | Disabled `#ccc` is light-gray; on dark it stands out brighter than the page. Prefer `var(--border)` for the disabled state. |
| book/page.tsx:1653,1685,1717 | button `color:'white'` | 2 | KEEP | White on orange CTA. |

### apps/web/src/app/book/BookingMap.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| BookingMap.tsx:53,92 | injected marker CSS `background:#22c55e / #3b82f6; border:3px solid white` | 2 | KEEP | Map marker glyphs — fixed colors over the map raster, theme-independent. |
| BookingMap.tsx:147,148 | map error box `background:'#1a1a2e'`, `color:'#fff'` | 2 | REVIEW | The whole BookingMap UI is deliberately styled as a permanent dark map chrome (instruction banner, address bar, location button all use `#1a1a2e`/`#e5e5e5`). Consistent within the component; not a contrast bug, but it ignores light theme by design. Flag for product decision only. |
| BookingMap.tsx:166-173,177 | `POI_COLORS` map + `'#78909C'` fallback | 2 | KEEP | Category marker colors over the map. |
| BookingMap.tsx:341 | cluster `'circle-color'` step `#51bbd6/#f1f075/#f28cb1` | 2 | KEEP | Mapbox cluster paint — map layer. |
| BookingMap.tsx:359,424 | cluster/POI `'text-color':'#333' / '#444'` | 2 | REVIEW | Mapbox symbol label color. Dark on a light map is fine; if dark basemap is ever used these vanish. Map-styling concern, low priority. |
| BookingMap.tsx:846,847,908,922,1041,1099 | pin/confirm `'#22c55e' / '#ef4444' / '#FF4D00'` | 2 | KEEP | Pickup-green / dropoff-red / brand-orange pin & CTA — fixed semantic + brand. |
| BookingMap.tsx:859,863,1066,1075,1121,1128,1149,1172 | dark map-chrome surfaces `#1a1a2e` / `rgba(26,26,46,*)` + text `#e5e5e5` | 2 | KEEP | Permanent dark map overlay — internally consistent (see :147 REVIEW note). |
| BookingMap.tsx:909,915,1042,1100 | pin border / inner dot / CTA text `'white'` | 2 | KEEP | White detailing on colored pins / orange CTA. |
| BookingMap.tsx:938 | pin shadow `background:'rgba(0,0,0,0.3)'` | 2 | KEEP | Shadow — theme-independent. |
| BookingMap.tsx:962,978,990,1010 | "Ir aquí" POI card `background:'#fff'`, text `#1a1a2e` / `#888` | 2 | FIX | This floating card is NOT part of the dark chrome — it is a white popover with dark text. It never flips, so it stays a white card on the dark app. Use `var(--bg-card)` / `var(--text-primary)` / `var(--text-tertiary)`. |
| BookingMap.tsx:1135,1184 | geo dot `background:'#3b82f6'` | 2 | KEEP | Location indicator dot. |
| BookingMap.tsx:1154 | route-loading text `color:'#FF4D00'` | 2 | KEEP | Brand-orange on the dark map overlay. |
| BookingMap.tsx:1171 | location button `border:'1px solid #333'` | 2 | KEEP | Part of dark map chrome. |
| BookingMap.tsx:1176 | location button text `color: done ? '#555' : '#e5e5e5'` | 2 | KEEP | Dark map chrome (disabled `#555` on `#1a1a2e`). |
| BookingMap.tsx:1191,1195,1202 | nearby-count `'#22c55e'`, error `'#ef4444'` | 2 | KEEP | Semantic success/error. |

### apps/web/src/app/track/TrackingMap.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| TrackingMap.tsx:86 | star SVG `stroke="white"` | 2 | KEEP | Marker glyph over map. |
| TrackingMap.tsx:492-494 | numbered waypoint marker `background:#FF4D00 / white`, text `#FF4D00` | 2 | KEEP | Map marker — fixed brand color. |
| TrackingMap.tsx:546,547 | map placeholder `background:'#f0f0f0'`, `color:'#888'` | 2 | FIX | Loading placeholder for the map box; `#f0f0f0` is a light-gray slab on dark. Use `var(--bg-light)` / `var(--text-tertiary)`. |
| TrackingMap.tsx:566 | vehicle dot CSS `background:#00C853;border:2px solid #fff` | 2 | KEEP | Map marker glyph. |

### apps/web/src/app/track/[id]/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| track/[id]/page.tsx:16 | map placeholder `background:'#f0f0f0'` | 2 | FIX | Light-gray slab on dark. Use `var(--bg-light)`. |
| track/[id]/page.tsx:17 | placeholder text `color:'#999'` | 2 | FIX | `color: var(--text-tertiary)`. |
| track/[id]/page.tsx:39 | star SVG `fill/stroke '#F59E0B' / '#d1d5db'` | 2 | KEEP | Rating star — semantic amber + neutral empty. |
| track/[id]/page.tsx:286 | `Trici<span style={{color:'#00C853'}}>Go</span>` | 2 | KEEP | Brand wordmark. |
| track/[id]/page.tsx:288 | loading text `color:'#999'` | 2 | FIX | `color: var(--text-tertiary)`. |
| track/[id]/page.tsx:356 | live-status pill `background:'rgba(0,0,0,0.7)', color:'#fff'` | 2 | KEEP | Dark overlay pill on top of the map. |
| track/[id]/page.tsx:433 | rating star `color: star<=rating ? '#F59E0B' : '#D1D5DB'` | 2 | KEEP | Semantic amber + neutral empty star. |
| track/[id]/page.tsx:469,470 | submit-rating button `background:'var(--primary,#00C853)', color:'#fff'` | 2 | KEEP | White on brand button. |
| track/[id]/page.tsx:710,711 | SOS button `background:'#dc2626', color:'white'` | 2 | KEEP | Semantic red emergency button, white text. |
| track/[id]/page.tsx:756 | toast `background:'#16a34a', color:'white'` | 2 | KEEP | Semantic green confirmation toast. |

### apps/web/src/app/wallet/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| wallet/page.tsx:539 | quick-amount chip `color: selected ? '#fff' : 'var(--text-secondary)'` | 2 | KEEP | White only on the selected `var(--primary)` chip. |
| wallet/page.tsx:574,623,727 | recharge/transfer error `color:'#dc2626'` | 2 | KEEP | Semantic error text. |
| wallet/page.tsx:667 | transfer button `color: disabled ? 'var(--text-tertiary)' : '#fff'` | 2 | KEEP | White on enabled brand button. |
| wallet/page.tsx:677 | transfer-recipient pill `background:'#f0fdf4', border:'1px solid #86efac'` | 2 | FIX | Pale-green pill never flips. Use `background: rgba(34,197,94,0.12)` + matching border. |
| wallet/page.tsx:726 | transfer success `color:'#16a34a'` | 2 | KEEP | Semantic green. |
| wallet/page.tsx:747 | filter tab `color: filter===tab.key ? 'white' : 'var(--text-secondary)'` | 2 | KEEP | White on selected tab. |
| wallet/page.tsx:800 | tx amount `color: amount>0 ? '#16a34a' : '#dc2626'` | 2 | KEEP | Semantic credit/debit colors. |

### apps/web/src/app/rides/[id]/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| rides/[id]/page.tsx:13-20 | `STATUS_CONFIG` — `bg:'#fef3c7'/'#dbeafe'/'#dcfce7'/'#fee2e2'` paired with `color:'#d97706'/'#2563eb'/'#16a34a'/'#dc2626'` | 2 | REVIEW | Status badge = pale-tint bg + dark-tint text. Works in light mode; in dark the pale bg never flips so the badge is a bright light chip on `#0d0d1a`. Text stays legible *on the chip*, but the chip clashes. Recommend the dark-aware pattern from globals.css (`rgba(...,0.12)` bg + semantic-var text), as `.ride-status-badge--*` already does. |
| rides/[id]/page.tsx:131 | error `<p style={{ color:'#dc2626' }}>` | 2 | KEEP | Semantic error text. |
| rides/[id]/page.tsx:136 | retry button `background:'var(--primary)', color:'white'` | 2 | KEEP | White on brand button. |
| rides/[id]/page.tsx:147 | fallback `statusInfo` `bg:'#f3f4f6'` | 2 | FIX | Default-status chip bg `#f3f4f6` is a light-gray slab on dark (text already uses `var(--text-secondary)`). Use `var(--bg-hover)`. |
| rides/[id]/page.tsx:312,313 | dynamic-fare `<span style={{ color:'#d97706' }}>` | 2 | KEEP | Semantic amber (surge) text. |

### apps/web/src/app/rides/[id]/dispute/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| dispute/page.tsx:124 | toast `background:'var(--success,#16a34a)', color:'white'` | 2 | KEEP | Semantic green toast. |
| dispute/page.tsx:172 | error banner `background:'#fee2e2', color:'#dc2626'` | 2 | FIX | Pale-red banner bg never flips → light block on dark. Use `background: rgba(239,68,68,0.12)`; keep `color: var(--error)`. |
| dispute/page.tsx:263 | evidence remove-btn `background:'#fff'` | 2 | FIX | White circular delete button over a thumbnail; never flips. Use `var(--bg-card)`. |
| dispute/page.tsx:266 | remove-btn `color:'#dc2626'` | 2 | KEEP | Semantic red "✕". |
| dispute/page.tsx:308 | submit button `color: valid ? 'white' : 'var(--text-tertiary)'` | 2 | KEEP | White on enabled brand button. |

### apps/web/src/app/rides/[id]/lost-item/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| lost-item/page.tsx:119 | toast `background:'var(--success,#16a34a)', color:'white'` | 2 | KEEP | Semantic green toast. |
| lost-item/page.tsx:155 | error banner `background:'#fee2e2', color:'#dc2626'` | 2 | FIX | Pale-red banner never flips. Use `background: rgba(239,68,68,0.12)`; keep `color: var(--error)`. |
| lost-item/page.tsx:243 | submit button `color: valid ? 'white' : 'var(--text-tertiary)'` | 2 | KEEP | White on enabled brand button. |

### apps/web/src/app/profile/safety/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| safety/page.tsx:69,73 | SOS info card `background:'#fef2f2'`, `border:'1px solid #fecaca'` | 2 | FIX | Pale-pink card never flips → glaring light block on dark. Use `background: rgba(239,68,68,0.10)` + `border-color: rgba(239,68,68,0.3)`. |
| safety/page.tsx:80 | SOS icon circle `background:'#e53e3e'` | 2 | KEEP | Semantic red icon badge. |
| safety/page.tsx:86 | SVG `stroke="#fff"` | 2 | KEEP | White glyph on red badge. |
| safety/page.tsx:92 | heading `color:'#c53030'` | 2 | REVIEW | Dark-red heading; on the pink card it works, on dark `#0d0d1a` it is low-contrast. If the card bg is fixed (above), switch to `var(--error)` which is lighter (`#ef4444`) and reads on dark. |
| safety/page.tsx:94 | body `color:'#744210'` | 2 | FIX | Dark-brown body text — unreadable on dark. Use `var(--text-secondary)`. |
| safety/page.tsx:144 | "configure" button `background:'var(--primary)', color:'#fff'` | 2 | KEEP | White on brand button. |
| safety/page.tsx:200,203 | tips card `background:'#f0fdf4'`, `border:'1px solid #bbf7d0'` | 2 | FIX | Pale-green card never flips. Use `background: rgba(34,197,94,0.10)` + matching border. |
| safety/page.tsx:205 | tips heading `color:'#166534'` | 2 | REVIEW | Dark-green heading; low contrast on dark `#0d0d1a`. If card bg fixed (above), use `var(--success)`. |

### apps/web/src/app/profile/corporate/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| corporate/page.tsx:289-291 | `statusColor()` returns `bg:'#f0fdf4'/'#fef2f2'/'#fffbeb'` + `color:'#16a34a'/'#dc2626'/'#d97706'` + `border:'#bbf7d0'/'#fecaca'/'#fde68a'` | 2 | REVIEW | Status pill = pale-tint bg + dark-tint text + pale border. Same issue as `STATUS_CONFIG` in rides/[id]: pale bg never flips → bright chip on dark. Recommend `rgba(...,0.12)` bg + semantic-var text/border. |
| corporate/page.tsx:328 | error box `background:'#fef2f2', border:'1px solid #fecaca'` | 2 | FIX | Pale-pink box never flips. Use `background: rgba(239,68,68,0.12)` + matching border. |
| corporate/page.tsx:329 | error text `color:'#c53030'` | 2 | REVIEW | Dark-red on dark = low contrast; switch to `var(--error)` once box bg fixed. |
| corporate/page.tsx:364 | Admin badge `background:'#eff6ff', color:'#2563eb', border:'1px solid #bfdbfe'` | 2 | REVIEW | Pale-blue pill + dark-blue text; pale bg never flips. Use `rgba(59,130,246,0.15)` bg + lighter blue text for dark. |
| corporate/page.tsx:390 | budget bar fill `background: budgetPercent<20 ? '#dc2626' : 'var(--primary)'` | 2 | KEEP | Semantic red / brand fill on a `var(--border-light)` track. |
| corporate/page.tsx:409 | "approve" button `background:'#16a34a', color:'#fff'` | 2 | KEEP | Semantic green action button, white text. |
| corporate/page.tsx:431,592,733 | action buttons `background:'var(--primary)', color:'#fff'` | 2 | KEEP | White on brand button. |
| corporate/page.tsx:480,483 | success note `background:'#f0fdf4'`, text `color:'#16a34a'` | 2 | FIX | Pale-green note bg never flips → light block on dark. Use `background: rgba(34,197,94,0.10)`; keep green text. |
| corporate/page.tsx:492 | members panel `background:'#f8fafc'` | 2 | FIX | Pale-gray panel never flips. Use `var(--bg-light)`. |
| corporate/page.tsx:547 | toggle text `color: checked ? '#fff' : 'var(--text-secondary)'` | 2 | KEEP | White on selected brand state. |

### apps/web/src/app/profile/trusted-contacts/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| trusted-contacts/page.tsx:153 | error box `background:'#fef2f2', border:'1px solid #fecaca'` | 2 | FIX | Pale-pink box never flips. Use `background: rgba(239,68,68,0.12)` + matching border. |
| trusted-contacts/page.tsx:154 | error text `color:'#c53030'` | 2 | REVIEW | Dark-red on dark = low contrast; switch to `var(--error)` once box bg fixed. |
| trusted-contacts/page.tsx:184 | emergency badge `background:'#e53e3e', color:'#fff'` | 2 | KEEP | Semantic red badge, white text. |
| trusted-contacts/page.tsx:209 | toggle track `background: auto_share ? 'var(--primary)' : '#ccc'` | 2 | FIX | Off-state `#ccc` washed-out on dark. Use `var(--border)`. |
| trusted-contacts/page.tsx:219 | toggle track `background: is_emergency ? '#e53e3e' : '#ccc'` | 2 | FIX | Off-state `#ccc`. Use `var(--border)` (keep red on-state). |
| trusted-contacts/page.tsx:210,220 | toggle knob `background:'#fff'` | 2 | KEEP | Switch knob — white in both themes. |
| trusted-contacts/page.tsx:298 | checkbox `accentColor:'#e53e3e'` | 2 | KEEP | Semantic red accent. |
| trusted-contacts/page.tsx:316 | save button `background:'var(--primary)', color:'#fff'` | 2 | KEEP | White on brand button. |

### apps/web/src/app/profile/saved-locations/page.tsx & SavedLocationsMap.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| saved-locations/page.tsx:199 | SVG `stroke="#f6ad55"` (header icon) | 2 | KEEP | Decorative amber icon — reads on both. |
| saved-locations/page.tsx:377,381 | tip pill `background:'rgba(56,161,105,0.08)'` + text `var(--text-secondary)` | 2 | REVIEW | Translucent green tint (alpha 0.08) — barely visible on dark; not unreadable but weak. Consider bumping to `~0.12` for dark or using a var. |
| saved-locations/page.tsx:386 | SVG `stroke="#38a169"` (success icon) | 2 | KEEP | Semantic green icon. |
| saved-locations/page.tsx:407 | save button `background:'var(--primary)', color:'#fff'` | 2 | KEEP | White on brand button. |
| SavedLocationsMap.tsx:26-28 | `markerColor()` → `'#38a169'/'#3182ce'/'#FF4D00'` | 2 | KEEP | Map marker colors (home/work/other). |
| SavedLocationsMap.tsx:79,92 | injected marker CSS `background:var(--primary,#FF4D00)` / `border-top:8px solid var(--primary,#FF4D00)` | 2 | KEEP | Map marker — brand color, `var()` with literal fallback. |
| SavedLocationsMap.tsx:191 | popup HTML `<div style="...color:#666...">` (address) | 2 | REVIEW | Injected Mapbox popup string; Mapbox popups render on a white popup chrome by default, so `#666` is on white — reads. Only a bug if popup CSS is themed; low priority. |

### apps/web/src/app/profile/edit/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| edit/page.tsx:191,365 | toast / save button `color:'#fff'` (on `var(--primary)`) | 2 | KEEP | White on brand button. |
| edit/page.tsx:243 | avatar placeholder SVG `fill="#ccc"` | 2 | REVIEW | `#ccc` placeholder silhouette; on a `var(--border-light)` circle (dark `#222`) the light-gray glyph actually reads, on light it's subtle. Borderline — could use `var(--text-tertiary)`. |
| edit/page.tsx:253 | camera button `background:'var(--primary)', color:'white'` | 2 | KEEP | White on brand button. |

### apps/web/src/app/profile/referral/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| referral/page.tsx:11,16,21 | `STATUS_STYLES` `bg:'#FEF3C7'/'#DCFCE7'/'#FEE2E2'` + `color:'#92400E'/'#166534'/'#991B1B'` | 2 | REVIEW | Referral-status pill = pale-tint bg + dark-tint text; pale bg never flips → bright chip on dark. Recommend `rgba(...,0.12)` bg + semantic-var text. |
| referral/page.tsx:201,204 | hero card `background:'linear-gradient(135deg, var(--primary), #FB923C)'`, `color:'#fff'` | 2 | KEEP | Permanent brand gradient hero, white text. |
| referral/page.tsx:209 | SVG `stroke="#fff"` (hero icon) | 2 | KEEP | White glyph on gradient hero. |
| referral/page.tsx:292,293,372,511 | buttons `background: 'var(--success,#16A34A)'/'var(--primary)'`, `color:'#fff'` | 2 | KEEP | White on brand/success buttons. |

### apps/web/src/app/profile/help/page.tsx & profile/about/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| help/page.tsx:164 | contact button `background:'var(--primary)', color:'#fff'` | 2 | KEEP | White on brand button. |
| about/page.tsx:59 | logo block `color:'#fff'` (on brand bg) | 2 | KEEP | White wordmark on brand-colored block. |

### apps/web/src/app/driver-profile/[userId]/page.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| driver-profile/[userId]/page.tsx:197,285 | rating star `<span style={{ color:'#F59E0B' }}>★</span>` | 2 | KEEP | Semantic amber rating star. |
| driver-profile/[userId]/page.tsx:229 | verified check `color:'#16A34A'` | 2 | KEEP | Semantic green checkmark. |
| driver-profile/[userId]/page.tsx:312 | trend `color: positive ? '#16A34A' : '#DC2626'` | 2 | KEEP | Semantic up/down color. |
| driver-profile/[userId]/page.tsx:251 | review card `background:'var(--bg-elevated, white)'` | 2 | REVIEW | `var(--bg-elevated)` is NOT defined in globals.css → falls back to literal `white`, which never flips. Use `var(--bg-card)`. |
| driver-profile/[userId]/page.tsx:216 | stats row `background:'var(--bg-secondary)'` | 1/2 | REVIEW | `var(--bg-secondary)` is not defined in globals.css and has no literal fallback → resolves to nothing (transparent). Not a contrast bug per se, but a dead token; should be `var(--bg-light)`. |

### apps/web/src/app/web-header.tsx & chat / support / ride-share / auth
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| web-header.tsx:138 | notif-badge `background:'var(--primary)', color:'#fff'` | 2 | KEEP | White on orange badge. |
| web-header.tsx:199,251 | menu avatar `background:'var(--gradient-primary)', color:'white'` | 2 | KEEP | White initials on brand gradient. |
| chat/[rideId]/page.tsx:170 | message bubble `color: isMine ? 'white' : 'var(--text-primary)'` | 2 | KEEP | White text only on the `var(--primary)` "my message" bubble. |
| chat/[rideId]/page.tsx:256 | send button `color:'white'` (on brand) | 2 | KEEP | White on brand send button. |
| chat/[rideId]/error.tsx:16 | retry button `color:'#fff'` (on `var(--primary)`) | 2 | KEEP | White on brand button. |
| support/page.tsx:19-22 | status colors `var(--info,#3B82F6)` / `var(--warning,#F59E0B)` / `var(--success,#10B981)` / `var(--text-tertiary,#6B7280)` | 2 | KEEP | Uses `var()` first; literal is only a fallback. `--info` is not defined but the fallback blue reads on both themes. Semantic. |
| support/page.tsx:142,238 | submit button `color:'white' / valid?'white':'var(--text-tertiary)'` | 2 | KEEP | White on brand button. |
| ride/share/[token]/page.tsx:85 | CTA button `color:'white'` (on `var(--primary)`) | 2 | KEEP | White on brand button. |
| track/share/[token]/page.tsx:22 | star SVG `fill/stroke '#F59E0B' / '#d1d5db'` | 2 | KEEP | Semantic rating star. |
| auth/callback/page.tsx:83 | `Trici<span style={{color:'var(--primary)'}}>Go</span>` | 2 | KEEP | Uses theme var — correct. |
| providers.tsx:94,96,98 / profile/layout.tsx:34,36,38 | `var(--bg-primary,#ffffff)`, `var(--text-tertiary,#999)`, `var(--primary,#00C853)` | 2 | REVIEW | `--bg-primary` is NOT defined in globals.css → these splash screens fall back to literal `#ffffff` and never flip to dark. `--text-tertiary` IS defined so that one is fine. Use `var(--bg)` instead of `var(--bg-primary,#ffffff)`. The `#00C853` fallback for `--primary` is dead (var defined) but misleading. |

### apps/web/src/components/DemoBanner.tsx, AvatarCropModal.tsx, TipFlow.tsx
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| DemoBanner.tsx:29,41 | `backgroundColor:'#FF4D00'`, `color:'#FFFFFF'` | 2 | KEEP | Permanent brand-orange banner, white text — fixed by design. |
| AvatarCropModal.tsx:170 | modal `background:'rgba(0,0,0,0.96)'` | 2 | KEEP | Full-screen crop modal — intentionally a dark immersive surface. |
| AvatarCropModal.tsx:188,195,205,273,284,289 | controls `color:'#fff' / 'rgba(255,255,255,0.75)'`, processing `'#888':'#FF4D00'` | 2 | KEEP | White/translucent-white controls on the permanent dark crop modal. |
| AvatarCropModal.tsx:282 | slider `accentColor:'#FF4D00'` | 2 | KEEP | Brand accent. |
| TipFlow.tsx:84,85 | success state `background:'rgba(22,163,74,0.12)'`, `color:'#16a34a'` | 2 | KEEP | Translucent green (alpha 0.12 — dark-aware) + semantic green text. Correct pattern. |
| TipFlow.tsx:189 | confirm button `color:'white'` (on `var(--primary)`) | 2 | KEEP | White on brand button. |
| TipFlow.tsx:202 | error `color:'var(--error,#dc2626)'` | 2 | KEEP | Uses theme var; literal is fallback only. |

### apps/web/src/app/layout.tsx — Class 1 (dead Tailwind)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| layout.tsx:92 | `<body className="font-sans antialiased bg-white text-neutral-900">` | 1 | FIX | web has no Tailwind — `bg-white text-neutral-900` are inert and **misleading** (suggest a permanent light theme). Remove them; `globals.css body` already sets `color:var(--text)` / `background:var(--bg)` correctly. `font-sans antialiased` are also inert but harmless. |

### apps/web/src/app/refer/[code]/page.tsx — Class 1 (dead Tailwind)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| refer/[code]/page.tsx:93 | `className="bg-white rounded-3xl shadow-2xl ..."` | 1 | FIX | Entire page is built with Tailwind classes that do nothing in web (no Tailwind). This page renders **unstyled**. Needs a real rewrite to inline styles / `var(--bg-card)` etc. — flagged as dead/misleading. |
| refer/[code]/page.tsx:113 | `className="text-2xl font-bold text-gray-900 ..."` | 1 | FIX | Dead Tailwind — `text-gray-900` inert. Use `var(--text-primary)`. |
| refer/[code]/page.tsx:121 | `className="text-gray-600 mb-2"` | 1 | FIX | Dead Tailwind — `text-gray-600` inert. Use `var(--text-secondary)`. |
| refer/[code]/page.tsx:133 | `className="bg-gray-50 ... border-orange-300"` | 1 | FIX | Dead Tailwind — code-display box has no real bg. Use `var(--bg-light)` + `var(--primary)` border. |
| refer/[code]/page.tsx:134 | `className="text-sm text-gray-500 mb-1"` | 1 | FIX | Dead Tailwind — `text-gray-500` inert. Use `var(--text-tertiary)`. |
| refer/[code]/page.tsx:145,155,171 | `className="... bg-orange-500 hover:bg-orange-600 text-white ..."` | 1 | FIX | Dead Tailwind — buttons have no bg/color. Use `var(--primary)` + `#fff`. |
| refer/[code]/page.tsx:161 | `className="... bg-white border border-orange-500 text-orange-600 ..."` | 1 | FIX | Dead Tailwind — outline button unstyled. Use transparent bg + `var(--primary)` border/text. |
| refer/[code]/page.tsx:178 | `className="text-sm text-gray-400 mt-4"` | 1 | FIX | Dead Tailwind — `text-gray-400` inert. Use `var(--text-tertiary)`. |

### apps/web/src/app/promo/[code]/page.tsx — Class 1 (dead Tailwind)
| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| promo/[code]/page.tsx:21 | `className="bg-white rounded-3xl shadow-2xl ..."` | 1 | FIX | Entire page built with inert Tailwind — renders unstyled. Rewrite with inline styles / theme vars. |
| promo/[code]/page.tsx:34 | `className="text-2xl font-bold text-gray-900 ..."` | 1 | FIX | Dead Tailwind — use `var(--text-primary)`. |
| promo/[code]/page.tsx:38 | `className="text-gray-600 mb-2"` | 1 | FIX | Dead Tailwind — use `var(--text-secondary)`. |
| promo/[code]/page.tsx:43 | `className="bg-gray-50 ... border-green-400"` | 1 | FIX | Dead Tailwind — code box unstyled. Use `var(--bg-light)`. |
| promo/[code]/page.tsx:44 | `className="text-sm text-gray-500 mb-1"` | 1 | FIX | Dead Tailwind — use `var(--text-tertiary)`. |
| promo/[code]/page.tsx:51 | `className="... bg-orange-500 hover:bg-orange-600 text-white ..."` | 1 | FIX | Dead Tailwind — button unstyled. Use `var(--primary)` + `#fff`. |
| promo/[code]/page.tsx:57 | `className="text-sm text-gray-400 mt-4"` | 1 | FIX | Dead Tailwind — use `var(--text-tertiary)`. |

## Hotspot files
1. **apps/web/src/app/book/page.tsx** — ~14 FIX (`#FFF5F0` selection bg ×6, pale status pills ×3, body/label grays, `#ccc` toggle/disabled). The single biggest readability offender.
2. **apps/web/src/app/refer/[code]/page.tsx** & **apps/web/src/app/promo/[code]/page.tsx** — 8 + 7 FIX, Class 1: both pages are built entirely in Tailwind classes that do nothing in web, so they render essentially unstyled (not just a dark-mode bug — a styling bug in both themes).
3. **apps/web/src/app/profile/corporate/page.tsx** — ~4 FIX + 4 REVIEW (pale error/success boxes, `#f8fafc` panel, status pills).
4. **apps/web/src/app/profile/safety/page.tsx** — 3 FIX + 2 REVIEW (pale-pink SOS card, dark-brown body text, pale-green tips card).
5. **apps/web/src/app/blog/page.tsx** + **blog/[slug]/page.tsx** + **privacy/page.tsx** + **terms/page.tsx** — 18 FIX combined, all the same pattern: hardcoded `#444`/`#666`/`#888`/`#999`/`#aaa` body/loading text that should be `var(--text-secondary|tertiary|primary)`.

## Notes
Systemic patterns observed:

1. **Pale-tint "soft" panels never flip.** The dominant bug class is `background: '#fef2f2' / '#f0fdf4' / '#fffbeb' / '#FFF5F0' / '#eff6ff'` for error / success / warning / selected / info panels and status pills. These pale backgrounds stay pale on the dark `#0d0d1a` page → glaring light blocks. globals.css *already establishes the correct pattern* (`.ride-status-badge--completed { background: rgba(34,197,94,0.08) }` + a `[data-theme="dark"]` bump to `0.12`). Every inline pale panel should adopt `rgba(<semantic>,0.10–0.12)`. Status-pill configs (`STATUS_CONFIG` in rides/[id], `statusColor()` in corporate, `STATUS_STYLES` in referral) are the same issue in object form — marked REVIEW because the *text* stays readable on the chip, but the chip itself clashes.

2. **Hardcoded grays for body/secondary text.** `#444` (body), `#666`/`#888` (secondary), `#999`/`#aaa`/`#bbb` (tertiary) appear across the static content pages (blog, privacy, terms) and loading states. All are pure FIX → `var(--text-secondary)` / `var(--text-tertiary)` (and `#333`/`#444` long-body → `var(--text-primary)`). On dark these range from low-contrast to invisible.

3. **`#ccc` for toggle off-state / disabled.** book/page.tsx and trusted-contacts use `#ccc` for switch tracks and disabled buttons. Light-gray reads brighter than the dark page — use `var(--border)`.

4. **Undefined CSS vars with literal fallbacks = silent light-mode lock.** `var(--bg-primary, #ffffff)` (providers.tsx, profile/layout.tsx), `var(--bg-elevated, white)` and `var(--bg-secondary)` (driver-profile) reference tokens that **do not exist** in globals.css. The literal fallback (`#ffffff`/`white`) is what actually renders, so these surfaces never flip. Real fix is to use the defined tokens (`var(--bg)`, `var(--bg-card)`, `var(--bg-light)`). Many `var(--primary, #00C853)` fallbacks are harmless (var is defined) but misleading — the wordmark green literal is dead code.

5. **Genuinely fixed colors (KEEP) are the majority.** Brand-orange (`#FF4D00`/`var(--primary)`) surfaces with white text, white text on permanent gradients/balance cards/badges, semantic status colors (green `#16a34a`, red `#dc2626`/`#ef4444`, amber `#f59e0b`/`#d97706`), Mapbox marker/label glyph colors, and the deliberately-dark BookingMap chrome + AvatarCropModal are all correctly theme-independent and were not flagged.

6. **`apps/web/src/app/global-error.tsx` is special.** It renders its own `<html>`/`<body>` outside the themed shell — CSS custom properties are not loaded there, so `var(--*)` would not work. Its `#666` is a REVIEW (acceptable hard fallback on white, but breaks if the OS forces dark; a static `background:#fff` on the body or a `prefers-color-scheme` block would harden it).

7. **`refer/[code]` and `promo/[code]` are broken in BOTH themes**, not just dark — they are written entirely in Tailwind utility classes and web has no Tailwind, so they render with browser-default styling. They need a genuine restyle to inline styles + theme vars; flagged here as Class 1 because that is the audit's bucket for inert Tailwind.
