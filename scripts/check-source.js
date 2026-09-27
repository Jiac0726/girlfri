const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
let js = 0, json = 0;

function walk(dir, visitor) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'backups'].includes(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file, visitor);
    else visitor(file, item);
  }
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function resolveLocalModule(fromFile, request) {
  if (!request || !request.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [
    base,
    base + '.js',
    path.join(base, 'index.js'),
    base + '.wxml',
    path.join(base, 'index.wxml'),
  ];
  return candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

function collectJsClosure(entryFile) {
  const visited = new Set(), files = [];
  function visit(file) {
    if (!file || visited.has(file) || !file.endsWith('.js')) return;
    visited.add(file);
    files.push(file);
    const source = readText(file);
    const re = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = re.exec(source))) {
      const local = resolveLocalModule(file, match[1]);
      if (local && local.endsWith('.js')) visit(local);
    }
  }
  visit(entryFile);
  return files;
}

function collectWxmlClosure(entryFile) {
  const visited = new Set(), files = [];
  function visit(file) {
    if (!file || visited.has(file) || !file.endsWith('.wxml')) return;
    visited.add(file);
    files.push(file);
    const source = readText(file);
    const re = /<(?:import|include)\s+src=["']([^"']+)["']/g;
    let match;
    while ((match = re.exec(source))) {
      const local = resolveLocalModule(file, match[1]);
      if (local && local.endsWith('.wxml')) visit(local);
    }
  }
  visit(entryFile);
  return files;
}

function declaredHandlers(jsSource) {
  const names = new Set();
  const method = /(?:^|[,{;\n])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\([^)]*\)|:\s*(?:async\s+)?function\s*\()/g;
  let match;
  while ((match = method.exec(jsSource))) names.add(match[1]);
  return names;
}

function wxmlHandlers(wxmlSource) {
  const names = [];
  const re = /\b(?:bind|catch|capture-bind|capture-catch|mut-bind|mut-catch)[A-Za-z0-9_-]*\s*=\s*["']([A-Za-z_$][\w$]*)["']/g;
  let match;
  while ((match = re.exec(wxmlSource))) names.push(match[1]);
  return names;
}

function checkPageHandlers(route) {
  const pageJs = path.join(root, route + '.js');
  const pageWxml = path.join(root, route + '.wxml');
  const methods = new Set();
  for (const file of collectJsClosure(pageJs)) {
    for (const name of declaredHandlers(readText(file))) methods.add(name);
  }
  const missing = [];
  for (const file of collectWxmlClosure(pageWxml)) {
    for (const name of wxmlHandlers(readText(file))) {
      if (!methods.has(name)) missing.push(route + ': ' + name + ' <- ' + path.relative(root, file));
    }
  }
  return missing;
}

function sourceActions(file) {
  const source = readText(file), actions = new Set(), re = /\bcall\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(source))) actions.add(match[1]);
  return actions;
}

function backendActions(file) {
  const source = readText(file), actions = new Set(), re = /\bcase\s+['"]([^'"]+)['"]\s*:/g;
  let match;
  while ((match = re.exec(source))) actions.add(match[1]);
  return actions;
}

walk(root, (file, item) => {
  if (item.name.endsWith('.js')) {
    new vm.Script(readText(file), { filename: file });
    js++;
  } else if (item.name.endsWith('.json')) {
    JSON.parse(readText(file));
    json++;
  }
});

const app = JSON.parse(readText(path.join(root, 'app.json')));
for (const page of app.pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    if (!fs.existsSync(path.join(root, page + '.' + ext))) {
      throw new Error('Missing route file: ' + page + '.' + ext);
    }
  }
}
for (const tab of app.tabBar.list) {
  if (!app.pages.includes(tab.pagePath)) throw new Error('Invalid tab ' + tab.pagePath);
}

const handlerErrors = app.pages.flatMap(checkPageHandlers);
if (handlerErrors.length) {
  throw new Error('WXML handler checks failed:\n' + handlerErrors.join('\n'));
}

const clientActions = sourceActions(path.join(root, 'services/cloud.js'));
const serverActions = backendActions(path.join(root, 'cloudfunctions/renianApi/v2.js'));
const missingOnServer = [...clientActions].filter(action => !serverActions.has(action)).sort();
const missingOnClient = [...serverActions].filter(action => !clientActions.has(action)).sort();
if (missingOnServer.length || missingOnClient.length) {
  const details = [];
  if (missingOnServer.length) details.push('missing on server: ' + missingOnServer.join(', '));
  if (missingOnClient.length) details.push('missing in client service: ' + missingOnClient.join(', '));
  throw new Error('API action contract check failed: ' + details.join('; '));
}

console.log(
  'Source check passed: ' + js + ' JavaScript files, ' + json + ' JSON files, ' +
  app.pages.length + ' complete page routes, WXML handlers resolved, ' +
  clientActions.size + ' API actions matched.'
);
