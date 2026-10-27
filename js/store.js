// データの保持・ローカル操作・GASとの同期
//
// server: 最後にGASから取得したデータ（デモ時はデモデータ）
// queue : まだGASに送っていない操作。data = server に queue を順に適用したもの
// ink   : 手書きの線（量が多いので server とは別に持ち、差分だけ取得する）
//
// 2台をオフラインで使っても干渉しないよう、変更は「項目ごとの新しい値（fields）」と
// 「編集前に見ていた値（prev）」「編集した時刻（editedAt）」で送り、GAS側で項目ごとにまとめる。
import * as db from './db.js';
import { uid, debounce, today } from './util.js';
import { demoData } from './demo.js';

const EMPTY = () => ({
  oshi: [], goods: [], events: [], lives: [], schedule: [], genres: [], expenses: [], savings: [], config: [], purchases: [],
  memos: [], conflicts: [],
});
const DEFAULT_SETTINGS = {
  gasUrl: '', token: '', device: '', weekStart: 1,
  hidden: [], showMine: true, showTasks: true, showDone: false,
};

export const state = {
  server: EMPTY(),
  data: EMPTY(),
  ink: new Map(), // StrokeID → { id, page, data }
  queue: [],
  failed: [],
  settings: { ...DEFAULT_SETTINGS },
  meta: { lastSync: null, inkSince: '' },
  sync: { busy: false, error: '', netFail: false },
  persisted: null,
};

// kind: 'data'（全体の再描画が必要）/ 'ink'（手書きの再描画だけ）
const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
const emit = (kind = 'data') => listeners.forEach((fn) => fn(kind));

export const isDemo = () => !state.settings.gasUrl;
export const keyOf = (g) => `${g.Sheet}:${g.ID}`;
export const TABLE_KEY = {
  Oshi: ['oshi', 'OshiID'], Events: ['events', 'EventID'], Lives: ['lives', 'LiveID'],
  Expenses: ['expenses', 'ExpenseID'], Savings: ['savings', 'SavingID'], Config: ['config', 'Key'],
  Memos: ['memos', 'MemoID'], Conflicts: ['conflicts', 'ConflictID'],
};
const GOODS_FIELDS = ['Name', 'Sub', 'Person', 'Genre', 'Price', 'Want', 'Trade', 'Memo', 'Deleted'];

/** 比較用にそろえる（シートの値は文字列、TRUE/FALSE は大文字） */
export const norm = (v) => (v === true || String(v).toUpperCase() === 'TRUE' ? 'TRUE' : v === false || v == null ? '' : String(v));

// ───────── 起動 ─────────

export async function init() {
  const [server, queue, failed, settings, meta, ink] = await Promise.all(
    ['server', 'queue', 'failed', 'settings', 'meta', 'ink'].map((k) => db.get('kv', k)),
  );
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (!state.settings.device) state.settings.device = guessDevice();
  state.queue = (queue || []).map(upgradeOp);
  state.failed = failed || [];
  state.meta = { lastSync: null, inkSince: '', ...(meta || {}) };
  state.server = { ...EMPTY(), ...(server || (isDemo() ? demoData() : {})) };
  state.ink = new Map((ink || (isDemo() && !server ? demoData().ink || [] : [])).map((s) => [s.id, s]));
  if (!server) await db.set('kv', 'server', state.server);
  recompute();
  if (navigator.storage?.persist) {
    state.persisted = await navigator.storage.persisted();
    if (!state.persisted) state.persisted = await navigator.storage.persist().catch(() => false);
  }
}

/** v0.2 で溜まっていた操作（row に行全体）を新しい形にする */
function upgradeOp(op) {
  if (op.type !== 'row.upsert' || !op.row) return op;
  const key = TABLE_KEY[op.table][1];
  const { [key]: id, UpdatedAt, ...fields } = op.row;
  return { type: op.type, opId: op.opId, date: op.date, table: op.table, id, fields, prev: null, editedAt: new Date().toISOString() };
}

function guessDevice() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'PC';
}

function recompute() {
  const d = structuredClone(state.server);
  state.queue.forEach((op) => applyOp(d, op));
  state.data = d;
}

