# Phase 5: Project — Design Issue

## Goal

AI FoundationからGitHub上のRepositoryをProjectとして発見・参照できるようにする。

Phase 1〜4で構築したMCP Server、Domain Model、Tool登録構造、Connector境界、Configuration、Credential Provider、Error分類を利用する。

Phase 5では **1 GitHub Repository = 1 Project** と定義し、GitHubをProjectのSource of Truthとして扱う。AI Foundation独自のProject Registry、Database、Cache、Indexは持たない。

Projectの論理的なSource of TruthはMVP全体ではGitHub / Google Driveだが、Phase 5で実装するProviderはGitHubのみとする。Google Drive Project Connectorは将来拡張とする。

## References

- `docs/specs/mvp-v0.1.md`
- `docs/specs/phase-1-foundation.md`
- `docs/specs/phase-2-task-schedule.md`
- `docs/specs/phase-3-collection.md`
- `docs/specs/phase-4-knowledge.md`
- `docs/development/workflow.md`
- `AGENTS.md`

## Scope

Source of Truth:

```text
GitHub
```

実装するTool:

```text
project_list
project_get
```

Phase 5ではRead-onlyとする。

以下はPhase 5対象外とする。

```text
Google Drive Project Connector
Project作成 / 更新 / 削除
README取得
Repository内File取得 / 検索
Issue / Pull Request取得
Project Status / Area
GitHubとGoogle Drive Projectの関連付け
Project Registry
Cache / Index
横断検索 / compare
```

READMEやRepository contents等が必要になった場合は、`project_get` を肥大化させず、将来必要な情報だけを取得する別Toolとして追加する。

## Architecture

概念:

```text
AI Client
    ↓ MCP
Project Tool
    ↓
ProjectConnector
    ↓
GitHubProjectConnector        ← Phase 5
GoogleDriveProjectConnector   ← Future
```

Phase 5ではGitHub APIからTool実行時の現在状態を取得する。

AI Foundation独自のProject RegistryやRepository allowlistは持たない。

```text
GITHUB_TOKEN
    ↓
GitHub API（GET /user/repos）
    ↓
Discovery集合
    ↓
Project Discovery
```

認証済みGitHub APIの `GET /user/repos` が返すRepositoryの集合（以下 **Discovery集合**）をPhase 5のアクセス境界とする。`project_list` はDiscovery集合を返し、`project_get` もDiscovery集合に含まれるRepositoryだけを返す（Issue #10）。

### Discovery集合とFine-grained PATのRepository selection

Discovery集合は、Tokenの所有者が owner / collaborator / organization member として関係するRepositoryである。Fine-grained PATのRepository selectionとの関係は以下のとおり。

| Repository | Discovery集合 |
|---|---|
| Tokenで選択したRepository（public / private） | 含まれる |
| Tokenで選択していない自分が所有・参加するprivate Repository | 含まれない |
| Tokenで選択していない自分が所有・参加するpublic Repository | **含まれる**（GitHubの仕様上、Fine-grained PATは選択と関係なくpublic Repositoryを読めるため） |
| 関係のない他人のpublic Repository | 含まれない |

Fine-grained PATのRepository selectionはprivate Repositoryの可視範囲の制御には利用できるが、自分が所有・参加するpublic RepositoryをDiscovery集合から除外する境界としては保証しない。

Repositoryごとに追加のRequestを送ってTokenの選択状態を推測する方式は採用しない（GitHubが正式な判定手段として保証しない挙動への依存と、Repository数に比例したRequest増加を避けるため）。

## Project Definition

Phase 5では以下をProjectと定義する。

```text
1 GitHub Repository = 1 Project
```

Repositoryが個人所有かOrganization所有か、public / private / internalか、archivedか、forkかはProject判定に影響しない。

Discovery集合に含まれればProjectとして扱う。

## Project Domain

既存のProvider非依存なProject Domainを維持する。

```yaml
id: string
type: project
title: string
source: github | google_drive
external_ref: string
```

Phase 5でGitHubから返すProjectでは `id` を必須とする。

例:

```json
{
  "id": "github:thanatos27/physical-ai-robot",
  "type": "project",
  "title": "physical-ai-robot",
  "source": "github",
  "external_ref": "https://github.com/thanatos27/physical-ai-robot"
}
```

`google_drive` はDomain上では将来用として維持するが、Phase 5のToolからGoogle Drive Projectを取得しない。

## Project ID

GitHub Project IDは以下とする。

```text
github:<owner>/<repository>
```

例:

```text
github:thanatos27/physical-ai-robot
github:openai/example
```

IDはGitHub Repositoryのcanonicalなowner loginとrepository nameから生成する。

`project_get` はexact IDのみ受け付ける。

