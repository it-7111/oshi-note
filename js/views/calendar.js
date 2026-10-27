import { state, upsertRow, saveSettings } from '../store.js';
import { groups, membersOf, oshiById, colorOf, nameOf, matchesSel, isVisible } from '../oshi.js';
import { esc, today, addDays, addMonths, parseYmd, ymd, fmtMD, WD, weekday, toMin, fromMin, pad, uid, isValidYmd } from '../util.js';
import { openModal, closeModal, toast, formValues, field, input, select } from '../ui.js';
import { openLiveEditor } from './lives.js';
import { liveSteps, archiveExpiry, watchedSet } from '../plans.js';
import { mountInk, gridMapping, toolbarHtml, bindToolbar } from '../ink.js';
import { weekKey, monthKey, hasMemo, isWide, memoPanelHtml, bindMemoPanel, openMemoViewer } from '../memo.js';

// 1時間の高さ。iPadでは画面の高さに合わせて、時間軸に16時間分が収まるようにする
let HOUR_H = 44;
const fitHour = { winH: 0, h: 44 };
const DEADLINE_KINDS = ['申込締切', '入金締切', '当落発表'];
export const EVENT_KINDS = ['配信', 'ライブ', 'リリース', '申込締切', '当落発表', '入金締切', 'その他'];
const KIND_ICON = { 配信: '📺', ライブ: '🎤', リリース: '💿', 申込締切: '📝', 当落発表: '🎫', 入金締切: '💴', その他: '📌' };
const REPEAT = [['none', 'なし'], ['weekly', '毎週'], ['monthly', '毎月'], ['yearly', '毎年']];

const ui = loadUi();
function loadUi() {
  try { return { view: 'week', cursor: today(), ...JSON.parse(localStorage.getItem('cal-ui') || '{}'), scroll: null }; } catch { return { view: 'week', cursor: today(), scroll: null }; }
}
function saveUi() {
  try { localStorage.setItem('cal-ui', JSON.stringify({ view: ui.view, cursor: ui.cursor })); } catch { /* 保存できなくても動く */ }
}

// ───────── 表示する項目を作る ─────────

export function occurrences(start, repeat, from, to) {
  if (!isValidYmd(start)) return [];
  const out = [];
  if (!repeat || repeat === 'none') {
    if (start >= from && start <= to) out.push(start);
  } else if (repeat === 'weekly') {
    let d = start;
    if (d < from) {
      const diff = Math.round((parseYmd(from) - parseYmd(start)) / 864e5);
      d = addDays(start, Math.floor(diff / 7) * 7);
    }
    for (; d <= to; d = addDays(d, 7)) if (d >= from) out.push(d);
  } else if (repeat === 'monthly') {
    const day = Number(start.slice(8));
    for (let m = addMonths(from, -1).slice(0, 7); m <= to.slice(0, 7); m = addMonths(m + '-01', 1).slice(0, 7)) {
      const d = `${m}-${pad(day)}`;
      if (d >= start && d >= from && d <= to && parseYmd(d).getDate() === day) out.push(d);
    }
  } else if (repeat === 'yearly') {
    out.push(...yearly(start.slice(5), from, to).filter((d) => d >= start));
  }
  return out;
}

function yearly(md, from, to) {
  const out = [];
  if (!/^\d{2}-\d{2}$/.test(md)) return out;
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    const d = `${y}-${md}`;
    if (d >= from && d <= to) out.push(d);
  }
  return out;
}

