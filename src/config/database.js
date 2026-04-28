'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

const {
  DATABASE_URL,
  DATABASE_POOL_MIN,
  DATABASE_POOL_MAX,
  DATABASE_SSL,
  NODE_ENV,
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  min: parseInt(DATABASE_POOL_MIN) || 2,
  max: parseInt(DATABASE_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: DATABASE_SSL === 'true' || NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// Log connection events
pool.on('connect', () => {
  logger.debug('New PostgreSQL client connected');
});

pool.on('acquire', () => {
  logger.debug('PostgreSQL client acquired from pool');
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error:', err);
});

pool.on('remove', () => {
  logger.debug('PostgreSQL client removed from pool');
});

/**
 * Execute a single query
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<object>} Query result
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executed', { query: text, duration, rows: result.rowCount });
    return result;
  } catch (error) {
    logger.error('Query error', { query: text, error: error.message });
    throw error;
  }
};

/**
 * Get a client from the pool for transactions
 * @returns {Promise<object>} Pool client with release method
 */
const getClient = async () => {
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  const release = client.release.bind(client);

  // Override query to log duration
  client.query = async (text, params) => {
    const start = Date.now();
    try {
      const result = await originalQuery(text, params);
      const duration = Date.now() - start;
      logger.debug('Transaction query', { query: text, duration });
      return result;
    } catch (error) {
      logger.error('Transaction query error', { query: text, error: error.message });
      throw error;
    }
  };

  // Override release to log
  client.release = () => {
    logger.debug('Client released to pool');
    release();
  };

  return client;
};

/**
 * Execute a transaction with automatic rollback on error
 * @param {Function} fn - Async function that receives the client
 * @returns {Promise<any>} Result of fn
 */
const withTransaction = async (fn) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Test database connectivity
 * @returns {Promise<boolean>}
 */
const testConnection = async () => {
  try {
    const result = await query('SELECT NOW() as time, version() as version');
    logger.info('Database connected', {
      time: result.rows[0].time,
      version: result.rows[0].version.split(' ')[0],
    });
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error.message);
    return false;
  }
};

/**
 * Set RLS context for current user (called after each request auth)
 * @param {object} client - DB client or pool
 * @param {number} userId - Authenticated user ID
 * @param {string} role - User role
 */
const setRLSContext = async (client, userId, role) => {
  await client.query(`SET app.current_user_id = $1`, [userId]);
  await client.query(`SET app.current_user_role = $1`, [role]);
};

module.exports = {
  query,
  getClient,
  withTransaction,
  testConnection,
  setRLSContext,
  pool,
};
