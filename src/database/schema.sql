-- ============================================================
-- INCORED ERP - PostgreSQL Schema
-- Version: 1.0.0
-- Applies to: PostgreSQL 15+
-- ============================================================

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────
-- HELPER FUNCTIONS
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION current_app_user_id()
RETURNS INTEGER AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_id', true), '')::INTEGER;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_app_user_role()
RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_role', true), '');
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Auto-update updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- COMPANIES
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS companies (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL UNIQUE,
  short_code VARCHAR(10)  NOT NULL UNIQUE, -- INC, ZHA, INT, MKA
  country    VARCHAR(100),
  industry   VARCHAR(100),
  address    TEXT,
  phone      VARCHAR(20),
  email      VARCHAR(255),
  rfc        VARCHAR(50),
  logo_url   TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                    SERIAL PRIMARY KEY,
  email                 VARCHAR(255) NOT NULL UNIQUE,
  password_hash         VARCHAR(255) NOT NULL,
  name                  VARCHAR(255) NOT NULL,
  phone                 VARCHAR(20),
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  role                  VARCHAR(50)  NOT NULL DEFAULT 'operative',
    CONSTRAINT users_role_check CHECK (role IN (
      'admin','manager','finance','hr','project_manager','supervisor','operative','technician'
    )),
  status                VARCHAR(50)  NOT NULL DEFAULT 'active',
    CONSTRAINT users_status_check CHECK (status IN ('active','inactive','suspended')),
  must_change_password  BOOLEAN      NOT NULL DEFAULT FALSE,
  last_login            TIMESTAMP,
  login_attempts        INTEGER      NOT NULL DEFAULT 0,
  locked_until          TIMESTAMP,
  two_fa_enabled        BOOLEAN      NOT NULL DEFAULT FALSE,
  two_fa_secret         VARCHAR(255),    -- encrypted
  two_fa_backup_codes   TEXT,            -- JSON array of hashed backup codes
  avatar_url            TEXT,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email       ON users(email);
CREATE INDEX idx_users_company_id  ON users(company_id);
CREATE INDEX idx_users_role        ON users(role);
CREATE INDEX idx_users_status      ON users(status);

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────
-- TOKEN MANAGEMENT
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  revoked    BOOLEAN   NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_refresh_tokens_token   ON refresh_tokens(token);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS token_blacklist (
  id         SERIAL PRIMARY KEY,
  token_jti  VARCHAR(50) NOT NULL UNIQUE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_token_blacklist_jti ON token_blacklist(token_jti);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used       BOOLEAN   NOT NULL DEFAULT FALSE,
  used_at    TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_prt_token   ON password_reset_tokens(token);
CREATE INDEX idx_prt_user_id ON password_reset_tokens(user_id);

-- ─────────────────────────────────────────────────────────────
-- CLIENTS / SUPPLIERS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clients (
  id                    SERIAL PRIMARY KEY,
  name                  VARCHAR(255) NOT NULL,
  type                  VARCHAR(50)  NOT NULL DEFAULT 'cliente',
    CONSTRAINT clients_type_check CHECK (type IN ('cliente','proveedor','ambos')),
  rfc                   VARCHAR(50),
  country               VARCHAR(100),
  state                 VARCHAR(100),
  city                  VARCHAR(100),
  address               TEXT,
  industry              VARCHAR(100),
  website               VARCHAR(255),
  primary_contact_name  VARCHAR(255),
  primary_contact_email VARCHAR(255),
  primary_contact_phone VARCHAR(20),
  credit_limit          DECIMAL(14,2),
  payment_terms         VARCHAR(50),
    CONSTRAINT clients_payment_terms_check CHECK (
      payment_terms IN ('contado','15_dias','30_dias','60_dias','90_dias') OR payment_terms IS NULL
    ),
  credit_rating         VARCHAR(50),
    CONSTRAINT clients_credit_rating_check CHECK (
      credit_rating IN ('excelente','buena','media','mala','morosa') OR credit_rating IS NULL
    ),
  notes                 TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_clients_type ON clients(type);
CREATE INDEX idx_clients_name ON clients(name);

CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────
-- LEADS / CRM PIPELINE
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leads (
  id           SERIAL PRIMARY KEY,
  title        VARCHAR(255) NOT NULL,
  client_id    INTEGER REFERENCES clients(id),
  company_id   INTEGER NOT NULL REFERENCES companies(id),
  assigned_to  INTEGER REFERENCES users(id),
  stage        VARCHAR(50) NOT NULL DEFAULT 'prospecto',
    CONSTRAINT leads_stage_check CHECK (stage IN (
      'prospecto','contactado','cotizacion','negociacion','ganado','perdido','cancelado'
    )),
  value        DECIMAL(14,2),
  currency     VARCHAR(10)  NOT NULL DEFAULT 'MXN',
  probability  INTEGER CHECK (probability BETWEEN 0 AND 100),
  source       VARCHAR(100),
  expected_close_date DATE,
  notes        TEXT,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_leads_company_id  ON leads(company_id);
CREATE INDEX idx_leads_stage       ON leads(stage);
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────
-- PROJECTS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id                 SERIAL PRIMARY KEY,
  code               VARCHAR(50)  NOT NULL UNIQUE,
  name               VARCHAR(255) NOT NULL,
  client_id          INTEGER NOT NULL REFERENCES clients(id),
  company_id         INTEGER NOT NULL REFERENCES companies(id),
  pm_id              INTEGER REFERENCES users(id),
  lead_id            INTEGER REFERENCES leads(id),
  order_number       VARCHAR(100),
  budget_amount      DECIMAL(14,2),
  spent_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency           VARCHAR(10)   NOT NULL DEFAULT 'MXN',
  expected_margin    DECIMAL(6,2),
  status             VARCHAR(50)   NOT NULL DEFAULT 'planning',
    CONSTRAINT projects_status_check CHECK (
      status IN ('planning','executing','paused','completed','cancelled')
    ),
  progress_percent   INTEGER       NOT NULL DEFAULT 0
    CHECK (progress_percent BETWEEN 0 AND 100),
  country            VARCHAR(100),
  city               VARCHAR(100),
  address            TEXT,
  start_date         DATE,
  end_date_planned   DATE,
  end_date_real      DATE,
  description        TEXT,
  notes              TEXT,
  created_by         INTEGER NOT NULL REFERENCES users(id),
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_projects_company_id ON projects(company_id);
CREATE INDEX idx_projects_client_id  ON projects(client_id);
CREATE INDEX idx_projects_pm_id      ON projects(pm_id);
CREATE INDEX idx_projects_status     ON projects(status);
CREATE INDEX idx_projects_code       ON projects(code);

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Project team members
CREATE TABLE IF NOT EXISTS project_members (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role       VARCHAR(100),
  added_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, user_id)
);

CREATE INDEX idx_project_members_project ON project_members(project_id);
CREATE INDEX idx_project_members_user    ON project_members(user_id);

-- ─────────────────────────────────────────────────────────────
-- TASKS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id               SERIAL PRIMARY KEY,
  title            VARCHAR(255) NOT NULL,
  description      TEXT,
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  assigned_to      INTEGER NOT NULL REFERENCES users(id),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  priority         VARCHAR(50) NOT NULL DEFAULT 'media',
    CONSTRAINT tasks_priority_check CHECK (priority IN ('critica','alta','media','baja')),
  status           VARCHAR(50) NOT NULL DEFAULT 'no_iniciada',
    CONSTRAINT tasks_status_check CHECK (
      status IN ('no_iniciada','pendiente','en_proceso','bloqueada','en_revision','completada','cancelada')
    ),
  due_date         DATE,
  estimated_hours  INTEGER,
  actual_hours     DECIMAL(8,2) NOT NULL DEFAULT 0,
  percent_complete INTEGER      NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),
  parent_task_id   INTEGER REFERENCES tasks(id),
  blocked_by_ids   INTEGER[],   -- array of task IDs that block this one
  tags             TEXT[],
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tasks_assigned_to  ON tasks(assigned_to);
CREATE INDEX idx_tasks_project_id   ON tasks(project_id);
CREATE INDEX idx_tasks_status       ON tasks(status);
CREATE INDEX idx_tasks_priority     ON tasks(priority);
CREATE INDEX idx_tasks_due_date     ON tasks(due_date);

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Task comments
CREATE TABLE IF NOT EXISTS task_comments (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_task_comments_task ON task_comments(task_id);

-- Time entries
CREATE TABLE IF NOT EXISTS time_entries (
  id               SERIAL PRIMARY KEY,
  task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  start_time       TIMESTAMP NOT NULL,
  end_time         TIMESTAMP,
  duration_minutes INTEGER,
  notes            TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_time_entries_task_id  ON time_entries(task_id);
CREATE INDEX idx_time_entries_user_id  ON time_entries(user_id);
CREATE INDEX idx_time_entries_start    ON time_entries(start_time DESC);

-- ─────────────────────────────────────────────────────────────
-- QUOTES
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quotes (
  id               SERIAL PRIMARY KEY,
  folio            VARCHAR(50)  NOT NULL UNIQUE,
  client_id        INTEGER NOT NULL REFERENCES clients(id),
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  project_id       INTEGER REFERENCES projects(id),
  lead_id          INTEGER REFERENCES leads(id),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  status           VARCHAR(50) NOT NULL DEFAULT 'borrador',
    CONSTRAINT quotes_status_check CHECK (
      status IN ('borrador','enviada','aceptada','rechazada','expirada','cancelada')
    ),
  issue_date       DATE NOT NULL,
  validity_days    INTEGER NOT NULL DEFAULT 30,
  subtotal         DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_percent      DECIMAL(5,2)  NOT NULL DEFAULT 16,
  tax_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  total            DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency         VARCHAR(10)   NOT NULL DEFAULT 'MXN',
  terms_conditions TEXT,
  internal_notes   TEXT,
  sent_at          TIMESTAMP,
  accepted_at      TIMESTAMP,
  rejected_at      TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_quotes_company_id ON quotes(company_id);
CREATE INDEX idx_quotes_client_id  ON quotes(client_id);
CREATE INDEX idx_quotes_status     ON quotes(status);
CREATE INDEX idx_quotes_folio      ON quotes(folio);

CREATE TRIGGER quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Quote line items
CREATE TABLE IF NOT EXISTS quote_lines (
  id               SERIAL PRIMARY KEY,
  quote_id         INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  description      VARCHAR(500) NOT NULL,
  quantity         DECIMAL(12,4) NOT NULL,
  unit             VARCHAR(50),
  unit_price       DECIMAL(14,4) NOT NULL,
  discount_percent DECIMAL(5,2)  NOT NULL DEFAULT 0,
  line_total       DECIMAL(14,2) NOT NULL,
  line_order       INTEGER       NOT NULL DEFAULT 0
);

CREATE INDEX idx_quote_lines_quote ON quote_lines(quote_id);

-- ─────────────────────────────────────────────────────────────
-- TRANSACTIONS (Finance)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transactions (
  id               SERIAL PRIMARY KEY,
  type             VARCHAR(50)  NOT NULL,
    CONSTRAINT transactions_type_check CHECK (type IN ('ingreso','egreso','transferencia')),
  category         VARCHAR(100) NOT NULL,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  project_id       INTEGER REFERENCES projects(id),
  client_id        INTEGER REFERENCES clients(id),
  amount           DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  currency         VARCHAR(10)   NOT NULL DEFAULT 'MXN',
  exchange_rate    DECIMAL(10,4) DEFAULT 1,
  description      TEXT,
  reference_number VARCHAR(100),
  transaction_date DATE NOT NULL,
  status           VARCHAR(50)   NOT NULL DEFAULT 'registrada',
    CONSTRAINT transactions_status_check CHECK (
      status IN ('pendiente','registrada','conciliada','cancelada')
    ),
  attachment_id    INTEGER,  -- FK added after attachments table
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transactions_company_project ON transactions(company_id, project_id);
CREATE INDEX idx_transactions_type            ON transactions(type);
CREATE INDEX idx_transactions_date            ON transactions(transaction_date DESC);
CREATE INDEX idx_transactions_client_id       ON transactions(client_id);

CREATE TRIGGER transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────
-- INVENTORY
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory_materials (
  id                   SERIAL PRIMARY KEY,
  sku                  VARCHAR(50)  NOT NULL UNIQUE,
  name                 VARCHAR(255) NOT NULL,
  category             VARCHAR(100),
  quantity_stock       DECIMAL(12,4) NOT NULL DEFAULT 0,
  quantity_min         DECIMAL(12,4),
  quantity_max         DECIMAL(12,4),
  unit_of_measure      VARCHAR(50)  NOT NULL DEFAULT 'unidad',
  cost_last_purchase   DECIMAL(14,4),
  cost_average         DECIMAL(14,4),
  company_id           INTEGER NOT NULL REFERENCES companies(id),
  supplier_id          INTEGER REFERENCES clients(id),
  location             VARCHAR(255),
  last_movement_date   DATE,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inventory_materials_sku        ON inventory_materials(sku);
CREATE INDEX idx_inventory_materials_company_id ON inventory_materials(company_id);
CREATE INDEX idx_inventory_materials_category   ON inventory_materials(category);

CREATE TRIGGER inventory_materials_updated_at
  BEFORE UPDATE ON inventory_materials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS inventory_movements (
  id               SERIAL PRIMARY KEY,
  material_id      INTEGER NOT NULL REFERENCES inventory_materials(id),
  type             VARCHAR(50) NOT NULL,
    CONSTRAINT inv_movements_type_check CHECK (
      type IN ('entrada','salida','transferencia','ajuste','devolucion')
    ),
  quantity         DECIMAL(12,4) NOT NULL,
  quantity_before  DECIMAL(12,4) NOT NULL DEFAULT 0,
  quantity_after   DECIMAL(12,4) NOT NULL DEFAULT 0,
  unit_cost        DECIMAL(14,4),
  total_cost       DECIMAL(14,2),
  project_id       INTEGER REFERENCES projects(id),
  company_from     INTEGER REFERENCES companies(id),
  company_to       INTEGER REFERENCES companies(id),
  reference_number VARCHAR(100),
  notes            TEXT,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inv_movements_material ON inventory_movements(material_id);
CREATE INDEX idx_inv_movements_type     ON inventory_movements(type);
CREATE INDEX idx_inv_movements_project  ON inventory_movements(project_id);

-- Tools
CREATE TABLE IF NOT EXISTS inventory_tools (
  id               SERIAL PRIMARY KEY,
  code             VARCHAR(50) NOT NULL UNIQUE,
  name             VARCHAR(255) NOT NULL,
  category         VARCHAR(100),
  brand            VARCHAR(100),
  model            VARCHAR(100),
  serial_number    VARCHAR(100),
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  current_project  INTEGER REFERENCES projects(id),
  assigned_to      INTEGER REFERENCES employees(id),
  status           VARCHAR(50) NOT NULL DEFAULT 'disponible',
    CONSTRAINT tools_status_check CHECK (
      status IN ('disponible','asignado','en_reparacion','dado_de_baja')
    ),
  purchase_date    DATE,
  purchase_cost    DECIMAL(12,2),
  notes            TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tools_company_id ON inventory_tools(company_id);
CREATE INDEX idx_tools_status     ON inventory_tools(status);

-- Vehicles
CREATE TABLE IF NOT EXISTS inventory_vehicles (
  id               SERIAL PRIMARY KEY,
  plates           VARCHAR(20)  NOT NULL UNIQUE,
  brand            VARCHAR(100) NOT NULL,
  model            VARCHAR(100) NOT NULL,
  year             INTEGER,
  vin              VARCHAR(50),
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  current_project  INTEGER REFERENCES projects(id),
  assigned_driver  INTEGER REFERENCES employees(id),
  status           VARCHAR(50) NOT NULL DEFAULT 'disponible',
    CONSTRAINT vehicles_status_check CHECK (
      status IN ('disponible','asignado','en_mantenimiento','dado_de_baja')
    ),
  fuel_type        VARCHAR(50),
  odometer         INTEGER NOT NULL DEFAULT 0,
  insurance_expiry DATE,
  next_service_km  INTEGER,
  notes            TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_vehicles_company_id ON inventory_vehicles(company_id);
CREATE INDEX idx_vehicles_status     ON inventory_vehicles(status);

-- ─────────────────────────────────────────────────────────────
-- EMPLOYEES (HR)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS employees (
  id               SERIAL PRIMARY KEY,
  employee_number  VARCHAR(20) UNIQUE,
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(255),
  phone            VARCHAR(20),
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  position         VARCHAR(100),
  department       VARCHAR(100),
  supervisor_id    INTEGER REFERENCES employees(id),
  salary_base      DECIMAL(12,2),
  salary_period    VARCHAR(20) NOT NULL DEFAULT 'mensual',
    CONSTRAINT emp_salary_period_check CHECK (
      salary_period IN ('semanal','quincenal','mensual')
    ),
  hire_date        DATE,
  termination_date DATE,
  status           VARCHAR(50) NOT NULL DEFAULT 'activo',
    CONSTRAINT employees_status_check CHECK (
      status IN ('activo','inactivo','vacaciones','baja')
    ),
  curp             VARCHAR(20),
  rfc              VARCHAR(15),
  nss              VARCHAR(15),     -- Número de Seguridad Social
  vacation_days    INTEGER NOT NULL DEFAULT 0,
  vacation_taken   INTEGER NOT NULL DEFAULT 0,
  skills           JSONB,
  certifications   JSONB,
  emergency_contact_name  VARCHAR(255),
  emergency_contact_phone VARCHAR(20),
  notes            TEXT,
  user_id          INTEGER REFERENCES users(id) UNIQUE, -- if they also have a system login
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_employees_company_id ON employees(company_id);
CREATE INDEX idx_employees_status     ON employees(status);

CREATE TRIGGER employees_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Employee contracts
CREATE TABLE IF NOT EXISTS employee_contracts (
  id               SERIAL PRIMARY KEY,
  employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contract_type    VARCHAR(50) NOT NULL,
    CONSTRAINT contract_type_check CHECK (
      contract_type IN ('indefinido','determinado','honorarios','obra','aprendizaje')
    ),
  start_date       DATE NOT NULL,
  end_date         DATE,
  salary           DECIMAL(12,2) NOT NULL,
  currency         VARCHAR(10)   NOT NULL DEFAULT 'MXN',
  signed_at        DATE,
  attachment_id    INTEGER,
  notes            TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contracts_employee ON employee_contracts(employee_id);

-- Vacation requests
CREATE TABLE IF NOT EXISTS vacation_requests (
  id               SERIAL PRIMARY KEY,
  employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  days_count       INTEGER NOT NULL,
  status           VARCHAR(50) NOT NULL DEFAULT 'pendiente',
    CONSTRAINT vacation_status_check CHECK (
      status IN ('pendiente','aprobada','rechazada','cancelada')
    ),
  reason           TEXT,
  approved_by      INTEGER REFERENCES users(id),
  approved_at      TIMESTAMP,
  rejection_reason TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_vacation_requests_employee ON vacation_requests(employee_id);
CREATE INDEX idx_vacation_requests_status   ON vacation_requests(status);

-- Payroll
CREATE TABLE IF NOT EXISTS payroll_periods (
  id               SERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  period_type      VARCHAR(20) NOT NULL DEFAULT 'quincenal',
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'borrador',
    CONSTRAINT payroll_status_check CHECK (
      status IN ('borrador','calculado','pagado','cancelado')
    ),
  total_gross      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_net        DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_deductions DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  paid_at          TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payroll_entries (
  id               SERIAL PRIMARY KEY,
  period_id        INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  base_salary      DECIMAL(12,2) NOT NULL,
  perceptions      DECIMAL(12,2) NOT NULL DEFAULT 0,
  deductions       DECIMAL(12,2) NOT NULL DEFAULT 0,
  isr              DECIMAL(12,2) NOT NULL DEFAULT 0,
  imss             DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_pay          DECIMAL(12,2) NOT NULL,
  notes            TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payroll_entries_period   ON payroll_entries(period_id);
CREATE INDEX idx_payroll_entries_employee ON payroll_entries(employee_id);

-- ─────────────────────────────────────────────────────────────
-- ATTACHMENTS (Files / S3)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS attachments (
  id                SERIAL PRIMARY KEY,
  original_filename VARCHAR(255) NOT NULL,
  s3_key            VARCHAR(500) NOT NULL UNIQUE,
  s3_bucket         VARCHAR(100),
  file_size         BIGINT,
  mime_type         VARCHAR(100),
  entity_type       VARCHAR(50),   -- project, task, quote, transaction, employee, etc.
  entity_id         INTEGER,
  is_public         BOOLEAN  NOT NULL DEFAULT FALSE,
  share_token       VARCHAR(128),
  share_expires_at  TIMESTAMP,
  uploaded_by       INTEGER NOT NULL REFERENCES users(id),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_attachments_entity       ON attachments(entity_type, entity_id);
CREATE INDEX idx_attachments_uploaded_by  ON attachments(uploaded_by);
CREATE INDEX idx_attachments_share_token  ON attachments(share_token);

-- Add FK to transactions
ALTER TABLE transactions
  ADD CONSTRAINT transactions_attachment_fk
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE SET NULL;

-- Add FK to employee_contracts
ALTER TABLE employee_contracts
  ADD CONSTRAINT contracts_attachment_fk
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────
-- AUDIT LOGS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(50)  NOT NULL,
  entity_type VARCHAR(50)  NOT NULL,
  entity_id   INTEGER,
  changes     JSONB,
  ip_address  INET,
  user_agent  TEXT,
  status_code INTEGER,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user_id     ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity      ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at  ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_action      ON audit_logs(action);

-- ─────────────────────────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(100) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  body        TEXT,
  data        JSONB,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  read_at     TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id, is_read, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- SCHEDULED REPORTS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_reports (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  report_type  VARCHAR(100) NOT NULL,
  params       JSONB,
  recipients   TEXT[],
  frequency    VARCHAR(50) NOT NULL,
    CONSTRAINT report_frequency_check CHECK (
      frequency IN ('diario','semanal','quincenal','mensual')
    ),
  next_run_at  TIMESTAMP,
  last_run_at  TIMESTAMP,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY (RLS)
-- ─────────────────────────────────────────────────────────────

-- Enable RLS on sensitive tables
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_entries     ENABLE ROW LEVEL SECURITY;

-- Users can see all users in same company; admin sees all
CREATE POLICY users_company_isolation ON users
  FOR SELECT USING (
    current_app_user_role() = 'admin'
    OR company_id = (SELECT company_id FROM users WHERE id = current_app_user_id())
    OR id = current_app_user_id()
  );

-- Projects visible to same company users or admin
CREATE POLICY projects_company_isolation ON projects
  FOR SELECT USING (
    current_app_user_role() = 'admin'
    OR company_id = (SELECT company_id FROM users WHERE id = current_app_user_id())
  );

CREATE POLICY projects_company_mutate ON projects
  FOR ALL USING (
    current_app_user_role() = 'admin'
    OR company_id = (SELECT company_id FROM users WHERE id = current_app_user_id())
  );

-- Tasks visible if assigned to user, created by user, or in accessible project
CREATE POLICY tasks_visibility ON tasks
  FOR SELECT USING (
    current_app_user_role() = 'admin'
    OR assigned_to = current_app_user_id()
    OR created_by = current_app_user_id()
    OR project_id IN (
      SELECT id FROM projects
      WHERE company_id = (SELECT company_id FROM users WHERE id = current_app_user_id())
    )
  );

CREATE POLICY tasks_mutate ON tasks
  FOR ALL USING (
    current_app_user_role() = 'admin'
    OR assigned_to = current_app_user_id()
    OR created_by = current_app_user_id()
    OR project_id IN (
      SELECT id FROM projects
      WHERE company_id = (SELECT company_id FROM users WHERE id = current_app_user_id())
    )
  );

-- Transactions visible within same company
CREATE POLICY transactions_company_isolation ON transactions
  FOR SELECT USING (
    current_app_user_role() IN ('admin','finance','manager')
    OR (
      current_app_user_role() IN ('project_manager','supervisor')
      AND company_id = (SELECT company_id FROM users WHERE id = current_app_user_id())
    )
  );

-- Employees visible within same company
CREATE POLICY employees_company_isolation ON employees
  FOR SELECT USING (
    current_app_user_role() = 'admin'
    OR company_id = (SELECT company_id FROM users WHERE id = current_app_user_id())
  );

-- Payroll only visible to admin, finance, hr
CREATE POLICY payroll_restricted ON payroll_periods
  FOR SELECT USING (
    current_app_user_role() IN ('admin','finance','hr')
  );

CREATE POLICY payroll_entries_restricted ON payroll_entries
  FOR SELECT USING (
    current_app_user_role() IN ('admin','finance','hr')
    OR employee_id IN (SELECT id FROM employees WHERE user_id = current_app_user_id())
  );
