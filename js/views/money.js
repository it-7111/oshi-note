// お金タブ：月別・年別の支出集計と、求リストに合わせた貯金目標
import { state, upsertRow, getConfig, setConfig } from '../store.js';
import { groups, membersOf, goodsMemberIds, groupBySheet, groupOf, colorOf, nameOf, matchesSel, personNames } from '../oshi.js';
import { esc, yen, num, today, uid, isValidYmd, parseYmd, fmtMD } from '../util.js';
import { openModal, closeModal, toast, formValues, field, input, select } from '../ui.js';

export const EXPENSE_CATEGORIES = ['FC会費', '配信チケット', 'カフェ・コラボ', '交通', '宿泊', 'プレゼント・お花', 'グッズ（その他）', 'その他'];
const SPENT = ['参戦済', '配信視聴', '当選'];
const PLANNED = ['申込中', '当選'];

const ui = { view: 'spend', period: 'month', cursor: today().slice(0, 7) };

// ───────── 支出データ ─────────

/** すべての支出を {date, cat, oshi, title, amount, src, ref} にそろえる */
function spendEntries() {
  const d = state.data;
  const goodsMap = new Map(d.goods.map((g) => [`${g.Sheet}:${g.ID}`, g]));
  const out = [];
  for (const p of d.purchases) {
    const g = goodsMap.get(`${p.sheet}:${p.id}`);
    if (!g || !p.date || !num(g.Price)) continue;
    const ids = goodsMemberIds(g);
    const oshi = ids.length === 1 ? ids[0] : groupBySheet(g.Sheet)?.OshiID || '';
    const who = personNames(g).join('・');
    out.push({ date: p.date, cat: 'グッズ', oshi, title: `${g.Name}${who ? `（${who}）` : ''}${Math.abs(p.delta) > 1 ? ` ×${p.delta}` : ''}`, amount: num(g.Price) * p.delta, src: 'goods', ref: g });
  }
  for (const l of d.lives) {
    if (!SPENT.includes(l.Status) || !isValidYmd(l.Date)) continue;
    if (num(l.Ticket)) out.push({ date: l.Date, cat: 'チケット', oshi: l.OshiID, title: l.Title, amount: num(l.Ticket), src: 'live', ref: l });
    if (num(l.Travel)) out.push({ date: l.Date, cat: '遠征', oshi: l.OshiID, title: `${l.Title}（遠征）`, amount: num(l.Travel), src: 'live', ref: l });
  }
  for (const x of d.expenses) {
    if (!isValidYmd(x.Date)) continue;
    out.push({ date: x.Date, cat: x.Category || 'その他', oshi: x.OshiID, title: x.Memo || x.Category, amount: num(x.Amount), src: 'expense', ref: x });
  }
  return out;
}

/** 購入日の記録がない所持グッズの金額（アプリ導入前の分） */
function undatedGoods() {
  const logged = new Map();
  state.data.purchases.forEach((p) => logged.set(`${p.sheet}:${p.id}`, (logged.get(`${p.sheet}:${p.id}`) || 0) + p.delta));
  return state.data.goods.reduce((s, g) => s + Math.max(0, num(g.Have) - Math.max(0, logged.get(`${g.Sheet}:${g.ID}`) || 0)) * num(g.Price), 0);
}

// ───────── 描画 ─────────

export function renderMoney(main, ctx) {
  if (ctx.moneyView) { ui.view = ctx.moneyView; ctx.moneyView = null; }
  const seg = `<div class="seg" role="group" style="margin:2px 0 10px;display:flex">
    <button type="button" data-mv="spend" aria-pressed="${ui.view === 'spend'}" style="flex:1">支出</button>
    <button type="button" data-mv="savings" aria-pressed="${ui.view === 'savings'}" style="flex:1">貯金目標</button></div>`;
  if (ui.view === 'savings') {
    ctx.hideChips();
    renderSavings(main, ctx, seg);
  } else {
    renderSpend(main, ctx, seg);
  }
  main.querySelectorAll('[data-mv]').forEach((b) => b.onclick = () => { ui.view = b.dataset.mv; ctx.rerender({ resetScroll: true }); });
}

