# Google Drive保存（Knowledge／Life Log） — Design

[Issue #34](https://github.com/thanatos27/ai-foundation/issues/34) の仕様。実装の詳細と実API検証の結果は [Implementation Plan](../plans/google-drive-storage-implementation-plan.md) を参照。

## Goal

Google Driveに同期しているObsidian Vaultを、Google Drive APIで直接読み書きできるようにする。手元のFilesystemを通さないため、クラウド上のServerからも同じMarkdownを操作できる。Obsidianは同期フォルダを使い続け、Vaultの移行・コピーはしない。

- `obsidian` はMarkdownの管理方式、`storage` はアクセス方法とする。
- Knowledge・Life LogのDomain、ID（`obsidian:<Vault相対パス>` / `lifelog:<ファイル名>`）、`external_ref`、操作ルール、REST API・MCP Toolは変えない。DriveのFile IDは外へ出さない。
- Filesystem保存（`storage: filesystem`）は引き続き使える。
- 独自DB、同期エンジン、常駐Indexer、Cacheは持たない。

## 対象外

クラウド配置・HTTPS終端、Muse・ChatGPT用のAdapter、共有ドライブ、Google Docsへの変換、画像・動画の管理、自動マージ・競合ファイルの整理、Life Logの一覧・検索、複数Process間の作成の排他。

## 設定

```yaml
sources:
  knowledge:
    obsidian:
      storage: google_drive
      vault_folder_id: "<VaultのルートフォルダのID>"   # config.local.yaml に書く
      knowledge_dir: "AI Foundation/Knowledge"
  lifelog:
    provider: obsidian
    obsidian:
      directory: "AI Foundation/LifeLog"
```

| 項目 | 内容 |
|---|---|
| `storage` | `filesystem`（`vault_path`）または `google_drive`（`vault_folder_id`）。Life LogはKnowledgeと同じ保存方式・Vaultを使う |
| `vault_folder_id` | マイドライブ上のVaultルートフォルダのID（`^[A-Za-z0-9_-]{10,}$`）。`root` 等の別名は不可。任意で、未設定ならToolが `ConfigurationError` |
| `vault_path` | `google_drive` では指定不可（`vault_folder_id` を使うよう示すConfig Error） |
| Directoryの重複 | Knowledge・Life LogのDirectoryは、設定の文字列（大小文字を無視）と、Drive上のフォルダID（同じ・内側・外側）の両方で重複を拒否する |

## 認証

- Google Calendarと同じOAuthクライアント・環境変数（`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN`）を使う。
- `npm run auth:google -- --drive` で、CalendarのScopeと `https://www.googleapis.com/auth/drive` を同時に要求する。要求したScopeがすべて付与されなければRefresh Tokenを出力しない。`--drive` なしの動作は変えない。
- `drive` ScopeはGoogle側ではDrive全体を管理できる。Knowledge／Life Logのフォルダに限るのはAI Foundation側の境界である。
- 未設定時のCredential Errorは `Google credential is not configured: set …`（Calendar・Drive共通）。

## パス・名前

- Vaultルートから、`knowledge_dir` / `directory` とIDのパスを1階層ずつ名前で解決する。毎回解決し、Cacheしない。
- 取得・追記・途中のフォルダは**名前の完全一致**で探す（Driveの名前検索は大小文字を区別しないため、結果を完全一致で絞る）。
- 同じフォルダに同じ名前の項目が複数ある場合は、どれも選ばない。

| 状況 | 取得・追記 | 作成 | 設定フォルダ |
|---|---|---|---|
| 対象がない | 404 | 作成する | `ConfigurationError`（自動作成しない） |
| 1件 | その項目 | 409 | 使う |
| 同名が複数 | 409 | 409 | `ConfigurationError` |

- 作成時の同名判定だけは、大小文字・Unicode正規化（NFC）を無視する（同期先のWindows / macOSで同じ名前になるため）。大小文字・NFCだけが異なる既存の名前は別のパスとして、取得・追記はそれぞれ完全一致で扱う。
- ショートカットは辿らない（設定フォルダの途中なら `ConfigurationError`、IDの途中・対象なら400）。ゴミ箱内の項目は扱わない。Google ドキュメント等（`application/vnd.google-apps.*`）は対象外。
- `.md` の判定は名前だけで行い、MIME typeでは絞らない。

## 操作

| 操作 | Drive上の動作 |
|---|---|
| `knowledge_search` | Knowledge Directoryを再帰的に一覧し、Markdownを本文まで読んで既存どおり照合する（Driveの全文検索は使わない）。一覧で見つけたファイルは、その検索の中ではFile IDで読む。曖昧なパスが1つでもあれば検索全体が409で、曖昧なIDを最大10件示す |
| 取得 | パスを解決し、現在の本文を読む |
| 作成 | `text/markdown` の新規ファイルとして作る（UTF-8、BOMなし）。既存ファイルを上書きしない |
| 追記 | 読み取ったbyte列を保持し、末尾に追記文のUTF-8を加えて、読み取った版に対する条件付き更新で書き込む。名前・親・MIME typeは変えず、更新日時は通常どおり更新する |

- 作成・追記後に5 MiBを超えるファイルには書き込まない（AI Foundationの上限）。
- AI FoundationはDrive上のファイルを削除・ゴミ箱へ移動・改名しない。

## 同時実行と保証範囲

### 追記

v2 `files.get` で取得したetagと `headRevisionId` を基準にし、その版の本文を `revisions.get` で読み、v2 `files.update` に `If-Match` を付けて書き込む。etagは不透明な値として扱い、解析・生成しない。

- 取得後にetagが変わる競合更新があれば、書き込まず409を返す。他の更新は保持される。
- AI FoundationとObsidian／Drive for desktopによる通常の更新を前提とする。更新日時を維持する特殊なAPI呼び出し・ツールでの更新は対象外。
- 未保存の編集、Drive for desktopが未Uploadの変更は保護しない。同時に追記した場合の順序は保証しない。

### 作成

- 同一Process内の、同じフォルダ・同じ名前（大小文字・NFCを無視）の作成処理は直列化する。
- 作成前の一覧に同名候補があれば作成せず409。
- 作成後の一覧に他の同名候補があれば、作成済みであることを示して409を返す。作成したファイルは取り消さない。
- 名前の一意性は保証しない。一覧への反映の遅れ、結果不明の作成、複数Process、他のClient・Drive for desktopとの同時作成では重複し得る。重複が残った場合は、以後の操作で1件を選ばず拒否する。
- Filesystemの `O_EXCL`（原子的で、同時作成の成功は1件だけ）との違い：成功しても同じ名前のファイルが他に作られている可能性があり、作成後確認による409ではファイルが作成済みである。

### 運用条件

書き込みを行うServerは1 Processにする（同じVaultでMCP Server〈stdio〉とHTTP Serverを同時に起動しない。クラウドではreplicaを1つにする）。

### 結果不明

タイムアウト・切断・5xxで書き込みの結果が分からない場合は再試行せず、作成・追記されたか確認してから再実行するよう示す `provider_error` を返す。

## エラー

既存のHTTP／MCPのError分類に従う。メッセージにDriveのFile ID・フォルダID・Token、SDKが書いた文（HTTPでは省略）は含めない。

| 状況 | Error | HTTP |
|---|---|---|
| OAuth環境変数が未設定 | `credential_missing` | 503 |
| Refresh Token失効（`invalid_grant`）、401、Drive Scope不足・Drive API未有効化、その他の403 | `credential`（`npm run auth:google -- --drive` を案内） | 502 |
| ファイル単位の権限不足、Rate Limit、5xx・通信断 | `provider_api` | 502 |
| Vaultフォルダ・設定Directoryが存在しない・フォルダでない・ゴミ箱内・ショートカット・重複・Directoryの重複 | `configuration` | 503 |
| 対象がない | `not_found` | 404 |
| 同名が複数、既存の名前での作成、作成後に同名を検出、読み取り後に変更された追記 | `conflict` | 409 |
| ショートカット経由のID、5 MiBを超える書き込み | `invalid_input` | 400 |
