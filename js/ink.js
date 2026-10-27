// 手書き（Apple Pencil）。線はベクトルで保存し、どの画面サイズでも同じ位置に描き直す。
//
// 座標の持ち方
//   週の時間軸（page = 'grid'）: x = 2020-01-01 からの日数×100、y = 0時からの分×2
//     → 週の始まりの曜日や画面幅が変わってもずれない
//   メモ欄（page = 'memo:…'）: 幅を1000とした座標（高さも同じ単位）
import { subscribe, inkPut, inkDel, inkStrokes } from './store.js';
import { uid } from './util.js';

export const INK_COLORS = ['#1f1a2e', '#e11d48', '#2563eb', '#16a34a', '#a21caf', '#f59e0b'];
const WIDTH = { pen: 2.2, marker: 12 };

export const tool = { mode: false, kind: 'pen', color: INK_COLORS[0], finger: false };
try { Object.assign(tool, JSON.parse(localStorage.getItem('ink-tool') || '{}'), { mode: false }); } catch { /* 既定値 */ }
const saveTool = () => { try { const { mode, ...t } = tool; localStorage.setItem('ink-tool', JSON.stringify(t)); } catch { /* 無視 */ } };

let drawingCount = 0;
/** 書いている最中か（同期による再描画で線が途切れないようにする） */
export const isDrawing = () => drawingCount > 0;

const undoStack = [];
const redoStack = [];

// ───────── 座標の変換 ─────────

const EPOCH = Date.UTC(2020, 0, 1);
export const dayIndex = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 864e5);
};

export function encode(pts) {
  let px = 0;
  let py = 0;
  return pts.map(([x, y]) => { const s = `${x - px},${y - py}`; px = x; py = y; return s; }).join(',');
}
export function decode(str) {
  const n = String(str || '').split(',').map(Number);
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < n.length; i += 2) { x += n[i]; y += n[i + 1]; out.push([x, y]); }
  return out;
}

