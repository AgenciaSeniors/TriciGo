import { describe, it, expect } from 'vitest';
import { addDriverFailure, emptyFleetMemberForm, parseFleetMemberForm } from '../fleetMemberForm';

const filled = { ...emptyFleetMemberForm, name: 'Ana Díaz', phone: '52345678' };

describe('addDriverFailure', () => {
  it('recognizes a number already in the fleet', () => {
    expect(addDriverFailure({ code: 'FLEET_MEMBER_EXISTS', message: 'Ese teléfono ya está en tu flota.' })).toBe('exists');
  });

  it.each([
    ['a lost connection', new Error('Fleet members lookup failed: TypeError: Network request failed')],
    ['another database error', { code: '42501', message: 'permission denied' }],
    ['nothing at all', null],
  ])('takes %s for a failure to save', (_label, err) => {
    expect(addDriverFailure(err)).toBe('failed');
  });
});

describe('parseFleetMemberForm', () => {
  it('asks for the name and the phone of an empty form', () => {
    expect(parseFleetMemberForm(emptyFleetMemberForm)).toEqual({
      ok: false,
      errors: { name: 'required', phone: 'required' },
    });
  });

  it('does not take spaces for a name or a phone', () => {
    expect(parseFleetMemberForm({ ...filled, name: '   ', phone: '   ' })).toEqual({
      ok: false,
      errors: { name: 'required', phone: 'required' },
    });
  });

  it.each(['1234', '42345678', '+34612345678', 'cincuenta'])('refuses %s as a Cuban mobile', (phone) => {
    expect(parseFleetMemberForm({ ...filled, phone })).toEqual({ ok: false, errors: { phone: 'invalid' } });
  });

  it.each(['52345678', '63234567', '+53 5234 5678'])('takes %s as a Cuban mobile', (phone) => {
    expect(parseFleetMemberForm({ ...filled, phone }).ok).toBe(true);
  });

  it('trims what the owner typed', () => {
    expect(
      parseFleetMemberForm({
        name: '  Ana Díaz ',
        phone: ' 52345678 ',
        email: ' ana@example.com ',
        license: ' L-123 ',
        idNumber: ' 90010112345 ',
      }),
    ).toEqual({
      ok: true,
      member: {
        driver_name: 'Ana Díaz',
        driver_phone: '52345678',
        driver_email: 'ana@example.com',
        driver_license_number: 'L-123',
        driver_id_number: '90010112345',
      },
    });
  });

  it('leaves out the optional fields left empty', () => {
    expect(parseFleetMemberForm({ ...filled, email: '  ' })).toEqual({
      ok: true,
      member: { driver_name: 'Ana Díaz', driver_phone: '52345678' },
    });
  });
});