以下は行わない。

```text
Repository名だけによるget
titleによるget
fuzzy matching
Foundation独自IDへの変換
```

ID形式が不正な場合は `InputValidationError` とする。

## Project Discovery

Project一覧を `config.yaml` に記述しない。

`project_list` は認証済みGitHub Tokenで `GET /user/repos` を呼び、Discovery集合を動的に列挙する。

AI Foundation独自のRepository allowlistはPhase 5では持たない。

### project_list Input

```json
{
  "query": "physical",
  "owner": "thanatos27"
}
```

両FieldともOptionalとする。

```text
query: string | undefined
owner: string | undefined
```

空Filter `{}` でDiscovery集合の全Repositoryを対象とする。

### query

`query` は以下を対象とする。

```text
repository name
owner/repository
description
```

大文字小文字を区別しない部分一致とする。

`description == null` は空文字列として扱う。

高度なranking、fuzzy search、GitHub Search APIによる全文検索は行わない。

### owner

`owner` はRepository owner loginとの大文字小文字を区別しない完全一致とする。

個人User / Organizationを区別しない。

### query + owner

両方指定された場合はANDとする。

### Pagination

GitHub APIのRepository一覧はConnector内部で最後までPaginationする。

Provider APIが1ページあたりの上限を持つ場合は利用可能な最大Page Sizeを利用してよい。

Pagination途中で失敗した場合、途中まで取得したProjectを返さず `ProviderApiError` とする。

Tool Inputとして `page` / `cursor` / `limit` はPhase 5では公開しない。

### Sort

Filter後の結果はcanonicalな `owner/repository` の昇順で返す。

Provider側の既定順序やupdated_atに依存しない。

## project_list Result

`project_list` は軽量なProject情報だけを返す。

例:

```json
{
  "items": [
    {
      "id": "github:thanatos27/physical-ai-robot",
      "type": "project",
      "title": "physical-ai-robot",
      "source": "github",
      "external_ref": "https://github.com/thanatos27/physical-ai-robot"
    }
  ]
}
```

以下を一覧結果へ含めない。

```text
README
Repository contents
Issue
Pull Request
GitHub API response全体
```

## project_get

Input:

```json
{
  "id": "github:thanatos27/physical-ai-robot"
}
```

exact IDでGitHub APIからRepositoryを直接取得し、取得したRepositoryがDiscovery集合に含まれることを確認する。含まれなければ `NotFoundError` とする。

Resultは共通ProjectとGitHub固有Detailsを分離する。

```json
{
  "project": {
    "id": "github:thanatos27/physical-ai-robot",
    "type": "project",
    "title": "physical-ai-robot",
    "source": "github",
    "external_ref": "https://github.com/thanatos27/physical-ai-robot"
  },
  "details": {
    "description": "Physical AI robot project",
    "owner": "thanatos27",
    "default_branch": "main",
    "visibility": "public",
    "archived": false,
    "fork": false,
    "updated_at": "2026-10-15T13:00:00Z"
  }
}
```

GitHub固有Detailsは最低限以下とする。

```text
description: string | null
owner: string
default_branch: string
visibility: public | private | internal
archived: boolean
fork: boolean
updated_at: datetime
```

GitHub APIから返るその他MetadataはTool Resultへそのまま流さない。

READMEやRepository contentsを `project_get` で取得しない。

## Canonical Mapping / Repository Lifecycle

GitHub APIから返された現在のRepository情報をcanonicalなProjectとして扱う。

Repositoryがrenameまたはowner移管され、GitHub APIが旧 `owner/repository` 指定を現在のRepositoryへ解決する場合、返却するProjectは現在のcanonicalなID / title / URLとする。

例:

```text
Input:
github:thanatos27/old-name

GitHubがnew-nameへ解決

Result:
github:thanatos27/new-name
```

AI Foundationは旧IDとの対応表を保持しない。

以下のGitHub側変更は次回Tool呼び出しから現在状態を反映する。

```text
description変更
default branch変更
visibility変更
archive / unarchive
rename
owner移管
削除
Token権限変更
```

削除済み、現在のTokenからアクセスできない、またはDiscovery集合に含まれないRepositoryへの `project_get` は `NotFoundError` とする。

## Repository Types

Discovery集合に含まれれば以下を除外しない。

```text
public Repository
private Repository
internal Repository
archived Repository
fork Repository
Organization-owned Repository
```

これらはProvider固有Detailsで現在状態を表現する。

## Authentication

Secretは `GITHUB_TOKEN` を利用する。

既存Credential ProviderへGitHub Token取得責務を追加し、GitHub Connectorが直接 `process.env` を参照しない。

概念:

