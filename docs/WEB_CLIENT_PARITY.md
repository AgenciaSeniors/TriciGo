# Web ↔ Client parity (rider)

Living checklist for bringing `apps/web` to full functional parity with the mobile
rider app `apps/client`. Web keeps its own design; only business logic + features
must match. Source of truth = the **native** render of the client
(`NativeHomeScreen`, `NativeWalletScreen`, `RideActiveView`, `RideCompleteView`,
hooks in `apps/client/src/hooks/`).

Legend: `[x]` done · `[ ]` pending · `[~]` partial/in-progress

---

## Fase 0 — Cross-cutting
- [x] Share `RIDE_CONFIG` via `@tricigo/utils` (`packages/utils/src/ride-config.ts`); client re-exports.
- [x] Cuban phone validation already shared (`@tricigo/utils` → `isValidCubanPhone`/`normalizeCubanPhone`).
- [x] Create this parity doc.

## Fase 1 — Booking (`apps/web/src/app/book/page.tsx`)
Logic divergences:
- [x] Minimum distance 200m (`RIDE_CONFIG.MIN_DISTANCE_M`) in confirm.
- [x] 1.2× surge buffer on TriciCoin balance check (+ fresh balance fetch at confirm).
- [x] Re-check corporate budget before create (`corporateService.getAccount`).
- [x] Send `insurance_premium_cup` + respect `insurance_available` (toggle gated on availability).
- [x] Estimate freshness — re-estimate at confirm + Δ>5% abort + `fareEstimatedAtRef`.
- [x] Double-submit guard with sync refs (`isSubmittingRef`/`pendingRequestIdRef`).
- [x] Price snapshot breakdown in `createRide` (base/per_km/per_min/min_fare/surge/pricing_rule_id).
Missing features:
- [dropped] ~~Scheduled ride (≥15min)~~ — feature retired, no longer used; not ported to web.
- [x] Shared ride (triciclo: `share_ride`/`declared_passengers` + seats stepper + discount preview).
- [dropped] ~~Ride preferences (`rider_preferences`)~~ — feature retired, no longer used; not ported to web.
- [x] Destination prediction (`useDestinationPredictions` web hook → quick-pick chips).
- [x] Delivery: package dims (L/W/H) + `deliveryService.createDeliveryDetails` (cancel-on-failure).
- [n/a] Notify trusted contacts — fires at *arrival* in client, belongs to Fase 2 (tracking), not booking.
Alignment:
- [x] Receiver phone regex unified (`isValidRecipientPhone`).
- [x] `pickup_address`/`dropoff_address` format (raw `address`, like client).
- [x] `ride_mode: 'passenger'` explicit.
- [x] Nearby radius/limit aligned to client (5km / 30).

Verification: `pnpm check-types` green (4 apps); `/book` compiles + renders 200 in Next dev. Full
authenticated booking E2E pending (needs live OTP session on device).

## Fase 2 — Tracking + Chat (`track/[id]`, `chat/[rideId]`)
- [x] **[CRITICAL]** Driver position: `/track/[id]` migrated from dead broadcast to polling RPC `get_driver_position` (new `useDriverPosition` web hook, 1 Hz + timeout/retry).
- [x] Dynamic ETA (OSRM via `fetchRoute`, 30s throttle, from live driver position to pickup/dropoff).
- [x] Rider location sharing in pickup (new `useRiderLocationSharing` web hook → `rider-location:${rideId}` broadcast).
- [x] `arrived_at_destination` state in stepper.
- [x] Tracking health banners (waiting-for-location / stale signal).
- [x] Cancel with status-aware preview copy (fee warning when driver en route).
- [x] `RideCompleteView`: tip (`TipFlow`) + categorized rating tags.
- [x] Chat: quick replies (`getQuickRepliesForRole`), char counter (400/500), offline banner.
- [x] Cancel **exact** fee + penalty preview (`previewCancellationFee` + `previewCancelPenalty` in the confirm dialog).
- [x] Driver-no-GPS consent + confirm-arrival modal (`gps_override_*` + `riderConfirmDriverArrival`; `Ride` type extended with `gps_override_requested_at`/`gps_override_confirmed_at`/`gps_check_distance_m`).
- [x] Add stop mid-ride (`getRideWaypoints` list + `AddressAutocomplete` → `estimateWaypointAddition` preview → `addWaypointToActiveRide`, máx 3).
- [x] Receipt download (HTML → print/PDF) + email (`getReceiptData` + `generateReceiptHTML` / `sendRideReceipt`) in `/track/[id]` completed view **and** `/rides/[id]`.
- [x] "Llegó seguro" auto-share contact SMS on completion (once, `localStorage` guard) + lightweight rating reminder banner (5 min, scrolls to rating).
Remaining (deferred — lower-frequency / heavier):
- [ ] Split fare management.
- [ ] Chat unread badge / last-read sealing; driver header vehicle+plate.

Verification: `pnpm check-types` green (4 apps); `/track/[id]` + `/rides/[id]` + `/chat/[rideId]` compile + render 200 in Next dev. Live driver-marker movement + GPS/confirm-arrival modal trigger E2E pending (needs an active ride with the `gps_override_*` flags set / a driver streaming GPS).

## Fase 3 — Wallet (`wallet/page.tsx`, `wallet/receipts`)
- [ ] USD-cents / Wallet v2 (`availableUsdCents`/`migrationRate`) + migration banner.
- [ ] `translateNetopiaError` on failures.
- [ ] Receipt PDF polling post-recharge (6×2s) + tappable chip.
- [ ] Per-transaction USD caption.
- Keep: `deviceFingerprint`, dynamic provider, no `recharge_type` (default `customer`).

## Fase 4 — Auth (`login` + complete-profile + verify-phone)
- [ ] Cuban phone validation/normalization + demo mode.
- [ ] OTP auto-submit at 6th digit + 60s resend timer.
- [ ] `deviceService.registerLoginDevice` after OTP login.
- [ ] complete-profile screen (force name/avatar on first login).
- [ ] verify-phone screen (`linkPhone`/`verifyPhoneLink` for OAuth).
- [ ] Route via `authService` (not raw EF calls).
- [ ] Session guard (missing `full_name`→complete-profile, OAuth missing `phone`→verify-phone).
- [ ] Clear domain stores on logout.

## Fase 5 — Profile + secondary screens
Build (missing): ~~`ride-preferences`~~ (dropped — retired), ~~`recurring-rides`~~ (dropped — retired), `emergency-contact`, `ticket-detail`.
Parity pass (existing): `settings`, `saved-locations`, `safety`, `trusted-contacts`, `corporate`, `help`, `about`, `referral`, `support`, `driver-profile/[userId]`, `promo/[code]`, `refer/[code]`, `notifications`.

## Fase 6 — Gift P2P (new)
- [ ] `wallet/gift` (send): phone/code, amount, note, my code + QR.
- [ ] `gift/[code]` (redeem/landing).
- [ ] "Regalar" button in `/wallet`.
- [ ] Reuse `walletService.sendGift/findUserByPhone/findUserByGiftCode/getTransfers`, `referralService.getOrCreateReferralCode`.
- [ ] Web QR (lib) + code-text fallback.
