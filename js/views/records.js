// 記録タブ：活動の一覧と、見積もりのずれ・自己評価の振り返り
import { state } from '../store.js';
import { matchesSel } from '../oshi.js';
import { esc, today, addDays, ymd, fmtMD, num, pad } from '../util.js';
import { activeAct, doneActs, categories, catColor, fmtMin, openDeclare, openActEditor, REASONS, estimateRatio } from '../activity.js';

const ui = { view: 'list', range: 7 };
const dateOf = (a) => (a.StartAt ? ymd(new Date(a.StartAt)) : '');
const timeOf = (a) => { const d = new Date(a.StartAt); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function renderRecords(main, ctx) {
  const seg = `<div class="seg" role="group" style="margin:2px 0 10px;display:flex">
    <button type="button" data-rv="list" aria-pressed="${ui.view === 'list'}" style="flex:1">記録</button>
    <button type="button" data-rv="stats" aria-pressed="${ui.view === 'stats'}" style="flex:1">振り返り</button></div>`;
  // 推しのチップで絞ったときは、その推しを選んだ記録だけ
  const acts = doneActs().filter((a) => !ctx.sel.group || (a.OshiID && matchesSel(a.OshiID, ctx.sel)));
  if (ui.view === 'stats') renderStats(main, ctx, acts, seg);
  else renderList(main, ctx, acts, seg);
  main.querySelectorAll('[data-rv]').forEach((b) => b.onclick = () => { ui.view = b.dataset.rv; ctx.rerender({ resetScroll: true }); });
  ctx.setFab(activeAct() ? null : () => openDeclare(ctx));
}

function renderList(main, ctx, acts, seg) {
  const t = today();
  const todays = acts.filter((a) => dateOf(a) === t);
  const todayMin = todays.reduce((s, a) => s + num(a.ActualMin), 0);
  const sorted = [...acts].sort((a, b) => String(b.StartAt).localeCompare(String(a.StartAt)));
  let html = `${seg}
    <div class="card hero">
      <span class="small muted">今日の記録</span>
      <b>${fmtMin(todayMin)} <small class="muted">/ ${todays.length}件</small></b>
      ${activeAct() ? '<span class="small">計測中の活動は上のバーから一時停止・終了できます</span>'
        : '<button type="button" class="btn primary" data-declare style="align-self:flex-start;margin-top:6px">⏱ これからやることを宣言して開始</button>'}
    </div>`;
  if (!sorted.length) html += '<div class="empty">まだ記録がありません。<br>やることと予想時間を決めて、タイマーを始めましょう。</div>';
  let cur = '';
  for (const a of sorted.slice(0, 200)) {
    const d = dateOf(a);
    if (d !== cur) {
      const dayMin = acts.filter((x) => dateOf(x) === d).reduce((s, x) => s + num(x.ActualMin), 0);
      html += `<div class="year">${d === t ? '今日' : d === addDays(t, -1) ? '昨日' : fmtMD(d)}　<span class="muted">${fmtMin(dayMin)}</span></div>`;
      cur = d;
    }
    const p = num(a.PlannedMin);
    const diff = num(a.ActualMin) - p;
    html += `<button type="button" class="card act-row" style="--c:${catColor(a.Category)}" data-act="${esc(a.ActID)}">
      <span class="ar-time">${timeOf(a)}</span>
      <span class="ar-main"><span class="ar-title">${esc(a.Title)}</span>
        <span class="small muted"><span class="badge" style="--c:${catColor(a.Category)}">${esc(a.Category)}</span>
        ${fmtMin(a.ActualMin)}${p ? `／予想${fmtMin(p)} <b class="${diff > 0 ? 'over' : 'under'}">${diff >= 0 ? '+' : '−'}${fmtMin(Math.abs(diff))}</b>` : ''}</span>
        ${a.Comment ? `<span class="small ar-comment">${esc(a.Comment.split('\n')[0])}</span>` : ''}</span>
      <span class="ar-rate">${num(a.Rating) ? '★'.repeat(num(a.Rating)) : '<span class="muted small">未評価</span>'}</span>
    </button>`;
  }
  main.innerHTML = html;
  main.querySelector('[data-declare]')?.addEventListener('click', () => openDeclare(ctx));
  const byId = new Map(acts.map((a) => [a.ActID, a]));
  main.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => openActEditor(byId.get(b.dataset.act)));
}

