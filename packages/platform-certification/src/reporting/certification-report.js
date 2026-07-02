'use strict';
/**
 * Platform Certification Report — Sprint P4.0Q.1
 * MODULE 6: Aggregates all validators into a single certification report.
 * IAS-070: Platform Certification Report
 */
const { v4: uuidv4 } = require('uuid');
const { ContractValidator }     = require('../contract/contract-validator');
const { ApiValidator }          = require('../api/api-validator');
const { PerformanceValidator }  = require('../performance/performance-validator');
const { ArchitectureValidator } = require('../architecture/architecture-validator');
const { CapabilityValidator }   = require('../capability/capability-validator');
const CERTIFICATION_VERSION = '1.0.0';
class PlatformCertificationReport {
  constructor(platformName, platformVersion) {
    this.platformName=platformName; this.platformVersion=platformVersion;
    this.certificationId=uuidv4(); this.startedAt=new Date().toISOString(); this.results={};
  }
  addContractValidation(dtoName, dto, options={}) {
    this.results[`contract_${dtoName}`] = ContractValidator.validateDTO(dto, { dtoType:dtoName, ...options });
    return this;
  }
  addApiValidation(endpoint, response, options={}) {
    this.results[`api_${endpoint.replace(/\//g,'_')}`] = ApiValidator.validateApiResponse(response, { endpoint, ...options });
    return this;
  }
  addPerformanceValidation(label, ms, thresholdType) {
    this.results[`perf_${label}`] = PerformanceValidator.validateExecutionTime(ms, thresholdType);
    return this;
  }
  addCapabilityValidation(registry) {
    this.results['capability_registry'] = CapabilityValidator.certifyRegistry(registry);
    return this;
  }
  build() {
    const allResults = Object.values(this.results);
    const total      = allResults.length;
    const passed     = allResults.filter(r => r.valid!==false && r.passed!==false && r.certified!==false).length;
    const failed     = total - passed;
    const certified  = failed === 0;
    return {
      certification_id: this.certificationId, certification_version: CERTIFICATION_VERSION,
      platform: this.platformName, platform_version: this.platformVersion,
      certified,
      grade: certified ? (total >= 10 ? 'A+' : 'A') : failed<=2?'B':failed<=5?'C':'F',
      summary: { total_checks:total, passed, failed, pass_rate: total>0?Math.round((passed/total)*100):0 },
      results: this.results, all_errors: allResults.flatMap(r=>r.errors||[]),
      started_at: this.startedAt, completed_at: new Date().toISOString(),
    };
  }
}
module.exports = { PlatformCertificationReport, CERTIFICATION_VERSION };