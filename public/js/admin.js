// N-PAS 管理画面
import { parseCsv, detectSheet, parseExportJson, runMigration, downloadBackup } from './migrate-client.js';

const $ = id => document.getElementById(id);

// ---------- 共通 ----------
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: Object.assign({ 'X-Requested-With': 'npas' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('通信に失敗しました。ネットワークを確認してください');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* JSON以外 */
  }
  if (res.status === 401 && !path.endsWith('/login')) showLogin();
  if (!res.ok) throw new Error((data && data.error) || `エラー（${res.status}）`);
  return data;
}
const get = p => api('GET', p);
const post = (p, b = {}) => api('POST', p, b);

/** 要素を作る（文字列は必ず textContent として入れるので、HTMLとして解釈されない） */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function toast(s) {
  const t = $('toast');
  t.textContent = s;
  t.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.style.display = 'none'), 3500);
}

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const fmtDT = s => {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const yen = n => (n === '' || n == null ? '' : Number(n).toLocaleString('ja-JP'));
const hrs = n => Number(n || 0).toFixed(2);

/**
 * 入力フォームのダイアログ。fields: [{name,label,type,value,options,required}]
 * onOk(values) が例外を投げたらダイアログ内にエラーを表示して閉じない。
 */
function form(title, fields, onOk, okLabel = 'OK') {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.replaceChildren();
  const inputs = {};
  for (const f of fields) {
    if (f.type === 'info') {
      body.append(h('p', { class: 'note', text: f.text }));
      continue;
    }
    let input;
    if (f.type === 'select') input = h('select', {}, f.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') }, l)));
    else if (f.type === 'textarea') input = h('textarea', { rows: 3, maxlength: f.max || 300 });
    else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', checked: !!f.value });
    else input = h('input', { type: f.type || 'text', min: f.min, max: f.maxNum, step: f.step, placeholder: f.placeholder || '' });
    if (f.type !== 'checkbox' && f.type !== 'select') input.value = f.value ?? '';
    inputs[f.name] = input;
    body.append(h('label', {}, f.label, input));
  }
  $('modalOk').textContent = okLabel;
  $('modalError').textContent = '';
  $('modal').hidden = false;
  const first = Object.values(inputs)[0];
  if (first) first.focus();
  $('modalCancel').onclick = () => ($('modal').hidden = true);
  $('modalOk').onclick = async () => {
    const values = {};
    for (const [k, el] of Object.entries(inputs)) values[k] = el.type === 'checkbox' ? el.checked : el.value;
    $('modalOk').disabled = true;
    try {
      await onOk(values);
      $('modal').hidden = true;
    } catch (e) {
      $('modalError').textContent = e.message;
    } finally {
      $('modalOk').disabled = false;
    }
  };
}

// ---------- ログイン ----------
function showLogin() {
  $('appView').hidden = true;
  $('loginView').hidden = false;
  $('logoutBtn').hidden = true;
  $('whoName').textContent = '';
  get('/api/admin/setup')
    .then(s => ($('setupCard').hidden = !s.needsSetup))
    .catch(() => {});
}
$('setupBtn').onclick = async () => {
  $('setupError').textContent = '';
  try {
    await post('/api/admin/setup', { setupToken: $('setupToken').value, loginId: $('setupLogin').value, name: $('setupName').value, password: $('setupPassword').value });
    $('setupCard').hidden = true;
    $('loginId').value = $('setupLogin').value;
    $('setupToken').value = $('setupPassword').value = '';
    toast('管理者を作成しました。ログインしてください');
  } catch (e) {
    $('setupError').textContent = e.message;
  }
};
async function start() {
  try {
    const me = await get('/api/admin/me');
    $('whoName').textContent = me.admin.name + ' さん';
    $('envBadge').textContent = me.environment === 'production' ? '' : `${me.environment} 環境`;
    $('loginView').hidden = true;
    $('appView').hidden = false;
    $('logoutBtn').hidden = false;
    appConfig = await get('/api/config').catch(() => appConfig);
    $('pinMissing').hidden = appConfig.authMode !== 'pin';
    $('resetCard').hidden = false;
    await loadStaffOptions();
    openTab('corrections');
  } catch {
    showLogin();
  }
}
$('loginBtn').onclick = async () => {
  $('loginError').textContent = '';
  try {
    await post('/api/admin/login', { loginId: $('loginId').value, password: $('password').value });
    $('password').value = '';
    await start();
  } catch (e) {
    $('loginError').textContent = e.message;
  }
};
$('password').addEventListener('keydown', e => e.key === 'Enter' && $('loginBtn').click());
$('logoutBtn').onclick = async () => {
  await post('/api/admin/logout').catch(() => {});
  showLogin();
};

// ---------- タブ ----------
const loaders = {};
function openTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => (s.hidden = s.id !== 'tab-' + name));
  loaders[name] && loaders[name]().catch(e => toast(e.message));
}
document.querySelectorAll('#tabs button').forEach(b => (b.onclick = () => openTab(b.dataset.tab)));

