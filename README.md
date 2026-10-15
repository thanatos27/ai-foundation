# AI Foundation

各サービスをSource of Truthとして維持しながら、Task / Schedule / Collection / Knowledge / ProjectをAIから統一的に操作するMCPベースの個人AI基盤。

## Source of Truth

| Entity | Source of Truth |
|---|---|
| Task | Todoist |
| Schedule | Google Calendar |
| CollectionItem | Notion |
| Knowledge | Obsidian / Google Drive |
| Project | GitHub / Google Drive |

AI Foundation自身は独自DBを持たず、共通Data Model、Tool Interface、SoTルール、Connector、静的設定を提供する。Routingと複数Toolの組み合わせはAI Clientが判断する。

## Current Phase

Phase 4 — Knowledge。Todoist・Google Calendar・Notion・Obsidian Vaultへ実際に接続し、以下のToolを公開している。

| Tool | 内容 |
|---|---|
| `task_create` | Todoist InboxへTaskを作成（title / status / due / area / tags） |
| `task_list` | Inbox内の未完了Taskを取得（status / area / due_before / due_after / tagsでFilter） |
| `task_update` | `todoist:<id>` を指定して部分更新 |
| `task_complete` | `todoist:<id>` を指定して完了 |
| `schedule_create` | AI Foundation専用Calendarへ予定を作成（時刻予定 / 終日予定） |
| `schedule_list` | 期間を指定し、閲覧可能な全Calendarから予定を取得 |
| `collection_create` | Notionの専用Collectionへ本・ゲーム・映画等を作成（title / collection_type / status / metadata / tags / note） |
| `collection_search` | 専用CollectionをTitle部分一致・collection_type・status・tags（AND）で検索 |
| `collection_update` | `notion:<page-id>` を指定して部分更新（status / metadata（shallow merge）/ tags（置換）/ append_note（本文末尾へ追記）） |
| `knowledge_create` | Obsidian VaultのKnowledge Directory直下へMarkdownを新規作成（title / description / content / area / tags）。既存ファイルは上書きしない |
| `knowledge_search` | Knowledge Directory以下を再帰的に検索（query: title / description / tags / 本文の部分一致、area、tags（AND））。本文全文ではなくsnippetを返す |
| `knowledge_get` | `obsidian:<vault-relative-path>` を指定してMetadataと本文全文を取得 |
| `knowledge_append` | `obsidian:<vault-relative-path>` を指定して本文末尾へ追記（Frontmatterは変更しない） |

Taskの `status`（`next` / `waiting` / `someday`）と `area`（`work` / `personal`）は、`af-` で始まるTodoist Label（`af-next`, `af-area-work` 等）で表現する。`af-` で始まるLabelはAI Foundation用に予約しており、`tags` には含まれない。

CollectionItemの `status` は自由文字列（例: `wishlist` / `playing` / `read`）で、NotionのSelect optionとして保存する。`metadata` は自由形式のObjectで、`Metadata` PropertyにJSON文字列として保存する。感想・読書メモ等の長文は `note` / `append_note` でPage本文の末尾へParagraphとして追記する。

Knowledgeは1件 = 1 Markdown file（UTF-8）で、`title` / `description` / `area` / `tags` をYAML Frontmatterに持つ。IDはVault相対パス（`obsidian:AI Foundation/Knowledge/CAP定理.md`）で、ローカルの絶対パスは含まない。ObsidianでファイルをKnowledge Directory内の別フォルダへ移動するとIDが変わる（旧IDはNot foundになり、`knowledge_search` で新しいIDが見つかる）。

## Getting Started

### Prerequisites

- Node.js 24以上
- npm 11以上

### Install

```sh
npm install
```

### Build

```sh
npm run build
```

`dist/` にJavaScriptが出力される。

### Test

```sh
npm run typecheck
npm test
```

`npm test` は外部Serviceへ通信せず、個人のObsidian Vaultにもアクセスしない（Knowledgeのテストは一時Directoryに作るVaultを使う）。実際のTodoist / Google Calendar / Notion / Obsidian Vaultに対するIntegration Testは、Credentialと `writable_calendar_id` / `data_source_id` / `vault_path` を設定したうえで明示的に実行する。設定されていないServiceのTestはskipされる。テストで作成したTask / Event / Markdownは終了時に削除し、NotionのPageはゴミ箱へ移す。ObsidianのIntegration Testは検証専用のVault（または検証専用の `knowledge_dir`）で実行する。

