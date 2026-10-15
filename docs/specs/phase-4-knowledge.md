# Phase 4: Knowledge — Design Issue

## Goal

AI FoundationからObsidian Vault上のKnowledgeを作成・検索・取得・追記できるようにし、長期的に再利用可能な学習内容・気づき・考察をMarkdownとして蓄積・再利用できる状態にする。

Phase 1〜3で構築したMCP Server、Domain Model、Tool登録構造、Connector境界、Configuration、Error分類を利用する。

Phase 4ではObsidianを論理的なSource of Truthとし、実アクセスはFilesystem経由で行う。Obsidian VaultがGoogle Drive等で同期されていてもよい。同期方式自体はAI Foundationの責務としない。

将来のクラウド化に備え、ObsidianというSource of TruthとFilesystemというStorage Accessを同一視しない。Phase 4ではFilesystem依存をObsidian Connector内部へ閉じ込め、Knowledge IDやTool IFへローカル絶対パスを漏らさない。

## References

- `docs/specs/mvp-v0.1.md`
- `docs/specs/phase-1-foundation.md`
- `docs/specs/phase-2-task-schedule.md`
- `docs/specs/phase-3-collection.md`
- `docs/development/workflow.md`
- `AGENTS.md`

## Scope

Source of Truth:

```text
Obsidian
```

Phase 4 Storage Access:

```text
Filesystem
```

実装するTool:

```text
knowledge_create
knowledge_search
knowledge_get
knowledge_append
```

`knowledge_get` は元のMVP案から追加する。

検索結果へ長い本文全文を含めず、候補探索と本文取得を分離するために追加する。

Google Drive APIを直接利用するKnowledge ConnectorはPhase 4対象外とする。

## Architecture

概念:

```text
AI Client
    ↓ MCP
Knowledge Tool
    ↓
Knowledge Connector
    ↓
Obsidian Connector
    ↓
Storage Access
    └─ Filesystem          ← Phase 4
       Google Drive API    ← Future
```

Phase 4で汎用Storage Frameworkを構築することは要件としない。

ただし以下は守る。

```text
Obsidian = logical Source of Truth
Filesystem = Phase 4 access mechanism
```

Filesystem固有の絶対パスやI/O処理をDomain / Tool IFへ漏らさない。

将来Google Drive API等のStorage Accessへ差し替えても、Knowledgeの論理ID・Markdown構造・Tool IFを維持できる構造とする。

## Obsidian / Google Drive Sync

現行運用ではObsidian VaultをGoogle Drive等の同期フォルダに置いてよい。

例:

```text
AI Foundation
      ↓
Filesystem
      ↓
Google Drive同期フォルダ
      ↓
Obsidian Vault
      ↕
Google Drive
      ↕
他PC / 他端末
```

AI FoundationはGoogle Drive同期処理を管理しない。

以下はPhase 4対象外とする。

```text
同期状態管理
競合ファイルの自動解決
複数端末間のLock
同期失敗の自動修復
Google Drive APIによるVault操作
```

Tool実行時にFilesystemから見えている現在状態をSource of Truthとして扱う。

## Storage Layout

Phase 4ではAI Foundation用Knowledge DirectoryをVault内に設定する。

例:

```text
Obsidian Vault/
└─ AI Foundation/
   └─ Knowledge/
      ├─ CAP定理.md
      ├─ AI/
      │  └─ RAG.md
      └─ Finance/
         └─ リスク中立確率.md
```

`knowledge_create` は `knowledge_dir` 直下へ作成する。

`knowledge_search` は `knowledge_dir` 以下を再帰的に探索する。

人間がObsidian上でKnowledge Directory内のファイルをサブディレクトリへ移動・整理してよい。

## Configuration

Phase 4ではKnowledge設定を以下の方向へ拡張する。

```yaml
sources:
  knowledge:
    default: obsidian
    providers:
      - obsidian

    obsidian:
      storage: filesystem
      vault_path: "<Obsidian Vault Path>"
      knowledge_dir: "AI Foundation/Knowledge"
```

`vault_path` は個人環境依存値のため、Public Repositoryの標準 `config.yaml` へ実値を保存しない。

`config.local.yaml` 等のGit管理外Configurationで設定してよい。

`knowledge_dir` はVault相対パスとする。

Phase 4では `storage` は `filesystem` のみをサポートする。

将来Storage Accessを追加する場合、例えば以下のような差し替えを可能にする設計を想定する。