let staffCache = [];
let appConfig = { authMode: 'pin', backups: false };
async function loadStaffOptions() {
  staffCache = (await get('/api/admin/staff')).staff;
  for (const id of ['perStaff', 'recStaff']) {
    const sel = $(id);
    const cur = sel.value;
    sel.replaceChildren(...staffCache.map(s => h('option', { value: s.id }, `${s.grade}年 ${s.name}${s.nick ? '（' + s.nick + '）' : ''}${s.active ? '' : '［無効］'}`)));
    if (cur) sel.value = cur;
  }
}

// ---------- 修正申請 ----------
const FIELDS = [
  ['date', '勤務日'],
  ['start', '出勤'],
  ['end', '退勤'],
  ['breakMin', '休憩(分)'],
  ['task', '業務内容'],
  ['allowance', '手当(円)'],
  ['hours', '勤務時間'],
];
loaders.corrections = async () => {
  const status = $('corrStatus').value;
  const { requests } = await get('/api/admin/corrections?status=' + encodeURIComponent(status));
  if (status === '申請中') $('pendingCount').textContent = requests.length || '';
  const list = $('corrList');
  if (!requests.length) {
    list.replaceChildren(h('div', { class: 'card note', text: status === '申請中' ? '審査待ちの申請はありません。' : '該当する申請はありません。' }));
    return;
  }
  list.replaceChildren(
    ...requests.map(r => {
      const b = r.before || {};
      const a = r.after || {};
      const isDelete = r.kind === '削除';
      const diff = h('div', { class: 'diff' }, h('b', {}, '項目'), h('b', {}, isDelete ? '削除する記録' : '変更前'), h('b', {}, isDelete ? '' : '変更後（申請）'));
      for (const [k, label] of FIELDS) {
        const changed = isDelete || String(b[k] ?? '') !== String(a[k] ?? '');
        diff.append(h('span', {}, label), h('span', { class: changed ? 'changed' : '' }, String(b[k] ?? '')), h('span', { class: changed && !isDelete ? 'changed' : '' }, isDelete ? '' : String(a[k] ?? '')));
      }
      const tagClass = r.status === '申請中' ? 'pending' : r.status === '承認' ? 'done' : 'rej';
      const card = h(
        'div',
        { class: 'req' },
        h('div', { class: 'head' }, h('div', {}, h('span', { class: 'tag ' + (isDelete ? 'rej' : 'pending') }, isDelete ? '削除申請' : '修正申請'), ' ', h('b', {}, r.name), ` (${r.staffId})　申請日時：${fmtDT(r.requestedAt)}`), h('span', { class: 'tag ' + tagClass }, r.status)),
        diff,
        h('div', {}, h('b', {}, isDelete ? '削除の理由：' : '修正理由：'), r.reason),
        r.status !== '申請中' ? h('div', { class: 'note' }, `処理：${fmtDT(r.processedAt)}　${r.processedBy || ''}　メモ：${r.memo || 'なし'}`) : null
      );
      if (r.status === '申請中') {
        card.append(
          h(
            'div',
            { class: 'bar', style: 'margin:10px 0 0' },
            h('button', { type: 'button', class: 'primary', onclick: () => decide(r, 'approve') }, isDelete ? '承認して記録を削除' : '承認して記録を変更'),
            h('button', { type: 'button', class: 'danger', onclick: () => decide(r, 'reject') }, '却下')
          )
        );
      }
      return card;
    })
  );
};
function decide(r, action) {
  const approve = action === 'approve';
  form(
    approve ? '修正申請を承認' : '修正申請を却下',
    [
      { type: 'info', text: approve ? (r.kind === '削除' ? `${r.name} さんの ${r.before?.date} ${r.before?.start}〜${r.before?.end} の記録を削除します。削除前の内容は操作履歴に残ります。` : `${r.name} さんの ${r.before?.date} の記録を、申請どおりに変更します。`) : '記録は変更されません。' },
      { name: 'memo', label: '管理者メモ（任意）', type: 'textarea' },
    ],
    async v => {
      await post(`/api/admin/corrections/${encodeURIComponent(r.id)}/${action}`, { memo: v.memo });
      toast(approve ? '承認しました' : '却下しました');
      await loaders.corrections();
    },
    approve ? '承認する' : '却下する'
  );
}
$('corrStatus').onchange = () => loaders.corrections().catch(e => toast(e.message));
$('corrReload').onclick = () => loaders.corrections().catch(e => toast(e.message));

