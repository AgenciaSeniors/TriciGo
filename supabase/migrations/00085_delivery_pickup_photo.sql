-- Add pickup photo URL to delivery_details for 2-photo flow (pickup + delivery)
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS pickup_photo_url TEXT;
