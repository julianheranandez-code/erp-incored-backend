'use strict';

const express = require('express');
const router = express.Router();
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const { query } = require('../config/database');
const {
  generateAccessToken,
  generateRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  blacklistToken,
  verifyAccessToken,
} = require('../config/auth');
const { generateSecureToken, generateBackupCodes, hashBackupCodes } = require('../utils/encryption');
const { sendPasswordResetEmail, sendWelcomeEmail, sendBackupCodesEmail } = require('../utils/emailer');
const { verifyToken } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validation');
const { loginLimiter, passwordResetLimiter } = require('../middleware/rateLimit');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
/**
 * @swagger
 * /signup:
 *   post:
 *     summary: POST /signup
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/signup',
  validate(schemas.signup),
  async (req, res, next) => {
    try {
      const { email, password, name, phone, company_id, role } = req.body;

      // Only admin can create accounts (or first setup)
      // This check is relaxed here — in production set it behind verifyToken + authorize('admin')
      const exists = await User.emailExists(email);
      if (exists) {
        return res.status(409).json({
          success: false,
          error: 'conflict',
          message: 'El correo electrónico ya está registrado.',
        });
      }

      // Validate company exists
      const companyResult = await query(`SELECT id FROM companies WHERE id = $1`, [company_id]);
      if (!companyResult.rows.length) {
        return res.status(400).json({
          success: false,
          error: 'validation_error',
          message: 'La empresa especificada no existe.',
        });
      }

      const user = await User.create({ email, password, name, phone, company_id, role });

      const accessToken = generateAccessToken(user);
      const refreshToken = await generateRefreshToken(user.id);

      await writeAudit({ userId: user.id, action: 'create', entityType: 'users', entityId: user.id, ip: req.ip });

      res.status(201).json({
        success: true,
        message: 'Usuario registrado exitosamente.',
        data: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          company_id: user.company_id,
          token: accessToken,
          refreshToken,
          expiresIn: 86400,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
/**
 * @swagger
 * /login:
 *   post:
 *     summary: POST /login
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/login',
  loginLimiter,
  validate(schemas.login),
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const user = await User.findByEmail(email);

      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'unauthorized',
          message: 'Credenciales inválidas.',
        });
      }

      // Check account lock
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const minutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
        return res.status(429).json({
          success: false,
          error: 'account_locked',
          message: `Cuenta bloqueada por intentos fallidos. Espera ${minutes} minutos.`,
          retryAfter: minutes,
        });
      }

      // Check account status
      if (user.status !== 'active') {
        return res.status(401).json({
          success: false,
          error: 'unauthorized',
          message: 'Tu cuenta está suspendida o inactiva. Contacta al administrador.',
        });
      }

      // Verify password
      const validPassword = await User.verifyPassword(password, user.password_hash);
      if (!validPassword) {
        await User.incrementLoginAttempts(email);
        await writeAudit({ userId: user.id, action: 'login_failed', entityType: 'auth', ip: req.ip });

        return res.status(401).json({
          success: false,
          error: 'unauthorized',
          message: 'Credenciales inválidas.',
        });
      }

      await User.recordLogin(user.id);

      await writeAudit({ userId: user.id, action: 'login', entityType: 'auth', ip: req.ip, userAgent: req.get('user-agent') });

      // If 2FA is enabled, return partial token requiring 2FA step
      if (user.two_fa_enabled) {
        const partialToken = generateAccessToken({ ...user, requires_2fa: true });
        return res.json({
          success: true,
          requires2FA: true,
          partialToken,
          message: 'Se requiere verificación de dos factores.',
        });
      }

      const accessToken = generateAccessToken(user);
      const refreshToken = await generateRefreshToken(user.id);

      res.json({
        success: true,
        message: 'Sesión iniciada correctamente.',
        data: {
          token: accessToken,
          refreshToken,
          expiresIn: 86400,
          mustChangePassword: user.must_change_password,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            company_id: user.company_id,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
/**
 * @swagger
 * /logout:
 *   post:
 *     summary: POST /logout
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/logout',
  verifyToken,
  async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];

      if (token) {
        try {
          const decoded = verifyAccessToken(token);
          await blacklistToken(token, decoded);
        } catch (_) {}
      }

      const { refreshToken } = req.body;
      if (refreshToken) await revokeRefreshToken(refreshToken);

      await writeAudit({ userId: req.user.id, action: 'logout', entityType: 'auth', ip: req.ip });

      res.json({ success: true, message: 'Sesión cerrada correctamente.' });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
/**
 * @swagger
 * /refresh:
 *   post:
 *     summary: POST /refresh
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/refresh',
  validate(schemas.refreshToken),
  async (req, res, next) => {
    try {
      const { refreshToken } = req.body;

      const tokenData = await validateRefreshToken(refreshToken);
      await revokeRefreshToken(refreshToken); // rotate token

      const user = {
        id: tokenData.user_id,
        email: tokenData.email,
        role: tokenData.role,
        company_id: tokenData.company_id,
        name: tokenData.name,
      };

      const newAccessToken = generateAccessToken(user);
      const newRefreshToken = await generateRefreshToken(user.id);

      res.json({
        success: true,
        data: {
          token: newAccessToken,
          refreshToken: newRefreshToken,
          expiresIn: 86400,
        },
      });
    } catch (error) {
      if (error.message.includes('refresh token')) {
        return res.status(401).json({
          success: false,
          error: 'unauthorized',
          message: 'Refresh token inválido o expirado. Inicia sesión nuevamente.',
        });
      }
      next(error);
    }
  }
);

// ─── POST /api/auth/request-password-reset ────────────────────────────────────
/**
 * @swagger
 * /request-password-reset:
 *   post:
 *     summary: POST /request-password-reset
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/request-password-reset',
  passwordResetLimiter,
  validate(schemas.passwordResetRequest),
  async (req, res, next) => {
    try {
      const { email } = req.body;

      // Always return success (don't reveal if email exists)
      const user = await User.findByEmail(email);
      if (!user) {
        return res.json({
          success: true,
          message: 'Si el correo existe, recibirás un enlace de restablecimiento.',
        });
      }

      // Generate secure token
      const token = generateSecureToken(32);
      const expiresAt = new Date(Date.now() + 3600000); // 1 hour

      await query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, token, expiresAt]
      );

      await sendPasswordResetEmail({ to: user.email, name: user.name, resetToken: token });
      await writeAudit({ userId: user.id, action: 'password_reset_requested', entityType: 'auth', ip: req.ip });

      res.json({
        success: true,
        message: 'Si el correo existe, recibirás un enlace de restablecimiento.',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
/**
 * @swagger
 * /reset-password:
 *   post:
 *     summary: POST /reset-password
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/reset-password',
  validate(schemas.passwordReset),
  async (req, res, next) => {
    try {
      const { token, newPassword } = req.body;

      const tokenResult = await query(
        `SELECT prt.*, u.id AS user_id, u.name
         FROM password_reset_tokens prt
         JOIN users u ON u.id = prt.user_id
         WHERE prt.token = $1 AND prt.used = false AND prt.expires_at > NOW()`,
        [token]
      );

      if (!tokenResult.rows.length) {
        return res.status(400).json({
          success: false,
          error: 'validation_error',
          message: 'Enlace de restablecimiento inválido o expirado.',
        });
      }

      const { user_id } = tokenResult.rows[0];

      await User.updatePassword(user_id, newPassword);
      await revokeAllUserTokens(user_id);

      await query(
        `UPDATE password_reset_tokens SET used = true, used_at = NOW() WHERE token = $1`,
        [token]
      );

      await writeAudit({ userId: user_id, action: 'password_reset', entityType: 'auth', ip: req.ip });

      res.json({ success: true, message: 'Contraseña actualizada. Por favor inicia sesión.' });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/enable-2fa ────────────────────────────────────────────────
/**
 * @swagger
 * /enable-2fa:
 *   post:
 *     summary: POST /enable-2fa
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/enable-2fa',
  verifyToken,
  async (req, res, next) => {
    try {
      const secret = authenticator.generateSecret();
      const issuer = process.env.TWO_FA_ISSUER || 'IncorERP';
      const otpauth = authenticator.keyuri(req.user.email, issuer, secret);

      const qrCode = await QRCode.toDataURL(otpauth);
      const backupCodes = generateBackupCodes();

      // Store secret temporarily (user must verify before it's saved)
      await query(
        `UPDATE users SET two_fa_secret = $1 WHERE id = $2`,
        [require('../utils/encryption').encrypt(secret), req.user.id]
      );

      res.json({
        success: true,
        data: {
          qrCode,
          secret,
          backupCodes,
          message: 'Escanea el código QR con Google Authenticator, luego confirma con POST /api/auth/confirm-2fa',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/confirm-2fa ───────────────────────────────────────────────
/**
 * @swagger
 * /confirm-2fa:
 *   post:
 *     summary: POST /confirm-2fa
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/confirm-2fa',
  verifyToken,
  validate(schemas.verify2fa),
  async (req, res, next) => {
    try {
      const { code } = req.body;
      const secret = await User.get2FASecret(req.user.id);

      if (!secret) {
        return res.status(400).json({
          success: false,
          error: 'validation_error',
          message: '2FA no ha sido configurado. Primero llama a /enable-2fa.',
        });
      }

      authenticator.options = { window: parseInt(process.env.TWO_FA_WINDOW) || 1 };
      const isValid = authenticator.verify({ token: code, secret });

      if (!isValid) {
        return res.status(400).json({
          success: false,
          error: 'invalid_2fa_code',
          message: 'Código 2FA inválido. Verifica tu aplicación.',
        });
      }

      const backupCodes = generateBackupCodes();
      const hashedBackupCodes = hashBackupCodes(backupCodes);

      await User.enable2FA(req.user.id, secret);
      await query(
        `UPDATE users SET two_fa_backup_codes = $1 WHERE id = $2`,
        [JSON.stringify(hashedBackupCodes), req.user.id]
      );

      await sendBackupCodesEmail({ to: req.user.email, name: req.user.name, backupCodes });

      res.json({
        success: true,
        message: '2FA habilitado correctamente. Se han enviado los códigos de respaldo a tu correo.',
        data: { backupCodes },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/verify-2fa ────────────────────────────────────────────────
/**
 * @swagger
 * /verify-2fa:
 *   post:
 *     summary: POST /verify-2fa
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/verify-2fa',
  async (req, res, next) => {
    try {
      const { partialToken, code } = req.body;

      if (!partialToken || !code) {
        return res.status(400).json({
          success: false,
          error: 'validation_error',
          message: 'Se requiere partialToken y code.',
        });
      }

      let decoded;
      try {
        decoded = verifyAccessToken(partialToken);
      } catch {
        return res.status(401).json({ success: false, error: 'unauthorized', message: 'Token inválido.' });
      }

      const secret = await User.get2FASecret(decoded.id);
      if (!secret) {
        return res.status(400).json({ success: false, error: 'error', message: 'Usuario sin 2FA configurado.' });
      }

      authenticator.options = { window: 1 };
      const isValid = authenticator.verify({ token: code, secret });

      if (!isValid) {
        return res.status(400).json({
          success: false,
          error: 'invalid_2fa_code',
          message: 'Código 2FA inválido.',
        });
      }

      const user = await User.findById(decoded.id);
      const accessToken = generateAccessToken(user);
      const refreshToken = await generateRefreshToken(user.id);

      await User.recordLogin(user.id);

      res.json({
        success: true,
        data: {
          authenticated: true,
          token: accessToken,
          refreshToken,
          expiresIn: 86400,
          user: { id: user.id, email: user.email, name: user.name, role: user.role },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
/**
 * @swagger
 * /me:
 *   get:
 *     summary: GET /me
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/me', verifyToken, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'not_found', message: 'Usuario no encontrado.' });
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
