'use strict';

const logger = require('../utils/logger');

// Role hierarchy (higher index = more permissions)
const ROLE_HIERARCHY = {
  operative: 0,
  technician: 1,
  supervisor: 2,
  project_manager: 3,
  manager: 4,
  finance: 4,
  hr: 4,
  admin: 99,
};

// Module permission matrix per role
const PERMISSIONS = {
  admin: {
    users: ['read', 'create', 'update', 'delete'],
    companies: ['read', 'create', 'update', 'delete'],
    projects: ['read', 'create', 'update', 'delete'],
    tasks: ['read', 'create', 'update', 'delete'],
    crm: ['read', 'create', 'update', 'delete'],
    transactions: ['read', 'create', 'update', 'delete'],
    inventory: ['read', 'create', 'update', 'delete'],
    employees: ['read', 'create', 'update', 'delete'],
    reports: ['read', 'create', 'export'],
    files: ['read', 'create', 'delete'],
  },
  manager: {
    users: ['read', 'create', 'update'],
    companies: ['read'],
    projects: ['read', 'create', 'update'],
    tasks: ['read', 'create', 'update', 'delete'],
    crm: ['read', 'create', 'update'],
    transactions: ['read', 'create', 'update'],
    inventory: ['read', 'create', 'update'],
    employees: ['read', 'create', 'update'],
    reports: ['read', 'create', 'export'],
    files: ['read', 'create', 'delete'],
  },
  finance: {
    users: ['read'],
    projects: ['read'],
    tasks: ['read'],
    crm: ['read', 'create', 'update'],
    transactions: ['read', 'create', 'update', 'delete'],
    inventory: ['read'],
    employees: ['read'],
    reports: ['read', 'create', 'export'],
    files: ['read', 'create'],
  },
  hr: {
    users: ['read', 'create', 'update'],
    projects: ['read'],
    tasks: ['read'],
    employees: ['read', 'create', 'update', 'delete'],
    reports: ['read', 'export'],
    files: ['read', 'create'],
  },
  project_manager: {
    users: ['read'],
    projects: ['read', 'create', 'update'],
    tasks: ['read', 'create', 'update', 'delete'],
    crm: ['read', 'create', 'update'],
    transactions: ['read'],
    inventory: ['read', 'create', 'update'],
    employees: ['read'],
    reports: ['read', 'export'],
    files: ['read', 'create', 'delete'],
  },
  supervisor: {
    users: ['read'],
    projects: ['read', 'update'],
    tasks: ['read', 'create', 'update'],
    inventory: ['read', 'update'],
    reports: ['read'],
    files: ['read', 'create'],
  },
  operative: {
    tasks: ['read', 'update'],
    inventory: ['read'],
    files: ['read'],
  },
  technician: {
    tasks: ['read', 'update'],
    inventory: ['read'],
    files: ['read', 'create'],
  },
};

/**
 * Authorize by role(s)
 * @param {...string} allowedRoles - Roles allowed to access route
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Autenticación requerida.',
      });
    }

    const userRole = req.user.role;

    // Admin always passes
    if (userRole === 'admin') return next();

    if (!allowedRoles.includes(userRole)) {
      logger.warn(`Access denied for user ${req.user.id} (${userRole}) to ${req.method} ${req.path}`);
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: 'No tienes permisos para realizar esta acción.',
      });
    }

    next();
  };
};

/**
 * Authorize by minimum role level
 * @param {string} minimumRole - Minimum role required
 */
const authorizeMinRole = (minimumRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Autenticación requerida.',
      });
    }

    const userLevel = ROLE_HIERARCHY[req.user.role] ?? -1;
    const requiredLevel = ROLE_HIERARCHY[minimumRole] ?? 99;

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: 'Nivel de acceso insuficiente.',
      });
    }

    next();
  };
};

/**
 * Check module + action permission
 * @param {string} module - Module name
 * @param {string} action - Action (read, create, update, delete)
 */
const authorizePermission = (module, action) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Autenticación requerida.',
      });
    }

    const rolePerms = PERMISSIONS[req.user.role];
    if (!rolePerms) {
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: 'Rol desconocido.',
      });
    }

    const modulePerms = rolePerms[module] || [];
    if (!modulePerms.includes(action)) {
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: `No tienes permisos para ${action} en el módulo ${module}.`,
      });
    }

    next();
  };
};

/**
 * Ensure user can only access their own company data
 * Skips check for admin
 */
const authorizeCompany = (getCompanyId) => {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (req.user.role === 'admin') return next();

    try {
      const targetCompanyId = typeof getCompanyId === 'function'
        ? await getCompanyId(req)
        : parseInt(req.params.company_id || req.body.company_id);

      if (targetCompanyId && targetCompanyId !== req.user.company_id) {
        return res.status(403).json({
          success: false,
          error: 'forbidden',
          message: 'No tienes acceso a los datos de esta empresa.',
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Get permissions object for a user's role
 * @param {string} role
 * @returns {object}
 */
const getPermissionsForRole = (role) => {
  return PERMISSIONS[role] || {};
};

module.exports = {
  authorize,
  authorizeMinRole,
  authorizePermission,
  authorizeCompany,
  getPermissionsForRole,
  PERMISSIONS,
  ROLE_HIERARCHY,
};
