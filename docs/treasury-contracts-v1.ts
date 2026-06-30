/**
 * TREASURY PLATFORM CONTRACT LAYER v1.0 — FROZEN
 * =================================================
 * Sprint P4.1A — Architecture Only
 *
 * Treasury Platform = Financial Operating System for the enterprise.
 * Consumed by: Executive Intelligence, Portfolio, Forecast, AI Copilot,
 *              Budget, Scenario Planning, Treasury Workspace.
 *
 * ARCHITECTURE:
 *   Financial Events → Financial Platform → Treasury Platform
 *     → Forecast Platform → AI Platform
 *
 * RULE 7: Treasury NEVER calculates accounting balances independently.
 * RULE 8: Forecast values are projections; actuals come from Financial Platform.
 */

// ═══════════════════════════════════════════════════════════════
// REUSED (from Executive + Portfolio Contract Layers) — zero duplication
// ═══════════════════════════════════════════════════════════════
export {
  SchemaVersion, RiskLevel, TrendDirection, Severity,
  DataQuality, DataFreshness, PeriodType, BaseMetadataDTO
} from './sprint-6-4a1-contracts-v1';

// ═══════════════════════════════════════════════════════════════
// NEW ENUMS — TREASURY-SPECIFIC
// ═══════════════════════════════════════════════════════════════

export enum BankAccountStatus {
  ACTIVE      = 'ACTIVE',
  INACTIVE    = 'INACTIVE',
  FROZEN      = 'FROZEN',
  CLOSED      = 'CLOSED',
  PENDING     = 'PENDING'
}

export enum CurrencyCode {
  MXN = 'MXN', USD = 'USD', EUR = 'EUR', CAD = 'CAD', GBP = 'GBP'
  // Future: extend without breaking existing contracts
}

export enum ForecastHorizon {
  DAYS_7    = 'DAYS_7',
  DAYS_30   = 'DAYS_30',
  DAYS_90   = 'DAYS_90',
  DAYS_365  = 'DAYS_365'
}

export enum ForecastScenario {
  BASE        = 'BASE',
  OPTIMISTIC  = 'OPTIMISTIC',
  PESSIMISTIC = 'PESSIMISTIC',
  STRESS_TEST = 'STRESS_TEST'   // reserved
}

export enum LiquidityHealth {
  EXCELLENT  = 'EXCELLENT',  // liquidity ratio > 2.0
  HEALTHY    = 'HEALTHY',    // 1.5 - 2.0
  ADEQUATE   = 'ADEQUATE',   // 1.0 - 1.5
  TIGHT      = 'TIGHT',      // 0.5 - 1.0
  CRITICAL   = 'CRITICAL'    // < 0.5
}

export enum PaymentPriority {
  CRITICAL  = 'CRITICAL',  // payroll, taxes, contractual penalties
  HIGH      = 'HIGH',
  MEDIUM    = 'MEDIUM',
  LOW       = 'LOW'
}

export enum PaymentMethod {
  WIRE        = 'WIRE',
  ACH         = 'ACH',
  CHECK       = 'CHECK',
  CARD        = 'CARD',
  CASH        = 'CASH'
}

export enum PaymentStatus {
  SCHEDULED = 'SCHEDULED',
  OVERDUE   = 'OVERDUE',
  PROCESSING= 'PROCESSING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED'
}

export enum TreasuryRiskDimension {
  CONCENTRATION_BANK     = 'CONCENTRATION_BANK',
  CONCENTRATION_CUSTOMER = 'CONCENTRATION_CUSTOMER',
  CONCENTRATION_SUPPLIER = 'CONCENTRATION_SUPPLIER',
  FX_EXPOSURE            = 'FX_EXPOSURE',
  LIQUIDITY              = 'LIQUIDITY',
  COUNTERPARTY           = 'COUNTERPARTY'
}

export enum TreasuryHealthDimension {
  LIQUIDITY  = 'LIQUIDITY',
  CASH       = 'CASH',
  RISK       = 'RISK',
  COLLECTIONS= 'COLLECTIONS',
  PAYMENTS   = 'PAYMENTS'
}

// ═══════════════════════════════════════════════════════════════
// DTO 1 — BankAccountDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * IAS-052: Cash Position Standard
 * Bank account snapshot. Balances sourced from Financial Platform (RULE 7).
 */