export function buildItems(from, to, sel) {
  const d = state.data;
  const s = state.settings;
  const items = [];
  const show = (id) => isVisible(id) && matchesSel(id, sel);
  const push = (o) => {
    const st = toMin(o.startT);
    let en = toMin(o.endT);
    const timed = st !== null && !o.allDayHint;
    if (timed) {
      if (en === null) en = Math.min(st + (o.defaultDur || 60), 24 * 60);
      else if (en <= st) en = 24 * 60; // 日付をまたぐ予定はその日の終わりまで
    }
    items.push({ ...o, start: timed ? st : null, end: timed ? en : null, allDay: !timed });
  };

  for (const e of d.events) {
    if (!show(e.OshiID)) continue;
    for (const date of occurrences(e.Date, e.Repeat, from, to)) {
      push({
        key: `ev:${e.EventID}:${date}`, src: 'event', ref: e, date, startT: e.Start, endT: e.End,
        allDayHint: DEADLINE_KINDS.includes(e.Kind), defaultDur: e.Kind === 'リリース' ? 30 : 60,
        title: `${KIND_ICON[e.Kind] || ''}${e.Title}`, color: colorOf(e.OshiID),
      });
    }
  }
  for (const l of d.lives) {
    if (!show(l.OshiID) || !(l.Date >= from && l.Date <= to)) continue;
    push({ key: `lv:${l.LiveID}`, src: 'live', ref: l, date: l.Date, startT: l.Start || l.Open, defaultDur: 180, title: `🎤${l.Title}`, color: colorOf(l.OshiID) });
  }
  // 申込締切・当落発表・入金締切・発券
  for (const l of d.lives) {
    if (!show(l.OshiID)) continue;
    for (const st of liveSteps(l)) {
      if (st.date < from || st.date > to) continue;
      push({ key: `ls:${l.LiveID}:${st.kind}`, src: 'live', ref: l, date: st.date, startT: st.time, allDayHint: true, title: `${st.label}${st.time ? ` ${st.time}` : ''} ${l.Title}`, color: colorOf(l.OshiID) });
    }
  }
  // 配信アーカイブの視聴期限（まだ見ていないもの）
  for (const e of d.events) {
    if (!show(e.OshiID) || (!e.ArchiveDays && !e.ArchiveUntil)) continue;
    const w = watchedSet(e);
    for (const od of occurrences(e.Date, e.Repeat, addDays(from, -120), to < today() ? to : today())) { // 配信済みの回だけ
      const exp = archiveExpiry(e, od);
      if (!exp || exp === '∞' || exp < from || exp > to || w.has(od)) continue;
      push({ key: `ar:${e.EventID}:${od}`, src: 'event', ref: e, date: exp, occ: od, allDayHint: true, title: `⏳アーカイブ期限 ${e.Title}`, color: colorOf(e.OshiID) });
    }
  }
  for (const o of d.oshi) {
    if (!show(o.OshiID)) continue;
    for (const date of yearly(String(o.Birthday || '').slice(-5), from, to)) {
      push({ key: `bd:${o.OshiID}:${date}`, src: 'anniv', ref: o, date, title: `🎂${o.Name} 誕生日`, color: o.Color });
    }
    for (const [field, label] of [['DebutDate', '周年'], ['OshiStart', '推して']]) {
      const base = o[field];
      if (!isValidYmd(base)) continue;
      for (const date of yearly(base.slice(5), from, to)) {
        const n = Number(date.slice(0, 4)) - Number(base.slice(0, 4));
        if (n <= 0) continue;
        const title = field === 'DebutDate' ? `🎉${o.Name} ${n}周年` : `💗${o.Name} 推して${n}年`;
        push({ key: `an:${o.OshiID}:${field}:${date}`, src: 'anniv', ref: o, date, title, color: o.Color });
      }
    }
  }
  for (const x of d.schedule) {
    if (x.date < from || x.date > to) continue;
    if (x.kind === 'S' && !s.showMine) continue;
    if (x.kind === 'T' && (!s.showTasks || (x.done && !s.showDone))) continue;
    push({
      key: `sc:${x.id}`, src: 'sched', ref: x, date: x.date, startT: x.start, endT: x.end, allDayHint: x.kind === 'T',
      title: x.kind === 'T' ? `${x.done ? '✓' : '□'}${x.title}` : x.title,
      mine: x.kind === 'S', task: x.kind === 'T',
    });
  }

  // 自分の予定と推しの予定の重なり
  const mine = items.filter((i) => i.mine && !i.allDay);
  for (const it of items) {
    if (it.mine || it.task || it.allDay) continue;
    for (const m of mine) {
      if (m.date === it.date && it.start < m.end && m.start < it.end) { it.conflict = true; m.conflict = true; }
    }
  }
  return items.sort((a, b) => (a.allDay === b.allDay ? (a.start ?? -1) - (b.start ?? -1) : a.allDay ? -1 : 1) || (a.mine ? 1 : 0) - (b.mine ? 1 : 0));
}

