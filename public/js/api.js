// 旧 google.script.run の代わりに、クラウド版の API を呼び出す。
// 画面側のプログラム（app.js）は今まで通り call('関数名', ...) を使うので、画面の動きは変わらない。
(function () {
  'use strict';

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  // ログインの通信中は、ほかの通信をその完了まで待たせる（すぐにホーム画面を出すため）
  let loginPending = null;

  async function http(method, path, body) {
    if (loginPending && path !== '/api/login') await loginPending.catch(() => {});
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: Object.assign({ 'X-Requested-With': 'npas' }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('通信に失敗しました。電波の良い場所でもう一度お試しください');
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* 応答がJSONでない */
    }
    if (!res.ok) throw new Error((data && data.error) || 'サーバーでエラーが発生しました（' + res.status + '）');
    return data;
  }

  // 通信エラーのあと同じ内容で再送したときに、二重登録にならないよう同じ識別子を付ける。
  // 保存が成功したら識別子は捨てる（次に同じ内容を申請したときは新しい記録になる＝旧仕様と同じ）。
  const pending = new Map();
  async function once(kind, body, path) {
    const key = kind + JSON.stringify(body);
    let id = pending.get(key);
    if (!id) {
      id = newId();
      pending.set(key, id);
    }
    const r = await http('POST', path, Object.assign({}, body, { requestId: id }));
    pending.delete(key);
    return r;
  }

  let bootPromise = null;
  function boot() {
    if (!bootPromise) bootPromise = http('GET', '/api/bootstrap').catch(e => {
      bootPromise = null;
      throw e;
    });
    return bootPromise;
  }

  const api = {
    // ログイン画面の名簿と設定は1回の通信でまとめて受け取る（失敗したら次回やり直す）
    listStaff: () => boot().then(b => b.staff),
    config: () => boot().then(b => b.config),
    login: (staffId, pin) => {
      const p = http('POST', '/api/login', { staffId, pin });
      loginPending = p;
      p.finally(() => {
        if (loginPending === p) loginPending = null;
      }).catch(() => {});
      return p;
    },
    logout: () => http('POST', '/api/logout', {}),
    // 本人の特定はログイン時のCookieで行う（スタッフIDはサーバー側で照合のみ）
    clockStatus: staffId => http('GET', '/api/clock/status?staffId=' + encodeURIComponent(staffId)),
    clockIn: staffId => http('POST', '/api/clock/in', { staffId }),
    clockOut: (staffId, breakMin, task, allowance) => once('clockOut', { staffId, breakMin, task, allowance }, '/api/clock/out'),
    saveAttendance: (staffId, input) => once('saveAttendance', Object.assign({ staffId }, input), '/api/attendance'),
    getHistory: (staffId, month) =>
      http('GET', '/api/history?staffId=' + encodeURIComponent(staffId) + '&month=' + encodeURIComponent(month)),
    npasSubmitCorrection: (staffId, recordId, input, reason) => http('POST', '/api/corrections', { staffId, recordId, input, reason }),
    npasSubmitDeletion: (staffId, recordId, reason) => http('POST', '/api/corrections/delete', { staffId, recordId, reason }),
    npasMyRequests: staffId => http('GET', '/api/my/requests?staffId=' + encodeURIComponent(staffId)),
    npasSaveBulkAttendance: (operatorId, staffIds, input) =>
      http('POST', '/api/bulk', Object.assign({ operatorId, staffIds }, input)),
    // 月別集計は「表示するときに元データから計算する」方式になったため、保存後の集計更新は不要。
    // 画面側の呼び出しはそのまま残し、通信せずに成功を返す（通信回数の削減）。
    npasUpdateSummaryNow: () => Promise.resolve({ ok: true, warning: '' }),
    npasUpdateBulkSummaryNow: () => Promise.resolve({ ok: true, failed: [] }),
  };

  window.npasApi = function (name, args) {
    const f = api[name];
    if (!f) return Promise.reject(new Error('未対応の処理です: ' + name));
    return f.apply(null, args);
  };
})();
