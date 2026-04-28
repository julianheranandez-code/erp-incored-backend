'use strict';

/**
 * Generate a sequential project code
 * @param {number} companyId
 * @param {number} count - Current project count
 * @returns {string} e.g. PRY-2025-001
 */
const generateProjectCode = (companyId, count) => {
  const year = new Date().getFullYear();
  const num = String(count + 1).padStart(3, '0');
  return `PRY-${year}-${num}`;
};

/**
 * Generate a quote folio
 * @param {string} companyPrefix - INC, ZHA, INT, MKA
 * @param {number} count
 * @returns {string} e.g. INC-2025-001
 */
const generateQuoteFolio = (companyPrefix, count) => {
  const year = new Date().getFullYear();
  const num = String(count + 1).padStart(3, '0');
  return `${companyPrefix}-${year}-${num}`;
};

/**
 * Paginate query results helper
 * @param {object} params - { page, limit }
 * @returns {{ offset: number, limit: number, page: number }}
 */
const getPagination = ({ page = 1, limit = 20 } = {}) => {
  const parsedPage = Math.max(1, parseInt(page));
  const parsedLimit = Math.min(200, Math.max(1, parseInt(limit)));
  return {
    page: parsedPage,
    limit: parsedLimit,
    offset: (parsedPage - 1) * parsedLimit,
  };
};

/**
 * Build pagination response object
 * @param {Array} data
 * @param {number} total
 * @param {number} page
 * @param {number} limit
 * @returns {object}
 */
const buildPaginatedResponse = (data, total, page, limit) => ({
  data,
  pagination: {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  },
});

/**
 * Parse allowed sort fields to prevent SQL injection
 * @param {string} sort - Field name from query
 * @param {string[]} allowedFields - Whitelist
 * @param {string} defaultField - Default sort field
 * @returns {string} Safe SQL column name
 */
const parseSortField = (sort, allowedFields, defaultField = 'created_at') => {
  if (!sort || !allowedFields.includes(sort)) return defaultField;
  return sort;
};

/**
 * Format currency amount
 * @param {number} amount
 * @param {string} currency
 * @returns {string}
 */
const formatCurrency = (amount, currency = 'MXN') => {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
  }).format(amount);
};

/**
 * Calculate quote/invoice totals
 * @param {Array} lines - Array of { quantity, unit_price, discount_percent }
 * @param {number} taxPercent
 * @returns {{ subtotal, tax, total }}
 */
const calculateTotals = (lines, taxPercent = 16) => {
  const subtotal = lines.reduce((sum, line) => {
    const lineTotal = line.quantity * line.unit_price * (1 - (line.discount_percent || 0) / 100);
    return sum + lineTotal;
  }, 0);
  const tax = subtotal * (taxPercent / 100);
  const total = subtotal + tax;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
};

/**
 * Validate Mexican RFC format
 * @param {string} rfc
 * @returns {boolean}
 */
const isValidRFC = (rfc) => {
  const rfcPattern = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
  return rfcPattern.test(rfc);
};

/**
 * Safe integer parse
 * @param {any} value
 * @param {number} defaultValue
 * @returns {number}
 */
const safeInt = (value, defaultValue = 0) => {
  const parsed = parseInt(value);
  return isNaN(parsed) ? defaultValue : parsed;
};

/**
 * Pick only allowed keys from an object
 * @param {object} obj
 * @param {string[]} keys
 * @returns {object}
 */
const pick = (obj, keys) => {
  return keys.reduce((acc, key) => {
    if (key in obj) acc[key] = obj[key];
    return acc;
  }, {});
};

/**
 * Omit keys from an object
 * @param {object} obj
 * @param {string[]} keys
 * @returns {object}
 */
const omit = (obj, keys) => {
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => !keys.includes(k))
  );
};

/**
 * Sleep utility for retry logic
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check if email domain is in allowed list
 * @param {string} email
 * @returns {boolean}
 */
const isAllowedEmailDomain = (email) => {
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS || 'incored.com.mx,zhada.mx').split(',');
  const emailDomain = email.split('@')[1]?.toLowerCase();
  return domains.map((d) => d.trim().toLowerCase()).includes(emailDomain);
};

module.exports = {
  generateProjectCode,
  generateQuoteFolio,
  getPagination,
  buildPaginatedResponse,
  parseSortField,
  formatCurrency,
  calculateTotals,
  isValidRFC,
  safeInt,
  pick,
  omit,
  sleep,
  isAllowedEmailDomain,
};
