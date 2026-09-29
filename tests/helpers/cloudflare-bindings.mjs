import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../worker/migrations');

// Minimal D1 binding over node:sqlite: prepare/bind/all/first/run and transactional batch.
export async function createTestD1() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(file => file.endsWith('.sql')).sort()) {
    database.exec(await readFile(path.join(MIGRATIONS_DIR, name), 'utf8'));
  }

  const toPlain = row => (row ? { ...row } : null);
  const run = (sql, params) => ({ meta: { changes: Number(database.prepare(sql).run(...params).changes) } });

  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind: (...values) => statement(sql, values),
      all: async () => ({ results: database.prepare(sql).all(...params).map(toPlain) }),
      first: async () => toPlain(database.prepare(sql).get(...params)),
      run: async () => run(sql, params)
    };
  }

  return {
    sqlite: database,
    prepare: sql => statement(sql),
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results = statements.map(item => run(item.sql, item.params));
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

export function createTestKv() {
  const entries = new Map();
  return {
    entries,
    async put(key, value, options = {}) {
      entries.set(key, { value: new Uint8Array(value).slice().buffer, metadata: options.metadata ?? null });
    },
    async getWithMetadata(key) {
      return entries.get(key) ?? { value: null, metadata: null };
    },
    async delete(key) {
      entries.delete(key);
    }
  };
}
