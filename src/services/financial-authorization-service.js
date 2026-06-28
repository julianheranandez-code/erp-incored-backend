'use strict';
/**
 * Financial Authorization Service — Sprint 6.1C.1
 * Centralizes company access validation for ALL Financial API consumers.
 * Reusable: Treasury, Portfolio, Projects, Assets, Payroll, AI Platform.
 */
const { query } = require('../config/database');
const logger    = require('../utils/logger');

class AuthorizationError extends Error {
  constructor(message, code = 'AUTHORIZATION_ERROR') {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
    this.statusCode = 403;
  }
}

/**
 * Validate user can access companyId.
 * @returns {number} Authorized companyId
 * @throws  {AuthorizationError}
 */
async function authorizeCompanyAccess(user, companyId) {
  if (!companyId || isNaN(parseInt(companyId)))
    throw new AuthorizationError('company_id is required.', 'COMPANY_REQUIRED');

  const cid = parseInt(companyId);

  // Super admin: unrestricted
  if (user.role === 'super_admin') return cid;

  // Admin/user: must belong to requested company
  const userCompany = parseInt(user.company_id);
  if (userCompany === cid) return cid;

  // Future: multi-company RBAC lookup
  // const allowed = await query(`SELECT company_id FROM user_company_access
  //   WHERE user_id=$1 AND company_id=$2`, [user.id, cid]);
  // if (allowed.rows.length) return cid;

  logger.warn(`[FinancialAuth] DENIED user=${user.id} company=${cid} (user.company=${userCompany})`);
  throw new AuthorizationError(
    `Access denied: you are not authorized to access company ${cid}.`,
    'COMPANY_ACCESS_DENIED'
  );
}

module.exports = { authorizeCompanyAccess, AuthorizationError };
