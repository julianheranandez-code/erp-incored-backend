/**
 * PORTFOLIO INTELLIGENCE CONTRACT LAYER v1.0 — FROZEN
 * =====================================================
 * Sprint P3.1 — Architecture Only
 *
 * STATUS: FROZEN after architectural review.
 * Breaking changes require v2.0 + new endpoint path.
 *
 * PLATFORM HIERARCHY:
 *   Financial Platform
 *     ↓ financial facts (amount_base, event counts)
 *   Executive Intelligence Platform
 *     ↓ business interpretation (insights, risk, health)
 *   Portfolio Intelligence Platform
 *     ↓ portfolio aggregation + project comparison
 *   Portfolio API → CEO Dashboard, AI, Power BI
 *
 * RULES (inherited from Enterprise Architecture):
 *   RULE 1: Collections NEVER return null. Always [].
 *   RULE 2: DTOs are immutable. v1.0 fields never change.
 *   RULE 3: New fields must be optional (nullable).
 *   RULE 4: Breaking changes → v2.0 at new endpoint path.
 *   RULE 5: BaseMetadataDTO composed, never duplicated.
 *   RULE 6: All financial amounts in amount_base (base currency).
 *   RULE 7: Portfolio Intelligence never accesses financial_events directly.
 */

// ═══════════════════════════════════════════════════════════════
// REUSED ENUMS (from Executive Intelligence Contract Layer v1.0)
// ═══════════════════════════════════════════════════════════════

// Re-exported for Portfolio consumers — no duplication
export {
  SchemaVersion,
  DataQuality,
  DataFreshness,
  TrendDirection,
  RiskLevel,
  Severity,
  PeriodType,
  BaseMetadataDTO
} from './sprint-6-4a1-contracts-v1';

// ═══════════════════════════════════════════════════════════════
// NEW ENUMS — PORTFOLIO-SPECIFIC
// ═══════════════════════════════════════════════════════════════

export enum PortfolioHealth {
  EXCELLENT   = 'EXCELLENT',  // margin > 30%, positive cash
  GOOD        = 'GOOD',       // margin 15–30%
  WARNING     = 'WARNING',    // margin 0–15% or cash concern
  CRITICAL    = 'CRITICAL',   // negative margin
  INACTIVE    = 'INACTIVE',   // no financial events
  NO_DATA     = 'NO_DATA'     // insufficient data
}

export enum PortfolioRiskLevel {
  CRITICAL    = 'CRITICAL',
  HIGH        = 'HIGH',
  MEDIUM      = 'MEDIUM',
  LOW         = 'LOW',
  HEALTHY     = 'HEALTHY'
}

export enum PortfolioStatus {
  ACTIVE      = 'ACTIVE',
  COMPLETED   = 'COMPLETED',
  ON_HOLD     = 'ON_HOLD',
  CANCELLED   = 'CANCELLED',
  PIPELINE    = 'PIPELINE'   // not yet started
}

export enum RankingMetric {
  REVENUE           = 'REVENUE',
  GROSS_PROFIT      = 'GROSS_PROFIT',
  MARGIN_PCT        = 'MARGIN_PCT',
  CASH_CONSUMPTION  = 'CASH_CONSUMPTION',
  LIABILITY         = 'LIABILITY',
  COMMITMENT        = 'COMMITMENT',
  HEALTH_SCORE      = 'HEALTH_SCORE',
  RISK_SCORE        = 'RISK_SCORE'
}

export enum ProjectPriority {
  CRITICAL    = 'CRITICAL',  // needs immediate executive attention
  HIGH        = 'HIGH',
  MEDIUM      = 'MEDIUM',
  LOW         = 'LOW',
  MONITOR     = 'MONITOR'    // healthy, watch only
}

export enum AllocationType {
  BY_CLIENT       = 'BY_CLIENT',
  BY_COMPANY      = 'BY_COMPANY',
  BY_PROJECT_TYPE = 'BY_PROJECT_TYPE',
  BY_REGION       = 'BY_REGION',      // future
  BY_TECHNOLOGY   = 'BY_TECHNOLOGY',  // future
  BY_STATUS        = 'BY_STATUS',
  BY_BUSINESS_UNIT = 'BY_BUSINESS_UNIT'  // CHANGE 2: future multi-BU support
}

