import { useState, useEffect } from 'react';
import { SUPPORT_WHATSAPP_PHONES } from '@tricigo/utils';
import { supportService } from '../services/support.service';

// The last numbers read, so the next help screen starts with them instead of
// flashing the built-in ones before the read answers.
let lastRead: string[] | null = null;

/**
 * The support WhatsApp numbers, in order (platform_config
 * `support_whatsapp_phones`, 00682). The one-tap buttons open the first; the
 * help screens list them all. Starts with the last numbers read (or the
 * built-in ones) and reads them again on every mount, so a change made in the
 * panel shows the next time a help screen opens. Never empty.
 */
export function useSupportPhones(): string[] {
  const [phones, setPhones] = useState<string[]>(() => lastRead ?? [...SUPPORT_WHATSAPP_PHONES]);

  useEffect(() => {
    let cancelled = false;
    void supportService.getWhatsAppPhones().then((value) => {
      lastRead = value;
      if (!cancelled) setPhones(value);
    });
    return () => { cancelled = true; };
  }, []);

  return phones;
}
