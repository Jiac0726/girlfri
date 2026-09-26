const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
let js = 0, json = 0;
function walk(dir) {
  for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
    if (['node_modules','.git','backups'].includes(item.name)) continue;
    const file = path.join(dir,item.name);
    if (item.isDirectory()) walk(file);
    else if (item.name.endsWith('.js')) { new vm.Script(fs.readFileSync(file,'utf8'),{filename:file}); js++; }
    else if (item.name.endsWith('.json')) { JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); json++; }
  }
}
walk(root);
const app = JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
for (const page of app.pages) {
  for (const ext of ['js','json','wxml','wxss']) {
    if (!fs.existsSync(path.join(root,page+'.'+ext))) throw new Error('Missing route file: '+page+'.'+ext);
  }
}
for (const tab of app.tabBar.list) if (!app.pages.includes(tab.pagePath)) throw new Error('Invalid tab '+tab.pagePath);
console.log('Source check passed: '+js+' JavaScript files, '+json+' JSON files, '+app.pages.length+' complete page routes.');
