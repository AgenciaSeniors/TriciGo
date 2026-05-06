# ASO Keywords privados — TriciGo Conductor

> **PROPÓSITO**: keywords privados para campos de App Store Connect / Play Console que NO se publican en el HTML público de la tienda. Stripe scrapers ven la description pública pero NO ven estos campos.

---

## Apple App Store Connect — Keywords field (max 100 caracteres)

Pegar en App Store Connect → My Apps → TriciGo Driver → App Information → Keywords:

```
conductor,bicitaxista,habana,cuba,driver,taxi,ganancias,viajes,empleo,trabajo
```

**Nota**: el driver app tiene un set diferente al cliente porque target audience es distinto (conductores buscando trabajar, no pasajeros buscando viajar).

### Subtitle (max 30 caracteres) — visible público
```
Para bicitaxistas y choferes
```

### Promotional Text (max 170 caracteres) — visible público
```
Recibe viajes, navega con mapas integrados, controla tus ganancias. Trabaja a tu ritmo.
```

---

## Apple — Localization

Misma estrategia que el cliente:
1. `en-US` — `store-metadata/en/listing.md`
2. `es-MX` (proxy Latam) — `store-metadata/es/listing.md`
3. `es-ES` opcional

**Territory**: igual que cliente.

---

## Google Play Console

### Tags
```
Business
Maps & Navigation
```

### Localization
1. `en-US`
2. `es-419` (Latam)

### Geographic targeting
Mismo que cliente.

---

## Stripe — Business profile

Como el driver app NO usa Stripe directamente (los conductores no tienen Stripe Connect), no hay configuración Stripe específica para esta app. Pero el Stripe account es UNO solo del developer, así que:

- Lo configurado en `apps/client/store-metadata/aso-keywords-private.md` aplica al Stripe dashboard
- El driver app NO debe crear ningún payment_intent ni payout en Stripe

---

## Checklist

- [ ] `apps/driver/store-metadata/{en,es}/listing.md` — 0 menciones de Cuba/Habana ✅
- [ ] Apple subtitle driver — sin Cuba
- [ ] Apple keywords driver — Cuba/Habana OK (privado)
- [ ] Promotional text driver — sin Cuba
- [ ] Stripe (compartido con client) — ver `apps/client/store-metadata/aso-keywords-private.md`
