import { DatabaseSync } from 'node:sqlite';

import { SHARE_DDL } from './schema.js';

export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export function openShareDb(path: string): SqliteLike {
  const raw = new DatabaseSync(path);
  const db = raw as unknown as SqliteLike;
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SHARE_DDL);
  return db;
}
