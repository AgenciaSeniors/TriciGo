# SEO off-page — plan de autoridad para tricigo.com

> El SEO **on-page** (páginas, schema, sitemap, contenido) ya está cubierto en el repo. Para
> rankear por los términos **competidos** ("transporte cuba", "app taxi cuba", "uber en cuba")
> hace falta **autoridad off-page**: citaciones en directorios + backlinks. Eso lo ejecuta el
> equipo (no es código). Este documento es la guía.

## Expectativas realistas (por término)

| Término | Dificultad | Plazo estimado |
|---|---|---|
| `tricigo` (marca) | Muy baja | 2-3 meses → #1 |
| `bicitaxi`, `triciclo cuba`, `motorina cuba` | Baja-media | 3-6 meses |
| `alternativa a la nave`, `uber en cuba` | Media | 4-8 meses (con backlinks) |
| `app taxi cuba`, `transporte en la habana` | Media-alta | 6-10 meses |
| `transporte cuba` | Alta | 8-12+ meses |
| `uber` (marca global) | No es objetivo | — |

El SEO no es instantáneo: Google tarda semanas-meses en recrawlear, indexar y mover posiciones.

## Límite estructural: Google Business Profile NO existe en Cuba

Por las sanciones de EE.UU. (OFAC), **Google Business Profile no está disponible en Cuba** → no hay
ranking en Google Maps / local pack ni reseñas de GBP. La autoridad local debe venir de **directorios + backlinks**.

## 1. Directorios / citaciones (NAP consistente)

Dar de alta TriciGo con **el mismo Nombre, "dirección"/contacto y teléfono (NAP)** en:

- **YelloCu** — https://www.yellocu.com/ (red de negocios cubana, alta prioridad)
- **PROCUBA** — https://www.procuba.cu/en/business-directory/ (directorio oficial, alta autoridad)
- **Directorio Cubano** — https://en.directoriocubano.info/empresas/
- **Negocios Cuba** — https://www.negocioscuba.net/
- **Compage Cuba** — https://cu.compage.org/
- **GlobalDatabase (Cuba)** — https://www.globaldatabase.com/cuba-companies-database

NAP sugerido (mantener idéntico en todos): `TriciGo` · soporte@tricigo.com · https://tricigo.com · operado por MACH DIGITAL TECH S.R.L.

## 2. Backlinks (calidad > cantidad)

**Medios cubanos** (relevancia + tráfico social):
- CiberCuba (cibercuba.com), elTOQUE (eltoque.com), Periódico Cubano (periodicocubano.com),
  Cuba en Miami (cubaenmiami.com) — cubrieron antes apps de transporte (Sube/Bajanda/Metro/La Nave).

**Blogs de turismo/expats** (consultas tipo "is there Uber in Cuba"):
- Epic Nomad Life, Cuba's Best, Monito, Wise (hub rideshare), Expat Focus, In Lovely Blue, Tripadvisor Cuba.
  Pitch: la página `tricigo.com/uber-cuba` es un recurso útil para enlazar desde sus guías de transporte.

**Comunidades / lanzamiento:**
- Product Hunt (ángulo "alternative to La Nave"), directorios de startups de LATAM.

Evitar: link farms, PBN, dominios .tk/.ml. El mercado es chico — vale más un backlink relevante que diez basura.

## 3. Redes sociales → `Organization.sameAs`

Cuando existan los perfiles oficiales (Instagram / Facebook / X / YouTube / Telegram), pasarlos para
agregarlos a `sameAs` del `Organization` JSON-LD en `apps/web/src/app/layout.tsx` (refuerza el knowledge panel).

## 4. Google Search Console (ya conectado)

- El `sitemap.xml` ya está enviado.
- **Pedir indexación** de las páginas nuevas de alto valor: `/`, `/uber-cuba`, `/triciclo`, `/moto`, `/auto`,
  `/mensajeria`, y las páginas de ciudad/provincia top.
- **Monitorear** en "Rendimiento" las consultas `tricigo`, `bicitaxi`, `uber cuba`, `motorina`, `app transporte cuba`
  (impresiones → posición → clics) para ver qué sube y dónde reforzar contenido.

## 5. Señales que ayudan en Cuba

- Contenido **en español neutro cubano** con los cubanismos reales (bicitaxi, motorina, almendrón, guagua, mandao).
- **Velocidad** (Cuba tiene conexiones lentas / 3G): el sitio ya es SSR + estático; mantener imágenes livianas.
- **Mobile-first** (Cuba es móvil-dominante).
- Páginas locales por provincia/ciudad (ya creadas) → reforzar con backlinks locales por zona.