function barList(rows, total, colorFn) {
  if (!rows.length) return '<p class="small muted">支出はありません</p>';
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return `<div class="bars">${rows.map(([label, v, key]) => `
    <div class="bar-row" title="${esc(label)}：${yen(v)}">
      <span class="bl">${colorFn ? `<i class="sw" style="background:${colorFn(key)}"></i>` : ''}${esc(label)}</span>
      <span class="bt"><i style="width:${Math.max(2, (v / max) * 100)}%;${colorFn ? `background:${colorFn(key)}` : ''}"></i></span>
      <span class="bv">${yen(v)}<small>${total ? Math.round((v / total) * 100) : 0}%</small></span>
    </div>`).join('')}</div>`;
}

function sumBy(list, keyFn) {
  const m = new Map();
  list.forEach((e) => { const k = keyFn(e); m.set(k, (m.get(k) || 0) + e.amount); });
  return [...m.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
}

function renderSpend(main, ctx, seg) {
  const all = spendEntries().filter((e) => matchesSel(e.oshi, ctx.sel));
  const isMonth = ui.period === 'month';
  if (!isMonth && ui.cursor.length !== 4) ui.cursor = ui.cursor.slice(0, 4);
  if (isMonth && ui.cursor.length !== 7) ui.cursor = `${ui.cursor}-${today().slice(5, 7)}`;
  const inPeriod = (c) => all.filter((e) => e.date.startsWith(c));
  const list = inPeriod(ui.cursor).sort((a, b) => b.date.localeCompare(a.date));
  const total = list.reduce((s, e) => s + e.amount, 0);
  const prev = shiftCursor(ui.cursor, -1);
  const prevTotal = inPeriod(prev).reduce((s, e) => s + e.amount, 0);
  const diff = total - prevTotal;
  const title = isMonth ? `${ui.cursor.slice(0, 4)}年${Number(ui.cursor.slice(5))}月` : `${ui.cursor}年`;

  // 推しごとの集計はグループ単位（メンバー選択中はメンバー単位）
  const oshiKey = (e) => (ctx.sel.group ? e.oshi || ctx.sel.group : groupOf(e.oshi)?.OshiID || '');

  let html = `${seg}
    <div class="row" style="margin-bottom:8px">
      <div class="seg" role="group"><button type="button" data-period="month" aria-pressed="${isMonth}">月</button><button type="button" data-period="year" aria-pressed="${!isMonth}">年</button></div>
      <span class="spacer"></span>
      <button type="button" class="icon-btn" data-shift="-1" aria-label="前へ">‹</button>
      <b style="min-width:110px;text-align:center">${title}</b>
      <button type="button" class="icon-btn" data-shift="1" aria-label="次へ">›</button>
    </div>
    <div class="card hero">
      <span class="small muted">${title}の支出</span>
      <b>${yen(total)}</b>
      <span class="small ${prevTotal ? (diff > 0 ? 'up' : 'down') : 'muted'}">${prevTotal ? `${isMonth ? '前月' : '前年'}より ${diff >= 0 ? '+' : '−'}${yen(Math.abs(diff))}` : `${isMonth ? '前月' : '前年'}の記録なし`}</span>
    </div>`;

  if (!isMonth) {
    const months = Array.from({ length: 12 }, (_, i) => `${ui.cursor}-${String(i + 1).padStart(2, '0')}`);
    const vals = months.map((m) => inPeriod(m).reduce((s, e) => s + e.amount, 0));
    const max = Math.max(...vals, 1);
    html += `<section class="card section"><h2>月ごとの支出</h2>
      <div class="cols" role="list">${months.map((m, i) => `
        <button type="button" class="col" role="listitem" data-month="${m}" aria-label="${i + 1}月 ${yen(vals[i])}" title="${i + 1}月：${yen(vals[i])}">
          <span class="cv">${vals[i] ? (vals[i] >= 10000 ? `${Math.round(vals[i] / 1000) / 10}万` : vals[i].toLocaleString()) : ''}</span>
          <span class="cb"><i style="height:${(vals[i] / max) * 100}%"></i></span>
          <span class="cl">${i + 1}</span></button>`).join('')}</div>
      <p class="small muted" style="margin-bottom:0">棒をタップするとその月を表示します</p></section>`;
  }

  html += `<section class="card section"><h2>内訳</h2>${barList(sumBy(list, (e) => e.cat), total)}</section>
    <section class="card section"><h2>推しごと</h2>${barList(sumBy(list, oshiKey).map(([k, v]) => [nameOf(k) || '未設定', v, k]), total, (k) => colorOf(k))}</section>`;

  if (isMonth) {
    html += `<section class="card section"><h2>明細（${list.length}件）</h2>
      ${list.length ? list.map((e, i) => `<button type="button" class="entry" data-entry="${i}">
        <span class="ed">${fmtMD(e.date)}</span>
        <span class="et"><span class="badge" style="--c:${colorOf(e.oshi)}">${esc(e.cat)}</span> ${esc(e.title)}</span>
        <span class="ea">${yen(e.amount)}</span></button>`).join('') : '<p class="small muted">ありません。右下の＋でFC会費や交通費なども記録できます。</p>'}
    </section>`;
  }
  html += `<p class="small muted">グッズはアプリで所持数を増やした日に計上します（価格×個数）。${yen(undatedGoods())} 分の所持グッズは購入日の記録がないため、集計に入っていません。チケット代・遠征費は参戦記録の公演日に計上します。</p>`;
  main.innerHTML = html;

  main.querySelectorAll('[data-period]').forEach((b) => b.onclick = () => {
    ui.period = b.dataset.period;
    ui.cursor = ui.period === 'year' ? ui.cursor.slice(0, 4) : (ui.cursor.slice(0, 4) === today().slice(0, 4) ? today().slice(0, 7) : `${ui.cursor.slice(0, 4)}-12`);
    ctx.rerender();
  });
  main.querySelectorAll('[data-shift]').forEach((b) => b.onclick = () => { ui.cursor = shiftCursor(ui.cursor, Number(b.dataset.shift)); ctx.rerender(); });
  main.querySelectorAll('[data-month]').forEach((b) => b.onclick = () => { ui.period = 'month'; ui.cursor = b.dataset.month; ctx.rerender({ resetScroll: true }); });
  main.querySelectorAll('[data-entry]').forEach((b) => b.onclick = () => {
    const e = list[Number(b.dataset.entry)];
    if (e.src === 'expense') openExpenseEditor(e.ref, ctx);
    else toast(e.src === 'goods' ? 'グッズの価格・個数はグッズタブで変更できます' : 'チケット代・遠征費は参戦記録で変更できます');
  });
  ctx.setFab(() => openExpenseEditor(null, ctx));
}

function shiftCursor(c, n) {
  if (c.length === 4) return String(Number(c) + n);
  const d = parseYmd(`${c}-01`);
  d.setMonth(d.getMonth() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function oshiOptions() {
  return [['', '—'], ...groups().flatMap((g) => [[g.OshiID, g.Name], ...membersOf(g.OshiID).map((m) => [m.OshiID, `　${m.Name}`])])];
}

function openExpenseEditor(x, ctx) {
  const isNew = !x;
  const row = x || { ExpenseID: uid('x'), Date: today(), OshiID: ctx.sel.member || ctx.sel.group || groups()[0]?.OshiID || '', Category: 'FC会費', Amount: '', Memo: '' };
  const cats = [...new Set([...EXPENSE_CATEGORIES, row.Category].filter(Boolean))];
  openModal({
    title: isNew ? '支出を記録' : '支出を編集',
    body: `
      <div class="fields-2">${field('日付', input('Date', row.Date, 'type="date" required'))}${field('金額（円）', input('Amount', row.Amount, 'type="number" inputmode="numeric" required'))}</div>
      <div class="fields-2">${field('推し', select('OshiID', oshiOptions(), row.OshiID))}${field('分類', select('Category', cats.map((c) => [c, c]), row.Category))}</div>
      ${field('メモ', input('Memo', row.Memo, 'placeholder="例：FC年会費"'))}
      <p class="small muted">グッズの購入やチケット代・遠征費は自動で集計されるので、ここではそれ以外の支出を記録します。</p>`,
    foot: `${isNew ? '' : '<button type="button" class="btn danger" data-del>削除</button>'}<span class="spacer"></span><button type="button" class="btn primary" data-save>保存</button>`,
    onMount: (m) => {
      m.querySelector('[data-save]').onclick = async () => {
        const v = formValues(m);
        if (!isValidYmd(v.Date) || !num(v.Amount)) return toast('日付と金額を入れてください');
        await upsertRow('Expenses', { ...row, ...v, Amount: String(num(v.Amount)) }, x?.UpdatedAt || '');
        closeModal();
        toast('保存しました');
      };
      m.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!confirm('この支出を削除しますか？')) return;
        await upsertRow('Expenses', { ...row, Deleted: true }, x?.UpdatedAt || '');
        closeModal();
      });
    },
  });
}

