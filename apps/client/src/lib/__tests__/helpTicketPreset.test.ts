import { describe, expect, it } from 'vitest';
import { helpTicketPreset } from '../helpTicketPreset';

// QA R4-06 (round 4, 2026-11-20): "Reportar Problema de Seguridad" opened the FAQ, whose answer
// sent the rider back to the Safety Center. It now opens the ticket form with the subject filled.

describe('helpTicketPreset', () => {
  it('opens a ride ticket about safety from the Safety Center', () => {
    expect(helpTicketPreset('safety')).toEqual({ category: 'ride_issue', subjectKey: 'profile.help_safety_subject' });
  });

  it('opens nothing for any other value', () => {
    expect(helpTicketPreset(undefined)).toBeNull();
    expect(helpTicketPreset('')).toBeNull();
    expect(helpTicketPreset('payment')).toBeNull();
    expect(helpTicketPreset(['safety'])).toBeNull();
  });
});
