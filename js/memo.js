// 週メモ・月メモ（文字＋手書き）。iPadでは常に表示して編集、iPhoneではタップで閲覧だけ。
import { state, upsertRow } from './store.js';
import { esc, debounce } from './util.js';
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
      ${editable
        ? `<textarea class="memo-text" data-memo-text="${esc(key)}" placeholder="文字のメモ（Pencilで書くと文字になります）">${esc(memoText(key))}</textarea>`
        : (memoText(key).trim() ? `<p class="memo-read">${esc(memoText(key))}</p>` : '')}
      <canvas class="memo-ink" data-memo-ink="${esc(key)}" aria-label="${esc(title)}の手書き"></canvas>
    </section>`).join('');
}

const saveText = new Map();
export function bindMemoPanel(root, editable) {
  root.querySelectorAll('[data-memo-text]').forEach((ta) => {
    const key = ta.dataset.memoText;
    if (!saveText.has(key)) saveText.set(key, debounce((v) => upsertRow('Memos', { MemoID: key, Text: v }), 800));
    ta.addEventListener('input', () => saveText.get(key)(ta.value));
  });
  root.querySelectorAll('[data-memo-ink]').forEach((cv) => {
    mountInk(cv, memoMapping(`memo:${cv.dataset.memoInk}`), { editable, minHeightUnits: editable ? 700 : 0 });
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
