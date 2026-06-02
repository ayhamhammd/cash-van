-- One-time data cleanup after the unit model revision.
-- Run via:  cat scripts/fix-units-data.sql | docker compose exec -T db psql -U cashvan -d cashvan
-- It is idempotent: each step is a no-op if already applied.

-- 1. Consolidate the duplicate piece units. The original migration created
--    `U001` from item_switch (mangled Arabic). A later POST /units created
--    `PCE`. Both have base_qty=1 — keep PCE, move any item_units to it.
UPDATE item_units
   SET unit_id = (SELECT id FROM units WHERE code = 'PCE')
 WHERE unit_id = (SELECT id FROM units WHERE code = 'U001');

DELETE FROM units WHERE code = 'U001';

-- 2. Rename the legacy carton (U002) to CTN24 and put real names on it.
UPDATE units
   SET code     = 'CTN24',
       name_ar  = 'كرتونة',
       name_en  = 'carton'
 WHERE code = 'U002';

-- 3. Repair the mangled Arabic / null English on the rest.
UPDATE units SET name_ar = 'حبة',   name_en = 'piece'  WHERE code = 'PCE';
UPDATE units SET name_ar = 'باكيت 6', name_en = '6-pack' WHERE code = 'PK6';
