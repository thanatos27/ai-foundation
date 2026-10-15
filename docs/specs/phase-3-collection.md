# Phase 3: Collection — Design Issue

## Goal

AI FoundationからNotion上のCollectionを操作できるようにし、本・ゲーム・映画などの候補・所有・消費状況と、そのItem固有のメモを管理できる状態にする。

Phase 1〜2で構築したMCP Server、Domain Model、Tool登録構造、Connector境界、Credential Provider、Error分類を利用し、Notion固有処理はConnectorへ閉じ込める。

## References

- `docs/specs/mvp-v0.1.md`
- `docs/specs/phase-1-foundation.md`
- `docs/specs/phase-2-task-schedule.md`
- `docs/development/workflow.md`
- `AGENTS.md`

## Scope

Source of Truth:

```text
Notion
```

実装するTool:

```text
collection_create
collection_search
collection_update
```

対象Collection Type:

```text
game
book
movie
other
```

Collection固有の感想、攻略メモ、読書メモ等はNotion Page本文へ保存してよい。

## Notion Storage Design

### Dedicated Collection Database

AI Foundation専用のNotion Databaseを1つ用意する。

種類ごとにDatabaseを分割しない。

Notion上で種類別・Status別の一覧が必要な場合はViewで表現する。

概念:

```text
AI Foundation Collection
├─ ペルソナ3 リロード
├─ Designing Data-Intensive Applications
├─ インセプション
└─ ...
```

AI Foundationは、このDatabase内のCollection用Data Sourceを固定の書き込み・検索対象として利用する。

### Data Source Configuration

対象Data SourceはConfigurationで固定し、Tool Inputから任意のDatabase / Data Sourceを指定できないようにする。

```yaml
sources:
  collection:
    provider: notion
    data_source_id: "<collection-data-source-id>"
```

`data_source_id` はSecretではないが個人環境依存値のため、Public Repositoryの `config.yaml` へ実値を保存せず、`config.local.yaml` 等のGit管理外Configurationで設定してよい。

### Properties

Notion側のCollection Data Sourceは以下のPropertyを持つ。

| Property | Notion Type | AI Foundation |
|---|---|---|
| `Name` | title | `title` |
| `Type` | select | `collection_type` |
| `Status` | select | `status` |
| `Tags` | multi_select | `tags` |
| `Metadata` | rich_text | JSONとして保存した `metadata` |

`Type` は以下の4種類を利用する。

```text
game
book
movie
other
```

`Status` はAI Foundation Domainでは自由文字列とし、種類ごとのenumをFoundationへ固定しない。

例:

```text
game  → wishlist / playing / completed
book  → wishlist / reading / read
movie → wishlist / watched
```

必要なStatusは利用時に決める。

### Metadata

`metadata` は自由形式のObjectとする。

例:

```json
{
  "platform": "Xbox",
  "rating": 5
}
```

Notionでは `Metadata` PropertyへJSON文字列として保存する。

Provider側のProperty表現や文字数制限等はConnectorで吸収し、黙ってtruncateしない。

### Page Body

CollectionItem固有の長文情報はNotion Page本文へ保存する。

例:

```text
感想
攻略メモ
読書メモ
購入理由
作品固有の補足
```

AI Foundationは本文内容を自動分類せず、Noteとして渡された内容をParagraphとして末尾へ追記する。

Foundation自身が自動的に以下を行わない。

```text
見出し生成
日時付与
「感想」「攻略」等への分類
既存本文の書き換え
```

必要な構造はAI ClientがNote本文へ含める。

## CollectionItem ID

Notion Page IDを利用し、AI Foundationでは以下の形式で返す。

```text
notion:<page-id>
```

`collection_create` / `collection_search` はこのIDを返す。

`collection_update` はexact ID指定で行う。

Titleによる直接更新やFoundation側のfuzzy matchingは実装しない。

自然言語から対象Itemを特定する必要がある場合は、AI Clientが `collection_search` で候補を取得し、返されたIDを使って更新する。

## CollectionItem Domain

Phase 3では既存のCollectionItemを以下として扱う。

```yaml
type: collection
title: string

collection_type:
  game |
  book |
  movie |
  other

status: string

metadata: object

tags: string[]
```

Provider由来Metadataとして以下を返してよい。

```text
id: notion:<page-id>
source: notion
external_ref: <Notion Page URL>
```

## collection_create

Input:

```text
title
collection_type
status
metadata
tags
note
```

必須:

```text
title
collection_type
status
```

Optional:

```text
metadata
tags
note
```

例:

```json
{
  "title": "ペルソナ3 リロード",
  "collection_type": "game",
  "status": "wishlist",
  "metadata": {
    "platform": "Xbox"
  },
  "tags": ["RPG"],
  "note": "セールになったら買いたい"
}
```

作成先はConfigurationの `data_source_id` に固定する。