// ───────── 描画 ─────────

/** 今表示している期間の週メモ・月メモ */
function currentMemos() {
  const wk = weekStartOf(ui.cursor);
  const ym = ui.cursor.slice(0, 7);
  const month = { key: monthKey(ym), title: `${Number(ym.slice(5))}月のメモ` };
  if (ui.view === 'month') return [month];
  return [{ key: weekKey(wk), title: `週のメモ（${fmtMD(wk)}〜）` }, month];
}

export function renderCalendar(main, ctx) {
  const t = today();
  const wide = isWide();
  const memos = currentMemos();
  const memoDot = memos.some((m) => hasMemo(m.key));
  HOUR_H = wide && fitHour.winH === window.innerHeight ? fitHour.h : wide ? Math.max(24, Math.min(56, Math.floor((window.innerHeight - 330) / 16))) : 44;
  main.classList.toggle('fit', wide); // iPadでは画面全体をスクロールさせず、1画面に収める
  document.body.classList.toggle('cal-fit', wide);
  let html = `
    <div class="row cal-controls" style="margin:2px 0 8px;flex-wrap:wrap">
      <div class="seg" role="group" aria-label="表示形式">
        ${[['day', '日'], ['week', '週'], ['month', '月']].map(([v, l]) => `<button type="button" data-view="${v}" aria-pressed="${ui.view === v}">${l}</button>`).join('')}
      </div>
      ${wide ? toolbarHtml() : ''}
      <span class="spacer"></span>
      ${wide ? '' : `<button type="button" class="btn sm memo-btn ${memoDot ? 'has' : ''}" data-memo-open aria-label="メモを見る">📝${memoDot ? '<i></i>' : ''}</button>`}
      <button type="button" class="btn sm" data-today>今日</button>
      <button type="button" class="btn sm" data-layers>表示 ▾</button>
    </div>
    <div class="cal-layout"><div class="cal-main">`;

  if (ui.view === 'month') html += monthHtml(ctx.sel, t);
  else html += gridHtml(ui.view === 'week' ? 7 : 1, ctx.sel, t);

  html += `<div class="legend">
    <span><i style="background:var(--mine-bg);border-left:3px solid var(--mine)"></i>自分の予定</span>
    <span><i style="background:transparent;outline:2px solid var(--danger)"></i>重なり</span>
    <span>📝締切 📺配信 🎤ライブ 🎂誕生日 ⏳アーカイブ期限</span>
    ${ui.view === 'day' ? '<span>手書きは週表示で見られます</span>' : ''}</div></div>
    ${wide ? `<aside class="memo-side">${memoPanelHtml(memos, true)}</aside>` : ''}</div>`;
  main.innerHTML = html;

  if (wide) {
    bindToolbar(main, () => ctx.rerender());
    bindMemoPanel(main, true);
  } else {
    main.querySelector('[data-memo-open]').onclick = () => openMemoViewer(memos);
  }
  const inkCanvas = main.querySelector('.ink-layer');
  if (inkCanvas) mountInk(inkCanvas, gridMapping(weekStartOf(ui.cursor), 7, HOUR_H), { editable: wide });

  main.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { ui.view = b.dataset.view; ui.scroll = null; saveUi(); ctx.rerender(); });
  main.querySelector('[data-today]').onclick = () => { ui.cursor = today(); ui.scroll = null; saveUi(); ctx.rerender(); };
  main.querySelector('[data-layers]').onclick = () => openLayers(ctx);
  main.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => { shift(Number(b.dataset.nav)); ctx.rerender(); });
  main.querySelectorAll('[data-goday]').forEach((b) => b.onclick = () => { ui.cursor = b.dataset.goday; ui.view = 'day'; ui.scroll = null; saveUi(); ctx.rerender(); });
  main.querySelectorAll('[data-item]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openItem(b.dataset.item, ctx); });

  const grid = main.querySelector('.tgrid');
  if (grid && wide) {
    // 実際の高さから1時間の高さを決め直す（画面の高さが変わらない限り1回だけ）
    const want = Math.max(24, Math.min(60, Math.floor(grid.clientHeight / 16)));
    fitHour.winH = window.innerHeight;
    if (Math.abs(want - fitHour.h) > 1 || HOUR_H !== want) {
      fitHour.h = want;
      if (HOUR_H !== want) { ui.scroll = null; return renderCalendar(main, ctx); }
    }
  }
  if (grid) {
    grid.scrollTop = ui.scroll ?? 8 * HOUR_H;
    grid.onscroll = () => { ui.scroll = grid.scrollTop; };
  }
  ctx.setFab(() => openEventEditor(null, ctx, ui.view === 'day' ? ui.cursor : today()));
}