export interface BankAccountDTO {
  meta:                   BaseMetadataDTO;
  id:                     number;
  company_id:             number;
  bank_name:              string;
  bank_code:              string;             // SWIFT/ABA/CLABE prefix
  account_number_masked:  string;             // e.g. '****1234'
  currency:               CurrencyCode;
  country:                string;             // ISO 3166-1 alpha-2
  balance:                number;             // native currency
  available_balance:      number;
  restricted_balance:     number;
  balance_base:           number;             // RULE 5: amount_base
  status:                 BankAccountStatus;
  last_reconciled_at:     string | null;
  data_quality:           DataQuality;
  metadata: {
    account_type?: 'CHECKING'|'SAVINGS'|'CREDIT_LINE' | null;
    is_intercompany?: boolean | null;
  };
}

// ═══════════════════════════════════════════════════════════════
// DTO 2 — CashPositionDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

export interface CurrencyBreakdownDTO {
  currency:      CurrencyCode;
  amount:        number;          // native currency
  amount_base:   number;          // RULE 5
  percentage:    number;          // 0-100 of total cash
  account_count: number;
}

/**
 * IAS-052: Cash Position Standard
 * Endpoint: GET /api/treasury/cash-position
 */
export interface CashPositionDTO {
  meta:               BaseMetadataDTO;
  company_id:         number;
  fiscal_period:      string;
  current_cash:        number;    // amount_base
  available_cash:      number;    // amount_base — unrestricted
  restricted_cash:      number;   // amount_base — escrow, collateral
  net_cash:            number;    // current_cash - liabilities due
  intercompany_cash:    number;   // amount_base — internal transfers pending
  currency_breakdown:  CurrencyBreakdownDTO[];  // RULE 1: []
  data_quality:        DataQuality;
}

// ═══════════════════════════════════════════════════════════════
// DTO 3 — CashForecastDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * RULE 8: Forecast values are projections. Never confused with actuals.
 * Endpoint: GET /api/treasury/forecast
 */
export interface CashForecastDTO {
  meta:               BaseMetadataDTO;
  company_id:         number;
  horizon:            ForecastHorizon;
  scenario:           ForecastScenario;
  as_of_date:         string;
  expected_inflows:   number;     // amount_base
  expected_outflows:  number;     // amount_base
  net_cash_forecast:  number;     // amount_base
  ending_cash_balance: number;    // current_cash + net_cash_forecast
  confidence:         number;     // 0.0–1.0
  data_quality:       DataQuality;
  is_projection:      true;       // RULE 8: always true, never confused with actual
}

// ═══════════════════════════════════════════════════════════════
// DTO 4 — LiquidityDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * IAS-053: Liquidity Standard
 * Endpoint: GET /api/treasury/liquidity
 */
export interface LiquidityDTO {
  meta:               BaseMetadataDTO;
  company_id:         number;
  fiscal_period:      string;
  liquidity_score:    number;        // 0–100
  liquidity_ratio:    number;        // current assets / current liabilities
  working_capital:    number;        // amount_base
  operating_cash:     number;        // amount_base
  burn_rate:          number | null; // amount_base/month, null if positive cash flow
  runway_days:        number | null; // days until cash depleted at burn_rate, null if N/A
  health:             LiquidityHealth;
  trend:              TrendDirection;
  data_quality:       DataQuality;
}

// ═══════════════════════════════════════════════════════════════
// DTO 5 — TreasuryRiskDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

export interface TreasuryRiskDriverDTO {
  dimension:        TreasuryRiskDimension;
  weight:           number;          // 0.0–1.0
  score:            number;          // 0–100 (100 = lowest risk)
  signal:           string;
  recommendation:   string;
  affected_entities: number[];       // bank_account_ids, customer_ids, etc.
  data_quality:     DataQuality;
}

/**
 * IAS-054: Treasury Risk Standard
 * Endpoint: GET /api/treasury/risk
 */
export interface TreasuryRiskDTO {
  meta:             BaseMetadataDTO;
  company_id:       number;
  fiscal_period:    string;
  score:            number;            // 0–100 composite
  risk_level:       RiskLevel;
  drivers:          TreasuryRiskDriverDTO[];  // RULE 1: []
  recommendations:  string[];                  // RULE 1: []
  ai_enhanced:      boolean;
}

// ═══════════════════════════════════════════════════════════════
// DTO 6 — PaymentCalendarDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

export interface ScheduledPaymentDTO {
  id:               number;
  vendor_name:      string;
  amount:           number;         // amount_base
  due_date:         string;
  priority:         PaymentPriority;
  method:           PaymentMethod;
  status:           PaymentStatus;
  cash_impact:      number;         // amount_base, negative for outflow
}

/**
 * Endpoint: GET /api/treasury/payments
 */
