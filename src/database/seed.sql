-- ============================================================
-- INCORED ERP - Seed Data
-- Run AFTER schema.sql
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- COMPANIES (4 empresas del grupo)
-- ─────────────────────────────────────────────────────────────
INSERT INTO companies (name, short_code, country, industry, email, rfc)
VALUES
  ('Incored y Asociados',    'INC', 'Mexico', 'Telecommunications', 'operaciones@incored.com.mx',     'IAA000101AAA'),
  ('Zhada Construcciones',   'ZHA', 'Mexico', 'Telecommunications', 'operaciones@zhada.mx',           'ZCO000101BBB'),
  ('Incored International',  'INT', 'USA',    'Telecommunications', 'operations@incored-intl.com',    'IIN000101CCC'),
  ('Mika Importaciones',     'MKA', 'Global', 'Materials Supply',   'operaciones@mika.mx',            'MIM000101DDD')
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- ADMIN USER
-- Password: Admin123! (bcrypt hash, 10 rounds)
-- IMPORTANT: Change this password immediately after first login
-- ─────────────────────────────────────────────────────────────
INSERT INTO users (email, password_hash, name, company_id, role, status, must_change_password)
VALUES (
  'admin@incored.com.mx',
  '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',  -- Admin123!
  'Administrador Sistema',
  1,
  'admin',
  'active',
  TRUE
)
ON CONFLICT (email) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- SAMPLE CLIENTS
-- ─────────────────────────────────────────────────────────────
INSERT INTO clients (name, type, rfc, country, industry, primary_contact_name, primary_contact_email, payment_terms)
VALUES
  ('CFE Distribución',         'cliente',   'CFE370814QI0', 'Mexico', 'Energy',             'Licitaciones CFE',        'licitaciones@cfe.mx',         '30_dias'),
  ('Telmex SA de CV',          'cliente',   'TEL911231KI4', 'Mexico', 'Telecommunications', 'Contratos Telmex',        'contratos@telmex.com',        '30_dias'),
  ('Pemex Exploración',        'cliente',   'PEP840101QX0', 'Mexico', 'Oil & Gas',          'Procurement',             'procurement@pemex.com',       '60_dias'),
  ('Distribuidora Global SRL', 'proveedor', 'DGS010101AAA', 'Mexico', 'Materials Supply',   'Carlos Mendoza',          'carlos@distglobal.mx',        '15_dias'),
  ('Herramientas Técnicas SA', 'proveedor', 'HTE020202BBB', 'Mexico', 'Tools & Equipment',  'Ana Torres',              'ana@herrtecnicas.mx',         'contado')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- SAMPLE INVENTORY MATERIALS
-- ─────────────────────────────────────────────────────────────
INSERT INTO inventory_materials (sku, name, category, quantity_stock, quantity_min, quantity_max, unit_of_measure, cost_last_purchase, company_id)
VALUES
  ('CAB-FIB-001', 'Cable de fibra óptica SM 12 hilos',  'Cables',       500,  100, 2000, 'metros',   45.00,  1),
  ('CAB-FIB-002', 'Cable de fibra óptica SM 24 hilos',  'Cables',       300,  50,  1500, 'metros',   85.00,  1),
  ('CON-FIB-001', 'Conector SC/APC',                    'Conectores',   1000, 200, 5000, 'unidad',    8.50,  1),
  ('CON-FIB-002', 'Conector LC/UPC',                    'Conectores',   800,  200, 4000, 'unidad',    7.20,  1),
  ('EQU-OTD-001', 'OTD-8 Equipo de distribución',       'Equipos',      50,   10,  200,  'unidad', 1250.00, 1),
  ('MAT-SOP-001', 'Poste de concreto 9m',               'Estructura',   80,   20,  300,  'unidad', 1800.00, 2),
  ('MAT-SOP-002', 'Mensajero de acero 3/8"',            'Estructura',   2000, 500, 8000, 'metros',   12.50,  2),
  ('SWT-MNG-001', 'Switch administrable 24 puertos',    'Equipos',      25,   5,   100,  'unidad', 4500.00, 1)
ON CONFLICT (sku) DO NOTHING;
