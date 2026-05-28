# Status Page Setup — `status.tricigo.com`

> **Optional para MVP launch**, **recomendado para Day 2** post-launch para transparencia y confianza usuarios.
> **Costo**: gratis (self-hosted Uptime Kuma) o $20/mes (Better Stack / Statuspage.io).

---

## ¿Por qué status page?

- **Transparencia con usuarios**: cuando algo falla, ven que estás encima del incidente.
- **Reduce tickets**: muchos users chequean status antes de contactar soporte.
- **Confianza B2B**: corporate accounts (empresas con flotas) preguntan por SLA + history.
- **Histórico de uptime**: público demuestra reliability.

---

## Opciones

| Opción | Costo | Setup | Mantenimiento |
|---|---|---|---|
| **Uptime Kuma** (self-hosted) | $0 | 30 min en mismo VPS donde corre web | Bajo (auto-actualiza) |
| **Better Stack Status Page** | $20/mes (free tier 1 page) | 15 min | Muy bajo (SaaS) |
| **Atlassian Statuspage** | $29/mes | 1 hora | Bajo |
| **Cronitor** | Free tier limited, $20/mes | 30 min | Bajo |

**Recomendación**: empezar con **Uptime Kuma** self-hosted (gratis), migrar a Better Stack si VPS no aguanta o querés features avanzadas.

---

## Setup — Opción A: Uptime Kuma (gratis, self-hosted)

### 1. Docker setup en VPS

```bash
# SSH al VPS donde corre apps/web
ssh user@<VPS_IP>

# Crear directorio de datos
mkdir -p /opt/uptime-kuma

# Run Docker container
docker run -d \
  --name uptime-kuma \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /opt/uptime-kuma:/app/data \
  louislam/uptime-kuma:1
```

### 2. Configurar acceso público

Si usás Caddy en el VPS, agregar a `Caddyfile`:

```caddyfile
status.tricigo.com {
    reverse_proxy localhost:3001
}
```

Recargar Caddy:
```bash
sudo systemctl reload caddy
```

Configurar DNS A record `status.tricigo.com` → IP del VPS.

### 3. Setup initial admin

1. Abrir `https://status.tricigo.com` en browser
2. Crear admin username + password (guardar en password manager)

### 4. Crear monitors

#### Monitor 1: Web app
- Type: HTTP(s)
- URL: `https://tricigo.com`
- Interval: 60 seconds
- Expected status: 200

#### Monitor 2: Supabase API
- Type: HTTP(s)
- URL: `https://lqaufszburqvlslpcuac.supabase.co/rest/v1/`
- Interval: 60 seconds
- Headers: `apikey: <ANON_KEY>`
- Expected status: 200 or 401 (401 = auth working)

#### Monitor 3: Edge Function health
- Type: HTTP(s)
- URL: `https://lqaufszburqvlslpcuac.supabase.co/functions/v1/health-check`
- Interval: 60 seconds
- Headers: `Authorization: Bearer <ANON_KEY>`
- Expected status: 200

#### Monitor 4: Mapbox tiles
- Type: HTTP(s)
- URL: `https://api.mapbox.com/v4/mapbox.satellite/0/0/0.png?access_token=<TOKEN>`
- Interval: 5 min (less critical)
- Expected status: 200

#### Monitor 5: NETOPIA (heartbeat)
- Type: HTTP(s)
- URL: NETOPIA endpoint público (preguntar a partner manager)
- Interval: 5 min

### 5. Crear Public Status Page

1. Settings → Status Pages → New Status Page
2. Slug: `tricigo` (URL: `https://status.tricigo.com/status/tricigo`)
3. Title: "TriciGo Status"
4. Description: "Estado de los servicios de TriciGo en tiempo real"
5. Monitors visible: agregar los 4 anteriores (excluir Mapbox/NETOPIA si tienen propios status pages)
6. Theme: dark (matching Cuban Modern brand)
7. Logo: subir `apps/web/public/logo-wordmark-white.png`

### 6. Crear primer incident (test)

1. Incidents → New Incident
2. Title: "Status page launched"
3. Description: "Welcome to TriciGo status page. We'll post updates here for any service disruption."
4. Status: Resolved
5. Affected monitors: none

### 7. Configurar notificaciones (opcional)

Settings → Notifications:
- Add Slack webhook → channel `#alerts-warning`
- Add Discord webhook (alternativa)
- Add email (founder)

Cuando un monitor down → notifica automáticamente.

---

## Setup — Opción B: Better Stack (SaaS, $20/mes)

### 1. Signup
- https://betterstack.com → crear cuenta business
- Plan: Uptime + Status Pages ($20/mes)

### 2. Create monitors

Same monitors que en Uptime Kuma. Better Stack UI guía:
- Add monitor → HTTP → URL + expected status
- Set check interval (recomendado 30 sec for Better Stack — más frecuente que self-hosted)

### 3. Create Status Page

- Status Pages → New
- Custom domain: `status.tricigo.com`
- Better Stack provides CNAME a setear en DNS

### 4. Configurar incidents auto-flow

- Cuando monitor down >2 minutes → auto-create incident on status page
- On-call team can update via Slack slash commands
- Auto-resolve cuando monitor up por 5 min consecutivos

---

## Comunicación durante incidents

Template para updates en status page:

```markdown
**Investigating** (10:32 UTC):
We're aware that some users may experience issues completing rides.
We're investigating and will update in 15 minutes.

**Identified** (10:47 UTC):
We've identified the cause: NETOPIA payment processor is experiencing
degraded performance. Rides paid in cash continue working normally.
Wallet recharges are temporarily disabled.

**Monitoring** (11:15 UTC):
A fix has been applied. Wallet recharges are working again.
We're monitoring to confirm full recovery.

**Resolved** (11:45 UTC):
All systems operating normally. We apologize for the inconvenience.
For users affected by wallet recharge failures: pending payments
will be retried automatically within 2 hours.
```

**Best practices**:
- Update cada 15-30 min durante incident (incluso "todavía investigando")
- Sin lenguaje técnico ("DB index dropped" → "some features may be slow")
- Postmortem público después de incidents grandes (resolución >1 hora)
- Linkear desde footer del web app + push notif para outages mayores

---

## Métricas que mostrar

| Métrica | Display | Where shown |
|---|---|---|
| Uptime últimos 30 días | % | Status page main |
| Uptime últimos 90 días | % | Trends |
| Avg response time | ms | Performance panel |
| Active incidents | banner | Top of page |
| Last incident | text | Sidebar |
| Subscribers | count | Footer |

---

## Integración con app

En `apps/web/src/app/web-footer.tsx` agregar link:

```tsx
<a href="https://status.tricigo.com" target="_blank" rel="noopener noreferrer">
  Estado del sistema
</a>
```

En mobile apps (post-launch), en perfil → "Acerca de" → link al status page.

---

## Checklist setup

- [ ] Elegir opción (Uptime Kuma vs Better Stack)
- [ ] Setup infrastructure (Docker container o SaaS account)
- [ ] DNS A/CNAME `status.tricigo.com` → IP/target
- [ ] HTTPS válido (Caddy auto-renews Let's Encrypt para Uptime Kuma)
- [ ] 4-5 monitors críticos configurados
- [ ] Status page público accesible
- [ ] Primer incident "test" posteado y resuelto
- [ ] Notificaciones configuradas (Slack/email)
- [ ] Link agregado en web footer
- [ ] (Post-launch) Link en mobile apps profile
