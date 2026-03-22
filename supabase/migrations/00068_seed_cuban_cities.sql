-- Seed all major Cuban cities for nationwide launch
INSERT INTO cities (name, slug, country, timezone, center_latitude, center_longitude, bounds_ne_lat, bounds_ne_lng, bounds_sw_lat, bounds_sw_lng) VALUES
('Santiago de Cuba', 'santiago', 'CU', 'America/Havana', 20.0247, -75.8214, 20.10, -75.75, 19.95, -75.90),
('Camagüey', 'camaguey', 'CU', 'America/Havana', 21.3808, -77.9167, 21.45, -77.85, 21.30, -77.98),
('Holguín', 'holguin', 'CU', 'America/Havana', 20.7203, -76.2631, 20.80, -76.20, 20.65, -76.33),
('Santa Clara', 'santa-clara', 'CU', 'America/Havana', 22.4069, -79.9644, 22.47, -79.90, 22.34, -80.03),
('Guantánamo', 'guantanamo', 'CU', 'America/Havana', 20.1419, -75.2092, 20.20, -75.14, 20.08, -75.28),
('Bayamo', 'bayamo', 'CU', 'America/Havana', 20.3789, -76.6433, 20.44, -76.58, 20.32, -76.71),
('Las Tunas', 'las-tunas', 'CU', 'America/Havana', 20.9608, -76.9514, 21.03, -76.88, 20.89, -77.02),
('Cienfuegos', 'cienfuegos', 'CU', 'America/Havana', 22.1461, -80.4403, 22.21, -80.37, 22.08, -80.51),
('Pinar del Río', 'pinar-del-rio', 'CU', 'America/Havana', 22.4175, -83.6978, 22.48, -83.63, 22.35, -83.77),
('Matanzas', 'matanzas', 'CU', 'America/Havana', 23.0411, -81.5775, 23.10, -81.51, 22.98, -81.65),
('Sancti Spíritus', 'sancti-spiritus', 'CU', 'America/Havana', 21.9303, -79.4422, 21.99, -79.38, 21.87, -79.51),
('Ciego de Ávila', 'ciego-de-avila', 'CU', 'America/Havana', 21.8403, -78.7622, 21.90, -78.70, 21.78, -78.83),
('Trinidad', 'trinidad', 'CU', 'America/Havana', 21.8022, -79.9839, 21.85, -79.92, 21.75, -80.05),
('Varadero', 'varadero', 'CU', 'America/Havana', 23.1544, -81.2542, 23.20, -81.19, 23.10, -81.32)
ON CONFLICT (slug) DO NOTHING;
