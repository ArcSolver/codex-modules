export interface SqlRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface SqlStatement<T = unknown> {
  run(...params: unknown[]): SqlRunResult;
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): SqlStatement<T>;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}
