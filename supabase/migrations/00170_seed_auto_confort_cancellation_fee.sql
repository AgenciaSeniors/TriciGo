-- ============================================================
-- BUG-113: `auto_confort` is listed in service_type_configs as active,
-- but cancellation_fee_configs had no row for it. Result:
-- calculate_cancellation_fee returned {fee_cup=0, reason='no_fee_config',
-- is_free=true} so any auto_confort ride could be canceled at any
-- stage for free. Silent loophole that costs drivers their time.
--
-- Fix: seed auto_confort with fees mirroring auto_standard. Operators
-- can later tune higher in /settings/cancellation-fee-configs if
-- auto_confort is meant to carry a premium penalty.
-- ============================================================

INSERT INTO cancellation_fee_configs (
  service_type, free_cancel_window_s,
  en_route_fee_cup, arrived_fee_cup,
  in_progress_fee_pct, in_progress_min_fee_cup,
  is_active
)
VALUES ('auto_confort', 120, 7500, 15000, 0.50, 15000, true)
ON CONFLICT DO NOTHING;
