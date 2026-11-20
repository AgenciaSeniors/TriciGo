import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keyboardInset } from '../keyboardInset';

// R2-07 (QA round 2026-11-17): on Android the keyboard covered the ride chat:
// the messages, the text being typed and the Send button. With edge-to-edge,
// KeyboardAvoidingView misplaces the keyboard. Measured on the emulator: the
// keyboard was 275 dp tall (screenY 501), but the view took its first height
// (800, before the safe-area insets) and compared a position relative to its
// parent with one relative to the screen, so 'height' still left the input
// under the keyboard. The chat now pads itself by the keyboard height Android
// reports.

describe('keyboardInset', () => {
  it('is the keyboard height Android reports, whatever the screen position', () => {
    expect(keyboardInset({ endCoordinates: { height: 275, screenY: 501 } })).toBe(275);
    expect(keyboardInset({ endCoordinates: { height: 274.6, screenY: 800 } })).toBe(275);
  });

  it('is 0 with no keyboard', () => {
    expect(keyboardInset(null)).toBe(0);
    expect(keyboardInset({ endCoordinates: { height: 0, screenY: 800 } })).toBe(0);
    expect(keyboardInset({ endCoordinates: { height: -24, screenY: 800 } })).toBe(0);
  });
});

describe('ride chat screen', () => {
  const chat = readFileSync(fileURLToPath(new URL('../../../app/chat/[rideId].tsx', import.meta.url)), 'utf8');

  it('keeps its content above the keyboard with KeyboardAwareView', () => {
    expect(chat).toMatch(/<KeyboardAwareView\b/);
    expect(chat).not.toMatch(/<KeyboardAvoidingView\b/);
  });
});
