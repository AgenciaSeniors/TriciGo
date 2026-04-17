-- Allow admin and super_admin roles to perform all ride state transitions.
-- Previously, driver-only transitions blocked admin users who also have
-- driver profiles from advancing ride status.

UPDATE valid_transitions SET allowed_roles = ARRAY['driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'searching' AND to_status = 'accepted';

UPDATE valid_transitions SET allowed_roles = ARRAY['driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'accepted' AND to_status = 'driver_en_route';

UPDATE valid_transitions SET allowed_roles = ARRAY['driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'driver_en_route' AND to_status = 'arrived_at_pickup';

UPDATE valid_transitions SET allowed_roles = ARRAY['driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'arrived_at_pickup' AND to_status = 'in_progress';

UPDATE valid_transitions SET allowed_roles = ARRAY['driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'in_progress' AND to_status = 'completed';

UPDATE valid_transitions SET allowed_roles = ARRAY['customer', 'driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'in_progress' AND to_status = 'disputed';

-- Ensure cancel transitions also include super_admin
UPDATE valid_transitions SET allowed_roles = ARRAY['customer', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'searching' AND to_status = 'canceled';

UPDATE valid_transitions SET allowed_roles = ARRAY['customer', 'driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'accepted' AND to_status = 'canceled';

UPDATE valid_transitions SET allowed_roles = ARRAY['driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'driver_en_route' AND to_status = 'canceled';

UPDATE valid_transitions SET allowed_roles = ARRAY['customer', 'driver', 'admin', 'super_admin']::user_role[]
WHERE from_status = 'arrived_at_pickup' AND to_status = 'canceled';
