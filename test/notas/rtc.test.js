// Reforma (CBS/IBS/IS) fields read from the official sample invoices of calculadora-rtc-regime-regular.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lerNota } from '../../src/notas/modulo.js';

const ler = (f) => lerNota(readFileSync(new URL(`../fixtures/notas/oficiais/${f}`, import.meta.url)), f);

test('NFS-e com IBSCBS: competência, locais, operação e valores já calculados pela NFS-e', async () => {
  const n = await ler('nfse_valido_com_IBSCBS.xml');
  assert.equal(n.tpDoc, '91');
  assert.equal(n.servico.nbs, '101011100');
  assert.deepEqual(n.ibscbs, { cClassTrib: '000001', cst: '000' });
  assert.equal(n.rtc.dCompet, '2026-04-29');
  assert.equal(n.rtc.cLocalidadeIncid, '4113700');
  assert.equal(n.rtc.vISSQN, '50.00');
  assert.deepEqual(n.rtc.operacao, { finNFSe: '0', indFinal: '0', cIndOp: '070101', tpOper: '2', tpEnteGov: '1', indDest: '0' });
  assert.deepEqual(n.rtc.declarado, { vBC: '950.00', pRedutor: '0.00', pCBS: '0.90', pIBSUF: '0.10', pIBSMun: '0.00', vCBS: '8.55', vIBSUF: '0.95', vIBSMun: '0.00' });
});

test('NFS-e sem IBSCBS: sem classificação e sem valores declarados', async () => {
  const n = await ler('nfse_valido_sem_IBSCBS.xml');
  assert.equal(n.ibscbs.cClassTrib, null);
  assert.equal(n.rtc.declarado, null);
  assert.equal(n.rtc.cLocIncid, '4113700');
});

test('NF-e: município do destinatário, grupo IBSCBS com tributação regular e componentes da base', async () => {
  const n = await ler('nfe_valido.xml');
  assert.equal(n.tpDoc, '55');
  assert.equal(n.rtc.municipioDestinatario, '3304557');
  assert.equal(n.rtc.cMunFG, '2111300');
  const it = n.itens[0];
  assert.equal(it.ncm, '76071120');
  assert.equal(it.vProd, '2.00');
  assert.equal(it.rtc.ibscbs.cClassTrib, '200022');
  assert.deepEqual(it.rtc.ibscbs.tributacaoRegular, { cst: '000', cClassTrib: '000001' });
  assert.equal(it.rtc.is, null);
});

test('NFC-e: Imposto Seletivo do item e compra governamental', async () => {
  const n = await ler('nfce_valido.xml');
  assert.equal(n.tpDoc, '65');
  assert.equal(n.rtc.tpEnteGov, '1');
  const is = n.itens[0].rtc.is;
  assert.equal(is.cst, '000');
  assert.equal(is.cClassTrib, '000000');
  assert.equal(is.vIS, '150');
  assert.equal(n.itens[0].rtc.vICMS, '6812.24');
});
