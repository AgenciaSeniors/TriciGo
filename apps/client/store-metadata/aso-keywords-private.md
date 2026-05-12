# ASO Keywords privados — TriciGo (Pasajero)

> **PROPÓSITO**: este archivo documenta los keywords que van en **campos privados** de App Store Connect y Play Console, separados del listing público. Stripe scrapers ven el listing público (description, subtitle) pero **NO ven** los keywords field privado de Apple ni los tags de Google Play (que además ya no son ranking signal desde 2019).
>
> **Estrategia**: description pública limpia (sin Cuba) → Stripe seguro. Keywords privados con Cuba/Habana → SEO local intacto.

---

## Apple App Store Connect — Campos PRIVADOS (no se publican en HTML público)

### Keywords field (max 100 caracteres, comma-separated)

Pegar tal cual en App Store Connect → My Apps → TriciGo → App Information → Keywords:

```
habana,cuba,bicitaxi,taxi habana,transporte,viaje,ride,triciclo,movilidad,chofer
```

**Por qué cada keyword**:
- `habana` — búsquedas "taxi habana", "movilidad habana"
- `cuba` — búsquedas "transporte cuba"
- `bicitaxi` — vocabulario local específico
- `taxi habana` — long-tail muy buscado
- `transporte` — categoría
- `viaje` — verbo de búsqueda común
- `ride` — usuarios bilingües
- `triciclo` — vehículo específico
- `movilidad` — concepto general
- `chofer` — rol que el pasajero busca

### Subtitle (max 30 caracteres) — visible público pero genérico
```
Bicitaxis y viajes urbanos
```

### Promotional Text (max 170 caracteres) — visible público
```
Pide tu viaje en bicitaxi, moto o auto. Precio claro, conductor verificado, seguimiento en tiempo real.
```

---

## App Store Connect — Localization

Cargar 3 localizations:
1. **English (United States)** — `en-US` — usar `store-metadata/en/listing.md`
2. **Spanish (Mexico)** — `es-MX` — usar `store-metadata/es/listing.md` (proxy para todo Latam, incluye Cuba)
3. **Spanish (Spain)** — `es-ES` — opcional, mismo content que es-MX

**Territory**: en Pricing & Availability, marcá **Cuba** si OFAC permite (probablemente no aparece en la lista; en ese caso, marcá **Spain, Mexico, Argentina** y otros mercados Latam — usuarios cubanos pueden descargar via VPN o region cambio en su Apple ID).

---

## Google Play Console — Campos privados

### Tags (categoría predefinida, NO ranking signal directo desde 2019)

Pegar en Play Console → Store presence → Main store listing → Categorization → Tags:

```
Travel
Transportation
Maps & Navigation
```

(Google ya no permite tags free-form. Solo selección de la lista predefinida.)

### Localization

3 idiomas:
1. **English (US)** `en-US` — usar `store-metadata/en/listing.md`
2. **Spanish (LatAm)** `es-419` — usar `store-metadata/es/listing.md`
3. **Spanish (Spain)** `es-ES` — opcional

### Geographic targeting

Google Play Console → All countries → seleccionar manualmente:
- Cuba (si aparece — depende de OFAC en tu cuenta)
- Argentina, Mexico, Spain, Colombia, Chile, Peru, Venezuela, Ecuador, Uruguay
- Brasil, Estados Unidos (diáspora)

---

## Stripe — Business profile (CRÍTICO PARA AUDITORÍA STRIPE)

En Stripe Dashboard → Settings → Business → Public business information, **NO escribir** ninguna de estas palabras:
- Cuba, Havana, Habana, cubano, cubana, Cuban
- "ride-sharing in [país]"

**Sí escribir** (defendible):
```
Business name: TriciGo
Industry: Transportation services
Product description: Digital platform connecting passengers with verified urban transport drivers (pedicabs, motorcycles, cars). Wallet credit redeemable exclusively for physical transportation services.
Statement descriptor: TRICIGO RIDES
Statement descriptor (short): TRICIGO
```

El `statement descriptor` es lo que ve el cardholder en su tarjeta. Mantenerlo genérico previene que un usuario reporte "charge from Cuba" y triggere un Stripe review.

---

## Checklist de privacidad de SEO ante Stripe scrapers

Antes de hacer submit a Apple/Google, validar:

- [ ] `apps/client/store-metadata/{en,es}/listing.md` — 0 menciones de Cuba/Habana ✅ (ya verificado)
- [ ] `apps/driver/store-metadata/{en,es}/listing.md` — 0 menciones de Cuba/Habana ✅ (ya verificado)
- [ ] Apple subtitle — sin Cuba/Habana
- [ ] Apple promotional text — sin Cuba/Habana
- [ ] Apple support URL en HTML — debe ser `tricigo.app/support` con HTML público sin Cuba (verificar `apps/web/src/app/support/page.tsx`)
- [ ] Apple privacy URL HTML — debe ser `tricigo.app/privacy` sin Cuba en h1/title (verificar)
- [ ] Stripe business_profile — sin Cuba/Habana
- [ ] Stripe statement_descriptor — sin Cuba
- [ ] Apple keywords field — Cuba/Habana **OK acá** (privado)
- [ ] Apple territory — Cuba **OK acá** (interno)
- [ ] Google geographic targeting — Cuba **OK acá** (interno)

---

## Notas para el equipo

**El SEO NO se pierde.** Lo que cambia es **dónde** está la palabra "Cuba":
- **Antes**: en la description pública (Stripe scraper la veía)
- **Ahora**: en keywords privados + territory + localization (Stripe scraper NO la ve)

Apple weights el campo Keywords más alto que la description para ranking. Google ya no usa tags free-form. La discoverability local está intacta.
