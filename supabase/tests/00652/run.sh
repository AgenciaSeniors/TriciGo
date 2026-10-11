#!/usr/bin/env bash
# Rehearsal runner for migration 00652 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00652/run.sh none
#       -> scaffold + tests (RED: there is no weekly voseo check)
#   supabase/tests/00652/run.sh supabase/migrations/00652_weekly_copy_voseo_check.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proof of the self-test (GREEN)
# The test database uses an ICU en-US collation, like prod's en_US.UTF-8: with collation C,
# [[:alpha:]] does not match accented letters (that is what the self-test guards against).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00652/run.sh ...
# All SQL goes to psql through stdin, never -c: on Windows a -c argument is
# re-encoded to the ANSI code page and accented letters stop being UTF-8.
set -u -o pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr652
RESULTS=$(mktemp); trap 'rm -f "$RESULTS"' EXIT
ok(){ echo "PASS  $1"; echo P >> "$RESULTS"; }
ko(){ echo "FAIL  $1  -- $2"; echo F >> "$RESULTS"; }
# q DB  (SQL on stdin) -> rows joined with ';', errors included
q(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f - 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME EXPECTED  (SQL on stdin, run in $DB)
val(){ local r; r=$(q "$DB"); if [ "$r" = "$2" ]; then ok "$1"; else ko "$1" "expected [$2], got [$r]"; fi; }
migrate(){ $BIN/psql $CONN -d "$1" -qAt -1 -v ON_ERROR_STOP=1 -f "$2" 2>&1 | tr -d '\r'; }
fresh(){ # fresh DB LOCALE_CLAUSE
  printf 'DROP DATABASE IF EXISTS %s;\nCREATE DATABASE %s TEMPLATE template0 ENCODING %s %s;\n' "$1" "$1" "'UTF8'" "$2" \
    | $BIN/psql $CONN -d postgres -qAt -v ON_ERROR_STOP=1 -f - >/dev/null 2>&1 || return 1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
ICU="LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C'"

fresh $DB "$ICU" || { echo "scaffold failed (does this Postgres have ICU?)"; exit 1; }
echo "SELECT 'elegís' ~ '^[[:alpha:]]+\$', lower('PODÉS');" | val "F1 test database reads accents like prod (ICU en-US)" "t|podés"

if [ "$MIG" != none ]; then
  OUT=$(migrate $DB "$MIG"); [ $? -eq 0 ] && ok "M1 migration applies" || ko "M1 migration applies" "$OUT"
  OUT=$(migrate $DB "$MIG"); [ $? -eq 0 ] && ok "M2 migration applies twice" || ko "M2 migration applies twice" "$OUT"
fi

echo "SELECT jobname || '|' || schedule || '|' || command FROM cron.job WHERE jobname = 'check-copy-voseo';" \
  | val "T1 cron job scheduled once, Mondays 13:00 UTC" "check-copy-voseo|0 13 * * 1|SELECT public.check_copy_voseo();"

cat <<'EOF' | val "T2 voseo_forms is the test's list (1911 forms, accents intact)" "1911|true|true|true|false|false"
SELECT count(*) || '|' || bool_or(w = 'podés') || '|' || bool_or(w = 'elegís') || '|' || bool_or(w = 'añadís')
       || '|' || bool_or(w = 'tomate') || '|' || bool_or(w = 'tomás')
FROM public.voseo_forms() AS w;
EOF

cat <<'EOF' | val "T3 voseo_hits finds accented, uppercase and NFD voseo and the verb sos" "{elegís,podés}|{podés}|{\"sos <palabra>\"}"
SELECT public.voseo_hits('Ya PODÉS ver tu viaje y elegís al chofer')::text || '|'
    || public.voseo_hits('Ya pode' || chr(769) || 's ver')::text || '|'
    || public.voseo_hits('si sos conductor')::text;
EOF

cat <<'EOF' | val "T4 voseo_hits leaves tuteo, the preterite and the SOS button alone" "{}"
SELECT public.voseo_hits('Ya puedes ver tu viaje. Pedí por error. SOS activado. Escríbenos. Inténtalo de nuevo.');
EOF

SEED=$(cat <<'EOF'
TRUNCATE cms_content, blog_posts, home_announcements, promotions, driver_quests, review_tag_definitions,
         trip_insurance_configs, service_type_configs, campaigns, notifications, sms_log, sent_mail;
DELETE FROM platform_config;
INSERT INTO platform_config (key, value) VALUES
  ('business_notification_email', to_jsonb('ops1@example.com, ops2@example.com'::text)),
  ('support_banner', to_jsonb('Escribinos por WhatsApp'::text)),
  ('cron_sql_health_detail', to_jsonb('sin fallas desde acá'::text)),
  ('welcome_text', to_jsonb('Bienvenido: pide tu viaje'::text));
INSERT INTO cms_content (slug, title_es, body_es) VALUES
  ('privacy', 'Política de privacidad', 'Datos de tus contactos que ingresás manualmente.'),
  ('terms', 'Términos', 'Al usar TriciGo aceptas estos términos.');
INSERT INTO blog_posts (slug, title_es, excerpt_es, body_es, is_published) VALUES
  ('bienvenidos', 'Bienvenidos', 'Movilidad cubana', 'Elegís al chofer. Sumate vos también.', false),
  ('guia', 'Guía', 'Cómo pedir', 'Pides el viaje y eliges al chofer.', true);
INSERT INTO home_announcements (title_es, body_es, cta_label_es) VALUES ('Nuevo', 'Ya puedes pagar con saldo', 'Ver más');
INSERT INTO promotions (code, title_es, body_es) VALUES ('BIENVENIDA', '25 % menos', 'Usá el código y pagá menos');
INSERT INTO review_tag_definitions (tag_key, label_es) VALUES ('punctual', 'Puntual');
INSERT INTO service_type_configs (slug, name_es) VALUES ('triciclo_basico', 'Triciclo');
INSERT INTO campaigns (name, message_title, message_body, sent_at) VALUES
  ('Vieja', 'Probá gratis', 'Ya pasó', now() - interval '30 days'),
  ('Activacion', 'Activá tu cuenta', 'Te esperamos', NULL);
INSERT INTO notifications (type, title, body, created_at) VALUES
  ('ride', '¿Ves a tu conductor?', 'Tu conductor llegó. Confirmá el viaje.', now() - interval '1 day'),
  ('payment', 'Pago', 'Intentalo nuevamente.', now() - interval '20 days'),
  ('<x>', 'Aviso', 'Revisá tu correo', now() - interval '2 days');
INSERT INTO sms_log (event_type, message_body, created_at) VALUES
  ('sos', 'Juan activó SOS. Seguilo en: https://tricigo.com/t/abc', now() - interval '3 days');
EOF
)
FINDINGS="SELECT string_agg(source || '=' || hits, ' | ' ORDER BY source COLLATE \"C\") FROM public.copy_voseo_findings();"
EXPECTED='blog:bienvenidos (despublicado)=elegís, sumate, vos | campaña:Activacion=activá | cms:privacy=ingresás | platform_config:support_banner=escribinos | promoción:BIENVENIDA=pagá, usá | push (8 días):<x>=revisá | push (8 días):ride=confirmá | sms (8 días):sos=seguilo'
CHECK="SELECT r ->> 'status' || '|' || (r ->> 'findings') || '|' || (r ->> 'emails_sent') FROM (SELECT public.check_copy_voseo() AS r) t;"

echo "$SEED $FINDINGS" | val "T5 findings: admin copy, recent pushes and SMS; old and telemetry rows left out" "$EXPECTED"

echo "$CHECK" | val "T6 first run e-mails each address" "found|8|2"
cat <<'EOF' | val "T7 the alert goes through cron_http_post with its label, HTML escaped" "2|copy-voseo-alert|[TriciGo] Hay voseo en textos que ven los usuarios|true|false"
SELECT count(*) || '|' || min(label) || '|' || min(subject) || '|'
    || bool_and(html LIKE '%&lt;x&gt;%') || '|' || bool_or(html LIKE '%<td style="padding:6px;border-bottom:1px solid #eee"><x>%')
FROM sent_mail;
EOF
cat <<'EOF' | val "T8 state stored in platform_config" "found|true|true|8 con voseo"
SELECT (SELECT value #>> '{}' FROM platform_config WHERE key = 'copy_voseo_status') || '|'
    || (SELECT length(value #>> '{}') = 32 FROM platform_config WHERE key = 'copy_voseo_signature') || '|'
    || (SELECT value IS NOT NULL FROM platform_config WHERE key = 'copy_voseo_at') || '|'
    || (SELECT split_part(value #>> '{}', ':', 1) FROM platform_config WHERE key = 'copy_voseo_detail');
EOF
echo "$CHECK" | val "T9 same findings next week: no e-mail" "found|8|0"
echo "INSERT INTO home_announcements (title_es, body_es) VALUES ('Promo', 'Tocá acá'); $CHECK" \
  | val "T10 a new finding e-mails again" "found|9|2"
cat <<'EOF' | val "T11 all fixed: one recovery e-mail, then silence" "ok|0|2;[TriciGo] Ya no hay voseo en los textos revisados;ok|0|0"
UPDATE cms_content SET body_es = 'Datos de tus contactos que ingresas manualmente.' WHERE slug = 'privacy';
UPDATE blog_posts SET body_es = 'Eliges al chofer. Súmate tú también.' WHERE slug = 'bienvenidos';
UPDATE promotions SET body_es = 'Usa el código y paga menos';
UPDATE campaigns SET message_title = 'Activa tu cuenta' WHERE name = 'Activacion';
UPDATE platform_config SET value = to_jsonb('Escríbenos por WhatsApp'::text) WHERE key = 'support_banner';
DELETE FROM notifications WHERE created_at > now() - interval '8 days';
DELETE FROM sms_log;
DELETE FROM home_announcements WHERE title_es = 'Promo';
DELETE FROM sent_mail;
SELECT r ->> 'status' || '|' || (r ->> 'findings') || '|' || (r ->> 'emails_sent') FROM (SELECT public.check_copy_voseo() AS r) t;
SELECT DISTINCT subject FROM sent_mail;
SELECT r ->> 'status' || '|' || (r ->> 'findings') || '|' || (r ->> 'emails_sent') FROM (SELECT public.check_copy_voseo() AS r) t;
EOF
cat <<'EOF' | val "T12 clean first run: no e-mail" "ok|0|0"
DELETE FROM platform_config WHERE key LIKE 'copy\_voseo\_%';
SELECT r ->> 'status' || '|' || (r ->> 'findings') || '|' || (r ->> 'emails_sent') FROM (SELECT public.check_copy_voseo() AS r) t;
EOF
cat <<'EOF' | val "T13 over 40 findings: 40 rows in the e-mail and a pointer to the rest" "45|2;2|true|true"
DELETE FROM sent_mail;
INSERT INTO review_tag_definitions (tag_key, label_es) SELECT 'tag' || g, 'Revisá ' || g FROM generate_series(1, 45) g;
SELECT r ->> 'findings' || '|' || (r ->> 'emails_sent') FROM (SELECT public.check_copy_voseo() AS r) t;
SELECT count(*) || '|'
    || bool_and((length(html) - length(replace(html, '<tr><td', ''))) / length('<tr><td') = 40)::text || '|'
    || bool_and(html LIKE '%Y 5 lugares más%')::text
FROM sent_mail;
EOF
cat <<'EOF' | val "T14 no business_notification_email: state kept, no e-mail" "found|0"
DELETE FROM platform_config WHERE key = 'business_notification_email';
UPDATE review_tag_definitions SET label_es = 'Llamá ' || tag_key WHERE tag_key = 'tag1';
SELECT r ->> 'status' || '|' || (r ->> 'emails_sent') FROM (SELECT public.check_copy_voseo() AS r) t;
EOF
cat <<'EOF' | val "T15 only service_role can execute the four functions" "false|false|true"
SELECT bool_or(has_function_privilege('anon', f, 'EXECUTE')) || '|'
    || bool_or(has_function_privilege('authenticated', f, 'EXECUTE')) || '|'
    || bool_and(has_function_privilege('service_role', f, 'EXECUTE'))
FROM unnest(ARRAY['public.voseo_forms()', 'public.voseo_hits(text)', 'public.copy_voseo_findings()',
                  'public.check_copy_voseo()']::regprocedure[]) AS f;
EOF

if [ "$MIG" != none ]; then
  # N1: in a database whose collation is C the check would be blind; the migration must refuse to install.
  fresh pr652c "LOCALE 'C'" || { echo "scaffold failed"; exit 1; }
  OUT=$(migrate pr652c "$MIG"); RC=$?
  [ $RC -ne 0 ] && echo "$OUT" | grep -q "the weekly check would be blind" \
    && ok "N1 with collation C the migration refuses to install" || ko "N1 with collation C the migration refuses to install" "rc=$RC $OUT"
  echo "SELECT count(*) FROM pg_proc WHERE proname = 'check_copy_voseo';" | q pr652c | grep -qx 0 \
    && ok "N1b and leaves nothing behind" || ko "N1b and leaves nothing behind" "check_copy_voseo exists"

  # N2: the file pasted from Windows (CRLF) into the SQL Editor installs and detects the same.
  fresh pr652crlf "$ICU" || { echo "scaffold failed"; exit 1; }
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  OUT=$(migrate pr652crlf "$CRLF"); RC=$?; rm -f "$CRLF"
  R=$(echo "SELECT count(*) || '|' || public.voseo_hits('Ya PODÉS ver')::text FROM public.voseo_forms();" | q pr652crlf)
  [ $RC -eq 0 ] && [ "$R" = "1911|{podés}" ] \
    && ok "N2 a CRLF copy installs and finds the same" || ko "N2 a CRLF copy installs and finds the same" "rc=$RC got [$R] $OUT"
fi

PASS=$(grep -c P "$RESULTS"); FAIL=$(grep -c F "$RESULTS")
echo "---- $PASS passed, $FAIL failed ----"
[ "$FAIL" -eq 0 ]
