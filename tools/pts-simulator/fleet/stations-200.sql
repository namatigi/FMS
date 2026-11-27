-- DEV ONLY: 200 simulated direct-mode stations for load tests and demos. Never load in production.
-- Applied by `make sim-fleet`; safe to re-run (existing rows are left alone).
-- Station codes <PROVINCE>-1001 .. -1200 across all 10 provinces, owned by 5 companies
-- (the two demo-seed companies plus three added here).
-- Controllers: PTS ids 0A5100000000000000000001 .. 0A51000000000000000000C8, secret devsecret-sim.
-- Each station: tank 1 PETROL 30 000 L, tank 2 DIESEL 40 000 L; 2 pumps x 2 nozzles (as in 001_demo.sql).
SET search_path = fms, public;
BEGIN;

INSERT INTO companies (id, name, zra_tpin, erb_licence_no, contact_email) VALUES
  ('33333333-3333-3333-3333-333333333333', 'Kafue Oil Ltd',          '1000000003', 'ERB/OMC/003', 'ops@kafueoil.example'),
  ('44444444-4444-4444-4444-444444444444', 'Luangwa Energy Ltd',     '1000000004', 'ERB/OMC/004', 'ops@luangwa.example'),
  ('55555555-5555-5555-5555-555555555555', 'Barotse Petroleum Ltd',  '1000000005', 'ERB/OMC/005', 'ops@barotse.example')
ON CONFLICT DO NOTHING;

-- Province weights (out of 20): Lusaka 5, Copperbelt 4, Central 2, Southern 2, Eastern 2, others 1.
WITH w(pid, n, lat, lon, town) AS (VALUES
  (5, 5, -15.42, 28.28, 'Lusaka'), (2, 4, -12.80, 28.21, 'Kitwe'), (1, 2, -14.45, 28.45, 'Kabwe'),
  (9, 2, -17.84, 25.85, 'Livingstone'), (3, 2, -13.64, 32.65, 'Chipata'), (4, 1, -11.20, 28.89, 'Mansa'),
  (6, 1, -10.55, 32.07, 'Chinsali'), (7, 1, -10.21, 31.18, 'Kasama'), (8, 1, -12.17, 26.39, 'Solwezi'),
  (10, 1, -15.25, 23.13, 'Mongu')),
slots AS (SELECT pid, lat, lon, town, row_number() OVER () AS slot FROM w, generate_series(1, n)),
src AS (
  SELECT i, s.*
  FROM generate_series(1, 200) i
  JOIN slots s ON s.slot = ((i - 1) % 20) + 1
)
INSERT INTO stations (company_id, code, name, province_id, district, town, latitude, longitude, erb_licence_no, zra_branch_id, connection_mode)
SELECT (ARRAY['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
              '33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444',
              '55555555-5555-5555-5555-555555555555']::uuid[])[(i % 5) + 1],
       p.code || '-' || (1000 + i), town || ' Station ' || i, pid, town, town,
       round((lat + ((i * 37) % 100 - 50) / 250.0)::numeric, 6), round((lon + ((i * 61) % 100 - 50) / 250.0)::numeric, 6),
       'ERB/RS/S' || i, lpad(((i % 900) + 100)::text, 3, '0'), 'direct'
FROM src JOIN provinces p ON p.id = src.pid
ON CONFLICT (code) DO NOTHING;

CREATE TEMP TABLE sim_st ON COMMIT DROP AS
SELECT s.id, row_number() OVER (ORDER BY (split_part(s.code, '-', 2))::int) AS i
FROM stations s WHERE split_part(s.code, '-', 2) ~ '^1[0-9]{3}$' AND s.erb_licence_no LIKE 'ERB/RS/S%';

INSERT INTO controllers (station_id, pts_id, hmac_secret)
SELECT id, '0A51' || lpad(upper(to_hex(i)), 20, '0'), 'devsecret-sim' FROM sim_st
ON CONFLICT (pts_id) DO NOTHING;

INSERT INTO tanks (station_id, tank_no, product_code, capacity_l, low_level_l)
SELECT s.id, t.no, t.p, t.cap, t.cap * 0.2
FROM sim_st s CROSS JOIN (VALUES (1, 'PETROL', 30000), (2, 'DIESEL', 40000)) AS t(no, p, cap)
WHERE NOT EXISTS (SELECT 1 FROM tanks x WHERE x.station_id = s.id);

INSERT INTO fuel_grades (station_id, pts_grade_id, name, product_code, zra_item_code, price)
SELECT s.id, g.id, g.name, g.p, g.item, g.price
FROM sim_st s CROSS JOIN (VALUES (1, 'Unleaded Petrol', 'PETROL', 'ZM1NTLTR0000001', 31.85),
                                 (2, 'Diesel LSD',      'DIESEL', 'ZM1NTLTR0000002', 29.95)) AS g(id, name, p, item, price)
WHERE NOT EXISTS (SELECT 1 FROM fuel_grades x WHERE x.station_id = s.id);

INSERT INTO nozzles (station_id, pump_no, nozzle_no, fuel_grade_id, tank_id)
SELECT s.id, pmp.no, nz.no, fg.id, t.id
FROM sim_st s
CROSS JOIN (VALUES (1), (2)) AS pmp(no)
CROSS JOIN (VALUES (1), (2)) AS nz(no)
JOIN fuel_grades fg ON fg.station_id = s.id AND fg.pts_grade_id = nz.no
JOIN tanks t        ON t.station_id = s.id AND t.tank_no = nz.no
WHERE NOT EXISTS (SELECT 1 FROM nozzles x WHERE x.station_id = s.id);

SELECT count(*) AS sim_stations FROM sim_st;
COMMIT;
