# Google Drive保存対応（Knowledge／Life Log） — Implementation Plan

- Status: **Draft。実API検証（P-01〜P-03）は未実施。AC-D05・AC-D06は未確定**
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
| ファイルの種類 | `.md` の判定は名前だけで行い、MIME typeでは絞らない | 同期クライアントが付けるMIME typeは一定でない可能性がある（P-01で記録） |
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
npx tsx scripts/probe-google-drive.ts <p01|p02|p03> [--keep] [--manual]
```

| 項目 | 内容 |
|---|---|
| 入力 | `.env` / 環境変数の `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` / `GOOGLE_DRIVE_PROBE_FOLDER_ID`。任意で `GOOGLE_DRIVE_VAULT_FOLDER_ID`（P-01 Step 10のメタデータ取得だけに使う） |
| 安全装置 | 対象フォルダの名前が `AI Foundation Probe` で始まらない、フォルダでない、ゴミ箱内のいずれかなら何もせず終了する。書き込むのは今回の実行で作成したファイル（名前 `probe-<runId>-…`）だけ。手動ファイルは読み取りのみ。`GOOGLE_DRIVE_VAULT_FOLDER_ID` のフォルダは `files.get` 以外の要求を送らない |
| 再試行 | 読み取りを含む全要求で `retry: false` を指定する。SDKの既定の再試行（v2の `PUT` 等）を混ぜずに、各要求の結果をそのまま記録するため |
| 後片付け | 作成したファイルを最後にゴミ箱へ移す（完全削除しない）。`--keep` で残す |
| 出力 | 標準出力にJSON Lines: step、method・endpoint・uploadType・条件header名と値、HTTP status、応答の `id` `name` `mimeType` `version` `headRevisionId` `md5Checksum` `modifiedTime` `size`、応答の `ETag` header、本文のSHA-256。Authorization header・Access Token・Refresh Tokenは出さない |
| `--manual` | Drive for desktopでの手動操作を挟む手順（P-02m・P-03m）で、標準入力のEnterを待つ |

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
| P-02m（`--manual`） | Bが取得した後、利用者がDrive for desktopの同期フォルダで同じファイルを編集・保存し、同期完了を待つ。Bが条件付き更新 | status、最終本文、同期フォルダ側の状態（競合コピーの有無） |

### 4.5 P-03：同名ファイルの同時作成

| Step | 操作 | 記録 |
|---|---|---|
| 1 | A・Bが同じ親・同じ名前で同時に `files.create`（`Promise.all`）。2クライアントで3回、5クライアントで3回 | 各要求のstatus・file ID |
| 2 | 作成直後・1秒後・5秒後に名前で一覧 | 見える件数（一覧の反映遅延の有無） |
| 3a | §10.2の手順を、probeが順序を指定して実行する: A・Bの作成前確認 → Aの作成 → Aの作成後一覧 → Bの作成 → Bの作成後一覧 | 各要求の結果（成功／409）、残った件数、各一覧に相手の作成分が見えたか |
| 3b | 同上の順序違い: A・Bの作成前確認 → Aの作成 → Bの作成 → Aの作成後一覧 → Bの作成後一覧 | 同上（両方が取り消して0件になるか） |
| 3c | 参考として、§10.2の手順を5クライアントで `Promise.all` により10回実行 | 各回の成功数・残った件数 |
| 4 | `files.generateIds` で得たIDを2つの作成要求に同時に指定 | 2件目が拒否されるか（IDの一意性。名前の一意性ではない） |
| P-03m（`--manual`） | 利用者がDrive for desktopで同名ファイルを作るのと同時にAPIで作成 | 同期後のDrive上の件数と名前（` (1)` 付き等） |

P-03の結果は、観測した順序でどうなったかの記録であり、名前の一意性の証明ではない。同一 `createdTime`・異なるfile ID、ゴミ箱移動の失敗、作成の結果不明などの順序・失敗はFake Drive（§13.3）で確認する。

### 4.6 検証結果から確定する事項

| 確定事項 | 根拠 |
|---|---|
| 追記を許可する条件と競合時のレスポンス（§10.1の方式A／B） | P-02 Step 3a・3b・4、P-02m |
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
  headRevisionId?: string; /* P-02で採用した条件の値（etag / version） */
}

interface DriveApi {
  getItem(fileId: string): Promise<DriveItem>;                       // files.get
  /** 全ページを取得してから返す。trashed = false のみ。name指定時もDrive側の一致規則に依らず呼び出し側で完全一致を確認する */
  listChildren(folderId: string, options?: { name?: string }): Promise<DriveItem[]>;
  download(item: DriveItem): Promise<Buffer>;                        // P-02 Step 4の結果で alt=media か revisions.get
  createFile(parentId: string, name: string, bytes: Buffer): Promise<DriveItem>;  // multipart, text/markdown
  /** 取得した版に対する条件付き更新。古ければ StaleRevisionError（P-02で方式を確定） */
  updateContent(item: DriveItem, bytes: Buffer): Promise<DriveItem>;
  trash(fileId: string): Promise<void>;                              // 作成直後の自分のファイルの取り消し（§10.2）だけに使う
}
```

