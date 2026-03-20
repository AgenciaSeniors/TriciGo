-- Allow 'eltoque_scraping' as a valid source for exchange rates
-- This supports the new scraping fallback in sync-exchange-rate edge function

ALTER TABLE exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_source_check;
ALTER TABLE exchange_rates ADD CONSTRAINT exchange_rates_source_check
  CHECK (source = ANY (ARRAY['eltoque_api'::text, 'eltoque_scraping'::text, 'manual'::text]));
