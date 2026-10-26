// GASを設定する前に表示するデモデータ（日付は今日を基準に作る）
import { today, addDays, weekday } from './util.js';

const OSHI = [
  ['sixfonia', 'group', '', 'シクフォニ', 'SIXFONIA', '#7c3aed', '🎼', '', '', '2024-05-03', 1],
  ['sixfonia-hima72', 'member', 'sixfonia', '暇72', '', '#ef4444', '', '', '', '', 2],
  ['sixfonia-kosame', 'member', 'sixfonia', '雨乃こさめ', '', '#38bdf8', '', '', '', '', 3],
  ['sixfonia-iruma', 'member', 'sixfonia', 'いるま', '', '#a855f7', '', '', '', '', 4],
  ['sixfonia-lan', 'member', 'sixfonia', 'LAN', '', '#f472b6', '', '', '', '', 5],
  ['sixfonia-suchi', 'member', 'sixfonia', 'すち', '', '#22c55e', '', '', '', '', 6],
  ['sixfonia-mikoto', 'member', 'sixfonia', 'みこと', '', '#facc15', '', '', '', '', 7],
  ['irregular', 'group', '', 'いれいす', '', '#2563eb', '', '', '', '', 8],
  ['other', 'group', '', 'その他', 'Other Oshi Goods', '#64748b', '⭐', '', '', '', 9],
];
const MEMBERS = ['暇72', '雨乃こさめ', 'いるま', 'LAN', 'すち', 'みこと'];

