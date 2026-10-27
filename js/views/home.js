// ホーム：今日やること・近い予定・カウントダウンを1画面に
import { state } from '../store.js';
import { colorOf } from '../oshi.js';
import { esc, today, addDays, fmtMD, fromMin, parseYmd, WD, yen } from '../util.js';
import { buildItems, occurrences, toggleWatched, openEventEditor } from './calendar.js';
import { openLiveEditor, checklistOf } from './lives.js';
import { liveSteps, pendingArchives } from '../plans.js';
import { weekKey, monthKey, memoText, hasMemo, openMemoViewer, isWide } from '../memo.js';
import { savingsGoal } from './money.js';
import { toast } from '../ui.js';

const ALL = { group: null, member: null };
const daysUntil = (d) => Math.round((parseYmd(d) - parseYmd(today())) / 864e5);
const dueLabel = (d) => { const n = daysUntil(d); return n === 0 ? '今日' : n === 1 ? '明日' : n < 0 ? `${-n}日前` : `あと${n}日`; };

function weekStart(t) {
  const ws = Number(state.settings.weekStart) || 0;
  return addDays(t, -((parseYmd(t).getDay() - ws + 7) % 7));
}

export function renderHome(main, ctx) {
  const t = today();
  const d = parseYmd(t);

  // 次の参戦（当選）
  const next = state.data.lives.filter((l) => l.Status === '当選' && l.Date >= t).sort((a, b) => a.Date.localeCompare(b.Date))[0];

  // 今日・明日
  const items = buildItems(t, addDays(t, 1), ALL).filter((i) => !(i.task && i.ref?.done));

  // やること（14日以内）：参戦の手続き＋締切の予定
  const todo = [];
  for (const l of state.data.lives) for (const st of liveSteps(l)) if (st.date >= t && st.date <= addDays(t, 14)) todo.push({ date: st.date, time: st.time, title: `${st.label} ${l.Title}`, color: colorOf(l.OshiID), open: () => openLiveEditor(l, ctx, {}, { section: 'apply' }) });
  for (const it of buildItems(t, addDays(t, 14), ALL)) {
    if (it.src === 'event' && ['申込締切', '入金締切', '当落発表'].includes(it.ref.Kind)) todo.push({ date: it.date, time: it.ref.Start, title: it.title, color: it.color, open: () => openEventEditor(it.ref, ctx) });
  }
  todo.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // アーカイブ
  const archives = pendingArchives(occurrences);

  // 誕生日・記念日（30日以内）
  const annivs = buildItems(t, addDays(t, 30), ALL).filter((i) => i.src === 'anniv');

  // 遠征（これからの申込中・当選で、遠征メモか持ち物があるもの／いちばん近いもの）
  const trips = state.data.lives.filter((l) => ['申込中', '当選'].includes(l.Status) && l.Date >= t).sort((a, b) => a.Date.localeCompare(b.Date)).slice(0, 2);

  const memos = [{ key: weekKey(weekStart(t)), title: '今週のメモ' }, { key: monthKey(t.slice(0, 7)), title: `${d.getMonth() + 1}月のメモ` }];
  const goal = savingsGoal();

  let html = `
    <div class="home-date">${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）</div>
    ${next ? `<button type="button" class="card hero count" data-next style="--c:${colorOf(next.OshiID)}">
      <span class="small muted">次の参戦</span>
      <b>${daysUntil(next.Date) === 0 ? '今日！' : `あと${daysUntil(next.Date)}日`}</b>
      <span>${esc(next.Title)}　<span class="muted small">${fmtMD(next.Date)} ${esc(next.Venue || '')}</span></span>
    </button>` : ''}
    <div class="home-grid">
    <section class="card section">
      <h2>今日・明日</h2>
      ${items.length ? [t, addDays(t, 1)].map((day) => {
        const list = items.filter((i) => i.date === day);
        return `<div class="small muted" style="margin:6px 0 2px">${day === t ? '今日' : '明日'} ${fmtMD(day)}</div>
          ${list.length ? list.map((i) => `<div class="agenda ${i.mine || i.task ? 'mine' : ''}" style="--c:${i.color || 'var(--mine)'}">
            <span class="at">${i.allDay ? '終日' : fromMin(i.start)}</span><span class="ag">${esc(i.title)}</span>${i.conflict ? '<span class="badge" style="--c:#dc2626">重なり</span>' : ''}</div>`).join('') : '<p class="small muted" style="margin:2px 0">予定なし</p>'}`;
      }).join('') : '<p class="small muted">予定はありません</p>'}
    </section>

    <section class="card section">
      <h2>やること（2週間以内）</h2>
      ${todo.length ? todo.map((x, i) => `<button type="button" class="entry" data-todo="${i}">
        <span class="ed">${dueLabel(x.date)}</span><span class="et"><i class="sw" style="background:${x.color}"></i>${esc(x.title)}</span><span class="ea small">${fmtMD(x.date)}${x.time ? ` ${x.time}` : ''}</span></button>`).join('') : '<p class="small muted">締切はありません</p>'}
    </section>

    <section class="card section">
      <h2>アーカイブ（まだ見ていない）</h2>
      ${archives.length ? archives.slice(0, 8).map((a, i) => `<div class="entry">
        <span class="ed">${a.expiry === '∞' ? '期限なし' : dueLabel(a.expiry)}</span>
        <span class="et"><i class="sw" style="background:${colorOf(a.event.OshiID)}"></i>${esc(a.event.Title)} <span class="muted small">${fmtMD(a.date)}配信</span></span>
        <button type="button" class="btn sm" data-watch="${i}">見た</button></div>`).join('') : '<p class="small muted">見逃しはありません。予定の「アーカイブ」を設定すると、ここに並びます。</p>'}
    </section>

    <section class="card section">
      <h2>遠征</h2>
      ${trips.length ? trips.map((l) => {
        const cl = checklistOf(l);
        const done = cl.filter((x) => x.d).length;
        return `<button type="button" class="entry" data-trip="${esc(l.LiveID)}">
          <span class="ed">${dueLabel(l.Date)}</span>
          <span class="et">${esc(l.Title)}<br><span class="muted small">${l.TravelMemo ? esc(l.TravelMemo.split('\n')[0]) : '交通・宿のメモなし'}</span></span>
          <span class="ea small">🧳 ${cl.length ? `${done}/${cl.length}` : '—'}</span></button>`;
      }).join('') : '<p class="small muted">これからの参戦はありません</p>'}
    </section>

    ${annivs.length ? `<section class="card section"><h2>誕生日・記念日（30日以内）</h2>
      ${annivs.map((a) => `<div class="entry"><span class="ed">${dueLabel(a.date)}</span><span class="et"><i class="sw" style="background:${a.color}"></i>${esc(a.title)}</span><span class="ea small">${fmtMD(a.date)}</span></div>`).join('')}</section>` : ''}

    <section class="card section">
      <div class="row"><h2 style="margin:0">メモ</h2><span class="spacer"></span><button type="button" class="btn sm" data-memos>${isWide() ? 'カレンダーで開く' : '見る'}</button></div>
      ${memos.map((m) => `<p class="small" style="margin:8px 0 0"><b>${esc(m.title)}</b>　${hasMemo(m.key) ? esc(memoText(m.key).split('\n')[0] || '（手書きあり）') : '<span class="muted">なし</span>'}</p>`).join('')}
    </section>

    ${goal.target ? `<section class="card section">
      <div class="row"><h2 style="margin:0">貯金目標</h2><span class="spacer"></span><button type="button" class="btn sm" data-goal>開く</button></div>
      <div class="goal-bar"><i style="width:${Math.min(100, Math.round((goal.saved / goal.target) * 100))}%"></i></div>
      <p class="small" style="margin:0">${yen(goal.saved)} / ${yen(goal.target)}${goal.remain ? `　あと ${yen(goal.remain)}` : '　🎉 達成'}</p>
    </section>` : ''}
    </div>`;
  main.innerHTML = html;

  main.querySelector('[data-next]')?.addEventListener('click', () => openLiveEditor(next, ctx));
  main.querySelectorAll('[data-todo]').forEach((b) => b.onclick = () => todo[Number(b.dataset.todo)].open());
  main.querySelectorAll('[data-watch]').forEach((b) => b.onclick = async () => {
    const a = archives[Number(b.dataset.watch)];
    await toggleWatched(a.event, a.date);
    toast('見たにしました');
  });
  const tripMap = new Map(trips.map((l) => [l.LiveID, l]));
  main.querySelectorAll('[data-trip]').forEach((b) => b.onclick = () => openLiveEditor(tripMap.get(b.dataset.trip), ctx, {}, { section: 'travel' }));
  main.querySelector('[data-memos]').onclick = () => (isWide() ? ctx.goTab('calendar') : openMemoViewer(memos));
  main.querySelector('[data-goal]')?.addEventListener('click', () => ctx.goTab('money', { moneyView: 'savings' }));
  ctx.setFab(null);
}

