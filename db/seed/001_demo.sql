-- =====================================================================
-- DEMO / DEVELOPMENT SEED — never load in production.
-- All demo users have password: ChangeMe123!
-- Password hash format (core-api): scrypt$N$r$p$<salt base64>$<64-byte key base64>
-- Demo credentials (dev only):
--   Gateway LUS-0001 key : gwLUS001.dev-gateway-key-lus-0001
--   Gateway COP-0001 key : gwCOP001.dev-gateway-key-cop-0001
--   Partner (ERB) API key: erbdemo1.dev-partner-key-erb
--   PTS-2 LUS-0001 secret: devsecret-lus-0001   (others: no secret)
-- =====================================================================
SET search_path = fms, public;

INSERT INTO companies (id, name, zra_tpin, erb_licence_no, contact_email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Zambezi Petroleum Ltd', '1000000001', 'ERB/OMC/001', 'ops@zambezi.example'),
  ('22222222-2222-2222-2222-222222222222', 'Copper Fuels Ltd',      '1000000002', 'ERB/OMC/002', 'ops@copperfuels.example');

INSERT INTO stations (id, company_id, code, name, province_id, district, town, latitude, longitude, erb_licence_no, zra_branch_id, connection_mode) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'LUS-0001', 'Zambezi Cairo Road',  5, 'Lusaka',  'Lusaka',  -15.416700, 28.283300, 'ERB/RS/1001', '000', 'edge'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'CEN-0001', 'Zambezi Kabwe North', 1, 'Kabwe',   'Kabwe',   -14.446900, 28.446400, 'ERB/RS/1002', '001', 'direct'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'COP-0001', 'Copper Fuels Kitwe',  2, 'Kitwe',   'Kitwe',   -12.802400, 28.213200, 'ERB/RS/2001', '000', 'edge'),
  ('aaaaaaaa-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'SOU-0001', 'Copper Fuels Livingstone', 9, 'Livingstone', 'Livingstone', -17.841900, 25.854300, 'ERB/RS/2002', '001', 'direct');

INSERT INTO controllers (station_id, pts_id, hmac_secret) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '003B00265030500420303531', 'devsecret-lus-0001'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '003B00265030500420303532', NULL),
  ('aaaaaaaa-0000-0000-0000-000000000003', '003B00265030500420303533', NULL),
  ('aaaaaaaa-0000-0000-0000-000000000004', '003B00265030500420303534', NULL);

INSERT INTO edge_gateways (station_id, gateway_code, api_key_hash) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'GW-LUS-0001', '9857d8faf9b07cdefa3ab5555dd36c137dc6ce4ba75acc80ade0cce82f3b9802'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'GW-COP-0001', '5e7564cedcf2c3b656072de42407e883368f49196320a965d2aa9633ab3874b4');

-- Each station: tank 1 PETROL 30 000 L, tank 2 DIESEL 40 000 L; 2 pumps × 2 nozzles (1=petrol, 2=diesel)
INSERT INTO tanks (station_id, tank_no, product_code, capacity_l, low_level_l)
SELECT s.id, t.no, t.p, t.cap, t.cap * 0.2
FROM stations s CROSS JOIN (VALUES (1, 'PETROL', 30000), (2, 'DIESEL', 40000)) AS t(no, p, cap);

INSERT INTO fuel_grades (station_id, pts_grade_id, name, product_code, zra_item_code, price)
SELECT s.id, g.id, g.name, g.p, g.item, g.price
FROM stations s CROSS JOIN (VALUES (1, 'Unleaded Petrol', 'PETROL', 'ZM1NTLTR0000001', 31.85),
                                   (2, 'Diesel LSD',      'DIESEL', 'ZM1NTLTR0000002', 29.95)) AS g(id, name, p, item, price);

