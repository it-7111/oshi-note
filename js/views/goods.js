import { state, keyOf, goodsDelta, goodsUpdate, goodsCreate, goodsImage, loadImage } from '../store.js';
import { groups, membersOf, goodsGroups, groupBySheet, goodsMemberIds, personNames, oshiById } from '../oshi.js';
import { esc, yen, num, resizeImage } from '../util.js';
import { openModal, closeModal, toast, formValues, field, input, select } from '../ui.js';
import { renderTrade } from './trade.js';

const GENRE_ICON = {
  缶バッジ: '🔘', カード: '🃏', アクリルスタンド: '🧍', アクリルキーホルダー: '🔑', その他キーホルダー: '🔑', CD: '💿',
  チェキ: '📸', ぬいぐるみ: '🧸', 'アパレル/アクセサリー': '👕', '日用雑貨/文房具': '✏️', その他: '📦',
};
const STATUS = [['all', 'すべて'], ['have', '所持'], ['none', '未所持'], ['want', '欲しい'], ['trade', '譲あり']];

const ui = { mode: 'list', status: 'all', genre: '', q: '', layout: 'grid', open: new Set(), includeAll: true };
try { Object.assign(ui, JSON.parse(localStorage.getItem('goods-ui') || '{}'), { open: new Set(), q: '' }); } catch { /* 既定値で動く */ }
const saveUi = () => { try { localStorage.setItem('goods-ui', JSON.stringify({ mode: ui.mode, status: ui.status, genre: ui.genre, layout: ui.layout, includeAll: ui.includeAll })); } catch { /* 無視 */ } };

const imgUrls = new Map(); // "シート:ID" → objectURL（再描画でのちらつき防止）

/** 上部チップ（推し・メンバー）に当てはまるか */
export function inSel(g, sel, includeAll = true) {
  const grp = groupBySheet(g.Sheet);
  if (sel.group && grp?.OshiID !== sel.group) return false;
  if (sel.member) {
    const ids = goodsMemberIds(g);
    if (!(ids.includes(sel.member) || (includeAll && ids.length === 0))) return false;
  }
  return true;
}

