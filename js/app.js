import { state, init, subscribe, sync, isDemo, onNotice } from './store.js';
import { groups, membersOf, oshiById } from './oshi.js';
import { esc } from './util.js';
import { toast } from './ui.js';
import { isDrawing } from './ink.js';
import { renderCalendar } from './views/calendar.js';
import { renderGoods } from './views/goods.js';
import { renderLives } from './views/lives.js';
import { renderSettings } from './views/settings.js';
import { renderMoney } from './views/money.js';
import { renderHome } from './views/home.js';

const VIEWS = {
  home: { title: 'ホーム', render: renderHome, chips: false },
  calendar: { title: 'カレンダー', render: renderCalendar, chips: true },
  goods: { title: 'グッズ', render: renderGoods, chips: true },
  lives: { title: '参戦記録', render: renderLives, chips: true },
  money: { title: 'お金', render: renderMoney, chips: true },
  settings: { title: 'その他', render: renderSettings, chips: false },
};

const main = document.getElementById('main');
const fab = document.getElementById('fab');
const ls = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};

const app = {
  tab: ls.get('tab', 'home'),
  sel: ls.get('sel', { group: null, member: null }),
};
if (!VIEWS[app.tab]) app.tab = 'home';

let fabAction = null;
const ctx = {
  get sel() { return app.sel; },
  focusSearch: false,
  rerender: (opts = {}) => render(opts),
  setFab: (fn) => { fabAction = fn; fab.hidden = !fn; },
  hideChips: () => { document.getElementById('chips').hidden = true; },
  /** 別のタブへ移る。opts はそのタブの表示指定（moneyView / goodsMode） */
  goTab: (tab, opts = {}) => {
    Object.assign(ctx, opts);
    app.tab = tab;
    ls.set('tab', tab);
    render({ resetScroll: true });
  },
};
fab.onclick = () => fabAction?.();

let pending = false;
function render(opts = {}) {
  // 入力中に同期などで再描画すると入力が消えるので、フォーカスが外れるまで待つ
  const a = document.activeElement;
  if (opts.fromStore && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox') {
    pending = true;
    renderStatus();
    return;
  }
  if (opts.fromStore && isDrawing()) { // 手書きの途中なら、書き終わってから描き直す
    renderStatus();
    setTimeout(() => render(opts), 400);
    return;
  }
  pending = false;
  if (app.sel.group && !oshiById(app.sel.group)) app.sel = { group: null, member: null };
  const v = VIEWS[app.tab];
  document.getElementById('title').textContent = v.title;
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === app.tab ? 'page' : 'false'));
  renderChips(v.chips);
  renderStatus();
  const top = main.scrollTop;
  ctx.focusSearch = !!opts.focusSearch;
  main.className = '';
  document.body.classList.remove('cal-fit');
  v.render(main, ctx);
  main.scrollTop = opts.resetScroll ? 0 : top;
}
main.addEventListener('focusout', () => setTimeout(() => { if (pending) render(); }, 0));

function renderChips(show) {
  const el = document.getElementById('chips');
  el.hidden = !show;
  if (!show) return;
  const gs = groups();
  const chip = (attrs, label, color, pressed) =>
    `<button type="button" class="chip" ${attrs} aria-pressed="${pressed}" ${color ? `style="--c:${color}"` : ''}>${color ? '<span class="dot"></span>' : ''}${esc(label)}</button>`;
  let html = `<div class="chip-row">${chip('data-group=""', 'すべて', '', !app.sel.group)}${gs.map((g) => chip(`data-group="${esc(g.OshiID)}"`, `${g.Emoji ? g.Emoji + ' ' : ''}${g.Name}`, g.Color, app.sel.group === g.OshiID)).join('')}</div>`;
  const ms = app.sel.group ? membersOf(app.sel.group) : [];
  if (ms.length) {
    html += `<div class="chip-row">${chip('data-member=""', '全員', '', !app.sel.member)}${ms.map((m) => chip(`data-member="${esc(m.OshiID)}"`, m.Name, m.Color, app.sel.member === m.OshiID)).join('')}</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.chip-row:nth-child(2) .chip').forEach((c) => c.classList.add('sm'));
  el.querySelectorAll('[data-group]').forEach((b) => b.onclick = () => {
    app.sel = { group: b.dataset.group || null, member: null };
    ls.set('sel', app.sel);
    render({ resetScroll: true });
  });
  el.querySelectorAll('[data-member]').forEach((b) => b.onclick = () => {
    app.sel = { ...app.sel, member: b.dataset.member || null };
    ls.set('sel', app.sel);
    render({ resetScroll: true });
  });
}

function renderStatus() {
  const b = document.getElementById('sync-status');
  const n = state.queue.length;
  b.className = 'sync';
  if (isDemo()) b.textContent = 'デモ表示';
  else if (state.sync.busy) { b.textContent = '同期中'; b.classList.add('busy'); }
  else if (!navigator.onLine || state.sync.netFail) { b.textContent = `${navigator.onLine ? '通信できません' : 'オフライン'}${n ? `・未送信${n}` : ''}`; b.classList.add('warn'); }
  else if (state.sync.error) { b.textContent = '⚠ 同期エラー'; b.classList.add('warn'); }
  else if (n) b.textContent = `未送信 ${n}`;
  else b.textContent = '✓ 同期済み';
}
document.getElementById('sync-status').onclick = () => {
  if (isDemo()) { app.tab = 'settings'; ls.set('tab', app.tab); render({ resetScroll: true }); return; }
  if (state.sync.error) toast(state.sync.error);
  sync();
};

document.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.onclick = () => {
  app.tab = b.dataset.tab;
  ls.set('tab', app.tab);
  render({ resetScroll: true });
});

let raf = 0;
subscribe((kind) => {
  if (kind === 'ink') { renderStatus(); return; } // 手書きは各キャンバスが自分で描き直す
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => render({ fromStore: true }));
});
// iPadの縦横の切り替えなどで「広い画面」かどうかが変わったら描き直す
window.matchMedia('(min-width: 760px)').addEventListener('change', () => render());
onNotice(toast);

window.addEventListener('online', () => { renderStatus(); sync(); });
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 5 * 60 * 1000);

// 手元での開発中（localhost）は ?sw を付けたときだけオフライン用キャッシュを使う
const devHost = location.hostname === 'localhost' && !new URLSearchParams(location.search).has('sw');
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !devHost) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

await init();
render();
sync();
