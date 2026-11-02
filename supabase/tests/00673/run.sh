#!/usr/bin/env bash
# Rehearsal runner for migration 00673 (operator role, delivery 4: support, accounts and moderation).
# Builds the functions 00673 patches as they are in prod (live-bodies.sql, byte for byte), the six
# 00672 ops functions (ops-00672.sql), on the tables of tables.sql, the role checks of base.sql and
# the 00671 helpers (scaffold.sql). process_dispute_refund is a stub here (scaffold.sql): same
# checks and status writes, no ledger; the prod rehearsal runs the real one.
#   supabase/tests/00673/run.sh none
#       -> prod as captured + tests (RED: the ops functions do not exist, the operator is refused)
#   supabase/tests/00673/run.sh supabase/migrations/00673_operator_support_and_moderation.sql
#       -> the same + 00673 applied twice, each in one transaction (GREEN), a snapshot showing it
#          changed no other function, a CRLF copy applied to a fresh database, and negative proofs
#          of the file's own checks
# The lost-item notices, SOS alerts, audit triggers, ride side effects and the RLS are not here: the
# prod rehearsal runs with all of them.
# Cluster: any Postgres 16 with a superuser. Default: psql on 127.0.0.1:${PGPORT:-5433} as pgtest.
#   PSQL="docker exec -i <container> psql -U pgtest" supabase/tests/00673/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
PSQL="${PSQL:-psql -h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest}"
DB=pr673
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ echo "$2" | $PSQL -d "$1" -qAt -v ON_ERROR_STOP=1 -f - 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3] in [$r]"; fi; }
apply(){ local out; if out=$({ echo "$AS_OWNER"; cat "$2"; } | $PSQL -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -f - 2>&1); then echo applied;
         else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
mkdb(){
  echo "DROP DATABASE IF EXISTS $1;" | $PSQL -d postgres -q -f - >/dev/null 2>&1
  echo "CREATE DATABASE $1;" | $PSQL -d postgres -q -f - >/dev/null 2>&1 || { echo "cannot create $1"; exit 1; }
  if ! cat "$DIR/scaffold.sql" "$DIR/tables.sql" "$DIR/base.sql" "$DIR/live-bodies.sql" "$DIR/ops-00672.sql" "$DIR/wiring.sql" \
       | $PSQL -d "$1" -q -v ON_ERROR_STOP=1 -1 -f - >/dev/null 2>&1; then
    echo "scaffold failed for $1"; exit 1
  fi
}

OP=a6730000-0000-4000-8000-000000000001      # operator; passenger of R2 and opener of its dispute
ADM=a6730000-0000-4000-8000-000000000002     # admin
SADM=a6730000-0000-4000-8000-000000000003    # super admin
MKT=a6730000-0000-4000-8000-000000000004     # marketing
CUS=a6730000-0000-4000-8000-000000000005     # passenger
DRV=a6730000-0000-4000-8000-000000000006     # driver (DP1), online, one session
CUS2=a6730000-0000-4000-8000-000000000007    # another passenger
DP1=d6730000-0000-4000-8000-000000000001
R1=b6730000-0000-4000-8000-000000000001      # CUS with DP1, disputed, fare 2000
R2=b6730000-0000-4000-8000-000000000002      # OP with DP1, disputed, fare 1000
T1=c6730000-0000-4000-8000-000000000001      # CUS's ticket, open
TOP=c6730000-0000-4000-8000-000000000002     # the operator's own ticket
I1=e6730000-0000-4000-8000-000000000001      # CUS against DRV on R1, open
I2=e6730000-0000-4000-8000-000000000002      # review_abuse on RV1, open
IOP=e6730000-0000-4000-8000-000000000003     # reported by the operator
RV1=f6730000-0000-4000-8000-000000000001     # DRV about CUS, visible
RVOP=f6730000-0000-4000-8000-000000000002    # the operator about DRV
L1=16730000-0000-4000-8000-000000000001      # CUS's lost item on R1, reported
LOP=16730000-0000-4000-8000-000000000002     # the operator's lost item on R2
D1=26730000-0000-4000-8000-000000000001      # CUS against DRV on R1, open
DOP=26730000-0000-4000-8000-000000000002     # opened by the operator on R2
FA1=36730000-0000-4000-8000-000000000001     # fraud alert about CUS
FAOP=36730000-0000-4000-8000-000000000002    # fraud alert about the operator
CR1=46730000-0000-4000-8000-000000000001     # collusion case DP1 / CUS, pending
CROP=46730000-0000-4000-8000-000000000002    # collusion case DP1 / OP, pending
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
tx(){ echo "BEGIN; $1 ROLLBACK;"; }
call(){ echo "$(as_user $1) SELECT $2; RESET ROLE;"; }

SEED="
INSERT INTO public.users (id, role, is_active, is_test) VALUES
  ('$OP', 'operator', true, false), ('$ADM', 'admin', true, false), ('$SADM', 'super_admin', true, false),
  ('$MKT', 'marketing', true, false), ('$CUS', 'customer', true, false), ('$DRV', 'driver', true, false),
  ('$CUS2', 'customer', true, false);
INSERT INTO auth.users (id) SELECT id FROM public.users;
INSERT INTO auth.sessions (user_id) VALUES ('$DRV'), ('$DRV');
INSERT INTO auth.refresh_tokens (user_id) VALUES ('$DRV');
INSERT INTO public.driver_profiles (id, user_id, status, is_online) VALUES ('$DP1', '$DRV', 'approved', true);
INSERT INTO public.rides (id, customer_id, driver_id, status, final_fare_trc) VALUES
  ('$R1', '$CUS', '$DP1', 'disputed', 2000), ('$R2', '$OP', '$DP1', 'disputed', 1000);
INSERT INTO public.support_tickets (id, user_id, subject, status) VALUES
  ('$T1', '$CUS', 'Cobro doble', 'open'), ('$TOP', '$OP', 'Mi viaje', 'open');
INSERT INTO public.reviews (id, ride_id, reviewer_id, reviewee_id, rating, comment, is_visible) VALUES
  ('$RV1', '$R1', '$DRV', '$CUS', 1, 'Insulto', true), ('$RVOP', '$R2', '$OP', '$DRV', 5, 'Bien', true);
INSERT INTO public.incident_reports (id, ride_id, reported_by, against_user_id, type, status, review_id) VALUES
  ('$I1', '$R1', '$CUS', '$DRV', 'driver_behavior', 'open', NULL),
  ('$I2', NULL, '$CUS', '$DRV', 'review_abuse', 'open', '$RV1'),
  ('$IOP', NULL, '$OP', '$DRV', 'driver_behavior', 'open', NULL);
INSERT INTO public.lost_items (id, ride_id, reporter_id, driver_id, description, status) VALUES
  ('$L1', '$R1', '$CUS', '$DRV', 'Mochila', 'reported'), ('$LOP', '$R2', '$OP', '$DRV', 'Llaves', 'reported');
INSERT INTO public.ride_disputes (id, ride_id, opened_by, respondent_id, reason, status) VALUES
  ('$D1', '$R1', '$CUS', '$DRV', 'overcharge', 'open'), ('$DOP', '$R2', '$OP', '$DRV', 'overcharge', 'open');
INSERT INTO public.fraud_alerts (id, user_id, alert_type) VALUES ('$FA1', '$CUS', 'velocity'), ('$FAOP', '$OP', 'velocity');
INSERT INTO public.cancellation_reviews (id, driver_id, customer_id, status) VALUES
  ('$CR1', '$DP1', '$CUS', 'pending'), ('$CROP', '$DP1', '$OP', 'pending');
DELETE FROM public.test_rating_calls;"

PATCHED_LIST="'tg_ride_disputes_protect_columns','tg_users_protect_admin_fields','admin_set_user_active',
  'detect_collusion_reviews','apply_collusion_sanction','reverse_collusion_sanction'"
CREATED_LIST="'_ops_notice_push','_ops_is_ride_party','ops_update_ticket','ops_reply_ticket','ops_update_incident',
  'ops_update_lost_item','tg_ride_disputes_close_escalations','ops_update_dispute','ops_resolve_dispute_without_refund',
  'ops_escalate_dispute','admin_refund_escalated_dispute','ops_set_review_visibility','ops_resolve_fraud_alert'"
BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($PATCHED_LIST, $CREATED_LIST)"
# md5 of prosrc in prod on 2026-11-02, and after 00673.
OLD_BODIES="admin_set_user_active=4fa49090b30f985f46cf740c300e677f,apply_collusion_sanction=3586cce95c176a1ddf8f15c658a57830,detect_collusion_reviews=94558654ff2fdd4a0482099f2649b690,reverse_collusion_sanction=4724bd489c39c51ab5a4b434993fd4f8,tg_ride_disputes_protect_columns=e7c521901228c1119a51219ea934544c,tg_users_protect_admin_fields=1934b73fc021a66a25ac89502a8a2a06"
NEW_BODIES="_ops_is_ride_party=8511443b949ae86d4c97959ef8d14f63,_ops_notice_push=84e3327e29155deeac108cc6fd54ac6b,admin_refund_escalated_dispute=8cc92ccd8cfca929768415f5c5f311b1,admin_set_user_active=7bdd11ba3b7f174b3ad84e838b81424e,apply_collusion_sanction=e2a208cfbc682610089ec9b49f51e963,detect_collusion_reviews=88441adb2332ff5e779c8f151741b9ea,ops_escalate_dispute=159c6b8f3359205860f1c5404173b95d,ops_reply_ticket=d20d12828bc22e58cadc2445f6cc5af6,ops_resolve_dispute_without_refund=e008abddb995cc28904279cd81e15d79,ops_resolve_fraud_alert=6e5b2cf8bbdce7329be64d247f2459df,ops_set_review_visibility=4c66d286d6cff31e30d8b6f1cafc50cf,ops_update_dispute=2e5d8314a4757d7ded10787366340ff4,ops_update_incident=6e76dd1b1a90847846915ccc94379e31,ops_update_lost_item=a7c1feb3b81ac4154ce9e7144af13ba9,ops_update_ticket=3e0f20ffb58b3a944e45754dfbbf54c5,reverse_collusion_sanction=82d3fca08a18b0f104efb1b8522dd8e5,tg_ride_disputes_close_escalations=b88f991c172074e1f95ce9c4e9c0287a,tg_ride_disputes_protect_columns=20b090fe5136655fc54707335566d88a,tg_users_protect_admin_fields=b7ce2ad1730bbcabae8bae6e612df802"
OTHERS="SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT IN ($PATCHED_LIST, $CREATED_LIST)"
PUSHES="SELECT string_agg(jobname || ':' || (body ->> 'title') || ':' || (SELECT string_agg(x, '+' ORDER BY x) FROM jsonb_array_elements_text(body -> 'user_ids') x), ',' ORDER BY id) FROM public.test_http_calls;"

mkdb $DB
run $DB "$SEED" >/dev/null
val "F0 the scaffold has prod's bodies" "$BODIES" "$OLD_BODIES"
OTHERS_BEFORE=$(run $DB "$OTHERS")

if [ "$MIG" != none ]; then
  r=$(apply $DB "$ROOT/$MIG"); [ "$r" = applied ] && ok "M1 00673 applies (1st)" || ko "M1 00673 applies (1st)" "$r"
  r=$(apply $DB "$ROOT/$MIG"); [ "$r" = applied ] && ok "M2 00673 applies again" || ko "M2 00673 applies again" "$r"
  val "M3 the bodies are 00673's" "$BODIES" "$NEW_BODIES"
  val "M4 no other function changed" "$OTHERS" "$OTHERS_BEFORE"
fi

# ── Before: the operator's direct writes are undone, as since 00668 ──
val "W1 an operator's direct dispute resolution is undone by the dispute trigger" \
    "$(tx "$(as_user $OP) UPDATE public.ride_disputes SET status = 'resolved_driver', admin_notes = 'x' WHERE id = '$D1'; RESET ROLE; SELECT status || ',' || coalesce(admin_notes, '-') FROM public.ride_disputes WHERE id = '$D1';")" \
    "open,-"
val "W2 an operator's direct block is undone by the users trigger" \
    "$(tx "$(as_user $OP) UPDATE public.users SET is_active = false WHERE id = '$CUS'; RESET ROLE; SELECT is_active FROM public.users WHERE id = '$CUS';")" \
    "t"

# ── Tickets ───────────────────────────────────────────────────
val "T1 operator answers an open ticket: support message, in progress, logged" \
    "$(tx "$(call $OP "public.ops_reply_ticket('$T1', '  Ya lo revisamos  ') -> 'message' ->> 'message'")
      SELECT is_admin || ',' || sender_id FROM public.ticket_messages WHERE ticket_id = '$T1';
      SELECT status FROM public.support_tickets WHERE id = '$T1';
      SELECT action || ',' || admin_id FROM public.admin_actions WHERE target_id = '$T1';")" \
    "Ya lo revisamos;true,$OP;in_progress;ticket_reply,$OP"
val "T2 marketing answers too, as support" \
    "$(tx "$(call $MKT "public.ops_reply_ticket('$T1', 'Hola') ->> 'status'") SELECT is_admin FROM public.ticket_messages WHERE ticket_id = '$T1';")" \
    "in_progress;t"
val "T3 never their own ticket; an empty or a long message" \
    "$(tx "$(call $OP "public.ops_reply_ticket('$TOP', 'Hola') ->> 'error'")
      $(call $OP "public.ops_reply_ticket('$T1', '   ') ->> 'error'")
      $(call $OP "public.ops_reply_ticket('$T1', repeat('a', 4001)) ->> 'error'")
      SELECT count(*) FROM public.ticket_messages;")" \
    "self_action;message_required;message_too_long;0"
val "T4 operator resolves: resolved with its date, logged" \
    "$(tx "$(call $OP "public.ops_update_ticket('$T1', 'resolved', 'open') ->> 'status'")
      SELECT status || ',' || (resolved_at IS NOT NULL) || ',' || (updated_at IS NOT NULL) FROM public.support_tickets WHERE id = '$T1';
      SELECT new_values ->> 'status' FROM public.admin_actions WHERE target_id = '$T1';")" \
    "resolved;resolved,true,true;resolved"
val "T5 a status that changed, one that does not exist, their own ticket" \
    "$(tx "$(call $OP "public.ops_update_ticket('$T1', 'closed', 'in_progress') ->> 'error'")
      $(call $OP "public.ops_update_ticket('$T1', 'archivado', 'open') ->> 'error'")
      $(call $OP "public.ops_update_ticket('$TOP', 'closed', 'open') ->> 'error'")")" \
    "ticket_changed;invalid_status;self_action"
val "T6 a passenger is refused" \
    "$(tx "$(call $CUS2 "public.ops_update_ticket('$T1', 'closed', 'open') ->> 'error'") $(call $CUS2 "public.ops_reply_ticket('$T1', 'x') ->> 'error'")")" \
    "forbidden;forbidden"

# ── Incidents ─────────────────────────────────────────────────
val "I1 operator investigates, then resolves with a note" \
    "$(tx "$(call $OP "public.ops_update_incident('$I1', 'investigating', 'open') ->> 'status'")
      $(call $OP "public.ops_update_incident('$I1', 'resolved', 'investigating', 'Hablamos con ambos') ->> 'status'")
      SELECT status || ',' || resolved_by || ',' || resolution_notes FROM public.incident_reports WHERE id = '$I1';
      SELECT string_agg(action, ',' ORDER BY action) FROM public.admin_actions WHERE target_id = '$I1';")" \
    "investigating;resolved;resolved,$OP,Hablamos con ambos;incident_investigating,incident_resolved"
val "I2 resolving a reported review hides it in the same call; the rating is recomputed" \
    "$(tx "$(call $OP "public.ops_update_incident('$I2', 'resolved', 'open', 'Reseña ofensiva', true) ->> 'review_hidden'")
      SELECT is_visible FROM public.reviews WHERE id = '$RV1';
      SELECT count(*) FROM public.test_rating_calls WHERE user_id = '$CUS';
      SELECT string_agg(action, ',' ORDER BY action) FROM public.admin_actions WHERE admin_id = '$OP';")" \
    "true;f;1;hide_review,incident_resolved"
val "I3 hiding a review needs a review_abuse incident being resolved" \
    "$(tx "$(call $OP "public.ops_update_incident('$I1', 'resolved', 'open', NULL, true) ->> 'error'")
      $(call $OP "public.ops_update_incident('$I2', 'dismissed', 'open', NULL, true) ->> 'error'")")" \
    "invalid_request;invalid_request"
val "I4 never their own report; a stale status; a closed incident" \
    "$(tx "$(call $OP "public.ops_update_incident('$IOP', 'dismissed', 'open') ->> 'error'")
      $(call $OP "public.ops_update_incident('$I1', 'resolved', 'investigating') ->> 'error'")
      $(call $OP "public.ops_update_incident('$I1', 'dismissed', 'open') ->> 'status'")
      $(call $OP "public.ops_update_incident('$I1', 'investigating', 'dismissed') ->> 'error'")")" \
    "self_action;incident_changed;dismissed;invalid_transition"
val "I5 marketing is refused" "$(tx "$(call $MKT "public.ops_update_incident('$I1', 'dismissed', 'open') ->> 'error'")")" "forbidden"

# ── Lost items ────────────────────────────────────────────────
val "L1 operator saves notes, then closes the report" \
    "$(tx "$(call $OP "public.ops_update_lost_item('$L1', 'notes', 'reported', 'Llamar al chofer') ->> 'success'")
      $(call $OP "public.ops_update_lost_item('$L1', 'close', 'reported') ->> 'status'")
      SELECT status || ',' || resolved_by || ',' || admin_notes || ',' || (resolved_at IS NOT NULL) FROM public.lost_items WHERE id = '$L1';
      SELECT string_agg(action, ',' ORDER BY action) FROM public.admin_actions WHERE target_id = '$L1';")" \
    "true;closed;closed,$OP,Llamar al chofer,true;lost_item_closed,lost_item_notes"
val "L2 a stale status, a closed report, their own report, an unknown action" \
    "$(tx "$(call $OP "public.ops_update_lost_item('$L1', 'close', 'found') ->> 'error'")
      UPDATE public.lost_items SET status = 'returned' WHERE id = '$L1';
      $(call $OP "public.ops_update_lost_item('$L1', 'close', 'returned') ->> 'error'")
      $(call $OP "public.ops_update_lost_item('$LOP', 'notes', 'reported', 'x') ->> 'error'")
      $(call $OP "public.ops_update_lost_item('$L1', 'borrar', 'returned') ->> 'error'")")" \
    "lost_item_changed;invalid_transition;self_action;invalid_action"

# ── Disputes ──────────────────────────────────────────────────
val "P1 operator takes a dispute: under review, assigned, both parties told" \
    "$(tx "$(call $OP "public.ops_update_dispute('$D1', 'take', 'open') ->> 'status'")
      SELECT status || ',' || assigned_to FROM public.ride_disputes WHERE id = '$D1';
      $PUSHES")" \
    "under_review;under_review,$OP;ops-case-notice:Actualización de disputa:$CUS+$DRV"
val "P2 taken already; notes saved; their own dispute" \
    "$(tx "$(call $OP "public.ops_update_dispute('$D1', 'take', 'open') ->> 'status'")
      $(call $ADM "public.ops_update_dispute('$D1', 'take', 'under_review') ->> 'error'")
      $(call $OP "public.ops_update_dispute('$D1', 'notes', 'under_review', 'Pedir capturas') ->> 'success'")
      SELECT admin_notes FROM public.ride_disputes WHERE id = '$D1';
      $(call $OP "public.ops_update_dispute('$DOP', 'take', 'open') ->> 'error'")")" \
    "under_review;already_assigned;true;Pedir capturas;self_action"
val "P3 operator resolves without refund: driver's favour, ride completed as admin, both told" \
    "$(tx "$(call $OP "public.ops_resolve_dispute_without_refund('$D1', 'no_action', 'open', 'Cobro correcto') ->> 'status'")
      SELECT status || ',' || resolution || ',' || refund_amount_trc || ',' || (resolved_at IS NOT NULL) FROM public.ride_disputes WHERE id = '$D1';
      SELECT status FROM public.rides WHERE id = '$R1';
      SELECT from_status || '>' || to_status || ',' || actor_id || ',' || actor_role FROM public.ride_transitions WHERE ride_id = '$R1';
      $PUSHES")" \
    "resolved_driver;resolved_driver,no_action,0,true;completed;disputed>completed,$OP,admin;ops-case-notice:Disputa resuelta:$CUS+$DRV"
val "P4 resolving needs a note and a no-money resolution; never twice" \
    "$(tx "$(call $OP "public.ops_resolve_dispute_without_refund('$D1', 'warning_issued', 'open', ' ') ->> 'error'")
      $(call $OP "public.ops_resolve_dispute_without_refund('$D1', 'full_refund', 'open', 'motivo') ->> 'error'")
      $(call $OP "public.ops_resolve_dispute_without_refund('$D1', 'warning_issued', 'open', 'Aviso dado') ->> 'status'")
      $(call $OP "public.ops_resolve_dispute_without_refund('$D1', 'no_action', 'resolved_driver', 'otra vez') ->> 'error'")")" \
    "reason_required;invalid_resolution;resolved_driver;invalid_transition"
val "P5 operator escalates: capped at the fare, one pending proposal, dispute escalated" \
    "$(tx "$(call $OP "public.ops_escalate_dispute('$D1', 'partial_refund', 2001, 'open', 'Cobro de más') ->> 'error'")
      $(call $OP "public.ops_escalate_dispute('$D1', 'partial_refund', 1500, 'open', 'Cobró de más') ->> 'status'")
      SELECT status FROM public.ride_disputes WHERE id = '$D1';
      SELECT suggested_trc || ',' || resolution || ',' || status || ',' || escalated_by FROM public.ride_dispute_escalations;
      $(call $OP "public.ops_escalate_dispute('$D1', 'credit', 100, 'escalated', 'Otra propuesta') ->> 'error'")
      $(call $OP "public.ops_escalate_dispute('$D1', 'credit', 100, 'escalated', 'malo') ->> 'error'")")" \
    "amount_exceeds_fare;escalated;escalated;1500,partial_refund,pending,$OP;already_escalated;reason_required"
val "P6 the operator cannot pay it, nor refund directly" \
    "$(tx "$(call $OP "public.ops_escalate_dispute('$D1', 'partial_refund', 1500, 'open', 'Cobró de más') ->> 'status'")
      $(call $OP "public.admin_refund_escalated_dispute((SELECT id FROM public.ride_dispute_escalations), 1500) ->> 'error'")
      SELECT count(*) FROM public.test_refunds;")" \
    "escalated;forbidden;0"
has "P7 process_dispute_refund still refuses the operator" \
    "$(tx "$(call $OP "public.process_dispute_refund('$D1', '$OP', 100, 'credit', 'x')")")" \
    "Forbidden: admin role required"
val "P8 the admin pays the proposal as shown: refunded, linked, both told" \
    "$(tx "$(call $OP "public.ops_escalate_dispute('$D1', 'partial_refund', 1500, 'open', 'Cobró de más') ->> 'status'")
      DELETE FROM public.test_http_calls;
      $(call $ADM "public.admin_refund_escalated_dispute((SELECT id FROM public.ride_dispute_escalations), 1400) ->> 'error'")
      $(call $ADM "public.admin_refund_escalated_dispute((SELECT id FROM public.ride_dispute_escalations), 1500) ->> 'success'")
      SELECT amount || ',' || resolution || ',' || admin_id FROM public.test_refunds;
      SELECT d.status || ',' || d.refund_amount_trc || ',' || e.status || ',' || e.resolved_by || ',' || (e.refund_transaction_id = d.refund_transaction_id)
        FROM public.ride_disputes d JOIN public.ride_dispute_escalations e ON e.dispute_id = d.id WHERE d.id = '$D1';
      SELECT status FROM public.rides WHERE id = '$R1';
      $PUSHES
      $(call $ADM "public.admin_refund_escalated_dispute((SELECT id FROM public.ride_dispute_escalations), 1500) ->> 'error'")")" \
    "escalated;amount_changed;true;1500,partial_refund,$ADM;resolved_rider,1500,refunded,$ADM,true;completed;ops-case-notice:Disputa resuelta:$CUS+$DRV;escalation_closed"
val "P9 a dispute resolved another way closes its proposal" \
    "$(tx "$(call $OP "public.ops_escalate_dispute('$D1', 'credit', 500, 'open', 'Compensación') ->> 'status'")
      $(call $ADM "public.ops_resolve_dispute_without_refund('$D1', 'no_action', 'escalated', 'No corresponde') ->> 'status'")
      SELECT status || ',' || resolved_by FROM public.ride_dispute_escalations;")" \
    "escalated;resolved_driver;closed,$ADM"
val "P10 never a dispute of their own ride; marketing refused" \
    "$(tx "$(call $OP "public.ops_escalate_dispute('$DOP', 'credit', 100, 'open', 'Compensación') ->> 'error'")
      $(call $OP "public.ops_resolve_dispute_without_refund('$DOP', 'no_action', 'open', 'motivo') ->> 'error'")
      $(call $MKT "public.ops_update_dispute('$D1', 'notes', 'open', 'x') ->> 'error'")")" \
    "self_action;self_action;forbidden"

# ── Blocking ──────────────────────────────────────────────────
val "B1 operator blocks a driver: inactive, banned, sessions closed, offline, logged" \
    "$(tx "$(call $OP "public.admin_set_user_active('$DRV', false, 'Fraude') ->> 'sessions_closed'")
      SELECT u.is_active || ',' || (a.banned_until > now() + interval '50 years') FROM public.users u JOIN auth.users a ON a.id = u.id WHERE u.id = '$DRV';
      SELECT count(*) FROM auth.sessions WHERE user_id = '$DRV'; SELECT count(*) FROM auth.refresh_tokens WHERE user_id = '$DRV';
      SELECT is_online FROM public.driver_profiles WHERE id = '$DP1';
      SELECT action || ',' || admin_id || ',' || reason FROM public.admin_actions WHERE target_id = '$DRV';")" \
    "2;false,true;0;0;f;block_user,$OP,Fraude"
val "B2 operator unblocks: active, ban lifted" \
    "$(tx "UPDATE public.users SET is_active = false WHERE id = '$CUS'; UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id = '$CUS';
      $(call $OP "public.admin_set_user_active('$CUS', true) ->> 'is_active'")
      SELECT u.is_active || ',' || (a.banned_until IS NULL) FROM public.users u JOIN auth.users a ON a.id = u.id WHERE u.id = '$CUS';")" \
    "true;true,true"
has "B3 an operator cannot block a team member" "$(tx "$(call $OP "public.admin_set_user_active('$MKT', false, 'motivo')")")" "target_is_staff"
has "B4 nor can an admin block marketing (the gap 00673 closes)" "$(tx "$(call $ADM "public.admin_set_user_active('$MKT', false, 'motivo')")")" "target_is_staff"
val "B5 a super admin can" \
    "$(tx "$(call $SADM "public.admin_set_user_active('$MKT', false, 'motivo') ->> 'is_active'") SELECT is_active FROM public.users WHERE id = '$MKT';")" \
    "false;f"
has "B6 marketing is refused" "$(tx "$(call $MKT "public.admin_set_user_active('$CUS', false, 'motivo')")")" "not_admin"
has "B7 never oneself" "$(tx "$(call $OP "public.admin_set_user_active('$OP', false, 'motivo')")")" "DETAIL:  self"
val "B8 outside the function the operator's block is still undone; the role too, inside it" \
    "$(tx "$(as_user $OP) SELECT public._ops_acting_on('$CUS'); UPDATE public.users SET is_active = false WHERE id = '$CUS'; RESET ROLE; SELECT is_active FROM public.users WHERE id = '$CUS';")" \
    "f;t"

# ── Moderation ────────────────────────────────────────────────
val "V1 operator hides a review: hidden, rating recomputed, logged" \
    "$(tx "$(call $OP "public.ops_set_review_visibility('$RV1', false, true) ->> 'is_visible'")
      SELECT is_visible FROM public.reviews WHERE id = '$RV1';
      SELECT count(*) FROM public.test_rating_calls WHERE user_id = '$CUS';
      SELECT action FROM public.admin_actions WHERE target_id = '$RV1';")" \
    "false;f;1;hide_review"
val "V2 a stale visibility; their own review" \
    "$(tx "$(call $OP "public.ops_set_review_visibility('$RV1', true, false) ->> 'error'") $(call $OP "public.ops_set_review_visibility('$RVOP', false, true) ->> 'error'")")" \
    "review_changed;self_action"
val "X1 operator resolves a fraud alert once; never one about them" \
    "$(tx "$(call $OP "public.ops_resolve_fraud_alert('$FA1', 'Falso positivo') ->> 'success'")
      SELECT resolved || ',' || resolved_by || ',' || resolution_note FROM public.fraud_alerts WHERE id = '$FA1';
      $(call $OP "public.ops_resolve_fraud_alert('$FA1') ->> 'error'")
      $(call $OP "public.ops_resolve_fraud_alert('$FAOP') ->> 'error'")")" \
    "true;true,$OP,Falso positivo;already_resolved;self_action"
val "C1 operator rescans the collusion queue" "$(tx "$(call $OP "public.detect_collusion_reviews() >= 0")")" "t"
val "C2 operator issues a warning: sanctioned, the driver told from the server" \
    "$(tx "$(call $OP "public.apply_collusion_sanction('$CR1', 'warning', 'Patrón repetido', '$OP') ->> 'success'")
      SELECT status || ',' || sanction_type || ',' || reviewed_by FROM public.cancellation_reviews WHERE id = '$CR1';
      $PUSHES")" \
    "true;sanctioned,warning,$OP;ops-case-notice:Aviso de la plataforma:$DRV"
val "C3 reputation, then reversed on appeal" \
    "$(tx "$(call $OP "public.apply_collusion_sanction('$CR1', 'reputation', NULL, '$OP') ->> 'success'")
      SELECT count(*) FROM public.cancellation_rating_events WHERE user_id = '$DRV';
      $(call $OP "public.reverse_collusion_sanction('$CR1', '$OP') ->> 'success'")
      SELECT count(*) FROM public.cancellation_rating_events WHERE user_id = '$DRV';")" \
    "true;1;true;0"
val "C4 never a case they are part of; dismiss sends nothing; marketing refused" \
    "$(tx "$(call $OP "public.apply_collusion_sanction('$CROP', 'warning', NULL, '$OP') ->> 'error'")
      $(call $OP "public.apply_collusion_sanction('$CR1', 'dismiss', NULL, '$OP') ->> 'success'")
      SELECT count(*) FROM public.test_http_calls;
      $(call $MKT "public.apply_collusion_sanction('$CR1', 'dismiss', NULL, '$MKT') ->> 'error'")")" \
    "self_action;true;0;forbidden"

# ── Grants ────────────────────────────────────────────────────
val "G1 the new functions: authenticated yes, anon no; helpers closed" \
    "SELECT bool_and(CASE WHEN p.proname LIKE 'ops\\_%' OR p.proname = 'admin_refund_escalated_dispute'
                          THEN NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                          ELSE NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') END),
            count(*)
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($CREATED_LIST)" "t|13"
val "G2 the proposals: read by authenticated (RLS: ops staff), written by service_role only" \
    "SELECT has_table_privilege('authenticated', 'public.ride_dispute_escalations', 'SELECT'),
            has_table_privilege('authenticated', 'public.ride_dispute_escalations', 'INSERT'),
            has_table_privilege('anon', 'public.ride_dispute_escalations', 'SELECT'),
            has_table_privilege('service_role', 'public.ride_dispute_escalations', 'INSERT'),
            (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ride_dispute_escalations'::regclass)" "t|f|f|t|t"

if [ "$MIG" != none ]; then
  CRLF=$(mktemp); sed 's/$/\r/' "$ROOT/$MIG" > "$CRLF"
  mkdb ${DB}crlf
  r=$(apply ${DB}crlf "$CRLF"); [ "$r" = applied ] && ok "R1 a CRLF copy applies" || ko "R1 a CRLF copy applies" "$r"
  val "R2 the CRLF copy leaves the same bodies, without carriage returns" \
      "$BODIES; SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND position(chr(13) IN p.prosrc) > 0" \
      "$NEW_BODIES;0" ${DB}crlf
  rm -f "$CRLF"

  neg(){ # neg NAME SETUP_SQL EXPECTED_ERROR [FILE]
    mkdb ${DB}neg
    run ${DB}neg "SET ROLE postgres; $2" >/dev/null
    local r; r=$(apply ${DB}neg "${4:-$ROOT/$MIG}")
    if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi
  }
  neg "N1 a body it does not know stops it" \
      "CREATE OR REPLACE FUNCTION public.tg_ride_disputes_protect_columns() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS \$f\$ BEGIN RETURN NEW; END \$f\$;" \
      "tg_ride_disputes_protect_columns() has an unknown body"
  neg "N2 another function calling the ops checks stops it" \
      "CREATE FUNCTION public.zz_probe() RETURNS boolean LANGUAGE sql AS \$f\$ SELECT public.is_ops_staff() \$f\$;" \
      "other functions call the ops checks: zz_probe()"
  neg "N3 a money function naming the operator stops it" \
      "CREATE FUNCTION public.freeze_wallet() RETURNS text LANGUAGE sql AS \$f\$ SELECT 'operator'::text \$f\$;" \
      "a money or role function names the operator"
  neg "N4 an ops function that logs nothing stops it" \
      "CREATE FUNCTION public.ops_zz_probe() RETURNS void LANGUAGE sql SECURITY DEFINER AS \$f\$ SELECT \$f\$;" \
      "ops_zz_probe() is not a proper ops function"
  NOREVOKE=$(mktemp); sed 's/^                       public._ops_is_ride_party(uuid),$/                       public.tg_ride_disputes_close_escalations(),/' "$ROOT/$MIG" > "$NOREVOKE"
  neg "N5 a helper open to clients stops it" "SELECT 1;" "the helpers are open to clients" "$NOREVOKE"
  OPEN=$(mktemp); sed 's/^GRANT SELECT ON public.ride_dispute_escalations TO authenticated;$/GRANT SELECT, INSERT ON public.ride_dispute_escalations TO authenticated;/' "$ROOT/$MIG" > "$OPEN"
  neg "N6 a writable proposals table stops it" "SELECT 1;" "ride_dispute_escalations is not locked down" "$OPEN"
  rm -f "$NOREVOKE" "$OPEN"
  for d in ${DB}crlf ${DB}neg; do echo "DROP DATABASE IF EXISTS $d;" | $PSQL -d postgres -q -f - >/dev/null 2>&1; done
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
