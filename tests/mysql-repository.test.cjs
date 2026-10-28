const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mysqlOptions, createMySQLRepository } = require('../selfhost/mysql-repository.cjs');

test('跨云数据库拒绝缺少双向TLS证书或使用root账号的配置', () => {
  // 配置缺失时必须在连接前失败，不能回退为明文或无认证连接。
  const config = {
    host: '127.0.0.1',
    user: 'care_app',
    database: 'care_test',
    password: 'p'.repeat(32),
  };
  assert.throws(() => mysqlOptions(config), /TLS/);
  assert.throws(
    () => mysqlOptions({ ...config, ca: 'ca', cert: 'cert', key: 'key', user: 'root' }),
    /账号/
  );
  assert.throws(
    () =>
      mysqlOptions({
        ...config,
        ca: 'ca',
        cert: 'cert',
        key: 'key',
        database: 'db;DROP TABLE records',
      }),
    /数据库名/
  );
});

test('跨云配置不能通过调用方参数关闭证书及主机名验证', () => {
  // 防止连接库兼容默认值或配置覆盖使证书校验失效。
  const options = mysqlOptions({
    host: '127.0.0.1',
    serverName: 'family-db.local',
    user: 'care_app',
    database: 'care_test',
    password: 'p'.repeat(32),
    ca: 'ca',
    cert: 'cert',
    key: 'key',
    ssl: false,
  });
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.verifyIdentity, true);
  assert.equal(options.ssl.minVersion, 'TLSv1.2');
  assert.equal(options.multipleStatements, false);
});

test(
  '真实MySQL跨副本并发更新、失败回滚、筛选和大头像持久化',
  { skip: !process.env.MYSQL_TEST_CONFIG_FILE },
  async (t) => {
    const config = JSON.parse(fs.readFileSync(process.env.MYSQL_TEST_CONFIG_FILE, 'utf8'));
    // 测试仅接受独立测试库，不能对家庭正式数据执行清理或覆盖。
    assert.match(config.database, /_test$/);
    const first = await createMySQLRepository(config);
    const second = await createMySQLRepository(config);
    // 相同私有CA签发的连接也必须匹配指定主机身份，不能仅检查链受信任。
    await assert.rejects(
      createMySQLRepository({ ...config, serverName: 'wrong-family-db.local' }),
      /altnames|Hostname/
    );
    t.after(async () => {
      await first.close();
      await second.close();
    });
    const collection = `test_${Date.now()}`;
    await first.put(collection, 'counter', { ownerId: 'family-a', value: 0 });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).transaction(async (tx) => {
          const item = await tx.get(collection, 'counter');
          await new Promise((resolve) => setTimeout(resolve, 2));
          await tx.put(collection, 'counter', { ...item, value: item.value + 1 });
        })
      )
    );
    assert.equal((await second.get(collection, 'counter')).value, 12);
    await assert.rejects(
      first.transaction(async (tx) => {
        await tx.put(collection, 'rollback', { ownerId: 'family-a' });
        throw new Error('business rollback');
      }),
      /business rollback/
    );
    assert.equal(await second.get(collection, 'rollback'), null);
    await first.put(collection, 'other', { ownerId: 'family-b', value: 99 });
    assert.deepEqual(await second.list(collection, { ownerId: 'family-a' }, 10), [
      { ownerId: 'family-a', value: 12 },
    ]);
    assert.deepEqual(await second.list(collection, { value: '12' }, 10), []);
    assert.equal((await second.list(collection, { value: 12 }, 10)).length, 1);
    assert.deepEqual(await second.list(collection, { ownerId: "family-a' OR 1=1 --" }, 10), []);
    // 10MiB原图编码后约14MB，真实跨连接回读验证现有数据库报文上限足够。
    const avatar = Buffer.alloc(10 * 1024 * 1024, 7).toString('base64');
    await first.put(collection, 'avatar', { data: avatar });
    assert.equal((await second.get(collection, 'avatar')).data, avatar);
  }
);
