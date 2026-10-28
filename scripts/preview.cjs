const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((item) =>
      item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]
    );
const bundle = () => {
  const data = {
    scripts: {},
    templates: {},
    style: fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8'),
  };
  for (const file of walk(path.join(root, 'miniprogram'))) {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    // 预览服务不把真实部署配置或任何密钥发到浏览器。
    if (relative.endsWith('config.local.js')) continue;
    if (file.endsWith('.js')) data.scripts[relative] = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.wxml')) data.templates[relative] = fs.readFileSync(file, 'utf8');
  }
  return `window.CARE_PREVIEW = ${JSON.stringify(data)};`;
};
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
http
  .createServer((request, response) => {
    if (request.url === '/preview-bundle.js') {
      response.setHeader('Content-Type', mime['.js']);
      response.end(bundle());
      return;
    }
    const target =
      request.url === '/'
        ? '/preview/index.html'
        : new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + decodeURIComponent(target));
    // 只开放预览与说明目录，阻止读取本地配置、Git目录等文件。
    if (
      !file.startsWith(path.join(root, 'preview') + path.sep) &&
      file !== path.join(root, 'setup.html')
    ) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    if (!fs.existsSync(file)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.setHeader('Content-Type', mime[path.extname(file)] || 'text/plain');
    response.end(fs.readFileSync(file));
  })
  .listen(4173, '127.0.0.1', () =>
    console.log('本地交互预览：http://127.0.0.1:4173（仅本机，不连接真实家庭）')
  );