function shift(n) {
  if (ui.view === 'month') ui.cursor = addMonths(ui.cursor, n);
  else ui.cursor = addDays(ui.cursor, n * (ui.view === 'week' ? 7 : 1));
  saveUi();
}

function weekStartOf(s) {
  const ws = Number(state.settings.weekStart) || 0;
  return addDays(s, -((weekday(s) - ws + 7) % 7));
}

function navHtml(title) {
  return `<div class="cal-head">
    <button type="button" class="icon-btn" data-nav="-1" aria-label="前へ">‹</button>
    <h2>${title}</h2>
    <button type="button" class="icon-btn" data-nav="1" aria-label="次へ">›</button></div>`;
}

const wdClass = (s) => ({ 0: 'sun', 6: 'sat' }[weekday(s)] || '');
let lastItems = new Map();
const remember = (items) => { items.forEach((i) => lastItems.set(i.key, i)); return items; };

function pillHtml(it) {
  const cls = ['pill', it.mine && 'mine', it.task && 'task', it.conflict && 'conflict'].filter(Boolean).join(' ');
  const time = !it.allDay && !it.mine ? `${fromMin(it.start)} ` : '';
  return `<div class="${cls}" style="--c:${it.color || 'var(--mine)'}" data-item="${esc(it.key)}">${esc(time + it.title)}</div>`;
}

function monthHtml(sel, t) {
  const first = ui.cursor.slice(0, 8) + '01';
  const start = weekStartOf(first);
  const end = addDays(start, 41);
  lastItems = new Map();
  const items = remember(buildItems(start, end, sel));
  const byDate = {};
  items.forEach((i) => (byDate[i.date] ||= []).push(i));
  const ws = Number(state.settings.weekStart) || 0;
  const d0 = parseYmd(first);
  let html = navHtml(`${d0.getFullYear()}年${d0.getMonth() + 1}月`);
  html += '<div class="month card">';
  for (let i = 0; i < 7; i++) {
    const w = (ws + i) % 7;
    html += `<div class="wd ${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}">${WD[w]}</div>`;
  }
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const list = byDate[d] || [];
    const oshiItems = list.filter((x) => !x.mine && !x.task);
    const mineN = list.length - oshiItems.length;
    const shown = oshiItems.slice(0, 3);
    html += `<button type="button" class="cell ${d.slice(0, 7) !== first.slice(0, 7) ? 'out' : ''} ${d === t ? 'today' : ''}" data-goday="${d}">
      <span class="num ${wdClass(d)}">${Number(d.slice(8))}</span>
      ${shown.map((x) => `<div class="pill ${x.conflict ? 'conflict' : ''}" style="--c:${x.color}">${esc(x.title)}</div>`).join('')}
      ${oshiItems.length > 3 ? `<span class="more">+${oshiItems.length - 3}</span>` : ''}
      ${mineN ? `<div class="pill mine">自分${mineN}</div>` : ''}
    </button>`;
  }
  return html + '</div>';
}