```text
GITHUB_TOKEN
    ↓
EnvCredentialProvider
    ↓
CredentialProvider
    ↓
GitHubProjectConnector
```

Fine-grained Personal Access Token等、対象Repositoryを限定できるRead-only Credentialの利用を推奨する。ただしRepository selectionで限定できるのはprivate Repositoryであり、自分が所有・参加するpublic Repositoryは選択と関係なくDiscovery集合に含まれる（§Architecture）。

実Token値を `config.yaml`、Public Repository、Tool Result、Logへ保存・出力しない。

## Configuration

Project一覧やRepository IDはConfigurationへ保存しない。

Phase 5では少なくとも以下を利用する。

```yaml
sources:
  project:
    providers:
      - github
```

`providers` に `github` が含まれない場合、`project_list` / `project_get` は `ConfigurationError` とする。

Project Domain上の `google_drive` は将来互換性として維持してよいが、Phase 5でGoogle Drive Connectorを作成しない。

## Current State / Cache Policy

AI Foundation独自のProject Cache / Index / Metadata DBを作成しない。

```text
project_list
project_get
    ↓
毎回GitHub API
    ↓
現在のRepository状態
```

Provider ResponseをProcess内へ長期CacheすることもPhase 5要件としない。

## Error Handling

既存のFoundation Error分類を利用する。

```text
InputValidationError
CredentialError
NotFoundError
ProviderApiError
ConfigurationError
```

最低限以下へMappingする。

| 状況 | Error |
|---|---|
| Project ID形式不正 | `InputValidationError` |
| `GITHUB_TOKEN` 未設定 | `CredentialError` |
| Token無効 / 期限切れ / 認証失敗 | `CredentialError` |
| Repository不存在 | `NotFoundError` |
| Repositoryへのアクセス権なし | `NotFoundError` |
| `github` Provider無効 | `ConfigurationError` |
| GitHub Rate Limit | `ProviderApiError` |
| Network Error | `ProviderApiError` |
| GitHub 5xx | `ProviderApiError` |
| Pagination途中失敗 | `ProviderApiError` |

存在しないRepositoryとアクセス権のないRepositoryをAI Foundationから区別できるようにはしない。

GitHub APIの生Errorは必要に応じて `cause` に保持してよいが、Secretを含み得る生Message / Request Header / Authorization情報をTool Resultや外向けError Messageへ流さない。

Rate Limit到達時に独自Retry / Sleep / Schedulerを実装しない。

Rate Limit情報を安全に取得できる場合、Credentialや不要なProvider情報を含まない範囲で原因が分かるMessageを返してよい。

## Safety / Permission

Phase 5のToolはRead-onlyである。

```text
project_list → Read
project_get  → Read
```

Write / Delete / External Sendは存在しないため、追加Confirmationは不要とする。

Repository accessの制御はGitHub Token側で行う。public RepositoryについてはTokenで除外できない範囲がある（§Architecture）。

Phase 5ではAI Foundation独自allowlistや詳細Permission Engineを追加しない。

## Security / Privacy

以下をTool Result / Error Message / Logへ含めない。

```text
GITHUB_TOKEN
Authorization Header
Secretを含むProvider生Error
不要なGitHub API response field
```

Repository Mappingでは明示的に定義したProject / Details項目だけを取り出す。

Private RepositoryもDiscovery集合に含まれればProjectとして返すため、利用者はTokenへ付与するRepository accessを意図的に制限する。

自分が所有・参加するpublic RepositoryはTokenの選択と関係なくProject一覧に含まれる。public Repositoryの内容自体は公開情報だが、「AI FoundationのProject一覧に何を含めるか」は整理・プライバシー上の意味を持つため、この制約をREADMEに明記する。

## Acceptance Criteria

### Project / GitHub Boundary

GitHub RepositoryをProjectとして扱える。

Phase 5では1 GitHub Repository = 1 Projectとする。

GitHubをSource of Truthとして扱い、AI Foundation独自のProject Registry / DB / Cache / Indexを持たない。

Google Drive Project Connectorへ依存しない。

### Authentication / Configuration

`GITHUB_TOKEN` をCredential Provider経由で利用できる。

GitHub Connectorが直接 `process.env` を参照しない。

Project一覧を `config.yaml` に記述しない。

`sources.project.providers` に `github` がない場合、Project Toolは `ConfigurationError` になる。

### Project Mapping

Repositoryから以下をProjectへMappingできる。

```text
id           = github:<owner>/<repository>
type         = project
title        = repository name
source       = github
external_ref = canonical GitHub repository URL
```

Phase 5のGitHub Project Resultではexact IDを必ず返す。

### Project Details

`project_get` で最低限以下を取得できる。