function applyOp(d, op) {
  if (op.type === 'goods.create') {
    if (Number(op.fields.Have) > 0) d.purchases.push({ date: op.date || '', sheet: op.sheet, id: op.id, delta: Number(op.fields.Have) });
    d.goods.push({ Sheet: op.sheet, ID: op.id, Name: '', Sub: '', Person: '', Genre: '', Price: 0, Have: 0, Want: 0, Trade: 0, Image: '', Memo: '', UpdatedAt: '', ...op.fields });
    return;
  }
  if (op.type === 'row.upsert') {
    const [coll, key] = TABLE_KEY[op.table];
    const list = d[coll];
    const i = list.findIndex((r) => r[key] === op.id);
    if (norm(op.fields.Deleted) === 'TRUE') { if (i >= 0) list.splice(i, 1); return; }
    if (op.table === 'Conflicts' && norm(op.fields.Resolved) === 'TRUE') { if (i >= 0) list.splice(i, 1); return; }
    if (i >= 0) list[i] = { ...list[i], ...op.fields };
    else list.push({ [key]: op.id, ...op.fields });
    return;
  }
  if (op.type === 'ink') return; // 手書きは state.ink に直接反映済み
  const i = d.goods.findIndex((g) => g.Sheet === op.sheet && g.ID === op.id);
  if (i < 0) return;
  const g = d.goods[i];
  if (op.type === 'goods.delta') {
    g.Have = Math.max(0, (Number(g.Have) || 0) + op.delta);
    d.purchases.push({ date: op.date || '', sheet: op.sheet, id: op.id, delta: op.delta });
  } else if (op.type === 'goods.update') {
    if (norm(op.fields.Deleted) === 'TRUE') d.goods.splice(i, 1);
    else Object.assign(g, op.fields);
  } else if (op.type === 'goods.image') g.Image = g.Image || 'local';
}

// ───────── ローカル操作 ─────────

const inflight = new Set();
const lastOpen = () => {
  const last = state.queue[state.queue.length - 1];
  return last && !inflight.has(last.opId) ? last : null;
};

async function commit(op) {
  op.opId = op.opId || uid('op');
  op.date = op.date || today();
  if (isDemo()) {
    applyOp(state.server, op);
    recompute();
    emit();
    await db.set('kv', 'server', state.server);
    return;
  }
  const last = lastOpen();
  const sameRow = last && last.type === op.type && last.sheet === op.sheet && last.table === op.table && last.id === op.id;
  if (op.type === 'goods.delta' && sameRow) {
    last.delta += op.delta; // 連打はまとめて1件にする
    if (last.delta === 0) state.queue.pop();
  } else if ((op.type === 'goods.update' || op.type === 'row.upsert') && sameRow) {
    // 続けて編集した分は1件にまとめる（prev は最初に見ていた値を残す）
    Object.assign(last.fields, op.fields);
    if (last.prev || op.prev) last.prev = { ...(op.prev || {}), ...(last.prev || {}) };
    last.editedAt = op.editedAt;
  } else {
    state.queue.push(op);
  }
  recompute();
  emit();
  await db.set('kv', 'queue', state.queue);
  scheduleSync();
}

export const goodsDelta = (g, delta) => commit({ type: 'goods.delta', sheet: g.Sheet, id: g.ID, delta });

export function goodsUpdate(g, fields) {
  const srv = state.server.goods.find((x) => x.Sheet === g.Sheet && x.ID === g.ID);
  const prev = srv ? Object.fromEntries(Object.keys(fields).filter((k) => GOODS_FIELDS.includes(k)).map((k) => [k, srv[k] ?? ''])) : null;
  return commit({ type: 'goods.update', sheet: g.Sheet, id: g.ID, fields, prev, editedAt: new Date().toISOString() });
}

export async function goodsCreate(sheet, fields) {
  const id = uid('tmp');
  await commit({ type: 'goods.create', sheet, id, fields });
  return { Sheet: sheet, ID: id };
}

