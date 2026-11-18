import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.8.0' } } }));

import { getDeviceMaker } from '../device';

describe('getDeviceMaker', () => {
  it("reads the phone's maker, brand and Android version", () => {
    expect(getDeviceMaker(() => ({ manufacturer: 'Xiaomi', brand: 'Redmi', osVersion: '14' }))).toEqual({
      manufacturer: 'Xiaomi',
      brand: 'Redmi',
      osVersion: '14',
    });
  });

  it('treats a missing expo-device as an unknown maker', () => {
    const load = () => {
      throw new Error("Cannot find native module 'ExpoDevice'");
    };
    expect(getDeviceMaker(load)).toEqual({ manufacturer: null, brand: null, osVersion: null });
  });

  it('turns undefined fields into null', () => {
    expect(getDeviceMaker(() => ({}))).toEqual({ manufacturer: null, brand: null, osVersion: null });
  });
});
