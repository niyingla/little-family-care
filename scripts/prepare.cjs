const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// 共用规则只在一处维护；部署包各自携带依赖，云函数不跨目录引用。
for (const target of ['server', 'cloudfunctions/family/lib', 'cloudfunctions/reminder/lib']) {
  const dir = path.join(root, target);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'miniprogram/utils/domain.js'), path.join(dir, 'domain.js'));
  fs.copyFileSync(
    path.join(root, 'miniprogram/utils/activity-policy.js'),
    path.join(dir, 'activity-policy.js')
  );
}
for (const name of ['family', 'reminder']) {
  for (const file of [
    'service.cjs',
    'cloud.cjs',
    'activity.cjs',
    'birthdays.cjs',
    'photo-wall.cjs',
  ]) {
    const source = path.join(root, 'server', file);
    if (fs.existsSync(source))
      fs.copyFileSync(source, path.join(root, 'cloudfunctions', name, 'lib', file));
  }
}
console.log('已同步日历规则和云函数部署依赖');