// ───────── 貯金目標 ─────────

export function savingsGoal() {
  const goal = { targetDate: '', includeLives: true, extra: 0, ...getConfig('savingsGoal', {}) };
  const t = today();
  const wants = state.data.goods.filter((g) => num(g.Want) > 0);
  const wantTotal = wants.reduce((s, g) => s + num(g.Want) * num(g.Price), 0);
  const lives = goal.includeLives ? state.data.lives.filter((l) => PLANNED.includes(l.Status) && l.Date >= t) : [];
  const livesTotal = lives.reduce((s, l) => s + num(l.Ticket) + num(l.Travel), 0);
  const target = wantTotal + livesTotal + num(goal.extra);
  const saved = state.data.savings.reduce((s, x) => s + num(x.Amount), 0);
  const days = isValidYmd(goal.targetDate) ? Math.round((parseYmd(goal.targetDate) - parseYmd(t)) / 864e5) : null;
  return { goal, wants, wantTotal, noPrice: wants.filter((g) => !num(g.Price)).length, lives, livesTotal, target, saved, remain: Math.max(0, target - saved), days };
}

function renderSavings(main, ctx, seg) {
  const s = savingsGoal();
  const pct = s.target ? Math.min(100, Math.round((s.saved / s.target) * 100)) : 0;
  const months = s.days !== null && s.days > 0 ? Math.max(1, Math.ceil(s.days / 30.4)) : null;
  const weeks = s.days !== null && s.days > 0 ? Math.max(1, Math.ceil(s.days / 7)) : null;
  const byGroup = new Map();
  s.wants.forEach((g) => {
    const k = groupBySheet(g.Sheet)?.OshiID || '';
    byGroup.set(k, (byGroup.get(k) || 0) + num(g.Want) * num(g.Price));
  });
  const history = [...state.data.savings].sort((a, b) => String(b.Date).localeCompare(String(a.Date)));

  let html = `${seg}
    <div class="card hero">
      <span class="small muted">貯金 / 目標</span>
      <b>${yen(s.saved)} <small class="muted">/ ${yen(s.target)}</small></b>
      <div class="goal-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
      <span class="small">${s.target === 0 ? '求リストに「欲しい数」と価格を入れると目標額になります' : s.remain === 0 ? '🎉 目標達成！' : `あと <b>${yen(s.remain)}</b>（${pct}%達成）`}</span>
    </div>
    <section class="card section">
      <h2>ペース</h2>
      ${s.days === null ? '<p class="small">目標日を決めると、月・週あたりの必要額を計算します。</p>'
        : s.days <= 0 ? `<p class="small">目標日（${fmtMD(s.goal.targetDate)}）を過ぎています。</p>`
        : s.remain === 0 ? '<p class="small">目標額に届いています。求リストが増えたら、ここで必要額を確認できます。</p>'
        : `<div class="stats two" style="margin:0">
            <div class="stat card"><b>${yen(Math.ceil(s.remain / months))}</b><span>1か月あたり（残り${months}か月）</span></div>
            <div class="stat card"><b>${yen(Math.ceil(s.remain / weeks))}</b><span>1週あたり（残り${s.days}日）</span></div></div>
           <p class="small muted" style="margin-bottom:0">目標日：${parseYmd(s.goal.targetDate).getFullYear()}年${fmtMD(s.goal.targetDate)}</p>`}
      <button type="button" class="btn sm" data-goal-edit style="margin-top:8px">目標を設定</button>
    </section>
    <section class="card section">
      <h2>目標額の内訳</h2>
      <div class="kv-line"><span>🎁 求リスト（${s.wants.length}件）</span><b>${yen(s.wantTotal)}</b></div>
      ${[...byGroup.entries()].map(([k, v]) => `<div class="kv-line sub"><span><i class="sw" style="background:${colorOf(k)}"></i>${esc(nameOf(k) || '—')}</span><span>${yen(v)}</span></div>`).join('')}
      ${s.noPrice ? `<p class="small" style="color:var(--danger);margin:4px 0">価格が入っていない求グッズが${s.noPrice}件あります（0円で計算）</p>` : ''}
      ${s.goal.includeLives ? `<div class="kv-line"><span>🎤 参戦予定（申込中・当選 ${s.lives.length}件）</span><b>${yen(s.livesTotal)}</b></div>
        ${s.lives.map((l) => `<div class="kv-line sub"><span>${fmtMD(l.Date)} ${esc(l.Title)}</span><span>${yen(num(l.Ticket) + num(l.Travel))}</span></div>`).join('')}` : ''}
      ${num(s.goal.extra) ? `<div class="kv-line"><span>➕ 追加の目標</span><b>${yen(s.goal.extra)}</b></div>` : ''}
      <button type="button" class="btn sm" data-to-trade style="margin-top:8px">求リストを開く</button>
    </section>
    <section class="card section">
      <div class="row"><h2 style="margin:0">貯金の記録</h2><span class="spacer"></span>
        <button type="button" class="btn sm" data-save-add="-1">出金</button><button type="button" class="btn sm primary" data-save-add="1">入金</button></div>
      ${history.length ? history.map((x, i) => `<button type="button" class="entry" data-saving="${i}">
        <span class="ed">${isValidYmd(x.Date) ? fmtMD(x.Date) : ''}</span><span class="et">${esc(x.Memo || (num(x.Amount) >= 0 ? '入金' : '出金'))}</span>
        <span class="ea ${num(x.Amount) < 0 ? 'neg' : ''}">${num(x.Amount) >= 0 ? '+' : '−'}${yen(Math.abs(num(x.Amount)))}</span></button>`).join('') : '<p class="small muted">まだ記録がありません</p>'}
    </section>`;
  main.innerHTML = html;

  main.querySelector('[data-goal-edit]').onclick = () => openGoalEditor(s.goal);
  main.querySelector('[data-to-trade]').onclick = () => ctx.goTab('goods', { goodsMode: 'trade' });
  main.querySelectorAll('[data-save-add]').forEach((b) => b.onclick = () => openSavingEditor(null, Number(b.dataset.saveAdd)));
  main.querySelectorAll('[data-saving]').forEach((b) => b.onclick = () => openSavingEditor(history[Number(b.dataset.saving)]));
  ctx.setFab(null);
}