// ---------- 月別集計 ----------
loaders.summary = async () => {
  if (!$('sumMonth').value) $('sumMonth').value = thisMonth();
  const m = $('sumMonth').value;
  $('sumCsv').href = '/api/admin/summary.csv?month=' + encodeURIComponent(m);
  const { rows } = await get('/api/admin/summary?month=' + encodeURIComponent(m));
  const t = { days: 0, hours: 0, breakMin: 0, allowance: 0 };
  rows.forEach(r => {
    t.days += r.days;
    t.hours += r.hours;
    t.breakMin += r.breakMin;
    t.allowance += r.allowance;
  });
  $('sumTable').replaceChildren(
    h('thead', {}, h('tr', {}, ['対象月', 'スタッフID', '氏名', 'ニックネーム', '学年', '勤務日数', '合計勤務時間(時間)', '合計休憩(分)', '合計手当(円)'].map(x => h('th', {}, x)))),
    h('tbody', {}, rows.map(r => h('tr', {}, h('td', { class: 'c' }, r.month), h('td', { class: 'c' }, r.staffId), h('td', {}, r.name), h('td', {}, r.nick), h('td', { class: 'c' }, r.grade), h('td', { class: 'c' }, r.days), h('td', { class: 'num' }, hrs(r.hours)), h('td', { class: 'num' }, r.breakMin), h('td', { class: 'num' }, yen(r.allowance))))),
    h('tfoot', {}, h('tr', {}, h('td', { colspan: 5 }, `合計（${rows.length}名）`), h('td', { class: 'c' }, t.days), h('td', { class: 'num' }, hrs(t.hours)), h('td', { class: 'num' }, t.breakMin), h('td', { class: 'num' }, yen(t.allowance))))
  );
};
$('sumMonth').onchange = () => loaders.summary();
$('sumPrev').onclick = () => {
  $('sumMonth').value = shiftMonth($('sumMonth').value || thisMonth(), -1);
  loaders.summary();
};
$('sumNext').onclick = () => {
  $('sumMonth').value = shiftMonth($('sumMonth').value || thisMonth(), 1);
  loaders.summary();
};

// ---------- 個人別勤怠申請書 ----------
loaders.personal = async () => {
  if (!$('perMonth').value) $('perMonth').value = thisMonth();
  const sid = $('perStaff').value;
  if (!sid) return;
  const d = await get(`/api/admin/personal?staffId=${encodeURIComponent(sid)}&month=${encodeURIComponent($('perMonth').value)}`);
  const [y, m] = d.month.split('-');
  const rows = d.days.map(x =>
    h(
      'tr',
      { class: x.day % 2 === 0 ? 'even' : '' },
      h('td', { class: 'cc' }, x.day),
      h('td', { class: 'cc' }, x.weekday),
      h('td', { class: 't' }, x.tasks.join('\n')),
      h('td', { class: 'cc' }, x.starts.join('\n')),
      h('td', { class: 'cc' }, x.ends.join('\n')),
      h('td', { class: 'n' }, x.records.length ? x.breakMin : ''),
      h('td', { class: 'n' }, x.records.length ? hrs(x.hours) : ''),
      h('td', { class: 'n' }, x.records.length ? yen(x.allowance) : '')
    )
  );
  $('perSheet').replaceChildren(
    h('div', { class: 'title' }, h('div', { class: 'ym' }, `${y} 年 `, h('b', {}, `${m} 月`)), h('span'), h('h1', {}, '勤 怠 申 請 書')),
    h('div', { class: 'info' }, h('div', {}, `学年：${d.staff.grade}年`), h('div', {}, `氏名：${d.staff.name}（${d.staff.nick}）`), h('div', {}, '所属：N-PAS')),
    h('div', { class: 'sub' }, `勤怠データと自動連動（個人ID ${d.staff.id}）`),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', { rowspan: 2 }, '日'), h('th', { rowspan: 2 }, '曜日'), h('th', { rowspan: 2 }, '業務内容'), h('th', { colspan: 3 }, '勤務時間'), h('th', { rowspan: 2 }, '時間数'), h('th', { rowspan: 2 }, '手当（円）')), h('tr', {}, h('th', {}, '出勤'), h('th', {}, '退勤'), h('th', {}, '休憩'))),
      h('tbody', {}, rows, h('tr', {}, h('td', { colspan: 2, class: 'cc' }, 'その他手当'), h('td', { colspan: 6, class: 'note' }, '備考・追加手当は元の勤怠データで管理してください。')))
    ),
    h('div', { class: 'totals' }, h('div', { style: 'border:0' }), h('div', { class: 'h' }, '勤務時間合計'), h('div', { class: 'h' }, '手当合計'), h('div', { style: 'border:0' }), h('div', { class: 'v' }, hrs(d.totals.hours)), h('div', { class: 'v' }, yen(d.totals.allowance)))
  );
};
$('perStaff').onchange = () => loaders.personal();
$('perMonth').onchange = () => loaders.personal();
$('perPrev').onclick = () => {
  $('perMonth').value = shiftMonth($('perMonth').value || thisMonth(), -1);
  loaders.personal();
};
$('perNext').onclick = () => {
  $('perMonth').value = shiftMonth($('perMonth').value || thisMonth(), 1);
  loaders.personal();
};
$('perPrint').onclick = () => window.print();

