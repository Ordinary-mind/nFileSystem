#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

async function main() {
  await run("CREATE VIRTUAL TABLE drive_search USING fts5(name, entity_id UNINDEXED, user_id UNINDEXED, tokenize='trigram')");
  await run('BEGIN');
  for (let index = 1; index <= 100_000; index += 1) {
    const marker = index % 997 === 0 ? '季度报告' : '普通文件';
    await run('INSERT INTO drive_search(name, entity_id, user_id) VALUES (?, ?, 1)', [`${marker}-${index}.txt`, index]);
  }
  await run('COMMIT');
  await get("SELECT COUNT(*) AS count FROM drive_search WHERE drive_search MATCH '季度报告' AND user_id = 1");
  const started = process.hrtime.bigint();
  const result = await get("SELECT COUNT(*) AS count FROM drive_search WHERE drive_search MATCH '季度报告' AND user_id = 1");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`10 万条索引，命中 ${result.count} 条，热查询 ${elapsedMs.toFixed(2)} ms`);
  if (elapsedMs > 500) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
