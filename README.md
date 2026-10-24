# AI Foundation

各サービスをSource of Truthとして維持しながら、Task / Schedule / Collection / Knowledge / Project / Area / Life LogをAIから統一的に操作するMCPベースの個人AI基盤。

## Source of Truth

| Entity | Source of Truth |
|---|---|
| Task | Todoist |
| Schedule | Google Calendar |
| CollectionItem | Notion |
| Knowledge | Obsidian / Google Drive |
| Project | GitHub / Google Drive |
| Area（PARAのAreas） | Notion |
| Life Log | Obsidian |

AI Foundation自身は独自DBを持たず、共通Data Model、Tool Interface、SoTルール、Connector、静的設定を提供する。Routingと複数Toolの組み合わせはAI Clientが判断する。

## Current Phase

Phase 5 — Project、Areas MVP（[Issue #13](https://github.com/thanatos27/ai-foundation/issues/13)）、Life Log MVP（[Issue #14](https://github.com/thanatos27/ai-foundation/issues/14)）、複数Calendar・期間イベント・説明欄（[Issue #12](https://github.com/thanatos27/ai-foundation/issues/12)）、および繰り返しタスク（[Issue #11](https://github.com/thanatos27/ai-foundation/issues/11)）。Todoist・Google Calendar・Notion・Obsidian Vault・GitHubへ実際に接続し、以下のToolを公開している。

| Tool | 内容 |
|---|---|
| `task_create` | Todoist InboxへTaskを作成（title / status / due / area / tags / recurrence） |
| `task_list` | Inbox内の未完了Taskを取得（status / area / due_before / due_after / tagsでFilter）。各Taskに繰り返し規則 `recurrence` が付く |
| `task_update` | `todoist:<id>` を指定して部分更新。`recurrence` で繰り返し規則を変更、`recurrence: null` で規則と期限を解除 |
| `task_complete` | `todoist:<id>` を指定して完了（繰り返しTaskは次回分へ進む） |
| `schedule_create` | 設定した書き込み先Calendar（別名 `calendar`、省略時は既定）へ予定・期間イベントを作成（時刻予定 / 終日予定、説明欄 `description`・場所 `location`） |
| `schedule_list` | 期間に重なる予定を、閲覧可能な全Calendar、または `calendar` で指定した1つのCalendarから取得。説明欄は原文のまま返す |
| `schedule_update` | 書き込み先Calendarの単発予定を `google_calendar:<calendar>:<event>` で部分更新（`description` / `location` は `null` で消去）。繰り返し予定・招待された予定は対象外 |
| `collection_create` | Notionの専用Collectionへ本・ゲーム・映画等を作成（title / collection_type / status / metadata / tags / note） |
| `collection_search` | 専用CollectionをTitle部分一致・collection_type・status・tags（AND）で検索 |
| `collection_update` | `notion:<page-id>` を指定して部分更新（status / metadata（shallow merge）/ tags（置換）/ append_note（本文末尾へ追記）） |
| `knowledge_create` | Obsidian VaultのKnowledge Directory直下へMarkdownを新規作成（title / description / content / area / tags）。既存ファイルは上書きしない |
| `knowledge_search` | Knowledge Directory以下を再帰的に検索（query: title / description / tags / 本文の部分一致、area、tags（AND））。本文全文ではなくsnippetを返す |
| `knowledge_get` | `obsidian:<vault-relative-path>` を指定してMetadataと本文全文を取得 |
| `knowledge_append` | `obsidian:<vault-relative-path>` を指定して本文末尾へ追記（Frontmatterは変更しない） |
| `project_list` | `GITHUB_TOKEN` の `/user/repos` が返すGitHub Repository（Discovery集合）をProjectとして一覧（query: name / owner/repository / descriptionの部分一致、owner: 完全一致。いずれも大文字小文字を区別しない）。owner/repository順 |
| `project_get` | `github:<owner>/<repository>` を指定してProjectとGitHub固有Details（description / owner / default_branch / visibility / archived / fork / updated_at）を取得（Read-only） |
| `area_list` | Notionの `Areas` 親ページ直下の子ページをArea（継続的に管理する領域）として一覧（query: タイトルの部分一致、大文字小文字を区別しない）。タイトル順。Read-only |
| `area_get` | `notion:<page-id>` を指定してAreaと目次本文（Markdown相当のテキスト）を取得。リンク先・子ページの中身は取得しない（Read-only） |
| `lifelog_create` | Obsidian VaultのLife Log Directory直下へ、日付・タイトル・本文から記事（`YYYY-MM-DD-<タイトル>.md`）を新規作成。既存ファイルは上書きしない |
| `lifelog_get` | `lifelog:<ファイル名>` を指定して記事と本文全文を取得 |
| `lifelog_append` | `lifelog:<ファイル名>` を指定して記事末尾へ段落として追記 |

Taskの `status`（`next` / `waiting` / `someday`）と `area`（`work` / `personal`）は、`af-` で始まるTodoist Label（`af-next`, `af-area-work` 等）で表現する。`af-` で始まるLabelはAI Foundation用に予約しており、`tags` には含まれない。

CollectionItemの `status` は自由文字列（例: `wishlist` / `playing` / `read`）で、NotionのSelect optionとして保存する。`metadata` は自由形式のObjectで、`Metadata` PropertyにJSON文字列として保存する。感想・読書メモ等の長文は `note` / `append_note` でPage本文の末尾へParagraphとして追記する。

Knowledgeは1件 = 1 Markdown file（UTF-8）で、`title` / `description` / `area` / `tags` をYAML Frontmatterに持つ。IDはVault相対パス（`obsidian:AI Foundation/Knowledge/CAP定理.md`）で、ローカルの絶対パスは含まない。ObsidianでファイルをKnowledge Directory内の別フォルダへ移動するとIDが変わる（旧IDはNot foundになり、`knowledge_search` で新しいIDが見つかる）。

Projectは1 GitHub Repository = 1 Projectで、IDは `github:<owner>/<repository>`。Project一覧はConfigに書かず、Tool呼び出しのたびにGitHub APIから取得する（Cacheなし）。public / private / internal、archived、fork、Organization所有のRepositoryも区別せず含む。RepositoryをGitHub上でrename・移管すると、旧IDの `project_get` は現在のIDで結果を返す。README・ファイル・Issue・Pull Requestは取得しない。

Area（PARAのAreas: 食事・資産・運動・家事など、完了を目指さず継続的に管理する領域）は、Notionの `Areas` 親ページ直下の子ページ1つ = 1 Areaで、IDは `notion:<page-id>`。Areaのページは関連情報へのリンクを集めた目次として使い、AI Foundationは目次を返すだけでリンク先を巡回しない。完了を目指す一時的な活動はProject。Task / Knowledgeの `area`（`work` / `personal`）とは別の概念。詳細は [Areas](#areas)。

Life Log（旅行・外出・イベントなど、不定期な出来事の記録）は、Obsidian VaultのLife Log Directory直下の自由形式のMarkdown 1ファイル = 1記事で、IDは `lifelog:<ファイル名>`（`lifelog:2026-10-03-東京散策.md`）。Knowledgeとは別のDirectory・別のToolで、Frontmatter・タグは使わない。一覧・検索Toolはない。詳細は [Life Log](#life-log)。

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

`npm test` は外部Serviceへ通信せず、個人のObsidian Vaultにもアクセスしない（Knowledge / Life Logのテストは一時Directoryに作るVaultを使う）。実際のTodoist / Google Calendar / Notion / Obsidian Vault / GitHubに対するIntegration Testは、Credentialと `writable_calendars` / `data_source_id` / `vault_path` を設定したうえで明示的に実行する。設定されていないServiceのTestはskipされる。テストで作成したTask / Event / Markdownは終了時に削除し（繰り返しタスクのTestはそのRunで作成したTaskだけを操作する）、NotionのPageはゴミ箱へ移す。ObsidianのIntegration Testは検証専用のVault（または検証専用の `knowledge_dir` / Life Log Directory）で実行する。Life LogのIntegration Testは `sources.lifelog.obsidian.directory` に記事を作成し、終了時にそのRunで作成したファイルだけを削除する。Google CalendarのIntegration Testは `writable_calendars` の各Calendarへ予定を作成・更新し、終了時にそのRunで作成した予定だけを削除する（別名が2つ以上あれば、Calendarごとの絞り込みと分配も確認する）。GitHubのIntegration Testは読み取りのみで、Repositoryへ書き込まない（private Repositoryの確認は任意で、`AI_FOUNDATION_IT_GITHUB_PRIVATE_REPO=<owner>/<repo>` を設定した場合のみ実行する）。

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

予定の書き込み先Calendar ID（`sources.schedule.writable_calendars`）、CollectionのNotion Data Source ID（`sources.collection.data_source_id`）、Areas親ページのID（`sources.area.notion.parent_page_id`）、Obsidian VaultのPath（`sources.knowledge.obsidian.vault_path`）は個人の値のため、Public Repositoryにある `config.yaml` には書かない。`config.yaml` を `config.local.yaml`（Git管理外）へコピーして設定し、`--config` または `AI_FOUNDATION_CONFIG` で指定する。

```yaml
sources:
  schedule:
    provider: google_calendar
    default_calendar: personal
    writable_calendars:
      personal: "xxxxxxxx@group.calendar.google.com"   # 通常の予定
      events: "yyyyyyyy@group.calendar.google.com"     # 期間イベント（任意）
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
  area:
    provider: notion
    notion:
      parent_page_id: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

未設定でもServerは起動する。`writable_calendars` がなければ `schedule_create` / `schedule_update` が、`data_source_id` がなければCollectionの3 Toolが、`vault_path` / `knowledge_dir` がなければKnowledgeの4 Toolが、`sources.area` / `parent_page_id` がなければAreaの2 ToolがConfiguration Errorになる。`sources.area` 自体を省略したConfig（Areas以前に作ったもの）もそのまま起動できる。

以前の `writable_calendar_id` は廃止した。残っていると起動時にConfig Errorになるため、次のように置き換える（別名は英小文字・数字・`_`・`-`）。

```yaml
    default_calendar: personal
    writable_calendars:
      personal: "<以前の writable_calendar_id の値>"
```

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

### Life Log

Life Logは、Knowledgeと同じObsidian Vaultの別Directoryに、出来事を1記事 = 1 Markdown file（UTF-8）として保存する。Credentialは不要。

1. Vault内にLife Log Directory（`config.yaml` の既定は `AI Foundation/LifeLog`）を作成する。AI Foundationは自動作成しない。`knowledge_dir` と同じ場所・その内側・それを含む場所には置けない（Knowledgeの検索にLife Logが混ざらないようにするため）。設定の文字列は起動時に、実際のフォルダはTool呼び出し時に実パスで確認する（Windowsの8.3短縮名 `KNOWLE~1` や大文字小文字違いで同じフォルダを指す場合もConfiguration Error。Knowledge Toolも同様）
2. Directoryを変える場合は `sources.lifelog.obsidian.directory`（Vault相対パス）を設定する。Vaultは `sources.knowledge.obsidian.vault_path` を使う（Knowledgeの設定が必要）

- ファイル名は `YYYY-MM-DD-<タイトル>.md`。タイトルの使えない文字はKnowledgeと同じく空白に置き換える。同じ日付に別タイトルの記事は作れるが、同じ日付・タイトルの記事があれば上書きせずErrorになる
- 本文は渡されたとおりに保存する（改行をLFにそろえ、末尾に改行を付けるだけ）。Frontmatter・見出し・日付は付け足さない。画像・動画は外部ストレージのURLを本文に書く。Project / Area / Knowledgeへの参照も、IDやURLを任意に書いてよい（自動の紐付けはしない）
- 一覧・検索Toolはない。`lifelog_create` が返したID、またはObsidianで確認した**正確なファイル名**から作ったID（`lifelog:` + ファイル名）で取得・追記する。どちらも分からない記事はAI Foundationからは取得できない
- Obsidianで手動作成した記事も、Life Log Directory直下で `YYYY-MM-DD-<タイトル>.md` の規則に合えば取得・追記できる（日付が実在しない・サブフォルダ内・規則外の名前は対象外）。将来の保存先の移行でも、この規則がIDで参照し続けるための前提になる
- UTF-8でないファイル（Shift_JIS等）はErrorになり、追記もしない。ObsidianでUTF-8に直す
- Symbolic Link / Junctionの扱いはKnowledgeと同じ（Vaultから辿る途中・Directoryの内側のLinkは辿らない）
- IDのファイル名に `:` は使えない（Windowsでは `x.txt:notes.md` が別ファイルの代替データストリームを指すため。Knowledgeも、Windowsでは `:` を含むパスを読み書きしない）

MVPの制約:

- 同時に追記した場合の順序は保証しない。複数のプロセスから同時に大きな内容を追記した場合、追記内容が混ざることがあり得る（既存の本文は消えない）
- 追記の書き込み途中で失敗した場合（ディスク容量不足・同期ソフトのロック等）、末尾に追記内容の一部だけが残ることがある。Obsidianで確認して直す
- Obsidianで記事を開いたまま未保存の編集がある状態で追記すると、Obsidian側の保存で追記が失われることがあり得る（AI Foundationからは検知できない）
- 大文字小文字だけが異なるタイトル（`Tokyo` と `tokyo`）は、Windows / macOSでは同名として扱われる

### Areas

Areaは、Notionの専用Workspaceにある通常ページ `Areas` の**直下の子ページ**。専用DatabaseやAI Foundation側の登録は不要で、子ページを作る・ゴミ箱へ移すだけで増減する。Collectionと同じIntegration（`NOTION_API_TOKEN`）を使い、Read-onlyでアクセスする。

1. Notionで通常ページ `Areas` を作り、ページのメニュー（`•••`）→ Connections からCollectionと同じIntegrationを追加する（子ページは共有を継承する）
2. `Areas` のページID（URL末尾の32桁の英数字）を `config.local.yaml` の `sources.area.notion.parent_page_id` に設定する。**このRepositoryはPublicなので、ページID・Area IDは `config.yaml`・Test・ドキュメントに書かず、Commitしない**
3. Areaごとに `Areas` 直下へ子ページを作る。列（Column）・トグルの中に置いた子ページや、子ページのさらに子ページはAreaにならない（`area_list` に出ず、`area_get` もNot foundになる）
4. Integration Test（`npm run test:integration`）は、`Areas` 直下に子ページが**最低1件**あることを前提とする（読み取りのみで、Notionは変更しない）

ゴミ箱へ移した子ページは `area_list` に出ず、`area_get` もNot foundになる。Notionの「アーカイブ」は判定に使わない（ゴミ箱に入っていなければAreaとして扱う）。

#### 目次テンプレート

Areaのページには関連情報へのリンクを書く。AI Foundationで辿れる参照先はFoundation IDで書くと、LLMが対応Toolでそのまま読める（`obsidian:…` → `knowledge_get`、`github:<owner>/<repository>` → `project_get`）。対応Toolのない参照先（Notionの他ページ、Google Drive、Web）はURLやNotionのリンク・mentionで書けば、リンクとして提示される。

```markdown
# 食事管理

## 記録
- 食事記録（Notionの子ページ・リンク・mention）

## Knowledge
- obsidian:Knowledge/栄養の基本.md

## Project
- github:<owner>/<repository>

## Task
- Todoistの「食事」ラベル
```

#### 取得範囲（MVP）

`area_get` の `content` はページ本文をMarkdown相当のテキストにしたもの。

- 変換するBlock: 見出し（H1〜H4）・段落・箇条書き・番号付きリスト・To-do・トグル・引用・コールアウト・列・区切り線・コード・子ページ / 子Database / ページへのリンク（リンクのみ）・ブックマーク / 埋め込み / リンクプレビュー。文字の装飾は無視し、リンク・mentionは `[テキスト](URL)` にする
- ネストは**3階層まで**取得する。それより深い内容は `[nested blocks not retrieved: depth limit 3]` と表示する
- 表・画像・ファイル・同期ブロック等の非対応Blockは `[unsupported Notion block: <type>]` と表示する（子を持つ場合は `…; its nested blocks were not retrieved`）
- 子ページ・リンク先の中身は取得しない

これらの表示がある箇所は取得していない内容があるという意味で、Notionで直接開けば確認できる（`external_ref`）。

#### Troubleshooting

- `Configuration error: sources.area.notion.parent_page_id is not set`: `config.local.yaml` に `sources.area.notion.parent_page_id` を設定する
- `Configuration error: Notion page … (sources.area.notion.parent_page_id) was not found, is in the trash or is not shared …`: ページIDの誤り、`Areas` がゴミ箱にある、またはIntegrationが `Areas` に追加されていない

### Calendarの使い分け（Google Calendar）

書き込み先のCalendarを用途ごとに分け、`writable_calendars` に別名で設定する。AI Foundationは設定したCalendarにしか書き込まず、読み取り（`schedule_list`）は従来どおり閲覧可能な全Calendarが対象。

| Calendar（別名の例） | 登録するもの |
|---|---|
| 期間イベント用（`events`） | 気になるイベント・展示・祭り等の開催期間。行くかどうかは問わない。開催期間は日付だけの終日予定で、`end` は最終日（その日を含む） |
| 通常（`personal`、既定） | 行くと決めた日時・参加予定 |
| Todoist（Task） | チケット購入・予約などの行動と期限 |

- 期間イベントに実際に行くことになっても、開催情報は動かさず、訪問予定を通常Calendarへ別に登録する（自動連携はしない）
- 通常Calendarの予定は「参加予定だった」ことを表すだけで、参加実績とは扱わない。急な不参加や参加結果は、必要なら説明欄に自由に書く
- 説明欄（`description`）と場所（`location`）は原文のまま保存・取得する。Google Calendarで書式を付けた説明欄はHTMLで返る。公式サイトのURLは説明欄に書く
- `schedule_update` は単発の予定だけを更新する。繰り返し予定、他人から招待された予定、書き込み先以外のCalendarの予定、Calendar間の移動、削除は対象外
- 時刻を片方だけ変えると、もう片方は保持される（移動するときは `start` と `end` の両方を渡す）

詳細は [複数Calendar・期間イベント Design](docs/specs/schedule-calendars.md) を参照。以前の参加済みフラグ（`#attended` / `attended_only`、Issue #15）はIssue #12で廃止した。

### 繰り返しタスク（Todoist）

`task_create` / `task_update` の `recurrence` に、Todoistの繰り返し規則を英語で書く（例: `every day`、`every monday`、`every weekday at 9am`、`every month on the 25th`）。完了日を基準に次回を決めるときは `every!`（例: `every! 3 days`）を使う。次回の期限はTodoistが計算し、`due` に入る（`recurrence` が規則、`due` が次回の予定日）。Config・Credentialの追加は不要。

- 取得結果の `recurrence` は、Todoistが保持する文字列をそのまま返す。Todoistが書き換えることがある（`after 3 days` → `every! 3 days`、`every month on the 25th` → `every 25th`。`starting …` は規則の文字列に残らない）。Todoistが解釈できれば日本語（`毎週月曜`）でも受理され、日本語のまま返る
- title / status / area / tags の変更では繰り返しは変わらない。`task_complete` で次回分へ進み、規則は維持される
- `recurrence` で規則を変えるとTodoistが次回の期限を計算し直す。時刻は、規則に含めない限り現在の時刻が引き継がれる（変えるときは `every day at 7am` のように書く）。`recurrence` の変更・解除は、他の項目と同じ `task_update` では指定できない
- `recurrence: null` は規則と期限の両方を消す。繰り返しTaskの `due` を変更・解除しようとすると、繰り返しが消えるため何も変えずにErrorになる。次回1回分だけの延期はTodoistで直接行う
- Todoistが繰り返しとして解釈しない文字列（`tomorrow` など）を指定すると、作成時はTaskを作らず、更新時は元に戻してErrorを返す。繰り返しの期限は規則と時刻まで元に戻すが、次回の期限はTodoistが計算し直すことがある。削除・復元に失敗したとき、または戻した結果が元と一致しないときだけ、残った状態とTask IDをErrorで示す（外部APIのため完全な原子性はない）
- 曜日・時刻・完了日はTodoistアカウントのtimezoneで解釈される（`defaults.timezone` と同じにしておく）

詳細と既知の制約は [繰り返しタスク Design](docs/specs/task-recurrence.md) を参照。

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
5. Google CalendarでAI Foundationが書き込むCalendar（通常の予定用、必要なら期間イベント用も）を作成し、各Calendarの「カレンダーの設定 → カレンダーの統合」にあるカレンダーIDを `config.local.yaml` の `writable_calendars` に別名で設定する（[ローカル設定](#ローカル設定configlocalyaml)）。IDは必ず設定画面から写し、`primary` やメールアドレスを推測して使わない（`primary` は起動時にConfig Errorになる）
6. 設定後、別名が意図したCalendarを指していることを確認する。たとえば `schedule_create` で各別名に予定を1件作り、Google Calendarで意図したCalendarに表示されることを確かめてから削除する

要求するScopeは `calendar.calendarlist.readonly` と `calendar.events`。`calendar.events` は技術的には全Calendarへ書き込めるが、AI Foundationは `writable_calendars` 以外へ書き込まない。

`invalid_grant` のCredential Errorが出た場合は、Refresh Tokenが失効している。`npm run auth:google` を再実行する。

### GitHub

`GITHUB_TOKEN` でGitHub APIの `GET /user/repos` が返すRepository（Discovery集合）がそのままProjectになる。AI Foundationにはallowlistがなく、`project_get` も `project_list` に出るRepositoryだけを返す。

Discovery集合に含まれるかどうかは次のとおり。

| Repository | `project_list` / `project_get` |
|---|---|
| Tokenで選択したRepository（public / private） | 含まれる |
| Tokenで選択していない、自分が所有・参加するprivate Repository | 含まれない（Not found） |
| Tokenで選択していない、自分が所有・参加する**public** Repository | **含まれる**（GitHubの仕様上、Fine-grained Tokenは選択と関係なくpublic Repositoryを読めるため） |
| 関係のない他人のpublic Repository | 含まれない（Not found） |

**Fine-grained TokenのRepository selectionで絞れるのはprivate Repositoryだけ**で、自分のpublic RepositoryをProject一覧から除外することはできない。public Repositoryの中身は公開情報だが、AI ClientのProject一覧にどのRepositoryが出るかには影響するため、一覧に出したくないRepositoryがある場合はこの点に注意する（Phase 5にはAI Foundation側で除外する仕組みはない）。


1. GitHubの [Fine-grained personal access tokens](https://github.com/settings/personal-access-tokens) で新しいTokenを作成する
2. Resource ownerを選び、Repository accessで「Only select repositories」からAI Foundationに見せるprivate Repositoryを選ぶ（すべてを見せる場合は「All repositories」）。自分のpublic Repositoryは選択と関係なく一覧に含まれる
3. Repository permissionsは **Metadata: Read-only** だけを付与する（AI FoundationはRepositoryへ書き込まない）
4. 作成したTokenを `GITHUB_TOKEN` に設定する

Classic Tokenも使えるが、private Repositoryを含めるには `repo` scope（書き込み権限を含む）が必要になるため、Fine-grained Tokenを推奨する。Organization所有のRepositoryは、Resource ownerにそのOrganizationを選んだTokenで参照する（Organization側でTokenの承認が必要な場合がある）。SAML SSOを要求するOrganizationでは、TokenのSSO承認が済むまで該当Repositoryが一覧に出ず、`project_get` もNot foundになる。

Rate Limitに達した場合はProvider API Errorとして解除時刻を返す（自動で待機・再試行しない）。`project_get` は境界の確認のためにRepository一覧も取得するので、1回あたり「1 + 一覧のページ数（100件ごと）」回のRequestになる。

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

`.env` を使わずMCP Client側でCredentialを渡す場合は、`claude mcp add` の `-e TODOIST_API_TOKEN=...`（Notionは `-e NOTION_API_TOKEN=...`、GitHubは `-e GITHUB_TOKEN=...`） や、Codexの `env` を使う。`--no-env-file` を付けると `.env` を読み込まない。

## Development

### Directory Structure

```text
src/
├─ domain/       Provider非依存のEntity / Tool Input Schema（Zod）
├─ config/       config.yamlのSchemaとLoader
├─ credentials/  CredentialProvider境界と環境変数実装
├─ connectors/   Connector境界と実装（todoist/, google-calendar/, notion/, obsidian/, github/）
├─ tools/        MCP Toolの登録（task.ts, schedule.ts, collection.ts, knowledge.ts, project.ts, area.ts, lifelog.ts）
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
- [Phase 5 Design Issue](docs/specs/phase-5-project.md)
- [Phase 5 Implementation Plan](docs/plans/phase-5-implementation-plan.md)
- [Areas MVP Design](docs/specs/areas.md)
- [Areas MVP Implementation Plan](docs/plans/areas-implementation-plan.md)
- [Life Log MVP Design](docs/specs/lifelog.md)
- [Life Log MVP Implementation Plan](docs/plans/lifelog-implementation-plan.md)
- [Google Calendar参加済みフラグ Design](docs/specs/schedule-attendance.md)（廃止）
- [Google Calendar参加済みフラグ Implementation Plan](docs/plans/schedule-attendance-implementation-plan.md)（廃止）
- [繰り返しタスク Design](docs/specs/task-recurrence.md)
- [繰り返しタスク Implementation Plan](docs/plans/task-recurrence-implementation-plan.md)
- [複数Calendar・期間イベント Design](docs/specs/schedule-calendars.md)
- [複数Calendar・期間イベント Implementation Plan](docs/plans/schedule-calendars-implementation-plan.md)
- [Development Workflow](docs/development/workflow.md)
- [Agent Guidelines](AGENTS.md)