export async function goodsImage(g, dataUrl) {
  await db.set('images', keyOf(g), { fileId: null, dataUrl });
  await commit({ type: 'goods.image', sheet: g.Sheet, id: g.ID });
}

/**
 * 行の追加・変更。row は行全体でよく、変わった項目だけを送る。
 * 削除は { ...row, Deleted: true }
 */
export function upsertRow(table, row) {
  const [coll, key] = TABLE_KEY[table];
  const id = row[key];
  const cur = state.data[coll].find((r) => r[key] === id);
  const srv = state.server[coll].find((r) => r[key] === id);
  const fields = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === key || k === 'UpdatedAt') continue;
    if (!cur || norm(v) !== norm(cur[k])) fields[k] = v === true ? 'TRUE' : v;
  }
  if (cur && !Object.keys(fields).length) return Promise.resolve();
  const prev = srv ? Object.fromEntries(Object.keys(fields).map((k) => [k, srv[k] ?? ''])) : null;
  return commit({ type: 'row.upsert', table, id, fields, prev, editedAt: new Date().toISOString() });
}

/** グッズ画像のdataURL。端末に無ければGASから取得してキャッシュする */
export async function loadImage(g) {
  const key = keyOf(g);
  const rec = await db.get('images', key);
  const pending = state.queue.some((o) => o.type === 'goods.image' && o.sheet === g.Sheet && o.id === g.ID);
  if (rec && (pending || isDemo() || !g.Image || g.Image === 'local' || rec.fileId === g.Image)) return rec.dataUrl;
  if (!g.Image || g.Image === 'local' || isDemo() || !navigator.onLine) return rec?.dataUrl || null;
  try {
    const { dataUrl } = await call('image', { fileId: g.Image });
    await db.set('images', key, { fileId: g.Image, dataUrl });
    return dataUrl;
  } catch {
    return rec?.dataUrl || null;
  }
}

// ───────── 手書き ─────────

const saveInk = debounce(() => db.set('kv', 'ink', [...state.ink.values()]), 400);

export const inkStrokes = () => state.ink.values();

/** 線を追加（取り消しの復元にも使う） */
export function inkPut(strokes) {
  strokes.forEach((s) => state.ink.set(s.id, s));
  queueInk(strokes, []);
}

export function inkDel(ids) {
  ids.forEach((id) => state.ink.delete(id));
  queueInk([], ids);
}

function queueInk(puts, dels) {
  saveInk();
  emit('ink');
  if (isDemo()) return;
  let op = lastOpen();
  if (!op || op.type !== 'ink') {
    op = { type: 'ink', opId: uid('op'), date: today(), puts: [], dels: [] };
    state.queue.push(op);
  }
  for (const s of puts) {
    op.puts = op.puts.filter((p) => p.id !== s.id).concat([s]);
    op.dels = op.dels.filter((d) => d !== s.id);
  }
  for (const id of dels) {
    const before = op.puts.length;
    op.puts = op.puts.filter((p) => p.id !== id);
    if (op.puts.length === before) op.dels.push(id); // まだ送っていない線なら、送らずに消すだけ
  }
  if (!op.puts.length && !op.dels.length) state.queue = state.queue.filter((o) => o !== op);
  db.set('kv', 'queue', state.queue);
  scheduleSync();
}

function applyInkRows(rows) {
  const pending = new Set(state.queue.filter((o) => o.type === 'ink').flatMap((o) => [...o.puts.map((p) => p.id), ...o.dels]));
  for (const r of rows) {
    if (pending.has(r.StrokeID)) continue; // この端末で変えたばかりの線は手元を優先
    if (norm(r.Deleted) === 'TRUE') state.ink.delete(r.StrokeID);
    else state.ink.set(r.StrokeID, { id: r.StrokeID, page: r.Page, data: r.Data });
  }
  if (rows.length) { saveInk(); emit('ink'); }
}

// ───────── 競合 ─────────

