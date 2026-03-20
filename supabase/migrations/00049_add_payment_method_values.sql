-- Migration: Add missing payment_method enum values
-- The TypeScript type includes 'tropipay' and 'corporate' but the DB enum only had
-- 'tricicoin', 'cash', 'mixed'. This caused INSERT failures for those payment methods.

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'tropipay';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'corporate';