```yaml
obsidian:
  storage: google_drive
  vault_folder_id: "<folder-id>"
  knowledge_dir: "AI Foundation/Knowledge"
```

これは将来拡張例でありPhase 4では実装しない。

## Knowledge File Model

Phase 4では以下を基本単位とする。

```text
1 Knowledge = 1 Markdown file
```

文字コード:

```text
UTF-8
```

AI Foundationが新規作成するファイルの改行:

```text
LF
```

構造:

```markdown
---
title: CAP定理
description: CAP定理と分散システムでの考え方
area: personal
tags:
  - database
  - distributed-systems
---

CAP定理では……
```

### Frontmatter

AI Foundationが扱う共通Frontmatter:

```yaml
title: string
description: string | null
area: work | personal | null
tags: string[]
```

`description` はKnowledgeの内容を短く説明するOptional Metadataとする。

本文はFrontmatterへ複製しない。

AI Foundationが認識しない追加Frontmatter Keyが存在してもよい。既知Keyの読み取りを妨げない限り無視し、`knowledge_append` ではFrontmatter自体を書き換えない。

### FrontmatterなしのMarkdown

人間が作成したFrontmatterなしのMarkdownもKnowledgeとして扱える。

Default Mapping:

```text
title       → 拡張子を除いたファイル名
description → null
area        → null
tags        → []
```

### Malformed Frontmatter

Frontmatterが存在するが、YAMLとして解析不能、またはAI Foundationが扱う既知Fieldが不正な型・値である場合はMalformedとして扱う。

```text
knowledge_search
→ 対象ファイルを結果から除外し、他ファイルの検索を継続

knowledge_get
→ Error

knowledge_append
→ Error。書き込みを行わない
```

AI FoundationはMalformed Frontmatterを自動修復しない。

## Knowledge Domain

Phase 4ではKnowledge Domainへ `description` を追加する。

```yaml
type: knowledge
title: string
description: string | null

source:
  obsidian |
  google_drive

external_ref: string

area: work | personal | null

tags: string[]
```

Phase 4で実際に生成・取得する `source` は `obsidian` とする。

`google_drive` は将来のKnowledge SourceとしてDomain上の予約を維持してよいが、Phase 4 Toolから直接書き込み対象として選択できない。

本文そのものは共通Knowledge Domainへ複製せず、Tool Resultとして必要時に返す。

## Knowledge ID

Knowledge IDはローカル絶対パスではなく、Vault相対パスを利用する。

例:

```text
obsidian:AI Foundation/Knowledge/CAP定理.md
```

禁止例:

```text
obsidian:C:\Users\user\Google Drive\Obsidian\AI Foundation\Knowledge\CAP定理.md
```

規則:

```text
prefix
→ obsidian:

path
→ Vaultからの相対パス

target
→ knowledge_dir以下の.mdのみ
```

`external_ref` には同じVault相対パスを返してよい。

ファイルが人間によって移動された場合、IDは永続UUIDではないため変化する。

例:

```text
before:
obsidian:AI Foundation/Knowledge/CAP定理.md

after:
obsidian:AI Foundation/Knowledge/Distributed Systems/CAP定理.md
```

旧IDはNotFoundとなり、`knowledge_search` により新IDで再発見できる。

Phase 4ではFrontmatterへ永続UUIDを追加しない。

## knowledge_create

Input:

```text
title
description
content
source
area
tags
```

必須:

```text
title
content
```

Optional:

```text
description
source
area
tags
```

例:

```json
{
  "title": "CAP定理",
  "description": "CAP定理と分散システムでの考え方",
  "content": "CAP定理では...",
  "source": "auto",
  "area": "personal",
  "tags": ["database", "distributed-systems"]
}
```

### Source

Phase 4のTool Inputとして利用可能:

```text
auto
obsidian
```

挙動:

```text
source省略
→ configのknowledge.default

source = auto
→ configのknowledge.default

source = obsidian
→ Obsidianを明示指定
```

Phase 4では最終的にObsidianへ解決される場合のみ実行可能とする。

未実装Providerを「利用可能なTool Input」として公開しない。

### Area

```text
area省略
→ defaults.area

area = null
→ areaなしを明示
```

### File Creation

`title` から安全なMarkdownファイル名を生成し、`knowledge_dir` 直下へ新規作成する。

例:

```text
title:
CAP定理

file:
AI Foundation/Knowledge/CAP定理.md
```

OSでファイル名として利用できない文字・形式は安全化する。

安全化後に有効なファイル名を生成できない場合はValidation Errorとする。

同名ファイルが既に存在する場合は上書きしない。

