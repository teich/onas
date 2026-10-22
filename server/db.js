const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.ONAS_DB || '/var/lib/onas/onas.db';
const MIGRATIONS = path.join(__dirname, 'migrations');

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Apply migrations/NNN_*.sql in order; user_version records the last one applied.
function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const files = fs.readdirSync(MIGRATIONS).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = parseInt(file, 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    });
    console.log(`db: applied ${file}`);
  }
}
migrate();

// node:sqlite binds only null, numbers, bigints, strings and buffers.
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) return JSON.stringify(value);
  return value;
}

function bindRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = bindable(value);
  return out;
}

// Replace every row of a table in one transaction. Rows are objects keyed by column name.
function replaceTable(table, rows) {
  transaction(() => {
    db.prepare(`DELETE FROM ${table}`).run();
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]);
    const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => '$' + c).join(', ')})`);
    for (const row of rows) insert.run(bindRow(row));
  });
}

module.exports = { db, transaction, replaceTable, bindRow, DB_PATH };
