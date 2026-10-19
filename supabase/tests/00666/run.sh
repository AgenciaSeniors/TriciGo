#!/usr/bin/env bash
# Rehearsal runner for migration 00666 (local Postgres 16, no PostGIS needed).
#   supabase/tests/00666/run.sh none
#       -> scaffold (prod's live bodies) + tests (RED: the guard still forces drafts, and
#          set_referral_amounts, the bonus column, the bonus trigger and the first-approval
#          record are missing)
#   supabase/tests/00666/run.sh supabase/migrations/00666_marketing_autonomy_driver_signup_bonus.sql
#       -> the same + migration x2 (idempotency) + tests + CRLF copy + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Plan: docs/superpowers/plans/2026-10-19-marketing-autonomy-driver-signup-bonus.md
# Cluster setup: CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00666/run.sh ...
# Another database name (two runs at once): PGDB=<name> ...  (the negative proofs use <name>n)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB="${PGDB:-pr666}"
NEG="${PGDB:-pr666}n"
FRESHLOG="$(mktemp)"; trap 'rm -f "$FRESHLOG"' EXIT
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

# Seeded in scaffold.sql
PLAT=00000000-0000-0000-0000-000000000001     # platform: owns platform_promotions
ANON=00000000-0000-0000-0000-000000000099     # the deleted-account placeholder (00657)
ADMIN=a0000000-0000-4000-8000-000000000001
SUPER=a0000000-0000-4000-8000-000000000002
MARK=a0000000-0000-4000-8000-000000000003     # marketing
RIDER=b0000000-0000-4000-8000-000000000006    # customer, phone 5355500006
DRV1=d0000000-0000-4000-8000-000000000001     # VIGO, phone 5355500011
DRV2=d0000000-0000-4000-8000-000000000002     # VIGO, phone never confirmed
DRV3=d0000000-0000-4000-8000-000000000003     # ZERO (amount 0), phone 5355500013
DRV4=d0000000-0000-4000-8000-000000000004     # no signup code, phone 5355500014
DRV5=d0000000-0000-4000-8000-000000000005     # created by C6: a new account on DRV1's phone, VIGO
DRV6=d0000000-0000-4000-8000-000000000006     # created by C15: a new driver, phone 5355500016, no code yet, not approved
DP1=dd000000-0000-4000-8000-000000000001; DP2=dd000000-0000-4000-8000-000000000002
DP3=dd000000-0000-4000-8000-000000000003; DP4=dd000000-0000-4000-8000-000000000004
DP5=dd000000-0000-4000-8000-000000000005; DP6=dd000000-0000-4000-8000-000000000006
P_LIVE=e0000000-0000-4000-8000-000000000001   # LIVE10: active, used once, approved by ADMIN on 2026-10-01 12:00 UTC
P_PAUSED=e0000000-0000-4000-8000-000000000002 # PAUSED5: paused, unused
P_REF=e0000000-0000-4000-8000-000000000003    # REF15: paused, unused, named by a canceled ride
R1=22222222-0000-4000-8000-000000000001; R2=22222222-0000-4000-8000-000000000002; R3=22222222-0000-4000-8000-000000000003
APPROVED_AT="'2026-10-01 12:00:00+00'"

tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
# client USER SQL: SQL from USER's app session (role authenticated), then back to the test superuser with no JWT
client(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; SET LOCAL request.jwt.claim.sub = '';" "$1" "$2"; }
user_of(){ case "$1" in $DP1) echo $DRV1;; $DP2) echo $DRV2;; $DP3) echo $DRV3;; $DP4) echo $DRV4;; $DP5) echo $DRV5;; $DP6) echo $DRV6;; esac; }
# bonus_ride ID DRIVER_PROFILE CUSTOMER: an accepted ride the driver completes. The driver's JWT is set
# and the update runs as a non-client role, as inside complete_ride_and_pay (SECURITY DEFINER).
bonus_ride(){ echo "SET LOCAL request.jwt.claim.sub = '$(user_of "$2")';
  INSERT INTO public.rides (id, customer_id, driver_id, status) VALUES ('$1', '$3', '$2', 'accepted');
  UPDATE public.rides SET status = 'completed' WHERE id = '$1';
  SET LOCAL request.jwt.claim.sub = '';"; }
# del USER: what deleting the account does (00657): references moved to the placeholder, then the auth
# user deleted (its users row and driver profile go with it). The phone's claim stays (00658).
del(){ echo "UPDATE public.ledger_transactions SET created_by = '$ANON' WHERE created_by = '$1'; DELETE FROM auth.users WHERE id = '$1';"; }
# drv5: a new driver account confirms DRV1's phone and registers with VIGO, then is approved
DRV5_NEW="INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$DRV5', '5355500011', now());
  INSERT INTO public.users (id, role, full_name, phone, signup_code, signup_code_at) VALUES ('$DRV5', 'driver', 'Driver Five', '+5355500011', 'VIGO', now() - interval '2 days');
  INSERT INTO public.driver_profiles (id, user_id, status, approved_at) VALUES ('$DP5', '$DRV5', 'approved', now() - interval '1 day');"
# drv6: a new driver registers (own phone, no code yet); the profile waits for review
DRV6_NEW="INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$DRV6', '5355500016', now());
  INSERT INTO public.users (id, role, full_name, phone) VALUES ('$DRV6', 'driver', 'Driver Six', '+5355500016');
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP6', '$DRV6');"
# approve DP: the panel's write (approveDriver), meant to run as ADMIN through RLS
approve(){ echo "SELECT public.t_try('UPDATE public.driver_profiles SET status = ''approved'', approved_at = now() WHERE id = ''$1''');"; }
FIRST="SELECT (fa.first_approved_at = dp.approved_at) FROM public.driver_first_approvals fa JOIN public.driver_profiles dp ON dp.id = fa.driver_profile_id WHERE dp.id ="
wallet(){ echo "SELECT coalesce((SELECT balance::text FROM public.wallet_accounts WHERE user_id = '$1' AND account_type = 'tricicoin'), 'none');"; }
PLATW="SELECT balance FROM public.wallet_accounts WHERE user_id = '$PLAT' AND account_type = 'platform_promotions';"
bonus(){ echo "UPDATE public.acquisition_codes SET driver_bonus_cup = $2 WHERE code = '$1';"; }
PROMO="SELECT is_active || '|' || pending_approval || '|' || current_uses || '|' || coalesce(created_by::text, 'null') || '|' || coalesce(approved_by::text, 'null')
       || '|' || (approved_at IS NOT NULL) || '|' || revision FROM public.promotions"
KEYS="('referral_bonus_cup', 'referral_bonus_driver_cup', 'referral_welcome_bonus_cup', 'referral_welcome_bonus_driver_cup')"
AMOUNTS="SELECT string_agg(jsonb_typeof(value) || ':' || value::text, '|' ORDER BY length(key), key) FROM public.platform_config WHERE key IN $KEYS;"
SEEDED_AMOUNTS="number:500|number:1000|number:0|number:0"
AUDIT="SELECT count(*) FROM public.admin_actions WHERE action = 'update_platform_config';"
sra(){ echo "SELECT public.set_referral_amounts('$1');"; }
NEWFNS="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('tg_promotions_marketing_guard', 'set_referral_amounts', 'trg_signup_driver_bonus', 'admin_signup_code_stats',
                          'promotion_is_referenced', 'tg_acquisition_codes_bonus_audit', 'tg_driver_profiles_first_approval')"
