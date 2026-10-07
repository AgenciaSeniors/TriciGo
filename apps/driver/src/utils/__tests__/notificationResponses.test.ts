import { describe, it, expect } from 'vitest';
import { claimNotificationResponse } from '../notificationResponses';

describe('claimNotificationResponse', () => {
  it('lets a notification response through once', () => {
    expect(claimNotificationResponse('notif-a')).toBe(true);
    // getLastNotificationResponseAsync hands back the same response when userId changes.
    expect(claimNotificationResponse('notif-a')).toBe(false);
    expect(claimNotificationResponse('notif-b')).toBe(true);
  });

  it('never blocks a response it cannot identify', () => {
    expect(claimNotificationResponse(undefined)).toBe(true);
    expect(claimNotificationResponse(undefined)).toBe(true);
    expect(claimNotificationResponse('')).toBe(true);
    expect(claimNotificationResponse(null)).toBe(true);
  });

  it('keeps remembering the recent ones after many responses', () => {
    for (let i = 0; i < 200; i += 1) claimNotificationResponse(`bulk-${i}`);
    expect(claimNotificationResponse('bulk-199')).toBe(false);
  });
});
