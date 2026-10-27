// ブラウザから実行する動作確認テスト（テスト環境専用）
// 実際のサーバー・データベースに対して、テスト用スタッフで主な操作を順番に行い、結果を表示する。
import { runSteps } from './selftest-steps.js';
const $ = id => document.getElementById(id);

$('run').onclick = async () => {
  $('run').disabled = true;
  const box = $('steps');
  box.replaceChildren();
  let row = null;
  const results = await runSteps(fetch.bind(window), r => {
    if (r.running) {
      row = document.createElement('div');
      row.className = 'step';
      row.innerHTML = '<span>⏳</span><div><b></b><div class="msg"></div></div><span class="ms"></span>';
      row.querySelector('b').textContent = r.name;
      box.append(row);
      return;
    }
    row.firstChild.textContent = r.ok ? '✅' : '❌';
    row.querySelector('.msg').textContent = r.msg;
    if (!r.ok) row.querySelector('.msg').style.color = '#a52b30';
    if (r.ms != null) row.querySelector('.ms').textContent = r.ms + ' ms';
  });
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  const times = results.map(r => r.ms).filter(x => x != null).sort((a, b) => a - b);
  const med = times.length ? times[Math.floor(times.length / 2)] : 0;
  $('summary').textContent = `結果：成功 ${pass} 件 ／ 失敗 ${fail} 件　（応答時間の中央値 ${med} ms・最大 ${times[times.length - 1] || 0} ms／${new Date().toLocaleString('ja-JP')}）`;
  $('summary').className = fail ? 'error' : 'ok';
  $('run').disabled = false;
};
