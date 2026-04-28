'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://localhost/incored_erp_test';
process.env.JWT_SECRET = 'test-jwt-secret-minimum-32-characters-long-here';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-minimum-32-chars-here!!';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '1025';
process.env.SMTP_USER = 'test@test.com';
process.env.SMTP_PASS = 'test';
process.env.SMTP_FROM = 'test@test.com';
process.env.API_URL = 'http://localhost:5000';
process.env.FRONTEND_URL = 'http://localhost:3000';

const request = require('supertest');
const app = require('../src/app');

describe('Auth Endpoints', () => {
  const testEmail = `test_${Date.now()}@incored.com.mx`;
  let accessToken;
  let refreshToken;

  // ─── POST /api/auth/signup ────────────────────────────────────────────────
  describe('POST /api/auth/signup', () => {
    it('should reject missing fields', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .send({ email: 'bad@example.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });

    it('should reject weak passwords', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .send({ email: testEmail, password: '1234', name: 'Test', company_id: 1, role: 'operative' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });
  });

  // ─── POST /api/auth/login ─────────────────────────────────────────────────
  describe('POST /api/auth/login', () => {
    it('should return 401 for unknown email', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@incored.com.mx', password: 'Whatever123!' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('should return 400 for missing password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@incored.com.mx' });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/auth/refresh ───────────────────────────────────────────────
  describe('POST /api/auth/refresh', () => {
    it('should reject invalid refresh token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/auth/me (no token) ─────────────────────────────────────────
  describe('GET /api/auth/me', () => {
    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });
  });

  // ─── Health checks ────────────────────────────────────────────────────────
  describe('Health endpoints', () => {
    it('GET /health should return ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  // ─── CORS ────────────────────────────────────────────────────────────────
  describe('CORS', () => {
    it('should allow requests from frontend origin', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000');
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });
  });
});
