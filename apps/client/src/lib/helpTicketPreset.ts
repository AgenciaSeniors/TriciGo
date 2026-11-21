import type { TicketCategory } from '@tricigo/types';

/**
 * What the Help screen opens when another screen links to it with `?newTicket=<kind>`.
 * Only the Safety Center uses it (QA R4-06): a safety report outside a ride goes to support as a
 * ride ticket with the subject already written, so the rider only tells what happened.
 */
export interface HelpTicketPreset {
  category: TicketCategory;
  subjectKey: string;
}

export function helpTicketPreset(param: string | string[] | undefined): HelpTicketPreset | null {
  if (param === 'safety') return { category: 'ride_issue', subjectKey: 'profile.help_safety_subject' };
  return null;
}
