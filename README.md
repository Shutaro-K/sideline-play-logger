# sideline-play-logger

iPad Safari向けのプレー記録アプリ。Phase 1の試合記録保存に、Phase 2-BのSign対応CSV読み込み・CWM照合を追加しています。実行時の外部ライブラリやCSV・試合記録のサーバー送信はありません。

## Sign対応CSVの読み込み

右上の「CSV読込」からファイルを選びます。UTF-8（BOMあり・なし）のCSVを使用してください。次の7列をこの順で必要とします。

```text
sign,formation,play,record_type,sign_raw,parent_sign,branch
```

- `sign`：先頭の0を含む半角数字5桁。全行で一意。
- `formation`：空欄不可。
- `play`：通常Sign・子Signでは空欄不可。CWM親では空欄。
- `record_type`：`normal`、`cwm_parent`、`cwm_choice`のいずれか。
- `sign_raw`：原資料の5桁、または5桁(2桁)。そのまま保持し、照合キーの再計算には使用しません。
- `parent_sign`・`branch`：CWM子だけに設定。親は同じ対応表の`cwm_parent`を参照し、枝番は`1`か`2`。各親に枝番1・2が一つずつ必要です。通常Sign・CWM親では両列を空欄にします。

引用符付きのカンマ・改行・二重引用符、CRLF/LF/CRを扱います。ヘッダー・列数・Sign・重複・種類・親子関係等を全件検証し、IndexedDBへの保存に成功してから一括適用します。不正CSV・文字コードエラー・保存失敗では以前の対応表を保持します。ファイル選択をキャンセルしても変更しません。

実際の対応表はブラウザで選択してください。アプリに初期データや架空の照合結果は同梱していません。CSV未読込でも未照合の記録を保存できます。

## 記録とCWM入力

- Enterで記録を保存します。全項目空欄でも保存でき、保存完了後に全入力をクリアします。
- 通常Signは5桁入力するとFormation・Playを表示します。
- CWM親Signを5桁入力すると「CWM」「枝番未確定」を表示します。そのまま既存テンキーの1・2を押して子を選びます。他の欄へ移動していた場合は「枝番」ボタンかSign欄で入力先を選び直します。
- Sign欄は親5桁と枝番を`親Sign · 1`のように表示します。別の枝番を押すと切り替えます。削除は枝番を先に消し、その後にSignを1桁ずつ消します。
- 子Signの5桁を直接入力しても同じ子プレーを照合します。Formation・Playは子行の値を使用します。
- 枝番未確定でもEnterで保存できます。子を推測せず、Playに`CWM（枝番未確定）`を表示・保存します。
- 未照合Signもそのまま保存します。
- 行を選んで編集し、Enterで同じ記録を上書きします。元の時刻・日時・ID・順序を保持します。
- 対応表を置き換えても過去ログを書き換えません。編集中もSign・入力枝番が同じなら保存済みのFormation・Play・照合状態を維持します。Signまたは枝番を変更した編集だけ、現在の対応表で再照合します。
- PLAY LOGの拡大・縮小、検索、スクロールは従来どおりです。

## 保存・復元・削除

- データベース：`sideline-play-logger`、バージョン：`2`。
- `plays`：試合記録。自動採番ID順に復元します。Phase 1からの移行では既存行・時刻・ID・採番順を維持します。
- `signMappings`：対応表1件（キー`current`）。全7列と読込日時を保持します。再読み込み・同じブラウザの再起動後も復元します。
- 復元完了まで記録・CSV読込を停止します。失敗時は上書きを防ぐため停止を維持し、再試行ボタンを表示します。
- 書き込みはトランザクション完了後に画面へ反映します。記録保存失敗では入力を残して継続通知し、Enterで再試行できます。CSVを読み込んでも未保存の記録入力は消しません。
- リセットはCSVを端末に保存して内容を確認したことと、全記録の削除を二段階で確認します。キャンセルでは変更せず、実行時は`plays`だけを削除します。対応表と他の設定は保持します。

新しい記録には従来の入力・日時に加え、入力した`sign`、入力枝番`branch`、`lookupStatus`、確定子または通常Signの`resolvedSign`、`parentSign`、照合結果の`cwmBranch`を保存します。未確定の`resolvedSign`は空欄です。子Signの直接入力では入力枝番は空欄で、照合結果の枝番を保持します。Phase 1の行に不足するメタデータを後から自動補完しません。

## CSV出力

出力は削除と独立しており、検索中も全記録を出力します。既存の8列（Time〜Remark）を同じ順で維持し、末尾に次の4列を追加しています。

```text
Lookup Status,Resolved Sign,Parent Sign,CWM Branch
```

`Sign`は入力した5桁、`Resolved Sign`は確定した子Signまたは通常Signです。状態は`empty`、`not_loaded`、`unmatched`、`matched`、`cwm_pending`、`cwm_resolved`。照合状態を持たないPhase 1の行は出力時に`legacy`とします。UTF-8 BOM、CRLF、CSVエスケープは維持しています。

## 開発・テスト

`index.html`、`storage.js`、`sign-lookup.js`を同じ場所から配信してください。ビルドは不要です。

```sh
npm install
npx playwright install chromium webkit
npm test
BROWSER_ENGINE=webkit npm test
```

インストール済みChromeなら`BROWSER_CHANNEL=chrome npm test`。テストはローカルHTTPサーバーと独立した一時ブラウザを使います。Phase 1の14件を維持し、CSV選択・検証・保存・復元、CWMの入力・編集・出力、旧DB移行、エラー時の保持等を追加しています。CSVや記録を送信するリクエストがないことも確認します。`tests/fixtures.cjs`のデータはすべて架空です。実CSVをテスト・スクリーンショット・コミットに含めないでください。`.gitignore`でもCSVを除外します。

## 制約とiPad実機確認

- 保存は現在のブラウザ・オリジン内のみです。同じ試合は1タブで操作してください。複数タブ同時編集の同期は未実装です。
- ブラウザ側のストレージ削除は保証しません。Enter前の入力は永続保存対象外です。保存エラー時は再試行成功まで再読み込みしないでください。
- CSVの端末保存完了はユーザー自身がファイルアプリ等で確認します。
- iPad Safariでファイル選択・キャンセル、実CSV読込、再読み込み・終了再起動後の復元、親Sign＋枝番・子Sign直接入力・未確定保存・編集・CSV出力を確認してください。WebKitテストは実機確認の代替ではありません。
- mainへのpush・GitHub Pages反映はレビュー・承認後に行います。
