# Watchdog externo de Supabase

Vigila que la base de datos de producción responda, **desde afuera de Supabase**.

## Por qué existe

El 2026-09-21 la capa de almacenamiento del proyecto se atascó ~3 h (09:24–12:28
UTC). PostgREST devolvió 503 en `/rest/v1/rides` (215 veces), `platform_config`
(126), `driver_heartbeat` y `find_nearby_vehicles`. **No salió una sola alerta.**
El dueño se enteró usando la app y tuvo que reiniciar el proyecto a mano.

La causa del silencio es estructural, no un olvido. Las tres alarmas del
proyecto viven **dentro** de Postgres y las dispara `pg_cron`:

| Alarma | Migración | Cron |
|---|---|---|
| `check_database_health()` | 00577 | 54, cada hora al :55 |
| `check_exchange_rate_freshness()` | 00503 | 36, cada hora al :20 |
| `check_cron_http_failures()` | 00507 | 37, cada hora al :40 |

Cuando el disco se atasca, `pg_cron` **no puede ni arrancar sus workers** — ese
día quedaron 98 × `cron job startup timeout` en los logs. Ninguna corrió.
`platform_config.db_health_status` se quedó congelado en `'ok'` desde las 08:55
UTC mientras la plataforma servía errores durante tres horas.

> Una alarma que vive dentro de lo que vigila no puede avisar que eso se cayó.

El mismo patrón ya había ocurrido el **2026-09-18** y el **2026-09-20**, visible
solo como huecos en `cron.job_run_details` porque nadie miraba desde afuera:

```sql
-- Cada hueco en un cron de 1 minuto = una ventana de caída.
WITH r AS (
  SELECT start_time, lag(start_time) OVER (ORDER BY start_time) AS prev
  FROM cron.job_run_details WHERE jobid = 17
)
SELECT prev AS caida_desde, start_time AS recupero,
       round(extract(epoch FROM start_time - prev)/60) AS minutos
FROM r WHERE start_time - prev > interval '4 minutes'
ORDER BY prev DESC LIMIT 25;
```

## Regla de diseño

**No toca Postgres para nada de su propio trabajo.**

- El estado va a un archivo local, nunca a `platform_config`.
- Las alertas salen directo a Resend / D7 por HTTPS, **nunca** por las Edge
  Functions `send-email` / `send-sms`: esas escriben en `email_sends` / `sms_log`,
  o sea que necesitan la base que está caída.
- Lo único de Supabase que toca es el blanco de la sonda.

## Qué sondea

Dos capas, porque fallan por separado — verificado en el incidente: el runtime
de Edge Functions siguió corriendo y siendo invocado mientras toda llamada que
tocaba la base fallaba.

| Sonda | Endpoint | Para qué |
|---|---|---|
| `rest` | `GET /rest/v1/platform_config?select=key&limit=1` | El camino **exacto** que usan las apps. Es la que decide. |
| `ef` | `GET /functions/v1/health-check` | Sobrevive a una base muerta y dice **qué capa** rompió (`checks.database` / `checks.auth`). Enriquece la alerta; nunca decide sola. |

Clasificación:

- **ok** — `rest` 2xx dentro de `SLOW_MS`
- **slow** — `rest` 2xx pero más lento que `SLOW_MS`. **No es cosmético:** ese
  día PostgREST llegó a responder en 125 s, y una sonda ingenua de arriba/abajo
  lo habría contado como "arriba".
- **down** — `rest` no 2xx, o sin respuesta dentro de `PROBE_TIMEOUT_S`

Antirruido: alerta tras `FAILS_BEFORE_ALERT` fallos seguidos, una sola vez por
incidente, y anuncia la recuperación tras `OKS_BEFORE_RECOVERY` éxitos seguidos.

## Instalación en el VPS

```bash
# 1. Script + config
scp ops/supabase-watchdog/healthcheck.sh root@187.77.214.236:/etc/tricigo/supabase-healthcheck.sh
ssh root@187.77.214.236 'chmod 700 /etc/tricigo/supabase-healthcheck.sh'

scp ops/supabase-watchdog/supabase-health.env.example root@187.77.214.236:/etc/tricigo/supabase-health.env
ssh root@187.77.214.236 'chmod 600 /etc/tricigo/supabase-health.env && chown root:root /etc/tricigo/supabase-health.env'
# Editar y poner RESEND_API_KEY, ALERT_EMAIL_TO y (recomendado) D7_API_TOKEN + ALERT_SMS_TO:
ssh root@187.77.214.236 'nano /etc/tricigo/supabase-health.env'

# Desde Windows: un checkout con core.autocrlf=true copia el script con CRLF y
# en Linux falla con "cannot execute: required file not found" (pasó con
# ops/squid el 2026-07-02). Quitar los CR y comprobar; debe imprimir 0.
ssh root@187.77.214.236 "sed -i 's/\r\$//' /etc/tricigo/supabase-healthcheck.sh /etc/tricigo/supabase-health.env && bash -n /etc/tricigo/supabase-healthcheck.sh && grep -c \$'\r' /etc/tricigo/supabase-healthcheck.sh"

# 2. Probar ANTES de programarlo. Debe salir 0 y te tiene que llegar el aviso.
ssh root@187.77.214.236 '/etc/tricigo/supabase-healthcheck.sh --selftest'

# 3. Recién entonces, programarlo
scp ops/supabase-watchdog/systemd/tricigo-supabase-healthcheck.* root@187.77.214.236:/etc/systemd/system/
ssh root@187.77.214.236 'systemctl daemon-reload && systemctl enable --now tricigo-supabase-healthcheck.timer'

# 4. Confirmar que corre
ssh root@187.77.214.236 'systemctl list-timers tricigo-supabase-healthcheck.timer --no-pager'
ssh root@187.77.214.236 'journalctl -t tricigo-supabase-health -n 20 --no-pager'
```

