// Adapter registry. An adapter exports { id, label, run(opts, onEvent) -> { cancel() } }.
// Add new agents (Codex CLI, Gemini CLI, API-key providers) by dropping a file
// here and registering it below.
const claudeCode = require('./claude-code');

const adapters = new Map([[claudeCode.id, claudeCode]]);

module.exports = {
  get: (id) => adapters.get(id),
  list: () => [...adapters.values()].map((a) => ({ id: a.id, label: a.label, models: a.models ?? [], efforts: a.efforts ?? [] })),
};