export enum PortfolioRiskDimension {
  REVENUE_CONCENTRATION = 'REVENUE_CONCENTRATION',
  CASH_EXPOSURE         = 'CASH_EXPOSURE',
  LIABILITY_EXPOSURE    = 'LIABILITY_EXPOSURE',
  COMMITMENT_EXPOSURE   = 'COMMITMENT_EXPOSURE',
  PROJECT_HEALTH        = 'PROJECT_HEALTH',
  MARGIN_STABILITY      = 'MARGIN_STABILITY',
  CLIENT_DEPENDENCY     = 'CLIENT_DEPENDENCY'   // future Sprint P3.4
}

// ═══════════════════════════════════════════════════════════════
// DTO 1 — PortfolioProjectDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * Single project within the portfolio.
 * Financial facts sourced from Financial Platform (never re-calculated).
 * Intelligence sourced from Executive Intelligence Platform.
 * Endpoint: GET /api/portfolio/projects/:projectId
 */
export interface PortfolioProjectDTO {
  meta:               BaseMetadataDTO;       // RULE 5

  // Identity
  project_id:         number;
  project_code:       string;                // e.g. 'FTTH-MTY-001'
  project_name:       string;
  company_id:         number;
  client_id:          number | null;
  status:             PortfolioStatus;
  fiscal_period:      string;               // 'YYYY-MM'

  // Financial facts (amount_base — base currency only, RULE 6)
  revenue:            number;
  operating_expenses: number;
  gross_profit:       number;
  operating_income:   number;
  margin_pct:         number | null;        // null if revenue=0
  liabilities:        number;               // net outstanding payables
  commitments:        number;               // approved IPO commitments
  cash_position:      number;               // net_cash (inflows - outflows)

  // Intelligence (from Executive Intelligence Engine)
  health_score:       number;               // 0–100
  health_level:       PortfolioHealth;
  health_trend:       TrendDirection;       // vs prior period
  executive_priority: ProjectPriority;      // computed from health + risk
  risk_score:         number;               // 0–100 (lower = more risk)
  data_quality:       DataQuality;

  // Extension points
  metadata: {
    event_count:      number;               // financial_events supporting this
    last_event_at:    string | null;        // most recent financial event
    tags?:            string[] | null;      // future: project taxonomy
    region?:          string | null;        // future: regional analysis
    technology?:      string | null;        // future: FTTH, CCTV, etc.
  };
}

/*
EXAMPLE:
{
  "meta": { "schema_version": "v1.0", "engine_version": "P3.2-v1.0", ... },
  "project_id": 7,
  "project_code": "FTTH-MTY-001",
  "project_name": "FTTH Monterrey Expansion",
  "company_id": 1,
  "client_id": 18,
  "status": "ACTIVE",
  "fiscal_period": "2026-06",
  "revenue": 900000,
  "operating_expenses": 500000,
  "gross_profit": 400000,
  "operating_income": 400000,
  "margin_pct": 44.4,
  "liabilities": 500000,
  "commitments": 200000,
  "cash_position": -800000,
  "health_score": 78,
  "health_level": "GOOD",
  "health_trend": "FLAT",
  "executive_priority": "MEDIUM",
  "risk_score": 62,
  "data_quality": "HIGH",
  "metadata": { "event_count": 8, "last_event_at": "2026-06-10T..." }
}
*/

// ═══════════════════════════════════════════════════════════════
// DTO 2 — PortfolioSummaryDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * Aggregate view of the entire project portfolio.
 * Endpoint: GET /api/portfolio/summary
 */
export interface PortfolioSummaryDTO {
  meta:                    BaseMetadataDTO;
  company_id:              number;
  fiscal_period:           string;

  // Counts
  total_projects:          number;
  active_projects:         number;
  completed_projects:      number;
  projects_at_risk:        number;          // health_level IN [WARNING, CRITICAL]
  projects_needing_attention: number;       // executive_priority IN [HIGH, CRITICAL]

  // Aggregated financials (amount_base)
  total_revenue:           number;
  total_operating_expenses:number;
  total_gross_profit:      number;
  total_operating_income:  number;
  total_cash_position:     number;          // sum of all project net_cash
  total_liabilities:       number;
  total_commitments:       number;