El paso 2 no es opcional. Este watchdog existe porque una alerta que nadie
ejerció no es una alerta: `--selftest` manda un aviso real por cada canal
configurado y **sale distinto de 0 si ninguno lo aceptó**.

## Respaldo independiente: GitHub Actions

`.github/workflows/supabase-uptime.yml` sondea lo mismo cada 10 min desde la
infraestructura de GitHub. Existe porque **el VPS es un punto único de fallo**:
si el VPS se cae, nadie vigila, y de eso tampoco avisaría nadie.

Señaliza abriendo un issue (que notifica a los watchers del repo) y haciendo
fallar la corrida; cierra el issue solo cuando recupera. No necesita secretos
—la URL y la publishable key traen valores por defecto y se pueden sobrescribir
con las variables de repo `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`—.

Es el respaldo, no el principal: GitHub demora las corridas programadas cuando
tiene carga. La detección rápida es el timer de 2 min del VPS.

## Runbook — me llegó una alerta

1. **`rest` no es 2xx** → los pasajeros y conductores están viendo errores
   **ahora**. Seguir al paso 2.
2. **Mirar Disk IO en el panel de Supabase.** En los tres incidentes conocidos
   la base estaba sana por dentro y lo que se cayó fue el almacenamiento.
3. **Reiniciar el proyecto** destraba la situación (es lo que funcionó el
   2026-09-21). No arregla la causa.
4. **Abrir ticket con Supabase** con la evidencia de abajo.

### Cómo distinguir "es la base" de "es el disco"

Lo que **descarta** un problema propio (medido el 2026-09-21, todo normal):

| Señal | Valor durante la caída |
|---|---|
| Tamaño de la base | 775 MB, y bajando −198 MB/día |
| Conexiones | 13–26 de 60 |
| Cache hit | 99.76 % |
| Transacciones largas / `idle in transaction` | 0 |
| Deadlocks, `too many clients`, `out of memory` | ninguno |

Lo que **prueba** que es el almacenamiento:

```
08:10 → checkpoint complete: wrote 118 buffers, total=11.9 s    ← normal
09:52 → checkpoint complete: wrote   9 buffers, total=265.4 s   ← 242 s para 9 buffers
12:02 → checkpoint complete: wrote  10 buffers, total=289.0 s
```

Escribir 9 buffers en 4 minutos no es carga de base de datos. Y la misma
función medida por `pg_stat_statements` daba **240 ms** en condiciones normales
contra **76.036 ms** durante el incidente (`cleanup_orphan_searching_rides`):
300× más lenta sin que cambiara ni la consulta ni los datos.

Consultas útiles para armar el ticket:

```sql
-- Huecos de cron = ventanas de caída (ver arriba)
-- Muestras horarias de salud, que se cortan cuando pg_cron muere:
SELECT sampled_at, db_size_bytes/1048576 AS mb, conn_used, cache_hit_pct,
       longest_tx_s, deadlocks
FROM db_health_samples ORDER BY sampled_at DESC LIMIT 24;
```

Y en el panel de Logs (los logs solo retienen 24 h — sacarlos temprano):

```sql
-- Latencia y errores por hora vistos por las apps
select toStartOfHour(timestamp) as hora, count(*) as total,
       countIf(log_attributes['response.status_code'] like '5%') as err_5xx,
       round(avg(toFloat64OrZero(log_attributes['response.origin_time']))) as ms
from logs where source='edge_logs' group by hora order by hora
```

## Tests

```bash
ops/supabase-watchdog/tests/run.sh
```

21 aserciones contra un mock local de PostgREST / `health-check` / Resend / D7.
Incluye **casos negativos** (canal roto, sin canal, config ausente) porque una
verificación que nunca se vio fallar no es una verificación.

Dos bugs que encontró esta suite y que habrían dejado el watchdog mudo:

- **`source` del archivo de config.** Con `ALERT_EMAIL_TO=a@x.com, b@x.com`
  (sin comillas), bash lo lee como prefijo de comando y **la variable nunca
  queda seteada** → todo aviso por correo se salta en silencio. Por eso la
  config se **parsea**, no se sourcea. La suite guarda esa regresión usando a
  propósito un valor sin comillas con espacio.
- **`--selftest` decía "listo" sin enviar nada**, porque llamaba a `send_email`
  antes de que la función estuviera definida. Ahora el veredicto exige que al
  menos un canal haya aceptado el envío de verdad.