```sh
AI_FOUNDATION_INTEGRATION=1 npm run test:integration
```

### Start the MCP Server

MCP ServerはMCP Clientからstdioで起動される。手動で起動確認する場合は以下を使う。

```sh
npm start        # node dist/index.js（要Build）
npm run dev      # tsx src/index.ts（Build不要）
```

起動するとstdinでMCPメッセージを待ち受ける。終了はCtrl+C。

## Configuration

静的設定は `config.yaml` に記述する（仕様: [MVP v0.1 §13](docs/specs/mvp-v0.1.md)）。Project一覧などの動的データやToken等の認証情報は記述しない。未知のKeyを含むConfigは起動時にErrorとなる。

読み込むファイルは以下の優先順位で決まる。

1. `--config <path>` 引数
2. 環境変数 `AI_FOUNDATION_CONFIG`
3. Repository直下の `config.yaml`

Configが不正な場合、理由をstderrへ出力して終了コード1で終了する。

```text
[ai-foundation] Invalid configuration in config.yaml:
  - sources.task.provider: Invalid input: expected "todoist"
```

### ローカル設定（`config.local.yaml`）

予定の書き込み先Calendar ID（`sources.schedule.writable_calendar_id`）、CollectionのNotion Data Source ID（`sources.collection.data_source_id`）、Obsidian VaultのPath（`sources.knowledge.obsidian.vault_path`）は個人の値のため、Public Repositoryにある `config.yaml` には書かない。`config.yaml` を `config.local.yaml`（Git管理外）へコピーして設定し、`--config` または `AI_FOUNDATION_CONFIG` で指定する。

```yaml
sources:
  schedule:
    provider: google_calendar
    writable_calendar_id: "xxxxxxxx@group.calendar.google.com"
  collection:
    provider: notion
    data_source_id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  knowledge:
    default: obsidian
    providers:
      - obsidian
    obsidian:
      storage: filesystem
      vault_path: "C:/Users/you/Documents/Obsidian/MyVault"
      knowledge_dir: "AI Foundation/Knowledge"
```

未設定でもServerは起動する。`writable_calendar_id` がなければ `schedule_create` が、`data_source_id` がなければCollectionの3 Toolが、`vault_path` / `knowledge_dir` がなければKnowledgeの4 ToolがConfiguration Errorになる。

### Obsidian

KnowledgeはObsidian VaultのMarkdownとしてFilesystem経由で読み書きする。Credentialは不要。

1. Vault内にAI Foundation用のKnowledge Directory（例: `AI Foundation/Knowledge`）を作成する。AI Foundationは自動作成しない
2. `config.local.yaml` の `sources.knowledge.obsidian` に `vault_path`（Vaultの絶対パス）と `knowledge_dir`（Vault相対パス、`/` 区切り）を設定する。YAMLでWindowsのパスを書く場合は `/` 区切り（`"C:/Users/..."`）か単一引用符（`'C:\Users\...'`）にする（二重引用符内の `\` はEscapeになる）

読み書きは `knowledge_dir` 以下の `.md` だけに限定される。`knowledge_create` は `knowledge_dir` 直下に作成し、`knowledge_search` はサブフォルダも含めて検索する。Obsidian上でファイルを編集・サブフォルダへ移動・削除してよく、次のTool呼び出しで現在のファイル状態が反映される（独自のIndexやCacheは持たない）。

- ファイル名は `title` から作る。OSやObsidianのLinkで使えない文字（`/ \ : * ? " < > | # ^ [ ]`）は空白に置き換える。同名ファイルが既にあれば上書きせずErrorになる
- `tags` はObsidianのTag規則に従う（`#` なし、空白なし、英字・数字・`_` `-` `/`・日本語等、数字だけは不可）。比較は大文字小文字を区別しない
- `knowledge_append` は本文末尾へ段落として追記するだけで、Frontmatter・既存本文は変更しない。日時や見出しは付けない
- Frontmatterが壊れている（YAMLとして読めない、`area` が `work` / `personal` 以外、`tags` がTag規則に合わない等）ファイルは検索結果から除外され（stderrに件数とPathを出す）、`knowledge_get` / `knowledge_append` はErrorになる。AI Foundationは自動修復しないので、Obsidianで直す
- FrontmatterのないMarkdownも扱える（titleはファイル名）。AI Foundationが知らないFrontmatter Key（`aliases` 等）はそのまま残る
- `vault_path` 自体は同期フォルダへのSymbolic Link / Junctionでもよいが、Vaultから `knowledge_dir` までと `knowledge_dir` の内側のSymbolic Link / Junctionは辿らない（Configuration ErrorまたはInput Validation Error）

