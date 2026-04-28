-- ============================================================
-- INCORED ERP — seed.sql
-- Datos iniciales de producción
-- Ejecutar DESPUÉS de schema.sql:
--   psql $DATABASE_URL -f database/seed.sql
-- ============================================================

-- ============================================================
-- 1. EMPRESAS DEL GRUPO
-- ============================================================

INSERT INTO companies (name, short_code, country, industry, email, phone, rfc)
VALUES
  ('Incored y Asociados',   'INC', 'Mexico', 'Telecommunications', 'operaciones@incored.com.mx',   '+52 55 1234 5678', 'IAA000101AAA'),
  ('Zhada Construcciones',  'ZHA', 'Mexico', 'Telecommunications', 'operaciones@zhada.mx',          '+52 55 2345 6789', 'ZCO000101BBB'),
  ('Incored International', 'INT', 'USA',    'Telecommunications', 'operations@incored-intl.com',   '+1 512 345 6789',  'IIN000101CCC'),
  ('Mika Importaciones',    'MKA', 'Global', 'Materials Supply',   'operaciones@mika.mx',           '+52 55 3456 7890', 'MIM000101DDD')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 2. USUARIO ADMINISTRADOR
-- ============================================================
-- Contraseña: Admin123!
-- Hash bcrypt generado con 10 salt rounds
-- ⚠️  CAMBIA ESTA CONTRASEÑA INMEDIATAMENTE DESPUÉS DEL PRIMER LOGIN
-- ============================================================

INSERT INTO users (
  email, password_hash, name, company_id, role, status, must_change_password
) VALUES (
  'admin@incored.com.mx',
  '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',
  'Administrador Sistema',
  1,
  'admin',
  'active',
  TRUE
) ON CONFLICT (email) DO NOTHING;

-- Usuarios de prueba por empresa
INSERT INTO users (email, password_hash, name, company_id, role, status)
VALUES
  -- Incored y Asociados
  ('gerente@incored.com.mx',
   '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',
   'Carlos Ramírez', 1, 'manager', 'active'),
  ('pm1@incored.com.mx',
   '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',
   'Laura González', 1, 'project_manager', 'active'),
  ('finanzas@incored.com.mx',
   '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',
   'Roberto Medina', 1, 'finance', 'active'),
  ('rrhh@incored.com.mx',
   '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',
   'Ana Torres', 1, 'hr', 'active'),
  -- Zhada Construcciones
  ('gerente@zhada.mx',
   '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',
   'Miguel Herrera', 2, 'manager', 'active'),
  ('pm2@zhada.mx',
   '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',
   'Patricia Soto', 2, 'project_manager', 'active'),
  -- Mika Importaciones
  ('gerente@mika.mx',
   '$2b$10$RIX/JGPKfXMJBJ.H3YnWNOW6Kaz04FiMasMHlOMfGtBGpZoQaYNxC',
   'Sofía Martínez', 4, 'manager', 'active')
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- 3. CLIENTES REPRESENTATIVOS
-- ============================================================

