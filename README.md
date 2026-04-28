# IncorERP — Backend API

> **Production-grade ERP backend** for Incored y Asociados and its 4 subsidiary companies.  
> Node.js 18 · Express 4 · PostgreSQL 15 · JWT · AWS S3 · GoDaddy SMTP

---

## Table of Contents

1. [Architecture](#architecture)
2. [Quick Start (Local)](#quick-start-local)
3. [Deploy to Render](#deploy-to-render)
4. [Environment Variables](#environment-variables)
5. [API Reference](#api-reference)
6. [Database Schema](#database-schema)
7. [Security Model](#security-model)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)

---

## Architecture

```
backend/
├── src/
│   ├── config/         ← DB pool, JWT helpers, env validation, email
│   ├── routes/         ← All Express route files (controllers inline)
│   ├── models/         ← Query builders per entity
│   ├── middleware/     ← Auth, RBAC, validation, rate-limit, audit
│   ├── utils/          ← Logger, encryption, PDF, Excel, emailer, helpers
│   ├── database/       ← schema.sql, seed.sql, migrations/
│   ├── app.js          ← Express app factory
│   └── server.js       ← Entry point
└── tests/              ← Jest test suites
```

### Companies managed
| ID | Name | Code | Country |
|----|------|------|---------|
| 1  | Incored y Asociados     | INC | Mexico |
| 2  | Zhada Construcciones    | ZHA | Mexico |
| 3  | Incored International   | INT | USA    |
| 4  | Mika Importaciones      | MKA | Global |

---

## Quick Start (Local)

### Prerequisites
- Node.js 18+
- PostgreSQL 15+
- (Optional) AWS account for S3 file storage

```bash
# 1. Clone and install
git clone <your-repo-url>
cd backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your local credentials

# 3. Create and seed database
createdb incored_erp_dev
psql incored_erp_dev < src/database/schema.sql
psql incored_erp_dev < src/database/seed.sql

# 4. Start dev server (with hot reload)
npm run dev

# 5. Verify
curl http://localhost:5000/health
curl http://localhost:5000/health/db
```

### Default admin credentials (change immediately!)
```
Email:    admin@incored.com.mx
Password: Admin123!
```

---

## Deploy to Render

### 1. Push to GitHub
```bash
git add .
git commit -m "Initial backend setup"
git push origin main
```

### 2. Create Render services

**PostgreSQL database:**
- Render Dashboard → New → PostgreSQL
- Note the `Internal Database URL`

**Web Service:**
- Render Dashboard → New → Web Service
- Connect your GitHub repo
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Environment:** Node
- **Plan:** Starter ($7/mo) or higher

### 3. Set environment variables on Render
Copy all variables from `.env.example` and fill in production values in  
Render Dashboard → Your Service → Environment.

### 4. Initialize the database on Render
After first deploy, open the Render shell:
```bash
psql $DATABASE_URL < src/database/schema.sql
psql $DATABASE_URL < src/database/seed.sql
```

Your API will be live at: `https://your-service.onrender.com`

---

## Environment Variables

See [`.env.example`](./.env.example) for the full list with descriptions.

**Critical variables you MUST set:**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Min 64 chars — generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `REFRESH_TOKEN_SECRET` | Same as above, different value |
| `ENCRYPTION_KEY` | 32-byte hex — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SMTP_*` | GoDaddy SMTP credentials |
| `AWS_*` | S3 file storage (optional for dev, required in prod) |

---

## API Reference

### Base URL
```
Production: https://api.incored.com.mx/api
Local:      http://localhost:5000/api
```

### Authentication
All protected endpoints require:
```
Authorization: Bearer <access_token>
```

### Authentication Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/signup` | Register user |
| POST | `/auth/login` | Login → returns JWT + refresh token |
| POST | `/auth/logout` | Logout (blacklists token) |
| POST | `/auth/refresh` | Rotate refresh token |
| POST | `/auth/request-password-reset` | Send reset email |
| POST | `/auth/reset-password` | Reset with token |
| POST | `/auth/enable-2fa` | Generate QR code for TOTP |
| POST | `/auth/confirm-2fa` | Confirm and activate 2FA |
| POST | `/auth/verify-2fa` | Verify TOTP on login |
| GET  | `/auth/me` | Get current user |

### Users

| Method | Path | Role Required |
|--------|------|---------------|
| GET | `/users` | any |
| GET | `/users/:id` | any |
| POST | `/users` | admin, manager |
| PUT | `/users/:id` | self or admin |
| DELETE | `/users/:id` | admin |
| GET | `/users/:id/permissions` | any |
| PUT | `/users/:id/role` | admin |
| PUT | `/users/:id/change-password` | self or admin |
| GET | `/users/meta/roles` | any |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/projects` | List (filterable by status, client, PM) |
| GET | `/projects/:id` | Detail |
| POST | `/projects` | Create |
| PUT | `/projects/:id` | Update |
| DELETE | `/projects/:id` | Cancel |
| PUT | `/projects/:id/status` | Change status |
| GET | `/projects/:id/finances` | P&L summary |
| GET | `/projects/:id/kanban` | Tasks by column |
| GET | `/projects/:id/gantt` | Tasks for Gantt |
| GET | `/projects/:id/team` | Team members |
| POST | `/projects/:id/team` | Add team member |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tasks` | List (filterable) |
| GET | `/tasks/:id` | Detail |
| POST | `/tasks` | Create |
| PUT | `/tasks/:id` | Update |
| DELETE | `/tasks/:id` | Cancel |
| PUT | `/tasks/:id/status` | Change status |
| PUT | `/tasks/:id/assignee` | Reassign |
| GET/POST | `/tasks/:id/comments` | Comments |
| GET/POST | `/tasks/:id/time-entries` | Time tracking |

### CRM

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/clients` | Client list / create |
| GET/PUT | `/clients/:id` | Detail / update |
| GET/POST | `/suppliers` | Supplier list / create |
| GET/POST | `/leads` | Lead pipeline |
| PUT | `/leads/:id/stage` | Move in pipeline |
| GET/POST | `/quotes` | Quote list / create |
| GET | `/quotes/:id` | Detail with lines |
| PUT | `/quotes/:id/status` | Change status |
| POST | `/quotes/:id/send-email` | Email PDF to client |
| GET | `/quotes/:id/pdf` | Download PDF |

### Transactions (Finance)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/transactions` | List with summary totals |
| GET | `/transactions/:id` | Detail |
| POST | `/transactions` | Register income/expense |
| PUT | `/transactions/:id` | Update |
| GET | `/transactions/reports/pnl` | P&L by category |
| GET | `/transactions/reports/cash-flow` | Monthly cash flow |
| GET | `/transactions/meta/categories` | Category list |

### Inventory

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/inventory/materials` | Material list / create |
| GET/PUT | `/inventory/materials/:id` | Detail / update |
| POST | `/inventory/materials/:id/movement` | Stock in/out/transfer |
| GET/POST | `/inventory/tools` | Tools |
| PUT | `/inventory/tools/:id/location` | Assign to project |
| GET/POST | `/inventory/vehicles` | Vehicles |
| PUT | `/inventory/vehicles/:id` | Update status |
| GET | `/inventory/report` | Report (JSON or ?format=excel) |

### Employees & HR

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/employees` | Employee list / create |
| GET/PUT | `/employees/:id` | Detail / update |
| GET/POST | `/employees/:id/contracts` | Contracts |
| GET | `/employees/vacations` | Vacation requests |
| POST | `/employees/vacations` | Request vacation |
| PUT | `/employees/vacations/:id` | Approve/reject |
| GET | `/employees/payroll` | Payroll periods |
| POST | `/employees/payroll/generate` | Generate payroll |

### Reports & Dashboards

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboards/executive` | CEO KPI dashboard |
| GET | `/dashboards/operations` | Ops dashboard |
| GET | `/dashboards/finance` | Finance dashboard |
| GET | `/dashboards/hr` | HR dashboard |
| GET | `/reports/projects` | Projects report (?format=excel) |
| GET | `/reports/tasks` | Tasks report |
| GET | `/reports/timesheet` | Timesheet (?format=excel) |
| GET | `/reports/income-statement` | P&L by month/category |
| GET | `/reports/audit` | Audit log (admin only) |

### Files

| Method | Path | Description |
|--------|------|-------------|
| POST | `/files/upload` | Upload file to S3 |
| GET | `/files/:id/download` | Get presigned download URL |
| DELETE | `/files/:id` | Delete file |
| POST | `/files/:id/share` | Generate shareable link |
| GET | `/files/shared/:token` | Public shared file access |

---

## Database Schema

See [`src/database/schema.sql`](./src/database/schema.sql) for the full schema.

### Key tables
| Table | Description |
|-------|-------------|
| `companies` | 4 group companies |
| `users` | System users with RBAC |
| `refresh_tokens` | Rotating JWT refresh tokens |
| `token_blacklist` | Revoked access tokens |
| `password_reset_tokens` | One-time reset links |
| `clients` | Clients AND suppliers |
| `leads` | CRM pipeline |
| `projects` | Projects with budget tracking |
| `project_members` | Team assignments |
| `tasks` | Tasks with Kanban status |
| `task_comments` | Comment threads |
| `time_entries` | Time tracking per task |
| `quotes` | Quotations with line items |
| `quote_lines` | Quote line items |
| `transactions` | Income & expenses |
| `inventory_materials` | Materials with stock |
| `inventory_movements` | Stock in/out log |
| `inventory_tools` | Equipment tracking |
| `inventory_vehicles` | Fleet management |
| `employees` | HR records |
| `employee_contracts` | Contract history |
| `vacation_requests` | Leave management |
| `payroll_periods` | Payroll runs |
| `payroll_entries` | Per-employee payroll |
| `attachments` | S3 file references |
| `audit_logs` | Full action audit trail |
| `notifications` | In-app notifications |

---

## Security Model

### Authentication
- **JWT** access tokens (24h expiry, RS256 signing)
- **Rotating refresh tokens** stored in DB (7-day expiry)
- **Token blacklist** for logout before expiry
- **2FA** via TOTP (Google Authenticator compatible)
- **Bcrypt** password hashing (salt rounds: 10)
- **AES-256-GCM** encryption for sensitive fields (2FA secrets)

### Authorization (RBAC)
| Role | Level | Key Permissions |
|------|-------|-----------------|
| `admin` | 99 | Full access to all modules and all companies |
| `manager` | 4 | Full access within own company |
| `finance` | 4 | Financial module + read-only elsewhere |
| `hr` | 4 | HR module + read-only elsewhere |
| `project_manager` | 3 | Projects, tasks, CRM, inventory |
| `supervisor` | 2 | Tasks, inventory updates |
| `operative` | 0 | Own tasks only |
| `technician` | 1 | Own tasks + file uploads |

### Row-Level Security (PostgreSQL RLS)
RLS policies enforce company isolation at the database level:
- Users can only query data from their own company
- Admins bypass RLS
- Sensitive tables: `users`, `projects`, `tasks`, `transactions`, `employees`, `payroll_*`

### Rate Limiting
| Endpoint | Limit |
|----------|-------|
| General API | 100 req / 15 min |
| Login | 5 attempts / 15 min per IP+email |
| Password reset | 3 req / hour |
| File upload | 20 uploads / 15 min |
| Report export | 10 exports / hour |

---

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

Test files live in `tests/`. The test suite uses:
- **Jest** as test runner
- **Supertest** for HTTP integration tests
- Test database isolated from production

---

## Troubleshooting

### Database connection fails
```bash
# Check DATABASE_URL is correct
psql $DATABASE_URL -c "SELECT version();"

# Check SSL setting
# Render requires SSL: set DATABASE_SSL=true in env
```

### JWT errors on every request
```bash
# Ensure JWT_SECRET is at least 32 characters and identical across deploys
node -e "console.log(process.env.JWT_SECRET?.length)"
```

### Emails not sending
```bash
# GoDaddy SMTP settings:
# Host: smtpout.secureserver.net
# Port: 465 (SSL) or 587 (TLS)
# Auth: your full email address + password
```

### 2FA codes rejected
- Ensure server clock is in sync (NTP)
- TWO_FA_WINDOW=1 allows ±30 second tolerance
- Increase to TWO_FA_WINDOW=2 if still failing

### S3 upload fails
```bash
# Verify bucket policy allows PutObject from your IAM user
# Ensure AWS_REGION matches the bucket's actual region
```

---

## License

Proprietary — Incored y Asociados © 2025. All rights reserved.
