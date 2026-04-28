'use strict';

const express = require('express');
const router = express.Router();

const User = require('../models/User');
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { authorize, getPermissionsForRole } = require('../middleware/authorization');
const { validate, schemas } = require('../middleware/validation');
const { auditLog } = require('../middleware/audit');
const { sendWelcomeEmail } = require('../utils/emailer');
const { generateSecureToken } = require('../utils/encryption');
const { getPagination, buildPaginatedResponse } = require('../utils/helpers');

router.use(verifyToken, auditLog);

// GET /api/users
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { company_id, role, status, search } = req.query;

    const result = await User.findAll({
      companyId: req.user.role === 'admin' ? company_id : req.user.company_id,
      role,
      status,
      search,
      page,
      limit,
      userRole: req.user.role,
      userCompanyId: req.user.company_id,
    });

    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

// GET /api/users/:id
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (req.user.role !== 'admin' && req.user.id !== id) {
      // Check same company
      const target = await User.findById(id);
      if (!target || target.company_id !== req.user.company_id) {
        return res.status(403).json({ success: false, error: 'forbidden', message: 'Acceso denegado.' });
      }
    }
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, error: 'not_found', message: 'Usuario no encontrado.' });
    res.json({ success: true, data: user });
  } catch (error) { next(error); }
});

// POST /api/users
router.post('/',
  authorize('admin', 'manager'),
  validate(schemas.createUser),
  async (req, res, next) => {
    try {
      const { email, name, phone, company_id, role, tempPassword } = req.body;

      // Managers can only create users in their own company
      if (req.user.role === 'manager' && company_id !== req.user.company_id) {
        return res.status(403).json({ success: false, error: 'forbidden', message: 'Solo puedes crear usuarios en tu empresa.' });
      }

      const exists = await User.emailExists(email);
      if (exists) {
        return res.status(409).json({ success: false, error: 'conflict', message: 'El correo ya está registrado.' });
      }

      const password = tempPassword || generateSecureToken(8) + 'A1!';
      const user = await User.create({ email, password, name, phone, company_id, role, must_change_password: true });

      await sendWelcomeEmail({ to: email, name, tempPassword: password }).catch(() => {});

      res.status(201).json({
        success: true,
        message: 'Usuario creado. Se envió email con credenciales.',
        data: { id: user.id, email: user.email, name: user.name, role: user.role },
      });
    } catch (error) { next(error); }
  }
);

// PUT /api/users/:id
router.put('/:id',
  validate(schemas.updateUser),
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);

      // Can update self or admin can update anyone
      if (req.user.id !== id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'forbidden', message: 'Solo puedes editar tu propio perfil.' });
      }

      // Only admin can change role/company
      if (req.user.role !== 'admin') {
        delete req.body.role;
        delete req.body.company_id;
        delete req.body.status;
      }

      const user = await User.update(id, req.body);
      if (!user) return res.status(404).json({ success: false, error: 'not_found', message: 'Usuario no encontrado.' });

      res.json({ success: true, message: 'Usuario actualizado.', data: user });
    } catch (error) { next(error); }
  }
);

// DELETE /api/users/:id (soft delete)
router.delete('/:id',
  authorize('admin'),
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      if (req.user.id === id) {
        return res.status(400).json({ success: false, error: 'error', message: 'No puedes desactivar tu propia cuenta.' });
      }
      const user = await User.deactivate(id);
      if (!user) return res.status(404).json({ success: false, error: 'not_found', message: 'Usuario no encontrado.' });
      res.json({ success: true, message: 'Usuario desactivado.', data: user });
    } catch (error) { next(error); }
  }
);

// GET /api/users/:id/permissions
router.get('/:id/permissions', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, error: 'not_found', message: 'Usuario no encontrado.' });

    const permissions = getPermissionsForRole(user.role);
    res.json({
      success: true,
      data: {
        user_id: id,
        role: user.role,
        modules: permissions,
        companies: req.user.role === 'admin' ? 'all' : [user.company_id],
      },
    });
  } catch (error) { next(error); }
});

// PUT /api/users/:id/role
router.put('/:id/role',
  authorize('admin'),
  async (req, res, next) => {
    try {
      const { role } = req.body;
      const validRoles = ['admin', 'manager', 'finance', 'hr', 'project_manager', 'supervisor', 'operative', 'technician'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Rol inválido.' });
      }
      const user = await User.update(parseInt(req.params.id), { role });
      if (!user) return res.status(404).json({ success: false, error: 'not_found', message: 'Usuario no encontrado.' });
      res.json({ success: true, message: 'Rol actualizado.', data: user });
    } catch (error) { next(error); }
  }
);

// GET /api/roles
router.get('/meta/roles', (req, res) => {
  res.json({
    success: true,
    data: [
      { value: 'admin', label: 'Administrador', description: 'Acceso total al sistema' },
      { value: 'manager', label: 'Gerente', description: 'Gestión de su empresa' },
      { value: 'finance', label: 'Finanzas', description: 'Módulo financiero' },
      { value: 'hr', label: 'Recursos Humanos', description: 'Módulo de RR.HH.' },
      { value: 'project_manager', label: 'Project Manager', description: 'Gestión de proyectos' },
      { value: 'supervisor', label: 'Supervisor', description: 'Supervisión de campo' },
      { value: 'operative', label: 'Operativo', description: 'Ejecución de tareas' },
      { value: 'technician', label: 'Técnico', description: 'Ejecución técnica' },
    ],
  });
});

// PUT /api/users/:id/change-password
router.put('/:id/change-password', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (req.user.id !== id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Acceso denegado.' });
    }

    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'La contraseña debe tener al menos 8 caracteres.' });
    }

    const userWithPwd = await User.findByEmail(req.user.email);
    if (currentPassword) {
      const valid = await User.verifyPassword(currentPassword, userWithPwd.password_hash);
      if (!valid) return res.status(401).json({ success: false, error: 'unauthorized', message: 'Contraseña actual incorrecta.' });
    }

    await User.updatePassword(id, newPassword);
    res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (error) { next(error); }
});

module.exports = router;