function gridHtml(days, sel, t) {
  const start = days === 7 ? weekStartOf(ui.cursor) : ui.cursor;
  const end = addDays(start, days - 1);
  lastItems = new Map();
  const items = remember(buildItems(start, end, sel));
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const title = days === 7
    ? `${fmtMD(start)} – ${fmtMD(end)}`
    : `${parseYmd(start).getFullYear()}年 ${fmtMD(start)}`;

  let html = navHtml(title);
  html += `<div class="grid-wrap card ${days > 1 ? 'wk' : ''}" style="--days:${days};--hour-h:${HOUR_H}px">`;
  html += `<div class="grid-head"><div></div>${dates.map((d) => `<button type="button" class="d ${d === t ? 'today' : ''} ${wdClass(d)}" data-goday="${d}"><span class="num ${wdClass(d)}">${WD[weekday(d)]}</span><b>${Number(d.slice(8))}</b></button>`).join('')}</div>`;
  html += `<div class="allday"><div class="lbl">終日</div>${dates.map((d) => `<div class="col">${items.filter((i) => i.allDay && i.date === d).map(pillHtml).join('')}</div>`).join('')}</div>`;
  html += `<div class="tgrid"><div class="tgrid-inner"><div class="hours">${Array.from({ length: 24 }, (_, h) => (h ? `<span style="top:${h * HOUR_H}px">${h}</span>` : '')).join('')}</div>`;

  const now = new Date();
  for (const d of dates) {
    const timed = items.filter((i) => !i.allDay && i.date === d);
    html += `<div class="daycol ${d === t ? 'today' : ''}">`;
    for (const it of layout(timed)) {
      const top = (it.start / 60) * HOUR_H;
      const h = Math.max(((it.end - it.start) / 60) * HOUR_H - 2, 16);
      const w = 100 / it.lanes;
      const cls = ['ev', it.mine && 'mine', it.conflict && 'conflict'].filter(Boolean).join(' ');
      html += `<button type="button" class="${cls}" style="--c:${it.color || 'var(--mine)'};top:${top}px;height:${h}px;left:calc(${it.lane * w}% + 1px);width:calc(${w}% - 2px)" data-item="${esc(it.key)}">
        ${days === 1 ? `<span class="t">${fromMin(it.start)}–${fromMin(it.end)}</span> ` : ''}<b>${esc(it.title)}</b>${days === 1 && it.ref?.place ? `<br><span class="t">@${esc(it.ref.place)}</span>` : ''}</button>`;
    }
    if (d === t) html += `<div class="nowline" style="top:${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H}px"></div>`;
    html += '</div>';
  }
  // 週表示では時間軸の上に手書きの層を重ねる（あいまいな予定はここに書く）
  if (days === 7) html += `<canvas class="ink-layer" style="height:${24 * HOUR_H}px" aria-label="週の手書き"></canvas>`;
  return html + '</div></div></div>';
}

