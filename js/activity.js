// 活動記録：やることを宣言 → タイマー（一時停止あり）→ 終わったら振り返り
//
// 経過時間は「区間（Segments）」の開始・終了時刻から計算するので、アプリを閉じても、
// iPhoneで始めてiPadで止めても、ずれない。
import { state, upsertRow, getConfig, setConfig, isDemo, sync, calendarSync } from './store.js';
import { groups, membersOf } from './oshi.js';
import { esc, uid, today, addDays, fmtMD, num, pad, ymd } from './util.js';
import { openModal, closeModal, toast, field, input, select } from './ui.js';

export const CATS_DEFAULT = [
  { name: '推し活', color: '#a21caf' }, { name: '勉強', color: '#2563eb' }, { name: '作業', color: '#0891b2' },
  { name: '家事', color: '#16a34a' }, { name: '運動', color: '#f59e0b' }, { name: 'その他', color: '#64748b' },
];
export const CAT_COLORS = ['#a21caf', '#db2777', '#e11d48', '#f59e0b', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#64748b'];
export const REASONS = ['割り込みがあった', '見積もりが甘かった', '思ったより簡単だった', '集中できた', '集中できなかった', '途中でやることが増えた', '準備に時間がかかった'];
const PLAN_CHOICES = [15, 30, 45, 60, 90, 120];

export const categories = () => getConfig('activityCategories', CATS_DEFAULT);
export const saveCategories = (list) => setConfig('activityCategories', list);
export const catColor = (name) => categories().find((c) => c.name === name)?.color || '#64748b';

export function segmentsOf(a) {
  try { const s = JSON.parse(a.Segments || '[]'); return Array.isArray(s) ? s : []; } catch { return []; }
}
export const elapsedMs = (a, now = Date.now()) => segmentsOf(a).reduce((sum, [st, en]) => sum + ((en ? Date.parse(en) : now) - Date.parse(st)), 0);
export const activeAct = () => state.data.activities.find((a) => a.Status === 'running' || a.Status === 'paused');
export const doneActs = () => state.data.activities.filter((a) => a.Status === 'done');

export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
export const fmtMin = (m) => { m = Math.round(num(m)); return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}` : `${m}分`; };

/** その分類で「予想の何倍かかりがちか」（3件以上あるとき、中央値） */
export function estimateRatio(category) {
  const r = doneActs()
    .filter((a) => a.Category === category && num(a.PlannedMin) > 0 && num(a.ActualMin) > 0)
    .map((a) => num(a.ActualMin) / num(a.PlannedMin))
    .sort((x, y) => x - y);
  if (r.length < 3) return null;
  return { ratio: r[Math.floor(r.length / 2)], n: r.length };
}

// ───────── 状態の変更 ─────────

const nowIso = () => new Date().toISOString();

/** 予想時間の通知をカレンダーに反映（通知がオンのときだけ。失敗しても計測には影響しない） */
function refreshNotice() {
  if (isDemo() || !getConfig('notify', {}).enabled) return;
  sync().then(() => (state.queue.length ? null : calendarSync())).catch(() => {});
}

export async function startAct(fields) {
  const now = nowIso();
  await upsertRow('Activities', {
    ActID: uid('a'), Title: fields.Title, Category: fields.Category, OshiID: fields.OshiID || '', PlannedMin: String(num(fields.PlannedMin) || ''),
    StartAt: now, EndAt: '', Segments: JSON.stringify([[now, null]]), ActualMin: '', Rating: '', Reasons: '', Comment: '', TaskRef: fields.TaskRef || '', Status: 'running',
  });
  refreshNotice();
}

export async function pauseAct(a) {
  const segs = segmentsOf(a);
  if (segs.length && !segs[segs.length - 1][1]) segs[segs.length - 1][1] = nowIso();
  await upsertRow('Activities', { ...a, Segments: JSON.stringify(segs), Status: 'paused' });
  refreshNotice();
}

export async function resumeAct(a) {
  const segs = segmentsOf(a);
  segs.push([nowIso(), null]);
  await upsertRow('Activities', { ...a, Segments: JSON.stringify(segs), Status: 'running' });
  refreshNotice();
}

export async function finishAct(a) {
  const segs = segmentsOf(a);
  const now = nowIso();
  if (segs.length && !segs[segs.length - 1][1]) segs[segs.length - 1][1] = now;
  const done = { ...a, Segments: JSON.stringify(segs), Status: 'done', EndAt: now, ActualMin: String(Math.max(1, Math.round(elapsedMs({ Segments: JSON.stringify(segs) }) / 60000))) };
  await upsertRow('Activities', done);
  refreshNotice();
  openActEditor(done, { review: true });
}

// ───────── 宣言（開始） ─────────

function oshiOptions() {
  return [['', '—'], ...groups().flatMap((g) => [[g.OshiID, g.Name], ...membersOf(g.OshiID).map((m) => [m.OshiID, `　${m.Name}`])])];
}

export function openDeclare(ctx, preset = {}) {
  const cur = activeAct();
  if (cur) {
    toast(`「${cur.Title}」を計測中です。先に終了してください`);
    return;
  }
  const cats = categories();
  let cat = preset.Category || cats[0]?.name || 'その他';
  let planned = num(preset.PlannedMin) || 30;
  let taskRef = preset.TaskRef || '';
  const t = today();
  // 予定GSSのタスク（今日の前後3日、未完了）から選べるように
  const tasks = state.data.schedule.filter((x) => x.kind === 'T' && !x.done && x.date >= addDays(t, -3) && x.date <= addDays(t, 3)).slice(0, 8);
  const recent = [...new Set(doneActs().sort((a, b) => String(b.StartAt).localeCompare(String(a.StartAt))).map((a) => a.Title))].slice(0, 12);

  const hint = () => {
    const e = estimateRatio(cat);
    if (!e) return `<span class="muted">「${esc(cat)}」の記録が3件たまると、いつもの見積もりのずれから目安を出します</span>`;
    const pct = Math.round(e.ratio * 100);
    return `「${esc(cat)}」はいつも予想の <b>${pct}%</b> かかっています（${e.n}件）→ ${planned}分なら <b>${fmtMin(planned * e.ratio)}</b> が目安`;
  };

  openModal({
    title: '⏱ これからやること',
    body: `
      ${field('やること', input('Title', preset.Title || '', 'required list="act-recent" placeholder="例：新曲の歌詞を覚える" autocomplete="off"'))}
      <datalist id="act-recent">${recent.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      ${tasks.length ? `<div class="field"><span>予定GSSのタスクから選ぶ</span><div class="chip-row wrap">${tasks.map((x, i) => `<button type="button" class="chip sm" data-task="${i}">${fmtMD(x.date)} ${esc(x.title)}</button>`).join('')}</div></div>` : ''}
      <div class="field"><span>分類</span><div class="chip-row wrap" data-cats>${cats.map((c) => `<button type="button" class="chip sm" data-cat="${esc(c.name)}" aria-pressed="${c.name === cat}" style="--c:${c.color}"><span class="dot"></span>${esc(c.name)}</button>`).join('')}</div></div>
      <div class="field"><span>予想時間</span><div class="chip-row wrap" data-plans>${PLAN_CHOICES.map((m) => `<button type="button" class="chip sm" data-plan="${m}" aria-pressed="${m === planned}">${fmtMin(m)}</button>`).join('')}
        <input class="search plan-input" data-plan-input type="number" inputmode="numeric" min="1" value="${planned}" aria-label="予想時間（分）"><span class="small muted">分</span></div></div>
      <p class="small hint" data-hint>${hint()}</p>
      ${field('推し（任意）', select('OshiID', oshiOptions(), preset.OshiID || ''))}`,
    foot: '<span class="spacer"></span><button type="button" class="btn primary" data-start>▶ 開始</button>',
    onMount: (m) => {
      const refresh = () => {
        m.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === cat)));
        m.querySelectorAll('[data-plan]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.plan) === planned)));
        m.querySelector('[data-plan-input]').value = planned;
        m.querySelector('[data-hint]').innerHTML = hint();
      };
      m.querySelectorAll('[data-cat]').forEach((b) => b.onclick = () => { cat = b.dataset.cat; refresh(); });
      m.querySelectorAll('[data-plan]').forEach((b) => b.onclick = () => { planned = Number(b.dataset.plan); refresh(); });
      m.querySelector('[data-plan-input]').oninput = (e) => { planned = Math.max(1, num(e.target.value)); m.querySelector('[data-hint]').innerHTML = hint(); m.querySelectorAll('[data-plan]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.plan) === planned))); };
      m.querySelectorAll('[data-task]').forEach((b) => b.onclick = () => {
        const x = tasks[Number(b.dataset.task)];
        m.querySelector('[name=Title]').value = x.title;
        taskRef = `${x.date} ${x.title}`;
      });
      m.querySelector('[data-start]').onclick = async () => {
        const title = m.querySelector('[name=Title]').value.trim();
        if (!title) return toast('やることを入れてください');
        await startAct({ Title: title, Category: cat, PlannedMin: planned, OshiID: m.querySelector('[name=OshiID]').value, TaskRef: taskRef });
        closeModal();
        toast('開始しました');
      };
    },
  });
}

// ───────── 振り返り・編集 ─────────

/** opts.review: 終了直後の振り返り（見出しと案内を変える） */
export function openActEditor(a, opts = {}) {
  let rating = num(a.Rating);
  const reasons = new Set(String(a.Reasons || '').split(',').filter(Boolean));
  const planned = num(a.PlannedMin);
  const cats = categories();
  const stars = () => [1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${n <= rating ? 'on' : ''}" aria-label="${n}点">★</button>`).join('');
  const diffHtml = (actual) => {
    if (!planned) return '<span class="muted">予想時間なし</span>';
    const d = actual - planned;
    const pct = Math.round((actual / planned) * 100);
    return `予想 ${fmtMin(planned)} → 実際 ${fmtMin(actual)}　<b class="${d > 0 ? 'over' : 'under'}">${d >= 0 ? '+' : '−'}${fmtMin(Math.abs(d))}（${pct}%）</b>`;
  };
  const start = a.StartAt ? new Date(a.StartAt) : null;

  openModal({
    title: opts.review ? `おつかれさまでした：${a.Title}` : '活動の記録',
    body: `
      <div class="card act-sum"><div class="small muted">${start ? `${fmtMD(ymd(start))} ${pad(start.getHours())}:${pad(start.getMinutes())}〜` : ''}　一時停止 ${Math.max(0, segmentsOf(a).length - 1)}回</div>
        <div data-diff>${diffHtml(num(a.ActualMin))}</div></div>
      ${opts.review ? '' : `${field('やること', input('Title', a.Title))}
        <div class="fields-2">${field('分類', select('Category', [...new Set([...cats.map((c) => c.name), a.Category].filter(Boolean))].map((c) => [c, c]), a.Category))}${field('予想（分）', input('PlannedMin', a.PlannedMin, 'type="number" inputmode="numeric" min="0"'))}</div>`}
      ${field('実際にかかった時間（分）', input('ActualMin', a.ActualMin, 'type="number" inputmode="numeric" min="0" data-actual'))}
      <div class="field"><span>自己評価</span><div class="stars" data-stars>${stars()}</div></div>
      <div class="field"><span>予想とずれた理由・よかったこと（複数可）</span><div class="checks">${REASONS.map((r) => `<label><input type="checkbox" data-reason value="${esc(r)}" ${reasons.has(r) ? 'checked' : ''}>${esc(r)}</label>`).join('')}</div></div>
      ${field('コメント', `<textarea name="Comment" rows="4" placeholder="次はこうしたい、など">${esc(a.Comment)}</textarea>`)}`,
    foot: `${opts.review ? '' : '<button type="button" class="btn danger" data-del>削除</button>'}<span class="spacer"></span><button type="button" class="btn primary" data-save>${opts.review ? '記録する' : '保存'}</button>`,
    onMount: (m) => {
      const box = m.querySelector('[data-stars]');
      box.onclick = (e) => { const n = Number(e.target.dataset.star); if (!n) return; rating = rating === n ? 0 : n; box.innerHTML = stars(); };
      m.querySelector('[data-actual]').oninput = (e) => { m.querySelector('[data-diff]').innerHTML = diffHtml(num(e.target.value)); };
      m.querySelector('[data-save]').onclick = async () => {
        const v = (name) => m.querySelector(`[name=${name}]`)?.value;
        const rec = {
          ...a,
          ActualMin: String(num(v('ActualMin'))),
          Rating: rating ? String(rating) : '',
          Reasons: [...m.querySelectorAll('[data-reason]:checked')].map((x) => x.value).join(','),
          Comment: v('Comment') || '',
        };
        if (!opts.review) Object.assign(rec, { Title: v('Title') || a.Title, Category: v('Category') || a.Category, PlannedMin: String(num(v('PlannedMin')) || '') });
        await upsertRow('Activities', rec);
        closeModal();
        toast('記録しました');
      };
      m.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!confirm(`「${a.Title}」の記録を削除しますか？`)) return;
        await upsertRow('Activities', { ...a, Deleted: true });
        closeModal();
      });
    },
  });
}

