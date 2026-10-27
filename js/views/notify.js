// 通知の設定（GASがGoogleカレンダーへ書き出し、カレンダーの通知で知らせる）
import { state, isDemo, getConfig, setConfig, calendarSync, sync } from '../store.js';
import { esc, today, addDays, fmtMD, fromMin } from '../util.js';
import { toast } from '../ui.js';
import { buildItems } from './calendar.js';

const DEFAULT = { enabled: false, calendarName: '推し活', days: 60, rules: { 配信: 15, ライブ: 120, リリース: 0, 締切: 1440, 誕生日: 180, アーカイブ: 180, タイマー: 0 } };
const TIMED = [[-1, '通知しない'], [0, '開始時'], [5, '5分前'], [15, '15分前'], [30, '30分前'], [60, '1時間前'], [120, '2時間前'], [180, '3時間前'], [1440, '1日前'], [2880, '2日前'], [10080, '1週間前']];
const ALLDAY = [[-1, '通知しない'], [0, '当日0時'], [180, '前日21時'], [720, '前日12時'], [900, '前日9時'], [1620, '2日前21時'], [10080, '1週間前']];
const RULES = [
  ['配信', '📺 配信', TIMED],
  ['ライブ', '🎤 ライブ・参戦（当選／申込中）', TIMED],
  ['リリース', '💿 リリース', TIMED],
  ['締切', '📝 申込・入金・発券／当落発表', TIMED],
  ['誕生日', '🎂 誕生日・周年', ALLDAY],
  ['アーカイブ', '⏳ アーカイブの視聴期限（まだ見ていないもの）', ALLDAY],
  ['タイマー', '⏱ 記録のタイマー：予想時間になったとき', [[-1, '通知しない'], [0, 'ちょうど'], [5, '5分前'], [10, '10分前']]],
];

export const notifyConfig = () => {
  const v = getConfig('notify', {});
  return { ...DEFAULT, ...v, rules: { ...DEFAULT.rules, ...(v.rules || {}) } };
};

export function notifyHtml() {
  const c = notifyConfig();
  const synced = getConfig('notifySyncedAt', '');
  const t = today();
  const upcoming = buildItems(t, addDays(t, 6), { group: null, member: null }).filter((i) => !i.mine && !i.task);
  return `
    <section class="card section" data-notify>
      <h2>通知</h2>
      <p class="small">推しの予定・誕生日・参戦をGoogleカレンダーの「${esc(c.calendarName)}」カレンダーに書き出し、カレンダーの通知でお知らせします（1時間ごとに更新）。</p>
      <p class="small muted">iPhoneでは、Googleカレンダーアプリを入れるか、「設定 > カレンダー > アカウント」でGoogleアカウントを追加すると通知が届きます。</p>
      ${isDemo() ? '<p class="small" style="color:var(--danger)">GASと接続すると使えます。</p>' : ''}
      <div class="toggle-list" style="margin:6px 0 10px"><label><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''} ${isDemo() ? 'disabled' : ''}>Googleカレンダーで通知する</label></div>
      ${RULES.map(([k, label, opts]) => `<label class="field"><span>${label}</span><select name="rule:${k}" ${isDemo() ? 'disabled' : ''}>${opts.map(([v, l]) => `<option value="${v}" ${Number(c.rules[k]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`).join('')}
      <div class="row"><span class="small muted">${synced ? `最終反映：${esc(new Date(synced).toLocaleString('ja-JP'))}` : '未反映'}</span><span class="spacer"></span>
        <button type="button" class="btn primary" data-notify-save ${isDemo() ? 'disabled' : ''}>保存して反映</button></div>
      <details style="margin-top:12px"><summary class="small">これから7日間のお知らせ（${upcoming.length}件）</summary>
        ${upcoming.length ? upcoming.map((i) => `<p class="small" style="margin:6px 0"><span class="badge" style="--c:${i.color}">${fmtMD(i.date)}${i.allDay ? '' : ' ' + fromMin(i.start)}</span> ${esc(i.title)}</p>`).join('') : '<p class="small muted">ありません</p>'}
      </details>
    </section>`;
}

export function bindNotify(main) {
  const sec = main.querySelector('[data-notify]');
  sec.querySelector('[data-notify-save]')?.addEventListener('click', async (e) => {
    const c = notifyConfig();
    c.enabled = sec.querySelector('[name=enabled]').checked;
    RULES.forEach(([k]) => { c.rules[k] = Number(sec.querySelector(`[name="rule:${k}"]`).value); });
    e.target.disabled = true;
    await setConfig('notify', c);
    try {
      await sync(); // 設定をGSSへ送ってから反映
      if (state.queue.length) throw new Error('未送信の変更があります');
      const r = await calendarSync();
      toast(c.enabled ? `カレンダーに反映しました（${r.count}件）` : '通知をオフにしました');
    } catch (err) {
      toast(`保存しました。カレンダーへの反映は次の同期で行います（${err.message}）`);
    }
  });
}
