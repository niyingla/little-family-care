const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const migration = require('../selfhost/relational/migration.cjs');
const {
  createRelationalRepository,
  relationalAccess,
} = require('../selfhost/relational/repository.cjs');
const { parseArguments } = require('../scripts/migrate-storage.cjs');
const { assertLegacyLayout } = require('../selfhost/mysql-repository.cjs');
const { createService } = require('../server/service.cjs');

/**
 * 使用实际SQLite事务验证分表SQL行为，适配的仅是两种数据库的DDL与upsert语法。
 * @param {object} t Node测试上下文，用于关闭本测试独占的内存库及临时备份目录。
 * @returns {object} 数据库、mysql2形状连接、私有备份路径及原始记录写入器。
 */
async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE care_records(collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(collection,id)); CREATE TABLE care_mutex(id INTEGER PRIMARY KEY); INSERT INTO care_mutex VALUES(1)'
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-migration-'));
  let sequence = 0;
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const connection = {
    async execute(sql, parameters = []) {
      // 不模拟业务仓库或数据；仅将生产SQL的方言转换为本机可执行语法。
      const translated = sql
        .replace(/ ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin/g, '')
        .replace(/ COMMENT '(?:[^']|'')*'/g, '')
        .replace(/,\s*KEY idx_\d+ \([^)]*\)/g, '')
        .replace(/ FOR UPDATE/g, '')
        .replace('INSERT IGNORE', 'INSERT OR IGNORE')
        .replace(/ON DUPLICATE KEY UPDATE/g, 'ON CONFLICT DO UPDATE SET')
        .replace(/VALUES\((`?\w+`?)\)/g, 'excluded.$1');
      const statement = db.prepare(translated);
      return /^\s*SELECT/i.test(translated)
        ? [statement.all(...parameters)]
        : [statement.run(...parameters)];
    },
    beginTransaction: async () => db.exec('BEGIN'),
    commit: async () => db.exec('COMMIT'),
    rollback: async () => db.exec('ROLLBACK'),
    release() {},
  };
  await migration.prepareSchema(connection);
  return {
    db,
    connection,
    options: () => ({
      writersPaused: true,
      backupFile: path.join(directory, `backup-${++sequence}.jsonl`),
    }),
    putLegacy(collection, id, body) {
      db.prepare(
        'INSERT INTO care_records VALUES(?,?,?) ON CONFLICT DO UPDATE SET body=excluded.body'
      ).run(collection, id, JSON.stringify(body));
    },
  };
}