`note` が指定された場合は、作成したPage本文へParagraphとして保存する。

`note` は非空文字列またはnull / 未指定を許可し、null / 未指定では本文を追加しない。

## collection_search

Input Filter:

```text
query
collection_type
status
tags
```

すべてOptionalとする。

規則:

| Filter | 挙動 |
|---|---|
| `query` | `Name` の部分一致 |
| `collection_type` | 完全一致 |
| `status` | 完全一致 |
| `tags` | 指定Tagをすべて持つ（AND） |

空Filter:

```json
{}
```

の場合は、専用Collection Data Source内の全CollectionItemを返す。

検索対象はPropertyのみとする。

Notion Page本文の全文検索はPhase 3対象外とする。

検索結果はPage本文を取得せず、CollectionItem Domainへ必要なPropertyのみ変換して返してよい。

## collection_update

必須:

```text
id
```

更新可能:

```text
status
metadata
tags
append_note
```

例:

```json
{
  "id": "notion:<page-id>",
  "status": "completed",
  "metadata": {
    "rating": 5
  },
  "tags": ["RPG", "Xbox"],
  "append_note": "ストーリー後半が特によかった"
}
```

`id` 以外の更新項目が1つも指定されていない場合はValidation Errorとする。

### Status Update

```text
status未指定
→ 現在値を維持

status: <string>
→ 指定値へ更新

status: null
→ Statusをクリア
```

### Metadata Update

```text
metadata未指定
→ 現在値を維持

metadata指定
→ 既存Metadataへshallow merge
```

例:

既存:

```json
{
  "platform": "Xbox",
  "rating": null
}
```

更新:

```json
{
  "metadata": {
    "rating": 5
  }
}
```

結果:

```json
{
  "platform": "Xbox",
  "rating": 5
}
```

Valueとして `null` が指定された場合はJSON値としてnullを保存する。

Metadata Keyの削除操作はPhase 3では実装しない。

### Tags Update

```text
tags未指定
→ 現在値を維持

tags: ["RPG", "Xbox"]
→ Tagsを置換

tags: []
→ Tagsをすべて削除
```

TagsはCollectionItem全体の属性とし、個々のNoteにはTagsを持たせない。

### Note Append

```text
append_note未指定 / null
→ 本文を変更しない

append_note: <non-empty string>
→ Notion Page本文末尾へParagraphとして追記
```

既存本文を削除・置換しない。

### Not Updatable in Phase 3

以下はPhase 3の `collection_update` では変更しない。

```text
title
collection_type
```

## Credential / Authentication

Phase 3ではNotion Internal Integration / Internal ConnectionのTokenを利用する。

CredentialはConfigurationへ保存しない。

```env
NOTION_API_TOKEN=...
```

ConnectorがEnvironment Variableを直接読む構造にはせず、既存のCredential Provider境界へNotion Credential取得を追加する。

概念:

```text
Tool
  ↓
NotionConnector
  ↓
CredentialProvider
  ↓
Environment Variable
```

Notion API Versionは実装時点で利用するVersionを明示的に指定し、Implementation Planで固定する。

### Notion Setup

利用前にNotion側で以下を行う。

```text
1. AI Foundation Collection Database / Data Sourceを作成
2. Name / Type / Status / Tags / Metadata Propertyを作成
3. AI Foundation用Internal Connectionを作成
4. Collection Database / Data SourceへConnectionを共有
5. Data Source IDを取得
6. NOTION_API_TOKENとdata_source_idをローカル環境へ設定
```

## Error Handling

Phase 2で導入したError分類を再利用する。

```text
Input Validation Error
Authentication / Credential Error
Target Not Found
Provider API Error
Configuration Error
```

Notion固有ErrorをそのままDomainへ漏らす必要はないが、利用者が原因を判断できるMessageを返す。

主なMapping方針:

| 状況 | AI Foundation Error |
|---|---|
| 不正Input | Input Validation Error |
| `NOTION_API_TOKEN` 未設定 | Credential Error |
| Token無効 / Authentication失敗 | Credential Error |
| 個別 `notion:<page-id>` が存在しない | Target Not Found |
| `data_source_id` 未設定 | Configuration Error |
| 対象Data Sourceが存在しない / Connectionから見えない | Configuration Error |
| Rate Limit / Conflict / 5xx / Network | Provider API Error |

Provider側の404は、Data Sourceアクセス時と個別Pageアクセス時で意味を分けて扱う。

独自のRetry FrameworkはPhase 3では追加しない。

## Configuration

Phase 3でCollection設定を以下へ拡張する。

```yaml
sources:
  collection:
    provider: notion
    data_source_id: "<collection-data-source-id>"
```

`data_source_id` はRuntimeでCollection Toolを利用するために必要とする。

実値はPublic RepositoryへCommitしない運用を基本とする。

Credentialは引き続きConfigurationへ保存しない。