INSERT INTO clients (
  name, type, rfc, country, state, city,
  primary_contact_name, primary_contact_email, primary_contact_phone,
  payment_terms, credit_rating, credit_limit
) VALUES
  ('CFE Distribución SA de CV',       'cliente',   'CFE370814QI0', 'Mexico', 'CDMX',        'Ciudad de México',
   'Licitaciones CFE',      'licitaciones@cfe.mx',        '+52 55 5229 4400', '30_dias', 'excelente', 5000000.00),
  ('Telmex SA de CV',                 'cliente',   'TEL911231KI4', 'Mexico', 'CDMX',        'Ciudad de México',
   'Contratos Telmex',      'contratos@telmex.com',       '+52 55 5222 5022', '30_dias', 'excelente', 3000000.00),
  ('Pemex Exploración y Producción',  'cliente',   'PEP840101QX0', 'Mexico', 'Tabasco',     'Villahermosa',
   'Procurement PEP',       'procurement@pemex.com',      '+52 993 310 2200', '60_dias', 'excelente', 8000000.00),
  ('Megacable Comunicaciones',        'cliente',   'MCO960101AAA', 'Mexico', 'Jalisco',     'Guadalajara',
   'Ing. Jorge Padilla',    'jpadilla@megacable.com.mx',  '+52 33 3669 9000', '30_dias', 'buena',     1500000.00),
  ('Axtel SAB de CV',                 'cliente',   'AXT971231KI4', 'Mexico', 'Nuevo León',  'Monterrey',
   'Lic. Claudia Reyes',    'creyes@axtel.com.mx',        '+52 81 8114 0000', '30_dias', 'buena',     2000000.00),
  -- Proveedores
  ('Distribuidora Global de Cables',  'proveedor', 'DGC010101AAA', 'Mexico', 'CDMX',        'Ciudad de México',
   'Carlos Mendoza',        'ventas@distglobal.mx',       '+52 55 5555 1234', '15_dias', 'excelente', NULL),
  ('Herramientas Técnicas del Norte', 'proveedor', 'HTN020202BBB', 'Mexico', 'Nuevo León',  'Monterrey',
   'Ana Robles',            'ana@herrtecnicas.mx',        '+52 81 8888 5678', 'contado',  'buena',    NULL),
  ('Importadora Óptica SA',           'proveedor', 'IOP030303CCC', 'Mexico', 'Jalisco',     'Guadalajara',
   'Roberto Silva',         'rsilva@importoptica.mx',     '+52 33 3333 9012', '15_dias', 'excelente', NULL),
  ('Ferremax Industrial',             'proveedor', 'FIN040404DDD', 'Mexico', 'Estado México','Ecatepec',
   'Luis Paredes',          'lparedes@ferremax.mx',       '+52 55 5678 3456', '30_dias', 'buena',    NULL)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 4. PROYECTOS DE EJEMPLO
-- ============================================================

