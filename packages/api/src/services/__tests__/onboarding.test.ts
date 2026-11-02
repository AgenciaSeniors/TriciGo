import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors';

const mockRpc = vi.fn();
const mockInvoke = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc, functions: { invoke: mockInvoke } }),
}));

import { ONBOARDING_UNAVAILABLE, onboardingService } from '../onboarding.service';

const ok = (data: unknown) => ({ data, error: null });

beforeEach(() => {
  mockRpc.mockReset();
  mockInvoke.mockReset();
});

describe('onboardingService.setDriverStatus', () => {
  it('sends the decision, what the reviewer saw and the reason', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'suspended', previous_status: 'approved' }));

    await onboardingService.setDriverStatus('d-1', 'suspended', 'approved', '  Quejas  ');

    expect(mockRpc).toHaveBeenCalledWith('ops_set_driver_status', {
      p_driver_id: 'd-1',
      p_status: 'suspended',
      p_expected_status: 'approved',
      p_reason: 'Quejas',
    });
  });

  it('sends no reason for an approval', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true }));

    await onboardingService.setDriverStatus('d-1', 'approved', 'under_review');

    expect(mockRpc.mock.calls[0]![1].p_reason).toBeNull();
  });

  it("throws the server's refusal as an AppError with its code", async () => {
    mockRpc.mockResolvedValueOnce(ok({ error: 'driver_changed', status: 'approved' }));

    const err = await onboardingService.setDriverStatus('d-1', 'approved', 'under_review').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('driver_changed');
  });

  it('says the function is not deployed when the migration is missing', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

    const err = await onboardingService.setDriverStatus('d-1', 'approved', 'under_review').catch((e: unknown) => e);

    expect((err as AppError).code).toBe(ONBOARDING_UNAVAILABLE);
  });

  it('rethrows any other database error', async () => {
    const dbErr = { code: '57014', message: 'canceling statement' };
    mockRpc.mockResolvedValueOnce({ data: null, error: dbErr });

    await expect(onboardingService.setDriverStatus('d-1', 'approved', 'under_review')).rejects.toBe(dbErr);
  });
});

describe('onboardingService.reviewDocument', () => {
  it('sends the message the driver reads and what the e-mail needs', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, is_verified: false }));

    await onboardingService.reviewDocument('doc-1', false, {
      message: 'Foto borrosa',
      reasonCodes: ['blurry'],
      note: 'Se ve movida',
    });

    expect(mockRpc).toHaveBeenCalledWith('ops_review_driver_document', {
      p_document_id: 'doc-1',
      p_verified: false,
      p_message: 'Foto borrosa',
      p_reason_codes: ['blurry'],
      p_note: 'Se ve movida',
    });
  });

  it('verifies with no reasons', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, is_verified: true }));

    await onboardingService.reviewDocument('doc-1', true, {});

    expect(mockRpc).toHaveBeenCalledWith('ops_review_driver_document', {
      p_document_id: 'doc-1',
      p_verified: true,
      p_message: null,
      p_reason_codes: [],
      p_note: null,
    });
  });
});

describe('onboardingService.addDocument', () => {
  const file = new File(['x'], 'licencia.png', { type: 'image/png' });

  it('uploads under the driver and type, then records the row', async () => {
    mockInvoke.mockResolvedValueOnce(ok({ path: 'x' }));
    mockRpc.mockResolvedValueOnce(ok({ success: true, document: { id: 'doc-9', is_verified: false } }));

    const doc = await onboardingService.addDocument('d-1', 'drivers_license', file);

    expect(doc).toEqual({ id: 'doc-9', is_verified: false });
    const form = mockInvoke.mock.calls[0]![1].body as FormData;
    expect(mockInvoke.mock.calls[0]![0]).toBe('storage-upload');
    expect(form.get('bucket')).toBe('driver-documents');
    const path = String(form.get('path'));
    expect(path).toMatch(/^driver-docs\/d-1\/drivers_license\/drivers_license_\d+\.png$/);
    expect(mockRpc).toHaveBeenCalledWith('ops_add_driver_document', {
      p_driver_id: 'd-1',
      p_document_type: 'drivers_license',
      p_storage_path: path,
      p_file_name: path.split('/').pop(),
      p_mime_type: 'image/png',
    });
  });

  it('records nothing when the upload fails', async () => {
    mockInvoke.mockResolvedValueOnce(ok({ error: 'forbidden' }));

    await expect(onboardingService.addDocument('d-1', 'drivers_license', file)).rejects.toThrow('forbidden');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('onboardingService.logOutreach', () => {
  it('sends the trimmed note, or none', async () => {
    mockRpc.mockResolvedValue(ok({ success: true, id: 'o-1' }));

    await onboardingService.logOutreach('dp1', 'whatsapp', '  Le escribí  ');
    await onboardingService.logOutreach('dp1', 'llamada', '   ');

    expect(mockRpc.mock.calls[0]).toEqual(['ops_log_driver_outreach',
      { p_driver_profile_id: 'dp1', p_channel: 'whatsapp', p_note: 'Le escribí' }]);
    expect(mockRpc.mock.calls[1]![1].p_note).toBeNull();
  });
});

describe('onboardingService fleets', () => {
  it('reviews a fleet request as shown', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'rejected' }));

    await onboardingService.reviewFleetAccount('ca-1', 'rejected', 'pending', 'Sin documentos');

    expect(mockRpc).toHaveBeenCalledWith('ops_review_fleet_account', {
      p_account_id: 'ca-1',
      p_decision: 'rejected',
      p_expected_status: 'pending',
      p_reason: 'Sin documentos',
    });
  });

  it('sends every reviewed column of the invitation as shown', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'approved' }));
    const shown = {
      id: 'fm-1', fleet_id: 'f-1', driver_name: 'Ana', driver_phone: '+5355512345', driver_email: null,
      driver_license_number: 'L-1', driver_id_number: null, license_doc_path: null,
    };

    await onboardingService.reviewFleetMember(shown, 'approved');

    expect(mockRpc).toHaveBeenCalledWith('ops_review_fleet_member', {
      p_member_id: 'fm-1',
      p_decision: 'approved',
      p_shown: {
        fleet_id: 'f-1', driver_name: 'Ana', driver_phone: '+5355512345', driver_email: null,
        driver_license_number: 'L-1', driver_id_number: null, license_doc_path: null,
      },
      p_reason: null,
    });
  });

  it('keeps the FLEET_MEMBER_CHANGED code the review panel reloads on', async () => {
    mockRpc.mockResolvedValueOnce(ok({ error: 'member_changed' }));
    const shown = {
      id: 'fm-1', fleet_id: 'f-1', driver_name: 'Ana', driver_phone: '+5355512345', driver_email: null,
      driver_license_number: 'L-1', driver_id_number: null, license_doc_path: null,
    };

    const err = await onboardingService.reviewFleetMember(shown, 'approved').catch((e: unknown) => e);

    expect((err as AppError).code).toBe('FLEET_MEMBER_CHANGED');
  });
});