function openGoalEditor(goal) {
  openModal({
    title: '貯金目標',
    body: `
      ${field('目標日', input('targetDate', goal.targetDate, 'type="date"'))}
      <div class="toggle-list" style="margin-bottom:12px"><label><input type="checkbox" name="includeLives" value="1" ${goal.includeLives ? 'checked' : ''}>参戦予定（申込中・当選）のチケット代・遠征費も含める</label></div>
      ${field('追加の目標額（円）', input('extra', goal.extra || '', 'type="number" inputmode="numeric" min="0" placeholder="例：遠征の予備費"'))}
      <p class="small muted">目標額 ＝ 求リスト（欲しい数×価格）＋ 参戦予定 ＋ 追加の目標額</p>`,
    foot: '<span class="spacer"></span><button type="button" class="btn primary" data-save>保存</button>',
    onMount: (m) => {
      m.querySelector('[data-save]').onclick = async () => {
        const v = formValues(m);
        await setConfig('savingsGoal', { targetDate: v.targetDate, includeLives: v.includeLives.length > 0, extra: num(v.extra) });
        closeModal();
        toast('保存しました');
      };
    },
  });
}

function openSavingEditor(x, sign = 1) {
  const isNew = !x;
  const row = x || { SavingID: uid('s'), Date: today(), Amount: '', Memo: '' };
  const outflow = isNew ? sign < 0 : num(row.Amount) < 0;
  openModal({
    title: isNew ? (outflow ? '出金を記録' : '入金を記録') : '貯金の記録を編集',
    body: `
      <div class="fields-2">${field('日付', input('Date', row.Date, 'type="date"'))}${field('金額（円）', input('Amount', row.Amount ? Math.abs(num(row.Amount)) : '', 'type="number" inputmode="numeric" min="1" required'))}</div>
      ${field('メモ', input('Memo', row.Memo, `placeholder="${outflow ? '例：ツアーグッズ購入' : '例：バイト代から'}"`))}`,
    foot: `${isNew ? '' : '<button type="button" class="btn danger" data-del>削除</button>'}<span class="spacer"></span><button type="button" class="btn primary" data-save>保存</button>`,
    onMount: (m) => {
      m.querySelector('[data-save]').onclick = async () => {
        const v = formValues(m);
        if (!num(v.Amount) || !isValidYmd(v.Date)) return toast('日付と金額を入れてください');
        await upsertRow('Savings', { ...row, ...v, Amount: String((outflow ? -1 : 1) * Math.abs(num(v.Amount))) }, x?.UpdatedAt || '');
        closeModal();
        toast('保存しました');
      };
      m.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!confirm('この記録を削除しますか？')) return;
        await upsertRow('Savings', { ...row, Deleted: true }, x?.UpdatedAt || '');
        closeModal();
      });
    },
  });
}
