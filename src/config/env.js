'use strict';

const Joi = require('joi');

const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(5000),
  API_URL: Joi.string().uri().required(),
  FRONTEND_URL: Joi.string().uri().required(),

  // Database
  DATABASE_URL: Joi.string().required(),
  DATABASE_POOL_MIN: Joi.number().default(2),
  DATABASE_POOL_MAX: Joi.number().default(10),
  DATABASE_SSL: Joi.boolean().default(true),

  // JWT
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRY: Joi.string().default('24h'),
  REFRESH_TOKEN_SECRET: Joi.string().min(32).required(),
  REFRESH_TOKEN_EXPIRY: Joi.string().default('7d'),

  // Email
  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().default(465),
  SMTP_SECURE: Joi.boolean().default(true),
  SMTP_USER: Joi.string().email().required(),
  SMTP_PASS: Joi.string().required(),
  SMTP_FROM: Joi.string().email().required(),
  SMTP_FROM_NAME: Joi.string().default('IncorERP Sistema'),

  // AWS
  AWS_ACCESS_KEY_ID: Joi.string().optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().optional(),
  AWS_REGION: Joi.string().default('us-east-1'),
  AWS_S3_BUCKET: Joi.string().optional(),
  AWS_S3_PRESIGNED_EXPIRY: Joi.number().default(3600),

  // Sentry
  SENTRY_DSN: Joi.string().uri().optional().allow(''),

  // Encryption
  ENCRYPTION_KEY: Joi.string().min(32).required(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: Joi.number().default(900000),
  RATE_LIMIT_MAX_REQUESTS: Joi.number().default(100),
  LOGIN_RATE_LIMIT_MAX: Joi.number().default(5),

  // 2FA
  TWO_FA_ISSUER: Joi.string().default('IncorERP'),
  TWO_FA_WINDOW: Joi.number().default(1),

  // Logging
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  LOG_FILE: Joi.string().default('logs/app.log'),

  // Allowed email domains
  ALLOWED_EMAIL_DOMAINS: Joi.string().default('incored.com.mx,zhada.mx,mika.mx'),
})
  .unknown(true);

const { error, value: validatedEnv } = envSchema.validate(process.env);

if (error) {
  throw new Error(`Environment validation error: ${error.message}`);
}

module.exports = validatedEnv;
