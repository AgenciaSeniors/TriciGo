# The driver approval bonus is paid by the approval

Date: 2026-11-17. Builds on the operator role (00668, 00672) and the one-per-phone rewards of 00658.

## Problem

Every approved driver gets a bonus in their `tricicoin` wallet: 10 000 CUP until late August 2026,
5 000 CUP since. Nothing pays it automatically. An admin loads it by hand with `admin_adjust_wallet`
right after approving, with a free-text reason ("Fundador", "Bono", "Bono conductor"...). Measured in
prod on 2026-11-17:

- 242 of the 243 approved real drivers got it. The one who did not was approved on 2026-07-12.
- Super admins pay it in the same minute they approve. The 7 drivers an operator approved on
  2026-11-15 waited 17 to 21 hours, until a super admin paid them: operators approve drivers
  (`ops_set_driver_status`, 00672) but cannot move money.
- Paying by hand goes wrong: on 2026-11-17 one driver got it twice two minutes apart (not reverted),
  and a driver re-approved after a change got it a second time (reverted a minute later).
- There was no `platform_config` key and no automatic mechanism for this bonus.

## Decision (owner, 2026-11-17)

The approval pays it (option A), whoever approves: admin, super admin or operator. Rejected
alternative: a "Pagar bono" button for operators (a scoped money RPC), because someone has to
remember to press it, and admins could still pay by hand twice.

## Design

### Amount

`platform_config.driver_approval_bonus_cup`, seeded at 5000. 0 turns the bonus off. Anything that is
not a whole number between 1 and 50 000 pays nothing and leaves an `invalid_amount` row in
`rpc_attempt_log`: a typo with extra zeros never reaches a wallet. The key is in Settings →
Platform config with a help text.

### When it pays

Inside `ops_set_driver_status`, in the same transaction that approves, and only on the profile's
first approval: the profile has no `approved_at` and no `driver_first_approvals` row before the
update. A re-approval (after a suspension, a rejection or a vehicle change, 00650) pays nothing.

### Once per person

- Per account: the ledger idempotency key `driver_approval_bonus:<user_id>`. A profile deleted and
  created again for the same account does not pay twice.
- Per confirmed phone: `_claim_reward(user, 'driver_approval_bonus')` (00658). A new account with the
  same phone does not pay twice. With no confirmed phone the bonus is not paid (`no_phone`), the rule
  the owner set for one-per-person rewards in 00658. 242 of the 243 approved real drivers have one.

### Drivers approved before this

They never get it from the new rule: they all have their first approval already. The migration also
claims the phone of every driver approved so far, so a new account with the same phone does not get
it again. People who got the bonus by hand and then had it taken back when their driver profile was
deleted (5 accounts, all at net 0) keep their phone free: when approved, they get it.

### Money

From `platform_promotions` (the platform account) to the driver's `tricicoin`, as a `promo_credit`
transaction, like the signup bonus of 00666. The USD anchor trigger puts a `promo_credit` in
`unbacked_cup`, so the bonus stays nominal CUP and is never revalued: the same result as
`admin_adjust_wallet`, whose credits carry an `unbacked_cup_delta` directive.

### Never blocks the approval

The payment runs in its own exception block. If it fails, the approval stands, the helper returns
`failed`, and `rpc_attempt_log` gets a `driver_approval_bonus` / `payment_failed` row with the error.

### Feedback

- `ops_set_driver_status` returns `bonus` (`paid` with the amount, `no_phone`, `already_paid`,
  `disabled`, `invalid_amount`, `failed`, or null when the approval is not the first).
- The panel's approval toast says the bonus was credited, or that it was not and why.
- The approval push says the bonus was credited (one push, not two).
- The `approve_driver` row of `admin_actions` carries the bonus outcome: whoever approved is whoever
  triggered the payment. The ledger transaction's `created_by` is the approver too.

### The operator and money

The operator still has no money function and no capability to move money. The approval pays a fixed,
configured amount once per person; the operator cannot choose the amount, the recipient or a second
payment. The payment helper (`_pay_driver_approval_bonus`) is closed to clients and does not ask
who calls: only `ops_set_driver_status` calls it, after its own checks (`is_ops_staff`, never the
caller's own profile, an operator never on a staff account).

### Test accounts

Paid like everyone: the beta-testing rounds should see what a real driver sees.

## Out of scope

- The driver approved on 2026-07-12 who never got the bonus, and the double payment of 2026-11-17:
  money decisions for the owner.
- `admin_adjust_wallet` stays as it is. Admins must stop loading the bonus by hand.
- A person whose account was deleted before this migration and signs up again with the same phone
  can get the bonus once more: their phone can no longer be read, so it cannot be claimed.
