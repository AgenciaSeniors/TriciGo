import { describe, it, expect } from 'vitest';
import {
  fleetRequestAnnouncement,
  fleetRequestErrorTexts,
  validateFleetRequestForm,
} from '../fleetRequestForm';

const driver = { driver_name: 'Ana Díaz', driver_phone: '52345678' };
const blankRow = {
  driver_name: '',
  driver_phone: '',
  driver_email: '',
  driver_license_number: '',
  driver_id_number: '',
};
const filled = { responsibleEmail: '', hoursStart: '', hoursEnd: '', members: [driver] };

describe('validateFleetRequestForm', () => {
  it('finds nothing wrong with a form filled in correctly', () => {
    expect(
      validateFleetRequestForm({
        responsibleEmail: 'flota@taxihabana.cu',
        hoursStart: '06:00',
        hoursEnd: '22:00',
        members: [driver, { ...driver, driver_phone: '+53 6323 4567', driver_email: 'ana@example.com' }],
      }),
    ).toBeNull();
  });

  it('does not ask for the optional fields', () => {
    expect(validateFleetRequestForm({ ...filled, responsibleEmail: '  ', hoursStart: ' ', hoursEnd: '' })).toBeNull();
  });

  describe('each driver row', () => {
    it.each(['1234', '42345678', '+34612345678', 'cincuenta'])('refuses %s as a Cuban mobile', (phone) => {
      const errors = validateFleetRequestForm({
        ...filled,
        members: [driver, { ...driver, driver_phone: phone }],
      });
      // By row, so the message goes under the field at fault.
      expect(errors?.members).toEqual([{}, { phone: 'invalid' }]);
    });

    it.each(['52345678', '63234567', '+53 5234 5678', ' 52345678 '])('takes %s as a Cuban mobile', (phone) => {
      expect(validateFleetRequestForm({ ...filled, members: [{ ...driver, driver_phone: phone }] })).toBeNull();
    });

    it('leaves out a row left empty, as the request does', () => {
      expect(validateFleetRequestForm({ ...filled, members: [blankRow, driver, { ...blankRow, driver_name: '  ' }] })).toBeNull();
    });

    it('does not drop a row filled in halfway: asks for what is missing', () => {
      const errors = validateFleetRequestForm({
        ...filled,
        members: [
          { ...blankRow, driver_name: 'Ana Díaz' },
          { ...blankRow, driver_phone: '52345678' },
          { ...blankRow, driver_license_number: 'L-123' },
        ],
      });
      expect(errors?.members).toEqual([
        { phone: 'required' },
        { name: 'required' },
        { name: 'required', phone: 'required' },
      ]);
    });

    it('checks the email only when there is one', () => {
      const errors = validateFleetRequestForm({
        ...filled,
        members: [
          { ...driver, driver_email: 'ana' },
          { ...driver, driver_email: ' ana@example.com ' },
          { ...driver, driver_email: '  ' },
          driver,
        ],
      });
      expect(errors?.members).toEqual([{ email: 'invalid' }, {}, {}, {}]);
    });
  });

  describe('the contact email', () => {
    it.each(['flota', 'flota@', 'flota@taxihabana', '@taxihabana.cu', 'flota @taxihabana.cu'])('refuses %s', (email) => {
      expect(validateFleetRequestForm({ ...filled, responsibleEmail: email })).toEqual({
        responsibleEmail: 'invalid',
        members: [{}],
      });
    });

    it('does not mind the spaces around it', () => {
      expect(validateFleetRequestForm({ ...filled, responsibleEmail: ' flota@taxihabana.cu ' })).toBeNull();
    });
  });

  describe('the operating hours', () => {
    it.each(['00:00', '06:00', '09:30', '19:05', '23:59', ' 06:00 '])('takes %s', (hour) => {
      expect(validateFleetRequestForm({ ...filled, hoursStart: hour, hoursEnd: hour })).toBeNull();
    });

    // The time column takes some of these and rejects others, so a bad value
    // used to fail the request after the account was created.
    it.each(['6:00', '24:00', '12:60', '22h', '0600', '06:00:00', '06.00', 'seis'])('refuses %s', (hour) => {
      expect(validateFleetRequestForm({ ...filled, hoursStart: hour, hoursEnd: hour })).toEqual({
        hoursStart: 'invalid',
        hoursEnd: 'invalid',
        members: [{}],
      });
    });

    it('checks each one on its own, since either can be left out', () => {
      expect(validateFleetRequestForm({ ...filled, hoursEnd: '22h' })).toEqual({ hoursEnd: 'invalid', members: [{}] });
      expect(validateFleetRequestForm({ ...filled, hoursStart: '6:00', hoursEnd: '22:00' })).toEqual({
        hoursStart: 'invalid',
        members: [{}],
      });
    });
  });
});

describe('fleetRequestErrorTexts', () => {
  const t = (key: string) => `text of ${key}`;

  it('has no text for a field without an error', () => {
    expect(fleetRequestErrorTexts({ members: [{}, {}] }, t)).toEqual({ members: [{}, {}] });
  });

  it('says what to fix in each field', () => {
    expect(
      fleetRequestErrorTexts(
        { responsibleEmail: 'invalid', hoursStart: 'invalid', hoursEnd: 'invalid', members: [{ email: 'invalid' }] },
        t,
      ),
    ).toEqual({
      responsibleEmail: 'text of fleet.request_email_invalid',
      hoursStart: 'text of fleet.request_hours_start_invalid',
      hoursEnd: 'text of fleet.request_hours_end_invalid',
      members: [{ email: 'text of fleet.request_email_invalid' }],
    });
  });

  it('uses the same messages as the add driver form for the name and the phone', () => {
    expect(
      fleetRequestErrorTexts({ members: [{ name: 'required', phone: 'required' }, { phone: 'invalid' }] }, t).members,
    ).toEqual([
      { name: 'text of fleet.add_driver_name_required', phone: 'text of fleet.add_driver_phone_required' },
      { phone: 'text of fleet.add_driver_phone_invalid' },
    ]);
  });
});

describe('fleetRequestAnnouncement', () => {
  const t = (key: string, options: { row?: number }) => (options.row ? `${key} ${options.row}` : key);

  it('reads the errors in the order of the form and says which driver each one is about', () => {
    expect(
      fleetRequestAnnouncement(
        {
          hoursEnd: 'invalid',
          responsibleEmail: 'invalid',
          members: [{}, { email: 'invalid', phone: 'invalid', name: 'required' }, {}, { phone: 'required' }],
        },
        t,
      ),
    ).toBe(
      'fleet.request_email_invalid fleet.request_hours_end_invalid ' +
        'fleet.request_driver_row 2: fleet.add_driver_name_required fleet.add_driver_phone_invalid fleet.request_email_invalid ' +
        'fleet.request_driver_row 4: fleet.add_driver_phone_required',
    );
  });
});