## Out of Scope

Phase 3では以下を実装しない。

```text
種類ごとのNotion Database分割
Page本文の全文検索
Page本文の置換 / 削除
CollectionItem削除
title変更
collection_type変更
Metadata Key削除専用操作
個別NoteへのTags / Metadata付与
Rating等の専用Notion Property化
Relation / Rollup
Notion Formula
Cross-source Search
Workflow Engine
Intent Classifier
独自Planner
Remote MCP
Multi-user Authentication
Cloud Credential Store
```

## Acceptance Criteria

### Notion Connection

Credential Provider経由でNotionへ接続できる。

Connectorが認証情報を直接Environment Variableから読み取らない。

対象Collection Data SourceはConfigurationの `data_source_id` で固定される。

Tool Inputから任意のDatabase / Data Sourceを指定できない。

### Collection Mapping

Notionの以下のPropertyとCollectionItem Domainを相互変換できる。

```text
Name     ↔ title
Type     ↔ collection_type
Status   ↔ status
Tags     ↔ tags
Metadata ↔ metadata(JSON)
```

AI Foundation IDとして `notion:<page-id>` を返せる。

Notion Page URLを `external_ref` として返せる。

### collection_create

専用Collection Data SourceへCollectionItemを作成できる。

以下がNotionへ正しく反映される。

```text
title
collection_type
status
metadata
tags
```

`note` を指定した場合、Page本文へ初期Noteを保存できる。

### collection_search

専用Collection Data Source内を以下で検索できる。

```text
query
collection_type
status
tags
```

`query` はTitle部分一致、`collection_type` / `status` は完全一致、`tags` はANDとして動作する。

空Filter `{}` で全CollectionItemを取得できる。

Page本文の全文検索を行わない。

### collection_update

`notion:<page-id>` のexact IDを指定してCollectionItemを更新できる。

以下を部分更新できる。

```text
status
metadata
tags
append_note
```

Metadata更新は既存Objectへのshallow mergeとなる。

Tags指定時は置換され、空配列で全削除できる。

`append_note` は既存Page本文を破壊せず末尾へ追記される。

`id` 以外の更新項目がない場合はValidation Errorとなる。

Titleによる直接更新やfuzzy matchingを行わない。

### Security / Configuration

Notion TokenがRepositoryや `config.yaml` へ保存されない。

個人のData Source IDをPublic Repositoryの標準Configurationへ実値として保存しない。

Connectionが共有されていないData Sourceを利用した場合、原因を判断できるConfiguration Errorを返せる。

### Error Handling

最低限以下を区別できる。

```text
Input Validation Error
Credential Error
Target Not Found
Provider API Error
Configuration Error
```

Provider固有のCredential値やAuthorization HeaderをError Messageへ含めない。

### Automated Test

Tool LayerはFake / Mock Connectorを利用して自動テストできる。

Notion ConnectorのProperty Mapping、Metadata JSON変換、Filter、Pagination、Note追加、Validation、Error Handlingについて自動テストが存在する。

通常のTest Suiteが実Notion APIへの依存なしで実行できる。

実Notionとの接続確認はIntegration Testまたは手動Verificationとして分離する。

### Integration Verification

実Notion環境で少なくとも以下を確認する。

```text
CollectionItem作成
Name / Type / Status / Tags / Metadataの保存
Title / Type / Status / Tagsによる検索
Metadata shallow merge
Tags置換
Page本文へのNote追記
exact IDによる更新
```

Integration Testで作成したデータは、テストコードからのみ後片付けしてよい。

Collection Delete Toolは公開しない。

### LLM Client Verification

実装完了後、Claude Code等の実LLM ClientからAI Foundationへ接続し、少なくとも以下を確認する。

```text
「この本を積読に追加」
→ collection_create

「積読の本を見せて」
→ collection_search

「このゲームをクリアした。感想は○○」
→ collection_search → exact id → collection_update(status + append_note)

「この本に分散システムタグを付けて」
→ collection_search → exact id → collection_update(tags)
```

## Coding Agent Task

Repository全体と上記Referenceを確認し、Phase 3のImplementation Planを作成すること。

Implementation Planには少なくとも以下を含める。

```text
現在のRepository状態
Phase 2までの実装への変更点
追加・変更予定ファイル
Domain / Tool Input Schema変更
Notion Connector設計
Data Source / Property Mapping
Metadata JSONの保存・shallow merge設計
Page本文Noteの追加方法
Credential Provider変更
Configuration変更
Notion API Version / 利用SDK
Error Mapping
実装順序
依存Package
Test Strategy
Integration Verification
LLM Client Verification
Acceptance Criteriaとの対応
懸念点 / 未確定事項
```

Implementation Plan作成時点では本実装を開始しないこと。

PlanをRepository内の適切な場所へMarkdownとして作成し、レビュー可能な状態にすること。
