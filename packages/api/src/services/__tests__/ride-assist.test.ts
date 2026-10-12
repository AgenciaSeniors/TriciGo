import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
}));

import { rideAssistService, RIDE_ASSIST_UNAVAILABLE, isProposalGone } from '../ride-assist.service';

const MISSING = { code: 'PGRST202', message: 'Could not find the function public.request_ride_help' };

describe('rideAssistService', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  describe('requestHelp (the rider never waits on it: WhatsApp opens either way)', () => {
    it('returns the ride code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, code: 'F1000000' }, error: null });
      await expect(rideAssistService.requestHelp('r-1')).resolves.toEqual({ code: 'F1000000' });
      expect(mockRpc).toHaveBeenCalledWith('request_ride_help', { p_ride_id: 'r-1' });
    });

    it('returns null when the migration is missing, the server refuses, or the network fails', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(rideAssistService.requestHelp('r-1')).resolves.toBeNull();
      mockRpc.mockResolvedValueOnce({ data: { error: 'ride_not_searching' }, error: null });
      await expect(rideAssistService.requestHelp('r-1')).resolves.toBeNull();
      mockRpc.mockRejectedValueOnce(new TypeError('Network request failed'));
      await expect(rideAssistService.requestHelp('r-1')).resolves.toBeNull();
    });
  });

  describe('getPendingProposal', () => {
    const p = { id: 'p-1', ride_id: 'r-1', from_service_type: 'triciclo_basico', to_service_type: 'auto_standard',
      from_fare_cup: 2000, to_fare_cup: 3000, expires_at: '2026-10-07T12:03:00Z' };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns the proposal, stamped with the moment the answer arrived', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-07T12:00:05Z'));
      mockRpc.mockResolvedValueOnce({ data: p, error: null });
      await expect(rideAssistService.getPendingProposal('r-1')).resolves.toEqual({
        ...p,
        received_at_ms: Date.parse('2026-10-07T12:00:05Z'),
      });
      expect(mockRpc).toHaveBeenCalledWith('get_my_ride_service_proposal', { p_ride_id: 'r-1' });
    });

    it('passes the seconds left by the server clock through, so the card does not need the phone clock', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-07T12:00:05Z'));
      mockRpc.mockResolvedValueOnce({ data: { ...p, expires_in_s: 174 }, error: null });
      await expect(rideAssistService.getPendingProposal('r-1')).resolves.toMatchObject({
        expires_in_s: 174,
        received_at_ms: Date.parse('2026-10-07T12:00:05Z'),
      });
    });

    it('works against a server that does not send expires_in_s yet', async () => {
      mockRpc.mockResolvedValueOnce({ data: p, error: null });
      const got = await rideAssistService.getPendingProposal('r-1');
      expect(got).not.toBeNull();
      expect(got).not.toHaveProperty('expires_in_s');
      expect(typeof got?.received_at_ms).toBe('number');
    });

    it('returns null when there is none or the migration is missing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      await expect(rideAssistService.getPendingProposal('r-1')).resolves.toBeNull();
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(rideAssistService.getPendingProposal('r-1')).resolves.toBeNull();
    });

    it('throws any other error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
      await expect(rideAssistService.getPendingProposal('r-1')).rejects.toMatchObject({ message: 'timeout' });
    });
  });

  describe('respondProposal', () => {
    it('sends the answer', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, accepted: true }, error: null });
      await rideAssistService.respondProposal('p-1', true);
      expect(mockRpc).toHaveBeenCalledWith('respond_ride_service_proposal', { p_proposal_id: 'p-1', p_accept: true });
    });

    it('throws the server code when it refuses', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'proposal_expired' }, error: null });
      await expect(rideAssistService.respondProposal('p-1', true)).rejects.toMatchObject({ code: 'proposal_expired' });
    });
  });

  describe('isProposalGone (the card goes away; the rider cannot fix it by retrying)', () => {
    it('is true for every refusal from the server', async () => {
      for (const code of ['proposal_expired', 'proposal_not_pending', 'proposal_not_found', 'ride_not_searching', 'fare_below_minimum']) {
        mockRpc.mockResolvedValueOnce({ data: { error: code }, error: null });
        const err = await rideAssistService.respondProposal('p-1', true).catch((e: unknown) => e);
        expect(isProposalGone(err)).toBe(true);
      }
    });

    it('is false for a network error or a database error, which the rider can retry', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
      const dbErr = await rideAssistService.respondProposal('p-1', true).catch((e: unknown) => e);
      expect(isProposalGone(dbErr)).toBe(false);
      expect(isProposalGone(new TypeError('Network request failed'))).toBe(false);
    });
  });

  describe('getWaitingRides', () => {
    it('returns the rows, or none when the migration is missing', async () => {
      const rows = [{ ride_id: 'r-1', code: 'F1000000', wait_s: 75, help_requested_at: null }];
      mockRpc.mockResolvedValueOnce({ data: rows, error: null });
      await expect(rideAssistService.getWaitingRides()).resolves.toEqual(rows);
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(rideAssistService.getWaitingRides()).resolves.toEqual([]);
    });

    it('throws when the caller is not an admin', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'forbidden' } });
      await expect(rideAssistService.getWaitingRides()).rejects.toMatchObject({ message: 'forbidden' });
    });
  });

  describe('support actions', () => {
    it('getAssistContext says the feature is unavailable when the migration is missing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(rideAssistService.getAssistContext('r-1')).rejects.toMatchObject({ code: RIDE_ASSIST_UNAVAILABLE });
    });

    it('getCandidates asks for the ride type unless told otherwise', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await rideAssistService.getCandidates('r-1');
      expect(mockRpc).toHaveBeenCalledWith('admin_ride_assist_candidates', { p_ride_id: 'r-1', p_service_type: null });
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await rideAssistService.getCandidates('r-1', 'auto_standard');
      expect(mockRpc).toHaveBeenLastCalledWith('admin_ride_assist_candidates', { p_ride_id: 'r-1', p_service_type: 'auto_standard' });
    });

    it('offerToDriver returns what happened to the offer', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, mode: 'rearmed', expires_at: '2026-10-07T12:02:00Z' }, error: null });
      await expect(rideAssistService.offerToDriver('r-1', 'd-1')).resolves.toEqual({ mode: 'rearmed', expiresAt: '2026-10-07T12:02:00Z' });
      expect(mockRpc).toHaveBeenCalledWith('admin_offer_ride_to_driver', { p_ride_id: 'r-1', p_driver_profile_id: 'd-1' });
    });

    it('offerToDriver throws the refusal code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'wrong_vehicle_type' }, error: null });
      await expect(rideAssistService.offerToDriver('r-1', 'd-2')).rejects.toMatchObject({ code: 'wrong_vehicle_type' });
    });

    it('assignToDriver sends the reason and throws the refusal code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'busy', active_ride_id: 'r-9' }, error: null });
      await expect(rideAssistService.assignToDriver('r-1', 'd-4', 'Habló por WhatsApp')).rejects.toMatchObject({ code: 'busy' });
      expect(mockRpc).toHaveBeenCalledWith('admin_assign_ride_to_driver', {
        p_ride_id: 'r-1', p_driver_profile_id: 'd-4', p_reason: 'Habló por WhatsApp',
      });
    });

    it('changeServiceType proposes and returns the proposal', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, mode: 'propose', proposal_id: 'p-1', expires_at: '2026-10-07T12:03:00Z' }, error: null });
      await expect(rideAssistService.changeServiceType('r-1', 'auto_standard', 3000, 'propose'))
        .resolves.toEqual({ proposalId: 'p-1', expiresAt: '2026-10-07T12:03:00Z' });
      expect(mockRpc).toHaveBeenCalledWith('admin_change_ride_service', {
        p_ride_id: 'r-1', p_service_type: 'auto_standard', p_fare_cup: 3000, p_mode: 'propose', p_reason: null,
      });
    });

    it('changeServiceType applies with a reason and throws the refusal code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'fare_below_minimum' }, error: null });
      await expect(rideAssistService.changeServiceType('r-1', 'auto_standard', 900, 'apply', 'Aceptó por WhatsApp'))
        .rejects.toMatchObject({ code: 'fare_below_minimum' });
      expect(mockRpc).toHaveBeenCalledWith('admin_change_ride_service', {
        p_ride_id: 'r-1', p_service_type: 'auto_standard', p_fare_cup: 900, p_mode: 'apply', p_reason: 'Aceptó por WhatsApp',
      });
    });
  });

  describe('active rides (00660)', () => {
    it('getActiveContext returns the context and maps a missing RPC to unavailable', async () => {
      const ctx = {
        ride: { id: 'r-1', status: 'in_progress' },
        driver_profile_id: 'd-1',
        delivery_proof_missing: false,
        allowed_actions: ['advance', 'complete'],
      };
      mockRpc.mockResolvedValueOnce({ data: ctx, error: null });
      await expect(rideAssistService.getActiveContext('r-1')).resolves.toEqual(ctx);
      expect(mockRpc).toHaveBeenCalledWith('admin_active_ride_context', { p_ride_id: 'r-1' });

      mockRpc.mockResolvedValueOnce({ data: null, error: { ...MISSING, message: 'Could not find the function public.admin_active_ride_context' } });
      await expect(rideAssistService.getActiveContext('r-1')).rejects.toMatchObject({ code: RIDE_ASSIST_UNAVAILABLE });
    });

    it('getActiveContext turns a self_ride refusal into an AppError with that code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'self_ride' }, error: null });
      await expect(rideAssistService.getActiveContext('r-1')).rejects.toMatchObject({ code: 'self_ride' });
    });

    it('releaseActiveRide sends the status and the driver support saw, and the reason', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, ride_id: 'r-1', status: 'searching' }, error: null });
      await rideAssistService.releaseActiveRide('r-1', 'accepted', 'd-1', 'no responde');
      expect(mockRpc).toHaveBeenCalledWith('admin_release_active_ride', {
        p_ride_id: 'r-1', p_expected_status: 'accepted', p_expected_driver_id: 'd-1', p_reason: 'no responde',
      });
    });

    it('advanceActiveRide returns what the step recorded', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          success: true, ride_id: 'r-1', status: 'in_progress',
          driver_arrived_at: '2026-10-12T12:00:00Z', pickup_at: '2026-10-12T12:07:00Z',
          wait_minutes: 7, billable_minutes: 2, wait_cup: 184,
        },
        error: null,
      });
      await expect(rideAssistService.advanceActiveRide('r-1', 'arrived_at_pickup', 'd-1', 'sin gps')).resolves.toEqual({
        status: 'in_progress',
        driver_arrived_at: '2026-10-12T12:00:00Z',
        pickup_at: '2026-10-12T12:07:00Z',
        wait_minutes: 7,
        billable_minutes: 2,
        wait_cup: 184,
      });
      expect(mockRpc).toHaveBeenCalledWith('admin_advance_active_ride', {
        p_ride_id: 'r-1', p_expected_status: 'arrived_at_pickup', p_expected_driver_id: 'd-1', p_reason: 'sin gps',
      });
    });

    it('completeActiveRide sends the confirmed total and returns what was charged', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          success: true, ride_id: 'r-1', status: 'completed',
          final_fare_cup: 2970, payment_method: 'mixed', cash_amount_cup: 970, wallet_amount_cup: 2000,
        },
        error: null,
      });
      await expect(rideAssistService.completeActiveRide('r-1', 'in_progress', 'd-1', 2970, 'app caída')).resolves.toEqual({
        final_fare_cup: 2970,
        payment_method: 'mixed',
        cash_amount_cup: 970,
        wallet_amount_cup: 2000,
      });
      expect(mockRpc).toHaveBeenCalledWith('admin_complete_active_ride', {
        p_ride_id: 'r-1', p_expected_status: 'in_progress', p_expected_driver_id: 'd-1', p_expected_total_cup: 2970, p_reason: 'app caída',
      });
    });

    it('completeActiveRide reports a cash or wallet part the server did not send as null', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { success: true, ride_id: 'r-1', status: 'completed', final_fare_cup: 2970, payment_method: 'cash', cash_amount_cup: null },
        error: null,
      });
      await expect(rideAssistService.completeActiveRide('r-1', 'in_progress', 'd-1', 2970, 'app caída')).resolves.toEqual({
        final_fare_cup: 2970,
        payment_method: 'cash',
        cash_amount_cup: null,
        wallet_amount_cup: null,
      });
    });

    it('a refusal comes back as an AppError carrying the code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'amount_changed', status: 'in_progress', total_cup: 3100 }, error: null });
      await expect(rideAssistService.completeActiveRide('r-1', 'in_progress', 'd-1', 2970, 'app caída'))
        .rejects.toMatchObject({ code: 'amount_changed' });
    });

    it('the three actions say the feature is unavailable when 00660 is not applied', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { ...MISSING, message: 'Could not find the function public.admin_release_active_ride' } });
      await expect(rideAssistService.releaseActiveRide('r-1', 'accepted', 'd-1', 'no responde'))
        .rejects.toMatchObject({ code: RIDE_ASSIST_UNAVAILABLE, statusCode: 503 });
      mockRpc.mockResolvedValueOnce({ data: null, error: { ...MISSING, message: 'Could not find the function public.admin_advance_active_ride' } });
      await expect(rideAssistService.advanceActiveRide('r-1', 'accepted', 'd-1', 'sin gps'))
        .rejects.toMatchObject({ code: RIDE_ASSIST_UNAVAILABLE, statusCode: 503 });
      mockRpc.mockResolvedValueOnce({ data: null, error: { ...MISSING, message: 'Could not find the function public.admin_complete_active_ride' } });
      await expect(rideAssistService.completeActiveRide('r-1', 'in_progress', 'd-1', 2970, 'app caída'))
        .rejects.toMatchObject({ code: RIDE_ASSIST_UNAVAILABLE, statusCode: 503 });
    });

    it('a deadlock (40P01) comes back as the Postgres error itself, for the panel to read as ride_changed', async () => {
      const deadlock = { code: '40P01', message: 'deadlock detected', details: null, hint: null };
      mockRpc.mockResolvedValueOnce({ data: null, error: deadlock });
      await expect(rideAssistService.releaseActiveRide('r-1', 'accepted', 'd-1', 'no responde')).rejects.toBe(deadlock);
      mockRpc.mockResolvedValueOnce({ data: null, error: deadlock });
      await expect(rideAssistService.advanceActiveRide('r-1', 'accepted', 'd-1', 'sin gps')).rejects.toBe(deadlock);
      mockRpc.mockResolvedValueOnce({ data: null, error: deadlock });
      await expect(rideAssistService.completeActiveRide('r-1', 'in_progress', 'd-1', 2970, 'app caída')).rejects.toBe(deadlock);
    });
  });
});
