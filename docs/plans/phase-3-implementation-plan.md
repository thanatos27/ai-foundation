# Phase 3: Collection — Implementation Plan

- Status: **rev.2（Plan Review完了・User承認済み）**
- 作成: Coding Agent (Claude Code) / 2026-10-15（rev.2: PR #4 レビュー反映。同日 再レビュー完了・User承認）
- 対象: [Phase 3 Design Issue](../specs/phase-3-collection.md)
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Phase 1 Design Issue](../specs/phase-1-foundation.md), [Phase 2 Design Issue](../specs/phase-2-task-schedule.md), [Phase 2 Implementation Plan](phase-2-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

ChatGPTによるPlan Reviewは完了（追加のBlocking Issueなし）し、User承認済み。実装は `main` から作成する `feat/phase-3-collection` で行う。仕様の解釈が必要な箇所・仕様に明記がない箇所は [§17 懸念点 / 未確定事項](#17-懸念点--未確定事項) にQとしてまとめている（rev.2時点でQ1〜Q11はすべて判断済み）。レビュー指摘への対応は [§20 Review対応履歴](#20-review対応履歴) を参照。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/phase-3-implementation-plan`（PR #4）。Baseは `main` の `0fdcf5f docs: align Collection status nullability`（Phase 2実装 PR #3 のMerge `06fb59c` 後に、Phase 3 Design Issue追加 `7fdec15`、MVP仕様のPhase 3整合 `d98946d`、`fae1b84`、PR #4 rev.1 レビューを受けたCollection `status` のnullable化 `b4ffe5e` / `0fdcf5f` がコミット済み） |
| Repository | `thanatos27/ai-foundation`（**Public**） |
| ローカル環境 | Node.js v24.20.0, npm 11.19.0。`package.json#engines` は `{ node: ">=24", npm: ">=11" }` |
| 依存 | `@modelcontextprotocol/server ^2.3.1`, `zod ^4.6.7`, `yaml ^2.9.1`, `@doist/todoist-sdk ^15.3.1`, `@googleapis/calendar ^20.1.0`, `google-auth-library ^11.3.0` |
| 公開Tool | 6件（`task_create` / `task_list` / `task_update` / `task_complete` / `schedule_create` / `schedule_list`） |

### Phase 2までの実装の要点（Phase 3で利用・変更するもの）

| File | 現状 |
|---|---|
| `src/domain/collection.ts` | `CollectionTypeSchema`（`game` / `book` / `movie` / `other`）と `CollectionItemSchema` のみ。**`status` は `z.string().min(1)` で必須**（nullを許さない）。`metadata` は `z.record(z.string(), z.unknown()).optional()`。Input Schemaはない |
| `src/domain/task.ts` | `TaskUpdateInputSchema` は `TASK_UPDATE_FIELDS.some(field => input[field] !== undefined)` で「id以外の更新項目なし」を拒否。Phase 3も同じ書き方に揃える |
| `src/errors.ts` | `FoundationError`（`code` 付き）と5分類（`InputValidationError` / `CredentialError` / `NotFoundError` / `ProviderApiError` / `ConfigurationError`）。**変更不要** |
| `src/credentials/types.ts`, `env.ts` | `CredentialProvider { getTodoistApiToken, getGoogleOAuthCredentials }`。`EnvCredentialProvider.require()` が未設定変数名のみを含む `CredentialError` を投げる |
| `src/connectors/types.ts` | `TaskConnector`, `ScheduleConnector`, `Connectors { task?, schedule? }` |
| `src/connectors/index.ts` | `createConnectors(config, credentials)` がTodoist / Google Calendar Connectorを生成。API Clientは `lazy*` で初回呼び出し時に生成 |
| `src/connectors/todoist/client.ts` | SDKの一部メソッドを `Pick` した `TodoistClient`、`lazyTodoistClient`、`toFoundationError(error, notFound?)` |
| `src/tools/index.ts`, `task.ts`, `schedule.ts`, `result.ts` | `register<Entity>Tools(server, context)`、Connector未設定時は `ConfigurationError`、`jsonResult()` で `structuredContent` + JSON `content` を返す |
| `src/config/schema.ts` | `sources.collection` は `z.strictObject({ provider: z.enum(['notion']) })` のみ |
| `src/index.ts` | `.env` 読込 → Config読込 → `createConnectors(config, new EnvCredentialProvider(process.env))` |
| `tests/helpers/fake-connectors.ts` | `FakeTaskConnector`, `FakeScheduleConnector` |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 6件を前提とするAssertion。e2eは `CREDENTIAL_VARS` を子プロセスのenvから除去 |
| `tests/integration/setup.ts`, `vitest.integration.config.ts` | `AI_FOUNDATION_INTEGRATION=1` でのみ実行。`config.local.yaml` を優先して読む |
| `.env.example` | `# NOTION_API_TOKEN=` がコメントアウトで予約済み |

---

## 2. 設計方針

1. **Phase 2の構造をそのまま使う。** Tool → `ToolContext.connectors.collection` → `NotionCollectionConnector` → `NotionClient`（SDKの薄いInterface）。Notion固有処理（Property形式、Rich Text分割、Select option、Block、Error変換）はConnector内に閉じ込める。
2. **Provider非依存のルールはDomainに置く。** Input Schema（必須・Optional・null許容・「更新項目なし」の拒否）、Metadataのshallow merge（純粋関数）はDomain。Notion固有の制約（Select名のカンマ禁止、Rich Text長、Page ID形式）はConnectorで検証する。
3. **書き込み・検索対象は `data_source_id` に固定する。** Tool Inputに Database / Data Source を指定するFieldは存在せず（strict）、`collection_update` でも対象Pageの親がConfigの `data_source_id` であることを確認する（§6.6）。
4. **起動時に外部APIへ接続しない。** Token取得、SDK Client生成、Data Source Schema検証はTool呼び出し時に遅延実行する（Phase 2方針）。
5. **黙ってデータを失わない。** Metadata JSON / Note の長さ制限は分割で吸収し、収まらない場合はErrorにする（truncateしない）。読めないMetadataを空Objectで上書きしない（§8.3）。
6. **独自Framework・抽象化を増やさない。** Retry Framework、Cache層、汎用Mapper、Markdown→Block変換は作らない。

---

## 3. Phase 2までの実装への変更点（概要）

| 対象 | 変更 | 理由 |
|---|---|---|
| `domain/collection.ts` | `CollectionItemSchema.status` を `nullable` に変更。`CollectionCreateInputSchema` / `CollectionSearchFilterSchema` / `CollectionUpdateInputSchema` / `mergeMetadata` を追加 | Phase 3 Design Issue / MVP §5.5 の CollectionItem `status: string \| null`（`0fdcf5f` で仕様修正済み。Q1） |
| `connectors/types.ts` | `CollectionConnector { create, search, update }`、`Connectors.collection?` を追加 | Connector境界 |
| `connectors/index.ts` | `NotionCollectionConnector` を生成 | 配線 |
| `credentials/types.ts`, `env.ts` | `getNotionApiToken()` を追加（`NOTION_API_TOKEN`） | Phase 3 §Credential |
| `config/schema.ts`, `config.yaml` | `sources.collection.data_source_id`（optional）を追加。`config.yaml` はコメントで例示のみ | Phase 3 §Configuration |
| `tools/index.ts` | `registerCollectionTools` を呼ぶ | Tool公開 |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 6件 → 9件。e2eの `CREDENTIAL_VARS` に `NOTION_API_TOKEN` を追加 | Tool公開 |
| `tests/domain/collection.test.ts` | `status: null` 許容に合わせて変更、Input Schemaのテスト追加 | Domain変更 |
| `.env.example`, `README.md` | `NOTION_API_TOKEN` の有効化、Notion Setup手順、Tool一覧、Current Phase | 利用手順 |

`src/errors.ts`、`src/instructions.ts`（MVP §15のInstructions）、Task / Schedule関連は変更しない。

---

## 4. 追加・変更予定ファイル

### 4.1 Source

| File | 種別 | 責務 |
|---|---|---|
| `src/domain/collection.ts` | 変更 | §5 |
| `src/credentials/types.ts` | 変更 | `getNotionApiToken(): Promise<string>` を追加 |
| `src/credentials/env.ts` | 変更 | `NOTION_API_TOKEN` を読む実装を追加 |
| `src/connectors/types.ts` | 変更 | `CollectionConnector` 追加 |
| `src/connectors/index.ts` | 変更 | `collection: new NotionCollectionConnector({ client: lazyNotionClient(credentials), dataSourceId })` |
| `src/connectors/notion/client.ts` | 追加 | `NOTION_API_VERSION` 定数、`@notionhq/client` の `Client` 生成（Tokenは `CredentialProvider` から遅延取得）、Connectorが使うメソッドだけを持つ `NotionClient` Interface、`toFoundationError()` |
| `src/connectors/notion/schema.ts` | 追加 | Data Source Property定義（`Name` / `Type` / `Status` / `Tags` / `Metadata` と期待するNotion Type）と、`dataSources.retrieve` 応答の検証（§6.3） |
| `src/connectors/notion/mapping.ts` | 追加 | Page ID ↔ `notion:<id>`、Domain ↔ Notion Property、Rich Textの分割・結合、Metadata JSON、Note → Paragraph Block、Select名の検証（§7, §8, §9） |
| `src/connectors/notion/filter.ts` | 追加 | `collection_search` Filter → Notion Query Filter（純粋関数。§6.5） |
| `src/connectors/notion/connector.ts` | 追加 | `NotionCollectionConnector implements CollectionConnector` |
| `src/tools/collection.ts` | 追加 | `registerCollectionTools`（3 Tool） |
| `src/tools/index.ts` | 変更 | `registerCollectionTools` の呼び出し |
| `src/config/schema.ts` | 変更 | §11 |

### 4.2 Tests

| File | 内容 |
|---|---|
| `tests/domain/collection.test.ts` | 変更（§14.2） |
| `tests/credentials/env.test.ts` | 変更（`NOTION_API_TOKEN`） |
| `tests/config/schema.test.ts` | 変更（`data_source_id`） |
| `tests/connectors/notion/fake-client.ts` | 追加（In-memoryのFake `NotionClient`。Data Source・Page・Blockを保持し、Query Filterを解釈する） |
| `tests/connectors/notion/mapping.test.ts`, `filter.test.ts`, `schema.test.ts`, `client.test.ts`, `connector.test.ts` | 追加 |
| `tests/tools/collection.test.ts` | 追加（InMemoryTransport + Fake Connector） |
| `tests/helpers/fake-connectors.ts` | `FakeCollectionConnector` を追加 |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 変更（9 Tool、`NOTION_API_TOKEN` 除去、Collection Toolの `Credential error` / `Configuration error`） |
| `tests/integration/notion.integration.test.ts` | 追加（実Notion。通常Suite対象外。§15.1） |

### 4.3 Project設定 / Documentation

| File | 変更 |
|---|---|
| `package.json` / `package-lock.json` | `@notionhq/client` を追加（§13） |
| `config.yaml` | `sources.collection.data_source_id` をコメントで例示（値はコミットしない） |
| `.env.example` | `NOTION_API_TOKEN=` を有効化（値は空）。「Phase 3 and later」から外す |
| `README.md` | Current Phase、Tool一覧、Notion Setup手順（§12.3）、Integration Test実行方法 |
| `docs/plans/phase-3-implementation-plan.md` | 本ファイル |

`vitest.config.ts` / `vitest.integration.config.ts` / `tsconfig.json` は既存設定で対象に含まれるため変更不要の見込み。

---

## 5. Domain / Tool Input Schema変更

Tool Input SchemaはDomainのInput Schemaをそのまま使い、`z.strictObject` で未知Key（`data_source_id`, `database_id`, `title`（update時）等）を拒否する（Phase 2 Q10）。

### 5.1 Entity

```ts
export const CollectionItemSchema = z.object({
  ...OptionalMetadataShape,
  type: z.literal('collection'),
  title: z.string().min(1),
  collection_type: CollectionTypeSchema,
  /** Free-form per collection (e.g. `playing`, `read`, `wishlist`). null after it was cleared. */
  status: z.string().min(1).nullable(),          // 変更: nullable（仕様 `string | null`。Q1）
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: TagsSchema.optional(),
});
```

Phase 3のConnectorは常に `id` / `source: "notion"` / `external_ref`（Page URL）/ `metadata`（空なら `{}`）/ `tags`（空なら `[]`）を返す。`metadata` を返せない場合（§8.3）のみ `metadata` を省略する。

### 5.2 Input Schema

```ts
/** Non-blank text. Stored as-is (not trimmed). */
const NoteSchema = z.string().refine((s) => s.trim().length > 0, { message: 'must not be blank' });
const CollectionStatusSchema = z.string().min(1);
const MetadataSchema = z.record(z.string(), z.unknown());

// collection_create
export const CollectionCreateInputSchema = z.strictObject({
  title: z.string().min(1),
  collection_type: CollectionTypeSchema,
  status: CollectionStatusSchema,
  metadata: MetadataSchema.optional(),
  tags: TagsSchema.optional(),
  note: NoteSchema.nullable().optional(),        // null / 未指定 = 本文なし
});

// collection_search（すべてOptional。{} = 全件）
export const CollectionSearchFilterSchema = z.strictObject({
  query: z.string().min(1).optional(),           // Name の部分一致
  collection_type: CollectionTypeSchema.optional(),
  status: CollectionStatusSchema.optional(),     // 完全一致
  tags: TagsSchema.optional(),                   // AND
});

// collection_update
const COLLECTION_UPDATE_FIELDS = ['status', 'metadata', 'tags', 'append_note'] as const;
export const CollectionUpdateInputSchema = z
  .strictObject({
    id: z.string().min(1),
    status: CollectionStatusSchema.nullable().optional(),   // null = クリア
    metadata: MetadataSchema.optional(),                     // shallow merge
    tags: TagsSchema.optional(),                             // 置換。[] = 全削除
    append_note: NoteSchema.nullable().optional(),           // null / 未指定 = 本文を変更しない
  })
  .refine(hasAnyUpdate, {
    message: `At least one of ${COLLECTION_UPDATE_FIELDS.join(', ')} must be specified`,
  });
```

- `hasAnyUpdate` は「`status` / `metadata` / `tags` が `undefined` 以外」または「`append_note` が非null」のとき真。`{ id, append_note: null }` は何も変更しないためValidation Errorとする（Q5）。
- `title` / `collection_type` は `collection_update` のSchemaに含めない（strictのため指定するとValidation Error）。
- `tags` の重複（`["RPG", "RPG"]`）はDomainでは拒否せず、Connectorで順序を保って重複除去する（Notionのmulti_selectは同名optionを2度持てないため）。重複除去後の件数上限（100件）はNotion固有の制約のためConnectorで検証する（§8.5）。
- `id` の形式（`notion:<page-id>`）はProvider固有のためConnectorで検証する（Phase 2のTodoist IDと同じ方針）。

### 5.3 Metadata merge（Domainの純粋関数）

```ts
/** Shallow merge (spec Phase 3 §Metadata Update). A null value is stored as JSON null; keys are never deleted. */
export function mergeMetadata(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...current, ...patch };
}
```

ネストしたObjectは置換される（shallow）。Keyの削除操作は提供しない（Phase 3 Out of Scope）。

---

## 6. Notion Connector設計

### 6.1 利用SDK・API Version

- 公式SDK `@notionhq/client`（v5系。調査時点の最新 `5.27.0`、`engines.node >=18`）を使う。
- **Notion API Versionは `2026-03-11` に固定する**（`NOTION_API_VERSION` 定数を `client.ts` に置き、`new Client({ auth, notionVersion: NOTION_API_VERSION })` で明示指定。Q2）。
  - SDK v5.27.0 がサポートするのは `2025-09-03`（SDK既定値）と `2026-03-11`。どちらもData Source API（`dataSources.query` / `dataSources.retrieve`、Page作成時の `parent: { data_source_id }`）を持つ。
  - `2026-03-11` では Pageの `archived` が `in_trash` に、Block追記の `after` が `position` に置き換わる。本Planが使うのは `in_trash` と `position: { type: 'end' }` のため、新しい方に揃える。
  - SDK既定値に依存しない（SDK更新で既定値が変わっても挙動が変わらない）。

### 6.2 NotionClient Interface

Connectorが依存するのはSDKの以下のメソッドだけとし、テストではFakeを注入する（Phase 2の `TodoistClient = Pick<TodoistApi, ...>` と同じ方針）。

```ts
export interface NotionClient {
  dataSources: Pick<Client['dataSources'], 'retrieve' | 'query'>;
  pages: Pick<Client['pages'], 'create' | 'retrieve' | 'update'>;
  blocks: { children: Pick<Client['blocks']['children'], 'append'> };
}
```

| 操作 | SDKメソッド（Endpoint） |
|---|---|
| Data Source Schema取得 | `dataSources.retrieve({ data_source_id })`（`GET /v1/data_sources/{id}`） |
| 検索 | `dataSources.query({ data_source_id, filter, page_size: 100, start_cursor, result_type: 'page' })`（`POST /v1/data_sources/{id}/query`） |
| 作成 | `pages.create({ parent: { type: 'data_source_id', data_source_id }, properties, children? })` |
| 取得 | `pages.retrieve({ page_id })` |
| Property更新 | `pages.update({ page_id, properties })` |
| Note追記 | `blocks.children.append({ block_id: pageId, children: [paragraph], position: { type: 'end' } })` |

`lazyNotionClient(credentials, factory?)` は Phase 2の `lazyTodoistClient` と同形（初回呼び出しで `getNotionApiToken()` → `new Client(...)`、失敗時はMemoizeを捨てて次回再試行）。

SDKのLogger: SDK既定のLoggerは `console.warn` 等へ出力する。MCPのstdoutを汚さないよう、`logger` オプションで **stderrへのみ出力するLogger** を渡し、`logLevel` は `WARN` を明示する（Request Bodyやヘッダを出さないLevel）。

### 6.3 Data Source / Property検証（`schema.ts`）

期待するProperty定義（名前は大文字小文字を区別、仕様の表のとおり固定）:

| Property | 期待するNotion Type |
|---|---|
| `Name` | `title` |
| `Type` | `select` |
| `Status` | `select` |
| `Tags` | `multi_select` |
| `Metadata` | `rich_text` |

- 各Tool呼び出しの最初に、Connectorは `ensureDataSource()` を呼ぶ。初回のみ `dataSources.retrieve` を実行し、上記5 Propertyの**存在と型**を検証する。成功結果はプロセス内でMemoizeし、失敗時はMemoizeしない（Notion側を直して再試行できるようにする。Phase 2の `inboxProjectId` と同じ）。
- 不足・型不一致は**すべてまとめて** `ConfigurationError` にする。例: `Configuration error: Notion data source <id> does not match the Collection schema: missing property "Metadata" (rich_text); property "Status" is status, expected select`。
- 追加のProperty（ユーザーが独自に作った列）は無視する（許容）。
- `Type` のselect optionに `game` / `book` / `movie` / `other` が揃っているかは検証しない（書き込み時に自動作成されるため。§9）。
- 検証のタイミング:
  - 起動時には行わない（方針4）。
  - プロセス起動後にユーザーがNotion側でPropertyを削除・型変更した場合、Memoize済みのため次の書き込みはNotionの `validation_error`（400）になり `ProviderApiError` として返る。再起動で再検証される。個人利用のため許容する（Q7）。
- `data_source_id` 未設定は `ensureDataSource()` の時点で `ConfigurationError`（`sources.collection.data_source_id is not set`）。Token取得より前に判定する（設定不備を先に知らせる）。

### 6.4 collection_create

1. `ensureDataSource()`。
2. 入力を検証・変換（Select名の検証 §9.2、Metadata JSONの分割 §8.1、Noteの分割 §10、Tags件数・Request body size §8.5）。いずれかが制限を超えたら `InputValidationError`（Notionへは何も送らない）。Request body sizeは title + metadata + note + tags を含む**送信予定の `pages.create` body全体**で検証する。
3. `pages.create`:
   ```ts
   {
     parent: { type: 'data_source_id', data_source_id },
     properties: {
       Name:     { title: richText(title) },
       Type:     { select: { name: collection_type } },
       Status:   { select: { name: status } },
       Tags:     { multi_select: dedupe(tags ?? []).map((name) => ({ name })) },
       Metadata: { rich_text: metadata ? richText(JSON.stringify(metadata)) : [] },
     },
     ...(note != null ? { children: [paragraph(note)] } : {}),
   }
   ```
   Noteは `children` として同じRequestで送るため、Page作成とNote保存はAtomic（片方だけ成功する状態にならない）。
4. 応答のPageをDomainへ変換して返す（§7）。

### 6.5 collection_search

1. `ensureDataSource()`。
2. Filterを `filter.ts` でNotion Query Filterへ変換（すべて `and` で結合。指定なしのFilterは条件に含めない）:

   | Domain Filter | Notion Filter |
   |---|---|
   | `query` | `{ property: 'Name', title: { contains: query } }` |
   | `collection_type` | `{ property: 'Type', select: { equals: collection_type } }` |
   | `status` | `{ property: 'Status', select: { equals: status } }` |
   | `tags`（各Tag） | `{ property: 'Tags', multi_select: { contains: tag } }` を Tagごとに1条件（AND） |
   | 空Filter `{}` | `filter` を送らない（全件） |

   Notionの複合Filterはネスト2段・条件数に上限（1段あたり100程度）があるが、本Toolは1段の `and` のみで、条件数は `3 + tags数`。`tags` が上限を超える指定はDomainでは制限せず、Notionの `validation_error` を `ProviderApiError` として返す（実用上問題にならない）。
3. `start_cursor` / `has_more` / `next_cursor` で**全ページを取得**する（`page_size: 100`）。件数上限は設けない（Q6）。
4. 結果から `object === 'page'` かつ `isFullPage` のものだけを対象にする（`result_type: 'page'` も指定）。`in_trash` のPageは返らないが、念のため除外する。
5. Page本文は取得しない（Property値のみからDomainへ変換。仕様どおり）。
6. ソート順は指定しない場合Notionの既定順になるため、**`last_edited_time` 降順**を明示する（直近に触ったItemが先頭に来る方がLLMの候補選択に向く。Q6）。

`query` の部分一致の大文字小文字の扱い（Notionの `contains` は大文字小文字を区別しない想定）はIntegration Testで確認し、Tool Descriptionへ反映する。

### 6.6 collection_update

```text
pageId = parseCollectionId(input.id)              // notion:<id> 以外 → InputValidationError
ensureDataSource()
page   = pages.retrieve(pageId)                   // 404 → NotFoundError
if page.in_trash                                   → NotFoundError
if page.parent.type !== 'data_source_id'
   or normalizeId(page.parent.data_source_id) !== normalizeId(config.data_source_id)
                                                   → NotFoundError（"not in the AI Foundation Collection"）
current = toCollectionItem(page)                   // 変換できない場合 → §7.3

properties = {}
if status !== undefined:   properties.Status   = { select: status === null ? null : { name: status } }
if tags   !== undefined:   properties.Tags     = { multi_select: dedupe(tags).map(name => ({ name })) }
if metadata !== undefined: currentMeta = readMetadata(page)   // 壊れていれば Error（§8.3）。上書きしない
                           properties.Metadata = { rich_text: richText(JSON.stringify(mergeMetadata(currentMeta, metadata))) }
updateBody = properties が空でなければ { properties }
appendBody = append_note != null なら { children: [paragraph(append_note)], position: { type: 'end' } }
入力の制限チェック（Select名・Tags件数・Metadata長・Note長、updateBody / appendBody それぞれのRequest body size。§8.5）を
**両Requestとも送信前に**完了し、どちらかが超過なら InputValidationError（何も書き込まない）

updated = properties が空でなければ pages.update({ page_id, properties }) else page
if append_note != null:
   blocks.children.append({ block_id: pageId, children: [paragraph(append_note)], position: { type: 'end' } })
   失敗時: properties を更新済みなら ProviderApiError("properties were updated, but the note could not be appended: ...")

return toCollectionItem(updated)
```

- **対象Pageの親Data Sourceを必ず確認する。** Internal Connectionが他のPage / Databaseにも共有されている場合でも、`collection_update` で専用Collection外のPageを書き換えられないようにする（AC「Tool Inputから任意のDatabase / Data Sourceを指定できない」の担保）。専用Collection外のPageは存在を明かさず `NotFoundError` とする。
- `title` / `collection_type` は送らない（Schemaにも存在しない）。
- Property更新とNote追記は別Requestのため非Atomic。順序は「Property → Note」とし、Note追記失敗時は「Propertyは更新済み」であることをMessageに含める（再実行時に `append_note` だけを再送できるようにする）。Note追記は再送すると重複するため、Property更新失敗時はNote追記を行わない。
- GET → PATCH の間に他所でMetadataが変更された場合は後勝ち（Phase 2 Q6と同様、個人利用のため許容）。
- 返却値は `pages.update` の応答（Note追記のみの場合は `pages.retrieve` の結果）。Note本文は返さない。

### 6.7 ID

- 出力: `notion:<page.id>`（Notion APIが返すハイフン付きUUID形式をそのまま使う）。
- 入力: `notion:` Prefixの後ろが UUID（ハイフン付き）または32桁Hex（ハイフンなし。NotionのURL末尾の形式）であれば受け付け、それ以外は `InputValidationError`。APIへはそのまま渡す（Notion APIは両形式を受け付ける）。
- `external_ref`: Page Objectの `url`（`https://www.notion.so/...`）。

---

## 7. Data Source / Property Mapping

### 7.1 Domain → Notion（書き込み）

| Domain | Notion Property | 値 |
|---|---|---|
| `title` | `Name`（title） | `richText(title)`（§8.1の分割を適用） |
| `collection_type` | `Type`（select） | `{ name: collection_type }` |
| `status` | `Status`（select） | `{ name: status }` / `null`（クリア） |
| `tags` | `Tags`（multi_select） | `[{ name }, ...]`（重複除去）/ `[]`（全削除） |
| `metadata` | `Metadata`（rich_text） | `JSON.stringify(metadata)` を分割した `rich_text` |
| `note` / `append_note` | Page本文 | Paragraph Block（§10） |

### 7.2 Notion → Domain（読み取り）

| Notion | Domain | 規則 |
|---|---|---|
| `page.id` | `id` | `notion:<page.id>` |
| — | `source` | `"notion"` |
| `page.url` | `external_ref` | そのまま |
| `Name.title[].plain_text` | `title` | 連結。空なら `"(Untitled)"`（Phase 2のCalendar `(No title)` と同じ扱い） |
| `Type.select.name` | `collection_type` | 4種のいずれか。それ以外 / 空は §7.3 |
| `Status.select?.name` | `status` | 未設定は `null` |
| `Tags.multi_select[].name` | `tags` | そのまま（未設定は `[]`） |
| `Metadata.rich_text[].plain_text` | `metadata` | 連結してJSON.parse（§8.2） |

### 7.3 Notion側で手作業作成されたItemの扱い

専用DatabaseはユーザーがNotion UIから直接編集する前提のため、Domain Schemaに合わないPageが存在し得る。

| 状況 | `collection_search` | `collection_update` |
|---|---|---|
| `Type` が空、または4種以外 | 結果から**除外**し、除外件数をstderrへログ（Q4） | `ProviderApiError`（"page has no valid Type (game/book/movie/other); set it in Notion"）。**書き込み前に判定**し、何も変更しない |
| `Name` が空 | `"(Untitled)"` として返す | 同左 |
| `Metadata` が空 | `metadata: {}` | 現在値 `{}` としてmerge |
| `Metadata` がJSON Objectとして読めない | `metadata` を省略して返す（Q3） | `metadata` 指定時は書き込み前にError（§8.3）。`metadata` 未指定なら他の更新は実行する |

---

## 8. Metadata JSONの保存・shallow merge設計

### 8.1 保存（Domain → Notion）

- `JSON.stringify(metadata)`（インデントなしのコンパクト形式）を `Metadata` Propertyのrich_textへ保存する。
- Notion API制限: **rich_textの1 text objectの `content` は最大2,000文字、1 Property値のrich_text配列は最大100要素**。JSON文字列を2,000文字ごとの text object に分割して保存し、最大 `2,000 × 100 = 200,000` 文字まで扱う。
  - 分割はUTF-16のSurrogate Pairを割らない位置で行う（絵文字等の破損防止）。
  - 200,000文字を超える場合は `InputValidationError`（"metadata JSON is N characters; Notion allows at most 200000"）。**truncateしない。**
  - 200,000文字以内でも、Request全体のUTF-8 byte数が500KBを超える場合は別途 `InputValidationError` になる（§8.5）。
- 同じ分割関数 `richText(text)` を `Name`（title）とNote（paragraph）にも使う。
- Notion側の文字数カウント方式とUTF-16長の差異はIntegration Testで多バイト文字（日本語・絵文字）を含む長文で確認する。

### 8.2 読み取り（Notion → Domain）

- `rich_text[].plain_text` を連結 → 空文字なら `{}`。
- `JSON.parse` の結果がPlain Object（配列・null・プリミティブでない）なら `metadata` として返す。それ以外は「読めないMetadata」（§8.3）。

### 8.3 読めないMetadataの扱い（Q3）

ユーザーがNotion UIで `Metadata` を直接編集してJSONを壊した場合:

- **読み取り（search / create・updateの戻り値）**: Item全体を失敗させず、`metadata` Fieldを省略して返す。Tool Descriptionに「metadataが返らないItemはNotion上のMetadataがJSONとして不正」と記載する。
- **`collection_update` で `metadata` を指定した場合**: 既存値を `{}` とみなしてmergeすると、ユーザーがNotion上に書いた内容を黙って消すことになるため、**書き込み前に `ProviderApiError`**（"Metadata of notion:<id> is not a JSON object; fix it in Notion before updating metadata"）とし、何も変更しない。
- `metadata` を指定しない `collection_update`（status / tags / append_noteのみ）は、Metadata Propertyに触れないため実行する。

### 8.4 shallow merge

`mergeMetadata(current, patch)`（§5.3）をDomainで定義し、Connectorは「現在値の読み取り → merge → 全体を書き戻し」を行う。

| 既存 | 入力 `metadata` | 結果 |
|---|---|---|
| `{"platform":"Xbox","rating":null}` | `{"rating":5}` | `{"platform":"Xbox","rating":5}` |
| `{"rating":5}` | `{"rating":null}` | `{"rating":null}`（Keyは残りnullを保存） |
| `{"a":{"x":1}}` | `{"a":{"y":2}}` | `{"a":{"y":2}}`（ネストは置換） |
| `{}`（空Property） | `{"platform":"Switch"}` | `{"platform":"Switch"}` |
| 任意 | `{}` | 既存のまま（書き戻しは行う） |

### 8.5 Notion Request制限の事前検証（Metadata / Tags / Note共通）

Notion APIのRequest Limitsに収まらない入力は、Providerの400に任せず**送信前に** `InputValidationError` とする（「truncateしない」方針のため、どの制限で失敗したかを利用者が判断できるMessageにする）。検証は `mapping.ts` の純粋関数として実装し、Connectorは送信予定のRequest bodyを組み立てた後・送信前に呼ぶ。

| 制限 | 対象 | 検証 | Message例 |
|---|---|---|---|
| rich_text 1 text objectの `content` 2,000文字 × 配列100要素 | `Name` / `Metadata` / Note Paragraph | 2,000文字単位に分割（§8.1）し、100要素を超えたらError | `metadata JSON is 210000 characters; Notion allows at most 200000` |
| multi_select 1回の値は最大100 options | `Tags`（create / update） | **重複除去後**の件数が100以下 | `tags has 101 distinct values; Notion allows at most 100` |
| Request body全体 500KB | `pages.create` / `pages.update` / `blocks.children.append` | 送信予定body（Path Parameterを除く。SDKが送るJSONと同じ内容）を `JSON.stringify` し、`Buffer.byteLength(json, 'utf8')` が上限以下 | `the Notion request would be 612345 bytes; Notion allows at most 500000 bytes (title, metadata, note and tags combined)` |

- **500KBは `500,000` bytes として扱う**（KB=1,000とKiB=1,024のどちらでも超過しない保守側）。JSONのEscape（Metadata JSONを文字列としてrich_textに入れることで増える `\"` 等）や、日本語（UTF-8で3 bytes）・絵文字（4 bytes）による増加は、最終的なbodyのbyte数を測ることで自然に反映される。
- 1文字あたりの上限では検出できないケース（例: 日本語のみのMetadata 200,000文字 ≒ 600KB、各Fieldは上限内だが title + metadata + note の合計が500KB超）をこの検証で検出する。
- `collection_update` は `pages.update` と `blocks.children.append` の2 Requestになるため、**両方のbodyを先に組み立てて検証してから** 1つ目を送る（片方だけ書き込まれた後に制限超過で失敗する状態を作らない。§6.6）。
- `dataSources.query`（Filter）と `pages.retrieve` はbodyが小さいため検証しない。
- Integration Testで、上限付近（499,xxx bytes）のRequestが成功することを確認する（§15.1 #8）。Notion側の実際の上限が `500,000` より厳しい場合は値を見直してPlan / 実装へ反映する。

---

## 9. Status / Tags と Notion Select option

### 9.1 option の作成・更新方法

- **Page Property書き込み時に `{ name }` で指定し、Notionの自動作成に任せる。** Notion APIは、select / multi_select に存在しないoption名を指定するとData Sourceにoptionを自動追加する（Integrationにデータ編集権限がある場合）。
- そのため **`dataSources.update` によるoption事前作成は行わない**。理由:
  - Data Source Schemaの更新はAI Foundationの責務（Domain / Connector）を超え、ユーザーがNotion上で設定したoptionの色・順序・説明を書き換えるリスクがある。
  - Connectionに必要な権限を最小化できる（Schema変更権限を前提にしない）。
- optionの**削除・リネームは行わない**。Status / Tagを変更しても、使われなくなったoptionはData Sourceに残る（Notion UIで整理する）。READMEに記載する。
- optionの色はNotionの自動割り当てに任せる。
- 大文字小文字・前後空白の異なる既存optionとの一致挙動（例: 既存 `RPG` に対し `rpg` を指定）はIntegration Testで確認し、結果をTool Description / READMEに反映する（Q8）。Connectorでは正規化しない（入力をそのまま送る）。

### 9.2 Select名の制約（Connectorで検証）

Notion公式のPage Propertyドキュメントで明示されているselect / multi_select option名の制約は**カンマ不可**のみのため、これだけを送信前に検証して `InputValidationError` を返す（Notion由来の分かりにくい400にしない）。

| 制約 | 対象 | 検証 |
|---|---|---|
| カンマ `,` を含められない | `status`, `tags[]`（`collection_type` は固定値のため不要） | `includes(',')` → `InputValidationError`（"tags must not contain commas (Notion select option names)"） |
| 1回のmulti_select値は最大100 options | `tags` | 重複除去後の件数（§8.5） |

- **option名の文字数上限はFoundation側で検証しない**（rev.1の「最大100文字」は現行のAPIドキュメント / Request Limits / SDK型定義から根拠を確認できなかったため削除）。自由文字列のStatus / TagをFoundationが不要に狭めない。長いoption名の実挙動はIntegration Testで確認し（§15.1 #7）、Notionが拒否する場合はその400を `ProviderApiError`（Notionの `message` を含む）として返す。根拠のある上限が確認できた場合は、根拠とTestを添えて検証を追加することを再提案する。
- `collection_search` の `status` / `tags` にカンマを含む値が指定された場合は一致し得ないため、Errorにせず空結果とする（Notion Filterにそのまま渡さず、Connectorで判定して空配列を返す）。

### 9.3 Data Source Schemaの型

`Status` はNotionの **`status` 型ではなく `select` 型** を使う（仕様のProperty表のとおり）。Notionの `status` 型はAPIからoptionを作成できず、自由文字列Statusを満たせないため。§6.3の検証で `status` 型を検出した場合は `ConfigurationError` に「select型へ変更する」旨を含める。

---

## 10. Page本文Noteの追加方法

- Noteは**1つのParagraph Block**として保存する（仕様: 「Paragraphとして末尾へ追記」）。
  ```ts
  { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(note) } }
  ```
- 本文は**Plain Textとして扱い、Markdown等の解釈はしない**（見出し生成・自動分類を行わない仕様に従う）。改行はrich_text内の `\n` としてそのまま保存され、Notion上は同一Paragraph内の改行として表示される（Q9）。
- 長さ: §8.1の `richText()` で2,000文字ごとに分割し、1 Paragraphのrich_text配列（最大100要素）に収める。最大200,000文字。超過は `InputValidationError`（truncateしない）。200,000文字以内でもRequest body全体が500KBを超える場合は `InputValidationError`（§8.5）。
- 作成時（`note`）: `pages.create` の `children` に含める（Atomic）。
- 追記時（`append_note`）: `blocks.children.append` に `position: { type: 'end' }` を明示する。既存Blockは読まない・変更しない（API上、追記は既存Blockを破壊しない）。
- 日時・見出し・区切り線は付与しない（仕様）。必要な構造はAI ClientがNote本文に含める。
- Noteのrich_textに装飾（annotations）・リンクは付けない。

---

## 11. Configuration変更

```ts
collection: z.strictObject({
  provider: z.enum(['notion']),
  /**
   * The Notion data source AI Foundation reads from and writes to. Not a secret, but personal:
   * keep it in config.local.yaml rather than the committed config.yaml. Optional so the server
   * still starts; collection tools return a configuration error without it.
   */
  data_source_id: z.string().min(1).optional(),
}),
```

- **optional** とする（Phase 2の `writable_calendar_id` と同じ扱い）。未設定でもServerは起動し、Task / Schedule Toolは利用でき、Collection 3 Toolは呼び出し時に `ConfigurationError` を返す。
- `config.yaml`（Public）には値を書かず、コメントで例示する。実値は `config.local.yaml`（gitignore済み）に書く。
  ```yaml
  collection:
    provider: notion
    # The AI Foundation Collection data source (Notion → database → ••• → Copy data source ID).
    # This repository is public: set it in config.local.yaml, not here.
    # data_source_id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  ```
- `database_id` ではなく `data_source_id` を使う（仕様どおり。API `2025-09-03` 以降、1 Databaseが複数Data Sourceを持ち得るため、Query / 作成先はData Source単位で指定する必要がある）。
- Credentialは引き続きConfigへ書けない（strictのため `api_token` 等は拒否）。

---

## 12. Credential Provider変更 / Notion Setup

### 12.1 Credential Provider

```ts
export interface CredentialProvider {
  getTodoistApiToken(): Promise<string>;
  getGoogleOAuthCredentials(): Promise<GoogleOAuthCredentials>;
  /** Internal integration token of the AI Foundation Notion connection. */
  getNotionApiToken(): Promise<string>;
}

// EnvCredentialProvider
async getNotionApiToken(): Promise<string> {
  return this.require('Notion', ['NOTION_API_TOKEN'])[0];
}
```

- 未設定 / 空文字は `CredentialError: Notion credential is not configured: set NOTION_API_TOKEN`（値は含めない）。
- Connectorは `CredentialProvider` のみに依存し、`process.env` を読まない（`process.env` の受け渡しは `src/index.ts` のみ、のまま）。

### 12.2 Error変換（`client.ts` の `toFoundationError`）

SDKは `APIResponseError`（`code` / `status`）、`RequestTimeoutError`、`UnknownHTTPResponseError` を投げる（`isNotionClientError()` で判定可能）。

| 状況 | Notion | AI Foundation Error |
|---|---|---|
| `NOTION_API_TOKEN` 未設定 | — | `CredentialError`（Credential Providerが投げる） |
| Token無効 | 401 `unauthorized` | `CredentialError`（"Notion rejected the API token"） |
| `data_source_id` 未設定 | — | `ConfigurationError` |
| Data Sourceが存在しない / Connectionに共有されていない | `dataSources.*` で 404 `object_not_found` | `ConfigurationError`（"Notion data source <id> was not found or is not shared with the AI Foundation connection"） |
| Data SourceのProperty不足・型不一致 | — | `ConfigurationError`（§6.3） |
| Connectionの権限（Capabilities）不足 | 403 `restricted_resource` | `ConfigurationError`（"the Notion connection lacks the required capabilities (read / update / insert content)"）（Q10） |
| 個別Pageが存在しない / Connectionから見えない | `pages.*` / `blocks.*` で 404 `object_not_found` | `NotFoundError`（"collection item notion:<id>"） |
| 専用Collection外 / ゴミ箱のPage | — | `NotFoundError` |
| `notion:` で始まらない / Page ID形式不正 | — | `InputValidationError` |
| Select名にカンマ、Tags 100件超過（重複除去後）、Metadata / Note長超過、Request body 500KB超過 | — | `InputValidationError`（§8.5、§9.2） |
| `Type` 不正なPageの更新、壊れたMetadataへのmerge | — | `ProviderApiError`（§7.3, §8.3） |
| 400 `validation_error` / `invalid_request` 等（上記で防げなかったもの） | 400 | `ProviderApiError`（Notionが返したMessageを含める） |
| 409 `conflict_error` / 429 `rate_limited` / 5xx / Timeout / Network | — | `ProviderApiError`（HTTP Status・Codeを含める） |

- 404の意味を呼び出し箇所で分ける: `toFoundationError(error, { notFound })` に、Data Source操作では `ConfigurationError` を、Page操作では `NotFoundError` を生成する関数を渡す（Phase 2のGoogle Calendar `toFoundationError` と同じ形）。
- SDKのError Objectは `cause` にのみ保持する。MessageにはNotionのError `message` と `code` / HTTP Statusのみを含め、Token・`Authorization` ヘッダ・Request Bodyを含めない（テストで検証）。

### 12.3 Notion Setup（READMEへ手順化）

仕様 §Notion Setup の手順を具体化する。

1. Notionで Database「AI Foundation Collection」を作成する（Full page推奨）。
2. Propertyを作成する: `Name`（Title、既定のまま）/ `Type`（Select）/ `Status`（**Select**。Status型ではない）/ `Tags`（Multi-select）/ `Metadata`（Text）。
3. `Type` に `game` / `book` / `movie` / `other` のoptionを作っておく（任意。書き込み時に自動作成もされる）。必要に応じて種類別・Status別のViewを作成する。
4. Notion Developer Portal（`https://www.notion.so/profile/integrations`）でInternal Integration（Internal Connection）を作成する。Capabilities: **Read content / Update content / Insert content**（User情報・Commentは不要）。
5. Databaseの `•••` → Connections から、作成したConnectionを追加する。
6. Databaseの `•••` → Manage data sources（または Data Sourceのメニュー）→ **Copy data source ID** でData Source IDを取得する。
7. `.env` に `NOTION_API_TOKEN=<token>`、`config.local.yaml` に `sources.collection.data_source_id: "<id>"` を設定する。

Notion UIのメニュー名はIntegration Verification時に実画面で確認し、READMEに反映する。

---

## 13. 依存Package

| Package | 種別 | Version | 用途 |
|---|---|---|---|
| `@notionhq/client` | dependencies | `^5.27.0` | Notion公式JavaScript / TypeScript SDK。Data Source API（`2025-09-03` / `2026-03-11`）対応、型付きRequest / Response、`APIResponseError` / `APIErrorCode`、`isFullPage` 等のHelper。依存Packageなし、`engines.node >=18`（本Repositoryの `>=24` と矛盾しない） |

- Endpointは6つと少なく `fetch` 直書きも可能だが、Phase 2（Todoist SDK採用）と同じ理由で公式SDKを採用する: 型定義とAPI Version差分への追従をSDKに任せられ、`NotionClient` Interface経由でFakeを注入できる。
- **SDK組み込みRetry**: SDK v5は既定で 429 / 529 を全Methodで、500 / 503 をGET / DELETEのみ最大2回Retryする（`retry-after` 準拠、最大遅延60秒）。仕様の「独自のRetry Frameworkは追加しない」はAI Foundation側にRetry層を作らないことと解釈し、**SDK既定のRetryはそのまま使う**。ただしTool呼び出しが長時間ブロックしないよう `retry: { maxRetries: 2, maxRetryDelayMs: 10_000 }` を明示する（Q11）。POST（作成）は5xxではRetryされないため重複作成は起きない。
- 追加しないもの: Markdown → Block変換Library（`@tryfabric/martian` 等）、JSON Schema Library。

バージョンは実装開始時点の最新安定版を再確認し、Lockfileで固定する。

---

## 14. Test Strategy

### 14.1 方針

- `npm test` は実Notion APIへ一切通信しない（Fake `NotionClient` / Fake Connector / Fake CredentialProvider）。
- 層ごとに責務を分ける: Tool LayerはFake Connector、ConnectorはFake `NotionClient`、Mapping / Filter / Schema検証 / Metadata mergeは純粋関数として直接テストする。
- `npm run typecheck && npm test` 成功をImplementation Review前の必須条件とする。

### 14.2 Domain（`tests/domain/collection.test.ts`）

| 対象 | 正常系 | 異常系 |
|---|---|---|
| `CollectionItemSchema` | 既存の§5.5の例、`status: null` | 既存の異常系（unknown type、配列Metadata等） |
| `CollectionCreateInputSchema` | 必須のみ、全Field、`note: null` | `title` / `collection_type` / `status` 欠落、`status: ''`、`note: ''` / `'   '`、`metadata: []`、`data_source_id` 指定（strict） |
| `CollectionSearchFilterSchema` | `{}`、各Filter単独、全Filter | `collection_type: 'music'`、`query: ''`、`database_id` 指定（strict） |
| `CollectionUpdateInputSchema` | 各Field単独、`status: null`、`tags: []`、`metadata: {}` | `id` のみ、`{ id, append_note: null }`、`title` / `collection_type` 指定（strict）、`append_note: ''` |
| `mergeMetadata` | §8.4の表 | — |

### 14.3 Credentials / Config

- `EnvCredentialProvider.getNotionApiToken`: 値あり / 未設定 / 空白のみ → `CredentialError`、Messageに値を含まない。
- `ConfigSchema`: `data_source_id` あり / なし / 空文字拒否、`collection` への未知Key（`api_token`）拒否。

### 14.4 Notion Connector

Fake `NotionClient`（`tests/connectors/notion/fake-client.ts`）はData Source定義・Page・本文Blockを保持し、全呼び出しの引数を記録する。`dataSources.query` は §6.5 の範囲のFilter（`and` / `title.contains` / `select.equals` / `multi_select.contains`）とPaginationを解釈する。任意の呼び出しで `APIResponseError` 等を投げられるようにする。

| 観点 | ケース |
|---|---|
| Mapping | Property ↔ Domainの往復、`id` = `notion:<uuid>`、`external_ref` = `page.url`、空Name → `(Untitled)`、Status未設定 → `null`、Tags未設定 → `[]`、Metadata空 → `{}` |
| Rich Text分割 | 2,000文字境界、Surrogate Pairを割らない、200,000文字ちょうどはOK / 超過は `InputValidationError`、分割後の連結で元に戻る（日本語・絵文字） |
| Request制限（§8.5） | **Tags**: 重複除去後100件はOK / 101件は `InputValidationError`、重複を含む101要素で重複除去後100件ならOK。**Request body size**: ASCII・日本語（3 bytes/文字）・絵文字（4 bytes/文字、Surrogate Pair）それぞれで500,000 bytesちょうど（境界内）はOK / 1 byte超過はError、200,000文字以内の日本語Metadataが500KB超でError、title + metadata + note + tags が各Field上限内だが**合算**で500KB超になる `collection_create` でError、Metadata JSONのEscape増加分が計上されること。いずれもNotion Clientのメソッドが**1回も呼ばれない**こと |
| Metadata | JSON化して保存、読み取りで復元、配列・プリミティブ・不正JSONは「読めない」扱い、shallow merge（§8.4） |
| Schema検証 | 5 Property正常、追加Propertyは無視、欠落・型不一致を**まとめて**報告、`Status` がstatus型 → 専用Message、成功時のMemoize（`retrieve` が1回だけ）、失敗時は再試行される、`data_source_id` 未設定 → `ConfigurationError`（Token取得前） |
| create | `parent.data_source_id` が常にConfig値、各Property、`note` あり → `children` に1 Paragraph、`note: null` / 未指定 → `children` なし、Tags重複除去、Select名のカンマ / Tags 101件 / body 500KB超過で `InputValidationError` かつ `pages.create` が呼ばれない、長いoption名（100文字超）は検証せずそのまま送る |
| search | `{}` → `filter` なし、各Filter → Notion Filter（`tags` は各Tagが `contains` のAND）、複数Filterの `and`、Pagination（`has_more` / `next_cursor` を最後まで）、`last_edited_time` 降順、Page本文APIを呼ばない、`Type` 不正Pageの除外、壊れたMetadataのItemは `metadata` 省略 |
| update | 不正ID形式、存在しないPage → `NotFoundError`、専用Data Source外のPage → `NotFoundError`（`pages.update` が呼ばれない）、`in_trash` → `NotFoundError`、`status` 更新 / `status: null` → `select: null`、`tags` 置換 / `[]`、`metadata` merge、壊れたMetadataへのmerge → Errorかつ書き込みなし、壊れたMetadataでも `status` のみの更新は成功、`append_note` のみ → `pages.update` を呼ばず `blocks.children.append`（`position: end`）、Property更新成功後のNote追記失敗 → Propertyは更新済みと分かる `ProviderApiError`、`title` / `collection_type` を送らない、`Type` 不正Pageの更新 → 書き込みなしでError、`pages.update` のbodyは上限内だが `append_note` のbodyが500KB超 → `pages.update` も `blocks.children.append` も呼ばれない |
| Error | 401 → `CredentialError`、Data Source 404 → `ConfigurationError`、Page 404 → `NotFoundError`、403 `restricted_resource` → `ConfigurationError`、400 / 409 / 429 / 500 / Timeout / Network → `ProviderApiError`、Token未設定 → `CredentialError`、全MessageにTokenが含まれない |
| 認証 | `lazyNotionClient`: TokenがCredentialProvider由来、Client生成は1回、Credential失敗時は次回再試行、`notionVersion` に `NOTION_API_VERSION` を渡す（Factoryを注入して検証） |

### 14.5 Tool Layer（`tests/tools/collection.test.ts`）

`InMemoryTransport` + `@modelcontextprotocol/client` + `FakeCollectionConnector`。

- `listTools()` に3 Toolが含まれ、Input Schema（必須項目、`collection_type` のenum、`collection_update` に `title` / `collection_type` がないこと）とAnnotation（§17 その他）が公開される。
- 各Toolの `callTool()` が `structuredContent`（`{ item }` / `{ items }`）とJSON `content` を返し、Fake ConnectorへDomain Inputがそのまま渡る。
- Validation Error（`collection_update` で `id` のみ、`data_source_id` 指定）が `isError` になり、Connectorが呼ばれない。
- Connectorの `NotFoundError` / `ConfigurationError` のMessageが `isError` 結果に現れる。
- `connectors.collection` 未設定時に `ConfigurationError`。

### 14.6 Server / e2e

- `tests/server.test.ts`: 公開Tool 9件。
- `tests/e2e/stdio.test.ts`: `CREDENTIAL_VARS` に `NOTION_API_TOKEN` を追加。Credentialなしで起動し `listTools()` が9件、リポジトリの `config.yaml`（`data_source_id` なし）で `collection_search({})` が `Configuration error` の `isError` を返す（外部通信なし）。`data_source_id` を設定した一時Configでは `Credential error` を返す。

---

## 15. Integration Verification

### 15.1 Integration Test（`tests/integration/notion.integration.test.ts`、手動起動）

- `npm run test:integration`。`AI_FOUNDATION_INTEGRATION=1`、`NOTION_API_TOKEN`、Configの `data_source_id` が揃わない場合は全件skip。
- 実Notionの専用Collection Data Source（テスト用に別Databaseを用意してもよい）に対して、Connectorを直接使って確認する。作成するItemのTitleには `runLabel`（`[af-it <timestamp>]`）を付ける。

| # | 確認内容 |
|---|---|
| 1 | Data Source Schema検証が通る |
| 2 | `create`（全Field + `note`、日本語・絵文字を含む）→ Name / Type / Status / Tags / Metadataが保存され、本文に1 Paragraphがある（テストコードから `blocks.children.list` で確認） |
| 3 | `search`: `query`（部分一致、大文字小文字違い）/ `collection_type` / `status` / `tags`（AND、片方のみ持つItemが除外される）/ 複合 / `{}` |
| 4 | `update`: `metadata` shallow merge（既存Keyの保持、`null` 保存）、`tags` 置換と `[]` 全削除、`status` 変更と `null` クリア |
| 5 | `update`: `append_note` が既存Paragraphの後ろに追加され、既存本文が変わらない |
| 6 | exact ID: ハイフン付き / なしの両形式で更新できる |
| 7 | 未作成のStatus / Tag名でoptionが自動作成される。既存optionと大文字小文字だけが異なる名前の扱い（Q8）。長いoption名（100文字超・数百文字）が受け付けられるか（§9.2。拒否される場合はNotionのMessageを記録し、検証追加を再提案） |
| 8 | 2,000文字超のMetadata / Noteが分割保存され、読み戻して一致する（Notionの文字数カウント確認）。Tags 100件で作成できる。日本語を含む上限付近（約490KB）の `collection_create` が成功し、事前検証の上限値（500,000 bytes）がNotionの実制限と矛盾しないこと |
| 9 | 共有されていないData Source ID → `ConfigurationError`、存在しないPage ID → `NotFoundError`、専用Data Source外のPage（テスト用に別途共有したPage。用意できなければ手動確認）→ `NotFoundError` |

- **後片付け**: テストで作成したPageは、テストコードから直接 `pages.update({ in_trash: true })` を呼んでゴミ箱へ移す（`afterAll`）。**ConnectorにもToolにもDelete操作は実装しない**（仕様）。
- Integration Testで確定したNotionの挙動（`contains` の大文字小文字、option名の一致規則、文字数カウント）はPlan / README / Tool Descriptionへ反映して報告する。

### 15.2 手動Verification

- Notion Setup手順（§12.3）をREADMEどおりに実施できること（メニュー名の確認を含む）。
- `Status` をNotionのStatus型で作った場合、およびConnectionを共有していない場合に、原因が分かる `Configuration error` が返ること。

---

## 16. LLM Client Verification

Build後、Claude CodeにServerを登録し（`NOTION_API_TOKEN` は `.env` またはMCP Client設定の `env`、`data_source_id` は `config.local.yaml`）、以下を確認して結果をPRに記録する。

| # | 発話例 | 期待するTool呼び出し | 確認 |
|---|---|---|---|
| 1 | 「『Designing Data-Intensive Applications』を積読に追加」 | `collection_create(collection_type: book, status: <積読を表す値>)` | Notionに作成される。Statusの値はLLMが選ぶ（自由文字列） |
| 2 | 「積読の本を見せて」 | `collection_search(collection_type: book, status: ...)` | 1が含まれる |
| 3 | 「ペルソナ3 リロードをクリアした。感想は○○」 | `collection_search(query: ペルソナ3)` → exact id → `collection_update(status, append_note)` | Statusが更新され、本文末尾に感想が追記される。Titleで直接更新されない |
| 4 | 「この本に分散システムタグを付けて」 | `collection_search` → exact id → `collection_update(tags: [既存..., 分散システム])` | 既存Tagが消えない（置換仕様のため、LLMが既存Tagを含めて渡すこと） |
| 5 | 「このゲームの評価を5にして」 | `collection_search` → `collection_update(metadata: { rating: 5 })` | 既存Metadataが保持される |
| 6 | 「今週の予定と、遊んでいるゲームを見せて」 | `schedule_list` + `collection_search` | 複数Sourceの組み合わせ（MVP §18） |

#4は `tags` が置換であることをLLMが理解する必要があるため、Tool Descriptionに「既存Tagを残す場合は検索結果の `tags` に追加して渡す」と明記する（§17 その他）。

Statusの語彙（「積読」を `wishlist` とするか `unread` とするか等）はFoundationで固定しない仕様のため、LLMが既存Itemの `status` を `collection_search` で確認して揃えることを期待する。Tool Descriptionに例（`game: wishlist / playing / completed` 等）を記載する。

---

## 17. 懸念点 / 未確定事項

rev.2時点で、Q1は仕様修正により解決済み、Q2〜Q11はPR #4 レビューで合意済み。未解決の事項はない。Q8と §9.2 / §8.5 の実挙動はIntegration Testで確定させる。

### Q1. `CollectionItemSchema.status` をnullableにする（解決済み: 仕様修正）

Phase 3 §collection_update の `status: null`（クリア）とEntity定義の不整合は、User + ChatGPTにより `main` の仕様側で修正された（`b4ffe5e` / `0fdcf5f`）。

- Phase 3 Design Issue / MVP §5.5: CollectionItem `status: string | null`
- `collection_create.status` は引き続き非空文字列必須
- `collection_update(status: null)` 後のEntityのみnullを許容

本Planは §5.1 / §5.2 のとおりこれに従う。

### Q2. Notion API Version（合意済み: `2026-03-11`）

SDK v5.27.0 がサポートする `2025-09-03`（SDK既定）と `2026-03-11` のうち、新しい `2026-03-11` に固定する（§6.1）。`2025-09-03` を選ぶ場合も本Planの設計は変わらず、`in_trash` → `archived`、`position` → `after` 省略（末尾追記）に読み替えるだけ。

### Q3. 読めないMetadataの扱い（合意済み: §8.3）

読み取りでは `metadata` を省略して返し、`metadata` 指定の更新は書き込み前にError（既存内容を黙って消さない）。代替案:（a）読み取りでもErrorにする（1件の手編集でSearch全体が失敗する）、（b）`{}` として扱う（更新時にデータが消える）。いずれも推奨しない。

### Q4. `Type` が空・不正なPage（合意済み）

`collection_search` では除外（stderrに件数ログ）、`collection_update` では書き込み前にError（§7.3）。`other` への読み替えは行わない。**Phase 3では除外件数をDomain出力へ追加しない。**

### Q5. `{ id, append_note: null }` の扱い（合意済み: Validation Error）

`append_note: null` は「本文を変更しない」と定義されているため、`id` 以外が `append_note: null` だけの入力は「更新項目なし」としてValidation Errorにする。一方 `metadata: {}` は有効な（結果として変化しない）merge操作として許容する。

### Q6. `collection_search` の件数・ソート（合意済み）

- 全件をPaginationで取得し、件数上限は設けない（個人のCollection規模を想定。Phase 2 `task_list` と同じ）。数千件規模になる場合は `limit` 追加を検討する。
- ソートは `last_edited_time` 降順とする（仕様に記載なし）。

### Q7. Data Source Schema検証のMemoize（合意済み）

成功した検証結果はプロセス存続中Memoizeする。起動後にNotion側でPropertyを変更した場合はNotionの400（`ProviderApiError`）になり、再起動で再検証される。毎回 `retrieve` するとRequest数が1回増える（Notion Rate Limit: 平均3 req/s）ため、Memoizeを推奨する。

### Q8. Select option名の大文字小文字・正規化（合意済み: Integration Testで確定）

既存option `RPG` に対し `rpg` を書き込んだときに別optionが作られるか、既存に寄せられるかをIntegration Testで確認する。Connectorは正規化しない。結果に応じてTool Descriptionに「既存の表記に合わせる」旨を記載する。

### Q9. Noteの改行（合意済み: 1 Paragraph）

Noteは1 Paragraph（改行は同一Paragraph内の改行）として保存する。空行区切りで複数Paragraphに分ける案もあるが、仕様の「Paragraphとして追記」「Foundationは構造化しない」に従い1 Paragraphとする。

### Q10. 403 `restricted_resource` の分類（合意済み: `ConfigurationError`）

Connectionに必要なCapabilityがない場合の403を `ConfigurationError` とする（Tokenは有効で、Notion側のConnection設定の問題のため）。仕様のMapping表に明示はない。

### Q11. SDK組み込みRetry（合意済み）

SDK既定のRetry（429 / 529は全Method、500 / 503はGET / DELETEのみ）を使い、最大遅延を10秒に制限する（§13）。AI Foundation独自のRetry層は追加しない。

### その他

- **Tool Description**: 以下を記載する。
  - `collection_create`: 作成先は専用Collection固定、`status` は自由文字列（種類ごとの例）、`note` は本文へそのまま保存。
  - `collection_search`: `query` はTitleの部分一致、`tags` はAND、本文は検索しない、返る `id` を `collection_update` に使う。
  - `collection_update`: exact id（`notion:<id>`）必須、Titleでは更新できない、`metadata` はshallow merge、`tags` は**置換**（既存Tagを残すには検索結果の `tags` に追加して渡す）、`append_note` は本文末尾に追記、`title` / `collection_type` は変更不可、`status: null` でクリア。
- **MCP Tool Annotations**（Phase 2と同じ基準）:

  | Tool | Annotation |
  |---|---|
  | `collection_search` | `readOnlyHint: true` |
  | `collection_create` | `readOnlyHint: false`, `destructiveHint: false` |
  | `collection_update` | `readOnlyHint: false`, `destructiveHint: true`（`idempotentHint` は `append_note` が重複追記されるため付けない） |

  全Toolで `openWorldHint: true`。
- **Tool出力の形**: `collection_create` / `collection_update` は `{ item: CollectionItem }`、`collection_search` は `{ items: CollectionItem[] }`（Phase 2の `{ task }` / `{ tasks }` に揃える）。
- **Rate Limit**: Notionは平均3 req/s。`collection_update` は最大4 Request（初回のみSchema検証 + retrieve + update + append）。
- **MVP Instructions（§15）** は変更しない。

---

## 18. 実装順序

各Stepは独立してCommit可能な単位とする。Branchは `feat/phase-3-collection`（本Plan PRのMerge後に `main` から作成）。

| # | Step | 成果物 | 完了条件 |
|---|---|---|---|
| 1 | Domain | `domain/collection.ts`（Entity変更、Input Schema、`mergeMetadata`）+ Test | Domain Test成功、型検査成功 |
| 2 | Config / Credential | `config/schema.ts`, `config.yaml`, `credentials/*`, `.env.example` + Test | Config / Credential Test成功 |
| 3 | Connector境界 / Tool Layer | `connectors/types.ts`, `tools/collection.ts`, `tools/index.ts`, `FakeCollectionConnector` + Tool Test、`server.test.ts` 更新 | Tool Test成功（Fake Connectorで3 Toolが動作） |
| 4 | Notion Connector | 依存追加（`@notionhq/client`）、`connectors/notion/*` + Fake Client + Test | Notion Connector Test成功 |
| 5 | 配線 | `connectors/index.ts`、e2e更新 | 全Test成功、Credential / `data_source_id` なしで起動可能 |
| 6 | Integration Test / Documentation | `tests/integration/notion.integration.test.ts`、README（Setup手順・Tool一覧・Current Phase） | 実Notionで `npm run test:integration` 成功。確定した挙動をPlan / READMEへ反映 |
| 7 | LLM Client Verification | — | §16 の確認結果をPRへ記録 |
| 8 | 最終確認 | — | 差分に `NOTION_API_TOKEN` の値・実 `data_source_id`・`.env`・`config.local.yaml` が含まれない。`npm run typecheck && npm test && npm run build` 成功 |

Tool Layer（Step 3）をConnector実装より先に行うのは、Phase 2と同様にDomain Input → Connector Interfaceの形をFakeで先に固めるため。

---

## 19. Acceptance Criteriaとの対応

| AC | 対応 | 検証 |
|---|---|---|
| **Notion Connection**: Credential Provider経由で接続 | `getNotionApiToken()` → `lazyNotionClient` | Connector Test（Factory注入）、Integration Test |
| **Notion Connection**: Connectorが環境変数を直接読まない | Connectorは `CredentialProvider` のみに依存。`process.env` 参照は `src/index.ts` のみ | Code Review（`grep process.env`）、Fake Provider注入 |
| **Notion Connection**: Data Sourceが `data_source_id` で固定 | 作成・検索・更新対象確認すべてConfig値を使用（§6.4〜6.6） | Connector Test、Integration Test |
| **Notion Connection**: Tool Inputから任意のDatabase / Data Sourceを指定できない | Input Schemaに該当Fieldなし（strict）、updateで親Data Sourceを検証 | Domain / Tool Test（`data_source_id` 拒否）、Connector Test（専用外Page → NotFound） |
| **Collection Mapping**: 5 Propertyの相互変換 | §7 | Mapping Test、Integration Test #2 |
| **Collection Mapping**: `notion:<page-id>` / `external_ref` | §6.7 | Mapping Test |
| **collection_create**: 作成、5項目の反映、`note` の初期保存 | §6.4（`children` でAtomic） | Connector Test、Integration Test #2 |
| **collection_search**: 4 Filter、部分一致 / 完全一致 / AND、`{}` で全件、本文検索なし | §6.5 | Filter / Connector Test、Integration Test #3 |
| **collection_update**: exact IDで部分更新（status / metadata / tags / append_note） | §6.6 | Connector Test、Integration Test #4〜6 |
| **collection_update**: Metadata shallow merge | `mergeMetadata`（§8.4） | Domain / Connector Test、Integration Test #4 |
| **collection_update**: Tags置換、`[]` で全削除 | §6.6 | Connector Test、Integration Test #4 |
| **collection_update**: `append_note` は既存本文を破壊せず末尾追記 | `blocks.children.append` + `position: end`（§10） | Connector Test、Integration Test #5 |
| **collection_update**: 更新項目なしでValidation Error | `CollectionUpdateInputSchema` の `refine` | Domain / Tool Test |
| **collection_update**: Title直接更新・fuzzy matchingなし | ID必須、Schemaに `title` なし、Connectorに検索 → 更新の経路なし | Domain / Tool Test、LLM Verification #3 |
| **Security**: TokenがRepository / `config.yaml` に保存されない | Credentialは環境変数のみ、Config strict | Config Test、Step 8 |
| **Security**: 個人のData Source IDを標準Configに保存しない | `config.yaml` はコメント例示のみ、実値は `config.local.yaml` | Step 8 |
| **Security**: 未共有Data Sourceで原因の分かるConfiguration Error | Data Source 404 → `ConfigurationError`（§12.2） | Connector Test、Integration Test #9 |
| **Error Handling**: 5分類の区別 | §12.2 | Connector / Tool Test |
| **Error Handling**: Credential値・Authorization HeaderをMessageに含めない | SDK Errorは `cause` のみ | Connector Test（Message検査） |
| **Automated Test**: Tool LayerをFake Connectorでテスト | §14.5 | `npm test` |
| **Automated Test**: Mapping / Metadata JSON / Filter / Pagination / Note追加 / Validation / Error Handling | §14.2〜14.4 | `npm test` |
| **Automated Test**: 通常Suiteが実Notionに依存しない | Fake注入、Integration分離 | `npm test`（ネットワークなしで成功） |
| **Automated Test**: 実接続確認の分離 | `npm run test:integration` / 手動Verification | §15 |
| **Integration Verification**: 7項目 | §15.1 #2〜#6 | Integration Test |
| **Security / 設計方針**: Provider制限を黙ってtruncateしない | rich_text分割、Tags 100件、Request body 500KBの送信前検証（§8.5） | Connector Test（境界値）、Integration Test #8 |
| **Integration Verification**: 作成データはテストコードからのみ後片付け、Delete Toolは公開しない | `afterAll` でテストコードから `in_trash: true`。Connector / ToolにDeleteなし | Integration Test、Tool Test（公開Tool一覧） |
| **LLM Client Verification**: 4シナリオ | §16 #1〜#4 | PRへ記録 |

---

## 20. Review対応履歴

### rev.2 再レビュー（PR #4）

rev.2で前回の3点（500KB制限、multi_select 100 options、option名100文字Validationの削除）がすべて適切に反映されていることを確認され、追加のBlocking Issueはなし。ChatGPTによるPlan Reviewは完了し、User承認済み。Statusを「Plan Review完了・User承認済み」に更新した。

### rev.2（PR #4 レビュー反映）

全体方針はPhase 3 Design Issueと整合しているとの評価。Q1は仕様側（`main`）で修正済み、Q2〜Q11は推奨案で合意。

| # | 指摘 | 対応 |
|---|---|---|
| 1 | [P1] Notionの1 Request 500KB制限を設計・テストへ入れる | 送信予定の `pages.create` / `pages.update` / `blocks.children.append` bodyのUTF-8 byte数を送信前に検証し、500,000 bytes超は `InputValidationError`。`collection_update` は2 Requestとも先に検証してから送信。rich_text 2,000×100の検証は維持。ASCII / 日本語 / 絵文字 / 複数Field合算の境界Test、Integration Testで上限付近を確認（§6.4、§6.6、§8.1、§8.5、§10、§12.2、§14.4、§15.1 #8、§19） |
| 2 | [P1] multi_select 1回100 options制限 | 重複除去後のTagsが100件以下であることをcreate / updateの送信前に検証し、超過は `InputValidationError`。100件 / 101件の回帰Test（§5.2、§8.5、§9.2、§12.2、§14.4、§15.1 #8） |
| 3 | [P2] Select option名「最大100文字」の根拠 | 現行のAPIドキュメント / Request Limits / SDK（v5.27.0の型定義・README）から根拠を確認できなかったため、独自の100文字Validationを削除。カンマ不可のみ検証し、長いoption名の実挙動はIntegration Testで確認（§9.2、§14.4、§15.1 #7） |
| Q1 | 仕様の不整合をmainで修正済み | 解決済みとして反映（§3、§5.1、§17 Q1） |
| Q2〜Q11 | 推奨案に賛成。Q4は除外件数をDomain出力へ追加しない | 「合意済み」として反映（§17） |
| 他 | Repository状態のBaseを最新mainへ | Branchを `0fdcf5f` へrebaseし、§1を更新 |
