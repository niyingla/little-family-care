const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { decodeDatabaseConfig } = require('../selfhost/runtime.cjs');

test('数据库配置兼容原始JSON与压缩格式，损坏或过大的配置拒绝加载', () => {
  const config = { host: 'example.test', cert: 'certificate\n'.repeat(100) };
  const raw = Buffer.from(JSON.stringify(config));
  // 相同配置在压缩迁移前后必须保持证书换行和字段完全一致。
  assert.deepEqual(decodeDatabaseConfig(raw.toString('base64')), config);
  assert.deepEqual(decodeDatabaseConfig(gzipSync(raw).toString('base64')), config);
  assert.throws(() => decodeDatabaseConfig(''), /配置/);
  assert.throws(() => decodeDatabaseConfig(Buffer.from('invalid').toString('base64')));
  // 对压缩输入设上界，错误配置不能耗尽启动进程内存。
  assert.throws(() => decodeDatabaseConfig(gzipSync(Buffer.alloc(70 * 1024)).toString('base64')));
});
