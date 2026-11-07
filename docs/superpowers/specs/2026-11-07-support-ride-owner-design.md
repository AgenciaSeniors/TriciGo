# One owner per assisted ride, and the support number from the operator on shift — design

Date: 2026-11-07 · Status: draft, answers from the founder in chat · Target: admin panel, web, client and driver 1.8.0 by OTA, one migration

## Why

- **The support number is the founder's.** `+53 5662 1636` is hardcoded as the support WhatsApp in six places, so every rider who taps "Pide ayuda" writes to him. He is not support.
  - `SUPPORT_WHATSAPP_PHONE` in `packages/utils/src/searchWait.ts`, used by the rider's help button (`apps/client/src/components/SupportHelpButton.tsx`) and the web tracking card (`apps/web/src/app/track/[id]/SupportHelpCard.tsx`).
  - Constants or literals in `apps/client/app/profile/help.tsx`, `apps/client/app/support.tsx`, `apps/driver/app/profile/help.tsx`, `apps/driver/app/onboarding/pending.tsx` and `apps/web/src/app/support/page.tsx`.
  - Copy: `faq_a7` (`common.json`) and `home.support_help_no_whatsapp` (`rider.json`), es/en/pt.
- **Nobody owns a ride.** Support is two operator accounts (00667/00668), Lete and Melanye. When a ride waits 60 s or its rider taps "Pide ayuda", `_support_alert` pushes every active admin, super_admin and operator. The banner lists the ride for everyone, and anyone can act on it. Nobody can see who is on it.
- **Measured in prod on 2026-11-07:**
  - Last 30 days: 18 help requests and 36 wait alerts. Operators made 14 ride actions and super admins 19. One ride was acted on by two people.
  - Every active user is on 1.8.0 (217 riders and 142 drivers in 14 days). Both apps have `expo-updates`, and OTA works (`eas-update.yml`, last success 2026-11-02).
  - Lete has no phone on her account; Melanye has one. Both have a registered device for pushes.

## Decisions taken with the founder

1. Each operator handles riders from **her own personal WhatsApp**. No shared support line.
2. **One owner per ride.** When a ride needs help, the system gives it to one operator on shift. The other sees who owns it and cannot act unless she takes it.
3. **No fixed hours.** Each operator turns "En turno" on in the panel when she can work and off when she stops.
4. **When nobody is on shift,** the rider's WhatsApp opens to the last operator who was on shift.
5. These were proposed in chat and the founder did not object:
   - with both on shift, rides alternate between them;
   - if the owner does not open the ride within 1 minute, it passes to the other operator on shift;
   - an operator who lets 2 rides in a row pass without opening them is taken off shift, with a push telling her;
   - an operator who goes off shift with open rides hands them to the other operator on shift, if there is one; if not, they stay hers;
   - admins get the alert only when nobody is on shift, or when a ride passed through every operator on shift without being opened;
   - the founder's number disappears from the apps and the web.

## User-facing behavior

### Operator (admin panel)

- **"En turno" switch.** In the header, on every page, visible on a phone. Any ops staff account (operator, admin, super_admin) can use it; it starts off.
  - The first time it is turned on, the panel asks for her WhatsApp number, prefilled from `users.phone`. It can be changed later from the same switch.
  - Next to the switch the panel says who else is on shift ("Melanye también está en turno").
  - Turning it off with open rides says how many will pass to the other operator, or that they stay hers when nobody else is on shift.
- **The push.** Only the owner gets it: "Te toca · Pasajero pide ayuda · Triciclo · #ABC12345". A ride handed over after 1 minute: "Te pasamos un viaje · …". Being taken off shift: "Te sacamos de turno: no abriste 2 viajes seguidos. Actívalo de nuevo cuando puedas."
- **Banner.** Each row gets a chip: "Tuyo", "Lo atiende Melanye" or "Sin asignar". For the viewer, her own rides come first.
- **Assist page** (`/rides/[id]/assist`, searching and active views).
  - A strip at the top: "Lo atiendes tú", "Lo atiende Melanye desde hace 3 min" with a "Tomar este viaje" button, or "Sin asignar".
  - When the owner opens the page, the ride counts as opened and the 1-minute handover stops.
  - When someone else owns the ride, every action button is disabled and the server refuses it too.
  - "Tomar este viaje" asks for confirmation, makes her the owner and pushes the previous owner: "Lete tomó el viaje #ABC12345". The rider may already be writing to the previous owner's WhatsApp; the new owner writes to the rider from the page.
  - On a ride with no owner, the first action makes the person who acted its owner.

### Rider and driver (apps by OTA, and web)