// ---------- 勤怠記録 ----------
const recFields = e => [
  { name: 'date', label: '勤務日', type: 'date', value: e?.date },
  { name: 'start', label: '出勤', type: 'time', value: e?.start || '10:00' },
  { name: 'end', label: '退勤', type: 'time', value: e?.end || '15:00' },
  { name: 'breakMin', label: '休憩（分）', type: 'number', min: 0, maxNum: 1439, value: e?.breakMin ?? 0 },
  { name: 'task', label: '業務内容', type: 'textarea', max: 200, value: e?.task || '' },
  { name: 'allowance', label: '手当（円・任意）', type: 'number', min: 0, value: e?.allowance ?? '' },
  { name: 'reason', label: '理由（必須・操作履歴に残ります）', type: 'textarea' },
];
loaders.records = async () => {
  if (!$('recMonth').value) $('recMonth').value = thisMonth();
  const sid = $('recStaff').value;
  if (!sid) return;
  const { entries } = await get(`/api/admin/records?staffId=${encodeURIComponent(sid)}&month=${encodeURIComponent($('recMonth').value)}`);
  $('recTable').replaceChildren(
    h('thead', {}, h('tr', {}, ['勤務日', '出勤', '退勤', '休憩(分)', '業務内容', '手当(円)', '勤務時間', '登録方法', '記録ID', ''].map(x => h('th', {}, x)))),
    h(
      'tbody',
      {},
      entries.length
        ? entries.map(e =>
            h(
              'tr',
              {},
              h('td', { class: 'c' }, e.date),
              h('td', { class: 'c' }, e.start),
              h('td', { class: 'c' }, e.end),
              h('td', { class: 'num' }, e.breakMin),
              h('td', {}, e.task),
              h('td', { class: 'num' }, yen(e.allowance)),
              h('td', { class: 'num' }, hrs(e.hours)),
              h('td', { class: 'c' }, e.method),
              h('td', { class: 'note' }, e.id),
              h(
                'td',
                { class: 'c' },
                h('button', { type: 'button', onclick: () => editRecord(e) }, '修正'),
                ' ',
                h('button', { type: 'button', class: 'danger', onclick: () => deleteRecord(e) }, '削除')
              )
            )
          )
        : h('tr', {}, h('td', { colspan: 10, class: 'note' }, 'この月の記録はありません'))
    )
  );
};
function editRecord(e) {
  form('勤怠記録の修正', recFields(e), async v => {
    await post(`/api/admin/records/${encodeURIComponent(e.id)}/update`, v);
    toast('修正しました');
    await loaders.records();
  });
}
function deleteRecord(e) {
  form('勤怠記録の削除', [{ type: 'info', text: `${e.date} ${e.start}〜${e.end} の記録を削除します。削除前の内容は操作履歴に残ります。` }, { name: 'reason', label: '理由（必須）', type: 'textarea' }], async v => {
    await post(`/api/admin/records/${encodeURIComponent(e.id)}/delete`, v);
    toast('削除しました');
    await loaders.records();
  }, '削除する');
}
$('recLoad').onclick = () => loaders.records().catch(e => toast(e.message));
$('recStaff').onchange = () => loaders.records().catch(e => toast(e.message));
$('recMonth').onchange = () => loaders.records().catch(e => toast(e.message));
$('recAdd').onclick = () => {
  const s = staffCache.find(x => x.id === $('recStaff').value);
  if (!s) return toast('スタッフを選んでください');
  form(`勤怠記録の追加：${s.name}`, recFields({ date: $('recMonth').value + '-01' }), async v => {
    await post('/api/admin/records', { staffId: s.id, ...v });
    toast('追加しました');
    await loaders.records();
  });
};

