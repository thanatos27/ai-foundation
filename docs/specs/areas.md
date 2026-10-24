# Areas MVP — Design

[Issue #13](https://github.com/thanatos27/ai-foundation/issues/13)（本文、詳細設計 v0.1 / v0.2）と、[Implementation Plan](../plans/areas-implementation-plan.md) のPlan Review（PR #17）で確定した事項をまとめる。[MVP v0.1仕様](mvp-v0.1.md) は変更せず、本書をAreasの仕様とする。

## Goal

PARAの **Areas（恒常的に管理する領域）** をAI Foundationから参照できるようにする。

ProjectsとAreasの本質的な差は「完了を目指す一時的な活動か / 継続的に管理する領域か」であり、Domain・Tool・Connectorの形は可能な範囲でProjectと揃える。

## MVP方針

- **Area = 関連情報へのリンクを集約した目次ドキュメント**とする。食事・資産・運動・整理整頓・家事などの専用Data ModelやAPIは作らない。
- 目次からNotionサブページ、Google Driveドキュメント、Knowledge等を参照できればよい。収集・整理・分析はLLMと既存Toolに任せる。
- Source of TruthはNotion。AI Foundation独自のDB・Cache・Index・Registryは持たない。
- Project側の既存挙動・Tool（`project_list` / `project_get`）は変更しない。

## Provider / 発見ルール

- Provider = Notion。専用Workspaceの通常ページ `Areas`（親ページ）の **直下の `child_page`** だけをAreaとみなす。専用Databaseは使わない。
- 子ページを再帰的にArea扱いしない。列・トグル等の中に置いた子ページもAreaではない。
- ゴミ箱のページ（`in_trash`）は除外する。Notionの「アーカイブ」（`is_archived`）は判定に使わない（将来のプラン変更でも一覧と取得の境界がずれないようにするため）。
- 既存の `NOTION_API_TOKEN` を再利用する。

## Domain

既存Domainの `Area` は work / personal の分類なので、PARAの概念は **`AreaResource`** と呼び、既存Schemaと互換性を保つ。

```ts
AreaResource {
  id: string            // "notion:<page-id>"
  type: "area"
  title: string         // 空タイトルは "Untitled"
  source: "notion"
  external_ref: string  // "https://www.notion.so/<32hex>"（一覧・取得で同一）
}
```

## MCP Tools（Read-only）

| Tool | Input | Output |
|---|---|---|
| `area_list` | `{ query? }`（タイトルの大文字小文字を区別しない部分一致） | `{ items: AreaResource[] }`（タイトル → ID順の安定ソート） |
| `area_get` | `{ id }`（`area_list` のID） | `{ area: AreaResource, content: string }` |

- `area_list`: 親ページのBlock childrenを最後までPaginationし、`child_page` だけを抽出する。Areaのページ本体は取得しない。
- `area_get`: exact IDでページを取得し、`parent` が `{ type: page_id, page_id: 親ページ }` でゴミ箱にないことを確認する。対象外は `NotFoundError`。本文Blockを取得して目次用Blockを Markdown相当のテキストに変換する。
- 同じ静的なNotion状態に対して、`area_list` の集合と `area_get` で取得できる集合は一致する（原子的な一致は保証しない）。
- 本文の取得範囲: 見出し・段落・リスト・To-do・トグル・引用・コールアウト・列・区切り線・コード・リンク系Block。ネストは3階層まで。非対応Block・深さ上限で取得しなかった内容は、本文中に「取得していない」ことが分かる注記を出す。
- 子ページ・リンク先の中身は取得しない（自動巡回しない）。目次中の `obsidian:…` / `github:…` 等の参照はLLMが既存Toolで辿り、対応Toolのない参照先はリンク提示に留める。
- Paginationの途中失敗では不完全な正常結果を返さない。

## Configuration

```yaml
sources:
  area:
    provider: notion
    notion:
      parent_page_id: "<Areas親ページID>"   # config.local.yaml に書く（Commitしない）
```

- `sources.area` も `parent_page_id` もOptional。未設定でもServerは起動し、Area Tool呼び出し時に `ConfigurationError`。
- Area一覧・Area IDはConfigに書かない。

## Error

| 状況 | Error |
|---|---|
| `sources.area` / `parent_page_id` 未設定、親ページの不存在・未共有・ゴミ箱 | `ConfigurationError` |
| 壊れたID | `InputValidationError` |
| 親ページ外のID、存在しないページ、ゴミ箱のページ | `NotFoundError` |
| Token失効 | `CredentialError` |
| 429 / 5xx / その他のAPI失敗 | `ProviderApiError` |

## 対象外

- Area固有のState / Log / Relation DB
- Areaの作成・更新・削除Tool
- 外部データの横断検索・自動同期・集計、専用分析ロジック
- Google Drive Provider（NotionとGoogle Driveの同時実装）
- 既存GitHub Projectの仕様変更、Google Drive Projectの新規実装

## Acceptance Criteria

- Areaを一時的なProjectと区別して一覧・詳細取得できる。
- 目次ドキュメントの参照先（URLまたはProvider固有参照ID）を取得できる。
- 目次に記したNotionサブページ・Knowledge等の参照先を、既存の対応Toolで追跡できる（未対応先はリンク提示に留める）。
- 親ページ直下の子ページのみAreaとして一覧表示し、Collection DBや通常Blockは除外する。
- `area_list` で部分一致検索・安定ソート・Paginationが機能する。
- `area_get` がタイトル / URLとリンクを含む目次を返す。
- 親ページ外のID、壊れたID、ゴミ箱のAreaの扱いを検証する。
- 親ページ未設定・未共有・CredentialError・Notion 429 / 5xx・途中ページ失敗を検証する。
- `project_list` / `project_get` の入出力と既存挙動、`collection_*` が後方互換である。
- 既存Provider・Credential・Error Handlingを再利用し、独自DBを追加しない。
- 通常TestはFake / Mockのみ。実API IntegrationはRead-onlyで検証できる。
- README等にAreaの登録方法と目次テンプレートを記載する。
