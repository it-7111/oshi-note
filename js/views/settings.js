import { state, isDemo, saveSettings, sync, ping, resetDemo, clearFailed, exportJson, importJson, resolveConflict } from '../store.js';
import { groups, membersOf } from '../oshi.js';
import { esc } from '../util.js';
import { toast } from '../ui.js';
import { openOshiEditor } from './oshi-edit.js';
import { notifyHtml, bindNotify } from './notify.js';
import { categories, saveCategories, CAT_COLORS } from '../activity.js';

const OP_LABEL = { 'goods.delta': '所持数', 'goods.update': 'グッズ編集', 'goods.create': 'グッズ追加', 'goods.image': '画像', 'row.upsert': '予定・参戦・推しなど' };

const TABLE_LABEL = { Activities: '活動記録', Memos: 'メモ', Events: '予定', Lives: '参戦記録', Oshi: '推し', Expenses: '支出', Savings: '貯金', Config: '設定' };
const FIELD_LABEL = { Comment: 'コメント', Rating: '自己評価', Segments: '計測時間', Status: '状態', Text: '本文', Title: 'タイトル', Memo: 'メモ', Deleted: '削除', Want: '欲しい数', Trade: '譲れる数', Name: '名前', Watched: '視聴済み', Checklist: '持ち物', TravelMemo: '遠征メモ' };

function rowName(c) {
  if (c.Table === 'Memos') return c.RowID.startsWith('week:') ? `${c.RowID.slice(5)}の週のメモ` : `${c.RowID.slice(6)}のメモ`;
  const map = { Events: ['events', 'EventID', 'Title'], Lives: ['lives', 'LiveID', 'Title'], Oshi: ['oshi', 'OshiID', 'Name'], Expenses: ['expenses', 'ExpenseID', 'Memo'] }[c.Table];
  if (map) return state.data[map[0]].find((r) => r[map[1]] === c.RowID)?.[map[2]] || c.RowID;
  const g = state.data.goods.find((x) => x.Sheet === c.Table && x.ID === c.RowID);
  return g ? g.Name : c.RowID;
}

/** 2台で同じ項目を変えたときの記録。どちらの内容にするか選べる */
/** 記録タブの分類（Configシートに保存） */
function categoriesHtml() {
  return `<section class="card section" data-cats-sec>
    <h2>記録の分類</h2>
    ${categories().map((c, i, all) => `<div class="oshi-line"><span class="dot" style="--c:${c.color}"></span><span style="flex:1">${esc(c.name)}</span>
      <button type="button" class="icon-btn" data-cat-up="${i}" ${i ? '' : 'disabled'} aria-label="上へ">↑</button>
      <button type="button" class="icon-btn" data-cat-down="${i}" ${i < all.length - 1 ? '' : 'disabled'} aria-label="下へ">↓</button>
      <button type="button" class="icon-btn" data-cat-del="${i}" aria-label="削除">✕</button></div>`).join('')}
    <div class="row" style="margin-top:10px;flex-wrap:wrap">
      <input class="search" data-cat-name placeholder="新しい分類（例：バイト）">
      <div class="ink-colors">${CAT_COLORS.map((c, i) => `<button type="button" data-cat-color="${c}" aria-pressed="${i === 0}" style="--c:${c}" aria-label="色"></button>`).join('')}</div>
      <button type="button" class="btn sm primary" data-cat-add>追加</button>
    </div>
    <p class="small muted">消した分類の過去の記録はそのまま残ります。</p>
  </section>`;
}

