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

# (guard, text in the migration (exactly once), replacement, tests that must fail)
MUTANTS = [
    ("the approval re-evaluates rows that were already approved",
     "  IF TG_OP = 'UPDATE' THEN\n    IF OLD.status IN ('approved', 'pending_signup') THEN\n"
     "      RETURN NEW;\n    END IF;\n  END IF;\n",
     "", ["B3"]),
    ("an unconfirmed number counts as verified",
     "    AND au.phone_confirmed_at IS NOT NULL\n    AND u.is_active;\n", "    AND u.is_active;\n",
     ["A11", "X2", "C6"]),
    ("a deactivated account counts as verified",
     "    AND u.is_active;\n", ";\n", ["A10", "C9"]),
    ("the helper guesses between two accounts",
     "CASE WHEN count(*) = 1 THEN", "CASE WHEN count(*) >= 1 THEN", ["A14"]),
    ("a NULL status slips through the approval gate",
     "  IF NEW.driver_id IS NOT NULL OR NEW.status IS NULL\n     OR NEW.status NOT IN",
     "  IF NEW.driver_id IS NOT NULL\n     OR NEW.status NOT IN", ["A16"]),
    ("the approval trigger ignores INSERTs",
     "  BEFORE INSERT OR UPDATE OF status ON public.fleet_members",
     "  BEFORE UPDATE OF status ON public.fleet_members", ["A5", "A13"]),
    ("the signup links a number the account never confirmed",
     "    IF public._user_id_by_verified_phone(NEW.phone) IS DISTINCT FROM NEW.id THEN\n"
     "      RETURN NEW;\n    END IF;\n\n    PERFORM set_config",
     "    PERFORM set_config", ["X2", "C6"]),
    ("a failure to link fails the signup",
     "  EXCEPTION WHEN OTHERS THEN\n"
     "    RAISE WARNING 'auto_link_fleet_member_on_signup(%): % %', NEW.id, SQLSTATE, SQLERRM;\n",
     "", ["X3"]),
    ("confirming an already confirmed number fires again",
     "        AND (OLD.phone_confirmed_at IS NULL OR NEW.phone IS DISTINCT FROM OLD.phone))",
     "        AND (OLD.phone_confirmed_at IS DISTINCT FROM NEW.phone_confirmed_at OR NEW.phone IS DISTINCT FROM OLD.phone))",
     ["C7"]),
    ("a failure to link fails the confirmation",
     "  EXCEPTION WHEN OTHERS THEN\n"
     "    RAISE WARNING 'auto_link_fleet_member_on_phone_confirmed(%): % %', NEW.id, SQLSTATE, SQLERRM;\n",
     "", ["C8"]),
    ("the confirmation links whichever account holds the number",
     "    IF public._user_id_by_verified_phone(NEW.phone) IS DISTINCT FROM NEW.id THEN\n"
     "      RETURN NEW;\n    END IF;\n\n    UPDATE public.fleet_members fm",
     "    UPDATE public.fleet_members fm", ["C9"]),
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