NEW_MD5="admin_signup_code_stats=c743b9103a7d1eb5b794831072b26b09,promotion_is_referenced=c0a5cd8f27d85b631ca9dde4db26e2ef,set_referral_amounts=cd6a37dea2a53f4674549af28e3c2e9a,tg_acquisition_codes_bonus_audit=c3731384cd8f09884c1be1de4d68a2cc,tg_driver_profiles_first_approval=ac953cb95443b406224b24f94fc7cdef,tg_promotions_marketing_guard=146c9ffc9df39e5f4bbf36b59a17dcb8,trg_signup_driver_bonus=b2f060309058f1cd4a321a08e7acedfc"

# The md5 and the EXECUTE grants in each header of live-bodies.sql (get_service_role_key's body is the scaffold's stand-in).
LIVE_NAMES="'_claim_reward','_gift_wallet_type','_platform_config_audit_value','_platform_config_is_telemetry','_reward_claim_status',
  '_reward_identity_hash','admin_signup_code_stats','apply_signup_code','cron_http_post','cup_to_trc_centavos','current_user_role',
  'ensure_wallet_account','get_current_exchange_rate','get_platform_config_numeric','get_service_role_key','is_admin','is_marketing',
  'is_super_admin','log_rpc_attempt','platform_config_can_read_secrets','platform_config_is_secret','promotion_is_referenced','tg_acquisition_codes_guard',
  'tg_platform_config_audit','tg_promotions_marketing_guard','uid'"
LIVE="SELECT string_agg(proname || '=' || md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE pronamespace IN ('public'::regnamespace, 'auth'::regnamespace) AND proname IN ($LIVE_NAMES) AND proname <> 'get_service_role_key'"
LIVE_MD5="_claim_reward=d9a8726c2f105908c0df7fe8c59b2982,_gift_wallet_type=fc1d4ab1b1ad238af448e32c4064c22d,_platform_config_audit_value=e221259c6ce8fa9322380013075413dd,_platform_config_is_telemetry=f9a571619f76ddd653767f4211c19912,_reward_claim_status=73d57eecb3631f0db8d1bc9d7a71fb30,_reward_identity_hash=4f1942d94b70a77d6b5007d776f5b425,admin_signup_code_stats=22b65e286149e554225824d766ba81f5,apply_signup_code=940d7a1bec4ce8530de97de271541ae5,cron_http_post=15d9ded451c60f92a0fd0a3c4e1ee0ab,cup_to_trc_centavos=f8db4dfddddeef620b300997f7b69c57,current_user_role=cb4a7c12d4e21fe2997135833f141e25,ensure_wallet_account=6f01c44a2ecd5afe0b625347b43c203f,get_current_exchange_rate=7377e83a3477419ad6c3897dca8a2835,get_platform_config_numeric=13d2587037eca74854cf2394ba42a90c,is_admin=22cb75e91980d512498034cd33e1eda2,is_marketing=1903156b6a1218a543888ae2ebfb3656,is_super_admin=5655a4615e92e8b1e323d06c7566b058,log_rpc_attempt=0a902c34a1148dac5686403a7c941bc0,platform_config_can_read_secrets=c38ca8f2ee39238d8c37a3f0b47ac879,platform_config_is_secret=7302ae9b8e160f90a253d5f5ace0f0b5,promotion_is_referenced=d02d1233dcb808f809ff0dcf29818a02,tg_acquisition_codes_guard=383b43d28d0e0598a9233fafd1eba296,tg_platform_config_audit=23121ec16ff092678dae2aca522220ff,tg_promotions_marketing_guard=2b4dd44a23aaf0c01a47b28d6b09cae4,uid=cdef18c69c4f4cbbced2eaf81e628b49"
GRANTEE="CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END"
LIVE_ACL_Q="SELECT string_agg(f.proname || '=' || f.g, ',' ORDER BY f.proname COLLATE \"C\") FROM (
      SELECT p.proname, string_agg($GRANTEE, '+' ORDER BY $GRANTEE COLLATE \"C\") AS g
      FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace) AND p.proname IN ($LIVE_NAMES)
        AND a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE'
      GROUP BY p.proname) f"
LIVE_ACL="_claim_reward=service_role,_gift_wallet_type=PUBLIC+service_role,_platform_config_audit_value=service_role,_platform_config_is_telemetry=service_role,_reward_claim_status=service_role,_reward_identity_hash=service_role,admin_signup_code_stats=authenticated+service_role,apply_signup_code=authenticated+service_role,cron_http_post=service_role,cup_to_trc_centavos=PUBLIC+anon+authenticated+service_role,current_user_role=authenticated+service_role,ensure_wallet_account=authenticated+service_role,get_current_exchange_rate=PUBLIC+anon+authenticated+service_role,get_platform_config_numeric=service_role,get_service_role_key=service_role,is_admin=PUBLIC+anon+authenticated+service_role,is_marketing=anon+authenticated+service_role,is_super_admin=authenticated+service_role,log_rpc_attempt=service_role,platform_config_can_read_secrets=PUBLIC+anon+authenticated+service_role,platform_config_is_secret=PUBLIC+service_role,promotion_is_referenced=authenticated,tg_acquisition_codes_guard=service_role,tg_platform_config_audit=service_role,tg_promotions_marketing_guard=service_role,uid=PUBLIC"

