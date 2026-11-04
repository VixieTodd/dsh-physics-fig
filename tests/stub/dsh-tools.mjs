// Test stub for @deepseek-ai/dsh-tools under the `dsh-stub` node condition.
// defineTool is an identity pass-through: it returns the definition object
// after checking the minimal contract (name, parameters, execute).

export function defineTool(def) {
  if (!def || typeof def.name !== 'string' || typeof def.execute !== 'function') {
    throw new Error('stub dsh-tools: defineTool requires { name, execute }');
  }
  return def;
}