  // Portfolio-level KPIs
  average_margin:          number | null;   // weighted by revenue
  best_margin:             number | null;   // top project margin
  worst_margin:            number | null;   // bottom project margin

  // Portfolio health
  portfolio_health:        PortfolioHealth;
  portfolio_health_trend:  TrendDirection;
  portfolio_risk:          PortfolioRiskLevel;

  // Distribution
  health_distribution: {
    EXCELLENT: number;
    GOOD:      number;
    WARNING:   number;
    CRITICAL:  number;
    NO_DATA:   number;
  };

  executive_summary:       string;          // human-readable narrative
  data_quality:            DataQuality;
}

/*
EXAMPLE:
{
  "meta": { "schema_version": "v1.0", ... },
  "company_id": 1,
  "fiscal_period": "2026-06",
  "total_projects": 6,
  "active_projects": 4,
  "completed_projects": 0,
  "projects_at_risk": 1,
  "projects_needing_attention": 1,
  "total_revenue": 1916000,
  "total_operating_expenses": 1300000,
  "total_gross_profit": 616000,
  "total_operating_income": 616000,
  "total_cash_position": -800000,
  "total_liabilities": 500000,
  "total_commitments": 250000,
  "average_margin": 32.15,
  "best_margin": 44.4,
  "worst_margin": 0,
  "portfolio_health": "GOOD",
  "portfolio_health_trend": "FLAT",
  "portfolio_risk": "MEDIUM",
  "health_distribution": { "EXCELLENT":0, "GOOD":3, "WARNING":1, "CRITICAL":0, "NO_DATA":2 },
  "executive_summary": "Portfolio performing at 32% margin. Cash position needs attention.",
  "data_quality": "HIGH"
}
*/

// ═══════════════════════════════════════════════════════════════
// DTO 3 — PortfolioRankingDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * Ranked project within a specific metric.
 * Endpoint: GET /api/portfolio/rankings
 */
export interface PortfolioRankingDTO {
  meta:                BaseMetadataDTO;
  rank:                number;              // 1 = top
  metric:              RankingMetric;
  metric_label:        string;              // "Gross Margin %"
  project:             PortfolioProjectDTO; // full project embedded
  value:               number;
  formatted_value:     string;
  delta_prior_period:  number | null;       // change vs prior period
  trend_direction:     TrendDirection | null;
  data_quality:        DataQuality;
}

// Rankings collection (returned by GET /api/portfolio/rankings)
export interface PortfolioRankingsDTO {
  meta:                   BaseMetadataDTO;
  top_by_revenue:         PortfolioRankingDTO[];    // RULE 1: []
  top_by_margin:          PortfolioRankingDTO[];    // RULE 1: []
  bottom_by_margin:       PortfolioRankingDTO[];    // RULE 1: []
  highest_cash_consumption: PortfolioRankingDTO[];  // RULE 1: []
  highest_liability:      PortfolioRankingDTO[];    // RULE 1: []
  highest_commitment:     PortfolioRankingDTO[];    // RULE 1: []
}

// ═══════════════════════════════════════════════════════════════
// DTO 4 — PortfolioRiskDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

export interface PortfolioRiskDriverDTO {
  dimension:      PortfolioRiskDimension;
  weight:         number;               // 0.0–1.0
  score:          number;               // 0–100 (100 = lowest risk)
  signal:         string;               // human-readable
  recommendation: string;
  affected_projects: number[];          // project_ids contributing to this risk
  data_quality:   DataQuality;
}

/**
 * Portfolio-level risk assessment across dimensions.
 * Endpoint: GET /api/portfolio/risk
 */
export interface PortfolioRiskDTO {
  meta:             BaseMetadataDTO;
  company_id:       number;
  fiscal_period:    string;
  score:            number;             // 0–100 composite
  risk_level:       PortfolioRiskLevel;
  drivers:          PortfolioRiskDriverDTO[];   // RULE 1: []
  recommendations:  string[];                   // RULE 1: []
  ai_enhanced:      boolean;
}

