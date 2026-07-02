'use strict';
/**
 * Capability Validator — Sprint P4.0Q.1
 * MODULE 5: Validates capability registry, dependency graph, execution plan.
 * IAS-068: Capability Registry Certification
 */
const CapabilityValidator = {
  name: 'CapabilityValidator',
  validateDependencyGraph(graph) {
    const ids = new Set(Object.keys(graph));
    return Object.entries(graph).flatMap(([id, def]) =>
      (def.depends_on || []).filter(dep => !ids.has(dep))
        .map(dep => ({ rule:'GRAPH_001', capability:id, message:`Dependency '${dep}' not registered` })));
  },
  detectCycles(graph) {
    const visited = new Set(), inStack = new Set(), cycles = [];
    const visit = (id, path=[]) => {
      if (inStack.has(id)) { cycles.push([...path, id]); return; }
      if (visited.has(id)) return;
      inStack.add(id); visited.add(id);
      for (const dep of (graph[id]?.depends_on || [])) visit(dep, [...path, id]);
      inStack.delete(id);
    };
    Object.keys(graph).forEach(id => visit(id));
    return cycles;
  },
  validateExecutionPlan(plan, graph) {
    const errors = [];
    for (let i=0; i<plan.length; i++) {
      for (const dep of (graph[plan[i]]?.depends_on || [])) {
        const di = plan.indexOf(dep);
        if (di===-1) errors.push({ rule:'PLAN_001', capability:plan[i], message:`'${dep}' missing from plan` });
        else if (di>=i) errors.push({ rule:'PLAN_002', capability:plan[i], message:`'${plan[i]}' executes before '${dep}'` });
      }
    }
    return errors;
  },
  certifyRegistry(registry) {
    const graph = registry.getExecutionGraph();
    const plan  = registry.resolveExecutionPlan().map(c=>c.id);
    const graphErrors = CapabilityValidator.validateDependencyGraph(graph);
    const cycles      = CapabilityValidator.detectCycles(graph);
    const planErrors  = CapabilityValidator.validateExecutionPlan(plan, graph);
    const allErrors   = [...graphErrors, ...planErrors,
      ...cycles.map(c=>({ rule:'CYCLE', path:c, message:`Circular dependency: ${c.join(' → ')}` }))];
    return {
      certified: allErrors.length === 0 && cycles.length === 0,
      capability_count: Object.keys(graph).length,
      execution_plan: plan, dependency_graph: graph,
      cycles_detected: cycles.length, errors: allErrors,
      certified_at: new Date().toISOString()
    };
  }
};
module.exports = { CapabilityValidator };