VaultはGoogle Drive等の同期フォルダに置いてよい。AI Foundationは同期を管理せず、手元のFilesystemに見えている状態だけを扱う。同期の競合で作られたファイル（`CAP定理 (1).md` 等）も通常のKnowledgeとして検索される。Google Drive for desktopを「ストリーミング」で使うと検索のたびにファイルの読み込みが発生して遅くなるため、Vaultのフォルダは「ミラーリング」（またはオフラインで使用可能）を推奨する。

## Credentials

認証情報は環境変数で渡す。`config.yaml` には書けない（未知のKeyとして起動時にErrorになる）。変数名は [.env.example](.env.example) を参照。

渡し方は次のいずれか。

- Repository直下の `.env`（`.env.example` をコピー）。Serverは起動時に存在すれば読み込む。`.env` はCommitしない
- MCP Client設定の `env`。`.env` より優先される

Credentialが未設定でもServerは起動する。該当Toolを呼んだときに、不足している環境変数名を含むCredential Errorを返す。

### Todoist

Todoistの [Settings → Integrations → Developer](https://app.todoist.com/app/settings/integrations/developer) でAPI Tokenを取得し、`TODOIST_API_TOKEN` に設定する。

### Google Calendar

1. [Google Cloud Console](https://console.cloud.google.com/) でProjectを作成し、Google Calendar APIを有効化する
2. OAuth同意画面を設定する。公開ステータスが「テスト中」のままだとRefresh Tokenが7日で失効するため、継続利用する場合は「本番環境」へ変更する（未確認アプリの警告は出るが個人利用は可能）
3. 認証情報で「OAuth クライアント ID」（種類: デスクトップアプリ）を作成し、`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` に設定する
4. `npm run auth:google` を実行し、表示されたURLをブラウザで開いて許可する。表示された `GOOGLE_OAUTH_REFRESH_TOKEN=...` を `.env` に追記する（ファイルへは自動で書き込まない）
5. Google CalendarでAI Foundation専用のCalendarを作成し、「カレンダーの設定 → カレンダーの統合」にあるカレンダーIDを `config.local.yaml` の `writable_calendar_id` に設定する

要求するScopeは `calendar.calendarlist.readonly` と `calendar.events`。`calendar.events` は技術的には全Calendarへ書き込めるが、AI Foundationは `writable_calendar_id` 以外へ書き込まない。

`invalid_grant` のCredential Errorが出た場合は、Refresh Tokenが失効している。`npm run auth:google` を再実行する。

### Notion

AI Foundation専用のCollection Databaseを1つ用意し、Internal Connection（Integration）を共有する。種類（book / game 等）ごとにDatabaseを分けず、種類別・Status別の一覧はNotionのViewで作る。

1. NotionでDatabase「AI Foundation Collection」を作成する
2. 以下のPropertyを作成する（名前は大文字小文字まで一致させる）

   | Property | 種類 |
   |---|---|
   | `Name` | Title（既定のTitle Property） |
   | `Type` | Select（`game` / `book` / `movie` / `other`。**小文字で**作る。`Book` のように大文字小文字だけが異なるoptionがあるとConfiguration Errorになる） |
   | `Status` | **Select**（NotionのStatus型ではない。Status型はAPIから任意の値を書き込めない） |
   | `Tags` | Multi-select |
   | `Metadata` | Text |

3. [Integrations](https://www.notion.so/profile/integrations) でInternal Integrationを作成する。Capabilitiesは Read content / Update content / Insert content を有効にする
4. 作成したIntegrationのTokenを `NOTION_API_TOKEN` に設定する
5. Databaseのメニュー（`•••`）→ Connections から、作成したIntegrationを追加する
6. DatabaseのData Source IDを取得し、`config.local.yaml` の `sources.collection.data_source_id` に設定する（Databaseのメニュー → Data sourcesの設定から「Copy data source ID」）

Propertyの不足・型の違い、Integrationが共有されていないData Sourceは、Collection Toolの初回呼び出し時にConfiguration Errorとして原因を返す。Propertyを直した後はServerを再起動する（Schemaの確認はProcessごとに1回）。

StatusやTagにNotion上に存在しない値を指定すると、Select optionが自動で追加される。使われなくなったoptionは自動では削除されないため、必要に応じてNotion上で整理する。既存のoptionと大文字小文字だけが異なる値（例: 既存 `rpg` に対して `RPG`）は、既存のoptionとして扱われ、既存の表記で保存される。Select optionの名前にはカンマを使えない。

Page本文の内容はAI Foundationからは変更・削除せず、`note` / `append_note` を末尾へ追記するだけ。Notion上で直接編集してよいが、`Metadata` はJSON Objectの形を保つ（JSONとして読めない場合、検索結果に `metadata` が含まれず、`metadata` の更新はErrorになる）。`Type` が空または4種以外のPageは検索結果に含まれない。

## Register with an MCP Client

Build後、`dist/index.js` の絶対パスを指定して登録する。MCP Clientは任意のディレクトリでServerを起動するため、パスは絶対パスで指定する。

Claude Code:

```sh
claude mcp add ai-foundation -- node /absolute/path/to/ai-foundation/dist/index.js
```

Codex（`~/.codex/config.toml`）:

```toml
[mcp_servers.ai-foundation]
command = "node"
args = ["/absolute/path/to/ai-foundation/dist/index.js"]
```

別の場所のConfigを使う場合は `--config <path>` を引数に追加するか、`AI_FOUNDATION_CONFIG` を設定する。`config.local.yaml` を使う例:

```sh
claude mcp add ai-foundation -- node /absolute/path/to/ai-foundation/dist/index.js --config /absolute/path/to/ai-foundation/config.local.yaml
```

`.env` を使わずMCP Client側でCredentialを渡す場合は、`claude mcp add` の `-e TODOIST_API_TOKEN=...`（Notionは `-e NOTION_API_TOKEN=...`） や、Codexの `env` を使う。`--no-env-file` を付けると `.env` を読み込まない。

## Development

### Directory Structure

```text
src/
├─ domain/       Provider非依存のEntity / Tool Input Schema（Zod）
├─ config/       config.yamlのSchemaとLoader
├─ credentials/  CredentialProvider境界と環境変数実装
├─ connectors/   Connector境界と実装（todoist/, google-calendar/, notion/, obsidian/）
├─ tools/        MCP Toolの登録（task.ts, schedule.ts, collection.ts, knowledge.ts）
├─ shared/       Timezone計算などの共通処理
├─ errors.ts     Tool呼び出しで返すError分類
├─ instructions.ts  AI Clientへ送るInstructions
├─ server.ts     MCP Serverの組み立て
└─ index.ts      Entry Point（.env / Config読込・Connector生成・stdio起動）
scripts/
└─ google-auth.ts  Google OAuth Refresh Tokenの取得
tests/
├─ integration/  実APIへのIntegration Test（npm run test:integration）
└─ ...           通常のTest（外部通信なし）
```

### Adding Tools

Entityごとに `src/tools/<entity>.ts` を作成し、`register<Entity>Tools(server, context)` 内でSDKの `server.registerTool()` を直接呼ぶ。作成した関数を `src/tools/index.ts` の `registerTools` から呼び出す。Provider固有処理は `src/connectors/<provider>/` に置き、Toolからは `context.connectors` 経由で利用する。

ConnectorはCredentialを `CredentialProvider` からのみ受け取り、`process.env` を直接読まない。失敗時は `src/errors.ts` のErrorを投げる。MCP SDKが `error.message` を `isError` 結果としてClientへ返すため、MessageにCredentialを含めない。

### Logging

stdoutはMCPのJSON-RPC専用。`console.log` を使うとstdio通信が壊れるため、ログは `console.error`（stderr）へ出力する。

## Documentation

- [MVP v0.1仕様](docs/specs/mvp-v0.1.md)
- [Phase 1 Design Issue](docs/specs/phase-1-foundation.md)
- [Phase 1 Implementation Plan](docs/plans/phase-1-implementation-plan.md)
- [Phase 2 Design Issue](docs/specs/phase-2-task-schedule.md)
- [Phase 2 Implementation Plan](docs/plans/phase-2-implementation-plan.md)
- [Phase 3 Design Issue](docs/specs/phase-3-collection.md)
- [Phase 3 Implementation Plan](docs/plans/phase-3-implementation-plan.md)
- [Phase 4 Design Issue](docs/specs/phase-4-knowledge.md)
- [Phase 4 Implementation Plan](docs/plans/phase-4-implementation-plan.md)
- [Development Workflow](docs/development/workflow.md)
- [Agent Guidelines](AGENTS.md)
