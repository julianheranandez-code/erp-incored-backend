'use strict';
class FeatureFlagManager {
  constructor(flags={}) { this._flags = { ...flags }; }
  isEnabled(flag) { return this._flags[flag] === true; }
  getAll()        { return { ...this._flags }; }
  enable(flag)    { this._flags[flag] = true; }
  disable(flag)   { this._flags[flag] = false; }
}
const defaultFlags = new FeatureFlagManager({
  ai_insights: false, ai_recommendations: false,
  forecast_engine: false, beta_workspace: false, plugin_sdk: false
});
module.exports = { FeatureFlagManager, defaultFlags };