export function demoData() {
  const t = today();
  const oshi = OSHI.map(([OshiID, Type, ParentID, Name, GoodsSheet, Color, Emoji, Birthday, DebutDate, OshiStart, Order]) => ({
    OshiID, Type, ParentID, Name, GoodsSheet, Color, Emoji, Birthday, DebutDate, OshiStart, Icon: '', Order: String(Order), UpdatedAt: '',
  }));

  let id = 0;
  const goods = [];
  const add = (Sheet, Name, Sub, Person, Genre, Price, Have, extra = {}) => goods.push({
    Sheet, ID: String(++id), Name, Sub, Person, Genre, Price, Have, Want: 0, Trade: 0, Image: '', Memo: '', UpdatedAt: '', ...extra,
  });
  MEMBERS.forEach((m, i) => add('SIXFONIA', 'ランダム缶バッジ 第1弾', '『ライブ衣装ver.』', m, '缶バッジ', 500, [1, 0, 2, 1, 0, 1][i], i === 2 ? { Trade: 1 } : i === 4 ? { Want: 1 } : {}));
  MEMBERS.forEach((m, i) => add('SIXFONIA', 'トレーディングカード', '2周年ver.', m, 'カード', 400, [0, 1, 1, 0, 0, 0][i]));
  add('SIXFONIA', '1stアルバム 通常盤', '', '🎼', 'CD', 3300, 1);
  add('SIXFONIA', 'アクリルスタンド', '', 'すち', 'アクリルスタンド', 1800, 1);
  add('SIXFONIA', 'ペアアクリルキーホルダー', '', 'すち, みこと', 'アクリルキーホルダー', 1200, 0, { Want: 1 });
  add('SIXFONIA', 'ツアーTシャツ 黒', '', '🎼', 'アパレル/アクセサリー', 4000, 1);
  add('SIXFONIA', 'ぬいぐるみ', '', '雨乃こさめ', 'ぬいぐるみ', 3500, 0);
  add('Other Oshi Goods', 'コラボカフェ コースター', '', '', 'その他', 0, 2);

  // 今週の金曜を基準に毎週の配信
  const offsetToFri = (5 - weekday(t) + 7) % 7;
  const fri = addDays(t, offsetToFri);
  const events = [
    { EventID: 'e1', OshiID: 'sixfonia', Kind: '配信', Title: '定期生配信', Date: addDays(fri, -14), Start: '21:00', End: '22:30', Repeat: 'weekly', URL: '', Memo: '', UpdatedAt: '' },
    { EventID: 'e2', OshiID: 'sixfonia', Kind: 'リリース', Title: '新曲MV公開', Date: addDays(t, 3), Start: '18:00', End: '', Repeat: 'none', URL: '', Memo: '', UpdatedAt: '' },
    { EventID: 'e3', OshiID: 'sixfonia', Kind: '申込締切', Title: 'FC先行 申込締切', Date: addDays(t, 5), Start: '23:59', End: '', Repeat: 'none', URL: '', Memo: '', UpdatedAt: '' },
    { EventID: 'e4', OshiID: 'irregular', Kind: '配信', Title: 'いれいす 生配信', Date: addDays(t, 1), Start: '20:00', End: '21:00', Repeat: 'none', URL: '', Memo: '', UpdatedAt: '' },
    { EventID: 'e5', OshiID: 'sixfonia-suchi', Kind: '配信', Title: 'すち 個人配信', Date: addDays(t, 2), Start: '18:30', End: '20:00', Repeat: 'none', URL: '', Memo: '', UpdatedAt: '' },
  ];

  const lives = [
    { LiveID: 'l1', OshiID: 'sixfonia', Date: addDays(t, 40), Open: '17:00', Start: '18:00', Title: '冬ツアー 東京公演', Tour: 'Winter Tour', Venue: '東京ホール', Status: '当選', Seat: '1階 15列', Companions: '', Ticket: '9800', Travel: '0', Setlist: '', Photos: '', Rating: '', Memo: '', UpdatedAt: '' },
    { LiveID: 'l2', OshiID: 'sixfonia', Date: addDays(t, -60), Open: '16:00', Start: '17:00', Title: '夏ライブ 大阪公演', Tour: 'Summer Live', Venue: '大阪アリーナ', Status: '参戦済', Seat: 'スタンド B-12', Companions: '友人', Ticket: '9800', Travel: '15400', Setlist: '1. オープニング曲\n2. 代表曲\n3. 新曲', Photos: '', Rating: '5', Memo: '最高だった', UpdatedAt: '' },
    { LiveID: 'l3', OshiID: 'irregular', Date: addDays(t, -200), Open: '', Start: '19:00', Title: '配信ライブ', Tour: '', Venue: 'オンライン', Status: '配信視聴', Seat: '', Companions: '', Ticket: '4500', Travel: '0', Setlist: '', Photos: '', Rating: '4', Memo: '', UpdatedAt: '' },
  ];

  const schedule = [];
  for (let i = -7; i < 35; i++) {
    const d = addDays(t, i);
    const w = weekday(d);
    if (w === 3) schedule.push({ kind: 'S', date: d, start: '10:30', end: '12:00', title: 'ゼミ', place: '大学', notes: '', done: false });
    if (w === 1 || w === 4) schedule.push({ kind: 'S', date: d, start: '18:00', end: '21:30', title: 'バイト', place: '', notes: '', done: false });
    if (w === 5) schedule.push({ kind: 'S', date: d, start: '20:30', end: '22:00', title: 'サークル練習', place: '', notes: '', done: false });
    if (w === 2) schedule.push({ kind: 'T', date: d, start: '', end: '', title: '課題提出', place: '', notes: '', done: i < 0 });
  }
  schedule.forEach((s, i) => { s.id = `sch-${i}`; });

  // 支出集計用：アプリで増やしたグッズの記録（Logシート相当）
  const purchases = [
    { date: addDays(t, -95), sheet: 'SIXFONIA', id: '13', delta: 1 },
    { date: addDays(t, -60), sheet: 'SIXFONIA', id: '16', delta: 1 },
    { date: addDays(t, -40), sheet: 'SIXFONIA', id: '1', delta: 1 },
    { date: addDays(t, -40), sheet: 'SIXFONIA', id: '3', delta: 2 },
    { date: addDays(t, -12), sheet: 'SIXFONIA', id: '14', delta: 1 },
    { date: addDays(t, -3), sheet: 'SIXFONIA', id: '8', delta: 1 },
  ];
  const expenses = [
    { ExpenseID: 'x1', Date: addDays(t, -150), OshiID: 'sixfonia', Category: 'FC会費', Amount: '5500', Memo: '', UpdatedAt: '' },
    { ExpenseID: 'x2', Date: addDays(t, -20), OshiID: 'irregular', Category: '配信チケット', Amount: '3800', Memo: '', UpdatedAt: '' },
    { ExpenseID: 'x3', Date: addDays(t, -5), OshiID: 'sixfonia', Category: 'カフェ・コラボ', Amount: '2400', Memo: 'コラボカフェ', UpdatedAt: '' },
  ];
  const savings = [
    { SavingID: 's1', Date: addDays(t, -30), Amount: '6000', Memo: 'バイト代から', UpdatedAt: '' },
    { SavingID: 's2', Date: addDays(t, -2), Amount: '2000', Memo: '', UpdatedAt: '' },
  ];
  const config = [
    { Key: 'savingsGoal', Value: JSON.stringify({ targetDate: addDays(t, 60), includeLives: true, extra: 0 }), UpdatedAt: '' },
  ];

  return {
    oshi, goods, events, lives, schedule, purchases, expenses, savings, config,
    genres: ['缶バッジ', 'アクリルスタンド', 'その他', '日用雑貨/文房具', 'カード', 'CD', 'アパレル/アクセサリー', 'その他キーホルダー', 'アクリルキーホルダー', 'チェキ', 'ぬいぐるみ'],
  };
}
