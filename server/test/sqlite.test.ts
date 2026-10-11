import { describe, it, expect } from 'vitest';
import { Database } from '../src/sqlite.js';

describe('node:sqlite wrapper', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  it('run/get/all with positional and named params', () => {
    const r = db.prepare('INSERT INTO t(name) VALUES(?)').run('a');
    expect(Number(r.lastInsertRowid)).toBe(1);
    expect(r.changes).toBe(1);
    db.prepare('INSERT INTO t(name) VALUES(@name)').run({ name: 'b' });
    expect((db.prepare('SELECT name FROM t WHERE id=?').get(2) as any).name).toBe('b');
    expect(db.prepare('SELECT * FROM t ORDER BY id').all().length).toBe(2);
    expect(db.prepare('SELECT * FROM t WHERE id=?').get(99)).toBeUndefined();
  });
  it('transaction commits, rolls back and nests', () => {
    const ins = db.prepare('INSERT INTO t(name) VALUES(?)');
    db.transaction((xs: string[]) => { for (const x of xs) ins.run(x); })(['c', 'd']);
    expect(() => db.transaction(() => { ins.run('e'); throw new Error('boom'); })()).toThrow('boom');
    const inner = db.transaction(() => { ins.run('f'); throw new Error('inner'); });
    db.transaction(() => { ins.run('g'); try { inner(); } catch { /* rolled back to savepoint */ } })();
    const names = (db.prepare('SELECT name FROM t ORDER BY id').all() as any[]).map((r) => r.name);
    expect(names).toEqual(['a', 'b', 'c', 'd', 'g']);
    expect(db.inTransaction).toBe(false);
  });
  it('pragma', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBeDefined();
  });
});
