import { state, upsertRow, norm, getConfig, setConfig } from '../store.js';
import { groups, membersOf, colorOf, nameOf, matchesSel } from '../oshi.js';
import { esc, today, parseYmd, WD, yen, num, uid, isValidYmd, fmtMD } from '../util.js';
import { nextStep } from '../plans.js';
import { openModal, closeModal, toast, formValues, field, input, select } from '../ui.js';

export const LIVE_STATUS = ['申込中', '当選', '落選', '参戦済', '配信視聴', '不参加'];
const STATUS_COLOR = { 申込中: '#d97706', 当選: '#db2777', 落選: '#6b7280', 参戦済: '#16a34a', 配信視聴: '#0891b2', 不参加: '#9ca3af' };
const ATTENDED = ['参戦済', '配信視聴'];
const SPENT = ['参戦済', '配信視聴', '当選'];

const ui = { status: '', year: '' };
export const DEFAULT_CHECKLIST = ['チケット（発券・アプリ）', '身分証', 'スマホ・モバイルバッテリー', 'ペンライト・電池', 'うちわ・グッズ', '現金・交通系IC', '宿の予約確認'];

export function checklistOf(l) {
  try { const a = JSON.parse(l.Checklist || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

export function renderLives(main, ctx) {
  const t = today();
  const all = state.data.lives.filter((l) => matchesSel(l.OshiID, ctx.sel));
  const years = [...new Set(all.map((l) => String(l.Date).slice(0, 4)).filter(Boolean))].sort().reverse();
  const list = all
    .filter((l) => (!ui.status || l.Status === ui.status) && (!ui.year || String(l.Date).startsWith(ui.year)))
    .sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
  const attended = list.filter((l) => ATTENDED.includes(l.Status) && l.Date <= t).length;
  const spent = list.filter((l) => SPENT.includes(l.Status)).reduce((s, l) => s + num(l.Ticket) + num(l.Travel), 0);
  const next = all.filter((l) => l.Status === '当選' && l.Date >= t).sort((a, b) => a.Date.localeCompare(b.Date))[0];
  const daysTo = next ? Math.round((parseYmd(next.Date) - parseYmd(t)) / 864e5) : null;

  let html = `
    <div class="stats">
      <div class="card stat"><b>${attended}</b><span>参戦回数</span></div>
      <div class="card stat"><b>${yen(spent)}</b><span>支出（チケット・遠征）</span></div>
      <div class="card stat"><b>${daysTo === null ? '—' : daysTo === 0 ? '今日!' : `あと${daysTo}日`}</b><span>次の参戦</span></div>
    </div>
    <div class="toolbar">
      <select class="sel" data-status aria-label="状態"><option value="">状態: すべて</option>${LIVE_STATUS.map((s) => `<option ${s === ui.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select class="sel" data-year aria-label="年"><option value="">年: すべて</option>${years.map((y) => `<option ${y === ui.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
    </div>`;

  if (!list.length) html += '<div class="empty">参戦記録はまだありません。<br>右下の＋から追加できます。</div>';
  const upcoming = list.filter((l) => l.Date >= t).reverse();
  const past = list.filter((l) => !(l.Date >= t));
  if (upcoming.length) html += `<div class="year">これから</div>${upcoming.map(rowHtml).join('')}`;
  let curYear = '';
  for (const l of past) {
    const y = String(l.Date).slice(0, 4);
    if (y !== curYear) { html += `<div class="year">${esc(y)}年</div>`; curYear = y; }
    html += rowHtml(l);
  }
  main.innerHTML = html;

  main.querySelector('[data-status]').onchange = (e) => { ui.status = e.target.value; ctx.rerender(); };
  main.querySelector('[data-year]').onchange = (e) => { ui.year = e.target.value; ctx.rerender(); };
  const byId = new Map(list.map((l) => [l.LiveID, l]));
  main.querySelectorAll('[data-live]').forEach((b) => b.onclick = () => openLiveEditor(byId.get(b.dataset.live), ctx));
  ctx.setFab(() => openLiveEditor(null, ctx));
}

function rowHtml(l) {
  const d = isValidYmd(l.Date) ? parseYmd(l.Date) : null;
  const meta = [l.Venue, l.Seat && `🎫${l.Seat}`, l.Companions && `👥${l.Companions}`].filter(Boolean).join('　');
  const step = nextStep(l);
  const cl = checklistOf(l);
  return `<button type="button" class="card live" style="--c:${colorOf(l.OshiID)}" data-live="${esc(l.LiveID)}">
    <div class="dt">${d ? `<span>${d.getMonth() + 1}月</span><b>${d.getDate()}</b><span>(${WD[d.getDay()]})</span>` : '<b>—</b>'}</div>
    <div class="info">
      <div class="row" style="gap:6px"><span class="badge" style="--c:${STATUS_COLOR[l.Status] || '#6b7280'}">${esc(l.Status || '—')}</span><span class="small muted">${esc(nameOf(l.OshiID))}</span>${l.Rating ? `<span class="small" style="color:#f59e0b">${'★'.repeat(num(l.Rating))}</span>` : ''}</div>
      <div class="ttl">${esc(l.Title)}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      ${step || cl.length ? `<div class="row small" style="gap:6px;margin-top:4px;flex-wrap:wrap">
        ${step ? `<span class="badge" style="--c:#dc2626">${esc(step.label)} ${fmtMD(step.date)}${step.time ? ` ${step.time}` : ''}</span>` : ''}
        ${cl.length ? `<span class="muted">🧳 持ち物 ${cl.filter((x) => x.d).length}/${cl.length}</span>` : ''}</div>` : ''}
    </div></button>`;
}

const toLocalDT = (v) => String(v || '').replace(' ', 'T').slice(0, 16);
const fromLocalDT = (v) => String(v || '').replace('T', ' ');

/** opts.section: 'apply' | 'travel' を指定すると、その欄を開いた状態で表示する */
export function openLiveEditor(l, ctx, preset = {}, opts = {}) {
  const isNew = !l;
  const row = l || {
    LiveID: uid('l'), OshiID: ctx.sel.member || ctx.sel.group || groups()[0]?.OshiID || '', Date: today(), Open: '', Start: '', Title: '', Tour: '', Venue: '',
    Status: '申込中', Seat: '', Companions: '', Ticket: '', Travel: '', Setlist: '', Photos: '', Rating: '', Memo: '',
    ApplyBy: '', ResultAt: '', PayBy: '', Paid: '', IssueAt: '', Issued: '', TravelMemo: '', Checklist: '', ...preset,
  };
  let rating = num(row.Rating);
  let checklist = checklistOf(row);
  const oshiOpts = groups().flatMap((g) => [[g.OshiID, g.Name], ...membersOf(g.OshiID).map((m) => [m.OshiID, `　${m.Name}`])]);
  const stars = () => [1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${n <= rating ? 'on' : ''}" aria-label="${n}点">★</button>`).join('');
  const checkHtml = () => checklist.map((x, i) => `<div class="check-row"><label><input type="checkbox" data-ck="${i}" ${x.d ? 'checked' : ''}><span>${esc(x.t)}</span></label><button type="button" class="icon-btn" data-ck-del="${i}" aria-label="削除">✕</button></div>`).join('')
    || '<p class="small muted">まだありません</p>';
  const open = (name) => (opts.section === name ? 'open' : '');

  openModal({
    title: isNew ? '参戦記録を追加' : '参戦記録',
    body: `
      <div class="fields-2">${field('推し', select('OshiID', oshiOpts, row.OshiID))}${field('状態', select('Status', LIVE_STATUS.map((s) => [s, s]), row.Status))}</div>
      ${field('公演名', input('Title', row.Title, 'required'))}
      ${field('ツアー名', input('Tour', row.Tour))}
      ${field('日付', input('Date', row.Date, 'type="date" required'))}
      <div class="fields-2">${field('開場', input('Open', row.Open, 'type="time"'))}${field('開演', input('Start', row.Start, 'type="time"'))}</div>
      ${field('会場', input('Venue', row.Venue))}
      <div class="fields-2">${field('チケット代（円）', input('Ticket', row.Ticket, 'type="number" inputmode="numeric" min="0"'))}${field('遠征費（円）', input('Travel', row.Travel, 'type="number" inputmode="numeric" min="0"'))}</div>

      <details class="sec" ${open('apply')}><summary>📝 申込・入金</summary>
        <div class="fields-2">${field('申込締切', input('ApplyBy', toLocalDT(row.ApplyBy), 'type="datetime-local"'))}${field('当落発表', input('ResultAt', toLocalDT(row.ResultAt), 'type="datetime-local"'))}</div>
        <div class="fields-2">${field('入金締切', input('PayBy', toLocalDT(row.PayBy), 'type="datetime-local"'))}${field('発券開始', input('IssueAt', toLocalDT(row.IssueAt), 'type="datetime-local"'))}</div>
        <div class="checks" style="margin-bottom:12px">
          <label><input type="checkbox" name="Paid" value="TRUE" ${norm(row.Paid) === 'TRUE' ? 'checked' : ''}>入金済み</label>
          <label><input type="checkbox" name="Issued" value="TRUE" ${norm(row.Issued) === 'TRUE' ? 'checked' : ''}>発券済み</label>
        </div>
        <p class="small muted">状態が「申込中」なら申込締切・当落発表、「当選」なら入金締切・発券開始を、ホームとカレンダーに表示し、通知にも入れます。</p>
      </details>

      <details class="sec" ${open('travel')}><summary>🧳 遠征</summary>
        ${field('交通・宿のメモ', `<textarea name="TravelMemo" rows="4" placeholder="新幹線 9:30 東京発 / ホテル〇〇 予約番号…">${esc(row.TravelMemo)}</textarea>`)}
        <div class="field"><span>持ち物チェックリスト</span><div data-checklist>${checkHtml()}</div>
          <div class="row" style="margin-top:6px"><input class="search" data-ck-new placeholder="持ち物を追加"><button type="button" class="btn sm" data-ck-add>追加</button></div>
          <div class="row" style="margin-top:6px;flex-wrap:wrap"><button type="button" class="btn sm" data-ck-tpl>いつもの持ち物を入れる</button><button type="button" class="btn sm" data-ck-save-tpl>この内容をいつもの持ち物にする</button></div>
        </div>
      </details>

      <details class="sec" ${open('record')}><summary>🎤 記録</summary>
        <div class="fields-2">${field('座席', input('Seat', row.Seat))}${field('同行者', input('Companions', row.Companions))}</div>
        <div class="field"><span>評価</span><div class="stars" data-stars>${stars()}</div></div>
        ${field('セットリスト（1行に1曲）', `<textarea name="Setlist" rows="6">${esc(row.Setlist)}</textarea>`)}
        ${field('メモ・感想', `<textarea name="Memo">${esc(row.Memo)}</textarea>`)}
      </details>`,
    foot: `${isNew ? '' : '<button type="button" class="btn danger" data-del>削除</button>'}<span class="spacer"></span><button type="button" class="btn primary" data-save>保存</button>`,
    onMount: (m) => {
      const box = m.querySelector('[data-stars]');
      box.onclick = (e) => {
        const n = Number(e.target.dataset.star);
        if (!n) return;
        rating = rating === n ? 0 : n;
        box.innerHTML = stars();
      };
      const list = m.querySelector('[data-checklist]');
      const redrawList = () => { list.innerHTML = checkHtml(); };
      list.onclick = (e) => {
        const del = e.target.closest('[data-ck-del]');
        if (del) { checklist.splice(Number(del.dataset.ckDel), 1); redrawList(); }
      };
      list.onchange = (e) => { if (e.target.dataset.ck !== undefined) checklist[Number(e.target.dataset.ck)].d = e.target.checked; };
      const addItem = () => {
        const inp = m.querySelector('[data-ck-new]');
        if (!inp.value.trim()) return;
        checklist.push({ t: inp.value.trim(), d: false });
        inp.value = '';
        redrawList();
      };
      m.querySelector('[data-ck-add]').onclick = addItem;
      m.querySelector('[data-ck-new]').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addItem(); } };
      m.querySelector('[data-ck-tpl]').onclick = () => {
        const tpl = getConfig('checklistTemplate', DEFAULT_CHECKLIST);
        const have = new Set(checklist.map((x) => x.t));
        tpl.filter((t) => !have.has(t)).forEach((t) => checklist.push({ t, d: false }));
        redrawList();
      };
      m.querySelector('[data-ck-save-tpl]').onclick = async () => {
        if (!checklist.length) return toast('持ち物がありません');
        await setConfig('checklistTemplate', checklist.map((x) => x.t));
        toast('いつもの持ち物として保存しました');
      };
      m.querySelector('[data-save]').onclick = async () => {
        const v = formValues(m);
        if (!v.Title || !isValidYmd(v.Date)) return toast('公演名と日付を入れてください');
        const rec = {
          ...row, ...v,
          ApplyBy: fromLocalDT(v.ApplyBy), ResultAt: fromLocalDT(v.ResultAt), PayBy: fromLocalDT(v.PayBy), IssueAt: fromLocalDT(v.IssueAt),
          Paid: v.Paid.length ? 'TRUE' : '', Issued: v.Issued.length ? 'TRUE' : '',
          Checklist: checklist.length ? JSON.stringify(checklist) : '',
          Rating: rating ? String(rating) : '',
        };
        await upsertRow('Lives', rec);
        closeModal();
        toast('保存しました');
      };
      m.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!confirm(`「${row.Title}」の記録を削除しますか？`)) return;
        await upsertRow('Lives', { ...row, Deleted: true });
        closeModal();
        toast('削除しました');
      });
    },
  });
}
