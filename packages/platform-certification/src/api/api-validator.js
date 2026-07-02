'use strict';
/**
 * API Validator — Sprint P4.0Q.1
 * MODULE 2: Validates API responses against enterprise standards.
 * ADR-030: Enterprise API Response Standard
 */
const ApiValidator = {
  name: 'ApiValidator',
  validateEnvelope(response) {
    const errors = [];
    for (const f of ['success','data','metadata'])
      if (!(f in response)) errors.push({ rule:'ENVELOPE', field:f, message:`Response envelope missing '${f}'` });
    if (response.success === true && !response.data && response.data !== 0)
      errors.push({ rule:'ENVELOPE', field:'data', message:'Successful response must include data' });
    return errors;
  },
  validateMetadata(metadata) {
    if (!metadata) return [{ rule:'METADATA', field:'metadata', message:'metadata required' }];
    return ['request_id','correlation_id','generated_at']
      .filter(f => !metadata[f])
      .map(f => ({ rule:'METADATA', field:`metadata.${f}`, message:`metadata.${f} required` }));
  },
  validateHttpStatus(status, isSuccess) {
    const valid = isSuccess ? [200,201,202] : [400,401,403,404,422,500,503];
    if (!valid.includes(status))
      return [{ rule:'HTTP_STATUS', field:'status', message:`HTTP ${status} not standard for ${isSuccess?'success':'error'}` }];
    return [];
  },
  validateErrorResponse(response) {
    const errors = [];
    if (response.success !== false) errors.push({ rule:'ERROR_ENVELOPE', field:'success', message:'Error must have success: false' });
    if (!response.error?.code)    errors.push({ rule:'ERROR_ENVELOPE', field:'error.code', message:'error.code required' });
    if (!response.error?.message) errors.push({ rule:'ERROR_ENVELOPE', field:'error.message', message:'error.message required' });
    return errors;
  },
  validateApiResponse(response, options = {}) {
    const isSuccess = response.success === true;
    const errors = [
      ...ApiValidator.validateEnvelope(response),
      ...ApiValidator.validateMetadata(response.metadata),
      ...(options.status ? ApiValidator.validateHttpStatus(options.status, isSuccess) : []),
      ...(!isSuccess ? ApiValidator.validateErrorResponse(response) : []),
    ];
    return { valid: errors.length === 0, errors, endpoint: options.endpoint || 'unknown', validated_at: new Date().toISOString() };
  }
};
module.exports = { ApiValidator };