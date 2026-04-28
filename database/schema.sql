-- =============================================================================
-- INCORED Y ASOCIADOS — ERP DATABASE SCHEMA
-- PostgreSQL 15+ | Versión 2.0
-- =============================================================================
-- Ejecutar en orden:
--   psql $DATABASE_URL -f database/schema.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. EXTENSIONES
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. FUNCIONES AUXILIARES
-- ---------------------------------------------------------------------------

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Funciones de contexto para RLS (se establecen por sesión desde la app)
CREATE OR REPLACE FUNCTION current_app_user_id()
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_id', true), '')::UUID;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION current_app_user_role()
RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_role', true), '');
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION current_app_company_id()
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_company_id', true), '')::UUID;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 2. EMPRESAS
-- =============================================================================

CREATE TABLE IF NOT EXISTS companies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(200) NOT NULL,
  short_name      VARCHAR(20)  NOT NULL UNIQUE,   -- INC, ZHA, INT, MKA
  code            VARCHAR(10)  NOT NULL UNIQUE,   -- Prefijo para folios
  rfc             VARCHAR(20),
  address         TEXT,
  phone           VARCHAR(20),
  email           VARCHAR(150),
  logo_url        TEXT,
  website         VARCHAR(200),
  industry        VARCHAR(100),
  tax_regime      VARCHAR(100),                   -- Régimen fiscal
  currency        CHAR(3)      NOT NULL DEFAULT 'MXN',
  active          BOOLEAN      NOT NULL DEFAULT TRUE,
  settings        JSONB        NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_companies_code ON companies(code);

-- =============================================================================
-- 3. USUARIOS & AUTENTICACIÓN
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  email                 VARCHAR(254) NOT NULL UNIQUE,
  password_hash         TEXT        NOT NULL,
  first_name            VARCHAR(100) NOT NULL,
  last_name             VARCHAR(100) NOT NULL,
  role                  VARCHAR(50)  NOT NULL DEFAULT 'operative'
                          CHECK (role IN ('admin','manager','finance','hr',
                                          'project_manager','supervisor',
                                          'operative','technician')),
  status                VARCHAR(20)  NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive','suspended','pending')),
  phone                 VARCHAR(30),
  avatar_url            TEXT,
  job_title             VARCHAR(150),
  department            VARCHAR(100),

  -- 2FA (secreto cifrado AES-256-GCM en la capa de aplicación)
  two_fa_enabled        BOOLEAN      NOT NULL DEFAULT FALSE,
  two_fa_secret         TEXT,
  two_fa_backup_codes   TEXT[],

  -- Seguridad de login
  login_attempts        INT          NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  last_login_ip         INET,
  password_changed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  must_change_password  BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Preferencias de usuario
  preferences           JSONB        NOT NULL DEFAULT '{}',
  timezone              VARCHAR(60)  NOT NULL DEFAULT 'America/Mexico_City',
  locale                VARCHAR(10)  NOT NULL DEFAULT 'es-MX',

  -- Soft delete
  deleted_at            TIMESTAMPTZ,
  deleted_by            UUID,

  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_users_email         ON users(email);
CREATE INDEX idx_users_company_id    ON users(company_id);
CREATE INDEX idx_users_role          ON users(role);
CREATE INDEX idx_users_status        ON users(status) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3a. Tokens & Sesiones
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,   -- SHA-256 del token real
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ,
  ip_address  INET,
  user_agent  TEXT
);