test('迁移必须暂停写入；成功后保留旧表、私有备份和独立列，并逐项核对照片原字节', async (t) => {
  const f = await fixture(t);
  f.putLegacy('care_users', 'mum', { openid: 'private-wechat-id', subscribed: false });
  f.putLegacy('care_avatar_blobs', 'one.jpg', {
    base64: Buffer.from([255, 216, 0, 255]).toString('base64'),
  });
  await assert.rejects(migration.migrateLegacy(f.connection, {}), /暂停/);
  const options = f.options(),
    result = await migration.migrateLegacy(f.connection, options);
  assert.equal(result.count, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM care_records').get().total, 2);
  assert.equal(f.db.prepare('SELECT subscribed FROM care_users').get().subscribed, 0);
  assert.deepEqual(
    Buffer.from(f.db.prepare('SELECT image_bytes FROM care_image_blobs').get().image_bytes),
    Buffer.from([255, 216, 0, 255])
  );
  const backup = fs.readFileSync(options.backupFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(backup.length, 2);
  assert.equal(backup.find((r) => r.collection === 'care_users').body.openid, 'private-wechat-id');
  assert.equal(f.db.prepare('SELECT layout FROM care_storage_state').get().layout, 'ready');
  await assert.rejects(createRelationalRepository(f.connection), /未完成/);
});

test('迁移中途异常回滚新表、拒绝覆盖备份，原数据与此前有效副本均保留', async (t) => {
  const f = await fixture(t);
  f.putLegacy('care_users', 'mum', { openid: 'first', subscribed: false });
  const prior = f.options();
  await migration.migrateLegacy(f.connection, prior);
  f.putLegacy('care_users', 'mum', { openid: 'changed', subscribed: true });
  await assert.rejects(migration.migrateLegacy(f.connection, prior), /EEXIST/);
  const failing = {
    ...f.connection,
    execute: async (sql, parameters) => {
      if (sql.startsWith('INSERT INTO `care_users`')) throw new Error('simulated write failure');
      return f.connection.execute(sql, parameters);
    },
  };
  await assert.rejects(migration.migrateLegacy(failing, f.options()), /simulated/);
  assert.equal(f.db.prepare('SELECT openid FROM care_users').get().openid, 'first');
  assert.equal(
    JSON.parse(f.db.prepare('SELECT body FROM care_records').get().body).openid,
    'changed'
  );
  assert.equal(f.db.prepare('SELECT layout FROM care_storage_state').get().layout, 'ready');
});

test('迁移后旧表有新增写入则禁止激活，重新迁移后才可切换', async (t) => {
  const f = await fixture(t);
  f.putLegacy('care_users', 'mum', { openid: 'mum', subscribed: false });
  await migration.migrateLegacy(f.connection, f.options());
  f.putLegacy('care_users', 'dad', { openid: 'dad', subscribed: true });
  await assert.rejects(migration.activateLayout(f.connection, { writersPaused: true }), /已变化/);
  assert.equal(f.db.prepare('SELECT layout FROM care_storage_state').get().layout, 'ready');
  await migration.migrateLegacy(f.connection, f.options());
  assert.equal((await migration.activateLayout(f.connection, { writersPaused: true })).count, 2);
  await assert.rejects(migration.migrateLegacy(f.connection, f.options()), /已激活/);
});

test('回滚先同步切换后的新数据与审核隔离数据，不能退回过时的旧表快照', async (t) => {
  const f = await fixture(t);
  f.putLegacy('care_users', 'same', { openid: 'formal', subscribed: false });
  f.putLegacy('review_care_users', 'same', { openid: 'review', subscribed: false });
  await migration.migrateLegacy(f.connection, f.options());
  await migration.activateLayout(f.connection, { writersPaused: true });
  const pool = { ...f.connection, getConnection: async () => f.connection, end: async () => {} };
  const repo = await createRelationalRepository(pool);
  await repo.put('care_users', 'same', { openid: 'formal-new', subscribed: true });
  assert.equal((await repo.get('review_care_users', 'same')).openid, 'review');
  const result = await migration.rollbackLayout(f.connection, f.options());
  assert.equal(result.count, 2);
  const original = await migration.readLegacy(f.connection);
  assert.equal(original.find((r) => r.collection === 'care_users').body.openid, 'formal-new');
  assert.equal(original.find((r) => r.collection === 'review_care_users').body.openid, 'review');
  assert.equal(f.db.prepare('SELECT layout FROM care_storage_state').get().layout, 'legacy');
});

test('真实领域服务经分表仓库完成建宝宝、任务、打勾和撤销，失败不丢失子表历史', async (t) => {
  const f = await fixture(t);
  f.db.exec("UPDATE care_storage_state SET layout='active'");
  const pool = { ...f.connection, getConnection: async () => f.connection, end: async () => {} };
  const repo = await createRelationalRepository(pool),
    hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const service = createService(repo, {
    hash,
    randomId: () => crypto.randomBytes(16).toString('hex'),
    now: () => '2026-10-29T04:00:00Z',
    ownerOpenId: 'owner',
    templateId: '',
    sendMessage: async () => {},
  });
  await service.call('owner', 'createHome', { name: '妈妈' });
  await service.call('owner', 'saveBaby', { name: '宝宝', birthDate: '2026-01-31' });
  let snapshot = await service.call('owner', 'snapshot', {});
  const baby = snapshot.home.babies[0];
  await service.call('owner', 'saveTask', {
    babyIds: [baby.id],
    title: '喂奶',
    scope: 'baby',
    frequency: 'daily',
    startDate: '2026-10-29',
    assigneeId: '',
    notifyMemberId: '',
  });
  snapshot = await service.call('owner', 'snapshot', {});
  const task = snapshot.home.tasks[0];
  await service.call('owner', 'complete', {
    taskId: task.id,
    date: '2026-10-29',
    done: true,
    expectedRevision: 0,
  });
  await service.call('owner', 'complete', {
    taskId: task.id,
    date: '2026-10-29',
    done: false,
    expectedRevision: 1,
  });
  assert.equal((await repo.get('care_days', '2026-10-29')).events.length, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM care_execution_events').get().n, 2);
  assert.equal(f.db.prepare('SELECT birth_date FROM care_babies').get().birth_date, '2026-01-31');
  await assert.rejects(
    repo.transaction(async (tx) => {
      const home = await tx.get('care_home', 'home');
      home.members = [];
      await tx.put('care_home', 'home', home);
      throw new Error('abort');
    }),
    /abort/
  );
  assert.equal((await repo.get('care_home', 'home')).members.length, 1);
  assert.deepEqual(await repo.list('care_messages', { status: 'queued' }, 10), []);
  const access = relationalAccess(f.connection);
  assert.deepEqual(await access.list('care_home', { version: '3' }, 10), []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM care_records').get().n, 0);
});

test('命令行不接受明文口令、混合操作或不完整文件参数', () => {
  assert.throws(() => parseArguments(['--password', 'private']), /不支持/);
  assert.throws(() => parseArguments(['--config-file', '--migrate']), /文件/);
  assert.throws(() => parseArguments(['--config-file', 'x', '--migrate', '--activate']), /唯一/);
  assert.equal(parseArguments(['--config-file', 'private.json']).mode, 'inspect');
});

test('回滚后已创建的分表连接必须停止读写，不能继续产生第二套数据', async (t) => {
  const f = await fixture(t);
  f.putLegacy('care_users', 'mum', { openid: 'mum', subscribed: false });
  await migration.migrateLegacy(f.connection, f.options());
  await migration.activateLayout(f.connection, { writersPaused: true });
  const pool = { ...f.connection, getConnection: async () => f.connection, end: async () => {} };
  const repo = await createRelationalRepository(pool);
  await migration.rollbackLayout(f.connection, f.options());
  await assert.rejects(
    repo.put('care_users', 'late', { openid: 'late', subscribed: false }),
    /布局/
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM care_users WHERE record_id='late'").get().n,
    0
  );
});

test('应用账号缺少子表DELETE权限时在启动阶段失败，不能等家人保存资料时才报错', async (t) => {
  const f = await fixture(t);
  f.db.exec("UPDATE care_storage_state SET layout='active'");
  const pool = {
    execute: async (sql, parameters) => {
      if (sql.startsWith('DELETE FROM `care_members`'))
        throw Object.assign(new Error('missing delete'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
      return f.connection.execute(sql, parameters);
    },
  };
  await assert.rejects(createRelationalRepository(pool), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
});

test('已激活的数据库拒绝遗漏分表配置的实例启动，未激活时保留旧布局兼容', async (t) => {
  const f = await fixture(t);
  await assertLegacyLayout(f.connection);
  f.db.exec("UPDATE care_storage_state SET layout='active'");
  await assert.rejects(assertLegacyLayout(f.connection), /布局/);
  f.db.exec("UPDATE care_storage_state SET layout='legacy'");
  await assertLegacyLayout(f.connection);
});
