// データの保持・ローカル操作・GASとの同期
//
// server: 最後にGASから取得したデータ（デモ時はデモデータ）
// queue : まだGASに送っていない操作。data = server に queue を順に適用したもの
import * as db from './db.js';
import { uid, debounce, today } from './util.js';
import { demoData } from './demo.js';

const EMPTY = () => ({ oshi: [], goods: [], events: [], lives: [], schedule: [], genres: [], expenses: [], savings: [], config: [], purchases: [] });
const DEFAULT_SETTINGS = {
  gasUrl: '', token: '', device: '', weekStart: 1,
  hidden: [], showMine: true, showTasks: true, showDone: false,
};

export const state = {
  server: EMPTY(),
  data: EMPTY(),
  queue: [],
  failed: [],
  settings: { ...DEFAULT_SETTINGS },
  meta: { lastSync: null },
  sync: { busy: false, error: '', netFail: false },
  persisted: null,
};

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn());

export const isDemo = () => !state.settings.gasUrl;
export const keyOf = (g) => `${g.Sheet}:${g.ID}`;
const TABLE_KEY = {
  Oshi: ['oshi', 'OshiID'], Events: ['events', 'EventID'], Lives: ['lives', 'LiveID'],
  Expenses: ['expenses', 'ExpenseID'], Savings: ['savings', 'SavingID'], Config: ['config', 'Key'],
};

// ───────── 起動 ─────────

export async function init() {
  const [server, queue, failed, settings, meta] = await Promise.all(
    ['server', 'queue', 'failed', 'settings', 'meta'].map((k) => db.get('kv', k)),
  );
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (!state.settings.device) state.settings.device = guessDevice();
  state.queue = queue || [];
  state.failed = failed || [];
  state.meta = meta || { lastSync: null };
  state.server = { ...EMPTY(), ...(server || (isDemo() ? demoData() : {})) };
  if (!server) await db.set('kv', 'server', state.server);
  recompute();
  if (navigator.storage?.persist) {
    state.persisted = await navigator.storage.persisted();
    if (!state.persisted) state.persisted = await navigator.storage.persist().catch(() => false);
  }
}

function guessDevice() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
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
    const i = list.findIndex((r) => r[key] === op.row[key]);
    if (op.row.Deleted) { if (i >= 0) list.splice(i, 1); return; }
    if (i >= 0) list[i] = { ...list[i], ...op.row };
    else list.push({ ...op.row });
    return;
  }
  const i = d.goods.findIndex((g) => g.Sheet === op.sheet && g.ID === op.id);
  if (i < 0) return;
  const g = d.goods[i];
  if (op.type === 'goods.delta') {
    g.Have = Math.max(0, (Number(g.Have) || 0) + op.delta);
    d.purchases.push({ date: op.date || '', sheet: op.sheet, id: op.id, delta: op.delta });
  }
  else if (op.type === 'goods.update') {
    if (op.fields.Deleted) d.goods.splice(i, 1);
    else Object.assign(g, op.fields);
  } else if (op.type === 'goods.image') g.Image = g.Image || 'local';
}

// ───────── ローカル操作 ─────────

const inflight = new Set();

async function commit(op) {
  op.opId = op.opId || uid('op');
  op.date = op.date || today();
  if (isDemo()) {
    applyOp(state.server, op);
    recompute();
    emit();
    await db.set('kv', 'server', state.server);
    return;
  } else {
    const last = state.queue[state.queue.length - 1];
    const same = last && !inflight.has(last.opId) && last.type === op.type && last.sheet === op.sheet && last.id === op.id;
    if (op.type === 'goods.delta' && same) {
      last.delta += op.delta; // 連打はまとめて1件にする
      if (last.delta === 0) state.queue.pop();
    } else if (op.type === 'goods.update' && same) {
      Object.assign(last.fields, op.fields);
    } else {
      state.queue.push(op);
    }
    recompute();
    emit();
    await db.set('kv', 'queue', state.queue);
    scheduleSync();
  }
}

export const goodsDelta = (g, delta) => commit({ type: 'goods.delta', sheet: g.Sheet, id: g.ID, delta });
export const goodsUpdate = (g, fields) => commit({ type: 'goods.update', sheet: g.Sheet, id: g.ID, fields, base: g.UpdatedAt || '' });

export async function goodsCreate(sheet, fields) {
  const id = uid('tmp');
  await commit({ type: 'goods.create', sheet, id, fields });
  return { Sheet: sheet, ID: id };
}

export async function goodsImage(g, dataUrl) {
  await db.set('images', keyOf(g), { fileId: null, dataUrl });
  await commit({ type: 'goods.image', sheet: g.Sheet, id: g.ID });
}

export function upsertRow(table, row, base = '') {
  return commit({ type: 'row.upsert', table, row, base });
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

// ───────── 設定 ─────────

export async function saveSettings(patch) {
  const wasDemo = isDemo();
  state.settings = { ...state.settings, ...patch };
  await db.set('kv', 'settings', state.settings);
  if (wasDemo && !isDemo()) {
    // デモから本番へ：デモデータを捨ててGASから取り直す
    state.server = EMPTY();
    state.queue = [];
    await Promise.all([db.set('kv', 'server', state.server), db.set('kv', 'queue', []), db.clear('images')]);
    recompute();
  }
  emit();
}

export async function resetDemo() {
  state.server = demoData();
  state.queue = [];
  await Promise.all([db.set('kv', 'server', state.server), db.set('kv', 'queue', []), db.clear('images')]);
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
  return JSON.stringify({ app: 'oshi-app', version: 1, exportedAt: new Date().toISOString(), server: state.server, queue: state.queue, settings }, null, 1);
}

export async function importJson(text) {
  const j = JSON.parse(text);
  if (j.app !== 'oshi-app' || !j.server) throw new Error('このアプリのバックアップではありません');
  state.server = { ...EMPTY(), ...j.server };
  state.queue = j.queue || [];
  await Promise.all([db.set('kv', 'server', state.server), db.set('kv', 'queue', state.queue)]);
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
  const row = state.data.config.find((r) => r.Key === key);
  return upsertRow('Config', { Key: key, Value: JSON.stringify(value) }, row?.UpdatedAt || '');
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
    const { data } = await call('pull');
    state.server = { ...EMPTY(), ...data };
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

async function pushQueue() {
  while (state.queue.length) {
    const batch = [];
    let size = 0;
    for (const op of state.queue) {
      let send = op;
      if (op.type === 'goods.image') {
        const img = await db.get('images', `${op.sheet}:${op.id}`);
        if (!img) { send = null; state.queue = state.queue.filter((o) => o !== op); continue; }
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
      if (r.status === 'conflict' || r.status === 'error') {
        if (r.status === 'conflict') conflicts++;
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
    // 送った変更でシート側の更新時刻が進むので、同じ行への後続の変更の基準時刻も進める
    for (const op of batch) {
      const r = byId[op.opId];
      if (r?.status !== 'ok' || !r.updatedAt) continue;
      const k = rowKey(op, r.id);
      state.queue.forEach((q) => { if ('base' in q && rowKey(q) === k) q.base = r.updatedAt; });
    }
    await Promise.all([db.set('kv', 'queue', state.queue), db.set('kv', 'failed', state.failed)]);
    if (conflicts) notify(`他の端末やシートの変更を優先しました（${conflicts}件）`);
    if (!done.size) throw new Error('GASから応答がありませんでした');
  }
}

function rowKey(op, id) {
  if (op.type === 'row.upsert') return `${op.table}:${op.row[TABLE_KEY[op.table][1]]}`;
  return `${op.sheet}:${id || op.id}`;
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