- 一覧のqueryは `'<folderId>' in parents and trashed = false`（＋ `and name = '<escaped>'`）。名前は `\` → `\\`、`'` → `\'` でエスケープする。`pageSize=1000`、`nextPageToken` がなくなるまで取得する。
- `fields` は必要な項目だけを指定する。
- 書き込み（`createFile` / `updateContent` / `trash`）は `retry: false` を指定する。

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
2. `download`（P-02 Step 4の結果により、`headRevisionId` を指定した `revisions.get` またはfile本体）。
3. デコードして返す。

### 9.3 `append`

1. `read` と同じく解決・取得する（版情報を保持）。
2. デコードした内容を `compose` に渡す。`compose` が例外を投げたら書き込まない。
3. 追記後の内容は**取得したbyte列＋追記文のUTF-8**とする。デコード後の文字列から再エンコードしない（Knowledgeの寛容デコードで不正バイトをU+FFFDに置き換えた内容で上書きしないため）。
4. 5 MiBを超える場合は書き込まず `InputValidationError`。
5. `updateContent` で取得した版に対して条件付き更新する。古い版と判定されたら `ConflictError`（「取得後に変更されたため書き込んでいない。再度実行する」旨）。`mimeType`・名前・親は変えない。
6. 通信断・タイムアウト・5xxは `ProviderApiError`（「追記されたか分からない。`knowledge_get` / `lifelog_get` で確認してから再実行する」旨）。再試行しない。

P-02で条件付き更新が成立しない場合の扱いは§10.1。

### 9.4 `createExclusive`

1. §7.4 → 親フォルダ（Knowledge: Knowledge Directory、Life Log: Life Log Directory）を解決。
2. §7.3の作成時規則で同名候補を確認。1件でもあれば `ConflictError`（既存メッセージ）。
3. 5 MiB以下を確認し、`createFile`（multipart、`text/markdown`、UTF-8・BOMなし）。
4. 作成後確認（§10.2）。
5. 作成要求の結果不明は `ProviderApiError`（「作成されたか分からない。取得して確認してから再実行する」旨）。再試行しない。

---

## 10. 競合・同時実行（P-02・P-03後に確定）

### 10.1 追記

| P-02の結果 | 方式 | 保証 |
|---|---|---|
| 3a・3bのいずれかが古い版の更新を412等で拒否し、3cが成功し、Step 4で取得版の本文を確実に得る方法がある | **方式A**: その条件付き更新を `updateContent` に使う。拒否は `ConflictError`（409） | 取得後に他クライアント・Drive同期で更新されていれば書き込まない。既存本文・他の追記を失わない |
| いずれも拒否しない | **方式B**: 設計レビューへ戻す。候補: (B1) Drive保存では追記を `ConfigurationError` として提供しない、(B2) 更新直前の版確認＋更新後の版確認で検出のみ行い、検出時は利用者に確認を求める（確認から書き込みまでの間の更新は失われ得る） | 既存 `append` の契約（既存本文を消さない）を満たせないため、B2を採る場合はACとREADMEで弱まる範囲を明示する |