- **"Pide ayuda"** opens WhatsApp to the ride owner's number, with the same message and ride code as today. With nobody on shift, it opens to the last operator who was on shift.
- **The help screens** (rider Ayuda and Soporte, driver Ayuda, driver waiting for approval, web `/support`) show the number of an operator on shift, or the last one. With no number known, they hide WhatsApp and keep e-mail and tickets.
- **Offline.** The apps keep the last number they received and use it when the server cannot be reached. The founder's number is never a fallback.
- **The "could not open WhatsApp" toast** says the number it tried, or, with none, to write to soporte@tricigo.com with the ride code.
- `faq_a7` loses the phone number and points to the WhatsApp button on that screen and to the e-mail.

## Rules

- **Who gets a new ride.**
  - Among operators on shift with a WhatsApp number: the one with the fewest open owned rides; on a tie, the one assigned least recently. Open means searching, or active with the assist page used.
  - With nobody on shift: no owner. Every ops staff account gets the push, as today. The rider's WhatsApp goes to the last operator who was on shift.
- **When the ride is assigned.** When `_support_alert` fires: the rider's help request, or the 60 s wait alert from the cron. A help request on a ride whose owner is on shift keeps her, and the help push goes to her. For an owner off shift, see below.
- **Handover.**
  - The owner has `support_handoff_after_s` (default 60) from assignment to open the ride. If she does not, the ride passes to another operator on shift who has not had it yet, and her miss counter goes up.
  - If no such operator is left, the owner stays and every ops staff account gets one push for that ride.
  - It applies only while the ride is still searching.
  - An operator whose miss counter reaches `support_auto_offshift_misses` (default 2) goes off shift. Opening a ride she owns resets the counter.
  - The counter goes up also when there is nobody to pass the ride to. The founder's rule ("2 rides in a row without opening them") has no exception, and an operator alone on shift is the common case: if she is away, she goes off shift and from then on the alerts reach everyone.
