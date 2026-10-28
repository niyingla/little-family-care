const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
let count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (/\.(js|cjs)$/.test(file)) {
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
      count++;
    }
    if (file.endsWith('.json')) {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      count++;
    }
  }
}
walk(root);
const main = path.join(root, 'miniprogram/pages/index');
const handlers = {};
global.Page = (value) => Object.assign(handlers, value);
require(path.join(main, 'index.js'));
delete global.Page;
for (const dir of [main, path.join(main, 'templates')]) {
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.wxml'))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    // WXML条件必须是数据绑定；静态非空字符串会导致分支永远为真。
    for (const condition of source.matchAll(/wx:(?:if|elif)="([^"]+)"/g)) {
      if (!condition[1].startsWith('{{') || !condition[1].endsWith('}}')) {
        throw new Error(`${name}: 条件未使用WXML数据绑定`);
      }
    }
    for (const match of source.matchAll(/(?:bindtap|catchtap|bindinput|bindchange)="(\w+)"/g)) {
      if (typeof handlers[match[1]] !== 'function')
        throw new Error(`${name}: 未找到事件处理器 ${match[1]}`);
    }
    for (const match of source.matchAll(/<import src="([^"]+)"/g))
      if (!fs.existsSync(path.join(dir, match[1]))) throw new Error('WXML模板引用缺失');
  }
}
console.log(`结构检查通过：${count} 个JavaScript/JSON文件；页面事件和模板引用完整`);
