// 週メモ・月メモ（文字＋手書き）。iPadでは常に表示して編集、iPhoneではタップで閲覧だけ。
import { state } from './store.js';
import { esc } from './util.js';
import { mountInk, memoMapping, pageHasInk } from './ink.js';
import { openModal } from './ui.js';

export const weekKey = (startYmd) => `week:${startYmd}`;
export const monthKey = (ym) => `month:${ym}`;
export const memoText = (key) => state.data.memos.find((m) => m.MemoID === key)?.Text || '';
export const hasMemo = (key) => !!memoText(key).trim() || pageHasInk(`memo:${key}`);

/** iPadなど画面が広いとき（メモ欄を常に出して編集できる） */
export const isWide = () => window.matchMedia('(min-width: 760px)').matches;

/** memos: [{ key, title }] */
export function memoPanelHtml(memos, editable) {
  return memos.map(({ key, title }) => `
    <section class="memo-card card" data-memo="${esc(key)}">
      <h3>${esc(title)}</h3>
      ${memoText(key).trim() ? `<p class="memo-read">${esc(memoText(key))}</p>` : ''}
      <canvas class="memo-ink" data-memo-ink="${esc(key)}" aria-label="${esc(title)}の手書き"></canvas>
    </section>`).join('');
}

/** 手書き欄を表示する。iPadでは、横に並ぶメモ欄の高さを等分して最初から書ける広さにする */
export function bindMemoPanel(root, editable) {
  const side = root.querySelector('.memo-side');
  const cards = [...root.querySelectorAll('[data-memo-ink]')];
  let minH = 0;
  if (editable && side) {
    const gap = 10;
    const head = 40; // 見出しの分
    const n = getComputedStyle(side).flexDirection === 'row' ? 1 : cards.length; // 縦向きは横並び
    minH = Math.max(160, (side.clientHeight - gap * (n - 1)) / n - head - 24);
  }
  cards.forEach((cv) => {
    const extra = cv.previousElementSibling?.classList.contains('memo-read') ? cv.previousElementSibling.offsetHeight : 0;
    mountInk(cv, memoMapping(`memo:${cv.dataset.memoInk}`), { editable, minHeightPx: Math.max(0, minH - extra) });
  });
}

/** iPhone用：閲覧だけのメモを開く */
export function openMemoViewer(memos) {
  const shown = memos.filter((m) => hasMemo(m.key));
  openModal({
    title: 'メモ',
    body: shown.length ? memoPanelHtml(shown, false) : '<p class="muted">メモはありません。iPadで書いたメモがここに表示されます。</p>',
    onMount: (m) => bindMemoPanel(m, false),
  });
}
