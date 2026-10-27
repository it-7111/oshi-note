// 申込・入金の手続き、配信アーカイブの期限（ホーム・カレンダー・参戦記録で共通。GASの同名関数と同じ規則）
import { state, norm } from './store.js';
import { addDays, today } from './util.js';

/** "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM" / "YYYY-MM-DD" → { date, time } */
export function splitDateTime(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  return m ? { date: m[1], time: m[2] || '' } : null;
}

/** 参戦記録のうち、まだ済んでいない手続き */
export function liveSteps(l) {
  const out = [];
  const push = (v, kind, label) => { const x = splitDateTime(v); if (x) out.push({ ...x, kind, label, live: l }); };
  if (l.Status === '申込中') { push(l.ApplyBy, 'apply', '📝申込締切'); push(l.ResultAt, 'result', '🎫当落発表'); }
  if (l.Status === '当選' && norm(l.Paid) !== 'TRUE') push(l.PayBy, 'pay', '💴入金締切');
  if (l.Status === '当選' && norm(l.Issued) !== 'TRUE') push(l.IssueAt, 'issue', '🎟発券開始');
  return out;
}

/** 参戦記録の「次にやること」を1つ */
export function nextStep(l) {
  const t = today();
  return liveSteps(l).filter((s) => s.date >= t).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0] || null;
}

/** 配信日 d のアーカイブ期限（'' はなし、'∞' は期限なし） */
export function archiveExpiry(e, d) {
  if (e.ArchiveUntil && (!e.Repeat || e.Repeat === 'none')) return e.ArchiveUntil;
  if (!e.ArchiveDays) return '';
  const n = Number(e.ArchiveDays);
  return n < 0 ? '∞' : addDays(d, n);
}

export const watchedSet = (e) => new Set(String(e.Watched || '').split(',').filter(Boolean));

/** まだ見ていないアーカイブ（期限の近い順）。occurrencesFn は calendar.js の繰り返し展開 */
export function pendingArchives(occurrencesFn) {
  const t = today();
  const out = [];
  for (const e of state.data.events) {
    if (!e.ArchiveDays && !e.ArchiveUntil) continue;
    const w = watchedSet(e);
    for (const d of occurrencesFn(e.Date, e.Repeat, addDays(t, -120), t)) {
      const exp = archiveExpiry(e, d);
      if (!exp || w.has(d) || (exp !== '∞' && exp < t)) continue;
      out.push({ event: e, date: d, expiry: exp });
    }
  }
  return out.sort((a, b) => (a.expiry === '∞' ? '9' : a.expiry).localeCompare(b.expiry === '∞' ? '9' : b.expiry));
}

