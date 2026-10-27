// 手書き（Apple Pencil）。線はベクトルで保存し、どの画面サイズでも同じ位置に描き直す。
//
// 座標の持ち方（「基準単位」。保存時は Q 倍して整数にする）
//   週の時間軸（page = 'grid'）: x = 2020-01-01 からの日数×100、y = 0時からの分×2
//     → 週の始まりの曜日や画面幅が変わってもずれない
//   メモ欄（page = 'memo:…'）: 幅を1000とした座標（高さも同じ単位）
//
// 書き心地のための工夫
//   - 書いている間は iOS のジェスチャー判定を止める（touch-action: none）。指のスクロールは自前で行う
//   - 書き途中の線は上に重ねた専用の層に、増えた区間だけ描く。確定した線だけを下の層に描き足す
//   - 筆圧で太さを変え、点の間は2次曲線でなめらかにつなぐ
//   - 描画中はレイアウトを読み直さない（書き始めに1回だけ測る）
import { subscribe, inkApply, inkStrokes } from './store.js';
import { uid } from './util.js';

export const INK_COLORS = ['#1f1a2e', '#e11d48', '#2563eb', '#16a34a', '#a21caf', '#f59e0b'];
export const SIZES = { pen: [1.2, 2, 3, 4.5, 7], marker: [8, 12, 18, 26], eraser: [6, 12, 22, 36] };
const Q = 10; // 保存時の倍率（基準単位の1/10まで残す）

export const tool = { kind: 'pen', color: INK_COLORS[0], finger: false, size: { pen: 1, marker: 1, eraser: 1 }, eraseWhole: false };
try {
  const saved = JSON.parse(localStorage.getItem('ink-tool') || '{}');
  Object.assign(tool, saved, { size: { ...tool.size, ...(saved.size || {}) } });
  delete tool.mode;
} catch { /* 既定値 */ }
const saveTool = () => { try { localStorage.setItem('ink-tool', JSON.stringify(tool)); } catch { /* 無視 */ } };
const sizeKeyOf = (k) => (k === 'eraser' ? 'eraser' : k === 'marker' ? 'marker' : 'pen');
const curWidth = () => SIZES[sizeKeyOf(tool.kind)][tool.size[sizeKeyOf(tool.kind)]] ?? 2;
const eraserR = () => SIZES.eraser[tool.size.eraser] ?? 12;

let drawingCount = 0;
let lastPenAt = 0;
const LONG_PRESS_MS = 550;

let toolChangeListener = () => {};
/** 長押しで道具が切り替わったときに道具バーを描き直すための通知先 */
export const onToolChange = (fn) => { toolChangeListener = fn; };
const notifyToolChange = () => toolChangeListener(tool.kind);
let penKindBeforeEraser = 'pen';
function toggleEraser() {
  if (tool.kind === 'eraser') tool.kind = penKindBeforeEraser;
  else { penKindBeforeEraser = tool.kind; tool.kind = 'eraser'; }
  saveTool();
  navigator.vibrate?.(15);
}
/** 書いている最中か（同期による再描画で線が途切れないようにする） */
export const isDrawing = () => drawingCount > 0;

const undoStack = [];
const redoStack = [];

// ───────── 保存形式 ─────────

const EPOCH = Date.UTC(2020, 0, 1);
export const dayIndex = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 864e5);
};

/** [[x, y, 筆圧0〜1], …]（基準単位）→ 差分の整数列。筆圧は0〜9 */
export function encode(pts) {
  let px = 0;
  let py = 0;
  return pts.map(([x, y, p]) => {
    const ix = Math.round(x * Q);
    const iy = Math.round(y * Q);
    const s = `${ix - px},${iy - py},${Math.max(0, Math.min(9, Math.round((p ?? 0.5) * 9)))}`;
    px = ix;
    py = iy;
    return s;
  }).join(',');
}
/** v1（x,y の組・倍率1）と v2（x,y,筆圧・倍率Q）の両方を読む */
export function decode(str, v = 1) {
  const n = String(str || '').split(',').map(Number);
  const out = [];
  let x = 0;
  let y = 0;
  if (v >= 2) {
    for (let i = 0; i + 2 < n.length; i += 3) { x += n[i]; y += n[i + 1]; out.push([x / Q, y / Q, n[i + 2] / 9]); }
  } else {
    for (let i = 0; i + 1 < n.length; i += 2) { x += n[i]; y += n[i + 1]; out.push([x, y, 0.5]); }
  }
  return out;
}