INSERT INTO projects (
  code, name, client_id, company_id, pm_id,
  budget_amount, currency, expected_margin,
  status, progress_percent,
  country, city, start_date, end_date_planned, description, created_by
) VALUES
  ('PRY-2025-001',
   'Red de Fibra Óptica CFE Zona Norte',
   1, 1,
   (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
   4500000.00, 'MXN', 22.00,
   'executing', 45,
   'Mexico', 'Monterrey',
   '2025-01-15', '2025-08-30',
   'Tendido de red de fibra óptica de 120 km para CFE en la zona norte del país. Incluye instalación de 850 postes, empalmes y equipamiento de nodo.',
   (SELECT id FROM users WHERE email = 'admin@incored.com.mx')),

  ('PRY-2025-002',
   'Modernización Red Telmex CDMX',
   2, 1,
   (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
   2800000.00, 'MXN', 18.50,
   'executing', 72,
   'Mexico', 'Ciudad de México',
   '2025-02-01', '2025-07-15',
   'Modernización de 45 nodos de distribución en la CDMX. Migración de cobre a fibra óptica.',
   (SELECT id FROM users WHERE email = 'admin@incored.com.mx')),

  ('PRY-2025-003',
   'Infraestructura Telecomunicaciones Pemex Tabasco',
   3, 2,
   (SELECT id FROM users WHERE email = 'pm2@zhada.mx'),
   6200000.00, 'MXN', 25.00,
   'planning', 8,
   'Mexico', 'Villahermosa',
   '2025-04-01', '2025-12-31',
   'Instalación de infraestructura de telecomunicaciones en 3 plataformas de Pemex. Proyecto de alta seguridad.',
   (SELECT id FROM users WHERE email = 'admin@incored.com.mx')),

  ('PRY-2025-004',
   'Expansión Red Megacable Guadalajara',
   4, 1,
   (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
   1850000.00, 'MXN', 20.00,
   'executing', 30,
   'Mexico', 'Guadalajara',
   '2025-03-01', '2025-09-30',
   'Expansión de la red HFC de Megacable en 8 colonias de Guadalajara.',
   (SELECT id FROM users WHERE email = 'admin@incored.com.mx')),

  ('PRY-2024-015',
   'Red Axtel Monterrey — Fase 2',
   5, 1,
   (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
   3100000.00, 'MXN', 21.00,
   'completed', 100,
   'Mexico', 'Monterrey',
   '2024-06-01', '2024-12-31',
   'Segunda fase de la red Axtel en el AMM. Proyecto completado exitosamente.',
   (SELECT id FROM users WHERE email = 'admin@incored.com.mx'))
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 5. TAREAS DE EJEMPLO
-- ============================================================

INSERT INTO tasks (
  title, description, project_id, assigned_to, created_by,
  priority, status, due_date, estimated_hours, percent_complete
)
SELECT
  'Levantamiento topográfico Zona Norte',
  'Realizar el levantamiento y mapeo de la ruta de tendido de fibra óptica en los 120 km del tramo norte.',
  p.id,
  (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx'),
  'alta', 'completada', CURRENT_DATE - 30, 40, 100
FROM projects p WHERE p.code = 'PRY-2025-001'
ON CONFLICT DO NOTHING;

INSERT INTO tasks (
  title, description, project_id, assigned_to, created_by,
  priority, status, due_date, estimated_hours, percent_complete
)
SELECT
  'Adquisición de materiales — Cable fibra 12 hilos',
  'Gestionar OC y recepción de 15,000 metros de cable de fibra óptica SM 12 hilos.',
  p.id,
  (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx'),
  'critica', 'completada', CURRENT_DATE - 20, 16, 100
FROM projects p WHERE p.code = 'PRY-2025-001'
ON CONFLICT DO NOTHING;

INSERT INTO tasks (
  title, description, project_id, assigned_to, created_by,
  priority, status, due_date, estimated_hours, percent_complete
)
SELECT
  'Instalación postes km 0–40',
  'Plantación e instalación de 280 postes de concreto en el primer tramo.',
  p.id,
  (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx'),
  'alta', 'en_proceso', CURRENT_DATE + 15, 160, 60
FROM projects p WHERE p.code = 'PRY-2025-001'
ON CONFLICT DO NOTHING;

INSERT INTO tasks (
  title, description, project_id, assigned_to, created_by,
  priority, status, due_date, estimated_hours, percent_complete
)
SELECT
  'Tendido de fibra km 0–40',
  'Tendido y fijación del cable de fibra óptica en el primer tramo de 40 km.',
  p.id,
  (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx'),
  'alta', 'pendiente', CURRENT_DATE + 30, 200, 0
FROM projects p WHERE p.code = 'PRY-2025-001'
ON CONFLICT DO NOTHING;

INSERT INTO tasks (
  title, description, project_id, assigned_to, created_by,
  priority, status, due_date, estimated_hours, percent_complete
)
SELECT
  'Actualización documentación nodos CDMX',
  'Actualizar planos y documentación técnica de los 45 nodos intervenidos.',
  p.id,
  (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx'),
  'media', 'en_proceso', CURRENT_DATE + 7, 24, 50
FROM projects p WHERE p.code = 'PRY-2025-002'
ON CONFLICT DO NOTHING;

INSERT INTO tasks (
  title, description, project_id, assigned_to, created_by,
  priority, status, due_date, estimated_hours, percent_complete
)
SELECT
  'Gestión de permisos Pemex',
  'Tramitar permisos de acceso a las 3 plataformas para el equipo técnico.',
  p.id,
  (SELECT id FROM users WHERE email = 'pm2@zhada.mx'),
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx'),
  'critica', 'en_proceso', CURRENT_DATE + 5, 32, 40
FROM projects p WHERE p.code = 'PRY-2025-003'
ON CONFLICT DO NOTHING;

-- ============================================================
-- 6. TRANSACCIONES FINANCIERAS DE EJEMPLO
-- ============================================================

INSERT INTO transactions (
  type, category, company_id, project_id, client_id,
  amount, currency, description, reference_number,
  transaction_date, status, created_by
)
SELECT
  'ingreso', 'anticipos',
  1,
  (SELECT id FROM projects WHERE code = 'PRY-2025-001'),
  1,
  1350000.00, 'MXN',
  'Anticipo 30% contrato CFE Red Fibra Óptica Zona Norte',
  'FAC-CFE-2025-001',
  '2025-01-20', 'conciliada',
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx')
ON CONFLICT DO NOTHING;

INSERT INTO transactions (
  type, category, company_id, project_id, client_id,
  amount, currency, description, reference_number,
  transaction_date, status, created_by
)
SELECT
  'ingreso', 'servicios',
  1,
  (SELECT id FROM projects WHERE code = 'PRY-2025-002'),
  2,
  840000.00, 'MXN',
  'Estimación #1 — Modernización nodos 1–15 Telmex CDMX',
  'FAC-TEL-2025-003',
  '2025-03-10', 'conciliada',
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx')
ON CONFLICT DO NOTHING;

INSERT INTO transactions (
  type, category, company_id, project_id,
  amount, currency, description, reference_number,
  transaction_date, status, created_by
)
SELECT
  'egreso', 'materiales',
  1,
  (SELECT id FROM projects WHERE code = 'PRY-2025-001'),
  675000.00, 'MXN',
  'Compra cable fibra óptica SM 12h — 15,000 m — Importadora Óptica SA',
  'OC-INC-2025-0042',
  '2025-02-05', 'conciliada',
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx')
ON CONFLICT DO NOTHING;

INSERT INTO transactions (
  type, category, company_id, project_id,
  amount, currency, description, reference_number,
  transaction_date, status, created_by
)
SELECT
  'egreso', 'mano_obra',
  1,
  (SELECT id FROM projects WHERE code = 'PRY-2025-001'),
  320000.00, 'MXN',
  'Nómina cuadrilla tendido — enero y febrero 2025',
  'NOM-2025-01-02',
  '2025-02-28', 'conciliada',
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx')
ON CONFLICT DO NOTHING;

INSERT INTO transactions (
  type, category, company_id, project_id,
  amount, currency, description, reference_number,
  transaction_date, status, created_by
)
SELECT
  'egreso', 'subcontratistas',
  1,
  (SELECT id FROM projects WHERE code = 'PRY-2025-001'),
  180000.00, 'MXN',
  'Subcontrato plantación postes km 0–40 — Constructora del Norte',
  'SC-2025-0015',
  '2025-03-15', 'registrada',
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx')
ON CONFLICT DO NOTHING;

INSERT INTO transactions (
  type, category, company_id, project_id, client_id,
  amount, currency, description, reference_number,
  transaction_date, status, created_by
)
SELECT
  'ingreso', 'finiquitos',
  1,
  (SELECT id FROM projects WHERE code = 'PRY-2024-015'),
  5,
  3100000.00, 'MXN',
  'Finiquito total Proyecto Axtel Monterrey Fase 2 — Pago final',
  'FAC-AXT-2024-099',
  '2025-01-10', 'conciliada',
  (SELECT id FROM users WHERE email = 'admin@incored.com.mx')
ON CONFLICT DO NOTHING;

-- ============================================================
-- 7. INVENTARIO DE MATERIALES
-- ============================================================

INSERT INTO inventory_materials (
  sku, name, category, quantity_stock, quantity_min, quantity_max,
  unit_of_measure, cost_last_purchase, cost_average, company_id, supplier_id
)
SELECT
  v.sku, v.name, v.category, v.qty_stock, v.qty_min, v.qty_max,
  v.uom, v.cost, v.cost_avg, 1,
  (SELECT id FROM clients WHERE name = 'Importadora Óptica SA' LIMIT 1)
FROM (VALUES
  ('CAB-FIB-SM-12', 'Cable Fibra Óptica SM 12 hilos G.652D',
   'Cables', 8500.00, 2000.00, 20000.00, 'metros', 45.00, 44.50),
  ('CAB-FIB-SM-24', 'Cable Fibra Óptica SM 24 hilos G.652D',
   'Cables', 3200.00, 500.00,  12000.00, 'metros', 85.00, 83.20),
  ('CAB-FIB-SM-48', 'Cable Fibra Óptica SM 48 hilos G.652D',
   'Cables', 1500.00, 300.00,  6000.00,  'metros', 155.00, 152.00),
  ('CON-SC-APC',    'Conector SC/APC pulido angled',
   'Conectores', 4500.00, 1000.00, 15000.00, 'pza', 8.50, 8.30),
  ('CON-LC-UPC',    'Conector LC/UPC dúplex',
   'Conectores', 3800.00, 800.00,  12000.00, 'pza', 7.20, 7.00),
  ('CON-SC-UPC',    'Conector SC/UPC pulido',
   'Conectores', 5200.00, 1000.00, 15000.00, 'pza', 7.80, 7.60),
  ('EMP-FUS-001',   'Empalmadora de fusión Fujikura 60S+',
   'Equipos', 3.00, 1.00, 10.00, 'equipo', 85000.00, 83000.00),
  ('EQU-OTD-8',     'Terminal óptica de distribución 8 puertos',
   'Equipos', 120.00, 20.00, 400.00, 'pza', 1250.00, 1220.00),
  ('EQU-OTD-16',    'Terminal óptica de distribución 16 puertos',
   'Equipos', 80.00, 15.00, 300.00, 'pza', 2100.00, 2050.00),
  ('SWT-MNG-24',    'Switch administrable 24 puertos GE + 4 SFP+',
   'Equipos', 18.00, 5.00, 60.00, 'pza', 4500.00, 4400.00),
  ('MAT-POS-9M',    'Poste de concreto 9 metros 300 kg',
   'Estructura', 420.00, 50.00, 1000.00, 'pza', 1800.00, 1780.00),
  ('MAT-MEN-3/8',   'Mensajero de acero 3/8" 7 hilos',
   'Estructura', 12500.00, 2000.00, 30000.00, 'metros', 12.50, 12.20),
  ('MAT-FLA-001',   'Fleje de acero inoxidable 3/4"',
   'Estructura', 3000.00, 500.00, 10000.00, 'metros', 18.00, 17.50),
  ('MAT-CIN-001',   'Cintillo plástico UV 300mm negro',
   'Consumibles', 25000.00, 5000.00, 80000.00, 'pza', 0.85, 0.82),
  ('HER-COR-001',   'Cortadora de fibra óptica Fujikura CT-100',
   'Herramientas', 8.00, 2.00, 20.00, 'pza', 3200.00, 3100.00),
  ('CAJ-EMP-24',    'Caja de empalme aéreo 24 hilos IP65',
   'Cajas', 95.00, 20.00, 300.00, 'pza', 680.00, 665.00),
  ('CAJ-DIS-8',     'Caja de distribución domiciliaria 8 puertos',
   'Cajas', 240.00, 50.00, 800.00, 'pza', 320.00, 315.00),
  ('CAB-PAT-SC',    'Cable patch cord SC/APC-SC/APC 2m',
   'Cables', 380.00, 100.00, 1200.00, 'pza', 65.00, 63.00)
) AS v(sku, name, category, qty_stock, qty_min, qty_max, uom, cost, cost_avg)
ON CONFLICT (sku) DO NOTHING;

-- Materiales empresa Zhada
INSERT INTO inventory_materials (
  sku, name, category, quantity_stock, quantity_min, quantity_max,
  unit_of_measure, cost_last_purchase, company_id
)
SELECT
  v.sku, v.name, v.category, v.qty, v.qmin, v.qmax, v.uom, v.cost, 2
FROM (VALUES
  ('ZHA-CAB-001', 'Cable de acometida UTP Cat6 exterior', 'Cables',
   5000.00, 500.00, 15000.00, 'metros', 22.00),
  ('ZHA-CAN-001', 'Canaleta PVC 100x50mm', 'Canalizaciones',
   800.00, 100.00, 3000.00, 'metros', 85.00),
  ('ZHA-CON-001', 'Conduit EMT 3/4" galvanizado 3m', 'Canalizaciones',
   350.00, 50.00, 1000.00, 'tramo', 45.00),
  ('ZHA-SIL-001', 'Silicón sellador transparente 300ml', 'Consumibles',
   120.00, 20.00, 400.00, 'tubo', 35.00)
) AS v(sku, name, category, qty, qmin, qmax, uom, cost)
ON CONFLICT (sku) DO NOTHING;

-- ============================================================
-- 8. HERRAMIENTAS
-- ============================================================

INSERT INTO inventory_tools (code, name, category, brand, model, serial_number, company_id, status, purchase_date, purchase_cost)
VALUES
  ('HRR-001', 'Empalmadora de fusión #1',     'Equipos ópticos', 'Fujikura',  '60S+',    'FUJ60S-001', 1, 'asignado',    '2023-03-15', 85000.00),
  ('HRR-002', 'Empalmadora de fusión #2',     'Equipos ópticos', 'Fujikura',  '60S+',    'FUJ60S-002', 1, 'disponible',  '2023-03-15', 85000.00),
  ('HRR-003', 'OTDR Anritsu MT9083',          'Medición',        'Anritsu',   'MT9083C', 'ANR-0012',   1, 'asignado',    '2022-08-01', 120000.00),
  ('HRR-004', 'OTDR de respaldo Yokogawa',    'Medición',        'Yokogawa',  'AQ7280',  'YOK-0034',   1, 'disponible',  '2021-05-10', 95000.00),
  ('HRR-005', 'Generador eléctrico 5kVA',     'Generación',      'Honda',     'EM5500',  'HON-5500-07',1, 'asignado',    '2022-01-20', 28000.00),
  ('HRR-006', 'Generador eléctrico 5kVA #2',  'Generación',      'Honda',     'EM5500',  'HON-5500-08',1, 'disponible',  '2022-01-20', 28000.00),
  ('HRR-007', 'Cortadora de fibra CT-100',    'Herramientas',    'Fujikura',  'CT-100',  'CT100-0051', 2, 'disponible',  '2023-06-01', 3200.00),
  ('HRR-008', 'Medidor de potencia óptica',   'Medición',        'EXFO',      'PPM-352', 'EXFO-0089',  2, 'disponible',  '2022-11-15', 12000.00)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 9. VEHÍCULOS
-- ============================================================

INSERT INTO inventory_vehicles (plates, brand, model, year, vin, company_id, status, fuel_type, odometer, insurance_expiry)
VALUES
  ('ABC-123-A', 'Ford',      'F-150 XLT',    2022, '1FTFW1E88NFC12345', 1, 'asignado',     'gasolina', 45230,  '2026-01-15'),
  ('DEF-456-B', 'Ford',      'F-150 XLT',    2022, '1FTFW1E88NFC12346', 1, 'disponible',   'gasolina', 38650,  '2026-01-15'),
  ('GHI-789-C', 'Chevrolet', 'Silverado 1500',2021,'3GCUYDED2MG123456', 1, 'asignado',     'gasolina', 62100,  '2025-08-30'),
  ('JKL-012-D', 'Toyota',    'Hilux 4x4',    2023, 'AHTFR3CD9P7654321', 1, 'disponible',   'diesel',   15400,  '2026-05-20'),
  ('MNO-345-E', 'Dodge',     'Ram 2500',     2021, '3C6UR5CL6MG654321', 2, 'asignado',     'diesel',   78900,  '2025-10-01'),
  ('PQR-678-F', 'Volkswagen','Transporter',  2022, 'WV1ZZZ7HZMH654321', 2, 'disponible',   'diesel',   29300,  '2026-03-10'),
  ('STU-901-G', 'Ford',      'Transit 350',  2023, '1FTBF2B62PKA12345', 4, 'disponible',   'gasolina', 8750,   '2026-06-30')
ON CONFLICT (plates) DO NOTHING;

-- ============================================================
-- 10. EMPLEADOS
-- ============================================================

INSERT INTO employees (
  employee_number, name, email, phone, company_id, position, department,
  salary_base, salary_period, hire_date, status, rfc, vacation_days_per_year
)
VALUES
  ('INC-001', 'Carlos Ramírez López',     'carlos.ramirez@incored.com.mx',    '+52 55 1111 0001', 1, 'Director General',         'Dirección',       85000.00, 'mensual',    '2019-01-15', 'activo', 'RALC810101AAA', 20),
  ('INC-002', 'Laura González Pérez',     'laura.gonzalez@incored.com.mx',    '+52 55 1111 0002', 1, 'Project Manager Sr.',      'Proyectos',       42000.00, 'mensual',    '2020-03-01', 'activo', 'GOPL880301BBB', 16),
  ('INC-003', 'Roberto Medina Ruiz',      'roberto.medina@incored.com.mx',    '+52 55 1111 0003', 1, 'Director de Finanzas',     'Finanzas',        65000.00, 'mensual',    '2020-06-15', 'activo', 'MERR850615CCC', 18),
  ('INC-004', 'Ana Torres Jiménez',       'ana.torres@incored.com.mx',        '+52 55 1111 0004', 1, 'Gerente de RR.HH.',        'Recursos Humanos',55000.00, 'mensual',    '2021-01-10', 'activo', 'TOJA900110DDD', 16),
  ('INC-005', 'Jorge Herrera Sánchez',    'jorge.herrera@incored.com.mx',     '+52 55 1111 0005', 1, 'Técnico Especialista FO',  'Operaciones',     28000.00, 'mensual',    '2021-07-01', 'activo', 'HESJ921001EEE', 14),
  ('INC-006', 'María Flores Vargas',      'maria.flores@incored.com.mx',      '+52 55 1111 0006', 1, 'Técnico FO Junior',        'Operaciones',     18000.00, 'mensual',    '2022-09-01', 'activo', 'FOVM960901FFF', 14),
  ('INC-007', 'Pedro Castillo Morales',   'pedro.castillo@incored.com.mx',    '+52 55 1111 0007', 1, 'Supervisor de Campo',      'Operaciones',     32000.00, 'mensual',    '2020-11-15', 'activo', 'CAMP891115GGG', 16),
  -- Zhada Construcciones
  ('ZHA-001', 'Miguel Herrera Gutiérrez', 'miguel.herrera@zhada.mx',          '+52 55 2222 0001', 2, 'Gerente General',          'Dirección',       70000.00, 'mensual',    '2019-04-01', 'activo', 'HEGM800401HHH', 18),
  ('ZHA-002', 'Patricia Soto Mendoza',    'patricia.soto@zhada.mx',           '+52 55 2222 0002', 2, 'Project Manager',          'Proyectos',       38000.00, 'mensual',    '2021-02-15', 'activo', 'SOMP870215III', 14),
  ('ZHA-003', 'Alejandro Ríos Cruz',      'alex.rios@zhada.mx',               '+52 55 2222 0003', 2, 'Técnico de Instalación',   'Operaciones',     22000.00, 'mensual',    '2022-05-01', 'activo', 'RICA940501JJJ', 12),
  -- Mika Importaciones
  ('MKA-001', 'Sofía Martínez León',      'sofia.martinez@mika.mx',           '+52 55 4444 0001', 4, 'Directora de Operaciones', 'Dirección',       72000.00, 'mensual',    '2020-08-01', 'activo', 'MALS820801KKK', 18),
  ('MKA-002', 'Fernando Vega Ortega',     'fernando.vega@mika.mx',            '+52 55 4444 0002', 4, 'Jefe de Almacén',          'Logística',       28000.00, 'mensual',    '2021-11-01', 'activo', 'VEOF900101LLL', 14)
ON CONFLICT (employee_number) DO NOTHING;

-- ============================================================
-- 11. COTIZACIÓN DE EJEMPLO
-- ============================================================

INSERT INTO quotes (
  folio, client_id, company_id, project_id, created_by,
  status, issue_date, validity_days,
  subtotal, tax_percent, tax_amount, total, currency,
  terms_conditions
)
SELECT
  'INC-2025-001',
  (SELECT id FROM clients WHERE name = 'Megacable Comunicaciones' LIMIT 1),
  1,
  (SELECT id FROM projects WHERE code = 'PRY-2025-004' LIMIT 1),
  (SELECT id FROM users WHERE email = 'pm1@incored.com.mx'),
  'enviada',
  '2025-02-15',
  30,
  1596551.72, 16, 255448.28, 1852000.00, 'MXN',
  '1. Los precios no incluyen IVA. 2. Vigencia 30 días naturales. 3. Tiempo de ejecución: 6 meses. 4. Pago: 30% anticipo, 40% a la mitad de obra, 30% finiquito. 5. Garantía de obra: 12 meses.'
ON CONFLICT (folio) DO NOTHING;

INSERT INTO quote_lines (quote_id, description, quantity, unit, unit_price, discount_percent, line_total, line_order)
SELECT
  q.id,
  v.description, v.quantity, v.unit, v.unit_price, v.discount, v.total, v.ord
FROM quotes q,
(VALUES
  ('Tendido e instalación de cable FO 24 hilos',    85000.00, 'metro',        12.50, 0, 1062500.00, 1),
  ('Instalación y configuración terminales OTD-8',  320.00,   'pza',         280.00, 0,  89600.00,  2),
  ('Empalmes de fusión (par)',                      420.00,   'empalme',      95.00, 0,  39900.00,  3),
  ('Poste concreto 9m instalado',                   180.00,   'pza',        2200.00, 5, 376200.00,  4),
  ('Ingeniería y supervisión técnica',                1.00,   'global',    28351.72, 0,  28351.72,  5)
) AS v(description, quantity, unit, unit_price, discount, total, ord)
WHERE q.folio = 'INC-2025-001'
ON CONFLICT DO NOTHING;

-- ============================================================
-- FIN DEL SEED
-- ============================================================

-- Resumen de datos insertados
SELECT 'companies'            AS tabla, COUNT(*) AS registros FROM companies
UNION ALL
SELECT 'users',               COUNT(*) FROM users
UNION ALL
SELECT 'clients',             COUNT(*) FROM clients
UNION ALL
SELECT 'projects',            COUNT(*) FROM projects
UNION ALL
SELECT 'tasks',               COUNT(*) FROM tasks
UNION ALL
SELECT 'transactions',        COUNT(*) FROM transactions
UNION ALL
SELECT 'inventory_materials', COUNT(*) FROM inventory_materials
UNION ALL
SELECT 'inventory_tools',     COUNT(*) FROM inventory_tools
UNION ALL
SELECT 'inventory_vehicles',  COUNT(*) FROM inventory_vehicles
UNION ALL
SELECT 'employees',           COUNT(*) FROM employees
UNION ALL
SELECT 'quotes',              COUNT(*) FROM quotes
UNION ALL
SELECT 'quote_lines',         COUNT(*) FROM quote_lines
ORDER BY 1;
