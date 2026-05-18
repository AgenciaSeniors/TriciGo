# ASO Keywords — TriciGo (Pasajero)

> **PROPÓSITO**: este archivo documenta los keywords que van en el **campo de keywords** de App Store Connect y la configuración de localización y segmentación geográfica de las tiendas. Es una referencia interna de ASO (App Store Optimization) para el equipo.

---

## Apple App Store Connect — Keywords field

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

### Subtitle (max 30 caracteres)
```
Bicitaxis y viajes urbanos
```

### Promotional Text (max 170 caracteres)
```
Pide tu viaje en bicitaxi, moto o auto. Precio claro, conductor verificado, seguimiento en tiempo real.
```

---

## App Store Connect — Localization

Cargar 3 localizations:
1. **English (United States)** — `en-US` — usar `store-metadata/en/listing.md`
2. **Spanish (Mexico)** — `es-MX` — usar `store-metadata/es/listing.md` (proxy para todo Latam, incluye Cuba)
3. **Spanish (Spain)** — `es-ES` — opcional, mismo content que es-MX

**Territory**: en Pricing & Availability, marcá **Cuba** si está disponible en la lista; en caso contrario, marcá **Spain, Mexico, Argentina** y otros mercados Latam.

---

## Google Play Console — Categorización y localización

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
- Cuba (si aparece en la lista)
- Argentina, Mexico, Spain, Colombia, Chile, Peru, Venezuela, Ecuador, Uruguay
- Brasil, Estados Unidos (diáspora)