/*
EXAMPLE:
{
  "meta": { "schema_version": "v1.0", ... },
  "company_id": 1,
  "fiscal_period": "2026-06",
  "score": 55,
  "risk_level": "MEDIUM",
  "drivers": [
    {
      "dimension": "REVENUE_CONCENTRATION",
      "weight": 0.30,
      "score": 40,
      "signal": "Top 2 projects represent 85% of total revenue.",
      "recommendation": "Diversify portfolio — target 2 new projects in Q3.",
      "affected_projects": [7, 5],
      "data_quality": "HIGH"
    }
  ],
  "recommendations": ["Diversify revenue sources", "Reduce cash exposure"],
  "ai_enhanced": false
}
*/

// ═══════════════════════════════════════════════════════════════
// DTO 5 — PortfolioTrendDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * Portfolio-level time-series data point.
 * Endpoint: GET /api/portfolio/trends
 */
export interface PortfolioTrendDTO {
  meta:               BaseMetadataDTO;
  period_type:        PeriodType;
  period:             string;           // 'YYYY-MM' | 'YYYY-Q#' | 'YYYY'
  company_id:         number;

  // Portfolio aggregates for this period
  total_revenue:      number;
  total_gross_profit: number;
  average_margin:     number | null;
  total_cash:         number;
  total_liabilities:  number;
  total_commitments:  number;
  active_projects:    number;

  // Period comparison
  revenue_variance:   number | null;    // vs prior same period
  margin_variance:    number | null;
  trend_direction:    TrendDirection;
  data_quality:       DataQuality;
}

// ═══════════════════════════════════════════════════════════════
// DTO 6 — PortfolioAllocationDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

export interface AllocationSliceDTO {
  label:            string;             // Client name, company name, etc.
  entity_id:        number | null;
  value:            number;             // amount_base
  percentage:       number;             // 0–100
  project_count:    number;
  trend_direction:  TrendDirection | null;
}

/**
 * Revenue/cash/commitment distribution across dimensions.
 * Endpoint: GET /api/portfolio/allocations
 */
export interface PortfolioAllocationDTO {
  meta:             BaseMetadataDTO;
  company_id:       number;
  fiscal_period:    string;
  allocation_type:  AllocationType;
  metric:           string;             // 'revenue' | 'cash_outflow' | 'commitment'
  total:            number;
  slices:           AllocationSliceDTO[];  // RULE 1: [] — supports pie charts
  data_quality:     DataQuality;

  // CHANGE 3: Allocation metadata — OPTIONAL for Power BI, AI, Forecast
  allocation_metadata?: {
    allocation_description?: string | null;
    business_context?:       string | null;
    aggregation_method?:     'SUM' | 'WEIGHTED_AVG' | 'COUNT' | null;
    last_refresh?:           string | null;  // ISO timestamp
  } | null;
}

/*
EXAMPLE (revenue by client):
{
  "meta": { "schema_version": "v1.0", ... },
  "company_id": 1,
  "fiscal_period": "2026-06",
  "allocation_type": "BY_CLIENT",
  "metric": "revenue",
  "total": 1916000,
  "slices": [
    { "label": "Telmex SA de CV", "entity_id": 18, "value": 1350000, "percentage": 70.5, "project_count": 2, "trend_direction": "UP" },
    { "label": "Megacable SA de CV", "entity_id": 20, "value": 566000, "percentage": 29.5, "project_count": 1, "trend_direction": "FLAT" }
  ],
  "data_quality": "HIGH"
}
*/

// ═══════════════════════════════════════════════════════════════
// DTO 7 — PortfolioDashboardDTO  (PUBLIC, STABLE)
// ═══════════════════════════════════════════════════════════════

/**
 * Aggregate payload for Portfolio Workspace and CEO Dashboard.
 * Single endpoint replaces 6 individual calls.
 * Endpoint: GET /api/portfolio/dashboard
 */
export interface PortfolioDashboardDTO {
  meta:        BaseMetadataDTO;
  company_id:  number;
  fiscal_period: string;

  // All portfolio intelligence
  summary:     PortfolioSummaryDTO;
  projects:    PortfolioProjectDTO[];   // RULE 1: []
  rankings:    PortfolioRankingsDTO;
  risk:        PortfolioRiskDTO;
  trends:      PortfolioTrendDTO[];     // RULE 1: []
  allocations: PortfolioAllocationDTO[]; // RULE 1: []