// ───────── 計測中の表示（どのタブでも上部に出す） ─────────

let overNotified = '';
export function runbarHtml() {
  const a = activeAct();
  if (!a) return '';
  const running = a.Status === 'running';
  return `<div class="runbar ${running ? 'live' : 'paused'}" style="--c:${catColor(a.Category)}">
    <span class="rb-dot" aria-hidden="true"></span>
    <span class="rb-title">${esc(a.Title)}</span>
    <span class="rb-time" data-rb-time>${fmtDur(elapsedMs(a))}</span>
    ${num(a.PlannedMin) ? `<span class="rb-plan">/ ${fmtMin(a.PlannedMin)}</span>` : ''}
    <button type="button" class="btn sm" data-run="${running ? 'pause' : 'resume'}">${running ? '⏸ 一時停止' : '▶ 再開'}</button>
    <button type="button" class="btn sm primary" data-run="finish">■ 終了</button>
  </div>`;
}

export function bindRunbar(root) {
  const a = activeAct();
  if (!a) return;
  root.querySelectorAll('[data-run]').forEach((b) => b.onclick = () => {
    const act = activeAct();
    if (!act) return;
    if (b.dataset.run === 'pause') pauseAct(act);
    else if (b.dataset.run === 'resume') resumeAct(act);
    else finishAct(act);
  });
}

/** 1秒ごとに経過時間を更新。予想時間を過ぎたら一度だけ知らせる */
export function tickRunbar(root) {
  const a = activeAct();
  const el = root.querySelector('[data-rb-time]');
  if (!a || !el) return;
  const ms = elapsedMs(a);
  el.textContent = fmtDur(ms);
  const over = num(a.PlannedMin) && ms > num(a.PlannedMin) * 60000;
  root.querySelector('.runbar')?.classList.toggle('over', !!over);
  if (over && a.Status === 'running' && overNotified !== a.ActID) {
    overNotified = a.ActID;
    toast(`⏰ 予想時間（${fmtMin(a.PlannedMin)}）になりました`);
    navigator.vibrate?.([200, 100, 200]);
  }
}