どちらの方式でも保証しないこと（READMEに書く）:

- PC上のObsidianの未保存の編集、Drive for desktopがまだUploadしていない変更。これらはAPIから見えず、同期時にDrive for desktopの競合処理に委ねられる（P-02mの結果を記載）。
- 同時に追記した場合の順序。

### 10.2 新規作成

Driveは同じ親の下の名前の一意性を保証せず、名前を条件にした原子的な作成もない。作成前確認・作成後確認はどちらも各要求が別の時点で見た一覧に基づくため、本節の方式は排他的な作成ではない。

**方式（勝者を選ばない作成後確認）:**

1. 作成前確認（§9.4 Step 2）。同名があれば作成せず `ConflictError`。
2. `createFile`。
3. 作成直後に親フォルダの同名項目（§7.3の作成時規則）を一覧する。自分の作成分以外が1件でもあれば、自分の作成分をゴミ箱へ移して `ConflictError`（「同じ名前のファイルが同時に作成された。確認してから再実行する」旨）。

勝者を選ばないのは、作成後の一覧を見る時点が要求ごとに異なり、先に成功を返した要求の判断を後の要求が覆せないためである（後の要求だけが規則上の勝者となって成功し、2件が残る）。この方式では、相手が見えた要求は必ず自分の作成分を取り消す。両方が取り消して0件になることはあるが、作成内容は呼び出し元に残っているため失われない。

**保証すること:**

- 既存ファイルを上書きしない（`files.create` は常に新規作成）。
- 作成前に見えた同名項目があれば作成しない（409）。
- 作成後に見えた他の同名項目があれば、自分の作成分を取り消して409を返す。
- 重複が残った場合も、以後の取得・追記・作成・検索は§7.3により409となり、1件を黙って選ばない。

**保証しないこと（READMEに書く）:**

- AI Foundation同士の同時作成で、成功が1件以下になること。各要求の作成後の一覧に、それより前に完了した作成が必ず反映されるなら、後に一覧した要求が先の作成分を見て取り消すため、成功は1件以下になる。しかし一覧への反映についてDriveの文書は保証を示していない。P-03で観測した結果は記録するが、保証の根拠にはしない。
- Drive for desktop・Obsidian・他のClientによる同時作成（AI Foundationの作成後確認に参加しない）。
- 取り消し（ゴミ箱への移動）に失敗した場合。重複が残ったことを示す `ProviderApiError` を返す。
- 作成要求の結果不明（§9.4 Step 5）。作成されているかもしれないファイルは取り消さない。

**`createExclusive` の契約との差:** Filesystemの `O_EXCL` は原子的で、同時作成でも成功は1件だけである。Driveの `createExclusive` は上記の範囲に限られ、「`ConflictError` ならファイルは作られていない」こと、「成功なら同名の他のファイルはない」ことのいずれも、同時作成時は保証しない。この差を受け入れるか、AI Foundationのwriter間で共有する排他（Q8）を設計するかは、P-03の結果とあわせて設計レビューで決める。

- ゴミ箱へ移すのは、その要求で作成した自分のファイルだけ（取り消し）。他の重複・同期の競合コピーは整理しない。
- 本節の方式は暫定の候補である。P-03後の設計レビューでは、結果不明・自己取り消し・`createExclusive` 契約との差に加え、取り消しまでの間に他のClientが自分の作成したファイルを編集した場合（取り消すと編集もゴミ箱へ移る）の扱いを確定する。

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
| 古い版からの追記（§10.1方式A） | `ConflictError` | 409 |
| 5xx・通信断・タイムアウト | `ProviderApiError`（書き込みでは結果不明を示す） | 502 |

- SDK・Googleが書いた文は `providerText` に入れ、HTTPでは省く。メッセージにはfile ID・フォルダID・Tokenを入れない（ID・パスはFoundation IDで示す）。
- Provider名は `Google Drive`。