INSERT INTO nozzles (station_id, pump_no, nozzle_no, fuel_grade_id, tank_id)
SELECT s.id, pmp.no, nz.no, fg.id, t.id
FROM stations s
CROSS JOIN (VALUES (1), (2)) AS pmp(no)
CROSS JOIN (VALUES (1), (2)) AS nz(no)
JOIN fuel_grades fg ON fg.station_id = s.id AND fg.pts_grade_id = nz.no
JOIN tanks t        ON t.station_id = s.id AND t.tank_no = nz.no;

-- ERB cap prices (national)
INSERT INTO price_changes (product_code, price, kind, effective_at) VALUES
  ('PETROL', 32.15, 'erb_cap', '2026-11-01T00:00:00+02:00'),
  ('DIESEL', 30.29, 'erb_cap', '2026-11-01T00:00:00+02:00'),
  ('KEROSENE', 26.80, 'erb_cap', '2026-11-01T00:00:00+02:00');

-- Users (password ChangeMe123!)
INSERT INTO users (email, full_name, password_hash, role, company_id, province_id) VALUES
  ('admin@fms.local',     'Platform Admin',        'scrypt$16384$8$1$w7vXiGeMVRNXTVyw+ec+QA==$vroHQeQLZHrHADYdk9MAwvlI7W9dX1d00faizG29Pajs3P+cr0UxH21raUzaW694nYo+s7oy7PM3G+7ByUg2Iw==', 'platform_admin', NULL, NULL),
  ('owner@zambezi.local', 'Zambezi Owner',         'scrypt$16384$8$1$w7vXiGeMVRNXTVyw+ec+QA==$vroHQeQLZHrHADYdk9MAwvlI7W9dX1d00faizG29Pajs3P+cr0UxH21raUzaW694nYo+s7oy7PM3G+7ByUg2Iw==', 'owner', '11111111-1111-1111-1111-111111111111', NULL),
  ('manager@zambezi.local','Cairo Road Manager',   'scrypt$16384$8$1$w7vXiGeMVRNXTVyw+ec+QA==$vroHQeQLZHrHADYdk9MAwvlI7W9dX1d00faizG29Pajs3P+cr0UxH21raUzaW694nYo+s7oy7PM3G+7ByUg2Iw==', 'manager', '11111111-1111-1111-1111-111111111111', NULL),
  ('erb@erb.local',       'ERB National Analyst',  'scrypt$16384$8$1$w7vXiGeMVRNXTVyw+ec+QA==$vroHQeQLZHrHADYdk9MAwvlI7W9dX1d00faizG29Pajs3P+cr0UxH21raUzaW694nYo+s7oy7PM3G+7ByUg2Iw==', 'erb_national', NULL, NULL),
  ('erb.cop@erb.local',   'ERB Copperbelt Officer','scrypt$16384$8$1$w7vXiGeMVRNXTVyw+ec+QA==$vroHQeQLZHrHADYdk9MAwvlI7W9dX1d00faizG29Pajs3P+cr0UxH21raUzaW694nYo+s7oy7PM3G+7ByUg2Iw==', 'erb_provincial', NULL, 2),
  ('zra@zra.local',       'ZRA Auditor',           'scrypt$16384$8$1$w7vXiGeMVRNXTVyw+ec+QA==$vroHQeQLZHrHADYdk9MAwvlI7W9dX1d00faizG29Pajs3P+cr0UxH21raUzaW694nYo+s7oy7PM3G+7ByUg2Iw==', 'zra_auditor', NULL, NULL);

INSERT INTO user_station_access (user_id, station_id)
SELECT u.id, 'aaaaaaaa-0000-0000-0000-000000000001' FROM users u WHERE u.email = 'manager@zambezi.local';

INSERT INTO api_clients (name, organisation, key_prefix, key_hash, scopes, province_id) VALUES
  ('ERB data exchange (demo)', 'Energy Regulation Board', 'erbdemo1',
   '3c0187e6a9ad7d65f13fa82207efb5b591bcdf86b93c24255f83d091b5e7d221',
   ARRAY['stations:read','stock:read','sales:read','prices:read','alerts:read'], NULL);