function bindCategories(main) {
  const sec = main.querySelector('[data-cats-sec]');
  let color = CAT_COLORS[0];
  const list = () => categories().map((c) => ({ ...c }));
  sec.querySelectorAll('[data-cat-color]').forEach((b) => b.onclick = () => {
    color = b.dataset.catColor;
    sec.querySelectorAll('[data-cat-color]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
  sec.querySelector('[data-cat-add]').onclick = async () => {
    const name = sec.querySelector('[data-cat-name]').value.trim();
    if (!name) return toast('分類の名前を入れてください');
    if (categories().some((c) => c.name === name)) return toast('同じ名前の分類があります');
    await saveCategories([...list(), { name, color }]);
    toast('追加しました');
  };
  const move = (i, d) => { const l = list(); [l[i], l[i + d]] = [l[i + d], l[i]]; saveCategories(l); };
  sec.querySelectorAll('[data-cat-up]').forEach((b) => b.onclick = () => move(Number(b.dataset.catUp), -1));
  sec.querySelectorAll('[data-cat-down]').forEach((b) => b.onclick = () => move(Number(b.dataset.catDown), 1));
  sec.querySelectorAll('[data-cat-del]').forEach((b) => b.onclick = () => {
    const l = list();
    if (l.length <= 1) return toast('分類は1つ以上必要です');
    if (!confirm(`分類「${l[Number(b.dataset.catDel)].name}」を消しますか？`)) return;
    l.splice(Number(b.dataset.catDel), 1);
    saveCategories(l);
  });
}

function conflictsHtml() {
  const list = state.data.conflicts;
  if (!list.length) return '';
  const cut = (v) => (String(v).length > 120 ? `${String(v).slice(0, 120)}…` : String(v));
  return `<section class="card section">
    <h2>⚠ 競合 ${list.length}件</h2>
    <p class="small muted">2台で同じ項目を変えたため、後に編集した方を採用しました。もう一方の内容に戻すこともできます。</p>
    ${list.map((c) => `<div class="conflict-card">
      <div class="small"><b>${esc(TABLE_LABEL[c.Table] || 'グッズ')}「${esc(rowName(c))}」の${esc(FIELD_LABEL[c.Field] || c.Field)}</b>
        <span class="muted">${c.At ? new Date(c.At).toLocaleString('ja-JP') : ''}</span></div>
      <div class="cf-vals"><div><span class="small muted">今の内容</span><pre>${esc(cut(c.KeptValue)) || '（空）'}</pre></div>
        <div><span class="small muted">もう一方${c.OtherDevice ? `（${esc(c.OtherDevice)}）` : ''}</span><pre>${esc(cut(c.OtherValue)) || '（空）'}</pre></div></div>
      <div class="row"><button type="button" class="btn sm" data-cf="${esc(c.ConflictID)}" data-use="other">もう一方に戻す</button><span class="spacer"></span>
        <button type="button" class="btn sm primary" data-cf="${esc(c.ConflictID)}" data-use="kept">このままでよい</button></div>
    </div>`).join('')}
  </section>`;
}

export function renderSettings(main, ctx) {
  const s = state.settings;
  const last = state.meta.lastSync ? new Date(state.meta.lastSync).toLocaleString('ja-JP') : '未同期';
  const bday = (o) => (o.Birthday ? `🎂${Number(o.Birthday.slice(0, 2))}/${Number(o.Birthday.slice(3))}` : '');
  const oshiHtml = groups().map((g) => `
    <button type="button" class="oshi-line" style="--c:${g.Color}" data-oshi="${esc(g.OshiID)}"><span class="dot"></span><b>${g.Emoji ? esc(g.Emoji) + ' ' : ''}${esc(g.Name)}</b>
      <span class="small muted">${g.GoodsSheet ? `グッズ: ${esc(g.GoodsSheet)}` : 'グッズシートなし'} ${bday(g)}</span><span class="spacer"></span><span class="muted">›</span></button>
    ${membersOf(g.OshiID).map((m) => `<button type="button" class="oshi-line member" style="--c:${m.Color}" data-oshi="${esc(m.OshiID)}"><span class="dot"></span>${esc(m.Name)}
      <span class="small muted">${bday(m)}</span><span class="spacer"></span><span class="muted">›</span></button>`).join('')}
    <button type="button" class="oshi-line member add" data-add-member="${esc(g.OshiID)}">＋ ${esc(g.Name)}のメンバーを追加</button>`).join('');

  main.innerHTML = `
    <section class="card section">
      <h2>同期</h2>
      ${isDemo()
        ? '<p>いまは<b>デモデータ</b>を表示しています。下の「GASとの接続」を設定すると、グッズGSSのデータに切り替わります。</p>'
        : `<p>最終同期：${esc(last)}</p>
           <p>未送信の変更：<b>${state.queue.length}</b> 件 ${navigator.onLine ? '' : '<span class="badge" style="--c:#dc2626">オフライン</span>'}</p>
           ${state.sync.error ? `<p style="color:var(--danger)">エラー：${esc(state.sync.error)}</p>` : ''}
           <button type="button" class="btn primary" data-sync ${state.sync.busy ? 'disabled' : ''}>${state.sync.busy ? '同期中…' : '今すぐ同期'}</button>`}
      ${state.failed.length ? `
        <details style="margin-top:10px"><summary class="small">反映できなかった変更 ${state.failed.length}件</summary>
          ${state.failed.slice(-20).reverse().map((f) => `<p class="small muted">${esc(new Date(f.at).toLocaleString('ja-JP'))}　${esc(OP_LABEL[f.type] || f.type)}　${f.status === 'conflict' ? '他の変更が新しかったため見送り' : esc(f.message)}</p>`).join('')}
          <button type="button" class="btn sm" data-clear-failed>一覧を消す</button>
        </details>` : ''}
    </section>

    ${conflictsHtml()}

    <section class="card section">
      <h2>GASとの接続</h2>
      <label class="field"><span>ウェブアプリのURL（…/exec）</span><input name="gasUrl" value="${esc(s.gasUrl)}" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label class="field"><span>TOKEN（setup() のログに出る値）</span><input name="token" value="${esc(s.token)}" autocomplete="off"></label>
      <label class="field"><span>この端末の名前（Logシートに記録）</span><input name="device" value="${esc(s.device)}"></label>
      <div class="row"><button type="button" class="btn" data-test>接続テスト</button><span class="spacer"></span><button type="button" class="btn primary" data-save-conn>保存</button></div>
      ${isDemo() ? '' : '<p class="small muted">URLを空にして保存するとデモ表示に戻ります（端末内の同期データは消えます）。</p>'}
    </section>

    <section class="card section">
      <h2>表示</h2>
      <label class="field"><span>週の始まり</span><select name="weekStart" data-week>
        <option value="1" ${String(s.weekStart) === '1' ? 'selected' : ''}>月曜日</option>
        <option value="0" ${String(s.weekStart) === '0' ? 'selected' : ''}>日曜日</option></select></label>
    </section>

    <section class="card section">
      <h2>推し</h2>
      ${oshiHtml || '<p class="muted">推しが登録されていません</p>'}
      <button type="button" class="btn" data-add-group style="margin-top:10px">＋ グループ・推しを追加</button>
      <p class="small muted">タップすると色・誕生日・デビュー日・推し始めた日を編集できます（グッズGSSの「Oshi」シートに保存）。</p>
    </section>

    ${categoriesHtml()}

    ${notifyHtml()}

    <section class="card section">
      <h2>バックアップ</h2>
      <p class="small">データの正本はGSSにあります。念のため、端末内のデータをファイルに書き出しておけます（画像とTOKENは含みません）。</p>
      <div class="row" style="flex-wrap:wrap">
        <button type="button" class="btn" data-export>書き出す</button>
        <label class="btn">読み込む<input type="file" accept="application/json,.json" data-import hidden></label>
        ${isDemo() ? '<button type="button" class="btn" data-reset-demo>デモを初期化</button>' : ''}
      </div>
      <p class="small muted">端末の保存領域：${state.persisted === true ? '保護済み（自動では消されません）' : state.persisted === false ? '未保護。ホーム画面に追加して使うと消されにくくなります' : '確認できません'}</p>
    </section>
    <p class="small muted" style="text-align:center">推し活ノート v0.4</p>`;

  main.querySelector('[data-sync]')?.addEventListener('click', () => sync());
  const oshiMap = new Map(state.data.oshi.map((o) => [o.OshiID, o]));
  main.querySelectorAll('[data-oshi]').forEach((b) => b.onclick = () => openOshiEditor(oshiMap.get(b.dataset.oshi)));
  main.querySelectorAll('[data-add-member]').forEach((b) => b.onclick = () => openOshiEditor(null, { Type: 'member', ParentID: b.dataset.addMember }));
  main.querySelector('[data-add-group]').onclick = () => openOshiEditor(null, { Type: 'group' });
  bindNotify(main);
  bindCategories(main);
  main.querySelectorAll('[data-cf]').forEach((b) => b.onclick = async () => {
    const c = state.data.conflicts.find((x) => x.ConflictID === b.dataset.cf);
    if (!c) return;
    await resolveConflict(c, b.dataset.use === 'other');
    toast(b.dataset.use === 'other' ? 'もう一方の内容に戻しました' : '今の内容のままにしました');
  });
  main.querySelector('[data-clear-failed]')?.addEventListener('click', () => clearFailed());
  const conn = () => ({
    gasUrl: main.querySelector('[name=gasUrl]').value.trim(),
    token: main.querySelector('[name=token]').value.trim(),
    device: main.querySelector('[name=device]').value.trim(),
  });
  main.querySelector('[data-test]').onclick = async () => {
    const prev = { ...state.settings };
    const c = conn();
    if (!c.gasUrl) return toast('URLを入れてください');
    Object.assign(state.settings, c); // 一時的に使う
    try { await ping(); toast('✅ 接続できました'); } catch (e) { toast(`接続できません：${e.message}`); } finally { Object.assign(state.settings, prev); }
  };
  main.querySelector('[data-save-conn]').onclick = async () => {
    const c = conn();
    if (!c.gasUrl && !isDemo() && !confirm('URLを空にすると、端末内の同期データを消してデモ表示に戻します。よろしいですか？')) return;
    const toDemo = !c.gasUrl && !isDemo();
    await saveSettings(c);
    if (toDemo) await resetDemo();
    toast('保存しました');
    sync();
  };
  main.querySelector('[data-week]').onchange = (e) => saveSettings({ weekStart: Number(e.target.value) });
  main.querySelector('[data-export]').onclick = () => {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `oshi-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  main.querySelector('[data-import]').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f || !confirm('端末内のデータをこのファイルの内容に置き換えます。よろしいですか？')) return;
    try { await importJson(await f.text()); toast('読み込みました'); } catch (err) { toast(err.message); }
  };
  main.querySelector('[data-reset-demo]')?.addEventListener('click', () => resetDemo().then(() => toast('デモを初期化しました')));
  ctx.setFab(null);
}