// ---------- スタッフ・PIN ----------
loaders.staff = async () => {
  await loadStaffOptions();
  loadAdmins().catch(e => toast(e.message));
  $('staffTable').replaceChildren(
    h('thead', {}, h('tr', {}, ['スタッフID', '氏名', 'ニックネーム', '学年', '有効', ...(pinMode() ? ['PIN'] : []), '状態', ''].map(x => h('th', {}, x)))),
    h(
      'tbody',
      {},
      staffCache.map(s =>
        h(
          'tr',
          {},
          h('td', { class: 'c' }, s.id),
          h('td', {}, s.name),
          h('td', {}, s.nick),
          h('td', { class: 'c' }, s.grade),
          h('td', { class: 'c' }, s.active ? '有効' : '無効'),
          pinMode() ? h('td', { class: 'c' }, s.hasPin ? '設定済み' : h('span', { class: 'warn' }, '未設定')) : null,
          h('td', {}, s.locked ? h('span', { class: 'error' }, 'ロック中 ') : null, s.clockedIn ? `出勤中（${fmtDT(s.clockStartedAt)}〜）` : ''),
          h(
            'td',
            { class: 'c' },
            h('button', { type: 'button', onclick: () => editStaff(s) }, '編集'),
            ' ',
            pinMode() ? h('button', { type: 'button', onclick: () => issuePin(s) }, s.hasPin ? 'PIN再発行' : 'PIN発行') : null,
            s.locked ? h('button', { type: 'button', onclick: () => act(`/api/admin/staff/${s.id}/unlock`, 'ロックを解除しました') }, 'ロック解除') : null,
            s.clockedIn ? h('button', { type: 'button', class: 'danger', onclick: () => cancelClock(s) }, '出勤を取消') : null
          )
        )
      )
    )
  );
};
const pinMode = () => appConfig.authMode === 'pin';
async function act(path, msg) {
  try {
    await post(path);
    toast(msg);
    await loaders.staff();
  } catch (e) {
    toast(e.message);
  }
}
function staffFields(s) {
  return [
    { name: 'name', label: '氏名', value: s?.name },
    { name: 'nick', label: 'ニックネーム', value: s?.nick },
    { name: 'grade', label: '学年', type: 'select', value: s?.grade || '1', options: [1, 2, 3, 4, 5, 6].map(n => [String(n), n + '年']) },
    { name: 'active', label: '有効（オフにするとログイン画面に表示されません）', type: 'checkbox', value: s ? s.active : true },
  ];
}
function editStaff(s) {
  form(`スタッフの編集（${s.id}）`, staffFields(s), async v => {
    await post('/api/admin/staff', { id: s.id, ...v });
    toast('保存しました');
    await loaders.staff();
  });
}
$('staffAdd').onclick = () =>
  form('スタッフの追加', staffFields(null), async v => {
    const r = await post('/api/admin/staff', v);
    toast(`追加しました（${r.id}）。PINを発行してください`);
    await loaders.staff();
  });
function showPins(list) {
  if (!list.length) return;
  const box = h(
    'div',
    { class: 'pinlist' },
    h('b', {}, '発行したPIN（この画面を閉じると二度と表示されません。本人に個別に伝えてください）'),
    h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['スタッフID', '氏名', 'ニックネーム', 'PIN'].map(x => h('th', {}, x)))), h('tbody', {}, list.map(p => h('tr', {}, h('td', { class: 'c' }, p.id), h('td', {}, p.name), h('td', {}, p.nick), h('td', { class: 'c', style: 'font-size:18px;letter-spacing:.2em' }, p.pin))))),
    h('button', { type: 'button', onclick: () => box.remove() }, '確認したので閉じる')
  );
  $('pinResult').prepend(box);
}
function issuePin(s) {
  form(`${s.hasPin ? 'PINの再発行' : 'PINの発行'}：${s.name}`, [{ type: 'info', text: '新しい6桁のPINを発行します。今のPINは使えなくなり、ログイン中の端末もログアウトされます。' }], async () => {
    const r = await post(`/api/admin/staff/${encodeURIComponent(s.id)}/pin`);
    showPins([r]);
    await loaders.staff();
  }, '発行する');
}
$('pinMissing').onclick = () =>
  form('PINのまとめて発行', [{ type: 'info', text: 'PINが未設定の有効スタッフ全員に、6桁のPINを発行します。' }], async () => {
    const all = [];
    for (let i = 0; i < 100; i++) {
      const r = await post('/api/admin/pins/issue-missing', { limit: 2 });
      all.push(...r.issued);
      toast(`発行中… ${all.length}名`);
      if (!r.remaining || !r.issued.length) break;
    }
    showPins(all);
    toast(all.length ? `${all.length}名にPINを発行しました` : 'PIN未設定のスタッフはいません');
    await loaders.staff();
  }, '発行する');
