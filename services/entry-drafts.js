// Process-local drafts are scoped to one relationship; no device-storage persistence.
let activeScope = '';
let drafts = {};
function activate(scope) { if (scope !== activeScope) { drafts = {}; activeScope = scope; } }
function read(scope, id) {
  if (!scope || scope !== activeScope) return null;
  const value = drafts[id || 'new'];
  return value ? JSON.parse(JSON.stringify(value)) : null;
}
function write(scope, id, value) {
  if (scope && scope === activeScope) drafts[id || 'new'] = JSON.parse(JSON.stringify(value));
}
function remove(scope, id) { if (scope === activeScope) delete drafts[id || 'new']; }
module.exports = { activate, read, write, remove };
