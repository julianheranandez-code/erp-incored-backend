#!/usr/bin/env node
'use strict';

/**
 * Backfill Runner — Sprint 5.3
 * Usage:
 *   node src/scripts/run-backfill.js --dry-run    (preview only)
 *   node src/scripts/run-backfill.js --execute     (live insert)
 *   node src/scripts/run-backfill.js --validate    (post-backfill check)
 *   node src/scripts/run-backfill.js --rollback    (delete backfill events)
 */

const { runBackfill, rollbackBackfill, validateBackfill } = require('../services/historical-backfill-service');

const args = process.argv.slice(2);
const isDryRun  = args.includes('--dry-run') || !args.includes('--execute');
const isExecute = args.includes('--execute');
const isValidate = args.includes('--validate');
const isRollback = args.includes('--rollback');

(async () => {
  try {
    if (isRollback) {
      console.log('🔄 Starting rollback...');
      const result = await rollbackBackfill();
      console.log(`✅ Rollback complete: ${result.deleted} events deleted`);
      process.exit(0);
    }

    if (isValidate) {
      console.log('🔍 Running post-backfill validation...');
      const result = await validateBackfill();
      console.log('Duplicates:', result.duplicates);
      console.log('Orphan reversals:', result.orphan_reversals);
      console.log('Null company:', result.null_company);
      console.log('Event summary:');
      result.event_summary.forEach(e =>
        console.log(`  ${e.event_type}: ${e.count} events, total=${e.total}`)
      );
      const passed = result.duplicates === 0 && result.orphan_reversals === 0 && result.null_company === 0;
      console.log(passed ? '✅ VALIDATION PASSED' : '❌ VALIDATION FAILED');
      process.exit(passed ? 0 : 1);
    }

    console.log(isExecute ? '🚀 LIVE BACKFILL STARTING...' : '🔍 DRY RUN STARTING...');
    const result = await runBackfill({ dryRun: !isExecute });
    console.log('\n=== BACKFILL RESULTS ===');
    console.log(`Mode:      ${result.dry_run ? 'DRY RUN' : 'LIVE'}`);
    console.log(`Processed: ${result.processed}`);
    console.log(`Created:   ${result.created}`);
    console.log(`Skipped:   ${result.skipped}`);
    console.log(`Errors:    ${result.errors}`);
    console.log(`Duration:  ${result.duration}ms`);
    console.log(`Batch ID:  ${result.batch_id}`);

    if (result.errors > 0) {
      console.log('\n❌ ERRORS DETECTED — Review logs before executing');
      process.exit(1);
    }
    console.log(isExecute ? '\n✅ BACKFILL COMPLETE' : '\n✅ DRY RUN COMPLETE — Run with --execute to insert');
    process.exit(0);
  } catch(err) {
    console.error('BACKFILL FATAL ERROR:', err.message);
    process.exit(1);
  }
})();