function cancelClock(s) {
  form(`出勤状態の取消：${s.name}`, [{ type: 'info', text: `${fmtDT(s.clockStartedAt)} からの出勤中の状態を取り消します（勤怠記録は作られません）。必要なら「勤怠記録」から正しい記録を追加してください。` }], async () => {
    await post(`/api/admin/staff/${encodeURIComponent(s.id)}/cancel-clock`);
    toast('取り消しました');
    await loaders.staff();
  }, '取り消す');
}

async function loadAdmins() {
  const { admins } = await get('/api/admin/admins');
  $('adminList').textContent = admins.map(a => `${a.name}（${a.loginId}）`).join('、') || '（テスト用管理者のみ）';
}
$('adminAdd').onclick = () =>
  form('管理者の追加', [{ name: 'loginId', label: 'ログインID（半角英数字）' }, { name: 'name', label: '名前' }, { name: 'password', label: 'パスワード（10文字以上）', type: 'password' }], async v => {
    await post('/api/admin/admins', v);
    toast('管理者を追加しました');
    await loadAdmins();
  });
$('pwChange').onclick = () =>
  form('パスワードの変更', [{ name: 'current', label: '今のパスワード', type: 'password' }, { name: 'password', label: '新しいパスワード（10文字以上）', type: 'password' }], async v => {
    await post('/api/admin/password', v);
    toast('パスワードを変更しました');
  });

// ---------- 操作履歴 ----------
let auditLast = null;
function auditRows(logs) {
  return logs.map(l => h('tr', {}, h('td', { class: 'c' }, fmtDT(l.at)), h('td', {}, l.action), h('td', {}, l.operator), h('td', { class: 'note' }, l.recordId), h('td', {}, h('pre', { class: 'json' }, l.before)), h('td', {}, h('pre', { class: 'json' }, l.after))));
}
loaders.audit = async () => {
  const { logs } = await get('/api/admin/audit?limit=100');
  auditLast = logs.length ? logs[logs.length - 1].id : null;
  $('auditTable').replaceChildren(h('thead', {}, h('tr', {}, ['日時', '操作', '操作者', '記録ID', '変更前(JSON)', '変更後(JSON)'].map(x => h('th', {}, x)))), h('tbody', { id: 'auditBody' }, auditRows(logs)));
  $('auditMore').hidden = logs.length < 100;
};
$('auditMore').onclick = async () => {
  if (!auditLast) return;
  const { logs } = await get('/api/admin/audit?limit=100&beforeId=' + auditLast);
  if (logs.length) auditLast = logs[logs.length - 1].id;
  $('auditBody').append(...auditRows(logs));
  $('auditMore').hidden = logs.length < 100;
};

