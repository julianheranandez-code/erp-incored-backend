'use strict';
/**
 * Contract Validator — Sprint P4.0Q.1
 * MODULE 1: Validates DTO contracts against v1.0 rules.
 */
const SCHEMA_VERSION = 'v1.0';
const ContractValidator = {
  name: 'ContractValidator',
  validateCollectionsNotNull(dto, fields) {
    return fields.filter(f => {
      const val = f.split('.').reduce((o,k)=>o?.[k], dto);
      return val === null || val === undefined;
    }).map(f => ({ rule:'RULE_1', field:f, message:`${f} must be [] not null. RULE 1 violated.` }));
  },
  validateAmountBase(dto, fields) {
    return fields.filter(f => {
      const val = f.split('.').reduce((o,k)=>o?.[k], dto);
      return val !== undefined && typeof val !== 'number';
    }).map(f => ({ rule:'RULE_5', field:f, message:`${f} must be a number (amount_base). RULE 5 violated.` }));
  },
  validateProjectionMarker(dto) {
    if ('is_projection' in dto && dto.is_projection !== true)
      return [{ rule:'RULE_8', field:'is_projection', message:'Forecast DTO must have is_projection: true. RULE 8 violated.' }];
    return [];
  },
  validateSchemaVersion(dto) {
    const meta = dto.meta || dto;
    const version = meta.schema_version;
    if (!version) return [{ rule:'SCHEMA_VERSION', field:'meta.schema_version', message:'schema_version required' }];
    if (version !== SCHEMA_VERSION) return [{ rule:'SCHEMA_VERSION', field:'meta.schema_version', message:`Expected ${SCHEMA_VERSION}, got ${version}` }];
    return [];
  },
  validateMetadata(dto) {
    const meta = dto.meta;
    if (!meta) return [{ rule:'BASE_META', field:'meta', message:'meta (BaseMetadataDTO) required' }];
    return ['schema_version','engine_version','generated_at','request_id','correlation_id']
      .filter(f => !meta[f])
      .map(f => ({ rule:'BASE_META', field:`meta.${f}`, message:`meta.${f} required` }));
  },
  validateDataQuality(dto) {
    const valid = ['HIGH','MEDIUM','LOW','INSUFFICIENT'];
    if ('data_quality' in dto && !valid.includes(dto.data_quality))
      return [{ rule:'DATA_QUALITY', field:'data_quality', message:`data_quality must be: ${valid.join(', ')}` }];
    return [];
  },
  validateDTO(dto, options = {}) {
    const errors = [
      ...ContractValidator.validateSchemaVersion(dto),
      ...ContractValidator.validateMetadata(dto),
      ...ContractValidator.validateDataQuality(dto),
      ...ContractValidator.validateCollectionsNotNull(dto, options.collections || []),
      ...ContractValidator.validateAmountBase(dto, options.amountBaseFields || []),
      ...ContractValidator.validateProjectionMarker(dto),
    ];
    return { valid: errors.length === 0, errors, dto_type: options.dtoType || 'unknown', validated_at: new Date().toISOString() };
  }
};
module.exports = { ContractValidator };