# fresh DB: a new database with the scaffold (and its seed). On a failure it prints what psql said and returns 1.
fresh(){ : > "$FRESHLOG"
         "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>>"$FRESHLOG" \
           || { echo "-- create database failed:"; cat "$FRESHLOG"; return 1; }
         (cd "$DIR" && "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold.sql >/dev/null 2>>"$FRESHLOG") \
           || { echo "-- scaffold.sql failed:"; cat "$FRESHLOG"; return 1; }; }
# VIGO pays 1000 CUP to its drivers, set by an admin through RLS. The column exists only with the migration:
# without it this fails and the bonus tests below are RED.
set_vigo(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "BEGIN; $(client $ADMIN "$(bonus VIGO 1000)") COMMIT;" >/dev/null 2>&1; }
apply_err(){ local out; if out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 the scaffold carries prod's live bodies" "$LIVE" "$LIVE_MD5"
val "S0b ... and their EXECUTE grants as read" "$LIVE_ACL_Q" "$LIVE_ACL"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  set_vigo $DB || echo "-- could not set VIGO's driver bonus"   # set between the two runs: the second one must leave it alone
  # DP3's approval date moves between the runs (C15d): the second run must keep its first approval
  run $DB "UPDATE public.driver_profiles SET approved_at = now() - interval '10 days' WHERE id = '$DP3';" >/dev/null
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1 || { echo "migration NOT idempotent"; exit 1; }
  val "S1 one bonus trigger, bonus column and check, guard, audit and first-approval trigger after two runs; VIGO's amount (audited) survived the second" \
    "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_signup_driver_bonus';
     SELECT count(*) FROM information_schema.columns WHERE table_name = 'acquisition_codes' AND column_name = 'driver_bonus_cup';
     SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.acquisition_codes'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%driver_bonus_cup%';
     SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_promotions_marketing_guard';
     SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_acquisition_codes_bonus_audit';
     SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_driver_profiles_first_approval';
     SELECT driver_bonus_cup FROM public.acquisition_codes WHERE code = 'VIGO';
     SELECT string_agg(admin_id || ':' || target_id || ':' || (old_values->>'driver_bonus_cup') || '>' || (new_values->>'driver_bonus_cup'), ',')
       FROM public.admin_actions WHERE action = 'update_signup_driver_bonus';" "1;1;1;1;1;1;1000;$ADMIN:VIGO:0>1000"
else
  set_vigo $DB || echo "-- RED: VIGO's driver bonus cannot be set (no column)"
fi

echo "== A. promotions: marketing runs them with no approval =="
val "A1 marketing creates a promotion already active: its own, stamped by it, counters and push stamp clean" \
  "$(tx "$(client $MARK "INSERT INTO public.promotions (code, type, discount_percent, is_active, current_uses, approved_by, approved_at, created_by, pending_approval, notified_at)
          VALUES ('MK1', 'percentage_discount', 10, true, 7, '$ADMIN', '2026-01-01', '$RIDER', true, now());")
         $PROMO WHERE code = 'MK1'; SELECT notified_at IS NULL FROM public.promotions WHERE code = 'MK1';")" \
  "true|false|0|$MARK|$MARK|true|0;t"
val "A2 ... or paused, and it does not wait for an admin" \
  "$(tx "$(client $MARK "INSERT INTO public.promotions (code, type, discount_percent, is_active, pending_approval) VALUES ('MK2', 'percentage_discount', 10, false, true);")
         $PROMO WHERE code = 'MK2';")" \
  "false|false|0|$MARK|null|false|0"
val "A3 marketing edits a live promotion: a new revision, the approval stamp kept" \
  "$(tx "$(client $MARK "UPDATE public.promotions SET title_es = 'Nuevo' WHERE id = '$P_LIVE';")
         SELECT revision || '|' || pending_approval || '|' || approved_by || '|' || (approved_at = $APPROVED_AT) || '|' || is_active || '|' || title_es FROM public.promotions WHERE id = '$P_LIVE';")" \
  "1|false|$ADMIN|true|true|Nuevo"
val "A4 marketing turns a paused one on, stamped with its own id" \
  "$(tx "$(client $MARK "UPDATE public.promotions SET is_active = true WHERE id = '$P_PAUSED';") $PROMO WHERE id = '$P_PAUSED';")" \
  "true|false|0|$ADMIN|$MARK|true|0"
val "A5 marketing never writes the use counter, the author, the approval stamps or the revision" \
  "$(tx "$(client $MARK "UPDATE public.promotions SET current_uses = 99, created_by = '$RIDER', approved_by = '$RIDER', approved_at = '2020-01-01', revision = 50 WHERE id = '$P_LIVE';")
         SELECT current_uses || '|' || created_by || '|' || approved_by || '|' || (approved_at = $APPROVED_AT) || '|' || revision FROM public.promotions WHERE id = '$P_LIVE';")" \
  "1|$ADMIN|$ADMIN|true|0"
val "A6 marketing pauses a live one" \
  "$(tx "$(client $MARK "UPDATE public.promotions SET is_active = false WHERE id = '$P_LIVE';")
         SELECT is_active || '|' || pending_approval || '|' || revision || '|' || approved_by FROM public.promotions WHERE id = '$P_LIVE';")" \
  "false|false|0|$ADMIN"
val "A7 marketing still deletes only a paused promotion nothing used or named" \
  "$(tx "$(client $MARK "UPDATE public.promotions SET is_active = false WHERE id = '$P_LIVE';
         SELECT public.t_try('DELETE FROM public.promotions WHERE id = ''$P_LIVE''');
         SELECT public.t_try('DELETE FROM public.promotions WHERE id = ''$P_REF''');
         SELECT public.t_try('DELETE FROM public.promotions WHERE id = ''$P_PAUSED''');")
         SELECT count(*) FROM public.promotions;")" \
  "err:P0001:promo_delete_blocked;err:P0001:promo_delete_blocked;ok:1;2"
val "A8 an admin is unchanged: stamps its activation, leaves a draft as sent, deletes a named one" \
  "$(tx "$(client $ADMIN "INSERT INTO public.promotions (code, type, discount_percent, is_active) VALUES ('AD1', 'percentage_discount', 5, true);
         INSERT INTO public.promotions (code, type, discount_percent, is_active, pending_approval) VALUES ('AD2', 'percentage_discount', 5, false, true);
         SELECT public.t_try('DELETE FROM public.promotions WHERE id = ''$P_REF''');")
         SELECT code || '|' || coalesce(approved_by::text, 'null') || '|' || pending_approval || '|' || (approved_at IS NOT NULL) FROM public.promotions WHERE code IN ('AD1', 'AD2') ORDER BY code;")" \
  "ok:1;AD1|$ADMIN|false|true;AD2|null|true|false"
val "A9 a rider neither sees nor creates promotions" \
  "$(tx "$(client $RIDER "SELECT count(*) FROM public.promotions;
         SELECT public.t_try('INSERT INTO public.promotions (code, type, is_active) VALUES (''RD1'', ''percentage_discount'', true)');")")" \
  "0;err:42501:new row violates row-level security policy for table \"promotions\""
val "A10 a ride's promo claim (SECURITY DEFINER, marketing's JWT set) still moves the use counter" \
  "$(tx "SET LOCAL request.jwt.claim.sub = '$MARK'; SET LOCAL ROLE tricigo_owner;
         UPDATE public.promotions SET current_uses = current_uses + 1 WHERE id = '$P_LIVE';
         RESET ROLE; SET LOCAL request.jwt.claim.sub = '';
         SELECT current_uses || '|' || revision FROM public.promotions WHERE id = '$P_LIVE';")" \
  "2|0"

val "A11 marketing cannot delete a paused, unused promotion a signup code links to; unlinked, it can" \
  "$(tx "UPDATE public.acquisition_codes SET promotion_id = '$P_PAUSED' WHERE code = 'VIGO';
         $(client $MARK "SELECT public.promotion_is_referenced('$P_PAUSED'); SELECT public.t_try('DELETE FROM public.promotions WHERE id = ''$P_PAUSED''');")
         UPDATE public.acquisition_codes SET promotion_id = NULL WHERE code = 'VIGO';
         $(client $MARK "SELECT public.promotion_is_referenced('$P_PAUSED'); SELECT public.t_try('DELETE FROM public.promotions WHERE id = ''$P_PAUSED''');")")" \
  "t;err:P0001:promo_delete_blocked;f;ok:1"
val "A11b an admin still deletes a linked one, and the link is cleared" \
  "$(tx "UPDATE public.acquisition_codes SET promotion_id = '$P_PAUSED' WHERE code = 'VIGO';
         $(client $ADMIN "SELECT public.t_try('DELETE FROM public.promotions WHERE id = ''$P_PAUSED''');")
         SELECT coalesce(promotion_id::text, 'none') FROM public.acquisition_codes WHERE code = 'VIGO';")" \
  "ok:1;none"

echo "== B. referral amounts =="
B1J='{"referral_bonus_cup": 700, "referral_welcome_bonus_driver_cup": 300}'
val "B1 marketing saves two amounts; the answer has the four, stored as JSON numbers" \
  "$(tx "$(client $MARK "$(sra "$B1J")") $AMOUNTS")" \
  '{"amounts": {"referral_bonus_cup": 700, "referral_bonus_driver_cup": 1000, "referral_welcome_bonus_cup": 0, "referral_welcome_bonus_driver_cup": 300}, "success": true};number:700|number:1000|number:0|number:300'
val "B2 one audit row per changed key, naming marketing" \
  "$(tx "$(client $MARK "SELECT public.set_referral_amounts('$B1J')->>'success';")
         SELECT string_agg(admin_id || ':' || target_id || ':' || (old_values->>'value') || '>' || (new_values->>'value'), ',' ORDER BY target_id)
         FROM public.admin_actions WHERE action = 'update_platform_config';")" \
  "true;$MARK:referral_bonus_cup:500>700,$MARK:referral_welcome_bonus_driver_cup:0>300"
val "B3 saving the same values again succeeds and writes no audit row" \
  "$(tx "$(client $MARK "SELECT public.set_referral_amounts('$B1J')->>'success'; SELECT public.set_referral_amounts('$B1J')->>'success';") $AUDIT")" \
  "true;true;2"
val "B4 a regular admin (not super) saves too" \
  "$(tx "$(client $ADMIN "SELECT public.set_referral_amounts('{\"referral_bonus_driver_cup\": 1500}')->>'success';")
         SELECT admin_id || ':' || target_id FROM public.admin_actions WHERE action = 'update_platform_config'; $AMOUNTS")" \
  "true;$ADMIN:referral_bonus_driver_cup;number:500|number:1500|number:0|number:0"
r1=$(run $DB "$(tx "$(client $RIDER "$(sra '{"referral_bonus_cup": 1}')") $AUDIT $AMOUNTS")")
r2=$(run $DB "BEGIN; SET LOCAL ROLE anon; $(sra '{"referral_bonus_cup": 1}') ROLLBACK;")
if [ "$r1" = "{\"error\": \"forbidden\"};0;$SEEDED_AMOUNTS" ] && echo "$r2" | grep -q "permission denied for function set_referral_amounts"; then
  ok "B5 a rider is refused and nothing changes; anon cannot call it"
else ko "B5 a rider is refused and nothing changes; anon cannot call it" "rider [$r1], anon [$r2]"; fi
val "B6 bad amounts and keys are refused, and a bad key next to a good one writes nothing" \
  "$(tx "$(client $MARK "$(sra '{"referral_bonus_cup": -1}') $(sra '{"referral_bonus_cup": 1.5}') $(sra '{"referral_bonus_cup": "500"}')
         $(sra '{"referral_bonus_cup": null}') $(sra '{"referral_bonus_cup": 2147483648}') $(sra '{"x_api_key": 1}') $(sra '{}') $(sra '[1]')
         $(sra '{"referral_bonus_cup": 900, "referral_bonus_driver_cup": -3}')") $AMOUNTS $AUDIT")" \
  "$(printf '%s;' '{"key": "referral_bonus_cup", "error": "invalid_amount"}' '{"key": "referral_bonus_cup", "error": "invalid_amount"}' \
     '{"key": "referral_bonus_cup", "error": "invalid_amount"}' '{"key": "referral_bonus_cup", "error": "invalid_amount"}' \
     '{"key": "referral_bonus_cup", "error": "invalid_amount"}' '{"key": "x_api_key", "error": "unknown_key"}' \
     '{"error": "nothing_to_save"}' '{"error": "nothing_to_save"}' '{"key": "referral_bonus_driver_cup", "error": "invalid_amount"}')$SEEDED_AMOUNTS;0"
val "B7 marketing reads the four amounts (not a secret key) with a plain SELECT" \
  "$(tx "$(client $MARK "SELECT count(*) FROM public.platform_config WHERE key IN $KEYS; SELECT count(*) FROM public.platform_config WHERE key = 'x_api_key';")")" \
  "4;0"
val "B8 marketing still cannot write platform_config directly" \
  "$(tx "$(client $MARK "SELECT public.t_try('UPDATE public.platform_config SET value = ''900'' WHERE key = ''referral_bonus_cup''');") $AMOUNTS")" \
  "ok:0;$SEEDED_AMOUNTS"
val "B9 a missing amount is created, and its audit row names marketing" \
  "$(tx "DELETE FROM public.platform_config WHERE key = 'referral_welcome_bonus_cup';
         $(client $MARK "SELECT public.set_referral_amounts('{\"referral_welcome_bonus_cup\": 50}')->>'success';")
         SELECT action || ':' || (new_values->>'value') FROM public.admin_actions WHERE admin_id = '$MARK'; $AMOUNTS")" \
  "true;insert_platform_config:50;number:500|number:1000|number:50|number:0"

echo "== C. a signup code pays new drivers on their first ride =="
val "C1a the first ride for another person pays the code's amount from platform_promotions" \
  "$(tx "$(bonus_ride $R1 $DP1 $RIDER) $(wallet $DRV1) $PLATW
         SELECT string_agg(amount || '/' || balance_after, ',' ORDER BY amount) FROM public.ledger_entries;")" \
  "1000;-1000;-1000/-1000,1000/1000"
val "C1b ... as one posted promo_credit, one bonus row and the phone's claim" \
  "$(tx "$(bonus_ride $R1 $DP1 $RIDER)
         SELECT count(*) || '|' || max(idempotency_key) || '|' || max(type::text) || '|' || max(status::text) || '|' || max(reference_type)
                || '|' || max(reference_id::text) || '|' || bool_and(description = U&'Bono de bienvenida - c\\00F3digo VIGO') || '|' || max(created_by::text)
           FROM public.ledger_transactions;
         SELECT b.user_id || '|' || b.code || '|' || b.amount_cup || '|' || b.ride_id || '|' || (b.transaction_id = t.id)
           FROM public.signup_driver_bonuses b, public.ledger_transactions t;
         SELECT count(*) || '|' || max(user_id::text) || '|' || max(ride_id::text) || '|' || bool_and(released_at IS NULL)
           FROM public.reward_claims WHERE claim = 'signup_driver_bonus';")" \
  "1|signup_driver_bonus:$DRV1|promo_credit|posted|signup_driver_bonus|$R1|true|$DRV1;$DRV1|VIGO|1000|$R1|true;1|$DRV1|$R1|true"
val "C1c ... and one push to the driver through cron_http_post (its data opens no trip)" \
  "$(tx "$(bonus_ride $R1 $DP1 $RIDER)
         SELECT count(*) FROM net.http_request_queue;
         SELECT (q.body->>'user_id') || '|' || (q.body->>'title') || '|' || (q.body->>'body') || '|' || (q.body->>'category')
                || '|' || (q.body->'data')::text
                || '|' || (q.headers->>'Authorization') || '|' || (q.url LIKE '%/functions/v1/send-push')
           FROM net.http_request_queue q;
         SELECT c.jobname || '|' || (c.request_id = q.id) FROM public.cron_http_calls c, net.http_request_queue q;")" \
  "1;$DRV1|Recibiste un bono de bienvenida|Te acreditamos 1000 CUP en tu billetera por tu primer viaje.|system|{\"event\": \"signup_driver_bonus\", \"amount_cup\": 1000}|Bearer test-service-key|true;signup-driver-bonus|true"
val "C2 a second ride pays nothing more" \
  "$(tx "$(bonus_ride $R1 $DP1 $RIDER) $(bonus_ride $R2 $DP1 $RIDER) $(wallet $DRV1)
         SELECT count(*) FROM public.ledger_transactions; SELECT count(*) FROM public.signup_driver_bonuses; SELECT count(*) FROM net.http_request_queue;")" \
  "1000;1;1;1"
val "C2b only the first ride counts: an amount set after it pays nothing later (control: another code's driver is paid)" \
  "$(tx "$(bonus VIGO 0) $(bonus_ride $R1 $DP1 $RIDER) $(wallet $DRV1)
         $(bonus VIGO 1000) $(bonus_ride $R2 $DP1 $RIDER) $(wallet $DRV1)
         $(bonus ZERO 1000) $(bonus_ride $R3 $DP3 $RIDER) $(wallet $DRV3)")" \
  "none;none;1000"
val "C3 a ride the driver requested for themselves does not count; their first ride for another person pays" \
  "$(tx "$(bonus_ride $R3 $DP1 $DRV1) $(wallet $DRV1) $(bonus_ride $R1 $DP1 $RIDER) $(wallet $DRV1)
         SELECT ride_id FROM public.signup_driver_bonuses;")" \
  "none;1000;$R1"
# the qualifying count alone would let this one through: one earlier ride for another person (that paid
# nothing: the code had no amount yet), and now a ride the driver requested for themselves
val "C3b a ride the driver requested for themselves never pays, even as the second one (control: another code's driver is paid)" \
  "$(tx "$(bonus VIGO 0) $(bonus_ride $R1 $DP1 $RIDER) $(bonus VIGO 1000) $(bonus_ride $R3 $DP1 $DRV1) $(wallet $DRV1)
         $(bonus ZERO 1000) $(bonus_ride $R2 $DP3 $RIDER) $(wallet $DRV3)")" \
  "none;1000"
val "C4 a code with amount 0 pays nothing (control: a VIGO driver in the same transaction is paid)" \
  "$(tx "$(bonus_ride $R1 $DP3 $RIDER) $(wallet $DRV3) SELECT count(*) FROM public.reward_claims;
         $(bonus_ride $R2 $DP1 $RIDER) $(wallet $DRV1)")" \
  "none;0;1000"
val "C5 a driver with no confirmed phone gets nothing, no claim, no bonus row (control: DRV1 is paid)" \
  "$(tx "$(bonus_ride $R1 $DP2 $RIDER) $(wallet $DRV2) SELECT count(*) FROM public.reward_claims; SELECT count(*) FROM public.signup_driver_bonuses;
         $(bonus_ride $R2 $DP1 $RIDER) $(wallet $DRV1)")" \
  "none;0;0;1000"
val "C6 a phone already paid gets nothing on a new account, after the old one was deleted" \
  "$(tx "$(bonus_ride $R1 $DP1 $RIDER) $(wallet $DRV1) $(del $DRV1) $DRV5_NEW $(bonus_ride $R2 $DP5 $RIDER) $(wallet $DRV5)
         SELECT count(*) || '|' || max(user_id::text) FROM public.signup_driver_bonuses;
         SELECT count(*) || '|' || max(user_id::text) FROM public.reward_claims WHERE claim = 'signup_driver_bonus';")" \
  "1000;none;1|$DRV1;1|$DRV1"
val "C6b control: the same new account is paid when the old one never was" \
  "$(tx "$(del $DRV1) $DRV5_NEW $(bonus_ride $R2 $DP5 $RIDER) $(wallet $DRV5)")" \
  "1000"
val "C7 a driver with no signup code gets nothing (control: DRV1 is paid)" \
  "$(tx "$(bonus_ride $R1 $DP4 $RIDER) $(wallet $DRV4) SELECT count(*) FROM public.reward_claims;
         $(bonus_ride $R2 $DP1 $RIDER) $(wallet $DRV1)")" \
  "none;0;1000"
# The payment block fails (ledger_entries refuses every row): the ride is still completed, and the claim,
# the wallets, the ledger and the push are all undone with the block. The trigger leaves a WARNING and a
# row in rpc_attempt_log, written after the block rolled back, so it stays.
C8_WANT="completed|0|0|0|none|0|0|trg_signup_driver_bonus:$DRV1:$R1:payment_failed:23514:VIGO:1000:true"
r=$(run $DB "$(tx "ALTER TABLE public.ledger_entries ADD CONSTRAINT t_fail CHECK (false) NOT VALID;
     $(bonus_ride $R1 $DP1 $RIDER)
     SELECT status || '|' || (SELECT count(*) FROM public.signup_driver_bonuses) || '|' || (SELECT count(*) FROM public.reward_claims)
            || '|' || (SELECT count(*) FROM public.ledger_transactions)
            || '|' || coalesce((SELECT balance::text FROM public.wallet_accounts WHERE user_id = '$DRV1'), 'none')
            || '|' || (SELECT balance FROM public.wallet_accounts WHERE user_id = '$PLAT') || '|' || (SELECT count(*) FROM net.http_request_queue)
            || '|' || (SELECT string_agg(rpc_name || ':' || caller_uid || ':' || target_id || ':' || outcome || ':' || (metadata->>'sqlstate')
                                         || ':' || (metadata->>'code') || ':' || (metadata->>'amount_cup') || ':' || (metadata->>'error' LIKE '%t_fail%'), ',')
                         FROM public.rpc_attempt_log)
       FROM public.rides WHERE id = '$R1';")")
if echo "$r" | grep -q "signup driver bonus failed for ride $R1: 23514" && echo "$r" | grep -q "$C8_WANT"; then
  ok "C8 a failing payment never blocks the ride, undoes the claim with itself and is logged"
else ko "C8 a failing payment never blocks the ride, undoes the claim with itself and is logged" "expected a WARNING and [$C8_WANT], got [$r]"; fi
# ... and a log that fails too (the function raising) still never blocks the ride
r=$(run $DB "$(tx "ALTER TABLE public.ledger_entries ADD CONSTRAINT t_fail CHECK (false) NOT VALID;
     CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb DEFAULT NULL::jsonb)
       RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN RAISE EXCEPTION 'log down'; END \$f\$;
     $(bonus_ride $R1 $DP1 $RIDER)
     SELECT 'ride:' || status FROM public.rides WHERE id = '$R1';")")
if ! echo "$r" | grep -q "ERROR:" && [ "${r##*;}" = "ride:completed" ]; then
  ok "C8b a failing log never blocks the ride either"
else ko "C8b a failing log never blocks the ride either" "got [$r]"; fi
val "C9 completing the same ride again (disputed -> completed) does not pay again" \
  "$(tx "$(bonus_ride $R1 $DP1 $RIDER) UPDATE public.rides SET status = 'disputed' WHERE id = '$R1';
         UPDATE public.rides SET status = 'completed' WHERE id = '$R1'; $(wallet $DRV1)
         SELECT count(*) FROM public.ledger_transactions; SELECT count(*) FROM net.http_request_queue;")" \
  "1000;1;1"
val "C13a a driver who applies the code after their approval gets nothing (control: DRV1, code at signup, is paid)" \
  "$(tx "$(client $DRV4 "SELECT public.apply_signup_code('vigo');") $(bonus_ride $R1 $DP4 $RIDER) $(wallet $DRV4)
         $(bonus_ride $R2 $DP1 $RIDER) $(wallet $DRV1)")" \
  "applied;none;1000"
val "C13b a driver with no approval date gets nothing (control: another code's driver is paid)" \
  "$(tx "UPDATE public.driver_profiles SET approved_at = NULL WHERE id = '$DP1'; $(bonus_ride $R1 $DP1 $RIDER) $(wallet $DRV1)
         $(bonus ZERO 1000) $(bonus_ride $R2 $DP3 $RIDER) $(wallet $DRV3)")" \
  "none;1000"
val "C13c a driver whose code has no date gets nothing (control: another code's driver is paid)" \
  "$(tx "UPDATE public.users SET signup_code_at = NULL WHERE id = '$DRV1'; $(bonus_ride $R1 $DP1 $RIDER) $(wallet $DRV1)
         $(bonus ZERO 1000) $(bonus_ride $R2 $DP3 $RIDER) $(wallet $DRV3)")" \
  "none;1000"
val "C13d a code applied at the very moment of the approval counts" \
  "$(tx "UPDATE public.users SET signup_code_at = (SELECT approved_at FROM public.driver_profiles WHERE id = '$DP1') WHERE id = '$DRV1';
         $(bonus_ride $R1 $DP1 $RIDER) $(wallet $DRV1)")" \
  "1000"
val "C14 each change of a code's driver amount is audited with who made it; an unchanged value or a new code at 0 writes nothing" \
  "$(tx "$(client $MARK "UPDATE public.acquisition_codes SET driver_bonus_cup = 2500 WHERE code = 'VIGO';
         UPDATE public.acquisition_codes SET driver_bonus_cup = 2500 WHERE code = 'VIGO';
         UPDATE public.acquisition_codes SET label = 'Vigo dos' WHERE code = 'VIGO';
         INSERT INTO public.acquisition_codes (code, label, channel) VALUES ('NEWZ', 'Cero', 'otro');
         INSERT INTO public.acquisition_codes (code, label, channel, driver_bonus_cup) VALUES ('NEWC', 'Nuevo', 'otro', 300);")
         SELECT string_agg(admin_id || ':' || target_type || ':' || target_id || ':' || coalesce(old_values::text, 'NULL') || '>' || new_values::text, ',' ORDER BY target_id)
           FROM public.admin_actions WHERE action = 'update_signup_driver_bonus' AND admin_id <> '$ADMIN';")" \
  "$MARK:acquisition_code:NEWC:NULL>{\"driver_bonus_cup\": 300},$MARK:acquisition_code:VIGO:{\"driver_bonus_cup\": 1000}>{\"driver_bonus_cup\": 2500}"
# The panel rewrites approved_at on every approval (approveDriver). The bonus compares the code's date
# with the driver's FIRST approval, recorded once by a trigger on driver_profiles.
val "C15a a driver re-approved today after adding the code yesterday gets nothing; their first approval keeps its date (control: DRV1 is paid)" \
  "$(tx "$(client $DRV4 "SELECT public.apply_signup_code('vigo');") UPDATE public.users SET signup_code_at = now() - interval '1 day' WHERE id = '$DRV4';
         $(client $ADMIN "SELECT public.t_try('UPDATE public.driver_profiles SET status = ''under_review'' WHERE id = ''$DP4''');
         $(approve $DP4)") $(bonus_ride $R1 $DP4 $RIDER) $(wallet $DRV4)
         SELECT (fa.first_approved_at < now() - interval '29 days') || '|' || (dp.approved_at = now())
           FROM public.driver_first_approvals fa JOIN public.driver_profiles dp ON dp.id = fa.driver_profile_id WHERE dp.id = '$DP4';
         $(bonus_ride $R2 $DP1 $RIDER) $(wallet $DRV1)")" \
  "applied;ok:1;ok:1;none;true|true;1000"
val "C15b a new driver who applied the code and is then approved for the first time is recorded and paid; a profile inserted already approved is recorded too" \
  "$(tx "$DRV6_NEW $(client $DRV6 "SELECT public.apply_signup_code('VIGO');")
         SELECT count(*) FROM public.driver_first_approvals WHERE driver_profile_id = '$DP6';
         $(client $ADMIN "$(approve $DP6)") $FIRST '$DP6'; $(bonus_ride $R1 $DP6 $RIDER) $(wallet $DRV6)
         $(del $DRV1) $DRV5_NEW $FIRST '$DP5';")" \
  "applied;0;ok:1;t;1000;t"
val "C15c with no first-approval row the approval date decides: an old code pays, a code added after the approval does not" \
  "$(tx "DELETE FROM public.driver_first_approvals WHERE driver_profile_id IN ('$DP1', '$DP4');
         $(bonus_ride $R1 $DP1 $RIDER) $(wallet $DRV1)
         $(client $DRV4 "SELECT public.apply_signup_code('vigo');") $(bonus_ride $R2 $DP4 $RIDER) $(wallet $DRV4)")" \
  "1000;applied;none"
val "C15d one first approval per approved profile; DP3's approval date moved between the two runs and its row kept the first one" \
  "SELECT count(*) FROM public.driver_first_approvals;
   SELECT (fa.first_approved_at < now() - interval '29 days') || '|' || (dp.approved_at > now() - interval '11 days')
     FROM public.driver_first_approvals fa JOIN public.driver_profiles dp ON dp.id = fa.driver_profile_id WHERE dp.id = '$DP3';" \
  "4;true|true"
# Recording the first approval fails (the table refuses every row): the approval still goes through.
r=$(run $DB "$(tx "$DRV6_NEW ALTER TABLE public.driver_first_approvals ADD CONSTRAINT t_fail CHECK (false) NOT VALID;
     $(client $ADMIN "$(approve $DP6)")
     SELECT 'profile:' || status || '|' || (SELECT count(*) FROM public.driver_first_approvals WHERE driver_profile_id = '$DP6')
       FROM public.driver_profiles WHERE id = '$DP6';")")
if echo "$r" | grep -q "first approval of driver profile $DP6 not recorded: 23514" && echo "$r" | grep -q "ok:1" \
   && [ "${r##*;}" = "profile:approved|0" ]; then
  ok "C15e a failure to record the first approval never blocks the approval"
else ko "C15e a failure to record the first approval never blocks the approval" "got [$r]"; fi
r1=$(run $DB "$(tx "$(bonus_ride $R1 $DP1 $RIDER) $(client $MARK "SELECT code || '|' || driver_bonus_cup || '|' || drivers_bonus_paid || '|' || driver_bonus_paid_cup
       FROM public.admin_signup_code_stats() ORDER BY code COLLATE \"C\";")")")
r2=$(run $DB "$(tx "$(client $RIDER "SELECT count(*) FROM public.admin_signup_code_stats();")")")
if [ "$r1" = "VIGO|1000|1|1000;ZERO|0|0|0" ] && echo "$r2" | grep -q "42501: Admin only"; then
  ok "C10 marketing sees each code's amount and what it paid; a rider is refused"
else ko "C10 marketing sees each code's amount and what it paid; a rider is refused" "marketing [$r1], rider [$r2]"; fi
val "C11a marketing sets and creates codes with an amount through RLS; a rider changes nothing" \
  "$(tx "$(client $MARK "SELECT public.t_try('UPDATE public.acquisition_codes SET driver_bonus_cup = 2500 WHERE code = ''VIGO''');
         SELECT public.t_try('INSERT INTO public.acquisition_codes (code, label, channel, driver_bonus_cup) VALUES (''NEWC'', ''Nuevo'', ''otro'', 300)');")
         $(client $RIDER "SELECT public.t_try('UPDATE public.acquisition_codes SET driver_bonus_cup = 9 WHERE code = ''VIGO''');")
         SELECT string_agg(code || ':' || driver_bonus_cup, ',' ORDER BY code COLLATE \"C\") FROM public.acquisition_codes;")" \
  "ok:1;ok:1;ok:0;NEWC:300,VIGO:2500,ZERO:0"
err "C11b a negative amount is refused" \
  "$(tx "$(client $MARK "UPDATE public.acquisition_codes SET driver_bonus_cup = -5 WHERE code = 'VIGO';")")" \
  "acquisition_codes_driver_bonus_cup_check"
val "C12 the fifteen stats columns from before are unchanged, on data where none of them is 0" \
  "$(tx "UPDATE public.users SET signup_code = 'VIGO' WHERE id = '$RIDER';
         UPDATE public.driver_profiles SET status = 'under_review' WHERE id = '$DP2';
         UPDATE public.acquisition_codes SET promotion_id = '$P_LIVE' WHERE code = 'VIGO';
         INSERT INTO public.rides (id, customer_id, driver_id, status, promo_code_id) VALUES ('$R1', '$RIDER', '$DP1', 'accepted', '$P_LIVE');
         UPDATE public.rides SET status = 'completed' WHERE id = '$R1';
         $(client $MARK "SELECT code || '|' || label || '|' || channel || '|' || audience || '|' || is_active || '|' || (created_at IS NOT NULL) || '|' || signups
           || '|' || rider_signups || '|' || driver_signups || '|' || drivers_approved || '|' || riders_with_ride || '|' || drivers_with_ride
           || '|' || promotion_id || '|' || promotion_code || '|' || promo_rides FROM public.admin_signup_code_stats() WHERE code = 'VIGO';
         SELECT string_agg(t.code, ',' ORDER BY t.ordinality) FROM public.admin_signup_code_stats() WITH ORDINALITY t;")")" \
  "VIGO|Vigo|influencer|ambos|true|true|3|1|2|1|1|1|$P_LIVE|LIVE10|1;VIGO,ZERO"

if [ "$MIG" != "none" ]; then
  echo "== G. permissions and shape =="
  val "G1 signup_driver_bonuses: RLS on, no policies, only the service role reads or writes it" \
    "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.signup_driver_bonuses'::regclass;
     SELECT count(*) FROM pg_policy WHERE polrelid = 'public.signup_driver_bonuses'::regclass;
     SELECT has_table_privilege('anon', 'public.signup_driver_bonuses', 'SELECT') || '|' || has_table_privilege('authenticated', 'public.signup_driver_bonuses', 'SELECT')
            || '|' || has_table_privilege('authenticated', 'public.signup_driver_bonuses', 'INSERT') || '|' || has_table_privilege('service_role', 'public.signup_driver_bonuses', 'INSERT');" \
    "t;0;false|false|false|true"
  err "G1b ... a signed-in marketing user cannot read it" \
    "$(tx "$(client $MARK "SELECT count(*) FROM public.signup_driver_bonuses;")")" "permission denied for table signup_driver_bonuses"
  val "G1c driver_first_approvals: RLS on, no policies, only the service role reads or writes it" \
    "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.driver_first_approvals'::regclass;
     SELECT count(*) FROM pg_policy WHERE polrelid = 'public.driver_first_approvals'::regclass;
     SELECT has_table_privilege('anon', 'public.driver_first_approvals', 'SELECT') || '|' || has_table_privilege('authenticated', 'public.driver_first_approvals', 'SELECT')
            || '|' || has_table_privilege('authenticated', 'public.driver_first_approvals', 'INSERT') || '|' || has_table_privilege('service_role', 'public.driver_first_approvals', 'INSERT');" \
    "t;0;false|false|false|true"
  val "G2 EXECUTE: set_referral_amounts, the stats and promotion_is_referenced for authenticated, not anon; the three trigger functions for neither" \
    "SELECT has_function_privilege('anon', 'public.set_referral_amounts(jsonb)', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.set_referral_amounts(jsonb)', 'EXECUTE')
            || '|' || has_function_privilege('anon', 'public.admin_signup_code_stats()', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.admin_signup_code_stats()', 'EXECUTE')
            || '|' || has_function_privilege('service_role', 'public.admin_signup_code_stats()', 'EXECUTE')
            || '|' || has_function_privilege('anon', 'public.trg_signup_driver_bonus()', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.trg_signup_driver_bonus()', 'EXECUTE')
            || '|' || has_function_privilege('anon', 'public.tg_acquisition_codes_bonus_audit()', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.tg_acquisition_codes_bonus_audit()', 'EXECUTE')
            || '|' || has_function_privilege('anon', 'public.promotion_is_referenced(uuid)', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.promotion_is_referenced(uuid)', 'EXECUTE')
            || '|' || has_function_privilege('anon', 'public.tg_driver_profiles_first_approval()', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.tg_driver_profiles_first_approval()', 'EXECUTE');" \
    "false|true|false|true|true|false|false|false|false|false|true|false|false"
  val "G3 the guard is SECURITY INVOKER and the enabled trigger on promotions; the bonus, audit and first-approval triggers; promotion_is_referenced keeps its definer and path" \
    "SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_promotions_marketing_guard()'::regprocedure;
     SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_promotions_marketing_guard';
     SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_signup_driver_bonus';
     SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_acquisition_codes_bonus_audit';
     SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_driver_profiles_first_approval';
     SELECT prosecdef || '|' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.promotion_is_referenced(uuid)'::regprocedure;" \
    "f;O;CREATE TRIGGER trg_signup_driver_bonus AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = 'completed'::ride_status) AND (old.status IS DISTINCT FROM 'completed'::ride_status))) EXECUTE FUNCTION trg_signup_driver_bonus();CREATE TRIGGER trg_acquisition_codes_bonus_audit AFTER INSERT OR UPDATE OF driver_bonus_cup ON public.acquisition_codes FOR EACH ROW EXECUTE FUNCTION tg_acquisition_codes_bonus_audit();CREATE TRIGGER trg_driver_profiles_first_approval AFTER INSERT OR UPDATE OF status ON public.driver_profiles FOR EACH ROW WHEN ((new.status = 'approved'::driver_status)) EXECUTE FUNCTION tg_driver_profiles_first_approval();true|search_path=\"\""
  val "G4 the seven bodies after 00666" "$NEWFNS" "$NEW_MD5"

  echo "== N. negative proofs: the migration refuses or catches what it must =="
  # a fresh negative-proof database (the proofs are worthless on a half-built one)
  fresh_neg(){ fresh $NEG || { echo "negative-proof database failed"; exit 1; }; }
  body_md5(){ run "$1" "SELECT md5(prosrc) FROM pg_proc WHERE proname = '$2'"; }
  # mutant FILE SED-SCRIPT: FILE is a copy of the migration with one sed edit; returns 1 when the edit changed nothing
  mutant(){ sed -e "$2" "$MIG" > "$1"; ! cmp -s "$MIG" "$1"; }
  # neg_mutant ID LABEL SED-SCRIPT WANT: a fresh database, the migration with one edit; it has to abort with WANT
  neg_mutant(){ local id="$1" label="$2" script="$3" want="$4" f r; f="$(mktemp)"
    if ! mutant "$f" "$script"; then ko "$id $label" "setup did not change the migration copy"; rm -f "$f"; return; fi
    fresh_neg; r=$(apply_err $NEG "$f"); rm -f "$f"
    if echo "$r" | grep -q "$want"; then ok "$id $label"; else ko "$id $label" "expected an abort like [$want], got [$r]"; fi; }

  fresh_neg
  b=$(body_md5 $NEG tg_promotions_marketing_guard)
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_promotions_marketing_guard()'::regprocedure),
            E'  RETURN NEW;\nEND;', E'  RETURN NEW; -- local edit\nEND;'); END \$x\$;" >/dev/null
  if [ "$(body_md5 $NEG tg_promotions_marketing_guard)" = "$b" ]; then ko "N1 a guard body it does not know aborts it" "setup did not change the body"
  else
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "tg_promotions_marketing_guard() is not the body read from prod" \
      && ok "N1 a guard body it does not know aborts it" || ko "N1 a guard body it does not know aborts it" "got [$r]"
  fi
  fresh_neg
  b=$(body_md5 $NEG admin_signup_code_stats)
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.admin_signup_code_stats()'::regprocedure),
            'ORDER BY count(u.id) DESC', 'ORDER BY count(u.id) ASC'); END \$x\$;" >/dev/null
  if [ "$(body_md5 $NEG admin_signup_code_stats)" = "$b" ]; then ko "N2 a stats body it does not know aborts it" "setup did not change the body"
  else
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "admin_signup_code_stats() is not the body read from prod" \
      && ok "N2 a stats body it does not know aborts it" || ko "N2 a stats body it does not know aborts it" "got [$r]"
  fi
  neg_mutant N3 "an edited bonus trigger body aborts it" \
    's/-- No code, a code that pays nothing, or a ride the driver requested for themselves\./-- No code, a code that pays nothing, or a ride the driver asked for themselves./' \
    "trg_signup_driver_bonus has an unexpected body"
  fresh_neg
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$NEWFNS")" = "$NEW_MD5" ] \
     && [ "$(run $NEG "SELECT count(*) FROM pg_proc WHERE position(chr(13) IN prosrc) > 0")" = "0" ]; then
    ok "N4 pasted with CRLF line ends, the bodies match the LF ones"
  else ko "N4 pasted with CRLF line ends, the bodies match the LF ones" "apply [$r], bodies [$(run $NEG "$NEWFNS")]"; fi
  # the self-checks at the end of the migration, each seen to fire
  neg_mutant N5 "a SECURITY DEFINER guard aborts it" \
    '/^CREATE OR REPLACE FUNCTION public.tg_promotions_marketing_guard()$/,/^AS \$function\$$/s/^ LANGUAGE plpgsql$/ LANGUAGE plpgsql SECURITY DEFINER/' \
    "the promotions guard is not an enabled SECURITY INVOKER trigger"
  neg_mutant N6 "anon keeping EXECUTE on set_referral_amounts aborts it" \
    's/^REVOKE ALL ON FUNCTION public.set_referral_amounts(jsonb) FROM PUBLIC, anon;$/REVOKE ALL ON FUNCTION public.set_referral_amounts(jsonb) FROM PUBLIC;/' \
    "wrong EXECUTE grants on the new functions"
  neg_mutant N7 "authenticated keeping its default privileges on the lock table aborts it" \
    's/^REVOKE ALL ON public.signup_driver_bonuses FROM PUBLIC, anon, authenticated;$/REVOKE ALL ON public.signup_driver_bonuses FROM PUBLIC, anon;/' \
    "signup_driver_bonuses is not a service-role-only lock table"
  neg_mutant N8 "a bonus trigger function without SECURITY DEFINER aborts it" \
    '/^CREATE OR REPLACE FUNCTION public.trg_signup_driver_bonus()$/,/^AS \$function\$$/{/^ SECURITY DEFINER$/d}' \
    "trg_signup_driver_bonus() is not SECURITY DEFINER with a fixed search_path"
  # a re-run meets a stats body it does not know, with the new result type: it must not replace it
  fresh_neg
  r=$(apply_err $NEG "$MIG")
  if [ "$r" != applied ]; then ko "N9 a re-run over an unknown stats body with the new columns aborts it" "the first apply failed: [$r]"
  else
    b=$(body_md5 $NEG admin_signup_code_stats)
    run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.admin_signup_code_stats()'::regprocedure),
              'ORDER BY count(u.id) DESC', 'ORDER BY count(u.id) ASC'); END \$x\$;" >/dev/null
    if [ "$(body_md5 $NEG admin_signup_code_stats)" = "$b" ]; then ko "N9 a re-run over an unknown stats body with the new columns aborts it" "setup did not change the body"
    else
      r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "admin_signup_code_stats() is not the body read from prod" \
        && ok "N9 a re-run over an unknown stats body with the new columns aborts it" || ko "N9 a re-run over an unknown stats body with the new columns aborts it" "got [$r]"
    fi
  fi
  fresh_neg
  b=$(body_md5 $NEG promotion_is_referenced)
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.promotion_is_referenced(uuid)'::regprocedure),
            'THEN false', 'THEN false /* local edit */'); END \$x\$;" >/dev/null
  if [ "$(body_md5 $NEG promotion_is_referenced)" = "$b" ]; then ko "N10 a promotion_is_referenced body it does not know aborts it" "setup did not change the body"
  else
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "promotion_is_referenced(uuid) is not the body read from prod" \
      && ok "N10 a promotion_is_referenced body it does not know aborts it" || ko "N10 a promotion_is_referenced body it does not know aborts it" "got [$r]"
  fi
  neg_mutant N11 "a bonus trigger that fires on any update aborts it" \
    's/^  AFTER UPDATE OF status ON public.rides$/  AFTER UPDATE ON public.rides/' \
    "trg_signup_driver_bonus is not the expected trigger on rides"
  neg_mutant N12 "anon keeping EXECUTE on the bonus trigger function aborts it" \
    's/^REVOKE ALL ON FUNCTION public.trg_signup_driver_bonus() FROM PUBLIC, anon, authenticated;$/REVOKE ALL ON FUNCTION public.trg_signup_driver_bonus() FROM PUBLIC, authenticated;/' \
    "wrong EXECUTE grants on the new functions"
  neg_mutant N13 "the service role losing EXECUTE on the stats aborts it" \
    's/^REVOKE ALL ON FUNCTION public.admin_signup_code_stats() FROM PUBLIC, anon;$/REVOKE ALL ON FUNCTION public.admin_signup_code_stats() FROM PUBLIC, anon, service_role;/; s/^GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO authenticated, service_role;$/GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO authenticated;/' \
    "wrong EXECUTE grants on the new functions"
  neg_mutant N14 "an audit trigger function without SECURITY DEFINER aborts it" \
    '/^CREATE OR REPLACE FUNCTION public.tg_acquisition_codes_bonus_audit()$/,/^AS \$function\$$/{/^ SECURITY DEFINER$/d}' \
    "tg_acquisition_codes_bonus_audit() is not SECURITY DEFINER with a fixed search_path"
  neg_mutant N16 "anon keeping EXECUTE on the first-approval trigger function aborts it" \
    's/^REVOKE ALL ON FUNCTION public.tg_driver_profiles_first_approval() FROM PUBLIC, anon, authenticated;$/REVOKE ALL ON FUNCTION public.tg_driver_profiles_first_approval() FROM PUBLIC, authenticated;/' \
    "wrong EXECUTE grants on the new functions"
  neg_mutant N17 "a first-approval trigger that fires on every status aborts it" \
    "/^  WHEN (NEW.status = 'approved')$/d" \
    "trg_driver_profiles_first_approval is not the expected trigger on driver_profiles"
  neg_mutant N18 "authenticated keeping its default privileges on the first-approval table aborts it" \
    's/^REVOKE ALL ON public.driver_first_approvals FROM PUBLIC, anon, authenticated;$/REVOKE ALL ON public.driver_first_approvals FROM PUBLIC, anon;/' \
    "driver_first_approvals is not a service-role-only lock table"
  neg_mutant N19 "a first-approval trigger function without SECURITY DEFINER aborts it" \
    '/^CREATE OR REPLACE FUNCTION public.tg_driver_profiles_first_approval()$/,/^AS \$function\$$/{/^ SECURITY DEFINER$/d}' \
    "tg_driver_profiles_first_approval() is not SECURITY DEFINER with a fixed search_path"
  neg_mutant N20 "a backfill that leaves an approved profile out aborts it" \
    "s/^  WHERE dp.approved_at IS NOT NULL$/  WHERE dp.approved_at IS NOT NULL AND dp.id <> '$DP3'/" \
    "a driver profile with an approval date has no first-approval row"
  # the trigger checks in \$verify\$ pin search_path; applied as through the dashboard or MCP, with
  # public on the path, it must still pass (and leave the session's path as it found it)
  fresh_neg
  r=$("$BIN/psql" $CONN -d $NEG -qAt -v ON_ERROR_STOP=1 -1 -c "SET SESSION AUTHORIZATION tricigo_owner; SET search_path = \"\$user\", public, extensions" \
        -f "$MIG" -c "SHOW search_path" 2>&1 | tr -d '\r' | tail -1)
  if [ "$r" = '"$user", public, extensions' ] && [ "$(run $NEG "$NEWFNS")" = "$NEW_MD5" ]; then
    ok "N15 applied with public on the search_path, it passes its checks and restores the path"
  else ko "N15 applied with public on the search_path, it passes its checks and restores the path" "got [$r]"; fi
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
  echo "== bodies after 00666 (copy into CLAUDE.md) =="
  "$BIN/psql" $CONN -d "$DB" -qAt -c "SELECT string_agg(proname || ' ' || md5(prosrc) || '/' || length(prosrc), E'\n' ORDER BY proname COLLATE \"C\") FROM pg_proc
           WHERE pronamespace = 'public'::regnamespace
             AND proname IN ('tg_promotions_marketing_guard', 'set_referral_amounts', 'trg_signup_driver_bonus', 'admin_signup_code_stats',
                             'promotion_is_referenced', 'tg_acquisition_codes_bonus_audit', 'tg_driver_profiles_first_approval')" | tr -d '\r'
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
