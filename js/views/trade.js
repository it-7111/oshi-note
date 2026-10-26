// 譲・求リスト（グッズタブ内の表示）
import { state, keyOf, goodsUpdate } from '../store.js';
import { groupBySheet, personNames } from '../oshi.js';
import { esc, yen, num } from '../util.js';
import { toast } from '../ui.js';

const ui = { side: 'want' };

/** 名前＋サブタイトル（＋メンバー）ごとにまとめる */
function bySet(list) {
  const sets = new Map();
  for (const g of list) {
    const k = `${g.Sheet}|${g.Name}|${g.Sub}`;
    if (!sets.has(k)) sets.set(k, []);
    sets.get(k).push(g);
  }
  return sets;
}
const who = (g) => personNames(g).join('・') || (g.Person ? '全員' : '');
const setTitle = (g) => `${g.Name}${g.Sub ? ` ${g.Sub}` : ''}`;

/** SNSに貼る用のテキスト */
export function tradeText(list) {
  const part = (field, label) => {
    const lines = [];
    for (const items of bySet(list.filter((g) => num(g[field]) > 0)).values()) {
      const names = items.map((g) => `${who(g) || ''}${num(g[field]) > 1 ? `×${num(g[field])}` : ''}`).filter(Boolean);
      lines.push(`・${setTitle(items[0])}${names.length ? `：${names.join('、')}` : num(items[0][field]) > 1 ? ` ×${num(items[0][field])}` : ''}`);
    }
    return lines.length ? `【${label}】\n${lines.join('\n')}` : '';
  };
  return [part('Trade', '譲'), part('Want', '求')].filter(Boolean).join('\n\n');
}

export function renderTrade(main, ctx, { list, imageUrl, openEditor, modeSeg }) {
  const wants = list.filter((g) => num(g.Want) > 0);
  const trades = list.filter((g) => num(g.Trade) > 0);
  const wantTotal = wants.reduce((s, g) => s + num(g.Want) * num(g.Price), 0);
  const noPrice = wants.filter((g) => !num(g.Price)).length;

  // 同じセット内で「譲」と「求」が両方あるもの＝交換候補
  const matches = [];
  for (const items of bySet(list).values()) {
    const t = items.filter((g) => num(g.Trade) > 0);
    const w = items.filter((g) => num(g.Want) > 0);
    if (t.length && w.length) matches.push({ title: setTitle(items[0]), t, w });
  }

  const shown = ui.side === 'want' ? wants : trades;
  const field = ui.side === 'want' ? 'Want' : 'Trade';
  let html = `${modeSeg}
    <div class="stats">
      <div class="card stat"><b>${wants.reduce((s, g) => s + num(g.Want), 0)}</b><span>求（点）</span></div>
      <div class="card stat"><b>${yen(wantTotal)}</b><span>求の合計${noPrice ? `（価格なし${noPrice}件）` : ''}</span></div>
      <div class="card stat"><b>${trades.reduce((s, g) => s + num(g.Trade), 0)}</b><span>譲（点）</span></div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <button type="button" class="btn sm" data-copy>📋 譲求テキストをコピー</button>
      <span class="spacer"></span>
      <button type="button" class="btn sm" data-goal>🐷 貯金目標を見る</button>
    </div>`;

  if (matches.length) {
    html += `<section class="card section" style="padding:12px 14px"><h2 style="font-size:14px;margin-bottom:6px">🔁 交換候補（同じシリーズで譲と求がある）</h2>
      ${matches.map((m) => `<p class="small" style="margin:6px 0"><b>${esc(m.title)}</b><br>
        <span class="badge" style="--c:#0891b2">譲</span> ${esc(m.t.map(who).join('・') || '—')}　⇄　<span class="badge" style="--c:#db2777">求</span> ${esc(m.w.map(who).join('・') || '—')}</p>`).join('')}
    </section>`;
  }

  html += `<div class="seg" role="group" style="margin-bottom:10px">
      <button type="button" data-side="want" aria-pressed="${ui.side === 'want'}">求 ${wants.length}</button>
      <button type="button" data-side="trade" aria-pressed="${ui.side === 'trade'}">譲 ${trades.length}</button></div>`;

  if (!shown.length) {
    html += `<div class="empty">${ui.side === 'want' ? '「欲しい数」' : '「譲れる数」'}が入っているグッズはありません。<br><span class="small">グッズの詳細で数を入れると、ここに並びます。</span></div>`;
  }
  let curGroup = '';
  for (const items of bySet(shown).values()) {
    const grp = groupBySheet(items[0].Sheet);
    if (grp && grp.OshiID !== curGroup) { html += `<div class="year" style="color:${grp.Color}">${esc(grp.Name)}</div>`; curGroup = grp.OshiID; }
    html += `<div class="card" style="padding:4px 10px;margin-bottom:8px">
      <div class="small" style="font-weight:700;padding:6px 0 2px">${esc(setTitle(items[0]))}</div>
      ${items.map((g) => `<div class="g-row" data-key="${esc(keyOf(g))}" style="padding:6px 0;border-top:1px solid var(--border)">
        <button type="button" class="g-img" data-open ${g.Image ? `data-img="${esc(keyOf(g))}"` : ''} aria-label="詳細"><span aria-hidden="true">🎁</span></button>
        <div class="g-body"><div class="g-name">${esc(who(g) || g.Name)}</div>
          <div class="g-sub">${num(g.Price) ? `${yen(g.Price)}${ui.side === 'want' ? ` × ${num(g.Want)} = ${yen(num(g.Price) * num(g.Want))}` : ''}` : '価格未設定'}${ui.side === 'want' && num(g.Have) ? `　所持${num(g.Have)}` : ''}</div></div>
        <div class="stepper"><button type="button" data-n="-1" aria-label="減らす">−</button><output>${num(g[field])}</output><button type="button" data-n="1" aria-label="増やす">＋</button></div>
      </div>`).join('')}
    </div>`;
  }
  main.innerHTML = html;

  main.querySelectorAll('[data-side]').forEach((b) => b.onclick = () => { ui.side = b.dataset.side; ctx.rerender(); });
  main.querySelector('[data-goal]').onclick = () => ctx.goTab('money', { moneyView: 'savings' });
  main.querySelector('[data-copy]').onclick = async () => {
    const text = tradeText(list);
    if (!text) return toast('譲・求に入っているグッズがありません');
    try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch { prompt('コピーしてください', text); }
  };
  const byKey = new Map(list.map((g) => [keyOf(g), g]));
  main.querySelectorAll('[data-key]').forEach((row) => {
    const g = byKey.get(row.dataset.key);
    row.querySelector('[data-open]').onclick = () => openEditor(g);
    row.querySelectorAll('[data-n]').forEach((b) => b.onclick = () => goodsUpdate(g, { [field]: Math.max(0, num(g[field]) + Number(b.dataset.n)) }));
  });
  main.querySelectorAll('[data-img]').forEach(async (el) => {
    const url = await imageUrl(byKey.get(el.dataset.img));
    if (url) el.innerHTML = `<img src="${url}" alt="">`;
  });
  ctx.setFab(null);
}
