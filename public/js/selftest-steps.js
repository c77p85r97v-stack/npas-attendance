// 動作確認テストの手順（ブラウザの selftest.html と、サーバー側の /api/test/selfcheck の両方で使う）
// fetchImpl(path, init) は fetch と同じ使い方の関数。
export function createSteps(fetchImpl) {
  async function call(method, path, body) {
    const t = performance.now();
    const res = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: Object.assign({ 'X-Requested-With': 'npas' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* JSON以外 */
    }
    return { status: res.status, data, ms: Math.round(performance.now() - t) };
  }
  const GET = p => call('GET', p);
  const POST = (p, b = {}) => call('POST', p, b);
  function expect(cond, msg) {
    if (!cond) throw new Error(msg);
  }
  const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  const steps = [];
  function step(name, fn) {
    steps.push({ name, fn });
  }

  const day = jstToday();
  const month = day.slice(0, 7);
  let recordId = null;

  step('テスト用データの初期化（TEST01〜05のみ）', async () => {
    const r = await POST('/api/test/reset?samples=0');
    expect(r.status === 200, r.data?.error || 'テスト環境ではありません');
    return { ms: r.ms, msg: r.data.message };
  });
  step('スタッフ一覧の取得', async () => {
    const r = await GET('/api/staff');
    expect(r.status === 200 && r.data.some(s => s.id === 'TEST01'), 'TEST01 が一覧にありません');
    expect(!JSON.stringify(r.data).includes('pin'), 'PIN情報が含まれています');
    return { ms: r.ms, msg: `${r.data.length}名` };
  });
  step('間違ったPINではログインできない', async () => {
    const r = await POST('/api/login', { staffId: 'TEST01', pin: '9999' });
    expect(r.status === 401, '間違ったPINでログインできてしまいました');
    return { ms: r.ms, msg: r.data.error };
  });
  step('名前の選択だけ（PINなし）ではログインできない', async () => {
    const r = await POST('/api/login', { staffId: 'TEST01' });
    expect(r.status === 400, 'PINなしでログインできてしまいました');
    return { ms: r.ms, msg: r.data.error };
  });
  step('正しいPINでログイン（TEST01）', async () => {
    const r = await POST('/api/login', { staffId: 'TEST01', pin: '1234' });
    expect(r.status === 200, r.data?.error);
    return { ms: r.ms, msg: r.data.user.name };
  });
  step('出勤状態の取得（まだ出勤していない）', async () => {
    const r = await GET('/api/clock/status');
    expect(r.status === 200 && r.data.active === false, JSON.stringify(r.data));
    return { ms: r.ms };
  });
  step('出勤していない状態での退勤は拒否', async () => {
    const r = await POST('/api/clock/out', { breakMin: 0 });
    expect(r.status === 400 && r.data.error === '先に出勤してください', JSON.stringify(r.data));
    return { ms: r.ms, msg: r.data.error };
  });
  step('出勤打刻', async () => {
    const r = await POST('/api/clock/in');
    expect(r.status === 200, r.data?.error);
    return { ms: r.ms, msg: `打刻時刻 ${r.data.time}` };
  });
  step('二重出勤の拒否', async () => {
    const r = await POST('/api/clock/in');
    expect(r.status === 409, '二回目の出勤が受け付けられてしまいました');
    return { ms: r.ms, msg: r.data.error };
  });
  step('退勤打刻（出勤と同じ「分」なら0分として拒否されるのが正しい動作）', async () => {
    const r = await POST('/api/clock/out', { breakMin: 0, task: '動作確認', requestId: 'selftest-' + Date.now() });
    if (r.status === 200) {
      const s = await GET('/api/clock/status');
      expect(s.data.active === false, '退勤後も出勤中のままです');
      return { ms: r.ms, msg: `保存しました（${r.data.hours}時間）` };
    }
    expect(r.data.error === '出退勤時刻と休憩時間を確認してください', JSON.stringify(r.data));
    const s = await GET('/api/clock/status');
    expect(s.data.active === true, '保存されていないのに出勤状態が解除されました');
    return { ms: r.ms, msg: '1分未満のため拒否され、出勤状態は残りました（正しい動作）。後の手順で管理者が取り消します' };
  });
  step('通常の勤怠申請', async () => {
    const r = await POST('/api/attendance', { date: day, start: '10:00', end: '15:30', breakMin: '30', task: '動作確認テスト', allowance: '500', requestId: 'selftest-att-' + Date.now() });
    expect(r.status === 200 && r.data.hours === 5, JSON.stringify(r.data));
    recordId = r.data.id;
    return { ms: r.ms, msg: `勤務時間 ${r.data.hours}時間` };
  });
  step('不正な入力の拒否（存在しない日付・時刻・休憩・手当）', async () => {
    const bad = [
      [{ date: '2026-02-30' }, '存在しない日付です'],
      [{ start: '25:00' }, '時刻が不正です'],
      [{ breakMin: '400' }, '出退勤時刻と休憩時間を確認してください'],
      [{ allowance: '-1' }, '手当を確認してください'],
    ];
    let ms = 0;
    for (const [o, msg] of bad) {
      const r = await POST('/api/attendance', { date: day, start: '10:00', end: '15:00', breakMin: '0', ...o });
      ms += r.ms;
      expect(r.status === 400 && r.data.error === msg, `${JSON.stringify(o)} → ${JSON.stringify(r.data)}`);
    }
    return { ms: Math.round(ms / bad.length), msg: '4件とも拒否（平均の応答時間）' };
  });
  step('月別履歴の取得と月間合計', async () => {
    const r = await GET('/api/history?month=' + month);
    expect(r.status === 200 && r.data.entries.some(e => e.id === recordId), '保存した記録が履歴にありません');
    return { ms: r.ms, msg: `${r.data.entries.length}件・合計 ${r.data.totalHours}時間` };
  });
  step('他のスタッフの履歴は取得できない（権限チェック）', async () => {
    const r = await GET('/api/history?month=' + month + '&staffId=TEST02');
    expect(r.status === 403, '他人の履歴が取得できてしまいました');
    return { ms: r.ms, msg: r.data.error };
  });
  step('一括勤怠申請（TEST02〜04）', async () => {
    const r = await POST('/api/bulk', { staffIds: ['TEST02', 'TEST03', 'TEST04'], date: day, start: '13:00', end: '17:00', breakMin: '0', task: '一括テスト', allowance: '' });
    expect(r.status === 200 && r.data.saved.length === 3, JSON.stringify(r.data));
    return { ms: r.ms, msg: `登録 ${r.data.saved.length}名・スキップ ${r.data.skipped.length}名` };
  });
  step('一括勤怠申請：同じ日の重複はスキップ', async () => {
    const r = await POST('/api/bulk', { staffIds: ['TEST02', 'TEST03', 'TEST05'], date: day, start: '13:00', end: '17:00', breakMin: '0', task: '', allowance: '' });
    expect(r.status === 200 && r.data.saved.length === 1 && r.data.skipped.length === 2, JSON.stringify(r.data));
    return { ms: r.ms, msg: `登録 ${r.data.saved.length}名・スキップ ${r.data.skipped.length}名（${r.data.skipped[0].reason}）` };
  });
  step('打刻修正申請（申請だけでは記録は変わらない）', async () => {
    const r = await POST('/api/corrections', { recordId, input: { date: day, start: '10:00', end: '16:00', breakMin: '30', task: '動作確認テスト（修正）', allowance: '500' }, reason: '動作確認のため' });
    expect(r.status === 200 && r.data.status === '申請中', JSON.stringify(r.data));
    const h = await GET('/api/history?month=' + month);
    expect(h.data.entries.find(e => e.id === recordId).end === '15:30', '承認前に記録が変わっています');
    const dup = await POST('/api/corrections', { recordId, input: { date: day, start: '10:00', end: '17:00', breakMin: '0' }, reason: '二重' });
    expect(dup.status === 409, '審査待ちがあるのに二重に申請できました');
    return { ms: r.ms, msg: '申請中（二重申請は拒否）' };
  });
  step('同時アクセス：5回同時に出勤を押しても1回だけ', async () => {
    await POST('/api/test/reset?samples=0').then(() => POST('/api/login', { staffId: 'TEST05', pin: '1234' }));
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => POST('/api/clock/in')));
    const ok = rs.filter(r => r.status === 200).length;
    expect(ok === 1, `${ok}回成功してしまいました`);
    return { ms: Math.max(...rs.map(r => r.ms)), msg: `成功1回・拒否${rs.length - 1}回` };
  });
  step('管理者ログイン（テスト用管理者）', async () => {
    const r = await POST('/api/admin/login', { loginId: 'testadmin', password: 'test-password-1234' });
    expect(r.status === 200, r.data?.error);
    return { ms: r.ms };
  });
  step('管理者：出勤状態の取消', async () => {
    const r = await POST('/api/admin/staff/TEST05/cancel-clock');
    expect(r.status === 200, r.data?.error);
    return { ms: r.ms };
  });
  step('修正申請の承認で記録が変わる', async () => {
    await POST('/api/login', { staffId: 'TEST01', pin: '1234' });
    const a = await POST('/api/attendance', { date: day, start: '09:00', end: '12:00', breakMin: '0', task: '承認テスト', allowance: '' });
    await POST('/api/corrections', { recordId: a.data.id, input: { date: day, start: '09:00', end: '13:00', breakMin: '0', task: '承認テスト', allowance: '' }, reason: '承認テスト' });
    const list = await GET('/api/admin/corrections');
    const req = list.data.requests.find(x => x.recordId === a.data.id);
    expect(req, '申請が管理画面に表示されません');
    const r = await POST(`/api/admin/corrections/${req.id}/approve`, { memo: '自動テスト' });
    expect(r.status === 200, r.data?.error);
    const h = await GET('/api/history?month=' + month);
    const e = h.data.entries.find(x => x.id === a.data.id);
    expect(e.end === '13:00' && e.hours === 4, JSON.stringify(e));
    return { ms: r.ms, msg: '12:00 → 13:00 に変更されました' };
  });
  step('月別集計（勤務実績のないスタッフも表示）', async () => {
    const r = await GET('/api/admin/summary?month=' + month);
    expect(r.status === 200, r.data?.error);
    const t1 = r.data.rows.find(x => x.staffId === 'TEST01');
    const t5 = r.data.rows.find(x => x.staffId === 'TEST05');
    expect(t1 && t1.hours === 4 && t1.days === 1, JSON.stringify(t1));
    expect(t5 && t5.days === 0, 'TEST05（実績なし）が表示されません');
    return { ms: r.ms, msg: `${r.data.rows.length}名分` };
  });
  step('個人別勤怠申請書', async () => {
    const r = await GET(`/api/admin/personal?staffId=TEST01&month=${month}`);
    expect(r.status === 200 && r.data.totals.hours === 4, JSON.stringify(r.data?.totals));
    return { ms: r.ms, msg: `${r.data.days.length}日分・合計 ${r.data.totals.hours}時間` };
  });
  step('ログアウト後は操作できない', async () => {
    await POST('/api/logout');
    const r = await GET('/api/me');
    expect(r.status === 401, 'ログアウト後も操作できます');
    await POST('/api/admin/logout');
    return { ms: r.ms };
  });
  step('後片付け（テスト用データを初期状態に戻す）', async () => {
    const r = await POST('/api/test/reset');
    expect(r.status === 200, r.data?.error);
    return { ms: r.ms };
  });


  return steps;
}

/** 手順を順番に実行する。onStep(結果) が1手順ごとに呼ばれる */
export async function runSteps(fetchImpl, onStep = () => {}) {
  const results = [];
  for (const s of createSteps(fetchImpl)) {
    const r = { name: s.name, ok: false, msg: '', ms: null };
    onStep({ ...r, running: true });
    try {
      const out = (await s.fn()) || {};
      Object.assign(r, { ok: true, msg: out.msg || '', ms: out.ms ?? null });
    } catch (e) {
      r.msg = e.message;
    }
    results.push(r);
    onStep(r);
  }
  return results;
}