CREATE INDEX idx_refresh_tokens_user_id    ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS token_blacklist (
  jti         TEXT PRIMARY KEY,              -- JWT ID
  user_id     UUID        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  blacklisted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_blacklist_expires ON token_blacklist(expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prt_token_hash ON password_reset_tokens(token_hash);
CREATE INDEX idx_prt_user_id    ON password_reset_tokens(user_id);

-- =============================================================================
-- 4. CRM — CLIENTES, PROVEEDORES & PROSPECTOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS clients (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  type              VARCHAR(20)  NOT NULL DEFAULT 'cliente'
                      CHECK (type IN ('cliente','proveedor','prospecto','ambos')),

  -- Datos fiscales
  business_name     VARCHAR(300) NOT NULL,           -- Razón social
  trade_name        VARCHAR(200),                    -- Nombre comercial
  rfc               VARCHAR(20),
  tax_regime        VARCHAR(100),
  cfdi_use          VARCHAR(10),

  -- Contacto
  primary_contact   VARCHAR(200),
  email             VARCHAR(254),
  phone             VARCHAR(30),
  mobile            VARCHAR(30),
  website           VARCHAR(200),

  -- Dirección
  address_street    TEXT,
  address_city      VARCHAR(100),
  address_state     VARCHAR(100),
  address_zip       VARCHAR(10),
  address_country   VARCHAR(100) NOT NULL DEFAULT 'México',

  -- Condiciones comerciales
  credit_limit      NUMERIC(14,2) DEFAULT 0,
  credit_days       INT           DEFAULT 0,
  payment_terms     VARCHAR(100),
  currency          CHAR(3)       NOT NULL DEFAULT 'MXN',
  price_list        VARCHAR(50),
  discount_percent  NUMERIC(5,2)  DEFAULT 0,
  credit_rating     VARCHAR(20)   DEFAULT 'normal'
                      CHECK (credit_rating IN ('excelente','bueno','normal','riesgo','bloqueado')),

  -- CRM
  source            VARCHAR(100),
  assigned_to       UUID REFERENCES users(id),
  tags              TEXT[]        DEFAULT '{}',
  notes             TEXT,

  -- Estado
  status            VARCHAR(20)   NOT NULL DEFAULT 'activo'
                      CHECK (status IN ('activo','inactivo','suspendido')),
  deleted_at        TIMESTAMPTZ,

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_clients_company_id    ON clients(company_id);
CREATE INDEX idx_clients_type          ON clients(type);
CREATE INDEX idx_clients_status        ON clients(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_clients_rfc           ON clients(rfc) WHERE rfc IS NOT NULL;
CREATE INDEX idx_clients_assigned_to   ON clients(assigned_to);

-- ---------------------------------------------------------------------------
-- 4a. Pipeline CRM — Prospectos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  client_id       UUID REFERENCES clients(id),
  title           VARCHAR(300) NOT NULL,
  contact_name    VARCHAR(200) NOT NULL,
  contact_email   VARCHAR(254),
  contact_phone   VARCHAR(30),
  company_name    VARCHAR(200),
  estimated_value NUMERIC(14,2) DEFAULT 0,
  currency        CHAR(3)       NOT NULL DEFAULT 'MXN',
  stage           VARCHAR(30)   NOT NULL DEFAULT 'nuevo'
                    CHECK (stage IN ('nuevo','contactado','propuesta','negociacion',
                                     'ganado','perdido','descartado')),
  probability     INT           NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  expected_close  DATE,
  source          VARCHAR(100),
  assigned_to     UUID REFERENCES users(id),
  lost_reason     TEXT,
  notes           TEXT,
  tags            TEXT[]        DEFAULT '{}',
  converted_at    TIMESTAMPTZ,
  status          VARCHAR(20)   NOT NULL DEFAULT 'activo'
                    CHECK (status IN ('activo','cerrado','cancelado')),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_leads_company_id   ON leads(company_id);
CREATE INDEX idx_leads_stage        ON leads(stage);
CREATE INDEX idx_leads_assigned_to  ON leads(assigned_to);

-- =============================================================================
-- 5. COTIZACIONES
-- =============================================================================

CREATE TABLE IF NOT EXISTS quotes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID         NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  client_id       UUID         NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  project_id      UUID,                             -- FK circular; se añade después
  lead_id         UUID REFERENCES leads(id),

  folio           VARCHAR(30)  NOT NULL UNIQUE,     -- Ej: INC-2025-001
  title           VARCHAR(300) NOT NULL,
  description     TEXT,

  -- Montos
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_percent     NUMERIC(5,2)  NOT NULL DEFAULT 16,
  tax_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency        CHAR(3)       NOT NULL DEFAULT 'MXN',

  -- Control
  status          VARCHAR(30)  NOT NULL DEFAULT 'borrador'
                    CHECK (status IN ('borrador','enviada','revision','aprobada',
                                      'rechazada','vencida','cancelada','facturada')),
  valid_until     DATE,
  sent_at         TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  rejected_at     TIMESTAMPTZ,
  rejected_reason TEXT,

  -- Condiciones
  payment_terms   TEXT,
  delivery_days   INT,
  warranty_days   INT,
  notes           TEXT,
  internal_notes  TEXT,

  created_by      UUID         NOT NULL REFERENCES users(id),
  approved_by     UUID REFERENCES users(id),

  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_quotes_company_id  ON quotes(company_id);
CREATE INDEX idx_quotes_client_id   ON quotes(client_id);
CREATE INDEX idx_quotes_status      ON quotes(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_quotes_folio       ON quotes(folio);

-- ---------------------------------------------------------------------------
-- 5a. Líneas de Cotización
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quote_lines (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quote_id        UUID         NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position        INT          NOT NULL DEFAULT 1,
  type            VARCHAR(20)  NOT NULL DEFAULT 'producto'
                    CHECK (type IN ('producto','servicio','mano_obra','descuento','subtotal')),
  code            VARCHAR(50),
  description     TEXT         NOT NULL,
  unit            VARCHAR(30)  NOT NULL DEFAULT 'pza',
  quantity        NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(14,4) NOT NULL DEFAULT 0,
  discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_exempt      BOOLEAN       NOT NULL DEFAULT FALSE,
  notes           TEXT,
  material_id     UUID,                             -- FK a inventory_materials (se añade después)
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_quote_lines_quote_id ON quote_lines(quote_id);
CREATE INDEX idx_quote_lines_position ON quote_lines(quote_id, position);

-- =============================================================================
-- 6. PROYECTOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS projects (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  client_id         UUID REFERENCES clients(id),
  quote_id          UUID REFERENCES quotes(id),
  manager_id        UUID REFERENCES users(id),

  code              VARCHAR(30)  NOT NULL UNIQUE,
  name              VARCHAR(300) NOT NULL,
  description       TEXT,
  type              VARCHAR(50)  NOT NULL DEFAULT 'interno'
                      CHECK (type IN ('interno','externo','licitacion',
                                      'mantenimiento','instalacion')),
  status            VARCHAR(30)  NOT NULL DEFAULT 'planificacion'
                      CHECK (status IN ('planificacion','activo','pausado',
                                        'en_revision','completado','cancelado')),

  -- Fechas planificadas vs reales
  planned_start     DATE,
  planned_end       DATE,
  actual_start      DATE,
  actual_end        DATE,

  -- Financiero
  budget            NUMERIC(14,2) NOT NULL DEFAULT 0,
  spent_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency          CHAR(3)       NOT NULL DEFAULT 'MXN',

  -- Avance
  progress_percent  INT          NOT NULL DEFAULT 0
                      CHECK (progress_percent BETWEEN 0 AND 100),

  -- Ubicación
  location          TEXT,
  coordinates       POINT,

  -- Metadatos
  tags              TEXT[]       DEFAULT '{}',
  priority          VARCHAR(20)  NOT NULL DEFAULT 'media'
                      CHECK (priority IN ('baja','media','alta','critica')),
  notes             TEXT,
  settings          JSONB        NOT NULL DEFAULT '{}',

  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_projects_company_id    ON projects(company_id);
CREATE INDEX idx_projects_client_id     ON projects(client_id);
CREATE INDEX idx_projects_manager_id    ON projects(manager_id);
CREATE INDEX idx_projects_status        ON projects(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_code          ON projects(code);

-- Resolver FK circular quotes <-> projects
ALTER TABLE quotes ADD CONSTRAINT fk_quotes_project_id
  FOREIGN KEY (project_id) REFERENCES projects(id);

-- ---------------------------------------------------------------------------
-- 6a. Miembros del Proyecto
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_members (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id   UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         VARCHAR(50)  NOT NULL DEFAULT 'miembro'
                 CHECK (role IN ('lider','coordinador','miembro','observador','cliente')),
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at   TIMESTAMPTZ,
  notes        TEXT,
  UNIQUE (project_id, user_id)
);

CREATE INDEX idx_project_members_project_id ON project_members(project_id);
CREATE INDEX idx_project_members_user_id    ON project_members(user_id);

-- =============================================================================
-- 7. TAREAS
-- =============================================================================

CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_task_id  UUID REFERENCES tasks(id),        -- Para subtareas
  assigned_to     UUID REFERENCES users(id),
  created_by      UUID        NOT NULL REFERENCES users(id),

  title           VARCHAR(500) NOT NULL,
  description     TEXT,
  status          VARCHAR(30)  NOT NULL DEFAULT 'pendiente'
                    CHECK (status IN ('pendiente','en_progreso','en_revision',
                                      'bloqueada','completada','cancelada')),
  priority        VARCHAR(20)  NOT NULL DEFAULT 'media'
                    CHECK (priority IN ('baja','media','alta','critica')),
  type            VARCHAR(30)  NOT NULL DEFAULT 'tarea'
                    CHECK (type IN ('tarea','milestone','bug','mejora','reunion')),

  -- Fechas
  planned_start   DATE,
  planned_end     DATE,
  actual_start    TIMESTAMPTZ,
  actual_end      TIMESTAMPTZ,
  due_date        DATE,

  -- Tiempo
  estimated_hours NUMERIC(7,2) DEFAULT 0,
  logged_hours    NUMERIC(7,2) NOT NULL DEFAULT 0,

  -- Kanban
  kanban_column   VARCHAR(50)  DEFAULT 'backlog',
  position        INT          NOT NULL DEFAULT 0,

  -- Extras
  tags            TEXT[]       DEFAULT '{}',
  checklist       JSONB        DEFAULT '[]',    -- [{id,text,done,done_by,done_at}]
  dependencies    UUID[]       DEFAULT '{}',   -- IDs de tareas prerequisito
  external_ref    VARCHAR(100),
  notes           TEXT,

  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_tasks_project_id     ON tasks(project_id);
CREATE INDEX idx_tasks_assigned_to    ON tasks(assigned_to);
CREATE INDEX idx_tasks_status         ON tasks(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_parent         ON tasks(parent_task_id);
CREATE INDEX idx_tasks_due_date       ON tasks(due_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_kanban         ON tasks(project_id, kanban_column, position);

-- ---------------------------------------------------------------------------
-- 7a. Comentarios de Tareas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_comments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id     UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id),
  content     TEXT        NOT NULL,
  attachments UUID[]      DEFAULT '{}',
  edited_at   TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_comments_task_id ON task_comments(task_id);
CREATE INDEX idx_task_comments_user_id ON task_comments(user_id);

-- ---------------------------------------------------------------------------
-- 7b. Registro de Tiempo (Timer)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS time_entries (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id      UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id   UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id),

  description  TEXT,
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ,
  duration_min INT,                                 -- Minutos (calculado o manual)
  is_manual    BOOLEAN     NOT NULL DEFAULT FALSE,
  billable     BOOLEAN     NOT NULL DEFAULT TRUE,
  hourly_rate  NUMERIC(10,2) DEFAULT 0,
  amount       NUMERIC(12,2) DEFAULT 0,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_time_entries_updated_at
  BEFORE UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_time_entries_task_id    ON time_entries(task_id);
CREATE INDEX idx_time_entries_user_id    ON time_entries(user_id);
CREATE INDEX idx_time_entries_project_id ON time_entries(project_id);
CREATE INDEX idx_time_entries_started_at ON time_entries(started_at);

-- =============================================================================
-- 8. FINANZAS — TRANSACCIONES
-- =============================================================================

CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID         NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  project_id      UUID REFERENCES projects(id),
  client_id       UUID REFERENCES clients(id),
  quote_id        UUID REFERENCES quotes(id),
  created_by      UUID         NOT NULL REFERENCES users(id),
  approved_by     UUID REFERENCES users(id),

  type            VARCHAR(20)  NOT NULL
                    CHECK (type IN ('ingreso','egreso','transferencia','ajuste')),
  category        VARCHAR(80)  NOT NULL,
  subcategory     VARCHAR(80),

  folio           VARCHAR(30)  UNIQUE,
  reference       VARCHAR(100),                     -- Número de factura externo
  description     TEXT         NOT NULL,

  amount          NUMERIC(14,2) NOT NULL,
  currency        CHAR(3)       NOT NULL DEFAULT 'MXN',
  exchange_rate   NUMERIC(10,6) NOT NULL DEFAULT 1,
  amount_mxn      NUMERIC(14,2) NOT NULL,

  tax_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_type        VARCHAR(20)   DEFAULT 'IVA',
  tax_included    BOOLEAN       NOT NULL DEFAULT TRUE,

  payment_method  VARCHAR(50)   NOT NULL DEFAULT 'transferencia'
                    CHECK (payment_method IN ('efectivo','transferencia','cheque',
                                              'tarjeta_debito','tarjeta_credito',
                                              'deposito','otro')),
  payment_status  VARCHAR(30)   NOT NULL DEFAULT 'pagado'
                    CHECK (payment_status IN ('pendiente','parcial','pagado',
                                              'vencido','cancelado')),
  payment_date    DATE,
  due_date        DATE,
  paid_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,

  bank_account    VARCHAR(100),
  bank_reference  VARCHAR(100),

  attachment_id   UUID,                             -- FK circular con attachments
  notes           TEXT,
  tags            TEXT[]        DEFAULT '{}',
  metadata        JSONB         DEFAULT '{}',

  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_transactions_company_id    ON transactions(company_id);
CREATE INDEX idx_transactions_project_id    ON transactions(project_id);
CREATE INDEX idx_transactions_client_id     ON transactions(client_id);
CREATE INDEX idx_transactions_type          ON transactions(type);
CREATE INDEX idx_transactions_payment_date  ON transactions(payment_date);
CREATE INDEX idx_transactions_created_by    ON transactions(created_by);
CREATE INDEX idx_transactions_status        ON transactions(payment_status) WHERE deleted_at IS NULL;

-- =============================================================================
-- 9. INVENTARIO — MATERIALES
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory_materials (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,

  sku               VARCHAR(50)  NOT NULL,
  name              VARCHAR(300) NOT NULL,
  description       TEXT,
  category          VARCHAR(100) NOT NULL DEFAULT 'general',
  subcategory       VARCHAR(100),
  brand             VARCHAR(100),
  model             VARCHAR(100),
  unit              VARCHAR(30)  NOT NULL DEFAULT 'pza',

  -- Control de stock
  quantity_stock    NUMERIC(12,4) NOT NULL DEFAULT 0,
  quantity_reserved NUMERIC(12,4) NOT NULL DEFAULT 0,
  quantity_minimum  NUMERIC(12,4) NOT NULL DEFAULT 0,
  quantity_maximum  NUMERIC(12,4),
  reorder_point     NUMERIC(12,4) NOT NULL DEFAULT 0,

  -- Precios
  cost_price        NUMERIC(14,4) NOT NULL DEFAULT 0,
  sale_price        NUMERIC(14,4) NOT NULL DEFAULT 0,
  currency          CHAR(3)       NOT NULL DEFAULT 'MXN',

  -- Ubicación en almacén
  warehouse         VARCHAR(100),
  aisle             VARCHAR(30),
  shelf             VARCHAR(30),
  bin               VARCHAR(30),

  -- Proveedor preferido
  supplier_id       UUID REFERENCES clients(id),
  supplier_sku      VARCHAR(100),
  lead_time_days    INT DEFAULT 0,

  tags              TEXT[]       DEFAULT '{}',
  image_url         TEXT,
  specifications    JSONB        DEFAULT '{}',
  notes             TEXT,

  status            VARCHAR(20)  NOT NULL DEFAULT 'activo'
                      CHECK (status IN ('activo','descontinuado','agotado','inactivo')),
  deleted_at        TIMESTAMPTZ,

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, sku)
);

CREATE TRIGGER trg_inventory_materials_updated_at
  BEFORE UPDATE ON inventory_materials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_inv_mat_company_id  ON inventory_materials(company_id);
CREATE INDEX idx_inv_mat_sku         ON inventory_materials(company_id, sku);
CREATE INDEX idx_inv_mat_category    ON inventory_materials(category);
CREATE INDEX idx_inv_mat_status      ON inventory_materials(status) WHERE deleted_at IS NULL;
-- Índice parcial para alertas automáticas de stock bajo
CREATE INDEX idx_inv_mat_low_stock   ON inventory_materials(company_id, quantity_stock)
  WHERE quantity_stock <= quantity_minimum AND status = 'activo';

-- ---------------------------------------------------------------------------
-- 9a. Movimientos de Inventario
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory_movements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID         NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  material_id     UUID         NOT NULL REFERENCES inventory_materials(id) ON DELETE RESTRICT,
  project_id      UUID REFERENCES projects(id),
  created_by      UUID         NOT NULL REFERENCES users(id),

  type            VARCHAR(30)  NOT NULL
                    CHECK (type IN ('entrada','salida','ajuste','transferencia',
                                    'devolucion','merma','inventario_inicial')),
  reason          VARCHAR(100),
  reference       VARCHAR(100),                     -- Núm. de orden de compra, remisión, etc.

  quantity        NUMERIC(12,4) NOT NULL,
  quantity_before NUMERIC(12,4) NOT NULL,
  quantity_after  NUMERIC(12,4) NOT NULL,

  unit_cost       NUMERIC(14,4) DEFAULT 0,
  total_cost      NUMERIC(14,4) DEFAULT 0,

  warehouse_from  VARCHAR(100),
  warehouse_to    VARCHAR(100),
  notes           TEXT,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inv_mov_material_id ON inventory_movements(material_id);
CREATE INDEX idx_inv_mov_company_id  ON inventory_movements(company_id);
CREATE INDEX idx_inv_mov_project_id  ON inventory_movements(project_id);
CREATE INDEX idx_inv_mov_type        ON inventory_movements(type);
CREATE INDEX idx_inv_mov_created_at  ON inventory_movements(created_at);

-- ---------------------------------------------------------------------------
-- 9b. Herramientas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory_tools (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code            VARCHAR(50)  NOT NULL,
  name            VARCHAR(300) NOT NULL,
  category        VARCHAR(100),
  brand           VARCHAR(100),
  model           VARCHAR(100),
  serial_number   VARCHAR(100),
  purchase_date   DATE,
  purchase_price  NUMERIC(14,2) DEFAULT 0,
  condition       VARCHAR(30)  NOT NULL DEFAULT 'bueno'
                    CHECK (condition IN ('nuevo','bueno','regular','mal_estado','baja')),
  status          VARCHAR(30)  NOT NULL DEFAULT 'disponible'
                    CHECK (status IN ('disponible','en_uso','mantenimiento','extraviado','baja')),
  assigned_to     UUID REFERENCES users(id),
  project_id      UUID REFERENCES projects(id),
  next_maintenance DATE,
  notes           TEXT,
  image_url       TEXT,
  specifications  JSONB DEFAULT '{}',
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
);

CREATE TRIGGER trg_inventory_tools_updated_at
  BEFORE UPDATE ON inventory_tools
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_inv_tools_company_id ON inventory_tools(company_id);
CREATE INDEX idx_inv_tools_status     ON inventory_tools(status);

-- ---------------------------------------------------------------------------
-- 9c. Vehículos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory_vehicles (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  plates              VARCHAR(20)  NOT NULL UNIQUE,
  brand               VARCHAR(100) NOT NULL,
  model               VARCHAR(100) NOT NULL,
  year                INT,
  color               VARCHAR(50),
  vin                 VARCHAR(30),
  type                VARCHAR(50)  NOT NULL DEFAULT 'camioneta'
                        CHECK (type IN ('sedan','camioneta','van','camion','motocicleta','otro')),
  status              VARCHAR(30)  NOT NULL DEFAULT 'disponible'
                        CHECK (status IN ('disponible','en_uso','mantenimiento','fuera_servicio')),
  assigned_to         UUID REFERENCES users(id),
  project_id          UUID REFERENCES projects(id),
  km_current          INT          NOT NULL DEFAULT 0,
  km_next_service     INT,
  insurance_expiry    DATE,
  verification_expiry DATE,
  notes               TEXT,
  image_url           TEXT,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_inventory_vehicles_updated_at
  BEFORE UPDATE ON inventory_vehicles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_vehicles_company_id ON inventory_vehicles(company_id);
CREATE INDEX idx_vehicles_status     ON inventory_vehicles(status);

-- =============================================================================
-- 10. RECURSOS HUMANOS — EMPLEADOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS employees (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id             UUID UNIQUE REFERENCES users(id),  -- Acceso al sistema

  -- Datos personales
  first_name          VARCHAR(100) NOT NULL,
  last_name           VARCHAR(100) NOT NULL,
  birth_date          DATE,
  gender              VARCHAR(30)
                        CHECK (gender IN ('masculino','femenino','otro','prefiero_no_decir')),
  nationality         VARCHAR(50)  DEFAULT 'Mexicana',
  marital_status      VARCHAR(20)
                        CHECK (marital_status IN ('soltero','casado','divorciado',
                                                   'union_libre','viudo')),

  -- Documentos legales (cifrar en capa de app con AES-256-GCM)
  curp                VARCHAR(20)  UNIQUE,
  rfc                 VARCHAR(15)  UNIQUE,
  nss                 VARCHAR(15)  UNIQUE,
  passport_number     VARCHAR(30),
  imss_clinic         VARCHAR(50),

  -- Contacto
  personal_email      VARCHAR(254),
  work_email          VARCHAR(254),
  phone               VARCHAR(30),
  emergency_contact   VARCHAR(200),
  emergency_phone     VARCHAR(30),

  -- Dirección
  address             TEXT,
  city                VARCHAR(100),
  state               VARCHAR(100),
  zip                 VARCHAR(10),

  -- Datos laborales
  employee_number     VARCHAR(30)  UNIQUE,
  job_title           VARCHAR(150) NOT NULL,
  department          VARCHAR(100),
  area                VARCHAR(100),
  manager_id          UUID REFERENCES employees(id),
  start_date          DATE         NOT NULL,
  end_date            DATE,
  employment_type     VARCHAR(30)  NOT NULL DEFAULT 'tiempo_completo'
                        CHECK (employment_type IN ('tiempo_completo','medio_tiempo',
                                                    'temporal','por_honorarios','practicante')),
  shift               VARCHAR(30)  DEFAULT 'diurno'
                        CHECK (shift IN ('diurno','nocturno','mixto','flexible')),

  -- Nómina
  salary              NUMERIC(12,2) NOT NULL DEFAULT 0,
  salary_type         VARCHAR(20)   NOT NULL DEFAULT 'mensual'
                        CHECK (salary_type IN ('mensual','quincenal','semanal',
                                                'por_hora','por_dia')),
  daily_wage          NUMERIC(10,2) DEFAULT 0,
  payment_method      VARCHAR(30)   DEFAULT 'transferencia',
  bank_name           VARCHAR(100),
  bank_account        VARCHAR(50),
  clabe               VARCHAR(20),

  -- Vacaciones
  vacation_days_year  INT          NOT NULL DEFAULT 12,
  vacation_days_used  INT          NOT NULL DEFAULT 0,
  vacation_days_left  INT          GENERATED ALWAYS AS
                        (vacation_days_year - vacation_days_used) STORED,

  -- Competencias
  skills              JSONB        DEFAULT '[]',   -- [{name, level}]
  certifications      JSONB        DEFAULT '[]',   -- [{name, issuer, expiry_date}]

  -- Estado
  status              VARCHAR(30)  NOT NULL DEFAULT 'activo'
                        CHECK (status IN ('activo','baja','incapacidad',
                                          'permiso','suspendido')),
  termination_reason  TEXT,
  photo_url           TEXT,
  notes               TEXT,
  metadata            JSONB        DEFAULT '{}',
  deleted_at          TIMESTAMPTZ,

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_employees_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_employees_company_id      ON employees(company_id);
CREATE INDEX idx_employees_user_id         ON employees(user_id);
CREATE INDEX idx_employees_department      ON employees(department);
CREATE INDEX idx_employees_status          ON employees(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_employees_employee_number ON employees(employee_number);
CREATE INDEX idx_employees_manager_id      ON employees(manager_id);

-- ---------------------------------------------------------------------------
-- 10a. Contratos de Trabajo
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contracts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  employee_id     UUID        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  contract_number VARCHAR(50)  UNIQUE,
  type            VARCHAR(50)  NOT NULL DEFAULT 'indefinido'
                    CHECK (type IN ('indefinido','determinado','obra_determinada',
                                    'honorarios','practicante','otro')),
  start_date      DATE         NOT NULL,
  end_date        DATE,
  salary          NUMERIC(12,2) NOT NULL,
  position        VARCHAR(150) NOT NULL,
  department      VARCHAR(100),
  status          VARCHAR(20)  NOT NULL DEFAULT 'activo'
                    CHECK (status IN ('activo','vencido','rescindido','renovado')),
  document_url    TEXT,
  signed_at       DATE,
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_contracts_employee_id ON contracts(employee_id);
CREATE INDEX idx_contracts_company_id  ON contracts(company_id);
CREATE INDEX idx_contracts_status      ON contracts(status);

-- ---------------------------------------------------------------------------
-- 10b. Solicitudes de Vacaciones / Permisos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vacation_requests (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id   UUID        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  requested_by  UUID        NOT NULL REFERENCES users(id),
  reviewed_by   UUID REFERENCES users(id),
  start_date    DATE        NOT NULL,
  end_date      DATE        NOT NULL,
  days          INT         NOT NULL,
  type          VARCHAR(30) NOT NULL DEFAULT 'vacaciones'
                  CHECK (type IN ('vacaciones','permiso_con_goce','permiso_sin_goce',
                                  'incapacidad','maternidad','paternidad')),
  status        VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                  CHECK (status IN ('pendiente','aprobada','rechazada','cancelada')),
  reason        TEXT,
  review_notes  TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_vacation_requests_updated_at
  BEFORE UPDATE ON vacation_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_vacation_requests_employee_id ON vacation_requests(employee_id);
CREATE INDEX idx_vacation_requests_status      ON vacation_requests(status);

-- ---------------------------------------------------------------------------
-- 10c. Períodos de Nómina
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payroll_periods (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name            VARCHAR(100) NOT NULL,
  period_type     VARCHAR(20)  NOT NULL DEFAULT 'quincenal'
                    CHECK (period_type IN ('semanal','quincenal','mensual')),
  start_date      DATE         NOT NULL,
  end_date        DATE         NOT NULL,
  payment_date    DATE         NOT NULL,
  status          VARCHAR(20)  NOT NULL DEFAULT 'borrador'
                    CHECK (status IN ('borrador','calculado','autorizado','pagado','cerrado')),
  total_gross     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_net       NUMERIC(14,2) NOT NULL DEFAULT 0,
  processed_by    UUID REFERENCES users(id),
  authorized_by   UUID REFERENCES users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_payroll_periods_updated_at
  BEFORE UPDATE ON payroll_periods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_payroll_periods_company_id ON payroll_periods(company_id);
CREATE INDEX idx_payroll_periods_status     ON payroll_periods(status);

-- ---------------------------------------------------------------------------
-- 10d. Detalle de Nómina por Empleado
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payroll_entries (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payroll_period_id UUID      NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id       UUID      NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  company_id        UUID      NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,

  -- Percepciones
  base_salary       NUMERIC(12,2) NOT NULL DEFAULT 0,
  overtime_hours    NUMERIC(7,2)  NOT NULL DEFAULT 0,
  overtime_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  bonuses           NUMERIC(12,2) NOT NULL DEFAULT 0,
  commissions       NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_income      NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_salary      NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Deducciones
  isr               NUMERIC(12,2) NOT NULL DEFAULT 0,
  imss_employee     NUMERIC(12,2) NOT NULL DEFAULT 0,
  infonavit         NUMERIC(12,2) NOT NULL DEFAULT 0,
  fonacot           NUMERIC(12,2) NOT NULL DEFAULT 0,
  absences_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_deductions  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_deductions  NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Aportaciones patronales
  imss_employer     NUMERIC(12,2) NOT NULL DEFAULT 0,
  infonavit_employer NUMERIC(12,2) NOT NULL DEFAULT 0,
  rcv               NUMERIC(12,2) NOT NULL DEFAULT 0,

  net_salary        NUMERIC(12,2) NOT NULL DEFAULT 0,

  days_worked       NUMERIC(5,2)  NOT NULL DEFAULT 0,
  absences          NUMERIC(5,2)  NOT NULL DEFAULT 0,

  payment_status    VARCHAR(20)   NOT NULL DEFAULT 'pendiente'
                      CHECK (payment_status IN ('pendiente','pagado','cancelado')),
  payment_date      DATE,
  bank_reference    VARCHAR(100),
  notes             TEXT,
  breakdown         JSONB         DEFAULT '{}',

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (payroll_period_id, employee_id)
);

CREATE TRIGGER trg_payroll_entries_updated_at
  BEFORE UPDATE ON payroll_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_payroll_entries_period_id   ON payroll_entries(payroll_period_id);
CREATE INDEX idx_payroll_entries_employee_id ON payroll_entries(employee_id);
CREATE INDEX idx_payroll_entries_company_id  ON payroll_entries(company_id);

-- =============================================================================
-- 11. ARCHIVOS — ATTACHMENTS (S3 / LOCAL)
-- =============================================================================

CREATE TABLE IF NOT EXISTS attachments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  uploaded_by     UUID        NOT NULL REFERENCES users(id),

  -- Referencia polimórfica (a cualquier entidad)
  entity_type     VARCHAR(50)  NOT NULL,             -- 'project','task','quote','transaction',...
  entity_id       UUID         NOT NULL,

  -- Datos del archivo
  original_name   VARCHAR(500) NOT NULL,
  stored_name     VARCHAR(500) NOT NULL,
  s3_key          TEXT         NOT NULL,
  s3_bucket       VARCHAR(200) NOT NULL,
  mime_type       VARCHAR(100) NOT NULL,
  file_size       BIGINT       NOT NULL DEFAULT 0,   -- Bytes
  file_extension  VARCHAR(20),

  -- Compartir con enlace
  share_token     VARCHAR(100) UNIQUE,
  share_expires_at TIMESTAMPTZ,
  is_public       BOOLEAN      NOT NULL DEFAULT FALSE,

  deleted_at      TIMESTAMPTZ,
  deleted_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attachments_entity        ON attachments(entity_type, entity_id);
CREATE INDEX idx_attachments_company_id    ON attachments(company_id);
CREATE INDEX idx_attachments_uploaded_by   ON attachments(uploaded_by);
CREATE INDEX idx_attachments_share_token   ON attachments(share_token) WHERE share_token IS NOT NULL;

-- Resolver FK circular: transactions → attachments
ALTER TABLE transactions ADD CONSTRAINT fk_transactions_attachment
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) DEFERRABLE INITIALLY DEFERRED;

-- Resolver FK: quote_lines → inventory_materials
ALTER TABLE quote_lines ADD CONSTRAINT fk_quote_lines_material
  FOREIGN KEY (material_id) REFERENCES inventory_materials(id);

-- =============================================================================
-- 12. AUDITORÍA
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  company_id      UUID,
  user_id         UUID,
  action          VARCHAR(100) NOT NULL,             -- CREATE, UPDATE, DELETE, LOGIN, EXPORT, etc.
  entity_type     VARCHAR(100) NOT NULL,
  entity_id       TEXT,
  changes         JSONB        DEFAULT '{}',         -- {before:{}, after:{}}
  ip_address      INET,
  user_agent      TEXT,
  endpoint        VARCHAR(300),
  http_method     VARCHAR(10),
  response_status INT,
  duration_ms     INT,
  session_id      TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_company_id ON audit_logs(company_id);
CREATE INDEX idx_audit_logs_user_id    ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity     ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_action     ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_changes    ON audit_logs USING GIN(changes);

-- =============================================================================
-- 13. NOTIFICACIONES
-- =============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type        VARCHAR(80)  NOT NULL,
  title       VARCHAR(300) NOT NULL,
  body        TEXT,
  data        JSONB        DEFAULT '{}',
  read_at     TIMESTAMPTZ,
  action_url  TEXT,
  icon        VARCHAR(50),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id    ON notifications(user_id);
CREATE INDEX idx_notifications_unread     ON notifications(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_created_at ON notifications(created_at);

-- =============================================================================
-- 14. REPORTES PROGRAMADOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS scheduled_reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by    UUID        NOT NULL REFERENCES users(id),
  name          VARCHAR(200) NOT NULL,
  report_type   VARCHAR(80)  NOT NULL,
  format        VARCHAR(20)  NOT NULL DEFAULT 'pdf'
                  CHECK (format IN ('pdf','xlsx','csv','json')),
  frequency     VARCHAR(20)  NOT NULL DEFAULT 'semanal'
                  CHECK (frequency IN ('diario','semanal','quincenal','mensual','manual')),
  recipients    TEXT[]       NOT NULL DEFAULT '{}',
  parameters    JSONB        DEFAULT '{}',
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_scheduled_reports_updated_at
  BEFORE UPDATE ON scheduled_reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_scheduled_reports_company_id ON scheduled_reports(company_id);
CREATE INDEX idx_scheduled_reports_next_run   ON scheduled_reports(next_run_at) WHERE active = TRUE;

-- =============================================================================
-- 15. ROW-LEVEL SECURITY (RLS)
-- =============================================================================
-- RLS actúa como segunda capa de defensa además de los checks en la aplicación.
-- La app debe llamar: SET app.current_user_id = '...'; SET app.current_user_role = '...';
-- antes de ejecutar queries en nombre de un usuario.

ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients         ENABLE ROW LEVEL SECURITY;

-- users: admin ve todo; demás solo su empresa
DROP POLICY IF EXISTS policy_users_isolation ON users;
CREATE POLICY policy_users_isolation ON users
  USING (
    current_app_user_role() = 'admin'
    OR company_id = current_app_company_id()
  )
  WITH CHECK (
    current_app_user_role() = 'admin'
    OR company_id = current_app_company_id()
  );

-- projects: admin ve todo; usuarios ven su empresa o proyectos donde son miembros
DROP POLICY IF EXISTS policy_projects_isolation ON projects;
CREATE POLICY policy_projects_isolation ON projects
  USING (
    current_app_user_role() = 'admin'
    OR company_id = current_app_company_id()
    OR id IN (
      SELECT project_id FROM project_members
      WHERE user_id = current_app_user_id()
    )
  );

-- tasks: admin/manager ven todo en su empresa; demás ven tareas asignadas o creadas
DROP POLICY IF EXISTS policy_tasks_isolation ON tasks;
CREATE POLICY policy_tasks_isolation ON tasks
  USING (
    current_app_user_role() IN ('admin','manager')
    OR project_id IN (
      SELECT id FROM projects WHERE company_id = current_app_company_id()
    )
    OR assigned_to = current_app_user_id()
    OR created_by  = current_app_user_id()
  );

-- transactions: solo admin/manager/finance; operative y technician no ven finanzas
DROP POLICY IF EXISTS policy_transactions_isolation ON transactions;
CREATE POLICY policy_transactions_isolation ON transactions
  USING (
    current_app_user_role() IN ('admin','manager','finance')
    OR (
      company_id = current_app_company_id()
      AND current_app_user_role() NOT IN ('operative','technician')
    )
  );

-- employees: admin/manager/hr ven todo; empleado solo se ve a sí mismo
DROP POLICY IF EXISTS policy_employees_isolation ON employees;
CREATE POLICY policy_employees_isolation ON employees
  USING (
    current_app_user_role() IN ('admin','manager','hr')
    OR (
      company_id = current_app_company_id()
      AND user_id = current_app_user_id()
    )
  );

-- payroll: solo admin/finance/hr
DROP POLICY IF EXISTS policy_payroll_periods ON payroll_periods;
CREATE POLICY policy_payroll_periods ON payroll_periods
  USING (
    current_app_user_role() IN ('admin','manager','finance','hr')
    AND company_id = current_app_company_id()
  );

DROP POLICY IF EXISTS policy_payroll_entries ON payroll_entries;
CREATE POLICY policy_payroll_entries ON payroll_entries
  USING (
    current_app_user_role() IN ('admin','manager','finance','hr')
    OR employee_id IN (
      SELECT id FROM employees WHERE user_id = current_app_user_id()
    )
  );

-- quotes: admin/manager/finance; o el creador
DROP POLICY IF EXISTS policy_quotes_isolation ON quotes;
CREATE POLICY policy_quotes_isolation ON quotes
  USING (
    current_app_user_role() IN ('admin','manager','finance')
    OR (
      company_id = current_app_company_id()
      AND created_by = current_app_user_id()
    )
  );

-- clients: admin ve todo; usuarios ven solo su empresa
DROP POLICY IF EXISTS policy_clients_isolation ON clients;
CREATE POLICY policy_clients_isolation ON clients
  USING (
    current_app_user_role() = 'admin'
    OR company_id = current_app_company_id()
  );

-- =============================================================================
-- 16. DATOS INICIALES — 4 EMPRESAS + USUARIOS
-- =============================================================================

INSERT INTO companies (id, name, short_name, code, rfc, email, phone, industry, currency) VALUES
(
  'a1000000-0000-0000-0000-000000000001',
  'Incored y Asociados S.A. de C.V.',
  'Incored', 'INC',
  'IAA211130AB1',
  'operaciones@incored.com.mx',
  '+52 55 1234 5678',
  'Telecomunicaciones / Infraestructura',
  'MXN'
),
(
  'a2000000-0000-0000-0000-000000000002',
  'Zhada Construcciones S.A. de C.V.',
  'Zhada', 'ZHA',
  'ZCO190815CD2',
  'administracion@zhada.com.mx',
  '+52 55 2345 6789',
  'Construcción Civil',
  'MXN'
),
(
  'a3000000-0000-0000-0000-000000000003',
  'Incored International Corp.',
  'Incored Int.', 'INT',
  'IIC200101EF3',
  'international@incored.com',
  '+1 210 555 0100',
  'International Telecommunications',
  'USD'
),
(
  'a4000000-0000-0000-0000-000000000004',
  'Mika Importaciones S.A. de C.V.',
  'Mika', 'MKA',
  'MIM180520GH4',
  'compras@mika.com.mx',
  '+52 55 3456 7890',
  'Importación / Comercio',
  'MXN'
)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Usuarios iniciales
-- CONTRASEÑA DE TODOS: Admin123!
-- Hash generado con bcrypt 10 rounds
-- ---------------------------------------------------------------------------
INSERT INTO users (
  id, company_id, email, password_hash,
  first_name, last_name, role, status, job_title
) VALUES
(
  'b1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'admin@incored.com.mx',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'Administrador', 'Sistema', 'admin', 'active',
  'Administrador del Sistema'
),
(
  'b2000000-0000-0000-0000-000000000002',
  'a1000000-0000-0000-0000-000000000001',
  'gerencia@incored.com.mx',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'Carlos', 'Mendoza', 'manager', 'active',
  'Gerente General'
),
(
  'b3000000-0000-0000-0000-000000000003',
  'a1000000-0000-0000-0000-000000000001',
  'finanzas@incored.com.mx',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'Ana', 'García', 'finance', 'active',
  'Directora de Finanzas'
),
(
  'b4000000-0000-0000-0000-000000000004',
  'a1000000-0000-0000-0000-000000000001',
  'proyectos@incored.com.mx',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'Roberto', 'López', 'project_manager', 'active',
  'Jefe de Proyectos'
),
(
  'b5000000-0000-0000-0000-000000000005',
  'a1000000-0000-0000-0000-000000000001',
  'rh@incored.com.mx',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'María', 'Torres', 'hr', 'active',
  'Coordinadora de Recursos Humanos'
),
(
  'b6000000-0000-0000-0000-000000000006',
  'a2000000-0000-0000-0000-000000000002',
  'gerencia@zhada.com.mx',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'Fernando', 'Ruiz', 'manager', 'active',
  'Gerente Zhada Construcciones'
),
(
  'b7000000-0000-0000-0000-000000000007',
  'a3000000-0000-0000-0000-000000000003',
  'ops@incored-int.com',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'David', 'Smith', 'manager', 'active',
  'Operations Manager'
),
(
  'b8000000-0000-0000-0000-000000000008',
  'a4000000-0000-0000-0000-000000000004',
  'compras@mika.com.mx',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'Laura', 'Vega', 'manager', 'active',
  'Directora de Compras'
)
ON CONFLICT (email) DO NOTHING;

-- =============================================================================
-- FIN DEL SCHEMA — VERIFICACIÓN
-- =============================================================================

SELECT
  tablename                                                      AS tabla,
  pg_size_pretty(pg_total_relation_size('public.'||tablename))  AS tamaño
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
