'use strict';
class PlatformError extends Error {
  constructor(m, code, statusCode=500) {
    super(m); this.name='PlatformError'; this.code=code; this.statusCode=statusCode;
  }
}
class ValidationError    extends PlatformError { constructor(m,c='VALIDATION_ERROR',f=null)   { super(m,c,400); this.name='ValidationError';    this.field=f; } }
class AuthorizationError extends PlatformError { constructor(m,c='AUTHORIZATION_ERROR')        { super(m,c,403); this.name='AuthorizationError'; } }
class CapabilityError    extends PlatformError { constructor(m,c='CAPABILITY_ERROR')           { super(m,c,500); this.name='CapabilityError';    } }
class DependencyError    extends PlatformError { constructor(m,c='DEPENDENCY_ERROR')           { super(m,c,500); this.name='DependencyError';    } }
class PipelineError      extends PlatformError { constructor(m,c='PIPELINE_ERROR')             { super(m,c,500); this.name='PipelineError';      } }
class HealthError        extends PlatformError { constructor(m,c='HEALTH_ERROR')               { super(m,c,503); this.name='HealthError';        } }
const ERROR_STATUS_MAP = { ValidationError:400, AuthorizationError:403,
  CapabilityError:500, DependencyError:500, PipelineError:500, HealthError:503 };
function mapErrorStatus(e) { return e.statusCode || ERROR_STATUS_MAP[e.name] || 500; }
module.exports = { PlatformError, ValidationError, AuthorizationError,
  CapabilityError, DependencyError, PipelineError, HealthError,
  ERROR_STATUS_MAP, mapErrorStatus };