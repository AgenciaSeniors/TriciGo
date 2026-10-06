import { describe, it, expect } from 'vitest';
import {
  REQUIRED_DRIVER_DOCS,
  driverDocLabel,
  whatsAppDigits,
  waMeLink,
  incompleteSignupMessage,
} from '../driverOutreach';

describe('REQUIRED_DRIVER_DOCS', () => {
  it('lists the five documents the approval needs, in onboarding order', () => {
    expect(REQUIRED_DRIVER_DOCS).toEqual([
      'national_id', 'selfie', 'drivers_license', 'vehicle_registration', 'vehicle_photo',
    ]);
  });
});

describe('driverDocLabel', () => {
  it('uses the names the driver app shows', () => {
    expect(driverDocLabel('national_id')).toBe('Carné de identidad');
    expect(driverDocLabel('vehicle_registration')).toBe('Matrícula del vehículo');
  });

  it('falls back to the raw type for an unknown document', () => {
    expect(driverDocLabel('something_new')).toBe('something_new');
  });
});

describe('whatsAppDigits', () => {
  it('keeps only the digits of an E.164 number', () => {
    expect(whatsAppDigits('+53 5 555 0001')).toBe('5355550001');
  });

  it('adds the Cuban country code to an 8-digit local mobile', () => {
    expect(whatsAppDigits('55550001')).toBe('5355550001');
  });

  it('returns null when there is nothing dialable', () => {
    expect(whatsAppDigits(null)).toBeNull();
    expect(whatsAppDigits('')).toBeNull();
    expect(whatsAppDigits('12345')).toBeNull();
  });
});

describe('waMeLink', () => {
  it('builds a wa.me link with the text encoded', () => {
    expect(waMeLink('+5355550001', 'Hola, ¿todo bien?')).toBe(
      'https://wa.me/5355550001?text=Hola%2C%20%C2%BFtodo%20bien%3F',
    );
  });

  it('returns null without a usable phone', () => {
    expect(waMeLink(null, 'Hola')).toBeNull();
  });
});

describe('incompleteSignupMessage', () => {
  it('greets by first name and lists what is missing, in lower case', () => {
    const msg = incompleteSignupMessage({
      fullName: '  María José Pérez ',
      missingDocs: ['national_id', 'drivers_license', 'vehicle_photo'],
      rejectedDocs: [],
    });
    expect(msg).toContain('Hola María,');
    expect(msg).toContain('sube: carné de identidad, licencia de conducción y foto del vehículo.');
    expect(msg).toContain('TriciGo Conductor');
  });

  it('asks to upload again the documents that were rejected', () => {
    const msg = incompleteSignupMessage({
      fullName: 'Pedro',
      missingDocs: ['selfie'],
      rejectedDocs: ['vehicle_photo'],
    });
    expect(msg).toContain('sube: selfie de verificación.');
    expect(msg).toContain('vuelve a subir: foto del vehículo');
  });

  it('when every document is in, points to the vehicle details and sending the application', () => {
    const msg = incompleteSignupMessage({ fullName: 'Ana', missingDocs: [], rejectedDocs: [] });
    expect(msg).toContain('Ya subiste todos los documentos');
    expect(msg).not.toContain('sube:');
  });

  it('works without a name', () => {
    const msg = incompleteSignupMessage({ fullName: null, missingDocs: ['selfie'], rejectedDocs: [] });
    expect(msg.startsWith('Hola, te escribimos de TriciGo.')).toBe(true);
  });

  it('joins two items with "y" and one item alone', () => {
    expect(
      incompleteSignupMessage({ fullName: 'Ana', missingDocs: ['selfie', 'national_id'], rejectedDocs: [] }),
    ).toContain('sube: selfie de verificación y carné de identidad.');
  });
});