/** 重なる予定を横に並べる（lane: 何列目か, lanes: その塊の列数） */
function layout(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const it of cluster) {
      let l = lanes.findIndex((end) => end <= it.start);
      if (l < 0) { l = lanes.length; lanes.push(0); }
      lanes[l] = it.end;
      it.lane = l;
    }
    cluster.forEach((it) => { it.lanes = lanes.length; out.push(it); });
    cluster = [];
  };
  for (const it of sorted) {
    if (cluster.length && it.start >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push({ ...it });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

// ───────── 表示の切り替え ─────────

function openLayers(ctx) {
  const s = state.settings;
  const hidden = new Set(s.hidden || []);
  const line = (o, sub) => `<label class="${sub ? 'sub' : ''}"><input type="checkbox" data-oshi="${esc(o.OshiID)}" ${hidden.has(o.OshiID) ? '' : 'checked'}><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${o.Color}"></span>${esc(o.Name)}</label>`;
  const body = `<div class="toggle-list">
      <label><input type="checkbox" data-flag="showMine" ${s.showMine ? 'checked' : ''}>自分の予定（予定GSSのS）</label>
      <label><input type="checkbox" data-flag="showTasks" ${s.showTasks ? 'checked' : ''}>タスク（予定GSSのT）</label>
      <label class="sub"><input type="checkbox" data-flag="showDone" ${s.showDone ? 'checked' : ''}>完了したタスクも表示</label>
      ${groups().map((g) => line(g, false) + membersOf(g.OshiID).map((m) => line(m, true)).join('')).join('')}
    </div>`;
  openModal({
    title: 'カレンダーに表示するもの', body,
    onMount: (m) => {
      m.querySelectorAll('[data-flag]').forEach((el) => el.onchange = () => saveSettings({ [el.dataset.flag]: el.checked }));
      m.querySelectorAll('[data-oshi]').forEach((el) => el.onchange = () => {
        const h = new Set(state.settings.hidden || []);
        el.checked ? h.delete(el.dataset.oshi) : h.add(el.dataset.oshi);
        saveSettings({ hidden: [...h] });
      });
    },
  });
}

// ───────── 詳細・編集 ─────────

function openItem(key, ctx) {
  const it = lastItems.get(key);
  if (!it) return;
  if (it.src === 'live') return openLiveEditor(it.ref, ctx);
  if (it.src === 'event') return openEventDetail(it, ctx);
  const x = it.ref;
  const rows = it.src === 'sched'
    ? [['日付', fmtMD(x.date)], ['時間', [x.start, x.end].filter(Boolean).join(' – ') || '終日'], ['場所', x.place], ['内容', x.title], ['メモ', x.notes], ['種類', x.kind === 'S' ? '予定' : `タスク${x.done ? '（完了）' : ''}`]]
    : [['日付', fmtMD(it.date)], ['推し', x.Name]];
  openModal({
    title: it.src === 'sched' ? '自分の予定' : it.title,
    body: `<dl class="kv">${rows.filter((r) => r[1]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <p class="muted small">${it.src === 'sched' ? '予定GSSから読み込んでいます。変更は予定GSSで行ってください。' : '推しの情報（Oshiシート）から自動で表示しています。'}</p>`,
  });
}

function openEventDetail(it, ctx) {
  const e = it.ref;
  const occ = it.occ || it.date; // アーカイブ期限の項目なら元の配信日
  const exp = archiveExpiry(e, occ);
  const watched = watchedSet(e).has(occ);
  const rep = REPEAT.find((r) => r[0] === e.Repeat)?.[1];
  const rows = [
    ['推し', nameOf(e.OshiID)], ['種類', e.Kind], ['日付', fmtMD(it.date)],
    ['時間', [e.Start, e.End].filter(Boolean).join(' – ') || '終日'], ['繰り返し', e.Repeat && e.Repeat !== 'none' ? rep : ''], ['メモ', e.Memo],
  ];
  openModal({
    title: it.title,
    body: `<dl class="kv">${rows.filter((r) => r[1]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}
      ${e.URL ? `<dt>URL</dt><dd><a href="${esc(e.URL)}" target="_blank" rel="noopener">${esc(e.URL)}</a></dd>` : ''}</dl>
      ${it.conflict ? '<p class="small" style="color:var(--danger)">⚠ 自分の予定と重なっています</p>' : ''}
      ${exp ? `<div class="row card" style="padding:10px 12px;margin-top:10px">
        <span class="small">⏳ アーカイブ（${fmtMD(occ)}配信分）：${exp === '∞' ? '期限なし' : `${fmtMD(exp)}まで`}</span><span class="spacer"></span>
        <button type="button" class="btn sm ${watched ? '' : 'primary'}" data-watch>${watched ? '✓ 見た' : '見た'}</button></div>` : ''}`,
    foot: `<button type="button" class="btn" data-live>参戦記録を作る</button><span class="spacer"></span><button type="button" class="btn primary" data-edit>編集</button>`,
    onMount: (m) => {
      m.querySelector('[data-watch]')?.addEventListener('click', async () => {
        await toggleWatched(e, occ);
        closeModal();
        toast(watched ? '「まだ」に戻しました' : '見たにしました');
      });
      m.querySelector('[data-edit]').onclick = () => openEventEditor(e, ctx);
      m.querySelector('[data-live]').onclick = () => openLiveEditor(null, ctx, { OshiID: e.OshiID, Date: it.date, Start: e.Start, Title: e.Title });
    },
  });
}

export function toggleWatched(e, occ) {
  const w = watchedSet(e);
  w.has(occ) ? w.delete(occ) : w.add(occ);
  return upsertRow('Events', { ...e, Watched: [...w].sort().join(',') });
}

export function oshiOptions() {
  return groups().flatMap((g) => [[g.OshiID, g.Name], ...membersOf(g.OshiID).map((m) => [m.OshiID, `　${m.Name}`])]);
}

export function openEventEditor(e, ctx, date = today()) {
  const isNew = !e;
  const row = e || { EventID: uid('e'), OshiID: ctx.sel.member || ctx.sel.group || groups()[0]?.OshiID || '', Kind: '配信', Title: '', Date: date, Start: '', End: '', Repeat: 'none', URL: '', Memo: '', ArchiveDays: '', ArchiveUntil: '', Watched: '' };
  const archMode = row.ArchiveUntil ? 'until' : row.ArchiveDays === '-1' ? 'unlimited' : row.ArchiveDays ? 'days' : '';
  openModal({
    title: isNew ? '予定を追加' : '予定を編集',
    body: `
      ${field('推し', select('OshiID', oshiOptions(), row.OshiID))}
      <div class="fields-2">${field('種類', select('Kind', EVENT_KINDS.map((k) => [k, `${KIND_ICON[k]} ${k}`]), row.Kind))}
      ${field('繰り返し', select('Repeat', REPEAT, row.Repeat || 'none'))}</div>
      ${field('タイトル', input('Title', row.Title, 'required'))}
      ${field('日付', input('Date', row.Date, 'type="date" required'))}
      <div class="fields-2">${field('開始', input('Start', row.Start, 'type="time"'))}${field('終了', input('End', row.End, 'type="time"'))}</div>
      ${field('URL', input('URL', row.URL, 'type="url" inputmode="url"'))}
      <div class="fields-2">
        ${field('アーカイブ', select('ArchiveMode', [['', 'なし'], ['days', '配信から○日'], ['until', '日付で指定'], ['unlimited', '期限なし']], archMode))}
        <div data-arch-days ${archMode === 'days' ? '' : 'hidden'}>${field('日数', input('ArchiveDays', archMode === 'days' ? row.ArchiveDays : '7', 'type="number" inputmode="numeric" min="0"'))}</div>
        <div data-arch-until ${archMode === 'until' ? '' : 'hidden'}>${field('期限', input('ArchiveUntil', row.ArchiveUntil, 'type="date"'))}</div>
      </div>
      ${field('メモ', `<textarea name="Memo">${esc(row.Memo)}</textarea>`)}`,
    foot: `${isNew ? '' : '<button type="button" class="btn danger" data-del>削除</button>'}<span class="spacer"></span><button type="button" class="btn primary" data-save>保存</button>`,
    onMount: (m) => {
      const modeSel = m.querySelector('[name=ArchiveMode]');
      modeSel.onchange = () => {
        m.querySelector('[data-arch-days]').hidden = modeSel.value !== 'days';
        m.querySelector('[data-arch-until]').hidden = modeSel.value !== 'until';
      };
      m.querySelector('[data-save]').onclick = async () => {
        const { ArchiveMode, ...v } = formValues(m);
        if (!v.Title || !isValidYmd(v.Date)) return toast('タイトルと日付を入れてください');
        v.ArchiveDays = ArchiveMode === 'days' ? String(Math.max(0, Number(v.ArchiveDays) || 0)) : ArchiveMode === 'unlimited' ? '-1' : '';
        v.ArchiveUntil = ArchiveMode === 'until' ? v.ArchiveUntil : '';
        if (ArchiveMode === 'until' && !isValidYmd(v.ArchiveUntil)) return toast('アーカイブの期限を入れてください');
        await upsertRow('Events', { ...row, ...v });
        closeModal();
        toast('保存しました');
      };
      m.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!confirm(`「${row.Title}」を削除しますか？${row.Repeat !== 'none' ? '（繰り返しの予定はすべて消えます）' : ''}`)) return;
        await upsertRow('Events', { ...row, Deleted: true });
        closeModal();
        toast('削除しました');
      });
    },
  });
}
