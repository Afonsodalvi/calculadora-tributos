// Read-only access to the OFFICIAL calculator database (calculadora-pro.db, built from the
// Receita Federal flyway migrations of calculadora-rtc-regime-regular). One connection is
// shared by every module (Simples Nacional and Regime Regular read the same tables).
// Prepared statements are cached per SQL text.
import { DatabaseSync } from 'node:sqlite';

export function abrirBanco(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const cache = new Map();
  const q = (sql) => {
    let st = cache.get(sql);
    if (!st) { st = db.prepare(sql); cache.set(sql, st); }
    return st;
  };
  const all = (sql, params) => (params === undefined ? q(sql).all() : q(sql).all(params));
  const get = (sql, params) => (params === undefined ? q(sql).get() : q(sql).get(params)) ?? null;
  const count = (sql, params) => Number(Object.values(get(sql, params))[0]);
  const exists = (sql, params) => count(sql, params) > 0;
  return {
    all, get, count, exists,
    close: () => db.close(),
    versao: () => get(`SELECT VRBD_VERSAO_BASE_DADO v, VRBD_DATA d, VRBD_DESCRICAO s FROM VERSAO_BASE_DADO ORDER BY VRBD_ID DESC LIMIT 1`),
  };
}