export interface PaymentCalendarDTO {
  meta:               BaseMetadataDTO;
  company_id:         number;
  fiscal_period:      string;
  upcoming_payments:  ScheduledPaymentDTO[];  // RULE 1: []
  overdue_payments:   ScheduledPaymentDTO[];  // RULE 1: []
  scheduled_payments: ScheduledPaymentDTO[];  // RULE 1: []
  total_upcoming:     number;       // amount_base
  total_overdue:      number;       // amount_base
  data_quality:       DataQuality;
}

// ═══════════════════════════════════════════════════════════════
// DTO 7 — CollectionCalendarDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

export interface ExpectedCollectionDTO {
  id:                     number;
  customer_name:          string;
  amount:                 number;       // amount_base
  due_date:               string;
  collection_probability: number;       // 0.0–1.0
  customer_priority:      PaymentPriority;
  expected_cash:          number;       // amount × probability
}

/**
 * Endpoint: GET /api/treasury/collections
 */
export interface CollectionCalendarDTO {
  meta:                   BaseMetadataDTO;
  company_id:             number;
  fiscal_period:          string;
  expected_collections:   ExpectedCollectionDTO[];  // RULE 1: []
  overdue_receivables:    ExpectedCollectionDTO[];  // RULE 1: []
  total_expected:         number;       // amount_base
  total_overdue:          number;       // amount_base
  data_quality:           DataQuality;
}

// ═══════════════════════════════════════════════════════════════
// DTO 8 — FXExposureDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

export interface FXExposureLineDTO {
  currency:       CurrencyCode;
  exposure:       number;          // native currency
  exposure_base:  number;          // RULE 5: amount_base
  hedged:         number;          // amount_base
  unhedged:       number;          // amount_base
  exposure_pct:   number;          // 0-100 of total FX exposure
}

/**
 * Endpoint: GET /api/treasury/fx-exposure
 */
export interface FXExposureDTO {
  meta:             BaseMetadataDTO;
  company_id:       number;
  fiscal_period:    string;
  base_currency:    CurrencyCode;
  total_exposure_base: number;
  lines:            FXExposureLineDTO[];  // RULE 1: []
  data_quality:     DataQuality;
}

// ═══════════════════════════════════════════════════════════════
// DTO 9 — WorkingCapitalDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * Endpoint: GET /api/treasury/working-capital
 */
export interface WorkingCapitalDTO {
  meta:                   BaseMetadataDTO;
  company_id:             number;
  fiscal_period:          string;
  accounts_receivable:    number;     // amount_base
  accounts_payable:       number;     // amount_base
  inventory:              number;     // amount_base (reserved, 0 if N/A)
  cash:                   number;     // amount_base
  working_capital:        number;     // AR + Inventory + Cash - AP
  cash_conversion_cycle:  number | null;  // days, null if insufficient data
  data_quality:           DataQuality;
}

// ═══════════════════════════════════════════════════════════════
// DTO 10 — TreasuryHealthDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

export interface TreasuryHealthDimensionDTO {
  dimension:  TreasuryHealthDimension;
  score:      number;          // 0–100
  status:     LiquidityHealth | RiskLevel;
  signal:     string;
}

/**
 * Endpoint: GET /api/treasury/health
 */
export interface TreasuryHealthDTO {
  meta:               BaseMetadataDTO;
  company_id:         number;
  fiscal_period:      string;
  overall_health:     LiquidityHealth;
  overall_score:      number;        // 0–100
  dimensions:         TreasuryHealthDimensionDTO[];  // RULE 1: []
  // Reserved extension points (RULE 3: optional, additive)
  forecast_accuracy?: number | null;   // reserved — Sprint P4.2
  ai_confidence?:     number | null;   // reserved — Sprint P6
  data_quality:       DataQuality;
}

// ═══════════════════════════════════════════════════════════════
// DTO 11 — TreasuryDashboardDTO  (PUBLIC, STABLE)
// Primary endpoint for Treasury Workspace
// ═══════════════════════════════════════════════════════════════

/**
 * Endpoint: GET /api/treasury/dashboard
 * Single aggregate call — replaces multiple widget requests.
 */
export interface TreasuryDashboardDTO {
  meta:                  BaseMetadataDTO;
  company_id:            number;
  fiscal_period:         string;

  cash_position:         CashPositionDTO;
  forecast_summary:      CashForecastDTO;
  liquidity:             LiquidityDTO;
  bank_accounts:         BankAccountDTO[];           // RULE 1: []
  upcoming_payments:     ScheduledPaymentDTO[];       // RULE 1: []
  upcoming_collections:  ExpectedCollectionDTO[];     // RULE 1: []
  fx_exposure:           FXExposureDTO;
  working_capital:       WorkingCapitalDTO;
  treasury_health:       TreasuryHealthDTO;

