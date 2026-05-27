'use strict';

/**
 * IAM Cache Provider Abstraction — IAM Phase 2B
 * ───────────────────────────────────────────────
 * Abstract cache interface for effective permissions engine.
 * Current implementation: in-memory Map with TTL.
 *
 * FUTURE PROVIDER MIGRATION PATH:
 *   Replace MemoryCacheProvider with:
 *   - RedisCacheProvider (ioredis/node-redis)
 *   - DistributedCacheProvider (Redis Cluster)
 *   - PubSubInvalidationProvider (Redis pub/sub)
 *   - GovernanceEventCacheProvider (event-driven invalidation)
 *
 * MIGRATION: Only replace the export at the bottom.
 *   All callers use the same interface: get/set/delete/clearByPrefix
 */

class MemoryCacheProvider {
  constructor() {
    this._store = new Map();
  }

  /**
   * Get cached value. Returns null if missing or expired.
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > entry.ttlMs) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Set cached value with TTL in milliseconds.
   */
  set(key, value, ttlMs) {
    this._store.set(key, { value, ts: Date.now(), ttlMs });
    // Passive cleanup on large caches
    if (this._store.size > 500) this._cleanup();
  }

  /**
   * Delete a specific cache entry.
   */
  delete(key) {
    this._store.delete(key);
  }

  /**
   * Clear all entries whose key starts with prefix.
   * Used for user-level invalidation: clearByPrefix('user123:')
   */
  clearByPrefix(prefix) {
    let count = 0;
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) { this._store.delete(key); count++; }
    }
    return count;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._store.entries()) {
      if (now - entry.ts > entry.ttlMs) this._store.delete(key);
    }
  }

  size() { return this._store.size; }
}

// ─── SINGLETON INSTANCE ───────────────────────────────────────
// Single cache instance shared across IAM lib modules.
// Future: replace with RedisCacheProvider without changing callers.
const cacheProvider = new MemoryCacheProvider();

// Periodic cleanup every 5 minutes
setInterval(() => cacheProvider._cleanup(), 5 * 60 * 1000).unref();

module.exports = cacheProvider;
