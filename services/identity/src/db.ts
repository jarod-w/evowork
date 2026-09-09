import { DatabaseSync } from 'node:sqlite';

import { IDENTITY_DDL } from './schema.js';

export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export function openIdentityDb(path: string): SqliteLike {
  const raw = new DatabaseSync(path);
  const db = raw as unknown as SqliteLike;
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(IDENTITY_DDL);
  return db;
}
