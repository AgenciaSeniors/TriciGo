# Filtro de trabajos del runner del VPS

El runner de GitHub Actions que vive en el VPS (`/root/actions-runner`, servicio
de systemd, corre como **root**) acepta **cualquier** trabajo cuyo `runs-on`
diga `self-hosted`. El repositorio es público, así que eso incluye:

- un workflow nuevo empujado a **cualquier rama**;
- un workflow lanzado a mano (`workflow_dispatch`) desde **cualquier rama**, con
  el archivo de esa rama;
- un workflow agregado por un **pull request desde un fork**, en cuanto su
  ejecución se aprueba, o sin aprobación si su autor ya contribuyó antes.

Cualquiera de esos trabajos corre como root en el servidor de producción.

`job-gate.sh` es el *job-started hook* del runner: el runner lo ejecuta antes del
primer paso de cada trabajo y, si sale con error, el trabajo falla sin correr
ninguno de sus pasos. Solo deja pasar el trabajo `deploy` de `deploy-web.yml` y
de `deploy-admin.yml`, leídos de `master` y lanzados por un push o a mano. Todo
lo demás se rechaza, incluido cualquier caso en que falte un dato.

## Qué mira

Las variables `GITHUB_*` que el runner arma con lo que mandó GitHub. Según el
código del runner, el `env:` del workflow no llega al hook; el paso 2 de
"Verificar" lo comprueba en el VPS con un workflow que intenta imitarlas.

| Variable | Tiene que ser |
|---|---|
| `GITHUB_REPOSITORY` | `AgenciaSeniors/TriciGo` (sin distinguir mayúsculas) |
| `GITHUB_EVENT_NAME` | `push` o `workflow_dispatch` |
| `GITHUB_REF` | `refs/heads/master` |
| `GITHUB_JOB` | `deploy` |
| `GITHUB_WORKFLOW_REF` | `AgenciaSeniors/TriciGo/.github/workflows/deploy-web.yml@refs/heads/master` o la misma con `deploy-admin.yml` |

`GITHUB_WORKFLOW_REF` es el archivo del que salió el trabajo **y la rama de la
que se leyó**. Por eso un workflow modificado en otra rama no pasa, aunque se
llame igual.

Un rechazo:

- deja una línea `::error::` en el log del trabajo;
- escribe en el journal (`journalctl -t tricigo-runner-gate`);
- manda un correo con la misma config que el watchdog de Supabase y la alarma de
  integridad (`/etc/tricigo/supabase-health.env`: `RESEND_API_KEY`,
  `ALERT_EMAIL_TO`). La config se **parsea**, nunca se hace `source`.

Los trabajos permitidos también quedan en el journal.

## Tests

```bash
bash ops/actions-runner/tests/run.sh
```

Corre el hook real con los datos de cada tipo de trabajo, en un entorno limpio
(`env -i`), con un `logger` falso y el Resend falso de
`ops/vps-integrity/tests/mock.py`. Después borra uno por uno los siete chequeos y
exige que, sin cada uno, pase un trabajo que antes se rechazaba. En CI corre
`runner-gate-tests.yml`.

## Antes de instalar: mirar el runner (solo lectura)

```bash
ssh root@187.77.214.236 'cd /root/actions-runner && cat .runner | grep -v -i token; echo; sed -E "s/(TOKEN|KEY|SECRET)=.*/\1=***/I" .env; echo; ./svc.sh status | head -5; ls _diag | tail -3'
```

Fíjate en tres cosas: que el servicio esté `active (running)`, que `.env` no
tenga ya un `ACTIONS_RUNNER_HOOK_JOB_STARTED` y que `.runner` diga
`"gitHubUrl": "https://github.com/AgenciaSeniors/TriciGo"` (un runner del
repositorio, no de la organización).

## Instalar

Desde la PC, en la raíz del repo (los mismos pasos que la alarma de integridad):

```bash
# 1. Copiar el hook y sacarle los finales de línea de Windows.
scp ops/actions-runner/job-gate.sh root@187.77.214.236:/etc/tricigo/runner-job-gate.sh
ssh root@187.77.214.236 "sed -i 's/\r\$//' /etc/tricigo/runner-job-gate.sh && chown root:root /etc/tricigo/runner-job-gate.sh && chmod 700 /etc/tricigo/runner-job-gate.sh && bash -n /etc/tricigo/runner-job-gate.sh && echo listo"

# 2. Probarlo a mano en el VPS: un trabajo ajeno se rechaza, y te llega un correo.
ssh root@187.77.214.236 'GITHUB_REPOSITORY=AgenciaSeniors/TriciGo GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/pull/1/merge GITHUB_JOB=deploy GITHUB_WORKFLOW_REF=AgenciaSeniors/TriciGo/.github/workflows/prueba.yml@refs/pull/1/merge GITHUB_RUN_ID=0 /etc/tricigo/runner-job-gate.sh; echo "salida=$?"'
#    Esperado: una línea ::error::, "salida=1" y un correo "Runner del VPS: trabajo rechazado".

# 3. Activarlo y reiniciar el runner (si hay un deploy corriendo, esperar a que termine).
ssh root@187.77.214.236 'cd /root/actions-runner && (grep -q "^ACTIONS_RUNNER_HOOK_JOB_STARTED=" .env || echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=/etc/tricigo/runner-job-gate.sh" >> .env) && ./svc.sh stop && ./svc.sh start && ./svc.sh status | head -5'
```

## Verificar

1. **Lo legítimo sigue andando.** En GitHub, Actions → Deploy Web → Run workflow
   sobre `master`. En el trabajo "Deploy to VPS (self-hosted)" tiene que aparecer
   un paso nuevo, *A job started hook*, que dice `trabajo permitido`, y el deploy
   tiene que terminar bien.
2. **Lo ajeno no corre.** Una rama de prueba con un workflow que corre en
   `self-hosted`, cuyo trabajo se llama `deploy` y que en su `env:` imita los
   valores de un deploy de master. El trabajo tiene que fallar en el hook, sin
   ejecutar su único paso (un `echo`), y tiene que llegar el correo. Después se
   borra la rama.

Si el paso 1 falla con `::error::`, el correo dice qué dato no coincidió.
Desactivar (abajo) y avisar.

## Desactivar

```bash
ssh root@187.77.214.236 'cd /root/actions-runner && sed -i "/^ACTIONS_RUNNER_HOOK_JOB_STARTED=/d" .env && ./svc.sh stop && ./svc.sh start'
```

## Lo que el filtro no cubre

- **Quien puede escribir en `master`** puede cambiar `deploy-web.yml` y correr lo
  que quiera en el VPS: el filtro confía en `master`. `master` no tiene
  protección de rama: conviene una regla que exija pull request y bloquee el
  force-push y el borrado.
- **El contenido del build.** El deploy ejecuta como root el `server.js` que armó
  el job de build en GitHub; una dependencia comprometida en `pnpm install`
  llega igual. La web y el admin corren como root bajo PM2: pasarlos a un usuario
  sin privilegios achica lo que puede hacer una falla en Next.js.