const parsed = new WeakMap();
function parse(stroke) {
  let p = parsed.get(stroke);
  if (!p) {
    let d = {};
    try { d = JSON.parse(stroke.data); } catch { /* 壊れた線は描かない */ }
    const pts = decode(d.p, d.v || 1);
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    p = { kind: d.t || 'pen', color: d.c || INK_COLORS[0], width: Number(d.w) || 2, pts, minX, maxX, minY, maxY };
    parsed.set(stroke, p);
  }
  return p;
}
const makeStroke = (page, style, pts) => ({ id: uid('s'), page, data: JSON.stringify({ v: 2, t: style.kind, c: style.color, w: style.width, p: encode(pts) }) });

// ───────── 座標の変換 ─────────

/** 週の時間軸用 */
export function gridMapping(startYmd, days, hourH) {
  const d0 = dayIndex(startYmd);
  return (canvas) => {
    const colW = canvas.clientWidth / days;
    return {
      page: 'grid',
      match: (s, p) => s.page === 'grid' && p.maxX >= d0 * 100 && p.minX <= (d0 + days) * 100,
      toPx: (x, y) => [(x / 100 - d0) * colW, (y / 120) * hourH],
      fromPx: (px, py) => [(d0 + px / colW) * 100, (py / hourH) * 120],
      scale: colW / 100,
    };
  };
}

/** メモ欄用 */
export function memoMapping(page) {
  return (canvas) => {
    const W = canvas.clientWidth || 1;
    return {
      page,
      match: (s) => s.page === page,
      toPx: (x, y) => [(x / 1000) * W, (y / 1000) * W],
      fromPx: (px, py) => [(px / W) * 1000, (py / W) * 1000],
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
let redrawQueued = false;
subscribe((kind) => { if (kind === 'ink') redrawAll(); });
/** 次のフレームでまとめて描き直す（消しゴムで連続して変わっても1回で済む） */
export function redrawAll() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    for (const m of mounts) { if (!m.canvas.isConnected) mounts.delete(m); else m.redraw(); }
  });
}

const pressureWidth = (base, p) => base * (0.35 + 1.25 * (p > 0 ? p : 0.5));

/** 点列（px＋筆圧）を描く。ペンは筆圧で太さを変えながら区間ごとに、マーカーは1本のパスで */
function paint(ctx, kind, color, width, P) {
  if (!P.length) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'marker') {
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(P[0][0], P[0][1]);
    if (P.length === 1) ctx.lineTo(P[0][0] + 0.01, P[0][1]);
    for (let i = 1; i < P.length - 1; i++) ctx.quadraticCurveTo(P[i][0], P[i][1], (P[i][0] + P[i + 1][0]) / 2, (P[i][1] + P[i + 1][1]) / 2);
    if (P.length > 1) ctx.lineTo(P[P.length - 1][0], P[P.length - 1][1]);
    ctx.stroke();
  } else if (P.length === 1) {
    ctx.beginPath();
    ctx.arc(P[0][0], P[0][1], pressureWidth(width, P[0][2]) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    penOutline(ctx, P, width);
  }
  ctx.restore();
}