/** 競合を解決する。useOther=true なら、採用されなかった方の値に戻す */
export async function resolveConflict(c, useOther) {
  if (useOther) {
    if (TABLE_KEY[c.Table]) {
      const [coll, key] = TABLE_KEY[c.Table];
      const row = state.data[coll].find((r) => r[key] === c.RowID) || { [key]: c.RowID };
      const v = c.Field === 'Deleted' ? (String(c.OtherValue).startsWith('TRUE') ? 'TRUE' : '') : c.OtherValue;
      await upsertRow(c.Table, { ...row, [c.Field]: v });
    } else {
      const g = state.data.goods.find((x) => x.Sheet === c.Table && x.ID === c.RowID);
      if (g && GOODS_FIELDS.includes(c.Field)) await goodsUpdate(g, { [c.Field]: c.OtherValue });
    }
  }
  await upsertRow('Conflicts', { ...c, Resolved: 'TRUE' });
}

// ───────── 設定 ─────────

export async function saveSettings(patch) {
  const wasDemo = isDemo();
  state.settings = { ...state.settings, ...patch };
  apiChecked = false;
  await db.set('kv', 'settings', state.settings);
  if (wasDemo && !isDemo()) {
    // デモから本番へ：デモデータを捨ててGASから取り直す
    state.server = EMPTY();
    state.queue = [];
    state.ink = new Map();
    state.meta.inkSince = '';
    await Promise.all([db.set('kv', 'server', state.server), db.set('kv', 'queue', []), db.set('kv', 'ink', []), db.set('kv', 'meta', state.meta), db.clear('images')]);
    recompute();
  }
  emit();
}

export async function resetDemo() {
  const demo = demoData();
  state.server = demo;
  state.queue = [];
  state.ink = new Map((demo.ink || []).map((s) => [s.id, s]));
  await Promise.all([db.set('kv', 'server', state.server), db.set('kv', 'queue', []), db.set('kv', 'ink', [...state.ink.values()]), db.clear('images')]);
  recompute();
  emit();
}

export async function clearFailed() {
  state.failed = [];
  await db.set('kv', 'failed', []);
  emit();
}

export function exportJson() {
  const { token, ...settings } = state.settings;
  return JSON.stringify({ app: 'oshi-app', version: 2, exportedAt: new Date().toISOString(), server: state.server, ink: [...state.ink.values()], queue: state.queue, settings }, null, 1);
}

export async function importJson(text) {
  const j = JSON.parse(text);
  if (j.app !== 'oshi-app' || !j.server) throw new Error('このアプリのバックアップではありません');
  state.server = { ...EMPTY(), ...j.server };
  state.queue = (j.queue || []).map(upgradeOp);
  state.ink = new Map((j.ink || []).map((s) => [s.id, s]));
  await Promise.all([db.set('kv', 'server', state.server), db.set('kv', 'queue', state.queue), db.set('kv', 'ink', [...state.ink.values()])]);
  recompute();
  emit();
}

// ───────── 同期 ─────────

async function call(action, extra = {}) {
  const s = state.settings;
  const res = await fetch(s.gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: s.token, device: s.device, ...extra }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'トークンが違います' : j.error);
  return j;
}

export const ping = () => call('ping');
export const calendarSync = () => call('calendarSync');

/** Configシートの値（JSON）を読む */
export function getConfig(key, fallback) {
  const row = state.data.config.find((r) => r.Key === key);
  if (!row) return fallback;
  try { return JSON.parse(row.Value); } catch { return row.Value; }
}
export function setConfig(key, value) {
  return upsertRow('Config', { Key: key, Value: JSON.stringify(value) });
}

let notify = () => {};
export const onNotice = (fn) => { notify = fn; };