AI Clientが既存Knowledgeへ追記したい場合は、`knowledge_search` でexact IDを取得して `knowledge_append` を利用する。

作成内容:

```text
YAML Frontmatter
blank line
Markdown content
```

作成結果はKnowledge Metadataを返せればよく、本文全文を返す必要はない。

## knowledge_search

Input Filter:

```text
query
area
tags
```

すべてOptionalとする。

例:

```json
{
  "query": "CAP",
  "area": "personal",
  "tags": ["distributed-systems"]
}
```

空Filter:

```json
{}
```

では `knowledge_dir` 以下のKnowledgeを一覧できる。

### Search Scope

`knowledge_dir` 以下を再帰的に探索する。

対象:

```text
*.md
```

検索対象:

```text
title
description
tags
Markdown body
```

`query` は大文字小文字を区別しない単純な部分一致とする。

`area` は完全一致とする。

`tags` は指定されたTagをすべて持つAND条件とする。

Phase 4では以下を実装しない。

```text
Embedding
Vector Search
RAG
高度なRanking
Fuzzy Search
```

### Search Result

検索結果には本文全文を含めない。

返却内容の概念:

```yaml
id: obsidian:AI Foundation/Knowledge/AI/RAG.md
type: knowledge
title: RAG
description: RAGの構成と役割についての学習メモ
source: obsidian
external_ref: AI Foundation/Knowledge/AI/RAG.md
area: personal
tags:
  - ai
  - rag
snippet: RAGでは検索した外部知識をLLMの...
```

`snippet` は短い本文抜粋とし、本文にqueryがHitした場合はHit周辺を返すことを基本とする。

snippetの厳密な文字数や切り出しアルゴリズムはImplementation Planで決めてよいが、本文全文を返す用途にはしない。

## knowledge_get

Input:

```text
id
```

例:

```json
{
  "id": "obsidian:AI Foundation/Knowledge/CAP定理.md"
}
```

exact IDのみ受け付ける。

Titleによる直接取得やFoundation側のfuzzy matchingは実装しない。

返却:

```text
Knowledge Metadata
Markdown本文全文
```

候補探索は `knowledge_search`、本文全文取得は `knowledge_get` に責務分離する。

## knowledge_append

Input:

```text
id
content
```

例:

```json
{
  "id": "obsidian:AI Foundation/Knowledge/CAP定理.md",
  "content": "PACELCについても関連して調べた。"
}
```

`id` はexact IDのみ受け付ける。

`content` は非空文字列を必須とする。

既存Markdown本文末尾へ追記する。

Frontmatterは変更しない。

Foundation自身が自動的に以下を行わない。

```text
日時付与
見出し生成
箇条書き化
分類
既存本文の置換
既存本文の削除
Markdown整形
```

既存本文と追記本文が潰れないよう、必要な改行のみ補う。

### Frontmatter Update

Phase 4では作成後のFrontmatterをAI Foundationから更新しない。

以下の変更Toolは提供しない。

```text
title変更
description変更
area変更
tags変更
```

必要になった場合は将来 `knowledge_update` を追加する。

Phase 4では人間がObsidianでFrontmatterを直接編集してよい。次回Tool実行時に最新ファイル状態を読み取る。

## External Editing

AI Foundation独自DBやMetadata RegistryをKnowledgeのSource of Truthにしない。

外部編集時の挙動:

```text
本文編集
→ 次回get/searchで最新内容を読む

Frontmatter編集
→ 次回get/searchで最新Metadataを読む

Knowledge Directory内で移動
→ 旧IDはNotFound
→ searchで新IDを再発見

削除
→ get/appendはNotFound

新規Markdown追加
→ search対象になる
```

Phase 4ではファイル変更Watcherや独自Indexを必須としない。

## Safety Boundary

AI FoundationがPhase 4で読み書き可能な範囲はConfigurationで指定した `knowledge_dir` 以下に限定する。

以下を拒否する。

```text
絶対パス
.. によるPath Traversal
knowledge_dir外のファイル
.md以外のファイル
symlink等を利用したknowledge_dir外へのアクセス
```

`knowledge_create` は既存ファイルを上書きしない。

`knowledge_get` / `knowledge_append` はexact IDを検証してから対象へアクセスする。

Safety判定に文字列prefix比較だけを利用せず、正規化後・実パスを考慮してKnowledge Directory外へ出ないことを保証する。

Phase 4でsymlinkをサポートすることは要件としない。

## Error Handling

既存Error分類を再利用する。

