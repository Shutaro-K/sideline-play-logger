# 閲覧共有の構築

フロントは従来どおりGitHub Pagesで配信します。サーバーはSupabase Auth、PostgreSQL、Realtime、Edge Functionです。実際の対応CSVと管理者のメール・PWはリポジトリへ追加しません。

1. Supabaseのプロジェクトを準備し、既存テーブルを確認してから`migrations/`のSQLをファイル名順に適用します。Realtimeの標準`realtime.messages`と`realtime.send()`が必要です。新規プロジェクトでは最初にRealtimeへ接続して初期化を完了させてください。
2. Authentication → Users → Add user → Create new userから管理者本人のアカウントを作成します。本人確認の完了したユーザーのみを管理許可します。公開の管理者作成エンドポイントは設けません。
3. 作成した本人のIDを`public.logger_admins`へ追加します。例のアドレスは実際の作成済みアカウントへ置き換えます。

```sql
insert into public.logger_admins(user_id)
select id from auth.users where lower(email)=lower('your-admin@example.com')
on conflict (user_id) do nothing;
```

4. `logger_admin_logins`へ、管理者ID・上記本人の`user_id`・16バイトのランダムsalt（16進32文字）・PWハッシュ（PBKDF2-SHA256、100,000回、32バイト、16進64文字）を信頼された管理経路で登録します。IDは小文字の半角英数字・`_`・`-`の1〜40文字です。平文PW・実アカウント情報をSQL移行ファイルへ含めません。
5. `functions/logger-share/index.ts`と`handler.mjs`を`logger-share`としてデプロイします。`verify_jwt=false`は管理者ID・閲覧IDのログイン用です。管理者IDログインはサーバー側のPWハッシュと許可表を照合し、対応する確認済みAuthアカウントのワンタイムトークンをサーバー内で生成・消費してセッションを取得します。メール送信や元のAuth PWの変更は行いません。以降の管理者操作はSupabase Authの`/user`と管理者許可表を検証します。サービスキーはSupabase内部だけで使用します。
6. `LOGGER_ALLOWED_ORIGINS`には公開サイトのOriginを設定します。未設定時の許可元は`https://shutaro-k.github.io`です。CORSに加えて、全データ操作を認証・RLS・RPC内の管理者照合で制限します。
7. フロントの`sharing-config.js`にはプロジェクトURLと**publishableキー**だけを設定します。`sb_secret_...`やservice-roleキーを使用しません。現在のクライアントは`sb_publishable_...`形式を要求します。
8. 入力側で管理者ID・PWによりログインし、試合共通の閲覧ID・PWを設定します。Supabase Authの閲覧用アカウントはEdge Functionが作成します。閲覧PWはAuthがハッシュ化し、アプリのテーブルには保存しません。

## アクセス制御

- 未認証の記録取得を禁止します。閲覧用ユーザーが読めるのは現在許可された1試合だけです。
- 管理者IDとPWハッシュの対応表はservice-roleのみ読み取り可能です。クライアントに渡されたメール・ユーザーIDをセッション発行先には使いません。管理者許可を削除するとIDの対応表も削除されます。
- テーブルへの直接の追加・更新・削除はブラウザへ許可しません。同期は`logger_publish`だけを使用し、本人のAuth ID・管理者許可・記録端末IDを検証します。
- `logger_publish`は意図的に`SECURITY DEFINER`を使うため、Supabase Advisorにauthenticated向け実行権限の警告が出ます。関数の先頭で管理者許可を照合し、所有していない試合・閲覧用ユーザーの呼び出しは拒否します。これらをSQLとブラウザの両方からテストしています。
- `logger_configure`と`logger_stop`はservice-roleにのみ実行を許可します。
- Realtimeの非公開チャンネルはRLSで制限します。通知の本文は改訂番号のみです。接続済みチャンネルの認可キャッシュが残っても、記録本文の取得は常に最新のRLSで検証します。
- ID・PW更新では閲覧ユーザーを入れ替え、旧JWTのユーザーIDを許可対象から外します。旧アカウント削除が一時的に失敗しても、データへの権限は残りません。
- 2026-10-23の実プロジェクトのAdvisorでは、[同期RPCの実行権限](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)と[漏洩済みPWの検知が無効](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)の2件が警告として残っています。RLSのエラーはありません。追加した管理者ID表には[ポリシー未定義の情報通知](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)がありますが、ブラウザへテーブル権限を与えず、全行へのアクセスを禁止する意図的な設定です。アプリの管理者IDはPBKDF2による独自照合なので、Supabase AuthのPW強度設定とは別です。

## テストと確認範囲

`tests/sharing-server.test.cjs`は移行SQLを実際のPostgreSQLエンジン（PGlite）で実行します。`tests/sharing-browser.test.cjs`は同じSQL・Edge FunctionコードをローカルHTTP／WebSocketの架空サービスで使用し、入力側と閲覧側を別のブラウザ環境として検証します。AuthのHTTP応答とRealtime配信はこのテストでは架空実装です。実際のSupabase Auth・Realtime・Safariでの確認は別に実施してください。

2026-10-23に東京の実プロジェクトでSupabase Auth・Realtimeも検証しました。本人が管理者ログインと検証用ID・PWの設定を行い、ChromeとWebKitの独立した閲覧画面で架空の1プレーを確認しました。両ブラウザでWebSocketの更新通知を受信し、開いた吹き出しへの訂正反映、閲覧者の書き込み拒否、共有停止後の表・吹き出し消去を確認しています。終了後は検証用の閲覧権限を外し、共有先の架空記録を削除しました。iPad Safari実機での共有確認は未実施です。

同日の管理者IDログインへの変更後も、Chrome・WebKitの全106テストが成功しました。実プロジェクトでも両ブラウザで、指定された管理者ID・PWによるログイン、誤ったPWの拒否、共有設定の表示、ログアウトを確認しました。この確認では共有設定・記録・既存AuthアカウントのPWを変更していません。

参考：[Realtime認可](https://supabase.com/docs/guides/realtime/authorization)、[データベースのRLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[認証API](https://supabase.com/docs/reference/self-hosting-auth)。
