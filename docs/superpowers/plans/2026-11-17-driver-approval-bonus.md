# Driver approval bonus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first approval of a driver pays the configured approval bonus (5000 CUP) in the same transaction, whoever approves (admin or operator), once per person.

**Architecture:** Migration 00691 adds `platform_config.driver_approval_bonus_cup`, a money helper `_pay_driver_approval_bonus` closed to clients, and patches the live body of `ops_set_driver_status` (00672) so a profile's first approval calls it and returns the outcome as `bonus`. The panel shows the outcome in the approval toast. Spec: `docs/superpowers/specs/2026-11-17-driver-approval-bonus-design.md`.

**Tech Stack:** Postgres (Supabase, plpgsql), TypeScript (`@tricigo/api`, vitest), Next.js admin panel, i18next.

---

### Task 1: Migration 00691

**Files:**
- Create: `supabase/migrations/00691_driver_approval_bonus.sql`

- [x] **Step 1:** Capture the live body of `ops_set_driver_status` from prod (`prosrc`, md5 `a27519ab241af329cf374c9921e6479c`), without transcribing it: one `execute_sql` that returns it padded to 150 000 characters, so the tool saves the output to a file; decode it with Python and compare its md5.
- [x] **Step 2:** Write the migration: config key, helper, md5-guarded patch of five pieces of the live body, phone claims for every driver approved so far, carriage-return cleanup, self-checks. No backslash anywhere (it must travel through `execute_sql` unchanged).
- [x] **Step 3:** Compute the md5 of the helper's body (the text between its `$function$` quotes) and of the patched body (the five replacements applied to the captured `prosrc`) with Python, and write them into the migration: helper `26d54b40b6770e5cb2269fd32d522878`, patched `13154cbfcbcd4e63000d19aec08f07f1`.

### Task 2: Rehearsal in prod

**Files:**
- Create: `supabase/tests/00691/prod-rehearsal.template.sql`
- Create: `supabase/tests/00691/make-rehearsal.py`
- Create (generated): `supabase/tests/00691/prod-rehearsal.sql`

- [x] **Step 1:** Template: one `DO` block that checks the md5 of the pasted migration, seeds four drivers in review (fictional numbers +1 202 555 0191..0194, `is_test`), makes QA Pasajero the operator, then runs RED (the approval pays nothing), a CRLF copy, the migration twice, and the cases (operator and admin first approvals pay; re-approval, phone already claimed, amount 0, invalid amounts, a failing payment, no phone, a driver approved before; grants), plus three negative proofs of the migration's own checks. It always ends with `RAISE EXCEPTION`, so nothing stays.
- [x] **Step 2:** `python -I supabase/tests/00691/make-rehearsal.py` builds `prod-rehearsal.sql`.
- [x] **Step 3:** Run it in prod with `execute_sql`. Result on 2026-11-17: `REHEARSAL 00691: 25 checks, 0 failures. claims=246 | 818 ms`.
  Renumbered from 00686 to 00691 on 2026-11-20 (master took 00686 for `00686_reclaim_released_ride.sql`); the md5 of the patched body changed with its comments, and the rehearsal ran again: `25 checks, 0 failures. claims=249 | 1102 ms`. Then confirm prod is unchanged (no helper, original md5, no key, no claims, no test users).

### Task 3: The service returns the bonus

**Files:**
- Modify: `packages/api/src/services/onboarding.service.ts`
- Modify: `packages/api/src/index.ts:161`
- Test: `packages/api/src/services/__tests__/onboarding.test.ts`

- [x] **Step 1: Write the failing tests** in the `onboardingService.setDriverStatus` describe:

```ts
  it('returns the approval bonus the server paid', async () => {
    mockRpc.mockResolvedValueOnce(ok({
      success: true, status: 'approved', previous_status: 'under_review',
      bonus: { status: 'paid', amount_cup: 5000, transaction_id: 'tx-1' },
    }));

    const result = await onboardingService.setDriverStatus('d-1', 'approved', 'under_review');

    expect(result.bonus).toEqual({ status: 'paid', amountCup: 5000 });
  });

  it('returns no bonus when the approval was not the first', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'approved', bonus: null }));

    const result = await onboardingService.setDriverStatus('d-1', 'approved', 'suspended');

    expect(result.bonus).toBeNull();
  });

  it('returns no bonus before 00691 and ignores a bonus it does not know', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'approved' }));
    mockRpc.mockResolvedValueOnce(ok({ success: true, bonus: { status: 'something_new' } }));

    expect((await onboardingService.setDriverStatus('d-1', 'approved', 'under_review')).bonus).toBeNull();
    expect((await onboardingService.setDriverStatus('d-2', 'approved', 'under_review')).bonus).toBeNull();
  });

  it('keeps an outcome without an amount', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, bonus: { status: 'no_phone' } }));

    const result = await onboardingService.setDriverStatus('d-1', 'approved', 'under_review');

    expect(result.bonus).toEqual({ status: 'no_phone', amountCup: null });
  });
```

