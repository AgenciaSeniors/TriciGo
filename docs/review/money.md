# Money checklist: wallet, payments, fares, promotions, gifts, bonuses, referrals

- [ ] **Money moves only through server RPCs that write the ledger.** No client write decides an
  amount, a share or a payment state. Prove: as an authenticated test user, try the direct
  PostgREST write in a rolled-back block and see it refused. (CLAUDE.md: "Escrituras directas de
  clientes que decidían dinero o una revisión")
- [ ] **Never `UPDATE wallet_accounts.balance`.** Balances change through `ledger_entries` (the USD
  anchor trigger lives there) or `admin_adjust_wallet`. Prove: `git grep -n "wallet_accounts"` in
  the diff shows no direct balance update. (CLAUDE.md: "Ajustar saldo de wallet")
- [ ] **Idempotent and race-safe.** A double tap, a retried request or a webhook delivered twice
  pays once. The row is claimed atomically (`UPDATE ... WHERE status IN (...) RETURNING`), and the
  claim allows the legitimate transitions (`failed → paid`). Prove: call it twice in a test or in
  a rolled-back block. (CLAUDE.md: "NETOPIA webhook: el atomic claim")
- [ ] **Only the server writes payment intents.** Clients never insert or update
  `payment_intents`; a refund without balance is recorded, not lost. (CLAUDE.md: "Recargas NETOPIA")
- [ ] **Fares are computed by the server.** The fare a client declares, promos, referrals and gifts
  are checked or recomputed on the server; stops are quoted as a direct fare plus the server's
  surcharge. (CLAUDE.md: "Tarifa declarada por el cliente, promos, referidos y regalos";
  "Paradas")
- [ ] **One bonus per person.** Signup, referral, apology and approval bonuses are tied to the
  confirmed phone and cannot be claimed twice by recreating an account. (CLAUDE.md: "Bonos de una vez
  por persona")
- [ ] **Shortfall and corporate paths.** A ride whose wallet does not cover the fare is charged in
  cash; corporate rides skip the personal wallet check and charge the company the server's fare.
  (CLAUDE.md: "Un viaje con billetera que no alcanza se cobra en efectivo")
- [ ] **Commission is always booked.** Completing a ride, cash included, leaves its ledger rows.
  Prove: complete a test ride in a rolled-back block and count the ledger rows.
- [ ] **Currency and rounding.** Amounts are CUP integers where the schema says so; display uses
  `formatCUP`; conversions read the current exchange rate, never a constant.
- [ ] **Every validation of a promo code is logged** and failures do not reveal whether a code
  exists for another account. (CLAUDE.md: "Cada validación de un código de promoción queda registrada")
- [ ] **Abuse case written down.** The PR says how someone would try to get money they should not
  (self-referral, collusion, test accounts, replay) and why it fails.