const parsed = new WeakMap();
function parse(stroke) {
  let p = parsed.get(stroke);
  if (!p) {
    let d = {};
    try { d = JSON.parse(stroke.data); } catch { /* 壊れた線は描かない */ }
    const pts = decode(d.p);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    p = { kind: d.t || 'pen', color: d.c || INK_COLORS[0], width: Number(d.w) || WIDTH.pen, pts, minX: Math.min(...xs), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    parsed.set(stroke, p);
  }
  return p;
}

/** 週の時間軸用の変換 */
export function gridMapping(startYmd, days, hourH) {
  const d0 = dayIndex(startYmd);
  return (canvas) => {
    const colW = canvas.clientWidth / days;
    return {
      page: 'grid',
      match: (s, p) => s.page === 'grid' && p.maxX >= d0 * 100 && p.minX <= (d0 + days) * 100,
      toPx: ([x, y]) => [(x / 100 - d0) * colW, (y / 120) * hourH],
      fromPx: (px, py) => [Math.round((d0 + px / colW) * 100), Math.round((py / hourH) * 120)],
      scale: colW / 100,
    };
  };
}

/** メモ欄用の変換 */
export function memoMapping(page) {
  return (canvas) => {
    const W = canvas.clientWidth || 1;
    return {
      page,
      match: (s) => s.page === page,
      toPx: ([x, y]) => [(x / 1000) * W, (y / 1000) * W],
      fromPx: (px, py) => [Math.round((px / W) * 1000), Math.round((py / W) * 1000)],
      scale: W / 400,
      autoHeight: true,
    };
  };
}

export function pageHasInk(page) {
  for (const s of inkStrokes()) if (s.page === page) return true;
  return false;
}

// ───────── 描画 ─────────

const mounts = new Set();
subscribe((kind) => { if (kind === 'ink') redrawAll(); });
export function redrawAll() {
  for (const m of mounts) { if (!m.canvas.isConnected) mounts.delete(m); else m.redraw(); }
}

function drawStroke(ctx, p, map) {
  if (p.pts.length === 0) return;
  ctx.save();
  ctx.strokeStyle = p.color;
  ctx.fillStyle = p.color;
  ctx.globalAlpha = p.kind === 'marker' ? 0.35 : 1;
  ctx.lineWidth = Math.max(0.8, p.width * map.scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const pts = p.pts.map(map.toPx);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) {
    ctx.arc(pts[0][0], pts[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * canvas に手書きを表示する。editable のときは Pencil（とマウス）で書ける。
 * mappingFn(canvas) は上の gridMapping / memoMapping の戻り値
 */
export function mountInk(canvas, mappingFn, { editable = false, minHeightUnits = 700 } = {}) {
  const ctx = canvas.getContext('2d');
  let map = mappingFn(canvas);
  let live = null; // 書いている途中の点
  let erased = [];

  const visible = () => {
    const out = [];
    for (const s of inkStrokes()) { const p = parse(s); if (map.match(s, p)) out.push([s, p]); }
    return out;
  };

  function resize() {
    map = mappingFn(canvas);
    if (map.autoHeight) {
      const maxY = Math.max(minHeightUnits, ...visible().map(([, p]) => p.maxY + 260));
      canvas.style.height = `${(maxY / 1000) * canvas.clientWidth}px`;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function redraw() {
    resize();
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const [, p] of visible()) drawStroke(ctx, p, map);
    if (live) drawStroke(ctx, { kind: tool.kind, color: tool.color, width: WIDTH[tool.kind] || WIDTH.pen, pts: live }, map);
  }

  const m = { canvas, redraw };
  mounts.add(m);
  new ResizeObserver(() => redraw()).observe(canvas);
  redraw();
  setDrawing(canvas, editable);

  if (!editable) return m;

  const allowed = (e) => tool.mode && (e.pointerType === 'pen' || e.pointerType === 'mouse' || (tool.finger && e.pointerType === 'touch'));
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return map.fromPx(e.clientX - r.left, e.clientY - r.top);
  };
  // Pencil で画面がスクロールしないようにする（指のスクロールはそのまま）
  const blockStylus = (e) => {
    if (!tool.mode) return;
    if (tool.finger || [...e.changedTouches].some((t) => t.touchType === 'stylus')) e.preventDefault();
  };
  canvas.addEventListener('touchstart', blockStylus, { passive: false });
  canvas.addEventListener('touchmove', blockStylus, { passive: false });

  let active = null; // 書いているポインターのID
  canvas.addEventListener('pointerdown', (e) => {
    if (!allowed(e) || active !== null) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* キャプチャできなくても書ける */ }
    active = e.pointerId;
    drawingCount++;
    if (tool.kind === 'eraser') { erased = []; eraseAt(e); return; }
    live = [local(e)];
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) return;
    if (tool.kind === 'eraser') { eraseAt(e); return; }
    if (!live) return;
    const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const evs = co.length ? co : [e];
    for (const ev of evs) {
      const q = local(ev);
      const last = live[live.length - 1];
      if (Math.abs(q[0] - last[0]) + Math.abs(q[1] - last[1]) < 1) continue;
      live.push(q);
      // 書いている途中は増えた区間だけ描く（確定後に全体を描き直す）
      drawStroke(ctx, { kind: tool.kind, color: tool.color, width: WIDTH[tool.kind] || WIDTH.pen, pts: [last, q] }, map);
    }
  });
  const finish = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* 既に外れている */ }
    drawingCount = Math.max(0, drawingCount - 1);
    if (tool.kind === 'eraser') {
      if (erased.length) { undoStack.push({ type: 'del', strokes: erased }); redoStack.length = 0; }
      erased = [];
      return;
    }
    if (!live) return;
    const stroke = { id: uid('s'), page: map.page, data: JSON.stringify({ t: tool.kind, c: tool.color, w: WIDTH[tool.kind] || WIDTH.pen, p: encode(live) }) };
    live = null;
    undoStack.push({ type: 'add', strokes: [stroke] });
    redoStack.length = 0;
    inkPut([stroke]);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  function eraseAt(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const hit = visible().filter(([, p]) => p.pts.some((q) => { const [px, py] = map.toPx(q); return Math.hypot(px - x, py - y) < 12; }));
    if (!hit.length) return;
    erased.push(...hit.map(([s]) => s));
    inkDel(hit.map(([s]) => s.id));
  }
  return m;
}

function setDrawing(canvas, editable) {
  const on = editable && tool.mode;
  canvas.classList.toggle('drawing', on);
  canvas.style.touchAction = on ? (tool.finger ? 'none' : 'pan-y') : '';
}

export function undo() {
  const a = undoStack.pop();
  if (!a) return;
  if (a.type === 'add') inkDel(a.strokes.map((s) => s.id));
  else inkPut(a.strokes);
  redoStack.push(a);
}
export function redo() {
  const a = redoStack.pop();
  if (!a) return;
  if (a.type === 'add') inkPut(a.strokes);
  else inkDel(a.strokes.map((s) => s.id));
  undoStack.push(a);
}

// ───────── 道具バー ─────────

export function toolbarHtml() {
  return `<div class="ink-bar" role="toolbar" aria-label="手書き">
    <button type="button" class="btn sm ${tool.mode ? 'primary' : ''}" data-ink="mode" aria-pressed="${tool.mode}">✏️ ${tool.mode ? '手書き中' : '手書き'}</button>
    ${tool.mode ? `
      <div class="seg">
        <button type="button" data-ink-kind="pen" aria-pressed="${tool.kind === 'pen'}" aria-label="ペン">🖊</button>
        <button type="button" data-ink-kind="marker" aria-pressed="${tool.kind === 'marker'}" aria-label="マーカー">🖍</button>
        <button type="button" data-ink-kind="eraser" aria-pressed="${tool.kind === 'eraser'}" aria-label="消しゴム">🧽</button>
      </div>
      <div class="ink-colors">${INK_COLORS.map((c) => `<button type="button" data-ink-color="${c}" aria-label="色" aria-pressed="${tool.color === c}" style="--c:${c}"></button>`).join('')}</div>
      <button type="button" class="icon-btn" data-ink="undo" aria-label="取り消し">↶</button>
      <button type="button" class="icon-btn" data-ink="redo" aria-label="やり直し">↷</button>
      <label class="small muted row" style="gap:4px"><input type="checkbox" data-ink="finger" ${tool.finger ? 'checked' : ''}>指でも書く</label>` : ''}
  </div>`;
}

export function bindToolbar(root, rerender) {
  root.querySelectorAll('[data-ink]').forEach((b) => {
    const a = b.dataset.ink;
    const fn = () => {
      if (a === 'mode') tool.mode = !tool.mode;
      if (a === 'undo') return undo();
      if (a === 'redo') return redo();
      if (a === 'finger') tool.finger = b.checked;
      saveTool();
      rerender();
    };
    b.addEventListener(a === 'finger' ? 'change' : 'click', fn);
  });
  root.querySelectorAll('[data-ink-kind]').forEach((b) => b.onclick = () => { tool.kind = b.dataset.inkKind; saveTool(); rerender(); });
  root.querySelectorAll('[data-ink-color]').forEach((b) => b.onclick = () => { tool.color = b.dataset.inkColor; if (tool.kind === 'eraser') tool.kind = 'pen'; saveTool(); rerender(); });
}