/** ペンの線を「輪郭」で1回に塗る。筆圧の太さを左右に振り分け、なめらかな曲線でつなぐ */
function penOutline(ctx, P, width) {
  const n = P.length;
  const W = P.map((p) => pressureWidth(width, p[2]));
  const Ws = W.map((w, i) => (W[Math.max(0, i - 1)] + 2 * w + W[Math.min(n - 1, i + 1)]) / 4); // 太さの揺れをならす
  const L = [];
  const R = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(n - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const h = Ws[i] / 2;
    L.push([P[i][0] + nx * h, P[i][1] + ny * h]);
    R.push([P[i][0] - nx * h, P[i][1] - ny * h]);
  }
  ctx.beginPath();
  smoothTo(ctx, L, true);
  smoothTo(ctx, R.reverse(), false);
  ctx.closePath();
  ctx.fill();
  // 両端は丸く
  for (const i of [0, n - 1]) { ctx.beginPath(); ctx.arc(P[i][0], P[i][1], Ws[i] / 2, 0, Math.PI * 2); ctx.fill(); }
}

function smoothTo(ctx, pts, first) {
  if (first) ctx.moveTo(pts[0][0], pts[0][1]); else ctx.lineTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  if (pts.length > 1) ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
}

/** 書き途中のペン：増えた1区間だけを塗る（前の点と今の点を結ぶ太さつきの帯＋丸） */
function penLive(ctx, width, a, b) {
  const wa = pressureWidth(width, a[2]) / 2;
  const wb = pressureWidth(width, b[2]) / 2;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  ctx.beginPath();
  ctx.moveTo(a[0] + nx * wa, a[1] + ny * wa);
  ctx.lineTo(b[0] + nx * wb, b[1] + ny * wb);
  ctx.lineTo(b[0] - nx * wb, b[1] - ny * wb);
  ctx.lineTo(a[0] - nx * wa, a[1] - ny * wa);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(b[0], b[1], wb, 0, Math.PI * 2);
  ctx.fill();
}

function toPxPts(p, map) {
  return p.pts.map(([x, y, pr]) => { const q = map.toPx(x, y); return [q[0], q[1], pr]; });
}

/**
 * canvas に手書きを表示する。editable のときは Pencil（とマウス）で書ける。
 * mappingFn(canvas) は gridMapping / memoMapping の戻り値。minHeightPx はメモ欄の最低の高さ
 */
