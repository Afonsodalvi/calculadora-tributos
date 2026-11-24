// Rebuilds data/calculadora-pro.db from the OFFICIAL flyway migrations of
// https://github.com/ReceitaFederal/calculadora-rtc-regime-regular (folder flyway/sql),
// replaying them in Flyway order: callback beforeMigrate → baseline B0001 → V0002..Vnnnn →
// callback afterMigrate, on a single connection.
// Foreign-key enforcement is kept OFF: with it ON the official V0011 aborts at
// `DELETE FROM SITUACAO_TRIBUTARIA WHERE SITR_ID=26` (row still referenced), so the
// published data only exists with FK checks inactive. No FK has ON DELETE actions, so the
// resulting rows are exactly what the migrations insert/update/delete.
// The input folder is checked before anything is written, and the new base is built in
// <saida>.novo and renamed over <saida> only after every migration ran: a wrong path or a
// failing migration leaves the current base untouched.
//
//   node scripts/build-db.mjs <path-to>/flyway/sql [out.db]
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const USO = 'uso: node scripts/build-db.mjs <calculadora-rtc-regime-regular>/flyway/sql [saida.db]';
const EXIGIDOS = ['criacao/beforeMigrate.sql', 'criacao/B0001__sistema_tributario_completo.sql', 'criacao/afterMigrate.sql', 'manutencao'];

const [sqlDir, out = 'data/calculadora-pro.db'] = process.argv.slice(2);
if (!sqlDir) { console.error(USO); process.exit(2); }
const faltando = EXIGIDOS.filter((f) => !existsSync(join(sqlDir, ...f.split('/'))));
if (faltando.length) {
  console.error(`${USO}\nPasta de migrações inválida (${sqlDir}): falta ${faltando.join(', ')}. Nada foi alterado.`);
  process.exit(2);
}

const tmp = `${out}.novo`;
const limparTmp = () => { rmSync(tmp, { force: true }); rmSync(`${tmp}-journal`, { force: true }); };
limparTmp();

const db = new DatabaseSync(tmp, { enableForeignKeyConstraints: false, allowExtension: false });
let versao;
try {
  const run = (file) => {
    const sql = readFileSync(file, 'utf8');
    // untrusted-input guard: these SQL files must be plain DDL/DML
    if (/^\s*\.|\bATTACH\b|\bload_extension\b|\bwritefile\b|\breadfile\b/im.test(sql.replace(/--.*$/gm, ''))) {
      throw new Error(`Comando não permitido em ${file}`);
    }
    db.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;/gim, ''));
    console.log('OK', file.split(/[\\/]/).pop());
  };
  run(join(sqlDir, 'criacao', 'beforeMigrate.sql'));
  run(join(sqlDir, 'criacao', 'B0001__sistema_tributario_completo.sql'));
  const versions = readdirSync(join(sqlDir, 'manutencao'))
    .filter((f) => /^V\d+__.*\.sql$/.test(f))
    .sort((a, b) => Number(/^V(\d+)/.exec(a)[1]) - Number(/^V(\d+)/.exec(b)[1]));
  for (const f of versions) run(join(sqlDir, 'manutencao', f));
  run(join(sqlDir, 'criacao', 'afterMigrate.sql'));
  versao = db.prepare('SELECT VRBD_VERSAO_BASE_DADO v FROM VERSAO_BASE_DADO ORDER BY VRBD_ID DESC LIMIT 1').get()?.v;
  if (!versao) throw new Error('VERSAO_BASE_DADO vazia depois das migrações.');
  db.close();
} catch (e) {
  try { db.close(); } catch { /* already closed */ }
  limparTmp();
  console.error(`Falhou: ${e.message}\nA base atual (${out}) não foi alterada.`);
  process.exit(1);
}
renameSync(tmp, out);
console.log('versão da base:', versao, `→ ${out}`);
