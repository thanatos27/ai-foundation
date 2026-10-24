# Areas MVP — Implementation Plan

- Status: **rev.2（Plan Review完了・User承認済み。実装済み: §23）**
- 作成: Coding Agent (Claude Code) / 2026-10-24（rev.2: 2026-10-24 PR #17 レビュー反映）
- 対象: [Issue #13 MVP: Areas管理（Projectsと共通化した目次ドキュメント方式）](https://github.com/thanatos27/ai-foundation/issues/13)（本文 + コメント「詳細設計 v0.1」「Areas MVP 詳細設計 v0.2」。**v0.2を正**とする）
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Phase 3 Design Issue](../specs/phase-3-collection.md), [Phase 5 Design Issue](../specs/phase-5-project.md), [Phase 5 Implementation Plan](phase-5-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

仕様に明記がなく本Planで決めた箇所は [§21 懸念点 / 未確定事項](#21-懸念点--未確定事項) にQとしてまとめている。ChatGPTによるPlan Review（PR #17）でQ1〜Q10はすべて提案どおり採用となった。補記の指摘への対応は [§22 Review対応履歴](#22-review対応履歴) を参照。Q7は実装前に実Notion APIで確認する（§14 手順0）。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/areas-implementation-plan`。Baseは `main` の `f6cac47`（Phase 5実装 PR #9 のMerge） |
| Repository | `thanatos27/ai-foundation`（**Public**） |
| 依存 | `@notionhq/client 5.27.0`（API version `2026-03-11` を `NOTION_API_VERSION` で固定済み）。**追加依存なし** |
| 公開Tool | 15件（`task_*` 4 / `schedule_*` 2 / `collection_*` 3 / `knowledge_*` 4 / `project_*` 2） |

### 既存実装の要点（Areasで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/domain/common.ts` | `AreaSchema = enum(['work', 'personal'])` が **既に存在**（Task / Knowledgeの分類、`defaults.area`）。PARAのAreaとは別概念。`NonBlankSchema` もここにある |
| `src/domain/project.ts` | `ProjectSchema { id?, type: 'project', title, source, external_ref }`、`ProjectResultSchema`（id必須）、`ProjectListFilterSchema`、`ProjectGetResultSchema { project, details }` |
| `src/config/schema.ts` | すべてstrict。`sources` は `task / schedule / collection / knowledge / project` の5つで、いずれも必須。Notion固有の値（`collection.data_source_id`）はOptionalで、未設定時はTool呼び出し時に `ConfigurationError` |
| `src/connectors/notion/client.ts` | `NotionClient` は SDK Clientを `Pick` した最小Interface（`dataSources.retrieve/query`, `pages.create/retrieve/update`, `blocks.children.append`）。`lazyNotionClient` / `toFoundationError(error, { notFound })` |
| `src/connectors/notion/mapping.ts` | `parseCollectionId`（`notion:<uuid | 32hex>`）、`sameNotionId`（ハイフン・大文字小文字を無視して比較）など。Collection専用の名前・Messageになっている |
| `src/connectors/notion/connector.ts` | `NotionCollectionConnector`。Paginationで `has_more` / `next_cursor` を最後まで辿る、`in_trash` を除外する、親（data source）外のPageは `NotFoundError` にする、というAreasと同型の境界処理を持つ |
| `src/connectors/index.ts` | `createConnectors` で `lazyNotionClient(credentials)` をCollection用に1つ生成 |
| `src/connectors/github/filter.ts` | 大文字小文字を無視した序数比較 + 元文字列の序数比較でstable sort（Phase 5 Q5） |
| `src/tools/project.ts` | Read-only Tool 2件。`connector()` でProvider判定とConnector未設定を `ConfigurationError` にする |
| `src/instructions.ts` | MVP §15の文面。Areaの記載はない |
| `tests/connectors/notion/fake-client.ts` | In-memory Notion（data source / page / block）。`blocks.children.list` は未対応 |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 15件を前提とするAssertion |

### Notion SDK 5.27（API `2026-03-11`）で確認した事実

| 項目 | 内容 |
|---|---|
| `blocks.children.list({ block_id, start_cursor?, page_size? })` | `{ results: (PartialBlockObjectResponse \| BlockObjectResponse)[], has_more, next_cursor }`。`page_size` 最大100。直下の子Blockのみ返す（孫は返さない） |
| `child_page` Block | `{ type: 'child_page', child_page: { title: string }, id, has_children, in_trash, parent }`。**Block idは子ページのPage idと同じ**。タイトルはplain textのstringで、Page本体を取得せずに得られる |
| `PageObjectResponse` | `in_trash`、`is_archived`、`url`、`parent`（`{ type: 'page_id', page_id }` / `block_id` / `data_source_id` / `workspace` 等） |
| Rich text | `{ plain_text, href, annotations, type: 'text' \| 'mention' \| 'equation' }`。Page mentionは `href` にNotion URLを持つ。テキストリンクでNotion内Pageを指す場合、`href` は `/<page-id>` の相対パスになることがある |
| `isFullBlock` / `isFullPage` | SDKが提供するType Guard |
| `pages.retrieveMarkdown` | `GET /v1/pages/{id}/markdown` → `{ markdown, truncated, unknown_block_ids }` もSDKに存在する（Q5で扱い） |

---

## 2. 設計方針

1. **既存構造をそのまま使う。** Tool → `ToolContext.connectors.area` → `NotionAreaConnector` → `NotionClient`（SDK）。Collectionと同じ `lazyNotionClient` instanceを共有する。
2. **Notionが唯一の正本。** Area Registry / Cache / Index / 専用DBを持たない。`area_list` / `area_get` は毎回Notion APIを呼ぶ。
3. **発見集合 = アクセス境界。** Areaは「`parent_page_id` のPage直下の `child_page` Block」。`area_get` は対象Pageの `parent` が `{ type: 'page_id', page_id: <設定の親> }` であることを確認する。この2条件が同じ集合を指すことを§9で示し、Testで固定する（Phase 5 §11.1と同じ考え方）。
4. **構造的にRead-only。** Areasが使うSDKメソッドは `pages.retrieve` と `blocks.children.list` のみ。書き込みメソッドを呼ぶコードパスを作らない。
5. **巡回しない。** 子ページ本文・リンク先・`child_page` の中身は取得しない。Area本文内のネストBlockは§11で定める深さまでだけ取得する。
6. **黙って欠落させない。** Paginationの途中失敗は正常結果にしない。非対応Block・深さ上限で省略した内容は本文中に注記を残す（§11.4）。
7. **既存のErrorと変換を再利用する。** `toFoundationError` / 5分類をそのまま使い、`errors.ts` は変更しない。
8. **既存Schemaとの互換性。** PARAのAreaは `AreaResource` と命名し、既存の `AreaSchema`（work / personal）・`defaults.area`・`project_*` の入出力を一切変更しない。

---

## 3. 既存実装への変更点（概要）

| 対象 | 変更 | 理由 |
|---|---|---|
| `domain/area-resource.ts`（新規）, `domain/index.ts` | `AreaResource` / Tool Input / Result Schema | v0.2 §MCP |
| `config/schema.ts` | `sources.area`（Optional、§7）を追加 | v0.2 §設定 |
| `config.yaml` | `sources.area.provider: notion` とコメントアウトした `parent_page_id` | 設定例 |
| `connectors/notion/client.ts` | `NotionClient.blocks.children` に `list` を追加 | v0.2 §設定 / 境界 |
| `connectors/notion/id.ts`（新規）, `mapping.ts` | `notion:<page-id>` のparseと `sameNotionId` をCollection / Area共通の関数へ移す。`parseCollectionId` は薄いWrapperとして残し、Messageは変えない | 最小限の共通化（Issueスコープ1） |
| `connectors/notion/area-connector.ts`（新規） | `NotionAreaConnector` | 一覧・取得・境界 |
| `connectors/notion/area-content.ts`（新規） | Block → Markdown相当テキスト（純粋関数） | `area_get.content` |
| `connectors/types.ts` | `AreaConnector`、`Connectors.area?` | Connector境界 |
| `connectors/index.ts` | `lazyNotionClient` を1つ作りCollectionとAreaで共有、`NotionAreaConnector` を生成 | 配線 |
| `tools/area.ts`（新規）, `tools/index.ts` | `area_list` / `area_get` | Tool公開 |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 15件 → 17件 | Tool公開 |
| `README.md` | Tool一覧、Areaの登録方法、目次テンプレート、MVPの取得範囲 | Issue AC、Q4 |
| `instructions.ts` | `Area:` の項を追記（Q6） | LLMがAreaとそのSoTを知るため |
| `docs/specs/areas.md`（新規） | Issue #13本文 + v0.2を仕様ファイルとして記録（Q6） | 過去Phaseと同じく仕様をRepositoryに残す |
| `tests/server.test.ts` | Instructions文面のAssertionを更新（Q6） | Q6 |

**変更しないもの**: `src/errors.ts`（403 Messageを含む、Q8）、`src/domain/common.ts`（`AreaSchema` を含む）、`src/domain/project.ts`、`src/connectors/github/**`、`src/tools/project.ts`、`src/credentials/**`（`NOTION_API_TOKEN` を再利用）、`.env.example`、Collectionの挙動・Message、`docs/specs/mvp-v0.1.md`（破壊的に書き換えない。Q6）。

---

## 4. 追加・変更予定ファイル

### 4.1 Source

| File | 種別 | 責務 |
|---|---|---|
| `src/domain/area-resource.ts` | 新規 | §5 |
| `src/domain/index.ts` | 変更 | `export * from './area-resource.js'` |
| `src/config/schema.ts` | 変更 | §7 |
| `src/connectors/notion/client.ts` | 変更 | `blocks: { children: Pick<…, 'append' \| 'list'> }` |
| `src/connectors/notion/id.ts` | 新規 | `parseNotionPageId(id, hint)`、`sameNotionId`、`compactNotionId`、`notionPageUrl`（純粋関数） |
| `src/connectors/notion/mapping.ts` | 変更 | `parseCollectionId` / `sameNotionId` を `id.ts` へ委譲（re-exportで既存importを壊さない） |
| `src/connectors/notion/area-content.ts` | 新規 | Rich text / Block → テキスト変換、非対応・省略の注記（純粋関数） |
| `src/connectors/notion/area-connector.ts` | 新規 | `NotionAreaConnector`。親ページ確認、Pagination、境界確認、Filter / Sort、本文Blockの取得 |
| `src/connectors/types.ts` | 変更 | `AreaConnector`、`Connectors.area?` |
| `src/connectors/index.ts` | 変更 | 配線 |
| `src/tools/area.ts` | 新規 | `area_list` / `area_get` |
| `src/tools/index.ts` | 変更 | `registerAreaTools` 呼び出し |
| `src/instructions.ts` | 変更 | `Area:` の項を `Project:` の後に追記（Q6） |

### 4.2 Tests

| File | 種別 | 内容 |
|---|---|---|
| `tests/domain/area-resource.test.ts` | 新規 | Input / Result Schema |
| `tests/config/schema.test.ts` | 変更 | `sources.area` 省略可、`parent_page_id` の形式、未知Keyの拒否 |
| `tests/connectors/notion/id.test.ts` | 新規 | parse / 比較 / URL生成 |
| `tests/connectors/notion/area-content.test.ts` | 新規 | Block種別ごとの変換、ネスト、注記、相対href |
| `tests/connectors/notion/fake-client.ts` | 変更 | `blocks.children.list`（Block tree、固定page sizeのPagination、n回目のErrorの注入） |
| `tests/connectors/notion/area-connector.test.ts` | 新規 | Fake NotionClientで一覧 / 取得 / 境界 / Error |
| `tests/connectors/notion/mapping.test.ts`, `connector.test.ts` | 変更なし | Collection回帰（`parseCollectionId` のMessageが同一であること） |
| `tests/helpers/fake-connectors.ts` | 変更 | `FakeAreaConnector` |
| `tests/tools/area.test.ts` | 新規 | Fake ConnectorでTool Layer |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 変更 | Tool 17件、`parent_page_id` 未設定時の `area_list` が `ConfigurationError` |
| `tests/integration/notion-area.integration.test.ts` | 新規 | 実Notion APIへのRead-only Integration Test（手動起動、§18） |

### 4.3 Project設定 / Documentation

| File | 変更 |
|---|---|
| `config.yaml` | §7.2 |
| `README.md` | Current Phase / Tool一覧、「Areas」節（登録方法・目次テンプレート・MVPの取得範囲・Troubleshooting）、Directory Structure、Documentation |
| `docs/plans/areas-implementation-plan.md` | 本Plan。実装後に「実装・Integration Verificationで確定した事項」を追記する |
| `docs/specs/areas.md` | 新規（Q6）。Issue #13本文と詳細設計v0.2（Plan Reviewで確定したQ1〜Q10を含む）を記録する。`mvp-v0.1.md` は書き換えない |

---

## 5. AreaResource Domain / Tool Input / Tool Result Schema

`src/domain/area-resource.ts` に置く。ID形式（`notion:<page-id>`）の検証はConnector（`id.ts`）で行い、Domain Schemaは `min(1)` に留める（Phase 3〜5と同じ分担）。

```ts
export const AreaResourceSourceSchema = z.enum(['notion']);

/**
 * A PARA area: a long-lived area of responsibility whose page is a table of contents linking to
 * related pages, knowledge and projects. Not the work / personal `Area` used by tasks and knowledge.
 */
export const AreaResourceSchema = z.object({
  id: z.string().min(1),
  type: z.literal('area'),
  title: z.string().min(1),
  source: AreaResourceSourceSchema,
  external_ref: z.string().min(1),
});

/** Input of `area_list`. `{}` lists every area. */
export const AreaListFilterSchema = z.strictObject({
  /** Case-insensitive substring of the title. */
  query: NonBlankSchema.optional(),
});

/** Input of `area_get`: an exact id (`notion:<page-id>`) from `area_list`. */
export const AreaGetInputSchema = z.strictObject({ id: z.string().min(1) });

/** `area_get` result: the area and its table of contents as Markdown-like text. */
export const AreaGetResultSchema = z.object({
  area: AreaResourceSchema,
  content: z.string(),
});
```

- **Projectとの共通化**: Field構成（`id / type / title / source / external_ref`）と、`*_list`（`{ items }`）/ `*_get` の形をProjectに揃える。`ProjectSchema` は `id` がOptionalで `source` が別Enumのため、共通Base Schemaへの抽出は既存Schemaの変更になるので行わない（後方互換を優先。Issue「大規模リファクタリングは避ける」）。
- `query` は `NonBlankSchema`（空白のみを拒否）。Project / Knowledgeと同じ。
- `content` は空文字を許可する（目次が空のArea）。

---

## 6. Tool設計（`src/tools/area.ts`）

```ts
const ListOutputSchema = z.object({ items: z.array(AreaResourceSchema) });

export function registerAreaTools(server: McpServer, { config, connectors }: ToolContext): void {
  const connector = (): AreaConnector => {
    if (!config.sources.area) throw new ConfigurationError('sources.area is not configured');
    if (!connectors.area) throw new ConfigurationError('the area source (Notion) is not configured');
    return connectors.area;
  };
  // area_list / area_get: annotations { readOnlyHint: true, openWorldHint: true }
}
```

| Tool | Input | Output | Description（要旨） |
|---|---|---|---|
| `area_list` | `{ query? }` | `{ items: AreaResource[] }` | PARAのArea（継続的に管理する領域。例: 食事・資産・運動）を一覧する。完了を目指す一時的な活動はProject（`project_list`）。queryはタイトルの大文字小文字を無視した部分一致。タイトル順。本文は含まないので `area_get` を使う |
| `area_get` | `{ id }` | `{ area, content }` | `area_list` のidでAreaの目次を取得する。contentはMarkdown相当のテキストで、関連ページ・Knowledge・Project等へのリンクを含む。リンク先は取得しないので、`obsidian:…` は `knowledge_get`、`github:…` は `project_get` 等の対応Toolで辿り、対応Toolのないリンク（Notionの他ページ・Google Drive等）はURLとして提示する。idは推測せず `area_list` から得る |

Description内でProject / Areaの区別とリンクの辿り方を明示し、LLMが `project_list` と `area_list` を使い分けられるようにする（Issue AC「Areaを一時的なProjectと区別して」）。

---

## 7. Configuration

### 7.1 Schema（`src/config/schema.ts`）

```ts
/** A Notion page ID: hyphenated UUID or the 32-hex form used in Notion URLs. */
const NotionPageIdSchema = z.string().regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i, …);

sources: z.strictObject({
  …,
  /**
   * PARA areas. Optional so that existing local configs keep working; the area tools return a
   * configuration error without it (Q1).
   */
  area: z
    .strictObject({
      provider: z.enum(['notion']),
      notion: z
        .strictObject({
          /** The page whose direct child pages are the areas. Personal: keep it in config.local.yaml. */
          parent_page_id: NotionPageIdSchema.optional(),
        })
        .optional(),
    })
    .optional(),
}),
```

- `parent_page_id` の形式不正は起動時の `ConfigError`（Configの他の値と同じ扱い）。未設定は起動可能で、Area Tool呼び出し時に `ConfigurationError('sources.area.notion.parent_page_id is not set')`。
- Area一覧・Area IDはConfigに書けない（strict）。AGENTS.md「個別Project名・ID等の動的データを列挙しない」を維持。

### 7.2 `config.yaml`

```yaml
  area:
    # PARA areas: the child pages directly under one Notion page (see README "Areas").
    # Do not list areas here; add or remove child pages in Notion.
    provider: notion
    # The Areas parent page. This repository is public: set it in config.local.yaml.
    # notion:
    #   parent_page_id: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

---

## 8. AreaConnector / NotionClient

### 8.1 Interface（`src/connectors/types.ts`）

```ts
/** Source of Truth: Notion. Read-only: areas are the child pages directly under the configured parent page. */
export interface AreaConnector {
  /** Every area matching `filter`, sorted by title (ignoring case), then id. */
  list(filter: AreaListFilter): Promise<AreaResource[]>;
  /** The area with this exact id and its table of contents. Only areas that `list` can return are available. */
  get(id: string): Promise<AreaGetResult>;
}
```

### 8.2 NotionClient（`src/connectors/notion/client.ts`）

```ts
blocks: { children: Pick<Client['blocks']['children'], 'append' | 'list'> };
```

`append` はCollectionが使うため残すが、`NotionAreaConnector` からは呼ばない（Testで呼び出し記録が `pages.retrieve` / `blocks.children.list` のみであることを確認する）。

### 8.3 `NotionAreaConnector` のOptions

```ts
export interface NotionAreaConnectorOptions {
  client: () => Promise<NotionClient>;          // createConnectorsでCollectionと同じinstance
  parentPageId: string | undefined;             // sources.area.notion.parent_page_id
}
```

### 8.4 共通の内部処理

| メソッド | 処理 |
|---|---|
| `parentPage(api)` | `pages.retrieve(parentPageId)`。404 → `ConfigurationError("Notion page <id> (sources.area.notion.parent_page_id) was not found or is not shared with the AI Foundation connection")`。Full pageでない / `in_trash` → 同様の `ConfigurationError` |
| `listChildren(api, blockId, onNotFound)` | `blocks.children.list({ block_id, page_size: 100, start_cursor })` を `has_more` が `false` になるまで繰り返す。どのPageで失敗しても例外を投げ、途中までの結果は返さない。`PartialBlockObjectResponse`（`isFullBlock` でない要素）が含まれたら `ProviderApiError`（種別不明のBlockを黙って捨てない、Q10） |

`parentPage` は `list` / `get` の両方で毎回呼ぶ（親ページがゴミ箱へ移った・共有が外れた状態で、`get` だけ成功する不整合を防ぐ。Q9）。

---

## 9. Area発見ルールとアクセス境界

### 9.1 `area_list`

1. `parentPageId` 未設定 → `ConfigurationError`
2. `parentPage(api)`
3. `listChildren(api, parentPageId)` で親ページ直下のBlockを全件取得
4. `type === 'child_page' && !in_trash` のBlockだけを残す（`child_database`、Collection DB、段落等の通常Block、`link_to_page` は除外）
5. `AreaResource` へMapping（§10）→ `query` Filter → Sort（§9.3）

子ページ本体（`pages.retrieve`）は取得しない（v0.2「ページ本体は取得しない」）。

### 9.2 `area_get`

1. `parseNotionPageId(id)`（不正 → `InputValidationError`）
2. `parentPageId` 未設定 → `ConfigurationError`
3. `parentPage(api)`
4. `pages.retrieve(pageId)`。404 → `NotFoundError("area <id>")`
5. 境界確認: `isFullPage(page) && !page.in_trash && page.parent.type === 'page_id' && sameNotionId(page.parent.page_id, parentPageId)`。満たさなければ `NotFoundError("area <id>")`（存在を明かさない。Collectionの `collectionPage` と同じ）
6. 本文Blockを取得して変換（§11）。この途中の404も `NotFoundError`（取得の間に削除・移動された場合）
7. `{ area: toAreaResource(page), content }`

### 9.3 一覧と取得の境界が一致する理由

**同じ静的なNotion状態に対して** `list` が返す集合と `get` が成功する集合が一致する設計とする。`list` と `get` は別々のAPI呼び出しなので、その間にNotion上でページの移動・削除・共有変更が起これば結果は変わり得る。原子的な一致は保証しない（Snapshotを持たないのはSoT方針どおり）。

- Notionでは、ページAの直下（トップレベル）にある子ページPは、Aの `blocks.children` に `child_page` Block（Block id = P のPage id）として現れ、Pの `parent` は `{ type: 'page_id', page_id: A }` になる。
- 親ページ内の列（`column`）・トグル・同期Block等の中に置いた子ページは、`parent` が `{ type: 'block_id' }` になり、Aの直下の `children` にも現れない。**両Toolとも対象外**になる（v0.2「子ページを再帰的にArea扱いしない」とも整合）。READMEに「Areaは親ページ直下（列やトグルの外）に置く」と書く。
- ゴミ箱: 一覧は `child_page.in_trash`、取得は `page.in_trash` で除外する。`page.is_archived` は**どちらのToolも判定に使わない**（`get` だけが除外する不整合を作らない。Q7）。
- Testでは、静的なFake状態に対して「`list` が返すid集合」と「`get` が成功するid集合」が一致することを1ケースで確認する（直下 / 列の中 / 孫 / 別親 / ゴミ箱 / Collection Page を混在させる）。

### 9.4 query Filter / Sort（`area-connector.ts` 内の純粋関数）

- `query`: `title.toLowerCase().includes(query.toLowerCase())`。全角半角・空白の正規化はしない（Phase 5 Q3と同じ方針）。
- Sort: タイトルを `toLowerCase()` した序数比較 → 元のタイトルの序数比較 → idの序数比較。Runtime localeに依存しない（Phase 5 Q5と同じ比較）。
- 同じidが重複して返った場合（Pagination中の変更）は1件にする。

---

## 10. AreaResource Mapping / ID

### 10.1 ID（`src/connectors/notion/id.ts`）

| 関数 | 内容 |
|---|---|
| `parseNotionPageId(id, { kind, from })` | `notion:<uuid>` / `notion:<32hex>` → page id。不正なら `InputValidationError('id must be "notion:<page-id>" as returned by <from>: <id>')`。`parseCollectionId` はこれを `kind: 'collection'`, `from: 'collection_search'` で呼ぶWrapperになり、Messageは現行と同一 |
| `sameNotionId(a, b)` | 現行 `mapping.ts` から移動（挙動同一） |
| `formatNotionId(pageId)` | `notion:<uuid（ハイフン付き・小文字）>`。SDKが返すidをそのまま使う |
| `notionPageUrl(pageId)` | `https://www.notion.so/<32hex>`（Q2） |

返却するidは常にSDKが返すハイフン付きUUID。入力は32hex / 大文字も受け付け、`sameNotionId` で比較する（Collectionと同じ）。

### 10.2 Mapping

| Field | `area_list`（`child_page` Block から） | `area_get`（Page から） |
|---|---|---|
| `id` | `formatNotionId(block.id)` | `formatNotionId(page.id)` |
| `type` | `'area'` | `'area'` |
| `title` | `block.child_page.title` | `type === 'title'` のPropertyの `title[].plain_text` を連結（Property名に依存しない） |
| `source` | `'notion'` | `'notion'` |
| `external_ref` | `notionPageUrl(block.id)` | `notionPageUrl(page.id)` |

- `get` のタイトルは `page.properties` を名前で引かず、値の `type === 'title'` で探す。通常ページの子ページではProperty名は `title` だが、Notionでは名前が任意になり得るため（Collectionの `Name` のように）名前を固定しない。`title` 型Propertyがない・複数ある場合は `ProviderApiError`。Testでは任意のProperty名、複数のRich text要素の連結、mentionを含むタイトルを扱い、Integration Test（§18.1）で実レスポンスの形と `child_page.title` との一致を確認する。
- 空タイトル（Notion上の「Untitled」）は `"Untitled"` とする（Q3）。両Toolで同じ扱い。
- `external_ref` は一覧ではPage本体を取得しないため `page.url` を使えない。同じAreaが両Toolで同じ `external_ref` になるよう、どちらも `notionPageUrl` で組み立てる（Q2）。

---

## 11. 目次本文（`content`）の取得と変換

### 11.1 取得範囲

- Area pageの `blocks.children` を全件Paginationで取得する（トップレベル）。
- `has_children: true` のBlockのうち、§11.2で「子を展開する」としたものだけ、子を再帰取得する。**深さ上限は3**（トップレベル = 1。Q4）。上限を超える子は取得せず注記する。
- `child_page` / `child_database` / `link_to_page` の中身、リンク先は取得しない。
- 取得途中のどのRequestが失敗しても、`area_get` 全体を失敗させる（部分結果を返さない）。

### 11.2 Block変換（`area-content.ts`、純粋関数）

入力は取得済みのBlock tree（`{ block, children?: Node[], omittedChildren?: boolean }`）とし、API呼び出しはConnector側に置く（変換をFakeなしでTestするため）。

| Block | 出力 | 子を展開 |
|---|---|---|
| `heading_1` / `heading_2` / `heading_3` / `heading_4` | `#` / `##` / `###` / `####` + テキスト | toggle見出しのみ ○ |
| `paragraph` | テキスト | ○ |
| `bulleted_list_item` | `- ` + テキスト | ○（2 space indent） |
| `numbered_list_item` | `1. ` + テキスト（番号はMarkdownの自動採番に任せる） | ○ |
| `to_do` | `- [ ] ` / `- [x] ` + テキスト | ○ |
| `toggle` | `- ` + テキスト | ○ |
| `quote` | `> ` + テキスト | ○ |
| `callout` | `> ` + テキスト | ○ |
| `column_list` / `column` | 自身は出力せず、子をそのまま並べる | ○ |
| `divider` | `---` | — |
| `child_page` | `- [<title>](<notionPageUrl>)` | ×（巡回しない） |
| `child_database` | `- [<title>](<notionPageUrl>) (Notion database)` | × |
| `link_to_page` | `- [Notion page](<notionPageUrl(page_id)>)`（database_idも同様、comment_idは非対応扱い） | × |
| `bookmark` / `embed` / `link_preview` | `[<caption or url>](<url>)` | × |
| `code` | ` ``` `で囲んだテキスト | × |
| 上記以外（`image` / `file` / `pdf` / `video` / `audio` / `table` / `equation` / `synced_block` / `table_of_contents` / `breadcrumb` / `template` / `meeting_notes` 等） | 注記（§11.4） | × |

Rich text → テキスト:

- `plain_text` を連結する。`href` があれば `[plain_text](href)`。太字等のannotationは無視する。
- `href` が `/` で始まる（Notion内の相対リンク）場合は `https://www.notion.so` を前置して絶対URLにする（LLMが提示・利用できる形にする）。
- Page / Database mentionは `href` を持つためリンクとして出る。User / Date mentionは `plain_text` のみ。
- Markdown記号のEscapeはしない（目次テキストをそのままLLMに渡す。`content` は表示用ではなくLLMの入力）。

ユーザーが本文に書いた `obsidian:…` / `github:…` 等のFoundation IDはテキストとしてそのまま出るので、LLMは対応Toolで辿れる（Issue AC。READMEの目次テンプレートでこの書き方を推奨する、§17）。

### 11.3 出力形式

- Blockごとに1行（複数行テキストは改行を保つ）、ネストは2 spaceのindent。Block間は `\n` で連結し、見出し・段落の前後に空行を入れる程度の最小整形に留める。
- 先頭にタイトル等のヘッダは付けない（`area.title` で返すため）。

### 11.4 省略の注記（黙って欠落させない）

| 状況 | 本文に出す注記 |
|---|---|
| 非対応Block | `[unsupported Notion block: <type>]`（Block 1つにつき1行。連続する同種は `… x<n>` にまとめる） |
| 非対応Blockが子を持つ（`has_children: true`） | 子は取得せず、`[unsupported Notion block: <type>; its nested blocks were not retrieved]` とする（内容が未取得であることを明示する） |
| 深さ上限で子を取得しなかった | 親Blockの直後に1段深いindentで `[nested blocks not retrieved: depth limit 3]` |
| `child_page` / `child_database` / `link_to_page` | リンクのみ。中身を取得しないのは仕様どおりなので注記しない（Tool descriptionで「リンク先は取得しない」と明記する） |

いずれの注記も「未取得」であることが分かる文言にし、LLMが本文を全文取得済みと誤認しないようにする。

注記の文言はTool descriptionにも記載し、LLMが「Notionで直接開けば見られる」と案内できるようにする。

---

## 12. Error Mapping

既存の `toFoundationError(error, { notFound })` を使い、`notFound` だけ呼び出し箇所ごとに渡す。

| 状況 | Error |
|---|---|
| `sources.area` なし | `ConfigurationError('sources.area is not configured')`（Tool層） |
| `parent_page_id` 未設定 | `ConfigurationError('sources.area.notion.parent_page_id is not set')` |
| 親ページ 404 / 未共有 / ゴミ箱 / Pageでない | `ConfigurationError`（親ページIDを含み、Tokenを含まない） |
| 壊れたID | `InputValidationError` |
| 対象Page 404 / 親ページ外 / ゴミ箱 / 本文取得中の404 | `NotFoundError('area notion:<id>')` |
| 401 `unauthorized` | `CredentialError`（既存） |
| 403 `restricted_resource` | `ConfigurationError`（既存のMessageはCollection向けに「read, update and insert content」と書いている。Q8） |
| 429 / 5xx / Network | SDKの既存Retry（`maxRetries: 2`）後に `ProviderApiError('Notion', …)` |
| Paginationの途中失敗 | 上記の分類のまま投げる（それまでの結果は捨てる） |
| `PartialBlockObjectResponse` が混入 | `ProviderApiError`（Q10） |

---

## 13. 配線（`src/connectors/index.ts`）

```ts
const notion = lazyNotionClient(credentials); // Collection と Area で共有
return {
  …,
  collection: new NotionCollectionConnector({ client: notion, dataSourceId: config.sources.collection.data_source_id }),
  area: new NotionAreaConnector({ client: notion, parentPageId: config.sources.area?.notion?.parent_page_id }),
};
```

起動時にNotionへアクセスしない（Phase 2〜5方針）。Collectionの挙動は、Client instanceを共有することで変わらない（Credential取得の遅延・失敗時の再試行も同一）。

---

## 14. 実装順序

0. **実装前のQ7確認（Read-only、2026-10-24 実施済み・齟齬なし。結果はQ7）**: 実Notion APIで、`Areas` 直下の子ページを「アーカイブ」した状態（Notion UIで可能な場合）と「ゴミ箱へ移動」した状態で、`blocks.children.list` の `child_page`（返るか・`in_trash`）と `pages.retrieve` の `in_trash` / `is_archived` を確認する。`list` と `get` の判定がずれる（例: アーカイブ済みが一覧に出ない一方で `pages.retrieve` は `in_trash: false`）場合は、**実装に入る前に報告する**。テスト用ページの準備はUserにお願いする
1. `domain/area-resource.ts` + Test
2. `config/schema.ts` + `config.yaml` + Test
3. `notion/id.ts` 抽出（`mapping.ts` を委譲に変更）→ 既存Collection Testが無変更で通ることを確認
4. `notion/client.ts` に `list` 追加、`fake-client.ts` 拡張
5. `notion/area-content.ts` + Test
6. `notion/area-connector.ts` + Test（境界一致Testを含む）
7. `connectors/types.ts` / `index.ts`
8. `tools/area.ts` / `tools/index.ts` + `FakeAreaConnector` + Tool Test
9. `server.test.ts` / e2e更新、`npm run typecheck` / `npm test`
10. `instructions.ts`、`docs/specs/areas.md`、README
11. Integration Test・手動Verification・LLM Client Verification（§18、§19）、本Planへ結果を追記

実装Branchは `main` から作成する `feat/areas`。

---

## 15. 依存Package

追加なし。`@notionhq/client` の既存Versionで `blocks.children.list`・`child_page`・`isFullBlock` を利用できることを確認済み（§1）。

---

## 16. Test Strategy

### 16.1 方針

- 通常Test（`npm test`）はFake / Mockのみ。実APIへ到達しない（e2eはCredential環境変数を削除済み）。
- 純粋関数（ID / 変換 / Filter / Sort）は単体で、ConnectorはFake NotionClientで、Tool層はFake Connectorで検証する（Phase 3〜5と同じ層分け）。

### 16.2 Domain / Config

- `AreaListFilterSchema`: `{}`、`query` 通常値、空文字・空白のみ拒否、未知Key拒否
- `AreaGetResultSchema`: `content: ''` を許可
- Config: `sources.area` 省略で起動可、`provider` 以外の値拒否、`parent_page_id` のUUID / 32hex 受理・不正形式拒否、`sources.area` 内の未知Key拒否

### 16.3 純粋関数

- `id.ts`: 両形式のparse、大文字、prefixなし・別prefix・短い値の拒否、`parseCollectionId` のMessageが従来と同一
- `area-content.ts`: §11.2の各Block、Rich textのリンク・相対href・mention、ネストのindent、`column_list` の透過、非対応Blockと連続のまとめ、深さ上限の注記、空本文

### 16.4 Connector（`area-connector.test.ts`、Fake NotionClient）

| 観点 | ケース |
|---|---|
| 一覧 | 0件 / 複数件、`child_page` 以外（段落・`child_database`・`link_to_page`）の除外、ゴミ箱の除外、Paginationを跨ぐ件数（Fakeのpage sizeを小さくする） |
| Filter / Sort | 部分一致・大文字小文字無視・0件Hit、タイトル同一時のid順、Pagination中の重複除去 |
| 取得 | 正常（Areaとcontent）、32hex / 大文字IDで取得しても返すidは正規形、子ページ本文・リンク先を取得しないこと（呼び出し記録）、title PropertyがNotion既定名以外でもタイトルを取れる・title Propertyなし → `ProviderApiError`、`is_archived: true`（`in_trash: false`）のPageは一覧にも取得にも出る |
| 本文の未取得表示 | 子を持つ非対応Blockの注記、深さ上限の注記 |
| 境界 | 親外Page、列の中の子ページ、孫ページ、Collection Page、ゴミ箱Page → `NotFoundError`。`list` のid集合 = `get` 成功のid集合 |
| 親ページ | 未設定 / 404 / ゴミ箱 → `ConfigurationError`（list・get両方） |
| Error | 401 → `CredentialError`、429 / 500 → `ProviderApiError`、2ページ目で失敗 → 例外（部分結果なし）、本文取得中の404 → `NotFoundError`、Partial block → `ProviderApiError` |
| Read-only | 呼び出されたメソッドが `pages.retrieve` / `blocks.children.list` のみ |

### 16.5 Tool Layer / Server / e2e

- `tests/tools/area.test.ts`: 入出力Schema、`sources.area` なし / Connectorなしで `ConfigurationError`、Connector Errorの伝播
- `server.test.ts` / e2e: 公開Tool 17件。e2eで `config.yaml`（`parent_page_id` なし）の `area_list` が `ConfigurationError`
- Project回帰: `project_*` の既存Testを変更せず通す（入出力の後方互換）。Collection回帰: `notion/*` 既存Testを変更せず通す

---

## 17. README

- Current Phase / Tool一覧に `area_list` / `area_get` を追加
- 「Areas」節:
  1. Notionの専用Workspaceに通常ページ `Areas` を作り、Integrationを Connections に追加する（子ページは共有を継承する）
  2. `Areas` のページIDを `config.local.yaml` の `sources.area.notion.parent_page_id` に設定する。**このRepositoryはPublicなので、ページIDは `config.yaml` やTest・ドキュメントに書かずCommitしない**（`config.local.yaml` はgit-ignored）
  3. Areaごとに `Areas` 直下へ子ページを作る（列・トグルの中に置かない、子ページの子はAreaにならない）。Integration Test（`npm run test:integration`）は、子ページが**最低1件**あることを前提とする
- MVPの取得範囲（Q4）: `area_get` は対応Block（見出し・段落・リスト・to_do・toggle・quote・callout・列・divider・code・リンク系）を変換し、ネストは深さ3まで取得する。表・画像・ファイル等の非対応Blockと、深さ3を超える内容は取得せず注記を出す。子ページ・リンク先の中身は取得しない
- 目次テンプレート（例）:

  ```markdown
  # 食事管理
  ## 記録
  - 食事記録（Notionの子ページ or リンク）
  ## Knowledge
  - obsidian:Knowledge/栄養の基本.md
  ## Project
  - github:<owner>/<repository>
  ## Task
  - Todoistの「食事」ラベル
  ```

  対応Toolがある参照先はFoundation ID（`obsidian:…` / `github:…`）で書くとLLMが辿れること、それ以外はURLを貼ればリンクとして提示されることを書く。
- Troubleshooting: 親ページ未共有・ID誤りは `ConfigurationError`、非対応Blockの注記の意味

---

## 18. Integration Verification

### 18.1 Integration Test（`tests/integration/notion-area.integration.test.ts`、手動起動・Read-only）

`AI_FOUNDATION_INTEGRATION=1`、`NOTION_API_TOKEN`、`config.local.yaml` の `parent_page_id` がある場合のみ実行。書き込みはしない。**前提**: `Areas` 親ページの直下に子ページを最低1件、手動で用意しておく（README §Areas）。親ページID・Area IDはTestに書かず、`config.local.yaml` と `area_list` の結果から得る。

- `area_list` が1件以上を返し、各idで `area_get` が成功する
- `area_list` の `title` と `area_get` の `area.title`（Page Propertyから取得）が一致する。実レスポンスのtitle Propertyの形（§10.2）を確認する
- `external_ref`（`https://www.notion.so/<32hex>`）がArea pageを指す形式である。手動でブラウザから開けることも確認する（Q2）
- Collection data source内のPage idで `area_get` → `NotFoundError`
- 存在しないUUIDで `area_get` → `NotFoundError`

### 18.2 手動Verification（記録のみ）

- 列の中・トグルの中・孫の子ページが一覧に出ず、`area_get` もNotFoundになる
- ゴミ箱へ移したAreaが一覧から消え、`area_get` がNotFoundになる。Notionの「アーカイブ」の挙動（Q7。実装前に §14 手順0 で確認済みの内容を、実装後に再確認する）
- 目次にネストした箇条書き・リンク・mention・子ページ・非対応Block（画像等）を置き、`content` を目視確認

---

## 19. LLM Client Verification

Claude Codeから以下を依頼し、Tool選択と出力を記録する。

- 「食事管理のAreaを見せて」→ `area_list({ query })` → `area_get`
- 「食事管理の目次にあるKnowledgeを読んで」→ `area_get` → `knowledge_get`（`obsidian:` ID）
- 「AI Foundationのプロジェクトを見せて」で `area_list` ではなく `project_list` が選ばれる（Project / Areaの区別）

---

## 20. Acceptance Criteriaとの対応

| AC（Issue #13 / v0.2） | 対応 |
|---|---|
| Areaを一時的なProjectと区別して一覧・詳細取得できる | 別Tool `area_*` / `type: 'area'` / Tool descriptionでの区別（§6）、LLM Verification（§19） |
| 目次ドキュメントの参照先（URLまたはProvider固有参照ID）を取得できる | `id`（`notion:<page-id>`）と `external_ref`（URL）（§10） |
| 目次に記したNotionサブページ・Knowledge等の参照先を既存ツールで追跡できる（未対応先はリンク提示） | `content` のリンク / Foundation ID（§11.2）、Tool description（§6）、READMEテンプレート（§17） |
| `project_list` / `project_get` の後方互換 | `project.ts` / `tools/project.ts` 無変更、既存Test無変更で通過（§16.5） |
| 既存Provider・Credential・Error Handlingを再利用、独自DBなし | `NOTION_API_TOKEN` / `lazyNotionClient` 共有 / `toFoundationError` / `errors.ts` 無変更（§12、§13） |
| README等にAreaの登録方法と目次テンプレート | §17 |
| 親ページ直下の子ページのみArea。Collection DBや通常Blockは除外 | §9.1、§16.4 |
| 部分一致検索・安定ソート・ページネーション | §9.4、§16.4 |
| `area_get` がタイトル/URLとリンクを含む目次を返す | §10、§11 |
| 親ページ外のID、壊れたID、アーカイブ済みAreaの扱い | §9.2、§12、§16.4、Q7 |
| 親ページ未設定・未共有・CredentialError・429/5xx・途中ページ失敗 | §12、§16.4 |
| `project_*`、`collection_*` の回帰 | §16.5 |
| 通常TestはFake/Mockのみ、実APIはRead-onlyで検証 | §16.1、§18 |

---

## 21. 懸念点 / 未確定事項

PR #17 のPlan ReviewでQ1〜Q10はすべて **提案どおり採用**（rev.2）。Q7は実装前に実APIで確認する条件付き。

### Q1. `sources.area` をOptionalにする（採用）

- 提案: `sources.area` ブロック自体をOptionalにする。既存の `config.local.yaml`（`sources.area` なし）でもServerが起動し、Area Toolだけが `ConfigurationError` を返す。
- 代替: 他の `sources.*` と同様に必須にする（`config.yaml` には追加するが、各自の `config.local.yaml` へ追記しないと起動時にConfigErrorになる）。

### Q2. `external_ref` を `https://www.notion.so/<32hex>` で組み立てる（採用）

- 背景: 一覧では子ページ本体を取得しない（v0.2）ため、`page.url`（現在は `https://app.notion.com/p/<slug>-<id>` 形式）を得られない。
- 提案: `list` / `get` とも `notionPageUrl(id)` で組み立て、同じAreaの `external_ref` を一致させる。Notionはこの形式を正規URLへRedirectする（Integrationで確認）。
- 代替: `get` だけ `page.url` を返す（同一Areaで2つのTool結果の `external_ref` が異なる）。

### Q3. 空タイトルを `"Untitled"` にする（採用）

- 提案: Notionの表示に合わせて `"Untitled"` を返す（Domainの `title.min(1)` を満たし、一覧から黙って消えない）。
- 代替: 空タイトルのAreaを一覧から除外して警告を出す（Collectionの不正Typeと同じ扱い。ただし `get` との境界がずれる）。

### Q4. 本文ネストの深さ上限3と、対応Blockの範囲（採用）

- 提案: §11.2の表のとおり。`table` は目次に使われ得るが、行の取得と表の整形が必要なためMVPでは非対応（注記のみ）とする。深さ3は「見出し配下の箇条書き → 子項目 → 孫項目」程度を想定。
- 代替: トップレベルのみ（Request数最小、ネストはすべて注記）/ 深さ無制限（Request数がBlock数に比例）。

### Q5. Notionの Markdown API（`pages.retrieveMarkdown`）を使わない（採用）

- 事実: SDK 5.27 / API `2026-03-11` に `GET /v1/pages/{id}/markdown` があり、ネストを含む本文をNotion形式のMarkdownで1回で返す（`truncated` / `unknown_block_ids` 付き）。
- 提案: v0.2の確定事項（`blocks.children.list` をWrapperへ追加して変換）に従う。出力形式・省略の注記・巡回しない範囲をAI Foundation側で決めてTestで固定できるため。
- 代替: Markdown APIで本文を取得する（実装量は大きく減るが、Notion独自タグを含む出力形式とTruncateの挙動がNotion側の仕様に依存する。採用する場合はv0.2の変更になる）。

### Q6. MVP仕様・Instructionsへの反映（採用）

- `src/instructions.ts` はMVP §15の文面で、Areaの記載がない。LLMがAreaの存在とSoTを知るため、以下を追記したい。仕様文面の変更になるため確認したい。

  ```text
  Area:
  Ongoing areas of responsibility (e.g. meals, assets, exercise), each a table of contents linking to related information.
  Source of Truth: Notion.
  ```

- 合わせて、過去Phaseと同様にIssue #13 v0.2を `docs/specs/areas.md` として残し、`mvp-v0.1.md` の将来設計（「Project Status / Area」の記述）からリンクするか。
- 決定（rev.2）: `instructions.ts` へ上記を追記し、`docs/specs/areas.md` を追加する。`mvp-v0.1.md` は破壊的に書き換えない（リンク追加などの非破壊的な変更に留める）。

### Q7. Notionの「アーカイブ」（`is_archived`）（採用・実装前に実API確認）

- 事実: API `2026-03-11` のPageは `in_trash` と `is_archived` を別に持つ。`child_page` Blockは `in_trash` のみで、一覧ではPage本体を取得しないため `is_archived` を見られない。
- 提案: 両Toolとも `in_trash` だけで除外し、境界を一致させる。`is_archived` のPageが一覧に出るかはIntegrationで確認し、出る場合は結果をPlanに記録して別途判断する。
- 代替: `get` で `is_archived` も `NotFoundError` にする（一覧に出るのに取得できない不整合が起こり得る）。
- 決定（rev.2）: 提案どおり両Toolとも `in_trash` のみで除外し、`get` だけ `is_archived` を除外することはしない。**実装前に** 実Notion APIで挙動を確認し（§14 手順0）、`list` と `get` の判定がずれる場合は実装に入る前に報告する。
- User判断（rev.2）: 現在はNotion Freeプランだが、将来Businessプラン等で「アーカイブ」を使う可能性も考慮し、`is_archived` は判定せず `in_trash` のみで除外する。
- 実装前確認の結果（2026-10-24、API `2026-03-11`、Read-only）:

  | 確認 | 結果 |
  |---|---|
  | `Areas` 直下の子ページをゴミ箱へ移動 → 親の `blocks.children.list` | 返らない（APIの時点で一覧から除外される） |
  | 同じページを `pages.retrieve` | **取得は成功**し、`in_trash: true`、`is_archived: false`、`parent: { type: 'page_id', page_id: <Areas> }`（ゴミ箱でも親は `Areas` のまま） |
  | title Property | 名前は `title` |
  | 非推奨 `archived` | レスポンスに含まれない |

  → 親の一致だけではゴミ箱のPageを `get` できてしまうため、§9.2 の `!page.in_trash` 判定は必須。一覧（APIで除外 + `in_trash` 判定）と取得（`in_trash` → `NotFoundError`）の境界は一致し、齟齬はない。アーカイブはFreeプランでは確認していない（Businessプラン利用時に §18.2 で再確認する）。

### Q8. `restricted_resource`（403）のMessage（採用）

- 現状のMessageは「read, update and insert content」を要求する（Collection向け）。Areaは読み取りだけだが、同じIntegrationを共有するため、Messageはそのまま使う提案。Area専用の文言にする場合は `toFoundationError` に引数を追加する。

### Q9. 親ページを毎回確認する（Request 1回追加）（採用）

- 提案: `list` / `get` で毎回 `pages.retrieve(parent)` する。親ページがゴミ箱・未共有のときに `ConfigurationError` で原因を示し、`get` だけ成功する不整合を防ぐ。
- 代替: Collectionの `schemaCheck` のようにProcessごとに1回だけ確認する（親ページの状態変化に追従しない）。

### Q10. Partial block（`isFullBlock` でない要素）をErrorにする（採用）

- 提案: `blocks.children.list` が種別を持たないBlockを返した場合 `ProviderApiError`。それがAreaかどうか判定できず、黙って捨てると一覧から欠落するため。通常は発生しない想定。
- 代替: 警告を出して無視する。

### その他

- `sources.area` と既存の `defaults.area`（work / personal）でKey名 `area` が重なる。v0.2の設定例どおりとし、Config / READMEのコメントで区別を明記する。
- Google Drive Provider、Areaの作成・更新・削除、Area固有DBはIssueの対象外。
- 子ページをArea扱いしないことで、Area配下に「食事記録」等のNotion子ページを置いた場合、`content` にはリンクとして出るが中身はAI Foundationから読めない（対応Toolがない）。Issue AC「未対応先はリンク提示に留める」どおり。

---

## 22. Review対応履歴

### rev.2（PR #17 レビュー反映）

判定: 設計方針承認。Q1〜Q10はすべて提案どおり採用（§21）。

| 指摘 | 対応 |
|---|---|
| Q4: MVPの取得範囲をREADMEにも明記 | §17 に取得範囲（対応Block・深さ3・非対応と省略の注記）を追加 |
| Q6: `instructions.ts` へArea追記、`docs/specs/areas.md` 追加、MVP仕様を破壊的に書き換えない | §3、§4.1、§4.3、§14、Q6に反映 |
| Q7: `in_trash` のみで除外、実APIで確認し齟齬は実装前に報告 | §9.3、§14 手順0（実装前のRead-only確認）、§16.4、§18.2、Q7に反映 |
| 1. `list` 集合 = `get` 可能集合は原子的に保証できない | §9.3 を「同じ静的なNotion状態で一致する設計」と書き直し、Fake testで固定する旨を明記 |
| 2. 子を持つ非対応Blockの注記で内容未取得を示す | §11.4 に `…; its nested blocks were not retrieved` の注記を追加。深さ上限の注記も「not retrieved」に統一。§16.4 にTestを追加 |
| 3. 実APIテストの前提（子ページ最低1件）とIDをCommitしないことをREADMEに明記 | §17（README）、§18.1 に反映 |
| 4. title Property名が任意になり得ることを踏まえて実装・テスト | §10.2 でProperty名ではなく `type === 'title'` で探すと明記。§16.4 のTest、§18.1 の実レスポンス確認を追加 |

---

## 23. 実装・Integration Verificationで確定した事項

実装Branch: `feat/areas`（Base: `main` の `6caa089`、PR #17 Merge後）。

### 23.1 Verification結果（2026-10-24）

| 項目 | 結果 |
|---|---|
| `npm run typecheck` | 成功 |
| `npm test` | 成功（45 files / 1065 passed / 4 skipped。既存の `project_*` / `collection_*` のTestは無変更で成功） |
| `npm run build` | 成功 |
| Integration（`tests/integration/notion-area.integration.test.ts`、Read-only） | 6件成功。`area_list` が1件以上、各idの `area_get` が一覧と同じ `area` を返す、`external_ref` の形式、title Propertyが1つで `parent.type = page_id`、部分一致、Collection PageとUUIDの不存在が `NotFoundError` |
| 実データの確認 | `Areas` 直下の子ページ1件が一覧・取得できた。本文は空のため `content` は `''` |
| ゴミ箱（実装前確認、Q7） | §21 Q7のとおり |

### 23.2 手動Verification / LLM Client Verification（Implementation Review後に実施、2026-10-24）

#### 手動Verification（§18.2、実Notion API、Read-only）

`Areas` 直下に子ページ2件（うち1件に目次を記述）を用意して確認した。

| 確認 | 結果 |
|---|---|
| 一覧 | 直下の子ページ2件がタイトル順で出る |
| 孫ページ（Areaの中の子ページ） | 一覧に出ず、`area_get` は `NotFoundError`（`parent.type = page_id` だが親が `Areas` ではない） |
| 列（Column）の中の子ページ | `parent.type = block_id` になることを実APIで確認。一覧に出ず、`area_get` は `NotFoundError`。§9.3 の前提どおり（列はArea pageの中に作成して確認した。`Areas` 直下の列でも同じ判定になる） |
| 見出しH1〜H3 | `#`〜`###`、見出しの前に空行 |
| 4階層の箇条書き | 3階層まで出力し、4階層目の位置に `[nested blocks not retrieved: depth limit 3]` |
| Page mention | `[タイトル](https://app.notion.com/p/…)` のリンク |
| `obsidian:…` のテキスト | そのまま出力（後続の `knowledge_get` に使える） |
| 子ページ | `- [タイトル](https://www.notion.so/…)` のリンクのみ。中身は取得しない |
| 列 | 列自体は出力せず、中の子ページのリンクを順に出す |
| 画像 / 表 | `[unsupported Notion block: image]`、`[unsupported Notion block: table; its nested blocks were not retrieved]` |
| トグル | `- toggle` の下に中の箇条書きをindent |

#### LLM Client Verification（§19、Claude Code、MCP Serverを本Branchの `dist` で再接続）

| 依頼 | Tool |
|---|---|
| 食事管理のAreaを見せて | `area_list({ query: "食事" })` → `area_get` |
| 食事管理の目次にあるKnowledgeを読んで | `area_get` の `content` にある `obsidian:…` を `knowledge_get` に渡して本文を取得（Tool descriptionの案内どおり） |
| AI Foundationのプロジェクトを見せて | `area_list` ではなく `project_list({ query: "foundation" })`（Project / Areaの区別） |

### 23.3 Plan外の変更・Planからの細部の変更（Implementation Reviewで確認してほしい点）

| 箇所 | 内容 |
|---|---|
| `notion/id.ts` | `parseNotionPageId(id, from)` は `from`（有効なIDを返すTool名）だけを引数にした（Planの `{ kind, from }` から簡略化）。`compactNotionId` を追加。`mapping.ts` は `sameNotionId` をre-exportし、`COLLECTION_ID_PREFIX` を残して既存importを維持 |
| `area-content.ts` | 空の段落は出力しない。本文中の `in_trash` のBlockは出力しない。`link_preview` はcaptionがないのでURLをそのまま表示。複数行テキストの2行目以降はリストのテキスト位置にindent（コードは自身のindentを維持） |
| 親ページのError Message | 「not found, is in the trash or is not shared」として、ゴミ箱も含めた |
| `tests/connectors/notion/fake-client.ts` | `seedPlainPage`（通常ページ。親がページなら `child_page` Blockも追加し、ゴミ箱のページは親のBlockに出さない）、`appendBlocks`（Block tree）、`childBlocks` と `blocks.children.list`（固定page sizeのPagination）を追加 |
| `README.md` | Source of Truth表にArea（Notion）の行を追加 |
| `config.local.yaml`（Git管理外） | 末尾のコメントだった `parent_page_id` を `sources.area.notion.parent_page_id` として設定（Integration Test用） |

### 23.4 Implementation Review（PR #18、Codex）

| 指摘 | 対応 |
|---|---|
| [P2] `tests/config/schema.test.ts` の `PARENT_ID`（ハイフン付き・URL形式を含む）が実際の `Areas` 親ページIDと一致する（§17「実際のページIDをTest・ドキュメントに書かずCommitしない」に反する） | 架空のfixture IDへ置き換えた。同様に実ページ（Q7確認用のゴミ箱ページ）のIDを使っていた `tests/connectors/notion/area-content.test.ts` / `id.test.ts`、`tests/domain/area-resource.test.ts`、`tests/tools/area.test.ts` も架空のIDへ統一した。`config.local.yaml` の他の個人用の値（Data Source ID・Calendar ID・Vault Path）がTrack対象に含まれないことも確認した |