export function mountInk(canvas, mappingFn, { editable = false, minHeightPx = 0 } = {}) {
  const ctx = canvas.getContext('2d', { desynchronized: true });
  // 書き途中の線と消しゴムの円は、上に重ねた別の canvas に描く
  const liveCv = document.createElement('canvas');
  liveCv.className = 'ink-live';
  canvas.insertAdjacentElement('afterend', liveCv);
  const live = liveCv.getContext('2d', { desynchronized: true });
  let map = mappingFn(canvas);
  let size = [0, 0];

  const visible = () => {
    const out = [];
    for (const s of inkStrokes()) { const p = parse(s); if (map.match(s, p)) out.push([s, p]); }
    return out;
  };

  function fit() {
    map = mappingFn(canvas);
    if (map.autoHeight) {
      const units = Math.max(0, ...visible().map(([, p]) => p.maxY + 220));
      canvas.style.height = `${Math.max(minHeightPx, (units / 1000) * canvas.clientWidth)}px`;
    }
    // 重ねる層を同じ位置・大きさにする
    liveCv.style.left = `${canvas.offsetLeft}px`;
    liveCv.style.top = `${canvas.offsetTop}px`;
    liveCv.style.width = `${canvas.clientWidth}px`;
    liveCv.style.height = `${canvas.clientHeight}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (w !== size[0] || h !== size[1]) { // 大きさが変わったときだけ確保し直す
      size = [w, h];
      canvas.width = w; canvas.height = h; liveCv.width = w; liveCv.height = h;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      live.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function redraw() {
    fit();
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const [, p] of visible()) paint(ctx, p.kind, p.color, p.width * map.scale, toPxPts(p, map));
  }

  const m = { canvas, redraw };
  mounts.add(m);
  new ResizeObserver(() => redraw()).observe(canvas);
  redraw();
  // 指で書くときだけ上の層がタッチを受ける。Pencilは手書きボタンなしで、いつでも書ける
  const fingerDraw = editable && tool.finger;
  liveCv.classList.toggle('drawing', fingerDraw);
  if (!editable) return m;

  // ここから書く処理。Pencilの入力は、下にある予定やボタンより先に（キャプチャ段階で）受け取る
  const host = canvas.parentElement;
  let rect = null;
  let active = null;
  let pts = [];       // 書き途中の点（px＋筆圧）
  let downAt = 0;
  let downXY = null;
  let longTimer = 0;  // 長押しでペン↔消しゴム
  let switched = false;

  const usesPen = (e) => e.pointerType === 'pen' || (tool.finger && (e.pointerType === 'touch' || e.pointerType === 'mouse'));
  const inside = (e) => { const r = liveCv.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  const xy = (e) => [e.clientX - rect.left, e.clientY - rect.top, e.pointerType === 'pen' ? e.pressure : 0.5];

  // Pencilでスクロール・拡大鏡・選択が起きないようにし、書いている間とその直後は手のひらのタッチも止める
  const guardTouch = (e) => {
    const stylus = [...e.touches].some((t) => t.touchType === 'stylus');
    if (stylus || active !== null || Date.now() - lastPenAt < 500 || (tool.finger && inside(e.touches[0] || e.changedTouches[0]))) e.preventDefault();
  };
  host.addEventListener('touchstart', guardTouch, { passive: false });
  host.addEventListener('touchmove', guardTouch, { passive: false });

  host.addEventListener('pointerdown', (e) => {
    if (!usesPen(e) || !inside(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (active !== null) return;
    liveCv.style.pointerEvents = 'auto';
    try { liveCv.setPointerCapture(e.pointerId); } catch { /* なくても書ける */ }
    active = e.pointerId;
    drawingCount++;
    lastPenAt = Date.now();
    rect = liveCv.getBoundingClientRect();
    downAt = Date.now();
    downXY = [e.clientX, e.clientY];
    switched = false;
    clearTimeout(longTimer);
    longTimer = setTimeout(() => { // 動かさずに長押し → ペンと消しゴムを切り替える
      if (active === null) return;
      switched = true;
      toggleEraser();
      pts = [];
      live.clearRect(0, 0, liveCv.clientWidth, liveCv.clientHeight);
    }, LONG_PRESS_MS);
    if (tool.kind === 'eraser') { eraseBegin(); eraseAt(xy(e)); showEraser(xy(e)); return; }
    pts = [xy(e)];
    if (tool.kind !== 'marker') { live.fillStyle = tool.color; penLive(live, curWidth() * map.scale, pts[0], pts[0]); }
  }, { capture: true });

  liveCv.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active || switched) return;
    lastPenAt = Date.now();
    if (downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 4) { clearTimeout(longTimer); downXY = null; }
    const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const evs = co.length ? co : [e];
    if (tool.kind === 'eraser') { for (const ev of evs) eraseAt(xy(ev)); showEraser(xy(e)); return; }
    const kind = tool.kind;
    const w = curWidth() * map.scale;
    for (const ev of evs) {
      const q = xy(ev);
      const prev = pts[pts.length - 1];
      if (!prev) { pts.push(q); continue; }
      if (Math.abs(q[0] - prev[0]) + Math.abs(q[1] - prev[1]) < 0.6) continue;
      pts.push(q);
      if (kind !== 'marker') {
        live.fillStyle = tool.color;
        penLive(live, w, prev, q);
      }
    }
    if (kind === 'marker') { // 半透明は重ね描きすると濃くなるので、線全体を描き直す
      live.clearRect(0, 0, liveCv.clientWidth, liveCv.clientHeight);
      paint(live, kind, tool.color, w, pts);
    }
  });

  const finish = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    clearTimeout(longTimer);
    lastPenAt = Date.now();
    drawingCount = Math.max(0, drawingCount - 1);
    try { liveCv.releasePointerCapture(e.pointerId); } catch { /* 既に外れている */ }
    liveCv.style.pointerEvents = '';
    live.clearRect(0, 0, liveCv.clientWidth, liveCv.clientHeight);
    if (switched) { switched = false; if (gesture) eraseEnd(); notifyToolChange(); return; }
    if (tool.kind === 'eraser') { eraseEnd(); return; }
    if (!pts.length) return;
    // Pencilで軽くタップしただけなら、下にある予定やボタンを押したことにする
    if (pts.length === 1 && Date.now() - downAt < 300) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-item], [data-goday], button, a');
      if (el) { pts = []; el.click(); return; }
    }
    const style = { kind: tool.kind, color: tool.color, width: curWidth() };
    paint(ctx, style.kind, style.color, style.width * map.scale, pts); // 下の層にすぐ描いて、ちらつかせない
    const stroke = makeStroke(map.page, style, pts.map(([x, y, p]) => [...map.fromPx(x, y), p]));
    pts = [];
    undoStack.push({ puts: [stroke], dels: [] });
    redoStack.length = 0;
    inkApply([stroke], []);
  };
  liveCv.addEventListener('pointerup', finish);
  liveCv.addEventListener('pointercancel', finish);

  // ── 消しゴム ──
  let gesture = null; // この操作で消した元の線・作った線（取り消し用）
  function eraseBegin() { gesture = { removed: new Map(), created: new Map() }; }
  function eraseEnd() {
    if (!gesture) return;
    const removed = [...gesture.removed.values()];
    const created = [...gesture.created.values()];
    if (removed.length || created.length) {
      // やり直し＝この操作をもう一度、取り消し＝元の線を戻して作った線を消す
      undoStack.push({ puts: created, dels: removed.map((s) => s.id), undo: { puts: removed, dels: created.map((s) => s.id) } });
      redoStack.length = 0;
    }
    gesture = null;
  }
  function showEraser([x, y]) {
    live.clearRect(0, 0, liveCv.clientWidth, liveCv.clientHeight);
    live.save();
    live.strokeStyle = 'rgba(120,120,140,.85)';
    live.lineWidth = 1;
    live.beginPath();
    live.arc(x, y, eraserR(), 0, Math.PI * 2);
    live.stroke();
    live.restore();
  }
  function eraseAt([x, y]) {
    const r = eraserR();
    const near = (px, py) => (px - x) ** 2 + (py - y) ** 2 <= r * r;
    const segNear = (a, b) => { // 円の中心と線分の距離
      const dx = b[0] - a[0]; const dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      return near(a[0] + t * dx, a[1] + t * dy);
    };
    const [ax, ay] = map.fromPx(x - r, y - r);
    const [bx, by] = map.fromPx(x + r, y + r);
    const puts = [];
    const dels = [];
    for (const [s, p] of visible()) {
      if (p.maxX < ax || p.minX > bx || p.maxY < ay || p.minY > by) continue; // 遠い線はすぐ飛ばす
      const P = toPxPts(p, map);
      if (!P.some(([px, py], i) => near(px, py) || (i > 0 && segNear(P[i - 1], P[i])))) continue;
      dels.push(s.id);
      if (gesture.created.has(s.id)) gesture.created.delete(s.id); else gesture.removed.set(s.id, s);
      if (tool.eraseWhole) continue;
      // 触れたところだけ消す：点を細かく補い、円の中の点を取り除いて、残りを別々の線にする
      const style = { kind: p.kind, color: p.color, width: p.width };
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          const piece = makeStroke(s.page, style, run.map(([px, py, pr]) => [...map.fromPx(px, py), pr]));
          puts.push(piece);
          gesture.created.set(piece.id, piece);
        }
        run = [];
      };
      for (const q of densify(P, Math.max(1, r / 3))) { if (near(q[0], q[1])) flush(); else run.push(q); }
      flush();
    }
    if (dels.length) inkApply(puts, dels);
  }
  return m;
}

function densify(P, step) {
  const out = [P[0]];
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1];
    const b = P[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

export function undo() {
  const a = undoStack.pop();
  if (!a) return;
  const u = a.undo || { puts: [], dels: a.puts.map((s) => s.id) };
  inkApply(u.puts, u.dels);
  redoStack.push(a);
}
export function redo() {
  const a = redoStack.pop();
  if (!a) return;
  inkApply(a.puts, a.dels);
  undoStack.push(a);
}

// ───────── 道具バー ─────────

export function toolbarHtml() {
  const k = tool.kind;
  const sk = sizeKeyOf(k);
  const dot = (v) => Math.max(4, Math.min(18, sk === 'eraser' ? v / 2 : sk === 'marker' ? v / 1.6 : v * 2.2));
  return `<div class="ink-bar" role="toolbar" aria-label="手書き（Apple Pencilでそのまま書けます。長押しでペン↔消しゴム）">
      <div class="seg">
        <button type="button" data-ink-kind="pen" aria-pressed="${k === 'pen'}" aria-label="ペン">🖊</button>
        <button type="button" data-ink-kind="marker" aria-pressed="${k === 'marker'}" aria-label="マーカー">🖍</button>
        <button type="button" data-ink-kind="eraser" aria-pressed="${k === 'eraser'}" aria-label="消しゴム">🧽</button>
      </div>
      <div class="ink-sizes" role="group" aria-label="太さ">${SIZES[sk].map((v, i) => `<button type="button" data-ink-size="${i}" aria-pressed="${tool.size[sk] === i}" aria-label="太さ${i + 1}"><i style="width:${dot(v)}px;height:${dot(v)}px;${k === 'eraser' ? 'background:transparent;border:1.5px solid currentColor' : `background:${tool.color}`}"></i></button>`).join('')}</div>
      ${k === 'eraser'
        ? `<div class="seg"><button type="button" data-ink-whole="0" aria-pressed="${!tool.eraseWhole}">触れた所だけ</button><button type="button" data-ink-whole="1" aria-pressed="${tool.eraseWhole}">線ごと</button></div>`
        : `<div class="ink-colors">${INK_COLORS.map((c) => `<button type="button" data-ink-color="${c}" aria-label="色" aria-pressed="${tool.color === c}" style="--c:${c}"></button>`).join('')}</div>`}
      <button type="button" class="icon-btn" data-ink="undo" aria-label="取り消し">↶</button>
      <button type="button" class="icon-btn" data-ink="redo" aria-label="やり直し">↷</button>
      <label class="small muted row" style="gap:4px"><input type="checkbox" data-ink="finger" ${tool.finger ? 'checked' : ''}>指でも書く</label>
  </div>`;
}

export function bindToolbar(root, rerender) {
  root.querySelectorAll('[data-ink]').forEach((b) => {
    const a = b.dataset.ink;
    b.addEventListener(a === 'finger' ? 'change' : 'click', () => {
      if (a === 'undo') return undo();
      if (a === 'redo') return redo();
      if (a === 'finger') tool.finger = b.checked;
      saveTool();
      rerender();
    });
  });
  root.querySelectorAll('[data-ink-kind]').forEach((b) => b.onclick = () => { tool.kind = b.dataset.inkKind; saveTool(); rerender(); });
  root.querySelectorAll('[data-ink-size]').forEach((b) => b.onclick = () => { tool.size[sizeKeyOf(tool.kind)] = Number(b.dataset.inkSize); saveTool(); rerender(); });
  root.querySelectorAll('[data-ink-whole]').forEach((b) => b.onclick = () => { tool.eraseWhole = b.dataset.inkWhole === '1'; saveTool(); rerender(); });
  root.querySelectorAll('[data-ink-color]').forEach((b) => b.onclick = () => { tool.color = b.dataset.inkColor; if (tool.kind === 'eraser') tool.kind = 'pen'; saveTool(); rerender(); });
}