```text
description
owner
default_branch
visibility
archived
fork
updated_at
```

README / Repository contents / Issue / Pull Requestを自動取得しない。

### project_list

認証済みTokenの `GET /user/repos` が返すDiscovery集合を動的に列挙できる。

空Filter `{}` で全対象Repositoryを取得できる。

`query` がrepository name / owner/repository / descriptionへの大文字小文字を区別しない部分一致として動作する。

`owner` がowner loginへの大文字小文字を区別しない完全一致として動作する。

`query` と `owner` を同時指定した場合はANDになる。

GitHub APIのPaginationを最後まで処理できる。

Pagination途中で失敗した場合に部分結果を返さない。

結果をcanonicalなowner/repository昇順で安定して返せる。

### project_get

`github:<owner>/<repository>` のexact IDでProjectを取得できる。

Repository名だけやfuzzy matchingでgetしない。

GitHub APIがrename / owner移管後のRepositoryへ解決する場合、現在のcanonical ID / URLを返せる。

### Repository Types

Discovery集合に含まれる以下をProjectとして扱える。

```text
public
private
internal
archived
fork
Organization-owned
```

### Current State / External Changes

AI Foundation独自CacheをSource of Truthにせず、次回Tool呼び出しでGitHub上の現在状態を反映できる。

削除済みまたはアクセス権を失ったRepositoryへのexact ID取得は `NotFoundError` になる。

### Security / Privacy

`/user/repos` のDiscovery集合をPhase 5のアクセス境界にできる（`project_get` もDiscovery集合外のRepositoryを `NotFoundError` にする）。Fine-grained PATのRepository selectionで自分のpublic Repositoryを除外できることは保証しない。

Token / Authorization HeaderをTool Result / Error Message / Logへ出さない。

GitHub API response全体をそのままTool Resultへ返さず、定義済みFieldのみMappingできる。

Repository不存在とアクセス権なしを `project_get` の外向けErrorで区別しない。

### Error Handling

最低限以下を区別できる。

```text
Input Validation Error
Credential Error
Target Not Found
Provider API Error
Configuration Error
```

Rate Limit / Network / 5xxは `ProviderApiError` として扱える。

独自RetryやRate Limit待機機構へ依存しない。

### Automated Test

通常Test Suiteは外部GitHub APIへ依存せず、Fake / Mock GitHub Clientで実行できる。

少なくとも以下を自動テストする。

```text
project_list {}
query filter
owner filter
query + owner
pagination
stable sort
public / private / internal
archived / fork
Organization Repository
project_get exact ID
invalid ID
rename後のcanonical mapping
404 / access denied
invalid credential
rate limit
network / 5xx
pagination途中失敗で部分結果を返さない
Credential漏洩防止
Provider生Responseの不要Fieldを返さない
```

### Integration Verification

実GitHub APIで少なくとも以下を確認する。

```text
Repository一覧取得
queryによるRepository検索
ownerによる絞り込み
exact IDによるproject_get
description / default_branch等のMetadata取得
public Repository取得
private Repository取得（利用可能な場合）
```

Integration VerificationではRepositoryへ書き込まない。

### LLM Client Verification

実装完了後、Claude Code等の実LLM ClientからAI Foundationへ接続し、少なくとも以下を確認する。

```text
「physical-ai-robotの情報を確認して」
→ project_list
→ exact ID
→ project_get

「AI Foundationのプロジェクトを探して」
→ project_list({ query: "AI Foundation" })

「thanatos27のプロジェクトを一覧して」
→ project_list({ owner: "thanatos27" })
```

## Coding Agent Task

Repository全体と上記Referenceを確認し、Phase 5のImplementation Planを作成すること。

Implementation Planには少なくとも以下を含める。

```text
現在のRepository状態
Phase 4までの実装への変更点
追加・変更予定File
Project Domain / Tool Input / Tool Result Schema
project_list / project_get Tool設計
ProjectConnector設計
GitHubProjectConnector設計
GitHub認証 / Credential Provider変更
Configuration変更
GitHub Repository Discovery方式
Pagination
query / owner Filter
stable sort
GitHub Project ID parse / validation
Repository → Project Mapping
project_get Details Mapping
rename / owner移管時のcanonical mapping
Repository不存在 / access deniedの扱い
Rate Limit / Network / GitHub API Error Mapping
Secret / Authorization情報の漏洩防止
実装順序
依存Package
Test Strategy
Integration Verification
LLM Client Verification
Acceptance Criteriaとの対応
Google Drive Project Connector追加時に維持する境界
懸念点 / 未確定事項
```

Implementation Plan作成時点では本実装を開始しないこと。

PlanをRepository内の適切な場所へMarkdownとして作成し、レビュー可能な状態にすること。
