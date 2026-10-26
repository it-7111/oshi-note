// 推し（グループ＞メンバー）まわりの共通処理
import { state } from './store.js';

const byOrder = (a, b) => (Number(a.Order) || 0) - (Number(b.Order) || 0);

export const allOshi = () => state.data.oshi;
export const groups = () => allOshi().filter((o) => o.Type === 'group').sort(byOrder);
export const membersOf = (gid) => allOshi().filter((o) => o.Type === 'member' && o.ParentID === gid).sort(byOrder);
export const oshiById = (id) => allOshi().find((o) => o.OshiID === id);
export const groupOf = (id) => {
  const o = oshiById(id);
  return o && o.Type === 'member' ? oshiById(o.ParentID) : o;
};
export const colorOf = (id) => oshiById(id)?.Color || '#a21caf';
export const nameOf = (id) => oshiById(id)?.Name || '';
export const goodsGroups = () => groups().filter((g) => g.GoodsSheet);
export const groupBySheet = (sheet) => groups().find((g) => g.GoodsSheet === sheet);

/** Person列を分解。空欄・グループ絵文字（🎼）なら [] ＝グループ全員 */
export function personNames(item) {
  const g = groupBySheet(item.Sheet);
  return String(item.Person || '')
    .split(/[,、，]\s*/)
    .map((s) => s.trim())
    .filter((s) => s && s !== g?.Emoji && s !== '全員');
}

/** グッズに対応するメンバーIDの一覧（[]ならグループ全員） */
export function goodsMemberIds(item) {
  const g = groupBySheet(item.Sheet);
  if (!g) return [];
  const ms = membersOf(g.OshiID);
  return personNames(item).map((n) => ms.find((m) => m.Name === n)?.OshiID).filter(Boolean);
}

/** 上部チップの選択（sel = {group, member}）に推しIDが当てはまるか */
export function matchesSel(oshiId, sel) {
  if (!sel.group) return true;
  const o = oshiById(oshiId);
  if (!o) return false;
  if (sel.member) return o.OshiID === sel.member || o.OshiID === sel.group; // グループ全体の予定はメンバー表示でも出す
  return o.OshiID === sel.group || o.ParentID === sel.group;
}

/** カレンダーの表示・非表示（設定 hidden に入っている推しは出さない。グループを隠すとメンバーも隠れる） */
export function isVisible(oshiId) {
  const hidden = state.settings.hidden || [];
  const o = oshiById(oshiId);
  if (!o) return !hidden.includes(oshiId);
  return !hidden.includes(o.OshiID) && !(o.ParentID && hidden.includes(o.ParentID));
}