  dashboard_meta: {
    bank_account_count: number;
    event_count:        number;
    data_as_of:         string;
    collections_empty:  string[];     // RULE 1 enforcement tracker
  };
}

// ═══════════════════════════════════════════════════════════════
// DTO 12 — TreasuryWorkspaceDTO  (RESERVED — composes Dashboard)
// ADR-105: Treasury Workspace Composition
// ═══════════════════════════════════════════════════════════════

/**
 * Composes TreasuryDashboardDTO. Never replaces it (Enterprise Rule
 * established in Portfolio P3.1A: Workspace DTOs compose Dashboard DTOs).
 */
export interface TreasuryWorkspaceDTO {
  meta:                BaseMetadataDTO;
  company_id:          number;
  dashboard:           TreasuryDashboardDTO;    // unchanged v1.0 contract
  risk:                TreasuryRiskDTO;
  payment_calendar:    PaymentCalendarDTO;
  collection_calendar: CollectionCalendarDTO;
  workspace_preferences?: {                      // optional, ADR-034 pattern
    default_view?:      string | null;
    pinned_widgets?:    string[] | null;
    layout_version?:    string | null;
  } | null;
}

// ═══════════════════════════════════════════════════════════════
// API CONTRACT MATRIX
// ═══════════════════════════════════════════════════════════════

/**
 * ENDPOINT CATALOG (Sprint P4.1B — Treasury Engine):
 *
 * GET /api/treasury/dashboard         → TreasuryDashboardDTO
 * GET /api/treasury/cash-position     → CashPositionDTO
 * GET /api/treasury/forecast          → CashForecastDTO
 * GET /api/treasury/liquidity         → LiquidityDTO
 * GET /api/treasury/risk              → TreasuryRiskDTO
 * GET /api/treasury/bank-accounts     → BankAccountDTO[]
 * GET /api/treasury/payments          → PaymentCalendarDTO
 * GET /api/treasury/collections       → CollectionCalendarDTO
 * GET /api/treasury/fx-exposure       → FXExposureDTO
 * GET /api/treasury/working-capital   → WorkingCapitalDTO
 * GET /api/treasury/health            → TreasuryHealthDTO
 */

// ═══════════════════════════════════════════════════════════════
// DEPENDENCY MATRIX
// ═══════════════════════════════════════════════════════════════

/**
 * CONSUMERS:
 *   TreasuryDashboardDTO  → Treasury Workspace, CEO/CFO Dashboard, Mobile
 *   CashPositionDTO       → Executive Dashboard widget, Power BI
 *   CashForecastDTO       → Forecast Platform (Sprint P5), AI Copilot
 *   LiquidityDTO          → Executive Risk, Board Reports
 *   TreasuryRiskDTO       → Risk Reports, AI Platform
 *   PaymentCalendarDTO    → Approval Workflows, AP automation
 *   CollectionCalendarDTO → AR automation, Customer Risk
 *   FXExposureDTO         → International ops (Incored International, company_id=3)
 *   WorkingCapitalDTO     → Budget Platform (reserved), Forecast
 *   TreasuryHealthDTO     → Executive Dashboard, Board Reports
 *
 * SOURCES (Treasury reads from):
 *   Financial Platform     → financial facts (RULE 7 — never recalculated)
 *   Executive Intelligence → risk scoring patterns (reused methodology)
 *   bank_accounts table    → account metadata
 */

// ═══════════════════════════════════════════════════════════════
// FUTURE RESERVED EXTENSIONS (not implemented)
// ═══════════════════════════════════════════════════════════════

/**
 * SPRINT P4.2+ RESERVED:
 *   ScenarioAnalysisDTO      → what-if cash modeling
 *   BudgetComparisonDTO      → actual vs budget treasury variance
 *   CashSimulationDTO        → Monte Carlo cash projections
 *   TreasuryAIInsightDTO     → AI-generated treasury insights
 *   TreasuryRecommendationDTO → AI recommendations (rule-based v1.0 first)
 *   TreasuryAlertDTO         → real-time treasury alerts
 *   TreasuryApprovalDTO      → payment approval workflow
 *   TreasuryWorkflowDTO      → multi-step treasury operations
 *   BankReconciliationDTO    → automated bank reconciliation
 *   FXHedgeDTO               → hedging instrument tracking
 *
 * All additive (optional nullable fields). Zero breaking changes to v1.0.
 */