  // Future: alerts from Executive Intelligence Platform
  portfolio_alerts: string[];           // RULE 1: [] placeholder for Sprint P3.4

  // CHANGE 1: Workspace personalization — OPTIONAL, never required
  // ADR-034: visualization state never mixes with business data
  workspace_preferences?: WorkspacePreferencesDTO | null;

  // Observability
  dashboard_meta: {
    project_count:     number;
    event_count:       number;
    execution_ms:      number;
    data_as_of:        string;
    collections_empty: string[];        // which collections returned []
  };
}

// ═══════════════════════════════════════════════════════════════
// API CONTRACT MATRIX
// ═══════════════════════════════════════════════════════════════

/**
 * ENDPOINT CATALOG:
 *
 * GET /api/portfolio/dashboard            → PortfolioDashboardDTO
 * GET /api/portfolio/summary              → PortfolioSummaryDTO
 * GET /api/portfolio/projects             → PortfolioProjectDTO[]
 * GET /api/portfolio/projects/:projectId  → PortfolioProjectDTO
 * GET /api/portfolio/rankings             → PortfolioRankingsDTO
 * GET /api/portfolio/risk                 → PortfolioRiskDTO
 * GET /api/portfolio/trends               → PortfolioTrendDTO[]
 * GET /api/portfolio/allocations          → PortfolioAllocationDTO[]
 *
 * All endpoints:
 *   - Require authentication (Bearer JWT)
 *   - Require company_id parameter (validated against user)
 *   - Support fiscal_period filter
 *   - Support groupBy (trends endpoint)
 *   - Return standard response envelope
 */

// ═══════════════════════════════════════════════════════════════
// DEPENDENCY MATRIX
// ═══════════════════════════════════════════════════════════════

/**
 * CONSUMERS:
 *
 * PortfolioDashboardDTO → CEO Workspace, CFO Dashboard, Portfolio Workspace
 * PortfolioSummaryDTO   → Executive Dashboard (widget), Mobile App, Power BI
 * PortfolioProjectDTO   → Project Manager Dashboard, Reports, AI Platform
 * PortfolioRankingsDTO  → Executive Dashboard rankings section
 * PortfolioRiskDTO      → Risk Reports, AI Platform, Board Presentations
 * PortfolioTrendDTO     → Trend Charts, Forecast Engine, Power BI
 * PortfolioAllocationDTO → Pie Charts, AI Platform, Reports
 *
 * SOURCES (Portfolio Intelligence reads from):
 *   Financial Platform      → financial facts (amounts, event counts)
 *   Executive Intelligence  → health scores, risk levels, insights
 *   Projects table          → project_code, project_name, client_id, status
 */

// ═══════════════════════════════════════════════════════════════
// FUTURE EVOLUTION (reserved, not implemented)
// ═══════════════════════════════════════════════════════════════

/**
 * SPRINT P3.4+ RESERVED EXTENSIONS:
 *
 * PortfolioForecastDTO    → project-level revenue forecast
 * PortfolioCapacityDTO    → resource utilization per project
 * PortfolioBenchmarkDTO   → industry comparison
 * PortfolioScenarioDTO    → what-if analysis
 * PortfolioAIInsightDTO   → AI-generated portfolio recommendations
 *
 * All will extend existing DTOs via optional nullable fields.
 * No breaking changes to v1.0 contracts.
 */

// ═══════════════════════════════════════════════════════════════
// SPRINT P3.1A HARDENING ADDITIONS
// ═══════════════════════════════════════════════════════════════

// CHANGE 2 + CHANGE 6: AllocationType extended + BusinessUnitType reserved
// AllocationType.BY_BUSINESS_UNIT added above ↑

/**
 * CHANGE 6: BusinessUnitType — RESERVED (Sprint P6/P7)
 * ADR-033: Business Unit Expansion Strategy
 * Telecom, Construction, Energy, IT, Real Estate, Infrastructure
 * No implementation. Document only.
 */
export enum BusinessUnitType {
  TELECOM         = 'TELECOM',
  CONSTRUCTION    = 'CONSTRUCTION',
  ENERGY          = 'ENERGY',
  IT              = 'IT',
  REAL_ESTATE     = 'REAL_ESTATE',
  INFRASTRUCTURE  = 'INFRASTRUCTURE'
  // Future: add without breaking existing contracts
}