```text
Input Validation Error
Credential Error
Target Not Found
Provider API Error
Configuration Error
```

Phase 4のFilesystem方式ではCredential Errorは通常利用しない。

主なMapping方針:

| 状況 | AI Foundation Error |
|---|---|
| title / contentが空 | Input Validation Error |
| 不正source | Input Validation Error |
| 不正ID形式 | Input Validation Error |
| Path Traversal / 絶対パス / 非.md | Input Validation Error |
| 同名Fileが既に存在 | Input Validation Error |
| `vault_path` / `knowledge_dir` 未設定 | Configuration Error |
| Vault / Knowledge Directoryが利用不能 | Configuration Error |
| exact ID対象が存在しない | Target Not Found |
| Malformed Frontmatterをget/append | Provider API Error |
| 予期しないFilesystem read/write失敗 | Provider API Error |

Filesystem Errorの生Messageに不要な個人絶対パスを含めないよう配慮する。

Google Drive同期競合や複数端末競合の自動Mergeは行わない。

独自Retry FrameworkはPhase 4では追加しない。

## Out of Scope

Phase 4では以下を実装しない。

```text
Google Drive APIによるKnowledge操作
Cloud Storage Adapterの本実装
汎用Storage Framework
Knowledge Delete
Knowledge本文の置換 / 部分編集
Frontmatter Update
knowledge_update
永続UUID
Vault全体のRead / Write
knowledge_dir外の検索
RAG
Embedding
Vector DB
高度な全文検索Engine
高度なRanking
Fuzzy Search
Cross-source Search
File Watcher / Index DB
同期状態管理
同期競合の自動解決
Multi-device Lock
Workflow Engine
Intent Classifier
独自Planner
Remote MCP
Multi-user Authentication
Cloud Credential Store
```

## Acceptance Criteria

### Obsidian / Storage Boundary

Obsidianを論理的なSource of Truthとして扱う。

Phase 4のStorage AccessはFilesystemとする。

Filesystem固有の絶対パスをKnowledge IDやTool Resultへ漏らさない。

将来Storage Accessを差し替えられるよう、Filesystem依存をObsidian Connector内部へ閉じ込める。

Google Drive等で同期されたVaultを利用できるが、同期処理そのものはAI Foundationが管理しない。

### Configuration

`vault_path` と `knowledge_dir` を設定できる。

`knowledge_dir` はVault相対パスとして扱う。

個人の `vault_path` 実値をPublic Repositoryの標準ConfigurationへCommitしない。

Phase 4では `storage: filesystem` を利用する。

### Knowledge Mapping

1 Knowledgeを1 Markdown fileとして扱える。

AI Foundationが作成するMarkdownはUTF-8 / LFとする。

以下のFrontmatterをKnowledge DomainへMappingできる。

```text
title       ↔ title
description ↔ description
area        ↔ area
tags        ↔ tags
```

本文を共通Knowledge Metadataへ複製しない。

未知Frontmatter Keyが存在しても通常の読み取りを妨げない。

### Knowledge ID

以下の形式でIDを返せる。

```text
obsidian:<vault-relative-path>
```

IDへローカル絶対パスを含めない。

Knowledge Directory内で人間がファイルを移動した場合、新しい相対パスが新しいIDになる。

### knowledge_create

`title` と `content` を指定してKnowledgeを新規作成できる。

Optionalな以下をFrontmatterへ保存できる。

```text
description
area
tags
```

`source` の省略 / `auto` はConfigurationのdefault Providerへ解決される。

Phase 4ではObsidianへ解決される場合に実行できる。

`title` から安全なMarkdown filenameを生成し、Knowledge Directory直下へ作成できる。

同名Fileを上書きしない。

### knowledge_search

Knowledge Directory以下を再帰的に検索できる。

対象はMarkdown fileのみとする。

以下をquery対象にできる。

```text
title
description
tags
Markdown body
```

queryは大文字小文字を区別しない部分一致として動作する。

areaは完全一致、tagsはANDとして動作する。

空Filter `{}` でKnowledge一覧を取得できる。

検索結果に本文全文を含めず、Metadata / description / snippetを返せる。

RAG / Vector Searchへ依存しない。

### knowledge_get

`obsidian:<vault-relative-path>` のexact IDでKnowledgeを取得できる。

Knowledge MetadataとMarkdown本文全文を返せる。

Titleによる直接取得やfuzzy matchingを行わない。

### knowledge_append

exact IDを指定してMarkdown本文末尾へ非破壊的に追記できる。

