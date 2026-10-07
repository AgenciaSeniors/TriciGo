// ============================================================
// Which phone owns a login account.
//
// Phone accounts get a synthetic auth email, phone_<digits>@tricigo.app
// (verify-otp), and verify-otp finds the account for a phone by its phone
// OR by that synthetic email (lookup_auth_user_by_contact). The email branch
// trusts whoever holds the address, so the domain is reserved for accounts
// verify-otp creates:
//
//  - add-email-with-verification refuses any @tricigo.app address. Before
//    2026-10-06 a signed-in user could set phone_<victim>@tricigo.app as
//    their auth email for a number that had no account yet; the victim's
//    first OTP login then found the attacker's account through the email
//    branch and got a session for it.
//  - verify-otp looks the account up by phone only, and logs a phone only
//    into an account that already has that phone, confirmed, and only hands
//    back a session for that same account. Anything else is refused. "None" matters because GoTrue's public /signup is
//    open with autoconfirm on (measured 2026-10-06): anyone can create
//    phone_<victim>@tricigo.app with a password of their choosing, and the
//    victim's first OTP login would land in it. It also covers a recycled
//    number: an account keeps its synthetic email after link-phone moves it
//    to a new number, and the next owner of the old number must not land in
//    it. Every account verify-otp creates gets its phone at creation, and no
//    account with a synthetic email lacks one (0 of 504 on 2026-10-06).
//
// Pure module with no remote imports, so packages/api's vitest runs its test.
// ============================================================

const SYNTHETIC_DOMAIN = 'tricigo.app';

const digits = (s: string) => s.replace(/\D/g, '');

/** The auth email verify-otp gives the account of an E.164 phone. */
export function syntheticLoginEmail(phone: string): string {
  return `phone_${digits(phone)}@${SYNTHETIC_DOMAIN}`;
}

/** True for addresses on the domain reserved for verify-otp's synthetic emails. */
export function isReservedLoginEmail(email: string): boolean {
  const at = email.trim().toLowerCase().lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.trim().toLowerCase().slice(at + 1);
  return domain === SYNTHETIC_DOMAIN || domain.endsWith(`.${SYNTHETIC_DOMAIN}`);
}

/**
 * True unless the existing account holds the phone that just proved itself
 * with an OTP, confirmed. A missing phone or an unconfirmed one is a conflict:
 * GoTrue's public signup can create an account with any email or any phone
 * (left unconfirmed), and neither proves anything. Every account verify-otp
 * creates has its phone confirmed (572 of 572 on 2026-10-06).
 */
export function phoneConflictsWithAccount(
  accountPhone: string | null | undefined,
  loginPhone: string,
  accountPhoneConfirmedAt?: string | null,
): boolean {
  const account = digits(accountPhone ?? '');
  return !account || account !== digits(loginPhone) || !accountPhoneConfirmedAt;
}

/**
 * True while GoTrue's ban on the account has not ended. The admin panel bans
 * a blocked account (admin_set_user_active, 00629); verify-otp checks this
 * before minting a session so the person gets a clear "blocked" answer
 * instead of a failed sign-in (GoTrue would refuse the password grant).
 */
export function isAccountBanned(bannedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!bannedUntil) return false;
  const until = Date.parse(bannedUntil);
  return Number.isFinite(until) && until > now.getTime();
}