export async function sync() {
  if (isDemo() || state.sync.busy) return;
  if (!navigator.onLine) { emit(); return; }
  state.sync.busy = true;
  emit();
  try {
    await pushQueue();
    const { data } = await call('pull', { inkSince: state.meta.inkSince || '' });
    const { ink, ...rest } = data;
    state.server = { ...EMPTY(), ...rest };
    applyInkRows(ink || []);
    // 読み込み中に書かれた線を取りこぼさないよう、少しさかのぼって次回の基準にする
    state.meta.inkSince = new Date(new Date(data.serverTime).getTime() - 120000).toISOString();
    state.meta.lastSync = new Date().toISOString();
    await Promise.all([db.set('kv', 'server', state.server), db.set('kv', 'meta', state.meta)]);
    recompute();
    state.sync.error = '';
    state.sync.netFail = false;
  } catch (e) {
    // 通信自体ができないときはエラー扱いにせず、未送信のまま後で再送する
    state.sync.netFail = e instanceof TypeError;
    state.sync.error = state.sync.netFail ? '' : e.message || String(e);
    if (state.sync.netFail) setTimeout(sync, 30000);
  } finally {
    state.sync.busy = false;
    inflight.clear();
    emit();
  }
}

export const scheduleSync = debounce(sync, 1500);

// GASが新しい形式（項目ごとのマージ）に対応しているか。古いままだと変更が失われるので送らない
const API_VERSION = 3;
let apiChecked = false;
async function checkApi() {
  if (apiChecked) return;
  const j = await call('ping');
  if (!(Number(j.apiVersion) >= API_VERSION)) throw new Error('GASのコードが古いままです。新しいCode.gsに貼り替えて setup() を実行し、新しいバージョンでデプロイしてください（変更は端末に保存されています）');
  apiChecked = true;
}

async function pushQueue() {
  if (state.queue.length) await checkApi();
  while (state.queue.length) {
    const batch = [];
    let size = 0;
    for (const op of state.queue) {
      let send = op;
      if (op.type === 'goods.image') {
        const img = await db.get('images', `${op.sheet}:${op.id}`);
        if (!img) { state.queue = state.queue.filter((o) => o !== op); continue; }
        send = { ...op, dataUrl: img.dataUrl };
      }
      size += JSON.stringify(send).length;
      if (batch.length && size > 4e6) break;
      batch.push(send);
      if (batch.length >= 25) break;
    }
    if (!batch.length) break;
    batch.forEach((o) => inflight.add(o.opId));

    const res = await call('push', { ops: batch });
    for (const [tmp, real] of Object.entries(res.idMap || {})) await remapId(tmp, real);

    const byId = Object.fromEntries((res.results || []).map((r) => [r.opId, r]));
    const done = new Set();
    let conflicts = 0;
    for (const op of batch) {
      const r = byId[op.opId];
      if (!r) continue;
      done.add(op.opId);
      conflicts += r.conflicts || 0;
      if (r.status === 'error') {
        const { dataUrl, ...rest } = op;
        state.failed.push({ ...rest, status: r.status, message: r.message || '', at: new Date().toISOString() });
      }
      if (op.type === 'goods.image' && r.fileId) {
        const key = `${op.sheet}:${r.id}`;
        const img = await db.get('images', key);
        if (img) await db.set('images', key, { ...img, fileId: r.fileId });
      }
    }
    state.queue = state.queue.filter((o) => !done.has(o.opId));
    // 送った値がシートの値になったので、同じ行への後続の変更の「編集前の値」も進める
    for (const op of batch) {
      if (byId[op.opId]?.status !== 'ok' || !op.fields) continue;
      for (const q of state.queue) {
        if (!q.prev || q.type !== op.type || q.table !== op.table || q.sheet !== op.sheet || q.id !== (byId[op.opId].id || op.id)) continue;
        for (const k of Object.keys(q.prev)) if (k in op.fields) q.prev[k] = op.fields[k];
      }
    }
    await Promise.all([db.set('kv', 'queue', state.queue), db.set('kv', 'failed', state.failed)]);
    if (conflicts) notify(`同じ項目が別の端末でも変更されていました（${conflicts}件）。「その他 > 競合」で確認できます`);
    if (!done.size) throw new Error('GASから応答がありませんでした');
  }
}

/** 新規グッズの仮ID → シートで振られたID */
async function remapId(tmp, real) {
  for (const op of state.queue) {
    if (op.id !== tmp) continue;
    const img = await db.get('images', `${op.sheet}:${tmp}`);
    if (img) {
      await db.set('images', `${op.sheet}:${real}`, img);
      await db.del('images', `${op.sheet}:${tmp}`);
    }
    op.id = real;
  }
}
