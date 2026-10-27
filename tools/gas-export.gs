/**
 * N-PAS データ移行用の書き出し（Google Apps Script）
 *
 * 使い方：
 *  1. 現在の Apps Script プロジェクトの「コード.gs」の末尾に、このファイルの内容を貼り付けて保存。
 *  2. 関数の選択で「npasExportForMigration」を選び「実行」。
 *  3. 実行ログに表示されるURL（Googleドライブ上のJSONファイル）を開き、ダウンロード。
 *  4. 新しいシステムの管理画面 → 「データ移行」でそのファイルを選ぶ。
 *
 * 安全性：
 *  ・スプレッドシートは読み取るだけです。書き込み・削除は一切しません。
 *  ・書き出し前に、スプレッドシートのバックアップ（コピー）をドライブに作成します。
 *  ・日付・時刻は「画面に表示されている値」で書き出すため、タイムゾーンのずれが起きません。
 */
function npasExportForMigration() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID がありません。');
  var ss = SpreadsheetApp.openById(id);
  var tz = Session.getScriptTimeZone();
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');

  // 1) 移行前バックアップ（スプレッドシートのコピー）
  var backup = DriveApp.getFileById(ss.getId()).makeCopy('【N-PAS 移行前バックアップ】' + ss.getName() + '_' + stamp);

  // 2) 各シートを読み取り
  // 日付・時刻の列は表示値（getDisplayValues）、それ以外は値（getValues）を使う
  var displayCols = {
    'スタッフ名簿': [],
    '勤怠データ': ['勤務日', '出勤', '退勤'],
    '修正履歴': [],
    '打刻修正申請': []
  };
  var dateTimeCols = ['更新日時', '日時', '申請日時', '処理日時'];
  var sheets = {};
  var counts = {};
  Object.keys(displayCols).forEach(function (name) {
    var s = ss.getSheetByName(name);
    if (!s || s.getLastRow() < 1) { sheets[name] = []; counts[name] = 0; return; }
    var range = s.getDataRange();
    var values = range.getValues();
    var shown = range.getDisplayValues();
    var headers = values[0].map(String);
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var empty = values[i].every(function (v) { return v === '' || v === null; });
      if (empty) continue;
      var o = { _row: i + 1 };
      headers.forEach(function (h, c) {
        if (!h) return;
        var v = values[i][c];
        if (displayCols[name].indexOf(h) >= 0) v = shown[i][c];
        else if (v instanceof Date) {
          v = dateTimeCols.indexOf(h) >= 0
            ? Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX")
            : shown[i][c];
        }
        o[h] = v;
      });
      rows.push(o);
    }
    sheets[name] = rows;
    counts[name] = rows.length;
  });

  var data = {
    format: 'npas-gas-export',
    version: 1,
    exportedAt: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    timezone: tz,
    spreadsheetName: ss.getName(),
    backupFileId: backup.getId(),
    counts: counts,
    sheets: sheets
  };
  var file = DriveApp.createFile('npas-export-' + stamp + '.json', JSON.stringify(data), 'application/json');
  Logger.log('バックアップ: ' + backup.getUrl());
  Logger.log('書き出しファイル: ' + file.getUrl());
  Logger.log('件数: ' + JSON.stringify(counts));
  return { backupUrl: backup.getUrl(), exportUrl: file.getUrl(), counts: counts };
}