function filtered(sel) {
  const q = ui.q.toLowerCase();
  return state.data.goods.filter((g) => {
    if (!inSel(g, sel, ui.includeAll)) return false;
    if (ui.genre && g.Genre !== ui.genre) return false;
    if (ui.status === 'have' && !(num(g.Have) > 0)) return false;
    if (ui.status === 'none' && num(g.Have) > 0) return false;
    if (ui.status === 'want' && !(num(g.Want) > 0)) return false;
    if (ui.status === 'trade' && !(num(g.Trade) > 0)) return false;
    if (q && !`${g.Name} ${g.Sub} ${g.Person} ${g.Memo}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function renderGoods(main, ctx) {
  if (ctx.goodsMode) { ui.mode = ctx.goodsMode; ctx.goodsMode = null; saveUi(); }
  const sel = ctx.sel;
  const selGroup = sel.group && oshiById(sel.group);
  if (selGroup && !selGroup.GoodsSheet) {
    main.innerHTML = `<div class="empty">${esc(selGroup.Name)}のグッズシートはまだありません。<br><span class="small">グッズGSSにシートを作り、OshiシートのGoodsSheet列にシート名を入れると表示されます。</span></div>`;
    ctx.setFab(null);
    return;
  }
  const modeSeg = `<div class="seg" role="group" aria-label="表示" style="margin:2px 0 10px;display:flex">
      <button type="button" data-mode="list" aria-pressed="${ui.mode === 'list'}" style="flex:1">グッズ一覧</button>
      <button type="button" data-mode="trade" aria-pressed="${ui.mode === 'trade'}" style="flex:1">譲・求</button></div>`;
  const bindMode = () => main.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => { ui.mode = b.dataset.mode; saveUi(); ctx.rerender({ resetScroll: true }); });
  if (ui.mode === 'trade') {
    renderTrade(main, ctx, { list: state.data.goods.filter((g) => inSel(g, sel)), imageUrl, openEditor: (g) => openGoodsEditor(g, ctx), modeSeg });
    bindMode();
    return;
  }
  const list = filtered(sel);
  const haveN = list.reduce((s, g) => s + num(g.Have), 0);
  const total = list.reduce((s, g) => s + num(g.Have) * num(g.Price), 0);
  const genres = [...new Set([...(state.data.genres || []), ...state.data.goods.map((g) => g.Genre)].filter(Boolean))];

  // 同じName＋Subが2件以上あるものはセット（ランダムグッズなど）としてまとめる
  const sets = new Map();
  for (const g of list) {
    const k = `${g.Sheet}|${g.Name}|${g.Sub}`;
    if (!sets.has(k)) sets.set(k, []);
    sets.get(k).push(g);
  }

  let html = `${modeSeg}
    <div class="stats">
      <div class="card stat"><b>${list.length.toLocaleString()}</b><span>種類</span></div>
      <div class="card stat"><b>${haveN.toLocaleString()}</b><span>所持数</span></div>
      <div class="card stat"><b>${yen(total)}</b><span>所持総額</span></div>
    </div>
    <div class="toolbar">
      <input class="search" type="search" placeholder="検索" value="${esc(ui.q)}" data-q aria-label="グッズを検索">
      <select class="sel" data-genre aria-label="ジャンル"><option value="">ジャンル</option>${genres.map((g) => `<option ${g === ui.genre ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
    </div>
    <div class="toolbar">
      <div class="chip-row" style="flex:1">${STATUS.map(([v, l]) => `<button type="button" class="chip sm" data-status="${v}" aria-pressed="${ui.status === v}">${l}</button>`).join('')}</div>
      <div class="seg"><button type="button" data-layout="grid" aria-pressed="${ui.layout === 'grid'}" aria-label="グリッド">▦</button><button type="button" data-layout="list" aria-pressed="${ui.layout === 'list'}" aria-label="リスト">☰</button></div>
    </div>
    ${sel.member ? `<label class="small muted row" style="margin:-2px 2px 8px"><input type="checkbox" data-incall ${ui.includeAll ? 'checked' : ''}>グループ全員向けのグッズも表示</label>` : ''}`;

  if (!list.length) html += '<div class="empty">該当するグッズがありません</div>';
  const wrap = ui.layout === 'grid' ? 'goods-grid' : 'goods-list';
  let loose = [];
  const flushLoose = () => {
    if (loose.length) html += `<div class="${wrap}" style="margin-bottom:12px">${loose.map((g) => cardHtml(g, false)).join('')}</div>`;
    loose = [];
  };
  for (const [k, items] of sets) {
    if (items.length < 2) { loose.push(items[0]); continue; }
    flushLoose();
    const got = items.filter((g) => num(g.Have) > 0).length;
    const open = ui.open.has(k);
    const color = groupBySheet(items[0].Sheet)?.Color;
    html += `<section class="set ${open ? 'open' : ''}">
      <button type="button" class="set-head" data-set="${esc(k)}" aria-expanded="${open}">
        <span class="nm">${esc(items[0].Name)}${items[0].Sub ? `<small>${esc(items[0].Sub)}</small>` : ''}</span>
        <span class="small muted">${got}/${items.length}</span>
        <span class="prog" style="--c:${color}"><i style="width:${(got / items.length) * 100}%"></i></span>
        <span class="chev">›</span>
      </button>
      ${open ? `<div class="${wrap}">${items.map((g) => cardHtml(g, true)).join('')}</div>` : ''}
    </section>`;
  }
  flushLoose();
  main.innerHTML = html;

  bindMode();
  const q = main.querySelector('[data-q]');
  const onQ = (e) => {
    if (e.isComposing) return; // 日本語変換中は再描画しない
    ui.q = q.value;
    ctx.rerender({ focusSearch: true });
  };
  q.addEventListener('input', onQ);
  q.addEventListener('compositionend', onQ);
  if (ctx.focusSearch) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  main.querySelector('[data-genre]').onchange = (e) => { ui.genre = e.target.value; saveUi(); ctx.rerender(); };
  main.querySelectorAll('[data-status]').forEach((b) => b.onclick = () => { ui.status = b.dataset.status; saveUi(); ctx.rerender(); });
  main.querySelectorAll('[data-layout]').forEach((b) => b.onclick = () => { ui.layout = b.dataset.layout; saveUi(); ctx.rerender(); });
  main.querySelector('[data-incall]')?.addEventListener('change', (e) => { ui.includeAll = e.target.checked; saveUi(); ctx.rerender(); });
  main.querySelectorAll('[data-set]').forEach((b) => b.onclick = () => {
    const k = b.dataset.set;
    ui.open.has(k) ? ui.open.delete(k) : ui.open.add(k);
    ctx.rerender();
  });

  const byKey = new Map(list.map((g) => [keyOf(g), g]));
  main.querySelectorAll('[data-key]').forEach((card) => {
    const g = byKey.get(card.dataset.key);
    card.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => goodsDelta(g, Number(b.dataset.d)));
    card.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openGoodsEditor(g, ctx));
  });
  observeImages(main, byKey);

  const defaultSheet = (sel.group && oshiById(sel.group)?.GoodsSheet) || goodsGroups()[0]?.GoodsSheet;
  ctx.setFab(defaultSheet ? () => openGoodsEditor(null, ctx, defaultSheet) : null);
}

function cardHtml(g, inSet) {
  const have = num(g.Have);
  const k = keyOf(g);
  const who = personNames(g).join('・') || (g.Person ? '全員' : '');
  const title = inSet ? (who || g.Name) : g.Name;
  const sub = inSet ? '' : [g.Sub, who].filter(Boolean).join(' · ');
  const badges = [num(g.Want) > 0 && `<span class="badge" style="--c:#db2777">欲しい${num(g.Want)}</span>`, num(g.Trade) > 0 && `<span class="badge" style="--c:#0891b2">譲${num(g.Trade)}</span>`].filter(Boolean).join(' ');
  const img = imgUrls.get(k);
  const imgInner = img ? `<img src="${img}" alt="">` : `<span aria-hidden="true">${GENRE_ICON[g.Genre] || '🎁'}</span>`;
  return `<div class="g-card card ${ui.layout === 'list' ? 'g-row' : ''} ${have ? '' : 'zero'}" data-key="${esc(k)}">
    <button type="button" class="g-img" data-open ${g.Image && !img ? `data-img="${esc(k)}"` : ''} aria-label="${esc(g.Name)}の詳細">${imgInner}${have > 1 && ui.layout === 'grid' ? `<span class="have-tag">×${have}</span>` : ''}</button>
    <div class="g-body">
      <div class="g-name">${esc(title)}</div>
      ${sub ? `<div class="g-sub">${esc(sub)}</div>` : ''}
      ${badges ? `<div>${badges}</div>` : ''}
      <div class="stepper"><button type="button" data-d="-1" aria-label="減らす" ${have ? '' : 'disabled'}>−</button><output>${have}</output><button type="button" data-d="1" aria-label="増やす">＋</button></div>
    </div></div>`;
}

let io;
function observeImages(main, byKey) {
  io?.disconnect();
  io = new IntersectionObserver((entries) => entries.forEach(async (en) => {
    if (!en.isIntersecting) return;
    const el = en.target;
    io.unobserve(el);
    const g = byKey.get(el.dataset.img);
    const url = await imageUrl(g);
    if (url) el.querySelector('span[aria-hidden]')?.replaceWith(Object.assign(document.createElement('img'), { src: url, alt: '' }));
  }), { root: main, rootMargin: '300px' });
  main.querySelectorAll('[data-img]').forEach((el) => io.observe(el));
}

export async function imageUrl(g) {
  const k = keyOf(g);
  if (imgUrls.has(k)) return imgUrls.get(k);
  const dataUrl = await loadImage(g);
  if (!dataUrl) return null;
  const url = URL.createObjectURL(await (await fetch(dataUrl)).blob());
  imgUrls.set(k, url);
  return url;
}

// ───────── 詳細・編集 ─────────

export function openGoodsEditor(g, ctx, sheet) {
  const isNew = !g;
  const item = g || { Sheet: sheet, Name: '', Sub: '', Person: '', Genre: '', Price: '', Have: 0, Want: 0, Trade: 0, Memo: '' };
  const grp = groupBySheet(item.Sheet);
  const members = grp ? membersOf(grp.OshiID) : [];
  const chosen = new Set(personNames(item));
  const allChecked = !!grp?.Emoji && String(item.Person).trim() === grp.Emoji;
  const genres = [...new Set([...(state.data.genres || []), item.Genre].filter(Boolean))];
  let have = num(item.Have);
  let newImage = null;
  const k = isNew ? '' : keyOf(item);

  const sheetSel = isNew && goodsGroups().length > 1
    ? field('推し（シート）', select('Sheet', goodsGroups().map((x) => [x.GoodsSheet, `${x.Name}（${x.GoodsSheet}）`]), item.Sheet))
    : '';
  const personField = members.length
    ? `<div class="field"><span>メンバー（複数可）</span><div class="checks">
        ${grp.Emoji ? `<label><input type="checkbox" name="Person" value="${esc(grp.Emoji)}" ${allChecked ? 'checked' : ''}>${esc(grp.Emoji)} 全員</label>` : ''}
        ${members.map((m) => `<label><input type="checkbox" name="Person" value="${esc(m.Name)}" ${chosen.has(m.Name) ? 'checked' : ''}>${esc(m.Name)}</label>`).join('')}</div></div>`
    : field('メンバー', input('PersonText', item.Person));

  openModal({
    title: isNew ? 'グッズを追加' : 'グッズの詳細',
    body: `
      <div class="img-edit">
        <div class="g-img" data-preview>${imgUrls.get(k) ? `<img src="${imgUrls.get(k)}" alt="">` : `<span aria-hidden="true">${GENRE_ICON[item.Genre] || '🎁'}</span>`}</div>
        <div><label class="btn sm">📷 画像を選ぶ<input type="file" accept="image/*" data-file hidden></label>
        <p class="small muted" style="margin:6px 0 0">長辺1024pxに縮小して保存し、同期時にGoogleドライブへ送ります。</p></div>
      </div>
      ${sheetSel}
      ${field('名前', input('Name', item.Name, 'required'))}
      ${field('サブタイトル（弾・柄など）', input('Sub', item.Sub))}
      ${personField}
      <div class="fields-2">
        ${field('ジャンル', select('Genre', [['', '—'], ...genres.map((x) => [x, x])], item.Genre))}
        ${field('価格（円）', input('Price', item.Price, 'type="number" inputmode="numeric" min="0"'))}
      </div>
      <div class="fields-3">
        <div class="field"><span>所持数</span><div class="stepper" style="margin:0"><button type="button" data-h="-1" aria-label="減らす">−</button><output data-have>${have}</output><button type="button" data-h="1" aria-label="増やす">＋</button></div></div>
        ${field('欲しい数', input('Want', item.Want || '', 'type="number" inputmode="numeric" min="0"'))}
        ${field('譲れる数', input('Trade', item.Trade || '', 'type="number" inputmode="numeric" min="0"'))}
      </div>
      ${field('メモ', `<textarea name="Memo">${esc(item.Memo)}</textarea>`)}
      ${isNew ? '' : `<p class="small muted">シート: ${esc(item.Sheet)} / ID: ${esc(item.ID)}</p>`}`,
    foot: `${isNew ? '' : '<button type="button" class="btn danger" data-del>削除</button>'}<span class="spacer"></span><button type="button" class="btn primary" data-save>保存</button>`,
    onMount: (m) => {
      if (!isNew && item.Image) imageUrl(item).then((u) => { if (u) m.querySelector('[data-preview]').innerHTML = `<img src="${u}" alt="">`; });
      m.querySelectorAll('[data-h]').forEach((b) => b.onclick = () => {
        have = Math.max(0, have + Number(b.dataset.h));
        m.querySelector('[data-have]').textContent = have;
      });
      m.querySelector('[data-file]').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          newImage = await resizeImage(f);
          m.querySelector('[data-preview]').innerHTML = `<img src="${newImage}" alt="">`;
        } catch (err) { toast(err.message); }
      };
      m.querySelector('[data-save]').onclick = async () => {
        const v = formValues(m);
        if (!v.Name) return toast('名前を入れてください');
        let person = v.PersonText ?? '';
        if (Array.isArray(v.Person)) person = v.Person.includes(grp?.Emoji) ? grp.Emoji : v.Person.join(', ');
        const fields = { Name: v.Name, Sub: v.Sub, Person: person, Genre: v.Genre, Price: v.Price === '' ? '' : num(v.Price), Want: num(v.Want), Trade: num(v.Trade), Memo: v.Memo };
        let target = item;
        if (isNew) {
          target = await goodsCreate(v.Sheet || item.Sheet, { ...fields, Have: have });
        } else {
          const changed = Object.fromEntries(Object.entries(fields).filter(([f, val]) => String(val ?? '') !== String(item[f] ?? '')));
          if (Object.keys(changed).length) await goodsUpdate(item, changed);
          if (have !== num(item.Have)) await goodsDelta(item, have - num(item.Have));
        }
        if (newImage) {
          imgUrls.delete(keyOf(target));
          await goodsImage(target, newImage);
        }
        closeModal();
        toast('保存しました');
      };
      m.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!confirm(`「${item.Name}」を削除しますか？（シートではDeleted列にTRUEが入ります）`)) return;
        await goodsUpdate(item, { Deleted: true });
        closeModal();
        toast('削除しました');
      });
    },
  });
}