Frontmatterを変更しない。

自動見出し・日時・分類・Markdown整形を行わない。

既存本文との間に必要な改行を入れる。

### Human-authored Markdown

FrontmatterなしのMarkdownをKnowledgeとして読み取れる。

Frontmatterなしの場合は以下をDefaultとして扱う。

```text
title       = filename
description = null
area        = null
tags        = []
```

Malformed Frontmatterはsearchから除外し、他ファイルの検索を継続できる。

Malformed Frontmatterへのget / appendはErrorとなり、append時には書き込みを行わない。

AI FoundationがMalformed Frontmatterを自動修復しない。

### External Editing

AI Foundation独自DBやCacheをSource of Truthにせず、Tool実行時の現在ファイル状態を参照する。

外部で追加・編集されたMarkdownを次回search/getで反映できる。

外部で移動されたFileの旧IDはNotFoundとなり、searchで新IDを取得できる。

削除されたFileへのget / appendはNotFoundとなる。

### Security

Read / Write範囲をKnowledge Directory以下へ限定できる。

以下の操作を拒否できる。

```text
Path Traversal
絶対パス
非Markdown対象
Knowledge Directory外へのアクセス
symlink等を経由した範囲外アクセス
```

createで既存Fileを上書きしない。

### Error Handling

最低限以下を区別できる。

```text
Input Validation Error
Target Not Found
Provider API Error
Configuration Error
```

Phase 4 Filesystem方式ではCredential Errorを必須としない。

Error Messageへ不要な個人絶対パスやSecretを含めない。

### Automated Test

Tool LayerはFake / Mock Connectorを利用して自動テストできる。

Filesystem / Obsidian Connectorのテストでは実際の個人Vaultへ依存せず、一時Directory等を利用できる。

少なくとも以下を自動テストする。

```text
create
recursive search
query / area / tags filter
get
append
Frontmatterあり
Frontmatterなし
Malformed Frontmatter
日本語filename / content
同名File上書き防止
Path Traversal
絶対パス拒否
非.md拒否
symlink等の境界外アクセス拒否
外部移動 / 削除後の挙動
```

通常のTest SuiteはGoogle Drive同期や個人Vaultに依存せず実行できる。

### Integration Verification

実Obsidian Vaultまたは検証専用Vaultで少なくとも以下を確認する。

```text
Knowledge作成
Obsidianから作成Fileを閲覧
title / description / area / tagsの読取
本文queryによる検索
recursive search
exact IDによるget
本文末尾へのappend
Obsidian側で編集した内容の再読込
Obsidian側で移動したFileの旧ID NotFound / 新ID再発見
```

Google Drive同期フォルダを利用する場合、AI Foundationが同期処理自体を管理しないことを確認するだけでよく、同期サービスのE2E TestはPhase 4要件としない。

### LLM Client Verification

実装完了後、Claude Code等の実LLM ClientからAI Foundationへ接続し、少なくとも以下を確認する。

```text
「今日CAP定理について理解した内容をメモして」
→ knowledge_create

「CAP定理について前に何をメモした？」
→ knowledge_search → exact id → knowledge_get

「CAP定理のメモにPACELCについて追記して」
→ knowledge_search → exact id → knowledge_append

「distributed-systemsタグのメモを探して」
→ knowledge_search
```

## Coding Agent Task

Repository全体と上記Referenceを確認し、Phase 4のImplementation Planを作成すること。

Implementation Planには少なくとも以下を含める。

```text
現在のRepository状態
Phase 3までの実装への変更点
追加・変更予定File
Knowledge Domain / Tool Input / Tool Result Schema変更
knowledge_get追加
Obsidian Connector設計
Filesystem依存を閉じ込める境界
Configuration変更
Vault / Knowledge DirectoryのPath解決
Knowledge ID parse / validation
Markdown / YAML Frontmatter parser・serializer
Frontmatterなし / Malformed時の扱い
titleからfilenameを生成するルール
create時の排他的な新規作成・上書き防止
recursive search
query / area / tags filter
snippet生成
get
append時のFrontmatter非変更・改行処理
Path Traversal / symlink対策
Filesystem Error Mapping
実装順序
依存Package
Test Strategy
Integration Verification
LLM Client Verification
Acceptance Criteriaとの対応
クラウドStorage差し替え時に維持する境界
懸念点 / 未確定事項
```

Implementation Plan作成時点では本実装を開始しないこと。

PlanをRepository内の適切な場所へMarkdownとして作成し、レビュー可能な状態にすること。
