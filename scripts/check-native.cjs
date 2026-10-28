const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', 'miniprogram');
const install = process.env.WECHAT_DEVTOOLS_PATH;
if (!install) throw new Error('请先设置WECHAT_DEVTOOLS_PATH为已安装的微信开发者工具目录');
const compiler = path.join(install, 'resources', 'app.asar.unpacked', 'node_modules', 'wcc-exec');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'family-native-check-'));

/**
 * 收集源码文件，路径相对于小程序根目录以保留模板引用语义。
 * @param {string} directory 当前递归目录，不遍历项目之外的文件。
 * @param {string} extension wxml或wxss编译输入类型。
 * @returns {string[]} 官方编译器可识别的相对文件名。
 */
function sources(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file, extension);
    // 不把本地私有配置或业务数据交给模板编译器。
    return file.endsWith('.' + extension)
      ? ['./' + path.relative(root, file).split(path.sep).join('/')]
      : [];
  });
}
try {
  for (const extension of ['wxml', 'wxss']) {
    const executable = path.join(
      compiler,
      (extension === 'wxml' ? 'wcc' : 'wcsc') + (process.platform === 'win32' ? '.exe' : '')
    );
    if (!fs.existsSync(executable)) throw new Error('当前工具安装未提供可直接调用的官方编译器');
    const files = sources(root, extension);
    const result = spawnSync(
      executable,
      ['-o', path.join(temporary, extension + '.js'), ...files],
      { cwd: root, encoding: 'utf8', timeout: 40000, windowsHide: true }
    );
    // 编译失败保留完整定位信息，不能用结构检查通过代替原生模板校验。
    if (result.error || result.status !== 0)
      throw new Error(result.stderr || result.stdout || result.error?.message || '原生编译失败');
    console.log(`微信官方${extension.toUpperCase()}编译通过：${files.length}个文件`);
  }
} finally {
  // 删除范围限定为本次独占创建的临时目录，不碰项目或用户其他文件。
  if (path.resolve(temporary).startsWith(path.join(os.tmpdir(), 'family-native-check-')))
    fs.rmSync(temporary, { recursive: true, force: true });
}
