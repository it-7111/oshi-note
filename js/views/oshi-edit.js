// 推しの追加・編集（Oshiシートに書き込む）
import { upsertRow, isDemo } from '../store.js';
import { groups, membersOf, oshiById } from '../oshi.js';
import { esc, uid, isValidYmd, pad } from '../util.js';
import { openModal, closeModal, toast, formValues, field, input, select } from '../ui.js';

const PALETTE = ['#7c3aed', '#ef4444', '#38bdf8', '#a855f7', '#f472b6', '#22c55e', '#facc15', '#2563eb', '#f97316', '#14b8a6', '#64748b'];

/** o: 編集する推し（新規なら null）, preset: 新規時の初期値（Type / ParentID） */
export function openOshiEditor(o, preset = {}) {
  const isNew = !o;
  const siblings = preset.ParentID ? membersOf(preset.ParentID) : groups();
  const row = o || {
    OshiID: uid('o'), Type: 'group', ParentID: '', Name: '', GoodsSheet: '', Emoji: '', Birthday: '', DebutDate: '', OshiStart: '', Icon: '',
    Color: PALETTE[siblings.length % PALETTE.length], Order: String(Math.max(0, ...groups().flatMap((g) => [g, ...membersOf(g.OshiID)]).map((x) => Number(x.Order) || 0)) + 1),
    ...preset,
  };
  const isMember = row.Type === 'member';
  const [bm, bd] = String(row.Birthday || '').split('-');
  const months = [['', '—'], ...Array.from({ length: 12 }, (_, i) => [pad(i + 1), `${i + 1}月`])];
  const days = [['', '—'], ...Array.from({ length: 31 }, (_, i) => [pad(i + 1), `${i + 1}日`])];
  const parent = isMember ? oshiById(row.ParentID) : null;
  const memberCount = isMember ? 0 : membersOf(row.OshiID).length;

  openModal({
    title: `${isNew ? '追加' : '編集'}：${isMember ? `メンバー${parent ? `（${parent.Name}）` : ''}` : 'グループ・推し'}`,
    body: `
      ${field('名前', input('Name', row.Name, 'required'))}
      ${!isNew && isMember ? '<p class="small muted" style="margin:-6px 0 12px">名前を変えると、同期時にグッズシートのPerson列の表記も書き換えます。</p>' : ''}
      <div class="fields-2">
        <label class="field"><span>色</span><input type="color" name="Color" value="${esc(row.Color || '#a21caf')}" style="height:44px;padding:4px"></label>
        ${field('絵文字', input('Emoji', row.Emoji, 'maxlength="4" placeholder="🎼"'))}
      </div>
      <div class="field"><span>誕生日（毎年カレンダーに表示）</span><div class="fields-2" style="gap:0 10px">
        ${select('BirthMonth', months, bm || '')}${select('BirthDay', days, bd || '')}</div></div>
      <div class="fields-2">
        ${field(isMember ? '活動開始日' : 'デビュー日（周年）', input('DebutDate', row.DebutDate, 'type="date"'))}
        ${field('推し始めた日', input('OshiStart', row.OshiStart, 'type="date"'))}
      </div>
      ${isMember ? '' : `${field('グッズシート名（空欄ならグッズ管理なし）', input('GoodsSheet', row.GoodsSheet, 'placeholder="例：IRREGULAR"'))}
        <p class="small muted" style="margin:-6px 0 12px">まだ無いシート名を入れると、同期時にグッズGSSにシートを作ります。${isDemo() ? '（デモでは作られません）' : ''}</p>`}
      ${field('並び順', input('Order', row.Order, 'type="number" inputmode="numeric"'))}`,
    foot: `${isNew ? '' : '<button type="button" class="btn danger" data-del>削除</button>'}<span class="spacer"></span><button type="button" class="btn primary" data-save>保存</button>`,
    onMount: (m) => {
      m.querySelector('[data-save]').onclick = async () => {
        const v = formValues(m);
        if (!v.Name) return toast('名前を入れてください');
        if ((v.BirthMonth && !v.BirthDay) || (!v.BirthMonth && v.BirthDay)) return toast('誕生日は月と日の両方を選んでください');
        const birthday = v.BirthMonth ? `${v.BirthMonth}-${v.BirthDay}` : '';
        if ([v.DebutDate, v.OshiStart].some((d) => d && !isValidYmd(d))) return toast('日付の形式が正しくありません');
        const { BirthMonth, BirthDay, ...rest } = v;
        await upsertRow('Oshi', { ...row, ...rest, Birthday: birthday }, o?.UpdatedAt || '');
        closeModal();
        toast('保存しました');
      };
      m.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (memberCount) return toast(`先にメンバー（${memberCount}人）を削除してください`);
        if (!confirm(`「${row.Name}」を削除しますか？（グッズシートや予定は消えません）`)) return;
        await upsertRow('Oshi', { ...row, Deleted: true }, o?.UpdatedAt || '');
        closeModal();
        toast('削除しました');
      });
    },
  });
}
