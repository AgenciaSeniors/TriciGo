import { describe, it, expect, beforeEach, vi } from 'vitest';

const openURL = vi.fn(async () => true);
vi.mock('react-native', () => ({
  Linking: { openURL: (...a: unknown[]) => openURL(...(a as [])) },
}));

import { openSupportPanelLink } from '../supportPanel';

const URL = 'https://admin.tricigo.com/rides/7a28083f-dde9-4fb8-8ab8-25989fb196ef/assist';

describe('openSupportPanelLink', () => {
  beforeEach(() => openURL.mockClear());

  it('opens the assist page of a support alert and reports it handled the tap', () => {
    expect(openSupportPanelLink({ type: 'system', event: 'support_help', url: URL })).toBe(true);
    expect(openURL).toHaveBeenCalledWith(URL);
  });

  it('leaves every other push to the normal navigation', () => {
    expect(openSupportPanelLink({ type: 'system', title: 'Novedades' })).toBe(false);
    expect(openSupportPanelLink({ type: 'ride', ride_id: 'x' })).toBe(false);
    expect(openSupportPanelLink(null)).toBe(false);
    expect(openURL).not.toHaveBeenCalled();
  });

  it('never opens a link outside the panel assist page', () => {
    expect(openSupportPanelLink({ event: 'support_help', url: 'https://evil.example/' })).toBe(false);
    expect(openURL).not.toHaveBeenCalled();
  });

  it('does not throw when the phone cannot open the link', async () => {
    openURL.mockRejectedValueOnce(new Error('no browser'));
    expect(openSupportPanelLink({ event: 'support_wait', url: URL })).toBe(true);
    await Promise.resolve();
  });
});
