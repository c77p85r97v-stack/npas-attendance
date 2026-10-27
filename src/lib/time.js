// 日本時間（Asia/Tokyo）での日付・時刻の表示。
// Cloudflare Workers のサーバー時計は UTC なので、必ずここを通して変換する。

const TZ = 'Asia/Tokyo';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(d) {
  const o = {};
  for (const p of partsFmt.formatToParts(d)) o[p.type] = p.value;
  return o;
}

/** yyyy-MM-dd（日本時間） */
export function jstDate(d = new Date()) {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** HH:mm（日本時間） */
export function jstTime(d = new Date()) {
  const p = parts(d);
  return `${p.hour}:${p.minute}`;
}

/** yyyy-MM（日本時間） */
export function jstMonth(d = new Date()) {
  return jstDate(d).slice(0, 7);
}

/** 保存用の日時（UTC の ISO 8601） */
export function nowIso(d = new Date()) {
  return d.toISOString();
}
