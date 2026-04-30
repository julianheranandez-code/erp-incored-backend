'use strict';

const Joi = require('joi');

/**
 * Generic request validation middleware factory
 * @param {Joi.Schema} schema - Joi schema
 * @param {'body'|'query'|'params'} source - Request part to validate
 */
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      allowUnknown: false,
    });

    if (error) {
      const details = {};
      error.details.forEach((d) => {
        const key = d.path.join('.');
        details[key] = d.message.replace(/['"]/g, '');
      });

      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: error.details[0].message.replace(/['"]/g, ''),
        details,
      });
    }

    req[source] = value;
    next();
  };
};

// ─── Reusable Joi schemas ────────────────────────────────────────────────────

const schemas = {
  // Auth
  signup: Joi.object({
    email: Joi.string().email().lowercase().trim().required(),
    password: Joi.string()
      .min(8)
      .pattern(/^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/)
      .required()
      .messages({
        'string.pattern.base': 'La contraseña debe tener al menos una mayúscula, un número y un símbolo.',
      }),
    name: Joi.string().min(2).max(255).trim().required(),
    phone: Joi.string().max(20).optional().allow(''),
    company_id: Joi.number().integer().positive().required(),
    role: Joi.string()
      .valid('admin', 'manager', 'finance', 'hr', 'project_manager', 'supervisor', 'operative', 'technician')
      .required(),
  }),

  login: Joi.object({
    email: Joi.string().email().lowercase().trim().required(),
    password: Joi.string().required(),
  }),

  refreshToken: Joi.object({
    refreshToken: Joi.string().uuid().required(),
  }),

  passwordResetRequest: Joi.object({
    email: Joi.string().email().lowercase().trim().required(),
  }),

  passwordReset: Joi.object({
    token: Joi.string().required(),
    newPassword: Joi.string()
      .min(8)
      .pattern(/^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/)
      .required(),
  }),

  verify2fa: Joi.object({
    code: Joi.string().length(6).pattern(/^\d+$/).required(),
  }),

  // Users
  createUser: Joi.object({
    email: Joi.string().email().lowercase().trim().required(),
    name: Joi.string().min(2).max(255).trim().required(),
    phone: Joi.string().max(20).optional().allow(''),
    company_id: Joi.number().integer().positive().required(),
    role: Joi.string()
      .valid('admin', 'manager', 'finance', 'hr', 'project_manager', 'supervisor', 'operative', 'technician')
      .required(),
    tempPassword: Joi.string().min(8).optional(),
  }),

  updateUser: Joi.object({
    name: Joi.string().min(2).max(255).trim().optional(),
    phone: Joi.string().max(20).optional().allow(''),
    company_id: Joi.number().integer().positive().optional(),
    role: Joi.string()
      .valid('admin', 'manager', 'finance', 'hr', 'project_manager', 'supervisor', 'operative', 'technician')
      .optional(),
    status: Joi.string().valid('active', 'inactive', 'suspended').optional(),
  }),

  // Projects
  createProject: Joi.object({
    code: Joi.string().max(50).optional(),
    name: Joi.string().min(2).max(255).trim().required(),
    client_id: Joi.number().integer().positive().required(),
    company_id: Joi.number().integer().positive().required(),
    pm_id: Joi.string().uuid().optional(),
    order_number: Joi.string().max(100).optional().allow(''),
    budget_amount: Joi.number().positive().optional(),
    currency: Joi.string().length(3).default('MXN').optional(),
    expected_margin: Joi.number().min(0).max(100).optional(),
    country: Joi.string().max(100).optional().allow(''),
    city: Joi.string().max(100).optional().allow(''),
    start_date: Joi.date().optional(),
    end_date_planned: Joi.date().optional(),
    description: Joi.string().max(5000).optional().allow(''),
  }),

  updateProject: Joi.object({
    name: Joi.string().min(2).max(255).trim().optional(),
    client_id: Joi.number().integer().positive().optional(),
    pm_id: Joi.string().uuid().optional().allow(null),
    order_number: Joi.string().max(100).optional().allow(''),
    budget_amount: Joi.number().positive().optional(),
    currency: Joi.string().length(3).optional(),
    expected_margin: Joi.number().min(0).max(100).optional(),
    status: Joi.string().valid('planning', 'executing', 'paused', 'completed', 'cancelled').optional(),
    progress_percent: Joi.number().min(0).max(100).optional(),
    country: Joi.string().max(100).optional().allow(''),
    city: Joi.string().max(100).optional().allow(''),
    start_date: Joi.date().optional(),
    end_date_planned: Joi.date().optional(),
    end_date_real: Joi.date().optional().allow(null),
    description: Joi.string().max(5000).optional().allow(''),
  }),

  // Tasks
  createTask: Joi.object({
    title: Joi.string().min(2).max(255).trim().required(),
    description: Joi.string().max(5000).optional().allow(''),
    project_id: Joi.number().integer().positive().optional().allow(null),
    assigned_to: Joi.number().integer().positive().required(),
    priority: Joi.string().valid('critica', 'alta', 'media', 'baja').default('media'),
    status: Joi.string()
      .valid('no_iniciada', 'pendiente', 'en_proceso', 'bloqueada', 'en_revision', 'completada', 'cancelada')
      .default('no_iniciada'),
    due_date: Joi.date().optional().allow(null),
    estimated_hours: Joi.number().integer().min(1).optional(),
  }),

  updateTask: Joi.object({
    title: Joi.string().min(2).max(255).trim().optional(),
    description: Joi.string().max(5000).optional().allow(''),
    assigned_to: Joi.number().integer().positive().optional(),
    priority: Joi.string().valid('critica', 'alta', 'media', 'baja').optional(),
    status: Joi.string()
      .valid('no_iniciada', 'pendiente', 'en_proceso', 'bloqueada', 'en_revision', 'completada', 'cancelada')
      .optional(),
    due_date: Joi.date().optional().allow(null),
    estimated_hours: Joi.number().integer().min(1).optional().allow(null),
    percent_complete: Joi.number().min(0).max(100).optional(),
  }),

  timeEntry: Joi.object({
    start_time: Joi.date().required(),
    end_time: Joi.date().optional().allow(null),
    duration_minutes: Joi.number().integer().min(1).optional(),
    notes: Joi.string().max(1000).optional().allow(''),
  }),

  // Clients
  createClient: Joi.object({
    name: Joi.string().min(2).max(255).trim().required(),
    type: Joi.string().valid('cliente', 'proveedor', 'ambos').default('cliente'),
    rfc: Joi.string().max(50).optional().allow(''),
    country: Joi.string().max(100).optional().allow(''),
    industry: Joi.string().max(100).optional().allow(''),
    primary_contact_name: Joi.string().max(255).optional().allow(''),
    primary_contact_email: Joi.string().email().optional().allow(''),
    primary_contact_phone: Joi.string().max(20).optional().allow(''),
    credit_limit: Joi.number().positive().optional().allow(null),
    payment_terms: Joi.string().valid('contado', '15_dias', '30_dias', '60_dias').optional(),
    credit_rating: Joi.string().valid('excelente', 'buena', 'media', 'mala', 'morosa').optional(),
  }),

  // Quotes
  createQuote: Joi.object({
    client_id: Joi.number().integer().positive().required(),
    company_id: Joi.number().integer().positive().required(),
    issue_date: Joi.date().required(),
    validity_days: Joi.number().integer().min(1).default(30),
    currency: Joi.string().length(3).default('MXN'),
    tax_percent: Joi.number().min(0).max(100).default(16),
    terms_conditions: Joi.string().max(5000).optional().allow(''),
    lines: Joi.array().items(
      Joi.object({
        description: Joi.string().max(255).required(),
        quantity: Joi.number().positive().required(),
        unit: Joi.string().max(50).optional().allow(''),
        unit_price: Joi.number().positive().required(),
        discount_percent: Joi.number().min(0).max(100).default(0),
        line_order: Joi.number().integer().optional(),
      })
    ).min(1).required(),
  }),

  // Transactions
  createTransaction: Joi.object({
    type: Joi.string().valid('ingreso', 'egreso', 'transferencia').required(),
    category: Joi.string().max(100).required(),
    company_id: Joi.number().integer().positive().required(),
    project_id: Joi.number().integer().positive().optional().allow(null),
    client_id: Joi.number().integer().positive().optional().allow(null),
    amount: Joi.number().positive().required(),
    currency: Joi.string().length(3).default('MXN'),
    description: Joi.string().max(1000).optional().allow(''),
    reference_number: Joi.string().max(100).optional().allow(''),
    transaction_date: Joi.date().required(),
  }),

  // Inventory
  createMaterial: Joi.object({
    sku: Joi.string().max(50).required(),
    name: Joi.string().max(255).required(),
    category: Joi.string().max(100).optional().allow(''),
    quantity_min: Joi.number().integer().min(0).optional(),
    quantity_max: Joi.number().integer().min(0).optional(),
    unit_of_measure: Joi.string().max(50).optional().allow(''),
    cost_last_purchase: Joi.number().positive().optional().allow(null),
    company_id: Joi.number().integer().positive().required(),
    supplier_id: Joi.number().integer().positive().optional().allow(null),
  }),

  inventoryMovement: Joi.object({
    type: Joi.string().valid('entrada', 'salida', 'transferencia', 'ajuste').required(),
    quantity: Joi.number().integer().required(),
    project_id: Joi.number().integer().positive().optional().allow(null),
    company_from: Joi.number().integer().positive().optional().allow(null),
    company_to: Joi.number().integer().positive().optional().allow(null),
    reference_number: Joi.string().max(100).optional().allow(''),
    notes: Joi.string().max(1000).optional().allow(''),
  }),

  // Employees
  createEmployee: Joi.object({
    name: Joi.string().min(2).max(255).trim().required(),
    email: Joi.string().email().optional().allow(''),
    phone: Joi.string().max(20).optional().allow(''),
    company_id: Joi.number().integer().positive().required(),
    position: Joi.string().max(100).optional().allow(''),
    supervisor_id: Joi.number().integer().positive().optional().allow(null),
    salary_base: Joi.number().positive().optional().allow(null),
    hire_date: Joi.date().optional().allow(null),
    skills: Joi.array().items(Joi.string()).optional(),
    certifications: Joi.array().items(Joi.string()).optional(),
  }),

  // Pagination
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(200).default(20),
    sort: Joi.string().optional(),
    order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
  }).unknown(true),
};

module.exports = { validate, schemas };