- [x] **Step 2:** Run `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/onboarding.test.ts`. Expected: the four new tests FAIL (`result` is undefined).

- [x] **Step 3: Implement** in `onboarding.service.ts`:

```ts
/** What the approval did with the driver approval bonus (00691). */
export type ApprovalBonusStatus =
  | 'paid'            // credited now
  | 'already_paid'    // this account or this phone got it before
  | 'no_phone'        // no confirmed phone: one bonus per person needs one
  | 'disabled'        // driver_approval_bonus_cup is 0
  | 'invalid_amount'  // the amount in Settings is not a whole number from 1 to 50000
  | 'failed'          // the payment failed; the approval stands
  | 'no_driver';

export interface ApprovalBonus {
  status: ApprovalBonusStatus;
  /** CUP credited, when paid. */
  amountCup: number | null;
}

export interface DriverStatusResult {
  /** Null unless the decision was the profile's first approval (or before 00691 is applied). */
  bonus: ApprovalBonus | null;
}

const APPROVAL_BONUS_STATUSES: ReadonlySet<string> = new Set<ApprovalBonusStatus>([
  'paid', 'already_paid', 'no_phone', 'disabled', 'invalid_amount', 'failed', 'no_driver',
]);

function parseApprovalBonus(raw: unknown): ApprovalBonus | null {
  if (!raw || typeof raw !== 'object') return null;
  const { status, amount_cup: amount } = raw as Record<string, unknown>;
  if (typeof status !== 'string' || !APPROVAL_BONUS_STATUSES.has(status)) return null;
  return { status: status as ApprovalBonusStatus, amountCup: typeof amount === 'number' ? amount : null };
}
```

and `setDriverStatus` returns `Promise<DriverStatusResult>`:

```ts
    const result = await callOps('ops_set_driver_status', { ... });
    return { bonus: parseApprovalBonus(result.bonus) };
```

Export the types from `packages/api/src/index.ts`:

```ts
export type { DriverDecision, ReviewDecision, OutreachChannelCode, ApprovalBonus, ApprovalBonusStatus, DriverStatusResult } from './services/onboarding.service';
```

- [x] **Step 4:** Run the same vitest command. Expected: all PASS.
- [x] **Step 5:** Commit.

### Task 4: The panel says what happened to the bonus

**Files:**
- Create: `apps/admin/src/lib/approvalBonus.ts`
- Modify: `apps/admin/src/app/drivers/[id]/page.tsx` (`handleApprove`)
- Modify: `apps/admin/src/app/settings/platform-config/page.tsx` (`KNOWN_KEYS`)
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json` (`drivers.approved_bonus_*`, `platform_config.driver_approval_bonus_cup_help`)

- [x] **Step 1:** `approvalBonus.ts`: `approvalToast(bonus)` returns `{ type: 'success' | 'warning', key, defaultValue, values? }` for each status (`paid` with `{{amount}}` from `formatCUP`; `no_phone`, `invalid_amount` and `failed` are warnings; null, `disabled`-less approvals fall back to `drivers.approved_success`).
- [x] **Step 2:** `handleApprove` shows `t(toast.key, { ...toast.values, defaultValue: toast.defaultValue })`, warnings for 10 s.
- [x] **Step 3:** `KNOWN_KEYS.driver_approval_bonus_cup` with its help text in es/en/pt.
- [x] **Step 4:** `pnpm --filter @tricigo/admin check-types` (or `pnpm check-types`) and the i18n/copy tests (`pnpm --filter @tricigo/utils exec vitest run copyTuteo`). Expected: PASS.
- [x] **Step 5:** Commit.

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (new section after the operator role; one line in "Entrega 2")

- [x] **Step 1:** Section "Bono de aprobación del conductor (00691)": what pays it, once per person, how to change or turn off the amount, the failure log, how to see who got it, what the operator can and cannot do, and the rehearsal.
- [x] **Step 2:** Commit.

### Task 6: Hand-over

- [ ] Ask the owner for the OK to apply 00691 in prod (MCP `apply_migration`, re-checking master and open PRs for 00691 just before), then to push and open the PR (title and body in Portuguese). After applying: verify by object (md5 of both bodies, grants, the key, one claim per approved driver with a confirmed phone: 249 on 2026-11-20) and that admins stop loading the bonus by hand.
