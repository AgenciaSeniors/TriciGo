# Email Provider Migration — Supabase Default → Resend

> **Pre-requisito**: Rama A.6 completada (cuenta Resend creada + dominio `tricigo.com` verificado + API key obtenida).
> **Tiempo estimado**: 15-20 minutos.
> **Riesgo**: Bajo — Supabase Auth puede revertir a default SMTP si la migración falla, sin downtime.

---

## ¿Por qué migrar?

| Atributo | Supabase default SMTP | Resend |
|---|---|---|
| Costo | Gratis (incluido en plan) | $20/mes hasta 50k emails |
| Rate limit | 1 email/seg, ~30k/mes | 10 emails/seg, 50k/mes |
| Sender domain | `noreply@mail.app.supabase.io` (genérico) | `no-reply@tricigo.com` (profesional, custom) |
| Deliverability | ~70% inbox (rest spam) | ~95% inbox con SPF/DKIM |
| Templates | Solo via Supabase Auth | Auth + custom transactional |
| Reputation | Compartida (poor) | Domain-isolated (control total) |

**Razón principal**: emails de auth (welcome, magic link, password reset) llegan a spam con default SMTP. Resend con dominio propio + DKIM mejora deliverability 70% → 95%.

---

## Pasos

### 1. Pre-flight (validar cuenta Resend)

```bash
# Confirmar API key funciona
curl -X POST 'https://api.resend.com/emails' \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "no-reply@tricigo.com",
    "to": "test@gmail.com",
    "subject": "Test from Resend",
    "html": "<p>Hello from TriciGo via Resend</p>"
  }'
```

Debe retornar `{"id": "..."}`. Si error `domain_not_verified`, esperar DNS propagation.

### 2. Configurar Supabase Auth SMTP

1. Ir a https://supabase.com/dashboard/project/lqaufszburqvlslpcuac/auth/templates
2. Scroll a "SMTP Settings" → click "Enable Custom SMTP"
3. Llenar:
   ```
   Sender email:    no-reply@tricigo.com
   Sender name:     TriciGo
   Host:            smtp.resend.com
   Port number:     587
   Username:        resend
   Password:        re_XXXXXXXX  (la API key)
   Minimum interval: 60 seconds (default OK)
   ```
4. Click "Save changes".

### 3. Validar smoke test

Triggers de auth que usan SMTP:

```sql
-- Forzar magic link a tu email de prueba
-- En SQL Editor:
SELECT auth.send_magic_link('test@gmail.com');
```

O via app: pedir password reset desde el login screen.

**Esperado**: email llega a inbox (no spam) con remitente `no-reply@tricigo.com`.

### 4. Validar templates con branding TriciGo

Los templates HTML están en `supabase/templates/*.html` (committed by sesión paralela 2026-05-28). Aplicarlos via Supabase Dashboard:

1. Dashboard → Auth → Templates → seleccionar cada uno:
   - Confirm signup
   - Invite user
   - Magic Link
   - Change Email Address
   - Reset Password
   - Reauthentication
2. Click "Use custom template" → paste contenido del `.html` correspondiente del repo.
3. Confirmar variables Supabase Auth disponibles:
   - `{{ .ConfirmationURL }}`
   - `{{ .Token }}`
   - `{{ .SiteURL }}`
   - `{{ .Email }}`

**Templates ya tienen branding TriciGo** (color naranja Cuban Modern + logo).

### 5. Configurar transactional emails (no-auth) via Resend Edge Function

Para emails que NO son auth (ride receipts, wallet receipts, behavioral nudges) que actualmente usan `send-email` EF con Supabase SMTP:

**Decisión**: mantener `send-email` EF actual + agregar nuevo `send-email-resend` EF para usos donde queremos mejor deliverability.

Crear `supabase/functions/send-email-resend/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

interface EmailPayload {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200 });

  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) return new Response(JSON.stringify({ error: 'resend_not_configured' }), { status: 500 });

  const payload: EmailPayload = await req.json();
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'TriciGo <no-reply@tricigo.com>',
      to: Array.isArray(payload.to) ? payload.to : [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      reply_to: payload.reply_to || 'soporte@tricigo.com',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    return new Response(JSON.stringify({ error: err }), { status: response.status });
  }

  const data = await response.json();
  return new Response(JSON.stringify({ success: true, id: data.id }), { status: 200 });
});
```

**Deploy**:
```bash
supabase functions deploy send-email-resend --project-ref lqaufszburqvlslpcuac
supabase secrets set RESEND_API_KEY=re_XXXXXXXX --project-ref lqaufszburqvlslpcuac
```

Update callers que usaban `send-email` para emails críticos (ride receipts) a usar `send-email-resend`.

### 6. Rollback plan (si Resend falla)

Si Resend integration falla:

1. Dashboard Auth → SMTP Settings → "Disable Custom SMTP"
2. Supabase auto-reverte a default SMTP.
3. Sin downtime.

Para `send-email-resend` EF caller code: agregar fallback en código:
```typescript
try {
  await supabase.functions.invoke('send-email-resend', { body: ... });
} catch {
  await supabase.functions.invoke('send-email', { body: ... });  // legacy fallback
}
```

---

## Checklist post-migration

- [ ] Pre-flight curl test OK
- [ ] Supabase Auth SMTP configurado con Resend credentials
- [ ] Smoke test magic link recibido en inbox (no spam) de `gmail.com`
- [ ] Templates HTML applied en Dashboard
- [ ] `send-email-resend` EF deployed
- [ ] `RESEND_API_KEY` secret seteado
- [ ] Callers críticos (ride receipts) migrados a `send-email-resend`
- [ ] Monitor Resend Dashboard primer día: delivery rate, bounces, complaints
- [ ] Update `docs/PUSH_NOTIFICATIONS_SETUP.md` referenciando email pipeline nuevo
