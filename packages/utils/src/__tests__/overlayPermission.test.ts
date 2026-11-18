import { describe, it, expect } from 'vitest';
import {
  OVERLAY_PROMPT_COOLDOWN_MS,
  isPromptDue,
  isXiaomiFamily,
  nextOverlayStep,
} from '../overlayPermission';

describe('isXiaomiFamily', () => {
  it.each([
    ['Xiaomi', null],
    [null, 'Redmi'],
    ['xiaomi', 'POCO'],
    ['XIAOMI', 'redmi'],
  ])('%s/%s → true', (m, b) => expect(isXiaomiFamily(m, b)).toBe(true));

  it.each([
    ['samsung', 'samsung'],
    ['motorola', null],
    [null, null],
    ['', ''],
  ])('%s/%s → false', (m, b) => expect(isXiaomiFamily(m, b)).toBe(false));
});

describe('isPromptDue', () => {
  const now = 1_000_000_000_000;
  it('is due when never shown', () => expect(isPromptDue(null, now)).toBe(true));
  it('is not due 1 ms before the cooldown', () =>
    expect(isPromptDue(now - OVERLAY_PROMPT_COOLDOWN_MS + 1, now)).toBe(false));
  it('is due exactly at the cooldown', () =>
    expect(isPromptDue(now - OVERLAY_PROMPT_COOLDOWN_MS, now)).toBe(true));
  it('is due when the stored time is in the future (clock moved back)', () =>
    expect(isPromptDue(now + 60_000, now)).toBe(true));
});

describe('nextOverlayStep', () => {
  const now = 1_000_000_000_000;
  const base = {
    moduleAvailable: true,
    overlayGranted: false,
    xiaomiFamily: false,
    xiaomiOk: false,
    overlayPromptAt: null,
    xiaomiPromptAt: null,
    now,
  };
  it('asks for the overlay when missing and due', () => expect(nextOverlayStep(base)).toBe('overlay'));
  it('says nothing without the native module', () =>
    expect(nextOverlayStep({ ...base, moduleAvailable: false })).toBe('none'));
  it('respects the overlay cooldown', () =>
    expect(nextOverlayStep({ ...base, overlayPromptAt: now - 1000 })).toBe('none'));
  it('says nothing to a granted non-Xiaomi phone', () =>
    expect(nextOverlayStep({ ...base, overlayGranted: true })).toBe('none'));
  it('asks the Xiaomi step once the overlay is granted', () =>
    expect(
      nextOverlayStep({ ...base, overlayGranted: true, xiaomiFamily: true, overlayPromptAt: now - 1000 }),
    ).toBe('xiaomi'));
  it('the overlay cooldown does not hide the Xiaomi step', () =>
    expect(nextOverlayStep({ ...base, overlayGranted: true, xiaomiFamily: true, overlayPromptAt: now })).toBe(
      'xiaomi',
    ));
  it('respects the Xiaomi cooldown', () =>
    expect(
      nextOverlayStep({ ...base, overlayGranted: true, xiaomiFamily: true, xiaomiPromptAt: now - 1000 }),
    ).toBe('none'));
  it('stops for good once the Xiaomi step is done', () =>
    expect(nextOverlayStep({ ...base, overlayGranted: true, xiaomiFamily: true, xiaomiOk: true })).toBe('none'));
  it('never asks the Xiaomi step before the overlay is granted', () =>
    expect(nextOverlayStep({ ...base, xiaomiFamily: true, overlayPromptAt: now - 1000 })).toBe('none'));
});