// ---------- データ移行 ----------
let migSheets = null;
$('migFiles').onchange = async () => {
  migSheets = null;
  ['migDry', 'migImport', 'migVerify'].forEach(id => ($(id).disabled = true));
  $('migReport').replaceChildren();
  const files = [...$('migFiles').files];
  const sheets = {};
  const msgs = [];
  try {
    for (const f of files) {
      const text = await f.text();
      if (/\.json$/i.test(f.name) || text.trim().startsWith('{')) {
        Object.assign(sheets, parseExportJson(text));
        msgs.push(`${f.name}：書き出しファイル`);
      } else {
        const rows = parseCsv(text);
        const name = detectSheet(rows);
        if (!name) throw new Error(`${f.name}：どのシートのCSVか判定できません（1行目の見出しを確認してください）`);
        sheets[name] = rows;
        msgs.push(`${f.name}：${name}（CSV）`);
      }
    }
    migSheets = sheets;
    const counts = Object.entries(sheets).map(([k, v]) => `${k} ${v.length}件`).join('、');
    $('migLoaded').textContent = `${msgs.join(' / ')}　→　${counts}`;
    ['migDry', 'migImport', 'migVerify'].forEach(id => ($(id).disabled = false));
  } catch (e) {
    $('migLoaded').textContent = '読み込みエラー：' + e.message;
  }
};
const LABEL = { 'dry-run': '確認のみ', import: '取り込み', verify: '照合' };
async function migrate(mode) {
  if (!migSheets) return;
  if (mode === 'import' && !confirmImport()) return;
  ['migDry', 'migImport', 'migVerify'].forEach(id => ($(id).disabled = true));
  $('migReport').replaceChildren();
  try {
    const report = await runMigration((p, b) => post(p, b), migSheets, mode, s => ($('migProgress').textContent = '処理中… ' + s));
    const saved = await post('/api/admin/migrate/report', { mode, report: { ...report, tables: Object.fromEntries(Object.entries(report.tables).map(([k, t]) => [k, { ...t, issues: t.issues.slice(0, 300) }])) } });
    $('migProgress').textContent = `${LABEL[mode]}が終わりました。`;
    renderReport(report, saved.dbCounts);
    await loadRuns();
  } catch (e) {
    $('migProgress').textContent = 'エラー：' + e.message;
  } finally {
    if (mode === 'import') confirmed = false;
    ['migDry', 'migImport', 'migVerify'].forEach(id => ($(id).disabled = false));
  }
}
let confirmed = false;
function confirmImport() {
  if (confirmed) return true;
  form('データを取り込みます', [{ type: 'info', text: '新しいシステムのデータベースに書き込みます。元のスプレッドシートは変更されません。同じIDのデータは上書きしません。' }], async () => {
    confirmed = true;
    setTimeout(() => migrate('import'), 0);
  }, '取り込む');
  return false;
}
function renderReport(rep, dbCounts) {
  const head = ['シート', '移行元', '正常', 'エラー', '警告', rep.mode === 'verify' ? '一致' : '新規', rep.mode === 'import' ? '取り込み' : rep.mode === 'verify' ? '移行先になし' : '既にあり(一致)', '内容の違い', '件数の照合'];
  const rows = Object.values(rep.tables).map(t =>
    h(
      'tr',
      {},
      h('td', {}, t.sheet),
      h('td', { class: 'num' }, t.source),
      h('td', { class: 'num' }, t.valid),
      h('td', { class: 'num' + (t.errors ? ' error' : '') }, t.errors),
      h('td', { class: 'num' }, t.warnings),
      h('td', { class: 'num' }, rep.mode === 'verify' ? t.identical : t.newRows),
      h('td', { class: 'num' }, rep.mode === 'import' ? `${t.inserted}（一致 ${t.identical}）` : rep.mode === 'verify' ? t.missing : t.identical),
      h('td', { class: 'num' + (t.conflicts ? ' error' : '') }, t.conflicts),
      h('td', { class: 'c' }, t.countCheck ? '✅' : '❌')
    )
  );
  const issues = Object.values(rep.tables).flatMap(t => t.issues.map(i => ({ ...i, sheet: t.sheet })));
  $('migReport').replaceChildren(
    ...[
    h('p', { class: rep.ok ? 'ok' : 'error' }, rep.ok ? `✅ ${LABEL[rep.mode]}：問題はありませんでした。` : `⚠️ ${LABEL[rep.mode]}：確認が必要な行があります（下の一覧）。`),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, head.map(x => h('th', {}, x)))), h('tbody', {}, rows))),
    dbCounts ? h('p', { class: 'note' }, `移行先の件数：スタッフ ${dbCounts.staff} / 勤怠 ${dbCounts.attendance} / 修正申請 ${dbCounts.corrections} / 移行した修正履歴 ${dbCounts.auditMigrated}`) : null,
    issues.length
      ? h('div', { class: 'scroll' }, h('table', { class: 'grid small' }, h('thead', {}, h('tr', {}, ['シート', '行', 'ID', '種類', '内容'].map(x => h('th', {}, x)))), h('tbody', {}, issues.slice(0, 500).map(i => h('tr', {}, h('td', {}, i.sheet), h('td', { class: 'c' }, i.row ?? ''), h('td', {}, i.id || ''), h('td', { class: 'c' }, { error: 'エラー', warning: '警告', conflict: '内容の違い', missing: '移行先になし' }[i.level] || i.level), h('td', {}, i.message))))))
      : null,
    ].filter(Boolean)
  );
}
async function loadRuns() {
  const { runs } = await get('/api/admin/migrate/reports');
  $('migRuns').replaceChildren(
    runs.length
      ? h('table', { class: 'grid small' }, h('thead', {}, h('tr', {}, ['日時', '実行者', '種類', '結果', '移行先の件数'].map(x => h('th', {}, x)))), h('tbody', {}, runs.map(r => h('tr', {}, h('td', {}, fmtDT(r.at)), h('td', {}, r.operator), h('td', {}, LABEL[r.mode] || r.mode), h('td', {}, r.report.ok ? '✅ 問題なし' : '⚠️ 要確認'), h('td', {}, r.report.dbCounts ? `スタッフ ${r.report.dbCounts.staff} / 勤怠 ${r.report.dbCounts.attendance}` : '')))))
      : h('p', { class: 'note' }, 'まだ実行していません。')
  );
}
$('migDry').onclick = () => migrate('dry-run');
$('migImport').onclick = () => migrate('import');
$('migVerify').onclick = () => migrate('verify');
loaders.data = async () => {
  await loadRuns();
  const pv = await get('/api/admin/reset-history');
  const c = pv.counts;
  $('resetCounts').textContent = `現在の件数：勤怠記録 ${c.attendance}件・申請 ${c.requests}件・操作履歴 ${c.audit}件・出勤中 ${c.clockedIn}人`;
  await loadBackups();
};
async function loadBackups() {
  const r = await get('/api/admin/backups');
  $('backupNow').hidden = !r.supported;
  if (!r.supported) {
    $('backupList').textContent = 'この環境では、Cloudflare D1 の Time Travel（自動の復元機能）を使います（README 7章）。';
    return;
  }
  $('backupList').replaceChildren(
    r.backups.length
      ? h(
          'table',
          { class: 'grid small' },
          h('thead', {}, h('tr', {}, ['名前', '日時', '大きさ', ''].map(x => h('th', {}, x)))),
          h(
            'tbody',
            {},
            r.backups.map(b =>
              h(
                'tr',
                {},
                h('td', {}, b.name),
                h('td', {}, fmtDT(b.uploadedAt)),
                h('td', { class: 'num' }, Math.ceil(b.size / 1024) + ' KB'),
                h(
                  'td',
                  { class: 'c' },
                  h('a', { class: 'button', href: '/api/admin/backups/download?name=' + encodeURIComponent(b.name) }, 'ダウンロード'),
                  ' ',
                  h('button', { type: 'button', class: 'danger', onclick: () => restore(b.name) }, 'この状態に戻す')
                )
              )
            )
          )
        )
      : 'まだありません。'
  );
}
function restore(name) {
  form(
    'バックアップから元に戻す',
    [
      { type: 'info', text: `「${name}」の時点の状態に戻します。それ以降の記録は消えます（戻す前の状態も自動でバックアップします）。` },
      { name: 'confirm', label: '確認のため「復元」と入力' },
    ],
    async v => {
      const r = await post('/api/admin/backups/restore', { name, confirm: v.confirm });
      toast(r.message);
      await loaders.data();
    },
    '元に戻す'
  );
}
$('backupNow').onclick = async () => {
  try {
    const r = await post('/api/admin/backups');
    toast(`バックアップしました（${r.backup.name}）`);
    await loadBackups();
  } catch (e) {
    toast(e.message);
  }
};
$('resetBtn').onclick = async () => {
  $('resetResult').textContent = '';
  $('resetBtn').disabled = true;
  try {
    const r = await post('/api/admin/reset-history', { confirm: $('resetConfirm').value.trim() });
    $('resetConfirm').value = '';
    $('resetResult').textContent = r.message;
    $('resetResult').className = 'ok';
    await loaders.data();
  } catch (e) {
    $('resetResult').textContent = e.message;
    $('resetResult').className = 'error';
  } finally {
    $('resetBtn').disabled = false;
  }
};
$('backupBtn').onclick = async () => {
  $('backupBtn').disabled = true;
  try {
    const data = await downloadBackup(get, s => ($('backupProgress').textContent = '取得中… ' + s));
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `npas-backup-${data.exportedAt.replace(/[-:]/g, '').slice(0, 15)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    const n = Object.entries(data.sheets).map(([k, v]) => `${k} ${v.length}件`).join('、');
    $('backupProgress').textContent = `保存しました（${n}）`;
  } catch (e) {
    $('backupProgress').textContent = 'エラー：' + e.message;
  } finally {
    $('backupBtn').disabled = false;
  }
};

start();