function renderStats(main, ctx, acts, seg) {
  const from = ui.range ? addDays(today(), -(ui.range - 1)) : '';
  const list = acts.filter((a) => !from || dateOf(a) >= from);
  const total = list.reduce((s, a) => s + num(a.ActualMin), 0);
  const cats = [...new Set([...categories().map((c) => c.name), ...list.map((a) => a.Category)])];
  const byCat = cats.map((c) => {
    const xs = list.filter((a) => a.Category === c);
    const min = xs.reduce((s, a) => s + num(a.ActualMin), 0);
    const rated = xs.filter((a) => num(a.Rating));
    const ratios = xs.filter((a) => num(a.PlannedMin) && num(a.ActualMin)).map((a) => num(a.ActualMin) / num(a.PlannedMin)).sort((x, y) => x - y);
    return { c, n: xs.length, min, avgRate: rated.length ? rated.reduce((s, a) => s + num(a.Rating), 0) / rated.length : 0, median: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null };
  }).filter((x) => x.n);
  const max = Math.max(1, ...byCat.map((x) => x.min));
  const reasonCount = REASONS.map((r) => [r, list.filter((a) => String(a.Reasons).split(',').includes(r)).length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  const planned = list.filter((a) => num(a.PlannedMin));
  const onTime = planned.filter((a) => num(a.ActualMin) <= num(a.PlannedMin) * 1.1).length;

  main.innerHTML = `${seg}
    <div class="row" style="margin-bottom:10px">
      <select class="sel" data-range aria-label="期間">${[[7, '直近7日'], [30, '直近30日'], [90, '直近90日'], [0, 'すべて']].map(([v, l]) => `<option value="${v}" ${ui.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="stats">
      <div class="card stat"><b>${fmtMin(total)}</b><span>合計</span></div>
      <div class="card stat"><b>${list.length}</b><span>件</span></div>
      <div class="card stat"><b>${planned.length ? `${Math.round((onTime / planned.length) * 100)}%` : '—'}</b><span>予想どおり（+10%以内）</span></div>
    </div>
    <section class="card section"><h2>分類ごとの時間</h2>
      ${byCat.length ? `<div class="bars">${byCat.map((x) => `<div class="bar-row" title="${esc(x.c)}：${fmtMin(x.min)}">
        <span class="bl"><i class="sw" style="background:${catColor(x.c)}"></i>${esc(x.c)}</span>
        <span class="bt"><i style="width:${Math.max(2, (x.min / max) * 100)}%;background:${catColor(x.c)}"></i></span>
        <span class="bv">${fmtMin(x.min)}<small>${total ? Math.round((x.min / total) * 100) : 0}%</small></span></div>`).join('')}</div>` : '<p class="small muted">この期間の記録はありません</p>'}
    </section>
    <section class="card section"><h2>見積もりのくせ</h2>
      <p class="small muted">実際にかかった時間 ÷ 予想時間 の中央値。100%より大きいと、予想より長くかかりがちです。</p>
      ${byCat.filter((x) => x.median).map((x) => {
        const e = estimateRatio(x.c);
        return `<div class="kv-line"><span><i class="sw" style="background:${catColor(x.c)}"></i>${esc(x.c)} <span class="small muted">${x.n}件・★${x.avgRate ? x.avgRate.toFixed(1) : '—'}</span></span>
          <b class="${x.median > 1.1 ? 'over' : x.median < 0.9 ? 'under' : ''}">${Math.round(x.median * 100)}%</b></div>
          ${e ? `<div class="kv-line sub"><span>次に30分と見積もるなら → ${fmtMin(30 * e.ratio)}が目安</span><span></span></div>` : ''}`;
      }).join('') || '<p class="small muted">予想時間つきの記録がたまると表示されます</p>'}
    </section>
    <section class="card section"><h2>ずれた理由・よかったこと</h2>
      ${reasonCount.length ? reasonCount.map(([r, n]) => `<div class="kv-line"><span>${esc(r)}</span><b>${n}回</b></div>`).join('') : '<p class="small muted">振り返りで理由を選ぶと集計されます</p>'}
    </section>`;
  main.querySelector('[data-range]').onchange = (e) => { ui.range = Number(e.target.value); ctx.rerender(); };
}