- **Going off shift.** Her open rides pass to another operator on shift, by the same rule as a new ride, each with a push. With nobody else on shift they stay hers.
- **An owner who is off shift** *(Claude's call, following decision 4)*. An owner counts only while she is on shift. This covers three cases: she went off shift with nobody else on, she was taken off for misses, or an admin off shift took the ride.
  - A help request on such a ride pushes every ops staff account, as when nobody is on shift.
  - `request_ride_help` returns `get_support_contact()` (an operator on shift, else the last one), not the owner's number.
  - The banner and the assist page still show her as the owner, so nobody acts on it by surprise.
- **Coming on shift** *(Claude's call)*. When an operator turns "En turno" on, she gets, by the assignment rule and with a push each, every searching ride that has no owner, or whose owner is off shift and never opened it. A ride its owner already opened stays hers: she may be handling it on WhatsApp.
- **Ownership guard.** Every assist action refuses with `ride_owned_by_other` when the ride has another owner: the six 00628 actions, the three 00660 actions and `admin_cancel_ride`. Admins too: they take the ride first. With no owner, the action makes the caller the owner.
- **Never on oneself** stays as today: an operator never owns a ride she is part of. The assignment skips her for such a ride.

## Server design (one migration)

Next free number on 2026-11-07: **00679** (00676 and 00677 are in PR 1192, 00678 in PR 1194). Re-check master and every open PR right before writing it.

**Order with 00677** *(Claude's call)*. 00677 (PR 1192, rehearsed, not applied yet) patches `admin_assign_ride_to_driver` and `admin_ride_assist_candidates` behind md5 guards. The ownership guard here also patches `admin_assign_ride_to_driver`, so whichever applies second would fail the other's md5 check.
- This migration goes after 00677, and its guard is written against the body 00677 leaves.
- If PR 1192 is still not applied when this one is ready to apply, ask the founder before changing either guard.

Every function follows the operator-role rules (00668, 00671-00673): SECURITY DEFINER, `search_path` set, gated by `is_ops_staff()` unless stated, EXECUTE revoked from `PUBLIC` and `anon` and granted only where listed, logged to `admin_actions`, md5 guards on every live body patched in place, and the self-check block at the end.

### Data

- **`support_staff`** (new): `user_id` PK → `users`, `whatsapp_phone` (E.164), `on_shift` (default false), `shift_started_at`, `shift_ended_at`, `missed_in_a_row` (default 0), `last_assigned_at`, `updated_at`.
  - RLS on; ops staff read every row (the panel shows who is on shift). No write policy: writes go through the RPCs.
  - Explicit GRANTs including `service_role` (`pnpm check:migration-grants`).
- **`ride_assist`** gains `owner_id` → `users`, `owner_assigned_at`, `owner_opened_at`, `owners_tried` (uuid[]) and `all_missed_alert_at`. A ride with no `ride_assist` row gets one when someone first acts on it.
- **`platform_config`:** `support_handoff_after_s` (60, floored at 30) and `support_auto_offshift_misses` (2, floored at 1), added to `KNOWN_KEYS` with es/en/pt help text.

### Functions

| Function | Caller | What it does |
|---|---|---|
| `ops_set_support_shift(on, whatsapp)` | ops staff | Turns the caller's shift on or off. On requires a valid number, stored on the caller's row. Off hands her open rides over (Rules). Resets `missed_in_a_row` when turning on. Logs `support_shift_on` / `support_shift_off`. |
| `ops_support_shift_status()` | ops staff | The caller's row, plus the names of the others on shift, for the header switch. |
| `get_support_contact()` | `anon`, `authenticated` | The WhatsApp number of an operator on shift (by the assignment rule), else the one whose `shift_ended_at` is latest, else NULL. Only the number, no name. |
| `_support_pick_owner(ride_id, exclude uuid[])` | internal | The assignment rule. NULL when nobody qualifies. |
| `_support_alert(ride_id, kind)` (patched) | internal | Assigns the owner when the ride has none, then pushes only her. With no owner, pushes every ops staff account, as today. Handover and off-shift pushes use the same path with their own titles. |
| `request_ride_help(ride_id)` (patched) | rider | Same as today, and returns `support_phone`: the owner's number, or `get_support_contact()` when there is no owner (also when the help alert is capped). Old app versions ignore the new key. |
| `ops_open_ride_assist(ride_id)` | ops staff | Called when the assist page loads. When the caller is the owner, stamps `owner_opened_at` and resets her miss counter. Otherwise it changes nothing. |
| `ops_take_ride_assist(ride_id, expected_owner_id)` | ops staff | Makes the caller the owner, bound to the owner she saw (`ride_changed` otherwise). Stamps opened, pushes the previous owner, logs `support_take_ride`. |
| `_assist_claim_or_refuse(ride_id)` | internal | The ownership guard, called first by every assist action listed in Rules. |
| `support_handoff_tick()` | pg_cron, every 20 s (1.6.4 supports seconds) | Runs the handover and off-shift rules. One push per ride and per person. |
| `admin_support_waiting_rides`, `admin_ride_assist_context`, `admin_active_ride_context` | ops staff | Gain `owner_id`, `owner_name`, `owner_assigned_at`, `owner_opened_at`. Changing a `RETURNS TABLE` needs a DROP or a new name; see the 00628 note about destructive statements and MCP approval. |

## App, web and panel changes

- **`packages/api`:** `rideAssistService.requestHelp` returns `{ code, supportPhone }`. A new `supportContactService.get()` calls `get_support_contact` and caches the answer (AsyncStorage in the apps, memory on the web).
- **`packages/utils`:** `SUPPORT_WHATSAPP_PHONE` is removed. Nothing hardcodes a support number afterwards; a test or lint check keeps `56621636` out of `apps/` and `packages/` (store metadata and docs excepted).
- **Client and driver:** the screens listed in "Why" read the number from the service. Ships by OTA to 1.8.0 through `eas-update.yml`, client and driver separately, starting at 10%.
- **Web:** the tracking card and `/support` read it too. Deploys with master.
- **Panel:** the switch in `Header.tsx`, the banner chip, the assist page strip and disabled actions, `ownership` error copy in `assistErrors.ts`, es/en/pt in `admin.json`.

## Rollout

1. Rehearse locally, then in prod inside a rolled-back block, each with the founder's OK, as in the operator deliveries.
2. Apply the migration and merge. The panel and the web deploy.
3. Lete and Melanye each turn "En turno" on once and enter their WhatsApp number.
4. Publish the client and driver OTA, 10% then 100%.
5. Meanwhile, the founder sets an away message on his WhatsApp pointing riders to support, for phones that have not taken the OTA yet.

## Calls Claude made (not the founder's)

The founder should check these:
1. An owner who is off shift counts as nobody on shift, for the push and for the number.
2. Coming on shift picks up the rides nobody owns, and the rides of an off-shift owner who never opened them.
3. The miss counter also counts when there is nobody to pass the ride to.
4. Admins must take a ride (one tap, or their first action on an unowned ride) before acting. They get no exception.
5. Any ops staff account can go on shift, including admins, so someone can cover. It starts off.
6. The assignment picks the operator with the fewest open rides, then the one assigned least recently.
7. `get_support_contact` returns only a number, never the operator's name.
8. The handover check runs every 20 s, so a ride passes 60 to 80 s after it was assigned.
9. This migration applies after 00677 (PR 1192).
10. Nothing hardcodes a support number afterwards. With no number known, the screens offer e-mail and tickets.

## Out of scope

- Support tickets (`/support` in the panel), incidents, disputes and lost items: no owner rule.
- The alert e-mail digest and `support_alert_email`: unchanged.
- Stuck active-ride alerts (`StuckRideBanner`): unchanged. The ownership guard still applies when someone acts on such a ride.
- Shift schedules, shift reports or pay.
- A shared support line, and in-app chat with support.
