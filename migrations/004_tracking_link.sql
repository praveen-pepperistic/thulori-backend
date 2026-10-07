-- Optional courier tracking link (from Shiprocket, Delhivery…) shown to the customer and in the shipped email.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url text;