// CHANGE 1: WorkspacePreferences — OPTIONAL section in PortfolioDashboardDTO
// ADR-034: Workspace Personalization — never mixes visualization state with business data
// ADR-035: Dashboard Contract Stability — DTO remains stable; workspace evolves outside it
export interface WorkspacePreferencesDTO {
  default_view?:     string | null;          // 'grid' | 'list' | 'map'
  default_sort?:     RankingMetric | null;
  default_grouping?: string | null;          // 'by_client' | 'by_health' | etc.
  pinned_widgets?:   string[] | null;        // RULE 1: [] not null when present
  favorite_filters?: Record<string,unknown>[] | null;
  layout_version?:   string | null;          // '1.0'
  last_saved_at?:    string | null;          // ISO timestamp
  // CHANGE 8: Widget registry support
  supported_widgets?: string[] | null;       // future Workspace Builder
}

// CHANGE 4: Workspace Evolution — RESERVED (Sprint P6)
// ADR-032: Workspace Composition Pattern
// ADR-031: Layered Intelligence Architecture
/**
 * RESERVED — Sprint P6+ (DO NOT IMPLEMENT)
 *
 * PortfolioWorkspaceDTO composes PortfolioDashboardDTO.
 * Dashboard DTO NEVER modified for workspace needs.
 *
 * Evolution:
 *   PortfolioWorkspaceDTO
 *     workspace_type: 'CEO' | 'CFO' | 'PORTFOLIO' | 'TREASURY' | 'AI'
 *     workspace_id:   string
 *     user_id:        string
 *     preferences:    WorkspacePreferencesDTO
 *     dashboard:      PortfolioDashboardDTO  ← unchanged v1.0 contract
 *     extensions?:    unknown | null         ← workspace-specific
 *
 * ENTERPRISE RULE (CHANGE 5):
 *   Workspace DTOs NEVER replace Dashboard DTOs.
 *   Workspace DTOs COMPOSE Dashboard DTOs.
 *   This guarantees backward compatibility forever.
 */
export interface PortfolioWorkspaceDTOReserved {
  // RESERVED — v4.1 — DO NOT IMPLEMENT YET
  workspace_type: 'CEO' | 'CFO' | 'PORTFOLIO' | 'TREASURY' | 'AI';
  workspace_id:   string;
  user_id:        string;
  preferences:    WorkspacePreferencesDTO;
  dashboard:      PortfolioDashboardDTO;     // unchanged v1.0 contract
  extensions?:    unknown | null;
}

/**
 * ADR DECISIONS (Sprint P3.1A):
 *
 * ADR-031: Layered Intelligence Architecture
 *   Financial Platform → Executive Intelligence → Portfolio Intelligence
 *   Each layer adds interpretation without re-implementing facts.
 *
 * ADR-032: Workspace Composition Pattern
 *   WorkspaceDTOs compose DashboardDTOs. Never replace.
 *   Personalizable UI layer sits above stable business DTOs.
 *
 * ADR-033: Business Unit Expansion Strategy
 *   BusinessUnitType enum reserved. No calculations until P6.
 *   AllocationType.BY_BUSINESS_UNIT registered now for future routing.
 *
 * ADR-034: Workspace Personalization
 *   WorkspacePreferencesDTO optional in PortfolioDashboardDTO.
 *   Never required. Never affects business calculations.
 *   layout_version governs migration if preferences schema evolves.
 *
 * ADR-035: Dashboard Contract Stability
 *   PortfolioDashboardDTO v1.0 fields immutable.
 *   workspace_preferences is additive (optional).
 *   Business data and visualization state never mixed.
 */

/**
 * UPDATED DEPENDENCY MATRIX (CHANGE 7):
 *
 * PortfolioDashboardDTO:
 *   → CEO Workspace         (primary)
 *   → CFO Dashboard
 *   → Portfolio Workspace   (new)
 *   → Portfolio Mobile      (new)
 *   → Executive Workspace   (new)
 *   → AI Copilot            (new)
 *   → Forecast Platform     (new)
 *   → Power BI              (new)
 *   → Executive Reports     (new)
 *   → Future Plugin SDK     (new)
 */
