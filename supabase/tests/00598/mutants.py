#!/usr/bin/env python3
"""Mutation check for migration 00598: remove one guard at a time; the test that owns it must fail.

  supabase/tests/00598/mutants.py supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql

Runs run.sh once per mutant with the same environment (PGBIN, PGPORT, PYTHON), about a minute each.
Every mutant here still applies: its migration self-test does not cover that guard. The guards the
self-test does cover are proven by run.sh's own negative proofs (N1-N4).
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.join(HERE, "run.sh").replace("\\", "/")

SIGNUP_HANDLER = (
    "  EXCEPTION WHEN OTHERS THEN\n"
    "    RAISE WARNING 'auto_link_fleet_member_on_signup(%): % %', NEW.id, SQLSTATE, SQLERRM;\n"
    "    PERFORM public.log_rpc_attempt('auto_link_fleet_member_on_signup', NULL, NEW.id, 'link_failed',\n"
    "      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));\n"
)
CONFIRM_LOG = (
    "    PERFORM public.log_rpc_attempt('auto_link_fleet_member_on_phone_confirmed', NULL, NEW.id, 'link_failed',\n"
    "      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));\n"
)
CONFIRM_HANDLER = (
    "  EXCEPTION WHEN OTHERS THEN\n"
    "    RAISE WARNING 'auto_link_fleet_member_on_phone_confirmed(%): % %', NEW.id, SQLSTATE, SQLERRM;\n"
    + CONFIRM_LOG
)
CONFIRM_EVENT = "     OR NOT (OLD.phone_confirmed_at IS NULL OR NEW.phone IS DISTINCT FROM OLD.phone) THEN"
BACKFILL_FILTER = "  WHERE status IN ('approved', 'pending_signup')\n    AND driver_id IS NULL\n) m"

# (guard, text in the migration (exactly once), replacement, tests that must fail)
MUTANTS = [
    # approval
    ("the approval re-evaluates rows that were already approved",
     "  IF TG_OP = 'UPDATE' THEN\n    IF OLD.status IN ('approved', 'pending_signup') THEN\n"
     "      RETURN NEW;\n    END IF;\n  END IF;\n",
     "", ["B3"]),
    ("a NULL status slips through the approval gate",
     "  IF NEW.driver_id IS NOT NULL OR NEW.status IS NULL\n     OR NEW.status NOT IN",
     "  IF NEW.driver_id IS NOT NULL\n     OR NEW.status NOT IN", ["A16"]),
    ("the approval trigger ignores INSERTs",
     "  BEFORE INSERT OR UPDATE OF status ON public.fleet_members",
     "  BEFORE UPDATE OF status ON public.fleet_members", ["A5", "A13"]),
    # the helper
    ("an unconfirmed number counts as verified",
     "    AND au.phone_confirmed_at IS NOT NULL\n    AND u.is_active;\n", "    AND u.is_active;\n",
     ["A11", "X2", "C6"]),
    ("a deactivated account counts as verified",
     "    AND u.is_active;\n", ";\n", ["A10", "C9"]),
    ("the helper guesses between two accounts",
     "CASE WHEN count(*) = 1 THEN", "CASE WHEN count(*) >= 1 THEN", ["A14"]),
    # signup
    ("the signup links a number the account never confirmed",
     "    IF public._user_id_by_verified_phone(v_phone) IS DISTINCT FROM NEW.id THEN\n"
     "      RETURN NEW;\n    END IF;\n\n    PERFORM set_config",
     "    PERFORM set_config", ["X2", "C6"]),
    ("a failure to link fails the signup",
     SIGNUP_HANDLER, "", ["X3"]),
    ("the signup links unreviewed and rejected invitations",
     "      AND status IN ('approved', 'pending_signup')\n", "", ["X4"]),
    ("the signup takes invitations that already name someone",
     "      AND driver_id IS NULL;\n", ";\n", ["X4"]),
    ("the signup drops the '+' of a number outside Cuba",
     "    v_phone := '+' || ltrim(NEW.phone, '+');\n    IF", "    v_phone := NEW.phone;\n    IF", ["X5"]),
    # confirmation
    ("re-confirming an already confirmed number fires again",
     CONFIRM_EVENT,
     "     OR NOT (OLD.phone_confirmed_at IS DISTINCT FROM NEW.phone_confirmed_at OR NEW.phone IS DISTINCT FROM OLD.phone) THEN",
     ["C7"]),
    ("a new number on an account already confirmed is ignored (GoTrue confirms before it sets the phone)",
     CONFIRM_EVENT, "     OR NOT (OLD.phone_confirmed_at IS NULL) THEN", ["C1", "C10"]),
    ("a failure to link fails the confirmation",
     CONFIRM_HANDLER, "", ["C8"]),
    ("a failed link during a confirmation leaves no trace in rpc_attempt_log",
     CONFIRM_LOG, "", ["C8"]),
    ("the confirmation links whichever account holds the number",
     "    IF public._user_id_by_verified_phone(v_phone) IS DISTINCT FROM NEW.id THEN\n"
     "      RETURN NEW;\n    END IF;\n\n    UPDATE public.fleet_members fm",
     "    UPDATE public.fleet_members fm", ["C9"]),
    ("the confirmation links unreviewed and rejected invitations",
     "      AND fm.status IN ('approved', 'pending_signup')\n", "", ["C11"]),
    ("the confirmation takes invitations that already name someone",
     "      AND fm.driver_id IS NULL;\n", ";\n", ["C11"]),
    ("the confirmation drops the '+' of a number outside Cuba",
     "    v_phone := '+' || ltrim(NEW.phone, '+');   -- GoTrue keeps E.164 without '+'",
     "    v_phone := NEW.phone;", ["C12"]),
    ("the confirmation waits for a lock as long as GoTrue's statement lets it",
     " SET lock_timeout TO '2s'\nAS $function$\nDECLARE\n  v_phone text;\nBEGIN\n  -- Fires on every update",
     "AS $function$\nDECLARE\n  v_phone text;\nBEGIN\n  -- Fires on every update", ["D2"]),
    # backfill
    ("the backfill links unreviewed and rejected invitations",
     BACKFILL_FILTER, "  WHERE driver_id IS NULL\n) m", ["M1", "M2"]),
    ("the backfill takes invitations that already name someone",
     BACKFILL_FILTER, "  WHERE status IN ('approved', 'pending_signup')\n) m", ["M1", "M2"]),
]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src = open(sys.argv[1], encoding="utf-8", newline="").read()
    all_caught = True
    for guard, old, new, expected in MUTANTS:
        found = src.count(old)
        if found != 1:
            print(f"BROKEN    {guard}: the anchor appears {found} times", flush=True)
            all_caught = False
            continue
        fd, path = tempfile.mkstemp(suffix=".sql")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(src.replace(old, new))
        try:
            out = subprocess.run(["bash", RUN, path], capture_output=True, text=True).stdout
        finally:
            os.remove(path)
        failing = sorted(set(re.findall(r"^FAIL  (\S+)", out, re.M)))
        applied = "migration failed" not in out
        caught = applied and all(test in failing for test in expected)
        all_caught &= caught
        verdict = "CAUGHT" if caught else ("ABORTED" if not applied else "MISSED")
        print(f"{verdict:8}  {guard}: expected {expected}, failing {failing}", flush=True)
    print("ALL MUTANTS CAUGHT" if all_caught else "SOME MUTANT SURVIVED")
    return 0 if all_caught else 1


if __name__ == "__main__":
    sys.exit(main())
