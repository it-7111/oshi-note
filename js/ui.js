import { esc } from './util.js';

const modal = () => document.getElementById('modal');

/**
 * 下から出るシートを開く。
 * body: HTML文字列, foot: ボタン群のHTML, onMount(root): イベント設定
 */
export function openModal({ title, body, foot = '', onMount }) {
  const m = modal();
  m.innerHTML = `
    <div class="m-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-close aria-label="閉じる">✕</button></div>
    <div class="m-body">${body}</div>
    ${foot ? `<div class="m-foot">${foot}</div>` : ''}`;
  m.querySelector('[data-close]').onclick = closeModal;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
  if (!m.open) m.showModal();
  onMount?.(m);
  return m;
}

export function closeModal() {
  const m = modal();
  if (m.open) m.close();
  m.innerHTML = '';
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/** フォーム内の [name] 要素から値を集める */
export function formValues(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') {
      if (!(el.name in out)) out[el.name] = [];
      if (el.checked) out[el.name].push(el.value);
    } else {
      out[el.name] = el.value.trim();
    }
  });
  return out;
}

export const field = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
export const input = (name, value = '', attrs = '') => `<input name="${name}" value="${esc(value)}" ${attrs}>`;
export const select = (name, options, value = '') =>
  `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
