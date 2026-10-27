let staff=[],selected=null,month=new Date();const $=id=>document.getElementById(id);const iso=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');const call=(name,...args)=>window.npasApi(name,args);function toast(s){$('toast').textContent=s;$('toast').style.display='block';setTimeout(()=>$('toast').style.display='none',3500)}function show(id){if(id==='home')updateLoggedInName();document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id));window.scrollTo(0,0);if(id==='home')loadStatus();if(id==='history')loadHistory();if(id==='corrections')openCorrections();if(id==='bulkRequest')npasOpenBulkRequest()}function busy(id,flag){$(id).disabled=flag}function updatePeople(){const grade=$('grade').value;const list=staff.filter(s=>String(s.grade)===grade);$('person').innerHTML='<option value="">名前を選択</option>'+list.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');$('person').disabled=!grade||!list.length;updateNick()}function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function updateNick(){const s=staff.find(x=>x.id===$('person').value);$('nickname').textContent='ニックネーム：'+(s?.nick||'―')}function safeStore(k,v){try{localStorage.setItem(k,v)}catch(e){}}function safeRead(k){try{return localStorage.getItem(k)}catch(e){return null}}function safeRemove(k){try{localStorage.removeItem(k)}catch(e){}}function updateLoggedInName(){if(!selected)return;$('loggedInName').textContent=selected.nick||selected.name;$('loggedInFullName').textContent=selected.name+' ・ '+selected.grade+'年'}async function login(){const u=staff.find(s=>s.id===$('person').value);if(!u){toast('名前を選択してね');return}const pin=$('pin').value.trim();if(npasPinMode&&!/^\d{4,6}$/.test(pin)){toast('PIN（4〜6桁の数字）を入力してね');return}busy('loginBtn',true);try{await call('login',u.id,pin);selected=u;$('pin').value='';show('home')}catch(e){toast(e.message)}finally{busy('loginBtn',false)}}function init(){const now=new Date();$('today').textContent='📅 '+now.toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short'});$('workDate').value=iso(now);$('bulkDate').value=iso(now);$('grade').addEventListener('change',()=>{updatePeople();if(!staff.length)npasLoadStaffWithRetry(0)});$('person').addEventListener('change',updateNick);$('loginBtn').addEventListener('click',login);$('pin').addEventListener('keydown',e=>{if(e.key==='Enter')login()});document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.go)));$('menuBtn').addEventListener('click',switchStaff);$('switchPerson').addEventListener('click',switchStaff);$('task').oninput=()=>$('taskCount').textContent=$('task').value.length;$('allowanceToggle').onclick=()=>$('allowanceArea').classList.toggle('open');$('clockIn').onclick=clockIn;$('clockOut').onclick=openCheckout;$('confirmCheckout').onclick=confirmCheckout;$('submit').onclick=submit;$('prevMonth').onclick=()=>changeMonth(-1);$('nextMonth').onclick=()=>changeMonth(1);$('monthMode').onclick=()=>toggleMode(true);$('listMode').onclick=()=>toggleMode(false);$('loadCorrections').onclick=loadCorrectionHistory;$('sendCorrection').onclick=sendCorrection;$('npasBulkConfirmCancel').onclick=()=>{$('npasBulkConfirm').style.display='none'};$('bulkSelectAll').onclick=()=>npasBulkSetAll(true);$('bulkClear').onclick=()=>npasBulkSetAll(false);$('bulkPeople').addEventListener('change',npasBulkCount);$('grade').disabled=true;$('person').disabled=true;$('person').innerHTML='<option value="">名簿を読み込み中…</option>';npasLoadStaffWithRetry(0)}// 名簿の取得前に学年を選んだ場合や一時的な通信エラーでも、候補を復元する。
// ログイン方式（名前だけ／名前＋PIN）はサーバーの設定に合わせる。PIN方式のときだけPIN欄を表示。
let npasPinMode=false;
call('config').then(c=>{npasPinMode=c.authMode==='pin';$('pinGroup').hidden=!npasPinMode}).catch(()=>{});
function npasLoadStaffWithRetry(attempt){
  call('listStaff').then(data=>{
    if(!Array.isArray(data)||!data.length)throw Error('名簿が空です');
    staff=data;
    $('grade').disabled=false;
    updatePeople(); // 現在選択中の学年から候補を必ず再描画
  }).catch(e=>{
    if(attempt<2){
      setTimeout(()=>npasLoadStaffWithRetry(attempt+1),1000*(attempt+1));
      return;
    }
    $('grade').disabled=false;
    $('person').innerHTML='<option value="">名簿の取得に失敗しました。学年を選び直してください</option>';
    toast('名簿取得エラー：'+e.message);
  });
}
function switchStaff(){call('logout').catch(()=>{});$('pin').value='';selected=null;$('grade').value='';updatePeople();show('login');toast('ログアウトしました')}async function loadStatus(){if(!selected)return;try{const s=await call('clockStatus',selected.id);$('statusText').textContent=s.active?'出勤中です！ 退勤時に「退勤」を押してね。':'まだ出勤していません。\n出勤ボタンを押して打刻してください！'}catch(e){toast(e.message)}}async function clockIn(){if(!selected)return;busy('clockIn',true);try{const r=await call('clockIn',selected.id);toast('出勤を記録したよ！ '+r.time);loadStatus()}catch(e){toast(e.message)}finally{busy('clockIn',false)}}async function openCheckout(){if(!selected){toast('スタッフを選択してね');return}show('checkout');$('checkoutMessage').textContent='';$('checkoutStarted').textContent='確認中…';try{const s=await call('clockStatus',selected.id);if(!s.active){$('checkoutMessage').textContent='まだ出勤していません。先に出勤打刻してください。';$('confirmCheckout').disabled=true;return}$('confirmCheckout').disabled=false;const d=new Date(s.startedAt);$('checkoutStarted').textContent=isNaN(d.getTime())?'出勤中':d.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',hour12:false})}catch(e){$('checkoutMessage').textContent='出勤状況を取得できません：'+e.message;$('confirmCheckout').disabled=true}}
function npasRefreshSummaryInBackground(staffId,workDate){
  // 成功通知は勤怠保存後すぐに表示。集計は直後に別通信で開始する。
  // 集計失敗はログへ残し、勤怠保存成功を取り消さない。
  if(!workDate)return;
  call('npasUpdateSummaryNow',staffId,workDate).then(r=>{
    if(!r||!r.ok)console.warn('N-PAS 月別集計の更新に失敗しました',r);
  }).catch(e=>console.error('N-PAS 月別集計の通信に失敗しました',e));
}
async function confirmCheckout(){if(!selected)return;const raw=$('checkoutBreak').value.trim();const br=Number(raw);if(raw===''||!Number.isInteger(br)||br<0||br>=1440){$('checkoutMessage').textContent='休憩時間は0以上の整数で入力してください';return}const btn=$('confirmCheckout');btn.disabled=true;btn.textContent='保存中…';$('checkoutMessage').textContent='';try{const saved=await call('clockOut',selected.id,br,$('checkoutTask').value,'');npasRefreshSummaryInBackground(selected.id,saved.workDate);$('checkoutTask').value='';$('checkoutBreak').value='0';show('home');toast('退勤を記録したよ！ おつかれさま！')}catch(e){$('checkoutMessage').textContent='退勤できませんでした：'+e.message;toast('退勤できませんでした')}finally{btn.disabled=false;btn.textContent='退勤を確定する →'}}
async function submit(){if(!selected)return;const data={date:$('workDate').value,start:$('start').value,end:$('end').value,breakMin:$('breakMin').value,task:$('task').value,allowance:$('allowance').value,method:'manual'};if(!data.date||!data.start||!data.end){toast('日付と時刻を入力してね');return}busy('submit',true);$('submit').textContent='保存中…';try{const saved=await call('saveAttendance',selected.id,data);npasRefreshSummaryInBackground(selected.id,saved.workDate||data.date);toast('申請完了！ おつかれさま！');$('task').value='';$('taskCount').textContent='0';show('home')}catch(e){toast(e.message)}finally{busy('submit',false);$('submit').textContent='➤ 申請する'}}function changeMonth(n){month=new Date(month.getFullYear(),month.getMonth()+n,1);loadHistory()}function toggleMode(monthly){$('monthMode').classList.toggle('on',monthly);$('listMode').classList.toggle('on',!monthly);$('monthText').parentElement.style.display=monthly?'flex':'none'}function fmt(min){min=Math.round(min);return Math.floor(min/60)+'時間 '+min%60+'分'}async function loadHistory(){if(!selected)return;const key=iso(month).slice(0,7);$('monthText').textContent=month.getFullYear()+'年 '+(month.getMonth()+1)+'月';$('entries').innerHTML='<div class="empty">読み込み中...</div>';try{const r=await call('getHistory',selected.id,key),entries=r.entries||[],mins=entries.reduce((a,e)=>a+Math.round(Number(e.hours||0)*60),0),breaks=entries.reduce((a,e)=>a+Number(e.breakMin||0),0),days=new Set(entries.map(e=>e.date)).size;$('totalHours').textContent=fmt(mins);$('days').textContent=days+'日';$('avg').textContent=days?fmt(mins/days):'0時間';$('breakTotal').textContent=fmt(breaks);$('entries').innerHTML=entries.length?entries.slice().reverse().map(e=>`<div class="entry"><b>${escapeHtml(String(e.date).slice(5))}</b><div>${escapeHtml(e.start)} - ${escapeHtml(e.end)}<small>${escapeHtml(e.task||'業務内容なし')}</small></div><b class="duration">${fmt(Number(e.hours||0)*60)}</b></div>`).join(''):'<div class="empty">この月の勤怠記録はまだありません 🌼</div>'}catch(e){$('entries').innerHTML='<div class="empty">読み込みに失敗しました</div>';toast(e.message)}}
let correctionRecords=[],correctionSelected=null;
function openCorrections(){if(!$('correctionMonth').value)$('correctionMonth').value=iso(new Date()).slice(0,7);$('correctionEditor').style.display='none';loadCorrectionHistory()}
async function loadCorrectionHistory(){if(!selected)return;const m=$('correctionMonth').value;$('correctionEntries').textContent='読み込み中…';$('correctionEditor').style.display='none';try{const result=await call('getHistory',selected.id,m);correctionRecords=result.entries||[];$('correctionEntries').innerHTML=correctionRecords.length?correctionRecords.slice().reverse().map(e=>'<button type="button" class="secondary correction-pick" data-id="'+escapeHtml(e.id)+'" style="width:100%;text-align:left;margin:4px 0;padding:13px">'+escapeHtml(e.date)+'　'+escapeHtml(e.start)+'〜'+escapeHtml(e.end)+'　'+fmt(Number(e.hours||0)*60)+'</button>').join(''):'<div class="empty">この月の記録はありません</div>';document.querySelectorAll('.correction-pick').forEach(b=>b.addEventListener('click',()=>chooseCorrection(b.dataset.id)))}catch(e){$('correctionEntries').textContent='読み込み失敗：'+e.message}}
function chooseCorrection(id){const e=correctionRecords.find(x=>x.id===id);if(!e)return;correctionSelected=e;$('fixDate').value=e.date;$('fixStart').value=e.start;$('fixEnd').value=e.end;$('fixBreak').value=e.breakMin;$('fixTask').value=e.task||'';$('fixAllowance').value=e.allowance;$('fixReason').value='';$('correctionTitle').textContent=e.date+' の修正';$('correctionMessage').textContent='';$('correctionEditor').style.display='block';$('correctionEditor').scrollIntoView({behavior:'smooth',block:'start'})}
async function sendCorrection(){if(!selected||!correctionSelected)return;const input={date:$('fixDate').value,start:$('fixStart').value,end:$('fixEnd').value,breakMin:$('fixBreak').value,task:$('fixTask').value,allowance:$('fixAllowance').value};const reason=$('fixReason').value.trim();if(!reason){$('correctionMessage').textContent='修正理由を入力してください';return}const btn=$('sendCorrection');btn.disabled=true;btn.textContent='申請中…';try{await call('npasSubmitCorrection',selected.id,correctionSelected.id,input,reason);$('correctionMessage').textContent='申請を受け付けました。管理者の承認をお待ちください。';toast('修正申請を送信しました');$('correctionEditor').style.display='none'}catch(e){$('correctionMessage').textContent=e.message}finally{btn.disabled=false;btn.textContent='管理者へ修正申請する'}}
document.addEventListener('DOMContentLoaded',init);
document.addEventListener('click',function(e){
  const target=e.target;
  const button=target && target.closest ? target.closest('#bulkSubmit') : null;
  if(button && !button.disabled){e.preventDefault();npasSubmitBulk();}
});

// 一括勤怠申請。既存の個別申請・打刻処理には触れない。
function npasOpenBulkRequest(){
  if(!selected)return;
  $('bulkOperator').textContent=selected.name;
  $('bulkResult').textContent='';
  const sorted=staff.slice().sort((a,b)=>String(a.grade).localeCompare(String(b.grade),'ja')||a.name.localeCompare(b.name,'ja'));
  const root=$('bulkPeople');root.replaceChildren();
  if(!sorted.length){root.textContent='スタッフ名簿が取得できていません。ログインし直してください。';return;}
  let grade='';
  sorted.forEach(u=>{
    if(String(u.grade)!==grade){grade=String(u.grade);const h=document.createElement('div');h.textContent=grade+'年生';h.style.cssText='font-weight:bold;color:#173e68;margin:12px 0 5px';root.appendChild(h)}
    const label=document.createElement('label');label.style.cssText='display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid #edf0f4;cursor:pointer';
    const cb=document.createElement('input');cb.type='checkbox';cb.className='npas-bulk-person';cb.value=u.id;cb.style.width='20px';cb.style.height='20px';
    const span=document.createElement('span');span.textContent=u.name+(u.nick?'（'+u.nick+'）':'');
    label.append(cb,span);root.appendChild(label);
  });
  npasBulkCount();
}
function npasBulkSelected(){return [...document.querySelectorAll('.npas-bulk-person:checked')].map(e=>e.value)}
function npasBulkCount(){$('bulkCount').textContent=npasBulkSelected().length+'名選択中'}
function npasBulkSetAll(on){document.querySelectorAll('.npas-bulk-person').forEach(e=>e.checked=on);npasBulkCount()}
async function npasSubmitBulk(){
  const report=(msg)=>{const el=$('bulkResult');if(el){el.textContent=msg;el.style.color='#ad2831';el.scrollIntoView({block:'nearest'});} };
  try {
  if(!selected){report('ログインしてください');return;}
  const ids=npasBulkSelected();
  const data={date:$('bulkDate').value,start:$('bulkStart').value,end:$('bulkEnd').value,
    breakMin:$('bulkBreak').value,task:$('bulkTask').value,allowance:$('bulkAllowance').value};
  if(!ids.length){report('対象スタッフを1名以上選択してください');return}
  if(!data.date||!data.start||!data.end){report('勤務日・出勤時刻・退勤時刻を入力してください');return}
  const br=Number(data.breakMin);
  if(data.breakMin===''||!Number.isInteger(br)||br<0||br>=1440){report('休憩時間を確認してください（0～1439分）');return}
  const names=ids.map(id=>staff.find(s=>s.id===id)?.name||id);
  const preview='代表者：'+selected.name+'\n勤務日：'+data.date+'\n時間：'+data.start+'〜'+data.end+
    '\n休憩：'+br+'分\n対象：'+ids.length+'名\n'+names.join('、')+
    '\n\n※勤務時間が重なる記録がある人はスキップします。\n\nこの内容で一括申請しますか？';
  // LINE内ブラウザでwindow.confirmが表示されない場合に備え、アプリ内の確認画面を使う。
  $('npasBulkConfirmText').textContent=preview.replace(/\n\nこの内容で一括申請しますか？$/, '');
  $('npasBulkConfirm').style.display='flex';
  $('bulkResult').textContent='確認画面を表示しました。';
  $('npasBulkConfirmOk').onclick=()=>{
    $('npasBulkConfirm').style.display='none';
    npasCommitBulk(ids,data);
  };
  return;
  } catch(e) {report('確認画面を開けませんでした：'+(e?.message||String(e)));console.error(e);}
}
async function npasCommitBulk(ids,data){
  const btn=$('bulkSubmit');btn.disabled=true;btn.textContent='保存中…';$('bulkResult').textContent='申請を保存しています…';
  try{
    const result=await call('npasSaveBulkAttendance',selected.id,ids,data);
    const saved=result.saved||[],skipped=result.skipped||[];
    let message='【一括申請結果】\n✅ 登録成功：'+saved.length+'名\n'+(saved.map(u=>'・'+u.name).join('\n')||'なし')+
      '\n\n⏭ 重複のためスキップ：'+skipped.length+'名\n'+(skipped.map(u=>'・'+u.name).join('\n')||'なし');
    if(result.auditWarning)message+='\n\n⚠️ '+result.auditWarning;
    $('bulkResult').textContent=message;
    toast(saved.length+'名の勤怠を登録しました！');
    if(saved.length){
      // 既存仕様と同様、保存完了後に集計を別通信で即時更新する（定期トリガーなし）。
      call('npasUpdateBulkSummaryNow',saved.map(u=>u.id),result.workDate||data.date)
        .then(r=>{if(!r?.ok){console.warn('N-PAS 一括申請の月別集計更新に失敗',r);$('bulkResult').textContent+='\n⚠️ 月別集計の一部更新に失敗しました。管理者に確認してください。'}})
        .catch(e=>{console.error(e);$('bulkResult').textContent+='\n⚠️ 月別集計の更新通信に失敗しました。管理者に確認してください。'});
    }
  }catch(e){$('bulkResult').textContent='申請に失敗しました：'+e.message;toast('一括申請エラー')}
  finally{btn.disabled=false;btn.textContent='申請内容を確認する →'}
}

// 勤怠記録の削除申請（管理者が承認すると記録が削除される）。理由は「修正理由」欄を使う。
async function npasSendDeletion(){if(!selected||!correctionSelected)return;const reason=$('fixReason').value.trim();if(!reason){$('correctionMessage').textContent='削除の理由を「修正理由」に入力してください';return}const btn=$('sendDeletion');btn.disabled=true;btn.textContent='申請中…';try{await call('npasSubmitDeletion',selected.id,correctionSelected.id,reason);$('correctionMessage').textContent='削除申請を受け付けました。管理者の承認をお待ちください。';toast('削除申請を送信しました');$('correctionEditor').style.display='none'}catch(e){$('correctionMessage').textContent=e.message}finally{btn.disabled=false;btn.textContent='この記録の削除を申請する'}}
document.addEventListener('DOMContentLoaded',()=>{$('sendDeletion').onclick=npasSendDeletion});
