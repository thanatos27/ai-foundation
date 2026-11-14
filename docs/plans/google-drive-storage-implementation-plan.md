# Google Drive保存対応（Knowledge／Life Log） — Implementation Plan

- Status: **実装済み。P-01〜P-03・P-02 Step 6・7・P-02mは実施済み（§17）。P-03mは未実施（外部writerとの名前の排他を保証しないため必須としない）。AC-D05・AC-D06は§12**
- 作成: 2026-11-14
- 対象: [Issue #34](https://github.com/thanatos27/ai-foundation/issues/34)
- 参照: [Phase 4 Implementation Plan](phase-4-implementation-plan.md), [Life Log Implementation Plan](lifelog-implementation-plan.md), [REST API](../specs/rest-api.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

Google Driveに同期済みのObsidian Vaultを、Google Drive APIから直接読み書きする保存方式（`storage: google_drive`）を追加する。Domain・ID・操作ルール・REST API・MCP Toolは変えず、`VaultStorage` / `LifeLogStorage` の保存境界の下にDrive実装を加える。Filesystem保存（`storage: filesystem`）は引き続き使える。

本Planは2段階で進める。

1. **検証フェーズ**: 認可スクリプトのDrive対応と検証用probe（§4）を実装し、P-01〜P-03を実行して結果を§17に記録する。結果に基づき§10の競合仕様とAC-D05・AC-D06を確定し、Plan Reviewへ進む。
2. **本実装フェーズ**: Plan承認後に§13の順序で実装する。

クラウド配置、HTTPS終端、Muse・ChatGPTとの接続は対象外。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Base | `main` の `14c8825`（REST API実装済み） |
| 実行環境 | Node `>=24`、TypeScript 5.9、ESM（NodeNext）、`zod 4.6.7`、Vitest 5 |
| Google関連依存 | `@googleapis/calendar 20.1.0`（`googleapis-common 9.3.0`）、`google-auth-library 11.3.0`（`gaxios 7.3.1`）。Drive用の依存はない |
| CI | なし（`npm test` をローカルWindowsで実行） |

### 既存実装の要点（本Planで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/connectors/obsidian/storage.ts` | `VaultStorage`（`checkKnowledgeDir` / `list` / `read` / `createExclusive` / `append`）。境界を越える値はVault相対パス（`VaultPath`）のみ。`checkKnowledgeDir` はInterface以外から呼ばれていない |
| `src/connectors/obsidian/lifelog-storage.ts` | `LifeLogStorage`（`refOf` / `read` / `createExclusive` / `append`）。境界を越える値はファイル名のみ |
| `src/connectors/obsidian/vault-directory.ts` | `FilesystemVaultDirectory`。Vaultから対象Directoryまでと内側のSymbolic Linkを辿らない、実パスで内側を確認、`apartFrom` で他Directoryとの重複を実パスで検査、`O_EXCL` 作成、`O_APPEND` 追記。Cacheなし。errnoはcodeだけをメッセージに出す |
| `src/connectors/obsidian/filesystem-storage.ts` | Knowledge用。UTF-8を寛容にデコード（不正バイトはU+FFFD）、BOMを除去 |
| `src/connectors/obsidian/filesystem-lifelog-storage.ts` | Life Log用。UTF-8を厳格にデコード（不正なら `ProviderApiError`） |
| `src/connectors/obsidian/connector.ts` | `append` は `storage.read` → Frontmatter検査 → `storage.append(path, appendText(file.text, content))`。`search` は `list` 後に最大8並列で `read` |
| `src/connectors/obsidian/lifelog-connector.ts` | `append` は `storage.read`（存在・UTF-8・末尾改行の確認）→ `storage.append` |
| `src/connectors/obsidian/text.ts` | `appendText(existing, content)`: 既存の改行コード（CRLFの有無）と末尾の改行数から区切りを決める |
| `src/connectors/obsidian/id.ts` / `lifelog-id.ts` | `obsidian:<Vault相対パス>` / `lifelog:<ファイル名>` の検証。Storage非依存 |
| `src/config/schema.ts` | `sources.knowledge.obsidian` は `storage: z.literal('filesystem')`・`vault_path`・`knowledge_dir`。Life LogはKnowledgeの `vault_path` を使う。Knowledge・Life LogのDirectoryの重複を文字列で検査（大小文字を区別しない） |
| `src/connectors/index.ts` | Filesystem Storageを固定で生成 |
| `src/connectors/google-calendar/client.ts` | `GOOGLE_CALENDAR_SCOPES`、`lazyCalendarApi`（初回呼び出しで `OAuth2Client` を生成）、`toFoundationError`（`invalid_grant`・401・403・404の分類、Provider文は `providerText`） |
| `src/credentials/env.ts` | `getGoogleOAuthCredentials()` の未設定メッセージは `Google Calendar credential is not configured` |
| `scripts/google-auth.ts` | Loopback＋PKCEでRefresh Tokenを取得。Scopeは `GOOGLE_CALENDAR_SCOPES` 固定。付与されたScopeは確認していない |
| `src/errors.ts` / `src/http/errors.ts` | `ConflictError` → 409 `conflict`、`CredentialError` → 502、`MissingCredentialError` → 503、`ConfigurationError` → 503、`ProviderApiError` → 502。HTTPではProvider文を除く |
| `googleapis-common` | `options.retry` の既定は `true`（gaxiosの既定ではGET・PUT等は再試行、POST・PATCHは再試行しない） |
| `src/domain/knowledge.ts` | `KnowledgeSourceSchema` に `google_drive` が予約されているが、本Planでは使わない（`source` は `obsidian` のまま） |

---

## 2. 設計方針

1. **`obsidian` は管理方式、`storage` はアクセス方法。** Knowledgeの `source`・ID・`external_ref`、Life LogのID・`external_ref` はStorageに依存しない。Driveのfile IDはStorage内部だけで使う。
2. **既存の境界ルールをDriveへ写す。** Symbolic Link → ショートカット、実パス確認 → Vaultルートからの名前解決、`O_EXCL` → 存在確認＋作成後確認、`O_APPEND` → 取得した版に対する条件付き更新、とFilesystem実装の規則と対応させる。
3. **曖昧さは選ばずに拒否する。** 同じ親に同名の候補が複数ある場合、取得・追記・作成・検索のいずれでも1件を選ばず `ConflictError`（409）にする。
4. **Cacheしない。** Filesystem実装と同じく、毎回Vaultルートから解決する。Obsidianでの移動・改名が次の呼び出しで反映される。
5. **書き込みは再試行しない。** 書き込み要求は自動再試行を無効にし、結果不明のときは成功も失敗も推測しないメッセージを返す。読み取りの再試行はgaxiosの既定に従う。
6. **保証できないことは保証しない。** PC上の未保存の編集や未同期の変更はAPIから検知できない。保証範囲は実API検証（P-02・P-03）の結果で確定し、READMEに制約として書く。

---

## 3. 基本設計の具体化

| 論点 | 本Planでの扱い | 理由 |
|---|---|---|
| Storage interfaceの変更 | **必要**。`append` を「読んだ内容に対して書く」形に変える（§8） | Driveの追記は読み取り→全体の再Uploadで、書き込みは読んだ版に対して行う必要がある。現在の `append(path, text)` ではStorageがConnectorの読んだ版を知らない。P-02の結果にかかわらず必要 |
| Life LogのVault | `sources.knowledge.obsidian` の `storage` と `vault_folder_id` を使う | 現在もLife LogはKnowledgeの `vault_path` を使う。保存方式だけが異なる構成を作らない |
| `external_ref` | 現在どおりVault相対パス（Knowledge: `<knowledge_dir>/…/x.md`、Life Log: `<directory>/<ファイル名>`）。Driveのfile ID・URLは出さない | Storageを切り替えてもIDと参照が変わらない |
| 大小文字 | 取得・追記は**名前の完全一致**。作成時の同名確認は大小文字・Unicode正規化（NFC）を無視して行う（§7.3） | Driveの名前は大小文字を区別するが、Windows・macOSの同期先では同名になる。取得は既存IDに忠実に、作成は同期先で衝突する名前を作らない |
| 検索で曖昧なパスがあるとき | 検索全体を `ConflictError` にし、曖昧なIDを最大10件示す（§9.1、Q2） | 黙って欠落させない。検索結果に返したIDは取得・追記でも曖昧になるため、返しても使えない |
| ショートカット | 辿らない。Vaultルート〜対象Directory上にあれば `ConfigurationError`、対象Directory内の検索では除外、ID指定の対象・途中にあれば `InputValidationError` | Symbolic Linkと同じ扱い |
| ゴミ箱 | 一覧・解決とも `trashed = false` のみ。Vaultルート・対象Directoryがゴミ箱内なら `ConfigurationError` | 削除済みのものを操作しない |
| Google Docs等 | `application/vnd.google-apps.*`（フォルダ・ショートカット以外）は対象外（検索で除外、ID指定は `NotFoundError`）。変換しない | Markdownのbyte列を持たない |
| ファイルの種類 | `.md` の判定は名前だけで行い、MIME typeでは絞らない | Drive for desktopで置いた `.md` のMIME typeは `text/plain` だった（P-01）。API・同期クライアントで値が異なる |
| 共有ドライブ | 対象外（マイドライブのみ）。`supportsAllDrives` は指定しない（Q5） | 同期済みVaultはマイドライブにある前提。共有ドライブは権限・一覧のcorporaが異なる |
| サイズ | 作成・追記後のファイルが5 MiBを超える場合は書き込まない（アプリ独自の上限、Q4） | Googleのupload guideはmedia / multipart uploadを5 MB以下の小さいファイル向けとし、それを超える場合はresumable uploadを案内している。APIの最大ファイルサイズ（`files.update` のreference）とは別の値で、本Planはresumable uploadを実装しないためにこの上限を設ける。Markdownのノートでは通常超えない |

---

## 4. 実装前の検証（P-01〜P-03）

**現時点で未実施。** 実APIの結果は§17に記録するまで取得済みとしない。

### 4.1 準備（利用者の環境で行う作業）

1. 既存のGoogle Cloud ProjectでGoogle Drive APIを有効化し、OAuth同意画面のScopeに `https://www.googleapis.com/auth/drive` を追加する。
2. `npm run auth:google -- --drive` でCalendarとDriveのScopeを同時に再認可し、`GOOGLE_OAUTH_REFRESH_TOKEN` を更新する（§6）。
3. マイドライブに検証用フォルダ（名前は `AI Foundation Probe` で始める）を作り、フォルダIDを `GOOGLE_DRIVE_PROBE_FOLDER_ID` に設定する。
4. Drive for desktopの同期フォルダ経由で、検証用フォルダに手動のMarkdown（例: `manual.md`、日本語本文）を1件置く。

### 4.2 probe（`scripts/probe-google-drive.ts`）

本実装（`src/`）とは別のスクリプトで、`src/` からimportしない。`npm test` では実行しない。

```text
npx tsx scripts/probe-google-drive.ts <p01|p02|p02m|p03> [--keep] [--manual]
```

| 項目 | 内容 |
|---|---|
| 入力 | `.env` / 環境変数の `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` / `GOOGLE_DRIVE_PROBE_FOLDER_ID`。任意で `GOOGLE_DRIVE_VAULT_FOLDER_ID`（P-01 Step 10のメタデータ取得だけに使う） |
| 安全装置 | 対象フォルダの名前が `AI Foundation Probe` で始まらない、フォルダでない、ゴミ箱内のいずれかなら何もせず終了する。書き込むのは今回の実行で作成したファイル（名前 `probe-<runId>-…`）だけ。手動ファイルは読み取りのみ。`GOOGLE_DRIVE_VAULT_FOLDER_ID` のフォルダは `files.get` 以外の要求を送らない |
| 再試行 | 読み取りを含む全要求で `retry: false` を指定する。SDKの既定の再試行（v2の `PUT` 等）を混ぜずに、各要求の結果をそのまま記録するため |
| 後片付け | 作成したファイルを最後にゴミ箱へ移す（完全削除しない）。`--keep` で残す |
| 出力 | 標準出力にJSON Lines: step、method・endpoint・uploadType・条件header名と値、HTTP status、応答の `id` `name` `mimeType` `version` `headRevisionId` `md5Checksum` `modifiedTime` `size`、応答の `ETag` header、本文のSHA-256。Authorization header・Access Token・Refresh Tokenは出さない |
| 手動操作 | Drive for desktopでの手動操作を挟む手順（`p02m`、`p03 --manual` のP-03m）は、標準入力のEnterを待つ |

### 4.3 P-01：権限・既存ファイルの読み書き

| Step | 操作 | 記録 |
|---|---|---|
| 1 | Access Tokenの `tokeninfo` | 要求したScopeと付与されたScope |
| 2 | Calendar `calendarList.list`（1件） | status（Calendar権限が残っていること） |
| 3 | 検証フォルダの `files.get` | `mimeType`・`trashed`・`parents` |
| 4 | 子の一覧（`'<id>' in parents and trashed = false`、`pageSize=2`） | ページ分割されること、`nextPageToken` |
| 5 | 手動ファイルの `files.get` と `alt=media` | 同期クライアントが付けた `mimeType`、`size`、`md5Checksum` と本文の一致、`headRevisionId`・`version` の有無 |
| 6 | `name = '<手動ファイル名を大文字にしたもの>'` で一覧 | 名前検索が大小文字を区別するか |
| 7 | 検証ファイルの作成（multipart、`text/markdown`、名前に日本語・空白・`'` を含む） | status、`mimeType`、エスケープした名前での検索結果 |
| 8 | 検証ファイルの本文更新（`uploadType=media`） | `version`・`headRevisionId` の変化、`mimeType` が変わらないこと |
| 9 | `revisions.get(headRevisionId, alt=media)` | 本文が手順8の内容と一致するか |
| 10 | `GOOGLE_DRIVE_VAULT_FOLDER_ID` が設定されていれば、そのフォルダの `files.get`（`driveId`・`ownedByMe`・`mimeType`・`trashed`） | 実際のVaultがマイドライブにあるか共有ドライブにあるか（Q5） |

### 4.4 P-02：古い内容からの更新を拒否できるか

同一プロセス内の別の `OAuth2Client`（クライアントA・B、Cacheを共有しない）で行う。

| Step | 操作 | 記録 |
|---|---|---|
| 1 | 基準ファイルを作成。A・Bがそれぞれメタデータ（v3の `version`・`headRevisionId`・`md5Checksum`、応答の `ETag` header、v2 `files.get` の `etag`）と本文を取得 | 各値 |
| 2 | Aが追記した本文で更新 | 新しい各値 |
| 3a | Bが古い本文からv3 `files.update`（`uploadType=media`）に `If-Match: <Bの取得したETag header>` を付けて更新 | status（412を期待）、最終本文 |
| 3b | Bが古い本文からv2 `files.update`（`upload/drive/v2`、`uploadType=media`）に `If-Match: <Bの取得したv2 etag>` を付けて更新 | status、最終本文 |
| 3c | 3a・3bで拒否された場合のみ：取得し直した値で同じ条件付き更新 | 200で成功すること（条件が常に失敗するのではないこと） |
| 4 | Bがメタデータ取得（`headRevisionId` = r1）→ Aが更新（r2）→ Bが `alt=media` と `revisions.get(r1, alt=media)` で本文取得 | `alt=media` がr2の本文を返すか、`revisions.get` がr1の本文を返すか（メタデータと本文の取得の間の変更） |
| 5 | 条件なしでBが古い本文から更新（基準として最後に実施） | Aの追記が失われることの確認 |
| 6 | 本実装の追記手順を一連で実行する: Bがv2 `files.get`（etag・`headRevisionId`）→ その版を `revisions.get` → 追記した本文をv2 `files.update`＋`If-Match`。割り込みなし／本文取得後にAが更新／v2 `files.get` と本文取得の間にAが更新、の3通り | 各取得値、Bのstatus（200／412）、最終本文にAの更新・Bの追記が残るか |
| 7 | A・Bが同じ版を読んだ後、Aが更新日時を維持して本文を更新（v2 `modifiedDateBehavior=noChange`、および `fromBody` で元の日時）→ Bが古いetagで条件付き更新 | A更新後の本文・`version`・`headRevisionId`・更新日時・etag（日時が実際に維持されたか）、Bのstatus、最終本文 |
| P-02m（`p02m`） | Step 6の手順でBが取得した後、利用者がDrive for desktopの同期フォルダで同じファイルに `LOCAL EDIT` の行を加えて保存し、同期完了を待つ。Bが条件付き更新 | ローカル編集後の更新日時・etag・`headRevisionId`、Bのstatus、最終本文にローカル編集が残るか、Drive上の同名・類似名のファイル |

### 4.5 P-03：同名ファイルの同時作成

| Step | 操作 | 記録 |
|---|---|---|
| 1 | A・Bが同じ親・同じ名前で同時に `files.create`（`Promise.all`）。2クライアントで3回、5クライアントで3回 | 各要求のstatus・file ID |
| 2 | 作成直後・1秒後・5秒後に名前で一覧 | 見える件数（一覧の反映遅延の有無） |
| 3a | 作成後確認で他の同名項目が見えたら自分の作成分を取り消す手順を、probeが順序を指定して実行する: A・Bの作成前確認 → Aの作成 → Aの作成後一覧 → Bの作成 → Bの作成後一覧 | 各要求の結果（成功／409）、残った件数、各一覧に相手の作成分が見えたか |
| 3b | 同上の順序違い: A・Bの作成前確認 → Aの作成 → Bの作成 → Aの作成後一覧 → Bの作成後一覧 | 同上（両方が取り消して0件になるか） |
| 3c | 参考として、同じ手順を5クライアントで `Promise.all` により10回実行 | 各回の成功数・残った件数 |
| 4 | `files.generateIds` で得たIDを2つの作成要求に同時に指定 | 2件目が拒否されるか（IDの一意性。名前の一意性ではない） |
| P-03m（`--manual`） | 利用者がDrive for desktopで同名ファイルを作るのと同時にAPIで作成 | 同期後のDrive上の件数と名前（` (1)` 付き等） |

P-03の結果は、観測した順序でどうなったかの記録であり、名前の一意性の証明ではない。§10.2の方式の順序・失敗はFake Drive（§13.3）で確認する。

### 4.6 検証結果から確定する事項

| 確定事項 | 根拠 |
|---|---|
| 追記を許可する条件と競合時のレスポンス（§10.1） | P-02 Step 3a・3b・4・6・7、P-02m |
| 新規作成の同名検出の範囲と、作成の排他を設計レビューへ戻すか（§10.2・Q8） | P-03 Step 1〜4、P-03m |
| Drive同期との競合で保証できない条件と運用（README） | P-02m、P-03m |
| Storage interfaceの変更内容（§8の `DriveApi.updateContent` の条件） | P-02 |
| AC-D05・AC-D06の文言（§12）、競合関連テスト（§14） | 上記すべて |

---

## 5. 設定（`src/config/schema.ts`）

`sources.knowledge.obsidian` を `storage` によるdiscriminated unionにする。

```yaml
sources:
  knowledge:
    default: obsidian
    providers: [obsidian]
    obsidian:
      storage: google_drive
      vault_folder_id: "<Drive上のVaultルートのフォルダID>"   # config.local.yaml に書く
      knowledge_dir: "AI Foundation/Knowledge"
  lifelog:
    provider: obsidian
    obsidian:
      directory: "AI Foundation/LifeLog"
```

| `storage` | Key |
|---|---|
| `filesystem` | `vault_path`（任意・絶対パス）、`knowledge_dir`（任意）。現在と同じ |
| `google_drive` | `vault_folder_id`（任意）、`knowledge_dir`（任意）。`vault_path` は受け付けない（strict object） |

- `vault_folder_id` は `^[A-Za-z0-9_-]{10,}$`。`root` 等の別名は受け付けない（マイドライブ全体をVaultにしない）。任意とし、未設定時はToolが `ConfigurationError` を返す（現在の `vault_path` と同じ）。
- `storage: google_drive` に `vault_path` が書かれていたら、「unrecognized key」ではなく「`google_drive` では `vault_folder_id` を使う」旨のIssueにする。
- Knowledge・Life LogのDirectory重複の検査（大小文字を区別しない文字列比較）は両Storageで共通。Drive上の実フォルダによる重複検査は§7.4。
- `config.yaml`（公開）は `storage: filesystem` のまま。コメントに `google_drive` の書き方を追記する。

---

## 6. 認証

### 6.1 Scope（`src/connectors/google-drive/client.ts`）

- `GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive']`。
- `drive` はDrive全体を管理できるScopeで、Knowledge／Life Logのフォルダ制限はAI Foundation側の境界（§7）である。READMEにもそう書き、Googleのフォルダ単位の権限制限とは説明しない。
- `drive.file` は同期クライアントや手動で作成された既存ファイルにアクセスできないため使わない。

### 6.2 `scripts/google-auth.ts`

| 起動 | 要求するScope |
|---|---|
| `npm run auth:google` | `GOOGLE_CALENDAR_SCOPES`（現在と同じ） |
| `npm run auth:google -- --drive` | `GOOGLE_CALENDAR_SCOPES` ＋ `GOOGLE_DRIVE_SCOPES` |

- Calendar・Driveは同じRefresh Tokenを使うため、`--drive` でもCalendarのScopeを必ず含める。
- `tokens.scope` を確認し、要求したScopeのうち付与されなかったものがあれば（同意画面でチェックを外した場合など）Refresh Tokenを出力せず、不足Scopeを示して終了コード1で終わる。
- 引数の解釈には `node:util` の `parseArgs`（strict）を使い、未知の引数はErrorにする。

### 6.3 Credential

- `CredentialProvider.getGoogleOAuthCredentials()` をそのまま使う。Interfaceは変えない。
- 未設定時のメッセージを `Google Calendar credential is not configured` から `Google credential is not configured` に変える（Driveからも呼ばれるため）。
- Drive用の `OAuth2Client` はCalendarとは別に `lazyDriveApi` で初回呼び出し時に生成する（`lazyCalendarApi` と同じ構造）。Token・Clientの値はログ・エラーメッセージ・APIレスポンスに出さない。

---

## 7. Drive上のパス解決

### 7.1 Drive API Client（`src/connectors/google-drive/client.ts`）

Connector側が使う最小のInterfaceを定義し、テストではFakeを注入する。

```ts
interface DriveItem {
  id: string; name: string; mimeType: string; trashed: boolean;
  parents: string[]; size?: number; modifiedTime: string; createdTime: string;
}

/** 追記の基準: 1回のv2 files.getで得たetagとheadRevisionId（同じ版を指す） */
interface DriveRevision { fileId: string; etag: string; headRevisionId: string }

interface DriveApi {
  getItem(fileId: string): Promise<DriveItem>;                       // v3 files.get
  /** 全ページを取得してから返す。trashed = false のみ。Driveの名前検索は大小文字を区別しない（P-01）ため、呼び出し側で完全一致を確認する */
  listChildren(folderId: string, options?: { name?: string }): Promise<DriveItem[]>;
  download(fileId: string): Promise<Buffer>;                         // v3 files.get alt=media（最新の本文）
  revisionOf(fileId: string): Promise<DriveRevision>;                // v2 files.get（fields: etag, headRevisionId）
  downloadRevision(revision: DriveRevision): Promise<Buffer>;        // v3 revisions.get alt=media
  createFile(parentId: string, name: string, bytes: Buffer): Promise<DriveItem>;  // v3 multipart, text/markdown
  /** v2 files.update（uploadType=media）に If-Match: revision.etag。412 conditionNotMet は StaleRevisionError */
  updateContent(revision: DriveRevision, bytes: Buffer): Promise<void>;
}
```

- v3のfiles resourceにはetagがなく、v3の応答にETag headerも付かない（P-02）。条件付き更新はv2の `files.update` と、v2の `files.get` が返すetagで行う。
- メタデータの取得後に更新が入ると、`alt=media` は新しい本文を返す（P-02 Step 4）。追記では、etagと同じ応答で得た `headRevisionId` の本文を `revisions.get` で取得し、etagと本文が同じ版を指すようにする。

- 一覧のqueryは `'<folderId>' in parents and trashed = false`（＋ `and name = '<escaped>'`）。名前は `\` → `\\`、`'` → `\'` でエスケープする。`pageSize=1000`、`nextPageToken` がなくなるまで取得する。
- `fields` は必要な項目だけを指定する。
- 書き込み（`createFile` / `updateContent`）は `retry: false` を指定する。AI FoundationはDrive上のファイルを削除・ゴミ箱へ移動しない。

### 7.2 項目の分類

| Driveの項目 | 検索（Knowledge Directory内の再帰一覧） | Vaultルート〜対象Directoryの途中 | ID指定の途中のフォルダ | ID指定の対象ファイル |
|---|---|---|---|---|
| フォルダ | 降りる | 名前一致で進む | 名前一致で進む | `NotFoundError`（ファイルでない） |
| ショートカット | 除外 | `ConfigurationError` | `InputValidationError` | `InputValidationError` |
| Google Docs等（`application/vnd.google-apps.*`） | 除外 | `ConfigurationError`（フォルダでない） | `NotFoundError` | `NotFoundError` |
| 通常ファイル（`isMarkdownFileName` かつ `isValidSegment`） | 含める | `ConfigurationError`（フォルダでない） | `NotFoundError` | 対象 |
| 名前に `/`・制御文字を含む等、IDに表せない名前 | 除外 | `ConfigurationError` | （指定できない） | （指定できない） |
| ゴミ箱内 | 一覧に出ない | 見つからない扱い | 見つからない扱い | 見つからない扱い |

### 7.3 同名候補

各階層で、同じ親の下の同名項目（種類を問わない、ゴミ箱を除く）を数える。

| 件数 | 取得・追記 | 新規作成 | 途中・設定フォルダ |
|---|---|---|---|
| 0 | `NotFoundError` | 作成候補 | 途中: `NotFoundError` / 設定: `ConfigurationError`（自動作成しない） |
| 1 | 対象 | `ConflictError`（既存メッセージ） | 進む |
| 2以上 | `ConflictError`（曖昧。Google Driveで重複を整理するよう示す） | `ConflictError` | 途中: `ConflictError` / 設定: `ConfigurationError` |

- 取得・追記・途中のフォルダは名前の完全一致で数える。
- 新規作成時は、親フォルダの全子項目を取得し、名前をNFC・小文字化して比較する（`A.md` と `a.md`、NFC／NFDの違いも同名として `ConflictError`）。

### 7.4 Vault・対象Directoryの確認（`check`）

毎回の操作の最初に行う。

1. `vault_folder_id` を `getItem` し、フォルダかつゴミ箱外であることを確認する（404・フォルダでない・ゴミ箱内は `ConfigurationError`）。
2. `knowledge_dir`（Life Logでは `directory`）を `/` で分け、各階層を§7.3で解決する。フォルダIDの列（chain）を得る。
3. もう一方のDirectory（Knowledgeに対するLife Log、またはその逆）が設定されていれば同様に解決し、一方の末端IDが他方のchainに含まれれば `ConfigurationError`（同じ・内側・外側）。もう一方が存在しない場合は検査しない（Filesystem実装と同じ）。

---

## 8. Storage interfaceの変更

`append` を、Storageが読み取りから書き込みまでを同じ版に対して行う形に変える。

```ts
// storage.ts
/** Adds what `compose` returns to the end of the file it was given, and changes nothing else.
 *  `compose` may throw (e.g. malformed frontmatter): nothing is written then.
 *  ConflictError when the file changed after it was read (storages that can tell). */
append(path: VaultPath, compose: (file: VaultFile) => string): Promise<VaultFile>;

// lifelog-storage.ts
append(name: string, compose: (file: LifeLogFile) => string): Promise<LifeLogFile>;
```

| 実装 | 動作 |
|---|---|
| Filesystem | `read` → `compose` → `O_APPEND` で書き込む。現在のConnectorの処理順をStorage内へ移すだけで、書き込み方法と保証は変わらない |
| Google Drive | §9.3 |

- Connectorは `storage.append(path, (file) => { const { meta } = parseOrThrow(file); … return appendText(file.text, content); })` とし、事前の `read` をやめる（読み取り1回）。
- `VaultFile` / `LifeLogFile` の公開項目は変えない。Driveの版情報はStorage内部で保持し、Interfaceに出さない。
- `checkKnowledgeDir` は使われていないが、Interfaceの変更を `append` に限るため残す。

---

## 9. 各操作のDrive実装

新規ファイル:

- `src/connectors/obsidian/drive-vault-directory.ts`: `DriveVaultDirectory`。`FilesystemVaultDirectory` と同じ `VaultDirectoryLabels` を受け取り、`check` / `list` / `read` / `createExclusive` / `append` を持つ。Drive APIを扱う唯一の場所（Obsidian側）。
- `src/connectors/obsidian/drive-storage.ts`: `DriveVaultStorage`（Knowledge、寛容なデコード）。
- `src/connectors/obsidian/drive-lifelog-storage.ts`: `DriveLifeLogStorage`（Life Log、厳格なデコード、直下のファイルのみ）。

デコード規則は既存Filesystem実装と同じ関数を使う（Knowledge: 不正バイトをU+FFFD・BOM除去、Life Log: 不正なら `ProviderApiError`・BOM除去）。

### 9.1 `list`（knowledge_search）

1. §7.4の確認後、Knowledge Directoryから幅優先で `listChildren` する（再帰の深さ制限なし、ショートカットは辿らないので循環しない）。
2. §7.2に従いフォルダは降り、対象ファイルを集める。
3. 同じ親に同名項目が2件以上ある場合（ファイル・フォルダとも）、その配下を含むパスを曖昧として集め、走査後に1件でもあれば `ConflictError`（最大10件のIDと残りの件数）。
4. `modifiedAt` は `modifiedTime` のepoch milliseconds。
5. 本文はConnectorが既存どおり最大8並列で `read` する。一覧と本文取得の間に削除されたファイルは `NotFoundError` → 既存どおり除外。
6. Driveの全文検索（`fullText contains`）は使わない。queryの意味（部分一致・大小文字無視・Frontmatter項目）を変えないため。

### 9.2 `read`

1. §7.4 → 途中のフォルダと対象ファイルを§7.2・§7.3で解決。
2. `download`（最新の本文）。書き込みの基準にしないため、版の固定は不要。
3. デコードして返す。

### 9.3 `append`

1. `read` と同じく解決し、`revisionOf` → `downloadRevision` で、etagと同じ版の本文を取得する。
2. デコードした内容を `compose` に渡す。`compose` が例外を投げたら書き込まない。
3. 追記後の内容は**取得したbyte列＋追記文のUTF-8**とする。デコード後の文字列から再エンコードしない（Knowledgeの寛容デコードで不正バイトをU+FFFDに置き換えた内容で上書きしないため）。
4. 5 MiBを超える場合は書き込まず `InputValidationError`。
5. `updateContent` で取得した版に対して条件付き更新する。412（`conditionNotMet`）なら `ConflictError`（「取得後に変更されたため書き込んでいない。再度実行する」旨）。`mimeType`・名前・親は変えない。
6. 通信断・タイムアウト・5xxは `ProviderApiError`（「追記されたか分からない。`knowledge_get` / `lifelog_get` で確認してから再実行する」旨）。再試行しない。

### 9.4 `createExclusive`

1. §7.4 → 親フォルダ（Knowledge: Knowledge Directory、Life Log: Life Log Directory）を解決。
2. §7.3の作成時規則で同名候補を確認。1件でもあれば `ConflictError`（既存メッセージ）。
3. 5 MiB以下を確認し、`createFile`（multipart、`text/markdown`、UTF-8・BOMなし）。
4. 作成後確認（§10.2）。Step 2〜4は§10.2の `DriveCreateLock` の中で行う。
5. 作成要求の結果不明は `ProviderApiError`（「作成されたか分からない。取得して確認してから再実行する」旨）。再試行しない。

---

## 10. 競合・同時実行

### 10.1 追記

**方式A（v2の条件付き更新）:** §9.3。v2 `files.get` のetag・`headRevisionId` → その版の本文を `revisions.get` → v2 `files.update`（`If-Match`）。412は `ConflictError`（409）。

P-02 Step 6で、この一連の手順をそのまま検証した。間に他の更新がなければ成功し、本文の取得後、またはv2 `files.get` と本文取得の間に他のClientの更新が入ると412で拒否され、他の更新は保持された。v3では条件付き更新に使える値が得られなかった（§7.1）。

**運用前提:** Vaultへ書き込むのはAI FoundationとObsidian／Drive for desktopの通常の利用とする。AI Foundationの更新では、更新日時を維持・復元する指定を使わず、Google Driveの通常の更新動作に従って更新日時を更新する。更新日時を維持する特殊なAPI呼び出し・ツールの利用は対象外とし、そのための追加の検出・保護処理は実装しない。

P-02mでは、Drive for desktop（Windows）の同期済みローカル編集で更新日時・etagが変わり、古いetagの更新は412で拒否され、ローカル編集が保持された。AI Foundationはetagを不透明な値として扱い、解析・生成しない。

**保証範囲:** 取得後にetagが変わる競合更新があれば、書き込まず409で拒否する。結果不明の書き込みは自動再試行せず、内容の確認を促す。

- PC上のObsidianの未保存の編集、Drive for desktopがまだUploadしていない変更はAPIから見えないため、保証対象外とする。
- 同時に追記した場合の順序は保証しない。
- 条件付き更新はv2 APIを使う（v3では検証時に利用できるetagが得られなかった）。

READMEには通常の利用を前提とすることと、未保存・未同期編集の制約を記載する。更新日時を維持する特殊な更新の説明は対象外の注記に留め、書き込み後の版履歴確認・追加probe・専用の実装テストは追加しない。P-02 Step 7の検証結果は§17の事実記録として残す。

### 10.2 新規作成

Driveは同じ親の下の名前の一意性を保証せず（P-03 Step 1）、名前を条件にした原子的な作成もない。本節の方式は、1つのServer Process内の作成だけを直列化し、それ以外のwriterとの重複は検出するだけである。全writerに対する排他的な作成ではない。

**方式:**

1. **プロセス内の直列化**: 親フォルダのIDと、名前をNFC・小文字化した値の組をキーに、同じキーの作成をProcess内で1件ずつ実行する（`DriveCreateLock`、`createConnectors` で1つ作り、Knowledge・Life LogのStorageで共有する）。Step 2〜4をlockの中で行う。
2. 作成前確認（§9.4 Step 2）。同名があれば作成せず `ConflictError`。
3. `createFile`。
4. 作成後確認: 親フォルダの同名項目（§7.3の作成時規則）を一覧する。自分の作成分以外があれば `ConflictError` を返す。メッセージでは、ファイルは作成済みであること、同じ名前（大小文字・NFCの違いを含む）の別のファイルがあること、Google Driveで確認・整理する必要があることを示す。**自分の作成分は取り消さない。**

作成後に重複を見つけても取り消さない理由: 本当に同時の作成では全要求が取り消して0件になることが多い（P-03 Step 3c）。また、取り消すまでの間に他のClientが作成したファイルを編集していた場合、その編集までゴミ箱へ移してしまう。

**保証すること:**

- 既存ファイルを上書きしない（`files.create` は常に新規作成）。
- 同一Process内の同じキーの作成処理は直列化する。
- 作成前の一覧に同名候補（§7.3の作成時規則）があれば作成しない（409）。
- 作成後の一覧に他の同名候補があれば、作成済みであることを示して409を返し、取り消さない。
- 検出された曖昧なパスは、以後の操作で1件を選ばず拒否する（§7.3）。名前が完全に一致する重複は、取得・追記・検索・作成のいずれも409。大小文字・NFCだけが異なる名前は別のパスであり、取得・追記は完全一致でそれぞれを対象とし、作成だけが409になる。

**保証しないこと（READMEに書く）:**

- 名前の一意性。直列化は処理の順序を決めるだけで、直前の作成が次の要求の一覧へ必ず反映されることは保証しない。一覧への反映が遅れれば、同一Process内の直列化された2件目も作成され得る（作成後確認で見えれば作成済みの409、見えなければ成功を返す）。
- 複数のProcess（同じDrive Vaultを使うMCP Server〈stdio〉とHTTP Serverを同時に起動した場合、複数のServer・replica）からの同時作成。Process内のlockは他のProcessを排他しない。
- Drive for desktop・Obsidian・他のClientによる同時作成。作成後確認の時点で見えなければ検出できない。
- 作成要求の結果不明（§9.4 Step 5）。結果不明の作成を次の要求へ引き継ぐ予約は持たない。

**運用条件（READMEに書く）:** Drive保存で書き込みを行うServerは1 Processにする。クラウドへ配置する場合も、replicaを1つにする。複数Process・replicaへ拡張する場合は、Process間で共有する排他（Q8）を先に設計する。

**`createExclusive` の契約との差:** Filesystemの `O_EXCL` は原子的で、他のwriterを含めて同時作成の成功は1件だけである。Driveの `createExclusive` は上記の範囲に限られる。成功を返しても、同じ名前のファイルが他にも作られている、または後から作られる可能性がある。また、作成後確認による `ConflictError` の場合はファイルが作成済みである。名前の一意性を保証するには、成功・結果不明の作成を次の要求へ引き継ぐ予約等が別途必要で、本Planでは持たない。`createExclusive` のInterfaceのコメントとREADMEにこの差を書く。

- 他の重複・同期の競合コピーは整理しない。

---

## 11. エラー分類（`src/connectors/google/errors.ts`）

Calendarの `toFoundationError` のうちGoogle共通の分類（`invalid_grant`・401・403・Rate Limit）を `src/connectors/google/errors.ts` に移し、Provider名とDrive固有の分類を引数で受け取る。Calendarの挙動・メッセージは変えない（既存テストで確認）。

| 状況 | Error | HTTP |
|---|---|---|
| OAuth環境変数が未設定 | `MissingCredentialError`（`Google credential is not configured: set …`） | 503 `credential_missing` |
| Refresh Token失効（`invalid_grant`） | `CredentialError`（`npm run auth:google -- --drive` を案内） | 502 `provider_auth_failed` |
| 401 | `CredentialError` | 502 |
| 403 Scope不足（`insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT`、Drive API未有効化を含む） | `CredentialError`（`--drive` での再認可・Drive APIの有効化を案内） | 502 |
| 403 ファイル単位の権限不足（`insufficientFilePermissions`） | `ProviderApiError`（そのIDに書き込めない） | 502 |
| 403 / 429 Rate Limit | `ProviderApiError` | 502 |
| Vaultルート・設定Directoryが404・フォルダでない・ゴミ箱内・ショートカット・重複 | `ConfigurationError`（設定Keyを示す。フォルダIDは出さない） | 503 |
| 対象ファイルがない・操作中に削除された | `NotFoundError`（既存メッセージ） | 404 |
| 同名候補が複数 | `ConflictError` | 409 |
| 作成後確認で他の同名項目を検出（§10.2） | `ConflictError`（作成済みであることを示す） | 409 |
| 古い版からの追記（§10.1方式A） | `ConflictError` | 409 |
| 5xx・通信断・タイムアウト | `ProviderApiError`（書き込みでは結果不明を示す） | 502 |

- SDK・Googleが書いた文は `providerText` に入れ、HTTPでは省く。メッセージにはfile ID・フォルダID・Tokenを入れない（ID・パスはFoundation IDで示す）。
- Provider名は `Google Drive`。

---

## 12. Acceptance Criteria（AC-D05・AC-D06）

AC-D01〜D04・D07は変更しない。AC-D05・AC-D06は次のとおりとする。

| ID | 条件・観測結果 | 検証方法 |
|---|---|---|
| AC-D05 | 新規作成は既存ファイルを上書きしない。同一Process内の同じキー（親フォルダ＋大小文字・NFCを無視した名前）の作成処理は直列化する。作成前の一覧に同名候補があれば作成せず409。作成後に他の同名候補が見えた場合は、作成済みであることを示して409を返し、取り消さない。一覧への反映遅延・結果不明・複数Process・他のClientを含めた名前の一意性は保証しない（READMEに運用条件として書き込むServerは1 Processと明記）。検出された曖昧なパスは以後の操作で1件を選ばず拒否する（§7.3） | Fake Driveによる自動テスト（直列化、一覧の反映遅延、外部writerの割り込み、削除しないこと）、実API検証P-03の証跡 |
| AC-D06 | AI FoundationとObsidian／Drive for desktopの通常の更新を前提とする。追記は取得したbyte列を保持して末尾に加え、AI Foundationは更新日時を維持する指定を使わない。取得後にetagが変わる競合更新があれば、v2の条件付き更新で書き込まず409。結果不明は再試行せず、確認を促すErrorを返す。未保存・未同期編集は保証対象外。更新日時を維持する特殊な更新は対象外で、追加の検出・保護処理は不要（§10.1） | Fake Driveによる自動テスト（割り込み更新で409、本文の保持）、実API検証P-02（Step 6）・P-02mの証跡 |

---

## 13. 追加・変更予定ファイル

### 13.1 検証フェーズ

| File | 内容 |
|---|---|
| `src/connectors/google-drive/client.ts`（Scope定数のみ先行） | `GOOGLE_DRIVE_SCOPES` |
| `scripts/google-auth.ts` | `--drive`、付与Scopeの確認（§6.2） |
| `scripts/probe-google-drive.ts` | P-01〜P-03（§4.2） |
| `package.json` / `package-lock.json` | `@googleapis/drive@27.0.0`（v2・v3を含む） |
| `.env.example` | `GOOGLE_DRIVE_PROBE_FOLDER_ID`（probe専用）、`--drive` の説明 |

### 13.2 本実装フェーズ

| File | 内容 |
|---|---|
| `src/config/schema.ts` | `knowledge.obsidian` のdiscriminated union（§5） |
| `src/credentials/env.ts` | 未設定メッセージ（§6.3） |
| `src/connectors/google/errors.ts`（新規） | Google共通のError分類（§11） |
| `src/connectors/google-calendar/client.ts` | 共通分類の利用（挙動不変） |
| `src/connectors/google-drive/client.ts` | `DriveApi`、`createDriveApi`、`lazyDriveApi`、Drive固有のError分類 |
| `src/connectors/obsidian/storage.ts` / `lifelog-storage.ts` | `append` の変更（§8） |
| `src/connectors/obsidian/vault-directory.ts` / `filesystem-storage.ts` / `filesystem-lifelog-storage.ts` | `append(compose)` への対応（書き込み方法は不変）。デコード関数を共有用に切り出す |
| `src/connectors/obsidian/connector.ts` / `lifelog-connector.ts` | `append` の呼び出し変更 |
| `src/connectors/obsidian/drive-vault-directory.ts` / `drive-storage.ts` / `drive-lifelog-storage.ts`（新規） | §7・§9・§10 |
| `src/connectors/obsidian/drive-create-lock.ts`（新規） | `DriveCreateLock`: キー（親フォルダID＋NFC・小文字化した名前）ごとに非同期処理を1件ずつ実行する。異なるキーは並行。例外時もlockを解放する（§10.2） |
| `src/connectors/index.ts` | `storage` によるStorageの選択。Driveでは `lazyDriveApi(credentials)` と `DriveCreateLock` を1つずつ作り、Knowledge・Life Logで共有 |

### 13.3 Tests

| File | 内容 |
|---|---|
| `tests/connectors/google-drive/fake-drive.ts`（新規） | メモリ上のDrive: 同名項目・ショートカット・Google Docs・ゴミ箱・ページ分割（小さいpageSize）・版の履歴・v2 etag（不透明な値として扱い、通常の更新時に変更する）・条件付き更新・作成直後の一覧遅延・任意の時点への割り込み更新（外部writerの作成を含む）・失敗注入。要求ごとに一時停止でき、作成前確認・作成・作成後一覧の順序をテストから指定できる |
| `tests/connectors/google-drive/client.test.ts`（新規） | queryのエスケープ、`trashed = false`、全ページ取得、`fields`、uploadType、条件header、書き込みの `retry: false`、Scope定数 |
| `tests/connectors/google/errors.test.ts`（新規） | §11の分類、Provider文の分離 |
| `tests/connectors/obsidian/storage-contract.ts`（新規） | Knowledge・Life Log StorageのContract Test。Filesystem（一時Vault）とDrive（Fake）の両方で同じfixture（日本語・空白・予約文字の名前、Frontmatter、CRLF、BOM、不正UTF-8、空ファイル）を実行 |
| `tests/connectors/obsidian/drive-vault-directory.test.ts`（新規） | §7.2・§7.3・§7.4の境界・曖昧さ・ページ分割、§9.3のbyte保持、§10.1の競合（本文取得後・v2 get と本文取得の間の通常の割り込み更新で409）。§10.2は次の各場合で、各要求の結果と残る件数が§10.2の記述どおりであること: 同一Process内の同じキーの同時作成が直列化されること（2件目の作成前確認は1件目の作成後に行われ、一覧に反映されていれば409）、一覧の反映遅延を同一Processの直列要求にも適用した場合（2件目も作成され、作成後確認で見えれば作成済みの409、見えなければ成功）、大小文字・NFCだけが異なる名前の同時作成、異なる名前の並行作成、外部writerの作成が作成前確認と作成の間・作成と作成後確認の間に入る場合（作成済みの409、作成分は残る）、残った重複に対する以後の操作（完全一致の重複は取得・追記・検索・作成が409、大小文字・NFCだけが異なる名前は取得・追記がそれぞれ成功し作成が409）、作成の結果不明。いずれもDriveのファイルを削除・ゴミ箱へ移動しないこと |
| `tests/connectors/obsidian/drive-create-lock.test.ts`（新規） | 同じキーは直列、異なるキーは並行、例外時の解放、キーの正規化 |
| `tests/connectors/obsidian/connector.test.ts` / `lifelog-connector.test.ts` / `filesystem-*.test.ts` | `append` 変更への追随、`compose` が例外のとき書き込まないこと |
| `tests/config/schema.test.ts` | union（`filesystem` の既存設定がそのまま通る、`google_drive` に `vault_path`、不正な `vault_folder_id`、Directory重複） |
| `tests/credentials/env.test.ts` | メッセージ変更 |
| `tests/connectors/google-calendar/client.test.ts` | 共通化後も既存の期待値のまま通ること |
| `tests/http/routes.test.ts` | Fake Drive上のObsidian ConnectorでKnowledge 4操作・Life Log 3操作、曖昧時の409、Credential系のHTTP変換（Provider文・IDを含まない） |
| `tests/integration/obsidian-drive.integration.test.ts`（新規） | §15 |

### 13.4 Documentation

| File | 内容 |
|---|---|
| `docs/specs/google-drive-storage.md`（新規） | 設定、境界、同名・大小文字の扱い、競合の保証範囲、エラー |
| `README.md` | 「Obsidian」「Life Log」にDrive保存の設定と制約、「Google Calendar」をGoogle OAuth（Calendar・Drive）として再構成、`drive` Scopeの説明（§6.1） |
| `config.yaml` | `google_drive` の書き方のコメント |
| `.env.example` | Google OAuthの説明をCalendar・Drive共通に |

---

## 14. 実装順序

| # | 内容 | 完了条件 |
|---|---|---|
| 1 | §13.1（Scope定数・`auth:google --drive`・probe・依存追加） | typecheck・build・`npm test` が成功 |
| 2 | 利用者が§4.1を準備し、P-01〜P-03を実行。結果を§17に記録し、§10・§12を確定してPlan Reviewへ | 証跡（対象コミット・Scope・status・最終本文・file ID）がPRに残っている |
| 3 | Google共通Error分類の切り出し | Calendarの既存テストが無変更で成功 |
| 4 | Storage interfaceの `append` 変更とFilesystem・Connectorの追随 | 既存のObsidian・Life Logテストが成功（Filesystemの挙動不変） |
| 5 | Config schema・Credentialメッセージ | `tests/config`・`tests/credentials` |
| 6 | Drive API Client・Fake Drive | `client.test.ts` |
| 7 | `DriveVaultDirectory`・Drive Storage | Contract Test・境界テスト・競合テスト |
| 8 | `createConnectors` の選択 | HTTP・MCPの回帰テスト |
| 9 | Integration Test | 検証用Vaultで成功（§15） |
| 10 | Documentation | README・spec・config.yamlコメント |
| 11 | 全体確認 | `npm run typecheck` / `npm run build` / `npm test` が成功 |

---

## 15. Integration Test（`tests/integration/obsidian-drive.integration.test.ts`）

- `AI_FOUNDATION_INTEGRATION=1` かつ `GOOGLE_DRIVE_IT_VAULT_FOLDER_ID` が設定されたときだけ実行する。個人のVault（`vault_folder_id`）は使わない。
- 検証用Vaultに `knowledge_dir` と `directory`（`config.local.yaml` の値）のフォルダを事前に用意する。テストはフォルダを作らない。
- Knowledge 4操作・Life Log 3操作を実APIで実行し、日本語・空白・`'` を含むタイトル、Frontmatter、CRLFの手動ファイル（テストがDrive APIで直接作る）への追記を確認する。
- 作成したファイルは `afterAll` でDrive APIから直接ゴミ箱へ移す（Connectorは削除しない）。
- 実API競合（AC-D05・D06）はprobe（§4）の証跡で確認し、Integration Testでは繰り返さない。
- `npm test`（通常テスト）からは分離されている（既存の `vitest.integration.config.ts`）。

---

## 16. 懸念点 / 未確定事項

### Q1. 作成時の同名判定で大小文字・NFCを無視する

取得・追記は完全一致、作成は大小文字・NFCを無視（§7.3）。Filesystem（Windows）では大小文字違いの取得も成功するため、Filesystemで動いていた大小文字違いのIDがDriveでは404になる。IDは常に `knowledge_search` / `lifelog_create` の返した値を使う前提で、READMEに記載する。

### Q2. 検索の曖昧さを検索全体のErrorにする

重複が1か所でもあると、整理するまで `knowledge_search` 全体が409になる。代替案は「曖昧なパスを除外し、結果に警告を含める」だが、現在の検索結果の型に警告の項目がなく（malformedはstderrのみ）、Clientに伝わらない。本Planは全体のErrorを採る。

### Q3. 追記の412で自動的にやり直すか

方式Aの拒否は「書き込まれていない」ことが確定しているため、読み取りからのやり直しは安全である。本Planではやり直さず409を返す（呼び出し元の再実行に任せる）。Drive同期が頻繁に更新するファイルで409が多い場合は、1回だけ内部でやり直す変更を検討する。

### Q4. 5 MiBの上限

5 MiBはGoogle APIの上限ではなく、resumable uploadを実装しないためのアプリ独自の上限である（§3）。Resumable uploadを使えばこの上限はなくなるが、実装とテストが増える。Filesystem保存に上限がないこととの差をREADMEに書く。

### Q5. 共有ドライブ

対象外とする。実際のVaultがマイドライブにあることをP-01 Step 10で確認する。共有ドライブにあった場合は、`supportsAllDrives`・`corpora=drive`・権限の検証を本Planに加えてから実装する。

### Q6. 検索の性能

検索はフォルダごとの一覧と全ファイルの本文取得を毎回行う（Filesystem実装と同じくCacheしない）。ファイル数が数百件ならRate Limit（ユーザーあたり毎分の要求数）内に収まる想定。Integration Testで所要時間を記録し、問題があればフォルダ一覧のCache等を別途検討する。

### Q7. OAuth同意画面の公開ステータス

`drive` は制限付きScopeのため、「本番環境」でも未確認アプリの警告が出る。個人利用では利用可能だが、Google側の方針変更でRefresh Tokenの扱いが変わり得る。READMEに再認可の手順を書く。

### Q8. 複数Process間で共有する作成の排他

§10.2の運用条件（書き込むServerは1 Process）を外す場合の候補。現段階では設計・実装しない。

- **親フォルダのメタデータによる予約**: 親フォルダの `appProperties` に予約（作成する名前・期限・要求ID）を、取得したフォルダの版に対する条件付き更新で書き込み、成功した要求だけが作成する。P-02の条件付き更新がフォルダのメタデータ更新にも効くこと、ファイルの作成で親フォルダの版が変わるかをprobeで別途確認する必要がある。期限切れの予約の扱い、利用者のフォルダへメタデータを書き込むこと、Drive for desktop・Obsidianは予約に参加しないことが制約になる。
- **固定file IDのlockファイル**: file IDの一意性は作成時に原子的に検査される（P-03 Step 4）。`generateIds` で一度だけ得たIDを親フォルダごとのlock用として決め、そのIDでlockファイルを作成できた要求だけが作成し、終わったらlockファイルを削除する。lock用IDの保管場所（Config等）、削除後に同じIDで再作成できるか（ゴミ箱へ移しただけではIDは使用中のまま）、異常終了で残ったlockの扱い、Drive for desktop・Obsidianは参加しないことを、probeと設計で確認する必要がある。
- いずれの候補も、Drive for desktop・Obsidian・他のClientは排他に参加しない。

---

## 17. 検証結果

| 項目 | 内容 |
|---|---|
| 実施日 | 2026-11-14 |
| 対象コミット | P-01・P-02 Step 1〜5・P-03: `87938f8`、P-02 Step 6・7: `68a77af`（`scripts/probe-google-drive.ts`） |
| 実行環境 | ローカルWindows、Node 24、`@googleapis/drive 27.0.0`、全要求 `retry: false` |
| 対象 | マイドライブの検証用フォルダ（`AI Foundation Probe`）。手動ファイルはDrive for desktopで置いた `test.md`（33 bytes）1件 |
| P-02m | `68a77af`、Drive for desktop（Windows）の同期フォルダでの手作業を挟んで実施 |
| 未実施 | P-03m（Drive for desktopでの同名ファイルの同時作成） |

各Stepの記録（JSON Lines）は、file IDを含むためRepositoryには置かない。

### 17.1 P-01

| Step | 結果 |
|---|---|
| 1 | 付与Scope: `calendar.calendarlist.readonly`、`calendar.events`、`drive`（要求どおり） |
| 2 | Calendar `calendarList.list`: 200 |
| 3 | 検証フォルダ: folder、ゴミ箱外、`ownedByMe: true` |
| 4 | 子は1件のみで、`pageSize=2` でも1ページ。ページ分割は確認できていない（Fake Drive・Integration Testで確認する） |
| 5 | 手動ファイル: `mimeType: text/plain`、`size` 33、`md5Checksum` と取得した本文が一致、`headRevisionId`・`version` あり |
| 6 | `name = 'TEST.MD'` で `test.md` が見つかった: 名前検索は大小文字を区別しない |
| 7 | 日本語・空白・`'` を含む名前で作成: 成功、`mimeType: text/markdown`。エスケープした名前で検索して完全一致1件 |
| 8 | `uploadType=media` で更新: `version` 1 → 3、`headRevisionId` が変化、`mimeType` は変わらない |
| 9 | 更新後の `headRevisionId` を `revisions.get alt=media`: 現在の本文と一致 |
| 10 | Vaultフォルダ: folder、ゴミ箱外、`ownedByMe: true`、`driveId` なし（マイドライブ） |

### 17.2 P-02

| Step | 結果 |
|---|---|
| 1 | v3 `files.get` の応答にETag headerなし。v2 `files.get` はetagを返す |
| 3a | v3の条件付き更新: 送るetagがないため未実施 |
| 3b | v2 `files.update`（`uploadType=media`）＋ `If-Match: <Bの古いetag>`: **412 `conditionNotMet`**。最終本文はAの追記のみ |
| 3c | v2で取得し直したetag: 成功。最終本文はAの追記＋Bの追記 |
| 4 | Bがメタデータ取得（r1）→ Aが更新（r2）→ `alt=media` はr2の本文、`revisions.get(r1)` はr1の本文 |
| 5 | 条件なしでBが古い本文から更新: 成功し、Aの追記が失われた |
| 6 割り込みなし | Bのv2 `files.get` → `revisions.get`（元の本文）→ 条件付き更新: 成功。最終本文はBの追記 |
| 6 本文取得後にAが更新 | Bの条件付き更新: **412 `conditionNotMet`**。最終本文はAの更新のみ（Bの追記なし） |
| 6 v2 get と本文取得の間にAが更新 | `revisions.get` はv2 `files.get` 時点の元の本文を返した。Bの条件付き更新: **412**。最終本文はAの更新のみ |
| 7 `noChange` | Aの更新は成功し、本文・`version`・`headRevisionId` は変化、更新日時は維持、**etagは不変**。Bの古いetagでの条件付き更新: **成功**。最終本文はBの追記のみで、Aの更新は上書きされた |
| 7 `fromBody`（元の日時） | `noChange` と同じ（更新日時は維持、etagは不変、Bの更新が成功し、Aの更新は上書きされた） |
| etag | 観測したv2 etagはいずれも更新日時のepoch millisecondsをBase64にした値（§10.1） |

#### P-02m

| Step | 結果 |
|---|---|
| 1 | Bがv2 `files.get` → `revisions.get` で元の本文を取得 |
| 2 | 同期フォルダで `LOCAL EDIT` の行を加えて保存し、同期の完了後: 更新日時・etag・`headRevisionId` がいずれも変化 |
| 3 | Bが取得時のetagで条件付き更新: **412 `conditionNotMet`** |
| 4 | 最終本文はローカル編集を含み、Bの追記はない |
| 5 | Drive上の同名・類似名のファイルは1件（競合コピーなし） |

### 17.3 P-03

| Step | 結果 |
|---|---|
| 1 | 2要求×3回・5要求×3回の同時作成: 全要求が成功（同じ名前のファイルが2件・5件） |
| 2 | 作成直後・1秒後・5秒後の名前一覧: 6回とも全件が見えた |
| 3a | 作成後確認で自分の作成分を取り消す手順。作成前確認×2 → Aの作成 → A作成後確認 → Bの作成 → B作成後確認: A成功、Bは取り消して409。残存1件 |
| 3b | 作成前確認×2 → Aの作成 → Bの作成 → A作成後確認 → B作成後確認: Aは取り消して409、B成功。残存1件 |
| 3c | 同じ手順を5要求で同時実行×10回: 9回は成功0件・残存0件、1回は成功1件・残存1件。成功2件以上は0回 |
| 4 | 同じ生成IDで2要求を同時に作成: 1件成功、1件は409 `fileIdInUse`。残存1件 |
| 後片付け | 作成した76件をゴミ箱へ移動（失敗0件） |

### 17.4 確定・設計レビューへ戻す事項

| 事項 | 状態 |
|---|---|
| 追記の方式 | 方式A（v2の条件付き更新、§10.1）を採用する。本実装の手順をStep 6で検証し、同期済みDrive for desktop編集が保持されることをP-02mで確認した。通常のAI FoundationとObsidian／Drive for desktopの更新を前提とし、更新日時を維持する特殊な更新は対象外とする。追加の履歴確認は行わない（§10.1、AC-D06） |
| 本文と版の対応 | 追記は `revisions.get` でetagと同じ版の本文を読む（§7.1・§9.3） |
| MIME type | 絞らない（Drive for desktopの `.md` は `text/plain`） |
| 名前検索 | 大小文字を区別しないため、完全一致は呼び出し側で確認する（§7.1） |
| 共有ドライブ | Vaultはマイドライブ。Q5の前提どおり |
| 新規作成 | 作成後の取り消しは行わない（Step 3cで全要求の取り消しが多く、取り消しは他のClientの編集も移動し得る）。Process内の直列化＋作成前・作成後の重複検出とし、名前の一意性は保証しない。書き込むServerは1 Processとする（§10.2、AC-D05） |
| Storage interface | §8のとおり `append(compose)` に変更する。Drive側の版情報（etag・`headRevisionId`）はStorage内部に閉じる |

---

## 18. 実装で確定した事項

### 18.1 Verification結果（2026-11-14、ローカルWindows・Node 24.20.0、ブランチ `feat/google-drive-storage` の `d894d88`）

| 確認 | 結果 |
|---|---|
| `npm run typecheck` | 成功 |
| `npm run build` | 成功 |
| `npm test` | 71 files、1898 passed、5 skipped |
| Calendarの既存テスト | Google共通Error分類の切り出し後も無変更で成功 |
| Filesystem保存の既存テスト | `append(compose)` への変更後も成功（外部編集を挟むテストは、`compose` の中で外部編集を行う形に変更） |
| Integration Test（`obsidian-drive.integration.test.ts`、`d894d88`） | マイドライブの検証用Vaultで5件成功（2回実行）。Knowledgeの作成（日本語・空白・`'` を含む名前、`text/markdown`）・検索・取得・追記、別Clientが作ったCRLF・`text/plain` のファイルへの追記（改行コード・MIME typeを保持）、同一Processの同名同時作成で成功1件・409が1件、Life Logの作成・取得・追記。作成したファイルは終了時にゴミ箱へ移動 |
| 検索の所要時間（Q6） | 数件のKnowledge Directoryで `knowledge_search` 2.3秒。テスト全体は約39秒（取得・追記・作成は1操作あたり数回の要求を順に行う） |

### 18.2 Planからの細部の変更・Plan外の変更

| 項目 | 内容 | 理由 |
|---|---|---|
| 検索時の本文の読み方 | `VaultStorage.list()` の各項目に任意の `read()` を持たせ、Drive保存では一覧で見つけたファイルをその検索の中だけFile IDで読む（§9.1 Step 5）。呼び出しをまたいで保持しない | ファイルごとにVaultルートから解決し直すと、1件あたり7回前後の要求になり、数百件のVaultで検索が数十秒かかる。一覧後に移動・削除されたファイルは、Filesystemと同じく404で除外される（ゴミ箱へ移されただけのファイルは、Driveが同じIDで返すため、その検索では読まれ得る） |
| `VaultStorage.append` / `LifeLogStorage.append` の戻り値 | 読み取ったファイルを返す（§8） | Connectorが `compose` の外で読み取り内容を使えるようにするため |
| `DriveRevision` | `mimeType` を含める | 追記で既存ファイルのMIME type（Drive for desktopの `text/plain` 等）を変えないため、v2 `files.get` の同じ応答から取得する |
| `DriveApi` | `trash` を持たない | AI FoundationはDrive上のファイルを削除・ゴミ箱へ移動しない（§10.2）ため |
| 共通化 | エラーのラベル（`labels.ts`）とデコード（`decode.ts`）をFilesystem・Driveで共有 | 同じID・メッセージ・デコード規則にするため |
| Rate Limitの理由 | Google共通は既存の3件のまま。Driveは `dailyLimitExceeded`・`sharingRateLimitExceeded` を加える | Calendarの分類を変えないため |
| `invalid_grant` の案内 | Calendarは従来どおり `npm run auth:google`、Driveは `npm run auth:google -- --drive` | Calendarの挙動・メッセージを変えないため |
| 作成後確認の失敗 | 作成後の一覧が失敗した場合は、作成済みであることを示す `ProviderApiError` | 作成は成功しているため、結果不明とは区別する |
