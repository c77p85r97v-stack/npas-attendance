"""
旧 GAS 版の Index.html を、クラウド版の public/ に変換する（1回だけ実行したスクリプト。記録として残す）。

やること（見た目は変えない）：
  1. HTML に埋め込まれた画像（base64）を public/img/*.png に分離する（毎回 820KB 読み込む → 画像はキャッシュ）
  2. __NPAS_SHARED_IMAGE_n__ の置き換え用スクリプトを削除し、画像のパスを直接書く
  3. <script> の中身を public/js/app.js に移す（Content-Security-Policy で外部スクリプトを禁止するため）
  4. ログイン画面に PIN 入力欄を1つ追加する（本人確認のため）
  5. google.script.run の呼び出しを、新しい API（public/js/api.js）への呼び出しに差し替える

使い方: python3 -I tools/convert-original-html.py <旧Index.html> <出力先public/>
"""
import base64
import re
import sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding='utf-8')
out = Path(sys.argv[2])
(out / 'img').mkdir(parents=True, exist_ok=True)
(out / 'js').mkdir(parents=True, exist_ok=True)

names = ['mascot-yellow.png', 'mascot-chuka.png', 'mascot-nasu.png', 'mascot-red.png']
uris = re.findall(r'data:image/png;base64,[A-Za-z0-9+/=]+', src)
assert len(uris) == 4, len(uris)
for i, uri in enumerate(uris):
    (out / 'img' / names[i]).write_bytes(base64.b64decode(uri.split(',', 1)[1]))
    src = src.replace(uri, '/img/' + names[i], 1)
for i, n in enumerate(names, start=1):
    src = src.replace(f'__NPAS_SHARED_IMAGE_{i}__', '/img/' + n)

# 2. 置き換え用スクリプト（最後の <script>）を削除
last = src.rindex('<script>')
end = src.index('</script>', last) + len('</script>')
assert '__NPAS_SHARED_IMAGE_' in src[last:end]
src = src[:last] + src[end:]

# 3. メインのスクリプトを外部ファイルへ
start = src.index('<script>')
end = src.index('</script>', start)
js = src[start + len('<script>'):end]
src = src[:start] + '<script src="/js/api.js"></script><script src="/js/app.js"></script>' + src[end + len('</script>'):]

# 5. 通信部分の差し替え（google.script.run → fetch API）
old_call = re.search(r"const call=\(name,\.\.\.args\)=>new Promise\(.*?\}\);", js, re.S).group(0)
js = js.replace(old_call, "const call=(name,...args)=>window.npasApi(name,args);", 1)

# 4. PIN入力欄を追加（ニックネーム表示と「はじめる」ボタンの間）
nick = '<div class="nick" id="nickname">ニックネーム：―</div>'
assert nick in src
pin_group = ('<div class="group" id="pinGroup" hidden><label class="form-label" for="pin">🔑 PINを入力してください</label>'
             '<input class="field" id="pin" type="password" inputmode="numeric" autocomplete="current-password" '
             'maxlength="6" placeholder="4〜6桁の数字"></div>')
src = src.replace(nick, nick + pin_group, 1)

old_login = "function login(){selected=staff.find(s=>s.id===$('person').value);if(!selected){toast('名前を選択してね');return}show('home')}"
assert old_login in js
new_login = ("async function login(){const u=staff.find(s=>s.id===$('person').value);if(!u){toast('名前を選択してね');return}"
             "const pin=$('pin').value.trim();if(!/^\\d{4,6}$/.test(pin)){toast('PIN（4〜6桁の数字）を入力してね');return}"
             "busy('loginBtn',true);try{await call('login',u.id,pin);selected=u;$('pin').value='';show('home')}"
             "catch(e){toast(e.message)}finally{busy('loginBtn',false)}}")
js = js.replace(old_login, new_login, 1)

old_switch = "function switchStaff(){selected=null;"
assert old_switch in js
js = js.replace(old_switch, "function switchStaff(){call('logout').catch(()=>{});$('pin').value='';selected=null;", 1)

old_bind = "$('loginBtn').addEventListener('click',login);"
assert old_bind in js
js = js.replace(old_bind, old_bind + "$('pin').addEventListener('keydown',e=>{if(e.key==='Enter')login()});", 1)

(out / 'index.html').write_text(src, encoding='utf-8', newline='')
(out / 'js' / 'app.js').write_text(js.strip('\r\n') + '\n', encoding='utf-8', newline='')
print('index.html', len(src.encode()), 'bytes / app.js', len(js.encode()), 'bytes')
