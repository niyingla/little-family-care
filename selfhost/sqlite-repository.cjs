const { DatabaseSync } = require('node:sqlite');

/**
 * 单进程SQLite仓库。公共读取也经过队列，避免看到尚未提交的审批数据。
 * @param {string} filename SQLite文件路径，测试可传:memory:。
 * @returns {object} 与云数据库相同的get/put/list/transaction接口及close。
 */
function createSQLiteRepository(filename) {
  const db = new DatabaseSync(filename);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(collection,id))'
  );
  const read = db.prepare('SELECT body FROM records WHERE collection=? AND id=?');
  const write = db.prepare(
    'INSERT INTO records(collection,id,body) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body'
  );
  const list = db.prepare('SELECT body FROM records WHERE collection=? ORDER BY id');
  let pending = Promise.resolve();
  const direct = {
    async get(collection, id) {
      const row = read.get(collection, String(id));
      return row ? JSON.parse(row.body) : null;
    },
    async put(collection, id, value) {
      write.run(collection, String(id), JSON.stringify(value));
    },
  };
  const enqueue = (fn) => {
    // 即便上一个事务回滚，后续家庭请求仍可以继续执行。
    const task = pending.then(fn);
    pending = task.catch(() => {});
    return task;
  };
  return {
    get: (collection, id) => enqueue(() => direct.get(collection, id)),
    put: (collection, id, value) => enqueue(() => direct.put(collection, id, value)),
    list: (collection, filter, limit) =>
      enqueue(async () =>
        list
          .all(collection)
          .map((row) => JSON.parse(row.body))
          .filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value))
          .slice(0, limit)
      ),
    transaction: (fn) =>
      enqueue(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(direct);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }),
    close: () => enqueue(async () => db.close()),
  };
}
module.exports = { createSQLiteRepository };