---

## 12. Acceptance Criteria（AC-D05・AC-D06の確定案）

AC-D01〜D04・D07は変更しない。AC-D05・AC-D06は未確定で、P-02・P-03の結果と設計レビューを経て確定する。以下は確定案の候補。

| ID | 候補 | 確定に必要なこと |
|---|---|---|
| AC-D05 | 新規作成は既存ファイルを上書きせず、作成前に同名（大小文字・NFC正規化を無視）の項目があれば409。作成後に他の同名項目を検出したら自分の作成分を取り消して409。同時作成で成功が1件以下になること、他のClientとの同時作成は保証しない。重複が残った場合も以後の操作は409となる | §10.2の `createExclusive` 契約との差を受け入れるか、Q8の排他を設計するかの決定 |
| AC-D06 | 追記は取得したbyte列を保持して末尾に加える。取得後にDrive上で変更されていれば書き込まず409。結果不明は再試行せず、確認を促すErrorを返す。未同期のローカル編集は保証しない | P-02で§10.1方式Aが成立すること。成立しなければ方式Bの選択に従う |

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
| `src/connectors/index.ts` | `storage` によるStorageの選択。Driveでは `lazyDriveApi(credentials)` を1つ作りKnowledge・Life Logで共有 |

### 13.3 Tests

| File | 内容 |
|---|---|
| `tests/connectors/google-drive/fake-drive.ts`（新規） | メモリ上のDrive: 同名項目・ショートカット・Google Docs・ゴミ箱・ページ分割（小さいpageSize）・版・条件付き更新・作成直後の一覧遅延・任意の時点への割り込み更新・失敗注入。作成は要求ごとに一時停止でき、作成前確認・作成・作成後一覧の順序をテストから指定できる。`createdTime`・file IDをテストから指定できる |
| `tests/connectors/google-drive/client.test.ts`（新規） | queryのエスケープ、`trashed = false`、全ページ取得、`fields`、uploadType、条件header、書き込みの `retry: false`、Scope定数 |
| `tests/connectors/google/errors.test.ts`（新規） | §11の分類、Provider文の分離 |
| `tests/connectors/obsidian/storage-contract.ts`（新規） | Knowledge・Life Log StorageのContract Test。Filesystem（一時Vault）とDrive（Fake）の両方で同じfixture（日本語・空白・予約文字の名前、Frontmatter、CRLF、BOM、不正UTF-8、空ファイル）を実行 |
| `tests/connectors/obsidian/drive-vault-directory.test.ts`（新規） | §7.2・§7.3・§7.4の境界・曖昧さ・ページ分割、§9.3のbyte保持、§10.1の競合。§10.2は次の各場合で、各要求の結果と残る件数が§10.2の記述どおりであること: 両方の作成前確認が終わった後の作成・作成後一覧の各順序、同一 `createdTime`・異なるfile ID、作成後一覧の反映遅延（重複が残り、以後の操作が409）、取り消しの失敗、作成の結果不明 |
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

### Q8. AI Foundationのwriter間で共有する作成の排他

同時作成で成功を1件以下にする必要がある場合の候補。いずれも本Planの方式には含めない。

- **親フォルダのメタデータによる予約**: 親フォルダの `appProperties` に予約（作成する名前・期限・要求ID）を、取得したフォルダの版に対する条件付き更新で書き込み、成功した要求だけが作成する。P-02の条件付き更新がフォルダのメタデータ更新にも効くこと、ファイルの作成で親フォルダの版が変わるかをprobeで別途確認する必要がある。期限切れの予約の扱い、利用者のフォルダへメタデータを書き込むこと、Drive for desktop・Obsidianは予約に参加しないことが制約になる。
- **プロセス内のlock**: 1つのServer Process内の同時作成だけを直列化する。複数Process・複数Server・他のClientは排他できないため、単独では保証の根拠にならない。

---

## 17. 検証結果

未実施。P-01〜P-03の実行後に、対象コミット、要求・付与Scope、各Stepのstatus・最終本文、確定した方式（§10）を記録する。
