// HTTP まわりの共通処理（応答形式・エラー・CSRF対策）

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message, ...(err.extra || {}) }, err.status);
  }
  // 想定外のエラー：詳細（SQLなど）は利用者に見せず、サーバーログにだけ残す
  console.error('N-PAS unexpected error:', err && err.stack ? err.stack : String(err));
  return json({ error: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。' }, 500);
}

const MAX_BODY = 4 * 1024 * 1024; // 4MB（データ移行の分割アップロードを考慮）

export async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'データが大きすぎます');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'データが大きすぎます');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, '送信データの形式が不正です');
  }
}

/**
 * 書き込み系リクエストのCSRF対策。
 * 同じオリジン（同じURL）の画面から送られたものだけを受け付ける。
 * CORSヘッダーは一切返さないため、他サイトのJavaScriptからは応答を読めない。
 */
export function assertSameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'none'].includes(site)) {
    throw new HttpError(403, '不正なリクエストです');
  }
  if (origin && origin !== url.origin) {
    throw new HttpError(403, '不正なリクエストです');
  }
  // fetch() からの送信であることを確認（フォーム送信による CSRF を防ぐ）
  if (request.headers.get('X-Requested-With') !== 'npas') {
    throw new HttpError(403, '不正なリクエストです');
  }
}
