# Dispatch checklist: ride state, offers, matching, presence, the live trip

- [ ] **A ride changes state, fare and times only through its RPCs.** No raw UPDATE of `rides` by
  the rider or the driver; the transition rules hold for every path. Prove: try the raw PostgREST
  update in a rolled-back block. (CLAUDE.md: "Un viaje cambia de estado, tarifa y horas solo por sus RPC")
- [ ] **Races.** Two drivers accepting, a driver accepting while the rider cancels, a retry after a
  timeout: one wins, the other gets a clear answer. Rows are locked (`FOR UPDATE`) where two paths
  meet. Prove: a test or a two-session rehearsal.
- [ ] **Terminal states are final** and `ride_already_closed` is treated as success by every
  caller. (CLAUDE.md: "`ride_already_closed` NO es un fallo")
- [ ] **Connection loss.** A driver or rider who loses signal comes back to the same ride; a ride
  released by silence goes back to its driver when he reappears; the app recovers the active ride
  at startup even if the first lookup fails. (CLAUDE.md: "Un viaje liberado por silencio vuelve a
  su conductor"; "Viaje que desaparece al reabrir la app del pasajero")
- [ ] **Offers reach the driver by both channels** (Realtime and push), and a missing permission
  degrades instead of breaking. (CLAUDE.md: "Auto-launch de oferta en el conductor: 2 canales")
- [ ] **Test accounts stay out of real dispatch.** (CLAUDE.md: "Cuentas de prueba aisladas del despacho")
- [ ] **A deadline in the app matches one the server really has.** Timers that decide something
  (offer expiry, stale ride cancellation) live on the server. The search has no server deadline, so
  the app must not show "no driver found" on a timer of its own; check the live function
  (`pg_get_functiondef`) before adding one. (CLAUDE.md: "La búsqueda NO tiene deadline en el servidor")
- [ ] **Realtime channels:** a new channel that carries private data is private. (CLAUDE.md:
  "Canales de Realtime: cuáles son privados")
- [ ] **Location and GPS gates** (arrival fence, waiting charge, trail) cannot be skipped by a
  client write. (CLAUDE.md: "Rastro GPS del viaje y cargo por espera")
- [ ] **The other apps stay in step.** Client, driver, web tracking and admin show the same state;
  a change in one is checked in the others. (CLAUDE.md: "Checklist de paridad cross-app")
