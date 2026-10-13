# Phase 2: Task / Schedule — Implementation Plan

- Status: **rev.3（Plan Review完了・User承認待ち）**
- 作成: Coding Agent (Claude Code) / 2026-10-14（rev.2: PR #3 レビュー反映、rev.3: PR #3 再レビューでQ1確定）
- 対象: [Phase 2 Design Issue](../specs/phase-2-task-schedule.md)
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Phase 1 Design Issue](../specs/phase-1-foundation.md), [Phase 1 Implementation Plan](phase-1-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

ChatGPTによるPlan Reviewは完了済み（追加のBlocking Issueなし）。**User承認まで実装は開始しない。** 判断済み事項は [§16 懸念点 / 未確定事項](#16-懸念点--未確定事項)、レビュー指摘への対応は [§17 Review対応履歴](#17-review対応履歴) を参照。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | 作業Branch `feat/phase-2-task-schedule`（PR #3）。Baseは `main` の `4a66f7e docs: clarify Phase 2 date handling`（Phase 1実装 `fb1884a` のMerge後に、Phase 2 Design Issue追加 `75924ae`、MVP仕様のPhase 2整合 `660b302`、Taskの日付扱い明確化 `4a66f7e` がコミット済み） |
| Repository | `thanatos27/ai-foundation`（**Public**） |
| ローカル環境 | Node.js v24.20.0, npm 11.19.0。`package.json` の `engines` は現在 `node >=22.12` のみ（Phase 2で `node >=24`, `npm >=11` へ変更。Q1） |
| 依存 | `@modelcontextprotocol/server ^2.3.1`, `zod ^4.6.7`, `yaml ^2.9.1`（dev: `@modelcontextprotocol/client`, `typescript ~5.9.3`, `vitest ^5.0.4`, `tsx`, `@types/node`） |
| 公開Tool | 0件（`registerTools` は空） |

### Phase 1実装の要点（Phase 2で利用・変更するもの）

| File | 現状 |
|---|---|
| `src/domain/common.ts` | `AreaSchema`, `TagsSchema`, `DateSchema`（`YYYY-MM-DD`）, `DateTimeSchema`（Offset必須）, `DateOrDateTimeSchema`, `endNotBeforeStart` |
| `src/domain/task.ts` | `TaskSchema`, `TaskCreateInputSchema`（`project_ref` あり）, `TaskListFilterSchema`（`project_ref` あり、`status` に `done` を許容） |
| `src/domain/schedule.ts` | `ScheduleSchema` / `ScheduleCreateInputSchema`。**`start` / `end` はDateTimeのみ**（Date-onlyの終日予定を表現できない）。Inputに `related_task` あり |
| `src/connectors/types.ts` | `TaskConnector { create, list }`, `ScheduleConnector { create }`, `Connectors { task?, schedule? }` |
| `src/tools/index.ts` | `ToolContext { config, connectors }` と空の `registerTools` |
| `src/config/schema.ts` | 全Object strict。`sources.schedule` は `{ provider }` のみ（`writable_calendar_id` なし） |
| `src/index.ts` | Config読込 → `serveStdio(() => createServer({ config, connectors: {} }))` |
| `tests/server.test.ts` / `tests/e2e/stdio.test.ts` | 「公開Tool 0件」を前提としたAssertionがある |

### MCP SDK v2の挙動（調査結果）

`node_modules/@modelcontextprotocol/server` の `tools/call` 実装を確認した。

- Handlerが例外を投げた場合、SDKが `{ isError: true, content: [{ type: 'text', text: error.message }] }` に変換する。
- Input Schema Validation失敗も同様に `isError: true` の結果（`Input validation error: Invalid arguments for tool ...`）になる。
- `outputSchema` 指定時は `structuredContent` を検証する。

→ Error Handlingは「意味のあるMessageを持つError Classを投げる」だけでよく、独自のError変換層は作らない（Phase 1方針を維持）。

---

## 2. 設計方針

1. **Phase 1の構造をそのまま使う。** Tool → `ToolContext.connectors` → Connector の依存方向を維持し、Provider固有処理（Label Mapping、終日予定の排他的終了日、API呼び出し）はConnectorに閉じ込める。
2. **Provider非依存のルールはDomainに置く。** 「時刻予定の`end`省略 = +1時間」「終日予定の`end`省略 = 1日」「DateとDateTimeの混在禁止」はProvider非依存のためDomainの純粋関数 / Schemaで表現し、Connectorはそれを受け取ってProvider形式へ変換する。
3. **Credentialは境界の外から注入する。** `process.env` を読むのは `src/index.ts`（Entry Point）だけとし、Connectorは `CredentialProvider` Interfaceのみに依存する。
4. **起動時に外部APIへ接続しない。** Credential取得・Inbox Project解決・OAuth Token取得はTool呼び出し時に遅延実行する。Credential未設定でもServerは起動し、該当Tool呼び出し時にCredential Errorを返す（e2e Testが外部APIなしで動くことも保証される）。
5. **テスト容易性のため、Connectorは通信手段を注入可能にする。** Todoist・Google Calendarとも、Connectorが利用するSDKメソッドだけを持つ薄いInterfaceに依存させ、テストではFakeを注入する。通常のTest Suiteは実APIへ一切通信しない。
6. **独自Framework・抽象化を増やさない。** Connector Registry、Retry/Rate-limit Framework、Cache層、汎用Mapper等は作らない。

---

## 3. 既存Phase 1実装への変更点（概要）

| 対象 | 変更 | 理由 |
|---|---|---|
| `domain/schedule.ts` | `start` / `end` を `DateOrDateTimeSchema` へ拡張し、Date/DateTime混在を拒否。`ScheduleSchema` と `ScheduleCreateInputSchema` の両方から `related_task` を削除。`ScheduleListFilterSchema` 追加。`normalizeScheduleCreateInput` 追加 | 終日予定対応（Phase 2 §Schedule）。`related_task` はPhase 2で実装しないことが確定し、MVP §5.3からも削除済み |
| `domain/task.ts` | Input Schemaから `project_ref` を削除。`TaskListFilterSchema.status` から `done` を除外。`tags` 入力で `af-` Prefixを拒否。`TaskUpdateInputSchema`, `TaskIdInputSchema` 追加 | Phase 2 §task_create / §task_list / §task_update / §task_complete、`af-*` NamespaceはAI Foundation管理用に予約 |
| `domain/common.ts` | `sameDateKind` 等のヘルパー追加 | Date/DateTime混在チェックの共通化 |
| `connectors/types.ts` | `TaskConnector` に `update` / `complete`、`ScheduleConnector` に `list` を追加 | Phase 1 Plan Q2で「入力仕様が決まるPhase 2で追加」としていたもの |
| `config/schema.ts` / `config.yaml` | `sources.schedule.writable_calendar_id` を追加 | Phase 2 §Calendar Policy |
| `tools/index.ts` | `registerTaskTools` / `registerScheduleTools` を呼ぶ | Tool公開 |
| `src/index.ts` | `.env` 読込、`EnvCredentialProvider` 生成、Connector生成 | Credential Provider境界・Connector配線 |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 「公開Tool 0件」のAssertionを「6 Toolが公開される」へ変更 | Tool公開に伴う期待値変更 |
| `.env.example`, `.gitignore`, `README.md` | Credential変数名・ローカルConfig・セットアップ手順 | Security / 利用手順 |

`domain/task.ts` の `TaskSchema`（Entity）は変更しない（`project_ref` はMVP §5.2に定義があるためEntityとしては残し、Phase 2の出力では常に `null`）。

---

## 4. 追加・変更予定ファイル

### 4.1 Source

| File | 種別 | 責務 |
|---|---|---|
| `src/domain/common.ts` | 変更 | `isDateOnly(value)`, `sameDateKind(start, end)` を追加 |
| `src/domain/task.ts` | 変更 | §5.1 |
| `src/domain/schedule.ts` | 変更 | §5.2 |
| `src/errors.ts` | 追加 | §9 のError Class 5種 |
| `src/shared/datetime.ts` | 追加 | Timezone計算の純粋関数（`zonedDateToInstant`, `formatInTimeZone`, `addDays`, `localDateOf`）。外部Libraryを使わず `Intl.DateTimeFormat` で実装 |
| `src/credentials/types.ts` | 追加 | `CredentialProvider` Interface（§8） |
| `src/credentials/env.ts` | 追加 | `EnvCredentialProvider`（§8） |
| `src/connectors/types.ts` | 変更 | `update` / `complete` / `list` メソッド追加 |
| `src/connectors/index.ts` | 追加 | `createConnectors(config, credentials)`: Configの `provider` に応じてConnectorを生成し `Connectors` を返す |
| `src/connectors/todoist/client.ts` | 追加 | `@doist/todoist-sdk` の `TodoistApi` 生成（Tokenは `CredentialProvider` から遅延取得）。Connectorが使うメソッドだけを持つ `TodoistClient` Interface（`Pick<TodoistApi, ...>`）、Pagination Helper、`TodoistRequestError` → Domain Error変換 |
| `src/connectors/todoist/mapping.ts` | 追加 | Label ↔ status/area/tags、Due ↔ `due`、Todoist Task → Domain `Task` |
| `src/connectors/todoist/filter.ts` | 追加 | `task_list` Filterの適用（純粋関数） |
| `src/connectors/todoist/connector.ts` | 追加 | `TodoistTaskConnector implements TaskConnector` |
| `src/connectors/google-calendar/client.ts` | 追加 | OAuth2Client + `calendar_v3.Calendar` の生成。Connectorが使うAPIだけを持つ `CalendarApi` Interfaceを定義 |
| `src/connectors/google-calendar/mapping.ts` | 追加 | Domain ↔ Google Event変換（終日予定の排他的終了日、期間→`timeMin`/`timeMax`） |
| `src/connectors/google-calendar/connector.ts` | 追加 | `GoogleCalendarScheduleConnector implements ScheduleConnector` |
| `src/tools/result.ts` | 追加 | `jsonResult(data)`: `structuredContent` と JSON文字列の `content` を同時に返すヘルパー（1関数のみ） |
| `src/tools/task.ts` | 追加 | `registerTaskTools`（4 Tool） |
| `src/tools/schedule.ts` | 追加 | `registerScheduleTools`（2 Tool） |
| `src/tools/index.ts` | 変更 | 上記2関数の呼び出し |
| `src/config/schema.ts` | 変更 | `writable_calendar_id` 追加（§10） |
| `src/index.ts` | 変更 | `.env` 読込、Credential Provider / Connector生成 |
| `scripts/google-auth.ts` | 追加 | Google OAuth Refresh Token取得用の1回限りのCLI（§7.5） |

### 4.2 Tests

| File | 内容 |
|---|---|
| `tests/domain/task.test.ts`, `tests/domain/schedule.test.ts` | 変更（§12.2） |
| `tests/shared/datetime.test.ts` | 追加 |
| `tests/credentials/env.test.ts` | 追加 |
| `tests/connectors/todoist/mapping.test.ts`, `filter.test.ts`, `connector.test.ts` | 追加（Fake `TodoistClient`） |
| `tests/connectors/google-calendar/mapping.test.ts`, `connector.test.ts` | 追加（Fake `CalendarApi`） |
| `tests/tools/task.test.ts`, `tests/tools/schedule.test.ts` | 追加（InMemoryTransport + Fake Connector） |
| `tests/helpers/fake-connectors.ts` | 追加（Tool Test用のIn-memory Fake） |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts`, `tests/config/*.test.ts` | 変更 |
| `tests/integration/todoist.integration.test.ts`, `google-calendar.integration.test.ts` | 追加（実API。通常Suite対象外。§13） |

### 4.3 Project設定 / Documentation

| File | 変更 |
|---|---|
| `package.json` | 依存追加（§11）、scripts `test:integration`, `auth:google` 追加。`engines` を `{ "node": ">=24", "npm": ">=11" }` に変更（Q1） |
| `vitest.config.ts` | `tests/integration/**` を除外 |
| `vitest.integration.config.ts` | 追加。`tests/integration/**/*.integration.test.ts` のみ対象 |
| `tsconfig.json` | `include` に `scripts` と `vitest.integration.config.ts` を追加 |
| `config.yaml` | `writable_calendar_id` をコメントで例示（値はコミットしない。§10, Q2） |
| `.env.example` | `TODOIST_API_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` を有効化（値は空） |
| `.gitignore` | `config.local.yaml` を追加 |
| `README.md` | Current Phase更新、PrerequisitesをNode.js 24以上 / npm 11以上へ更新（Q1）、Todoist Token / Google OAuth / 専用Calendarのセットアップ、Credentialの渡し方、Integration Test実行方法、Tool一覧 |
| `docs/plans/phase-2-implementation-plan.md` | 本ファイル |

---

## 5. Domain / Tool Input Schema変更

Tool Input SchemaはDomainのInput Schemaをそのまま使う（Phase 1方針）。Tool Inputは `z.strictObject` とし、未定義Key（例: `calendar_id`, `project_ref`）はValidation Errorにする（Q10）。

### 5.1 Task

```ts
const ActiveTaskStatusSchema = TaskStatusSchema.exclude(['done']); // inbox | next | waiting | someday

/** `af-` はAI Foundation管理用Namespace。通常Tagとしては受け付けない（大文字小文字を区別しない）。 */
export const RESERVED_TAG_PREFIX = 'af-';
const TaskTagsInputSchema = TagsSchema.refine(
  (tags) => tags.every((tag) => !tag.toLowerCase().startsWith(RESERVED_TAG_PREFIX)),
  { message: 'tags must not start with "af-" (reserved for AI Foundation)' },
);

// task_create
TaskCreateInputSchema = z.strictObject({
  title: z.string().min(1),
  status: ActiveTaskStatusSchema.optional(),        // 省略時 inbox
  due: DateOrDateTimeSchema.nullable().optional(),
  area: AreaSchema.nullable().optional(),
  tags: TaskTagsInputSchema.optional(),
});                                                  // project_ref を削除

// task_list
TaskListFilterSchema = z.strictObject({
  status: z.array(ActiveTaskStatusSchema).optional(), // done を除外
  area: AreaSchema.optional(),
  due_before: DateOrDateTimeSchema.optional(),
  due_after: DateOrDateTimeSchema.optional(),
  tags: TagsSchema.optional(),                       // af-* は通常Tagに現れないため、指定しても一致しないだけ
});                                                  // project_ref を削除

// task_update
TaskUpdateInputSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  status: ActiveTaskStatusSchema.optional(),         // done は拒否 → task_complete
  due: DateOrDateTimeSchema.nullable().optional(),   // null = 期限削除
  area: AreaSchema.nullable().optional(),            // null = Area Label削除
  tags: TaskTagsInputSchema.optional(),              // 通常Labelの置換。[] = 通常Labelを全削除
}).refine(hasAnyUpdateField, { message: 'At least one field other than id must be specified' });

// task_complete
TaskIdInputSchema = z.strictObject({ id: z.string().min(1) });
```

- `id` の形式（`todoist:<task-id>`）はProvider固有のため、DomainではなくTodoist Connectorが検証し、不正形式は `InputValidationError` とする。
- `due` / `due_before` / `due_after` の `null` は、Phase 1の `TaskListFilterSchema` では許容していたが、Filterでは「指定なし」と意味が重複するため削除する（`task_update.due` の `null` = 削除は維持）。
- `af-*` Namespaceの予約はTodoist固有ではなくAI Foundationの規則のため、Domainの入力Schemaで検証する（Tool呼び出し時にSDKが `Input validation error` として返す）。
- `TaskSchema`（出力）は変更しない。Phase 2では `id: "todoist:<id>"`, `source: "todoist"`, `external_ref: "https://app.todoist.com/app/task/<id>"`, `project_ref: null` を返す。Todoist API v1のTask objectには旧 `url` Propertyがないため、`external_ref` はConnectorでTask IDから組み立てる。

### 5.2 Schedule

```ts
const DateKindConsistent = { message: 'start and end must both be dates or both be date-times', path: ['end'] };

ScheduleSchema = z.object({
  ...OptionalMetadataShape,
  type: z.literal('schedule'),
  title: z.string().min(1),
  start: DateOrDateTimeSchema,
  end: DateOrDateTimeSchema.nullable().optional(),
  tags: TagsSchema.optional(),                        // 既存のまま
}).refine(sameDateKind, DateKindConsistent).refine(endNotBeforeStart, END_BEFORE_START);
                                                      // related_task を削除（MVP §5.3と一致）

// schedule_create
ScheduleCreateInputSchema = z.strictObject({
  title: z.string().min(1),
  start: DateOrDateTimeSchema,
  end: DateOrDateTimeSchema.nullable().optional(),
}).refine(sameDateKind, ...).refine(endNotBeforeStart, ...);  // related_task を削除

// schedule_list
ScheduleListFilterSchema = z.strictObject({
  start: DateOrDateTimeSchema,
  end: DateOrDateTimeSchema,
}).refine(endNotBeforeStart, ...);                    // 混在は許容（§7.3）
```

Provider非依存の正規化（Domainの純粋関数）:

```ts
type NormalizedScheduleCreate =
  | { kind: 'timed'; title: string; start: string; end: string }          // end省略 → start + 1h
  | { kind: 'all_day'; title: string; startDate: string; endDate: string }; // endDate はユーザー視点の包含日。省略 → startDate

function normalizeScheduleCreateInput(input: ScheduleCreateInput): NormalizedScheduleCreate;
```

`+1h` は入力DateTimeのOffsetを保ったまま計算する（例: `2026-10-17T14:00:00+09:00` → `2026-10-17T15:00:00+09:00`、`2026-10-14T20:00:00+02:00` → `2026-10-14T21:00:00+02:00`）。

`endNotBeforeStart` は既存実装（`Date.parse` 比較）がDate同士でも正しく動くため変更しない。終日予定の `start == end`（1日）は許容される。

---

## 6. Todoist Connector設計

### 6.1 利用API

公式SDK `@doist/todoist-sdk`（Todoist API v1）を使う（採用理由・Node要件は Q1）。Connectorは以下のメソッドだけを持つ `TodoistClient` Interface（`Pick<TodoistApi, 'getUser' | 'getTasks' | 'getTask' | 'addTask' | 'updateTask' | 'closeTask'>`）に依存し、テストではFakeを注入する。

| 操作 | SDKメソッド（API v1 Endpoint） |
|---|---|
| Inbox Project解決 | `getUser()` → `inboxProjectId`（`GET /user`）。プロセス内でMemoize |
| Task一覧 | `getTasks({ projectId: inboxId, limit: 200, cursor })` → `{ results, nextCursor }`。`nextCursor` がnullになるまで取得 |
| Task取得 | `getTask(id)`（`GET /tasks/{id}`） |
| Task作成 | `addTask({ content, labels, dueDate \| dueDatetime })`（`projectId` は指定しない → Inbox） |
| Task更新 | `updateTask(id, { content?, labels?, dueDate \| dueDatetime \| dueString })` |
| Task完了 | `closeTask(id)`（`POST /tasks/{id}/close`） |

- `TodoistApi` は初回Tool呼び出し時に `CredentialProvider.getTodoistApiToken()` のTokenで1回だけ生成してMemoizeする。
- SDKは `customFetch` オプションでHTTP層も差し替え可能だが、通常のテストはメソッド単位のFakeで足りるため使わない。

### 6.2 Label Mapping（`mapping.ts`）

`af-` で始まるLabelはすべてAI Foundation管理用Namespaceとして扱い、通常Tagと分離する。

```ts
const STATUS_LABELS = { next: 'af-next', waiting: 'af-waiting', someday: 'af-someday' } as const;
const AREA_LABELS   = { work: 'af-area-work', personal: 'af-area-personal' } as const;
const isManagedLabel = (label: string) => label.toLowerCase().startsWith(RESERVED_TAG_PREFIX); // 'af-'
```

| 方向 | 規則 |
|---|---|
| Domain → Todoist | `labels = [statusLabel?, areaLabel?, ...tags]`。`inbox` / `area: null` はLabelなし |
| Todoist → Domain | status: Status Labelがなければ `inbox`。area: Area Labelがなければ `null`。tags: `af-*` **以外**のLabel |
| 未知の `af-*` Label（上記5種以外） | status / area / tagsのいずれにも反映しない。`task_update` でも保持し、削除しない（将来の管理Label追加時の衝突防止） |
| 不整合（Status Labelが複数） | 読取時は固定優先順（`next` > `waiting` > `someday`、`work` > `personal`）で1つを採用。次回の該当項目更新時に同種Labelはすべて除去される |
| `tags` 入力に `af-` で始まるTag | Domain Schemaで拒否（§5.1、Q11） |

### 6.3 Due Mapping

| Domain `due` | Todoist Request（SDK引数） |
|---|---|
| `YYYY-MM-DD` | `dueDate` |
| Offset付きDateTime | `dueDatetime`（UTC `Z` 形式に変換） |
| `null`（update時） | `dueString: null`（SDK型定義上 `"no date"` と同等。期限削除） |
| 未指定 | 送らない |

| Todoist `due` | Domain `due` |
|---|---|
| `null` | `null` |
| `date` が `YYYY-MM-DD` | そのまま |
| 時刻付き（固定Timezone / UTC） | `due.timezone`（なければ `config.defaults.timezone`）のOffset付きDateTimeへ整形 |
| 時刻付き（Floating、Offsetなし） | `config.defaults.timezone` で解釈してOffset付きDateTimeへ整形 |

API v1の時刻付き `due` の正確な形状（`date` に時刻が入るか、`datetime` が別Fieldか）はSDK型定義上 `date` + `datetime?` + `timezone?` であり、Integration Testで実データを確認して確定する。

### 6.4 操作

| メソッド | 処理 |
|---|---|
| `create(input)` | Labels / Due を組み立てて `addTask` → 応答をDomain `Task` へ変換 |
| `list(filter)` | Inbox ID解決 → Inbox内の未完了Taskを全件取得 → Domainへ変換 → `filter.ts` で絞り込み |
| `update(input)` | `id` をParse → `getTask`（現在のLabel取得）→ 変更対象カテゴリのLabelだけを差し替えた `labels` を計算 → 変更Fieldのみ `updateTask` → 応答を変換 |
| `complete(id)` | 下記 |

`update` のLabel計算（AC「古いLabelが残らない」「通常Tag更新で管理用Labelが破壊されない」の中核）:

```text
next = current
if status 指定: next から全Status Labelを除去し、新しいStatus Labelを追加（inbox なら追加なし）
if area   指定: next から全Area Labelを除去し、新しいArea Labelを追加（null なら追加なし）
if tags   指定: next から af-* 以外の全Labelを除去し、tags を追加（af-* Labelはすべて保持）
status / area / tags のいずれも指定がなければ labels を送らない
```

`complete` は**close後のSoT状態と矛盾するTaskを返さない**:

```text
before = getTask(id)            // 存在確認（404 → NotFoundError）
closeTask(id)
after  = getTask(id) を試行
  after が取得でき、未完了（checked: false）  → 繰り返しTaskが次回分へ進んだ状態。after をそのまま変換して返す（status は Label 由来、due は次回日付）
  after が取得でき、完了（checked: true）     → after を status: done で返す
  after が 404                               → before を status: done で返す
```

- 繰り返しTaskでは返却Taskの `status` が `done` にならないため、Tool Descriptionに「繰り返しTaskは次回分へ進み、未完了のまま返る」ことを明記する。
- close後の `getTask` が完了Taskを返すか404になるか、繰り返しTaskのclose後の状態はIntegration Testで確認し、上記の分岐で両方に対応しておく。

`getTask` → `updateTask` の間に他所でLabelが変更された場合は後勝ちになる（Q6）。

### 6.5 Filter（`filter.ts`）

| Filter | 規則 |
|---|---|
| `status` | 配列のいずれかに一致（OR） |
| `area` | 一致（Area Labelなしは不一致） |
| `tags` | 指定Tagをすべて持つ（AND） |
| `due_before` / `due_after` | 境界を含む（`<=` / `>=`）。`due` なしのTaskは除外。双方がDateTimeなら瞬間で比較し、どちらかがDate-onlyなら `config.defaults.timezone` における日付で比較 |

比較規則は仕様に明記がないため Q3 で確認する。

### 6.6 Error変換（`client.ts`）

| 状況 | Error |
|---|---|
| Token未設定 | `CredentialError`（`CredentialProvider` が投げる） |
| `TodoistRequestError` 401 / 403（`isAuthenticationError()`） | `CredentialError`（"Todoist rejected the API token"） |
| `TodoistRequestError` 404（Task取得・更新・完了） | `NotFoundError`（"Task todoist:123 not found"） |
| `TodoistRequestError` 400 | `ProviderApiError`（Todoistが返したMessageを含める） |
| `TodoistRequestError` 429 / 5xx、Network Error、SDKの応答Validation失敗 | `ProviderApiError`（Status・概要を含める。Retryは追加しない） |
| `id` が `todoist:` で始まらない | `InputValidationError` |
| Inbox Projectが見つからない | `ProviderApiError` |

---

## 7. Google Calendar Connector設計

### 7.1 Library / 認証

- `@googleapis/calendar`（Calendar APIのみの公式Package）と `google-auth-library`（`OAuth2Client`）を使う。Token Refreshは `OAuth2Client` に任せる。
- `client.ts` で `CredentialProvider.getGoogleOAuthCredentials()` から `{ clientId, clientSecret, refreshToken }` を得て `OAuth2Client` を生成し、`setCredentials({ refresh_token })` する。初回Tool呼び出し時に1回だけ生成してMemoize。
- Connectorが依存するのは以下の最小Interfaceのみ（テストではFakeを注入）:

```ts
interface CalendarApi {
  insertEvent(calendarId: string, event: calendar_v3.Schema$Event): Promise<calendar_v3.Schema$Event>;
  listCalendars(): Promise<calendar_v3.Schema$CalendarListEntry[]>;   // Pagination込み
  listEvents(calendarId: string, params: { timeMin: string; timeMax: string }): Promise<calendar_v3.Schema$Event[]>; // Pagination込み
}
```

- OAuth Scope（最小化）:
  - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`（閲覧可能Calendar一覧）
  - `https://www.googleapis.com/auth/calendar.events`（Event読み書き）
  - `calendar.events` Scope自体は全CalendarのEvent書き込み権限を与えるため、**書き込み先を `writable_calendar_id` に固定することはConnectorのHard Ruleとして維持する**（Write系の呼び出しは `insertEvent` 1か所のみで、`calendarId` 引数には常にConfig値を渡す。テストで保証）。Scopeでの技術的制限案は Q7。

### 7.2 schedule_create

1. `config.sources.schedule.writable_calendar_id` が未設定なら `ConfigurationError`。
2. `normalizeScheduleCreateInput(input)` で正規化。
3. Google Eventへ変換:
   - timed: `start: { dateTime: start }`, `end: { dateTime: end }`。**入力のOffsetを正とし、`timeZone` は付けない**（`defaults.timezone` を付けると `+02:00` の入力と矛盾し得るため）。表示Timezoneは書き込み先CalendarのTimezoneに従う
   - all_day: `start: { date: startDate }`, `end: { date: addDays(endDate, 1) }`（**排他的終了日への変換はここだけ**）

   `defaults.timezone` はDate-onlyの期間境界（§7.3）とTodoistのFloating datetime解釈（§6.3）にのみ使う。
4. `insertEvent(writableCalendarId, event)`。`calendarId` は常にConfig値で、Tool Input由来の値は経路上に存在しない（Input Schemaもstrictで `calendar_id` を拒否）。
5. 応答をDomain `Schedule` へ変換して返す。

### 7.3 schedule_list

1. 期間を `timeMin` / `timeMax`（RFC3339）へ変換:
   - DateTime: そのまま
   - `start` がDate: `defaults.timezone` のその日 00:00
   - `end` がDate: `defaults.timezone` の**翌日** 00:00（end日を含む）
2. `listCalendars()`（`minAccessRole: 'reader'`。空き時間のみ閲覧可能なCalendarは除外）。
3. 各Calendarに `listEvents(calendarId, { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', showDeleted: false })` を並列実行。Google APIの仕様により期間と重なるEventが返る。
4. `status: cancelled` を除外し、Domainへ変換して `start` 昇順でマージ。
5. 1つのCalendarでも取得に失敗した場合は全体を `ProviderApiError` とする（部分結果を黙って返さない。Q8）。

### 7.4 Event → Schedule Mapping

| Domain | Google Event |
|---|---|
| `id` | `google_calendar:<calendarId>:<eventId>`（Q4） |
| `source` | `google_calendar` |
| `external_ref` | `htmlLink` |
| `title` | `summary`（空の場合 `(No title)`） |
| `start` / `end`（時刻予定） | `start.dateTime` / `end.dateTime`（Offset付きで返る） |
| `start` / `end`（終日） | `start.date` / `end.date - 1日`（ユーザー視点の包含終了日。1日予定は `end == start`。Q4） |
| `tags` | 返さない（Phase 2対象外） |

### 7.5 OAuth Refresh Token取得（`scripts/google-auth.ts`）

`npm run auth:google` で実行する1回限りのCLI。

1. `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` を環境変数（`.env`）から読む（Desktop App型OAuth Client）。
2. `127.0.0.1` のランダムPortでLoopback Serverを起動し、PKCE付きの認可URLを表示（`access_type=offline`, `prompt=consent`, §7.1のScope）。
3. ブラウザで同意 → Codeを受信 → Token交換。
4. Refresh Tokenを**画面に表示するだけ**とし、ファイルへは書き込まない。ユーザーが `.env`（またはMCP Client設定のenv）へ `GOOGLE_OAUTH_REFRESH_TOKEN` として設定する。

Google Cloud側の準備（Calendar API有効化、OAuth同意画面、Desktop Client作成、専用Calendar作成とCalendar ID確認）はREADMEに手順化する。

### 7.6 Error変換

| 状況 | Error |
|---|---|
| Client ID / Secret / Refresh Token未設定 | `CredentialError` |
| `invalid_grant`（Refresh Token失効・取り消し） | `CredentialError`（"Re-run npm run auth:google"） |
| HTTP 401 / 403 | `CredentialError`（403のうちRate Limit系は `ProviderApiError`） |
| HTTP 404（書き込み先Calendarが存在しない等） | `ConfigurationError`（"writable_calendar_id <id> not found or not accessible"） |
| HTTP 400 / 429 / 5xx / Network Error | `ProviderApiError` |

---

## 8. Credential Provider設計

```ts
// src/credentials/types.ts
export interface GoogleOAuthCredentials { clientId: string; clientSecret: string; refreshToken: string; }

export interface CredentialProvider {
  /** Throws CredentialError when not configured. */
  getTodoistApiToken(): Promise<string>;
  getGoogleOAuthCredentials(): Promise<GoogleOAuthCredentials>;
}
```

```ts
// src/credentials/env.ts
export class EnvCredentialProvider implements CredentialProvider {
  constructor(private readonly env: Readonly<Record<string, string | undefined>>) {}
  // TODOIST_API_TOKEN / GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
}
```

- 汎用の `get(name)` ではなくCredential種別ごとのメソッドにする。Connectorは環境変数名を知らず、将来Secret Manager実装へ差し替えても呼び出し側は変わらない。
- 非同期（`Promise`）にしておく（Secret Manager等はI/Oを伴うため）。
- 未設定時のMessageには**変数名のみ**を含め、値は含めない（例: `Todoist credential is not configured: set TODOIST_API_TOKEN`）。
- `process.env` を渡すのは `src/index.ts` のみ。テストでは任意のObjectを渡す。

### `.env` の読込

MCP ClientはServerを任意のcwdで起動するため、`src/index.ts` で **Repository Rootの `.env` が存在すれば** Node標準の `process.loadEnvFile()` で読み込む（`dotenv` は追加しない）。既存の環境変数（MCP Client設定の `env` 等）を上書きしないことを実装時に確認する。MCP Client設定の `env` で直接渡す方法もREADMEに併記する。

---

## 9. Error設計（`src/errors.ts`）

仕様の5分類をそのままClass化する。SDKが `error.message` を `isError` 結果へ変換するため、Messageの先頭に分類を含める。

| Class | Message例 |
|---|---|
| `InputValidationError` | `Invalid input: tags must not contain AI Foundation managed labels (af-next)` |
| `CredentialError` | `Credential error: Todoist credential is not configured: set TODOIST_API_TOKEN` |
| `NotFoundError` | `Not found: task todoist:123` |
| `ProviderApiError` | `Todoist API error (HTTP 503): Service Unavailable` |
| `ConfigurationError` | `Configuration error: sources.schedule.writable_calendar_id is not set` |

- 共通基底 `FoundationError`（`code` プロパティ付き）を持たせ、テストで分類を検証できるようにする。
- Schema Validation Error（Zod）はSDKが `Input validation error: ...` として返すため、そのまま使う。
- Provider SDK / HTTPのError ObjectはDomainへ漏らさず、`cause` にのみ保持する。Token・Authorization Header・Refresh TokenはMessageに含めない（テストで検証）。
- 既存の `ConfigError`（起動時のConfig読込失敗）は変更しない。`ConfigurationError` は実行時（Tool呼び出し時）の設定不備用。

---

## 10. Configuration変更

```ts
schedule: z.strictObject({
  provider: z.enum(['google_calendar']),
  writable_calendar_id: z.string().min(1).optional(),
}),
```

- **optional** とする。未設定でもServerは起動し、`schedule_list` は利用可能、`schedule_create` のみ `ConfigurationError` を返す。
- Repositoryの `config.yaml` はPublic Repositoryにコミットされるため、個人のCalendar IDは書かず、コメントで例示のみ行う。実際の値は `.gitignore` 済みの `config.local.yaml`（`config.yaml` をコピーして編集）に書き、`--config` または `AI_FOUNDATION_CONFIG` で指定する（Q2）。
- Credentialは引き続きConfigへ書けない（strict Schemaのまま。`api_token` 等の未知Keyは拒否）。

---

## 11. 依存Package

| Package | 種別 | Version | 用途 |
|---|---|---|---|
| `@doist/todoist-sdk` | dependencies | `^15.3.1` | Todoist公式TypeScript SDK（API v1。旧 `@doist/todoist-api-typescript` の後継）。型付きRequest / Response、Pagination、`TodoistRequestError` |
| `@googleapis/calendar` | dependencies | `^20.1.0` | Calendar API v3 Client（`googleapis` 全体は巨大なため単体Packageを使う）。engines: Node >=22 |
| `google-auth-library` | dependencies | `^11.3.0` | `OAuth2Client`（Token Refresh、PKCE、Loopback認可）。engines: Node >=22 |

`@doist/todoist-sdk` について:

- READMEは「Node 20.18.1+」と案内しているが、公開Package（v15.3.1）の `package.json` は `engines: { node: ">=24", npm: ">=11" }` を宣言している（`npm view` と展開したTarballで確認）。利用する具体的なVersionのMetadataを実行環境要件として優先し、本Repositoryの `engines` を `node >=24`, `npm >=11` へ引き上げる（Q1、合意済み）。
- 依存として `zod 4.3.6`（固定）、`undici`、`@doist/sdk-kmp` 等を持ち、`type-fest` をPeer依存とする。SDK内部のzodは本Repositoryの `zod ^4.6.7` とは別Instanceになるが、SDKのSchemaをDomainへ渡さないため影響しない。
- Endpointは6つと少なく直接 `fetch` でも実装できるが、公式SDKを使うことでRequest / Responseの型とAPI変更への追従をSDKに任せられ、`TodoistClient` Interface経由でFakeも容易に注入できるため、SDKを採用する。

追加しないもの: `dotenv`（Node標準 `process.loadEnvFile()` を使う）、日付Library（`Intl` で足りる）、`googleapis`（全API同梱）。

バージョンは実装開始時点の最新安定版を再確認し、Lockfileで固定する。

---

## 12. Test Strategy

### 12.1 方針

- `npm test` は外部Serviceへ一切通信しない（Fake `TodoistClient` / Fake `CalendarApi` / Fake Connector / Fake CredentialProvider）。
- 層ごとに責務を分けてテストする。Tool LayerはFake Connector、ConnectorはFake通信、Mapping / Filter / Datetimeは純粋関数として直接テストする。
- `npm run typecheck && npm test` 成功をImplementation Review前の必須条件とする。

### 12.2 Domain

| 対象 | 正常系 | 異常系 |
|---|---|---|
| `TaskCreateInputSchema` | status省略 / date due / datetime due | `status: done`、`project_ref` 指定（strict）、Offsetなし日時、`tags: ['af-next']` / `['AF-foo']`（`af-` Namespace） |
| `TaskListFilterSchema` | 空 / 全Filter | `status: ['done']` |
| `TaskUpdateInputSchema` | 各Field単独 / `due: null` / `area: null` / `tags: []` | `id` のみ、`status: done`、`title: ''`、`af-` で始まるTag |
| `ScheduleSchema` | timed / 終日 | Date・DateTime混在、`related_task` を持たないこと |
| `ScheduleCreateInputSchema` | timed（end有/無）/ date（end有/無）/ 同日の終日 | Date・DateTime混在、`end < start`、`calendar_id` / `related_task` 指定 |
| `ScheduleListFilterSchema` | date範囲 / datetime範囲 | `start` 欠落、`end < start` |
| `normalizeScheduleCreateInput` | +1h（`+09:00` / `+02:00` それぞれのOffset維持、日付跨ぎ）、終日1日、終日複数日 | — |

### 12.3 Shared / Credentials

- `datetime.ts`: `Asia/Tokyo` と夏時間のある `America/New_York` で、日付→瞬間、瞬間→Offset付き文字列、日付加算（月末・年末）を検証。
- `EnvCredentialProvider`: 値あり / 未設定 / 空文字 → `CredentialError`、Messageに値が含まれないこと。

### 12.4 Todoist Connector

Fake `TodoistClient`（§6.1のSDKメソッドのみ）は呼び出し引数を記録し、用意した応答または `TodoistRequestError` を返す。

| 観点 | ケース |
|---|---|
| Mapping | 全status × area の Label生成、読取時に `af-*`（未知の `af-foo` を含む）を `tags` から除外、不整合Labelの優先順位、Due（date / UTC / 固定TZ / Floating）の変換、`external_ref` = `https://app.todoist.com/app/task/<id>` |
| create | `addTask` に `projectId` を渡さない（Inbox）、`labels` / `dueDate` / `dueDatetime`（UTC） |
| list | `getUser().inboxProjectId` の解決とMemoize、`projectId` 指定、Pagination（`nextCursor`）、各Filter（OR / AND / 境界値 / due無し除外 / Date×DateTime比較） |
| update | status変更で旧Status Labelが消える、area変更・`area: null`、tags置換で5種の管理Labelと未知の `af-*` Labelが残る、指定外Fieldを送らない、`due: null` → `dueString: null`、不正ID形式 |
| complete | close後に未完了（繰り返しTask）→ 次回分のTaskを未完了のまま返す、close後に完了状態で取得 → `status: done`、close後に404 → close前のTaskを `status: done` で返す、close前404 → `NotFoundError` |
| Error | `TodoistRequestError` 401/403 → `CredentialError`、404 → `NotFoundError`、400/429/500 → `ProviderApiError`、Network Error → `ProviderApiError`、Token未設定、MessageにTokenが含まれない |
| 認証 | `TodoistApi` 生成に渡すTokenがCredentialProvider由来で、生成が1回だけであること（Client Factoryを注入して検証） |

### 12.5 Google Calendar Connector

Fake `CalendarApi` は呼び出し引数を記録する。

| 観点 | ケース |
|---|---|
| create | `calendarId` が常に `writable_calendar_id`、timed end省略で+1h、timedの `start` / `end` が入力Offsetのままで `timeZone` を含まない（`+02:00` 入力と `defaults.timezone: Asia/Tokyo` の組み合わせ）、終日1日（`end.date = start + 1`）、終日複数日（`end.date = end + 1`）、`writable_calendar_id` 未設定で `ConfigurationError` |
| list | 全Calendarに対して呼ぶ、Date範囲→`timeMin`/`timeMax`（翌日0時）、cancelled除外、複数Calendarのマージとソート、終日Eventの包含終了日変換、`summary` なし |
| Error | `invalid_grant` / 401 / 403 → `CredentialError`、create時404 → `ConfigurationError`、500 / Network → `ProviderApiError`、1 Calendar失敗で全体Error |

### 12.6 Tool Layer

`InMemoryTransport` + `@modelcontextprotocol/client` + In-memory Fake Connector（`tests/helpers/fake-connectors.ts`）。

- `listTools()` に6 Toolが含まれ、Input Schema（必須項目、`status` のenumに `done` がない等）とAnnotation（§16 その他）が公開される。
- 各Toolの `callTool()` が `structuredContent` と JSON `content` を返し、Fake ConnectorへDomain Inputがそのまま渡る。
- Validation Error（`task_update` で `id` のみ、`schedule_create` に `calendar_id`）が `isError` になり、Connectorが呼ばれない。
- Connectorが投げた `NotFoundError` 等のMessageが `isError` 結果に現れる。
- Connector未設定時に `ConfigurationError` を返す。

### 12.7 Server / e2e

- `tests/server.test.ts`: 公開Toolが6件であることへ変更。test-only Toolの検証は維持。
- `tests/e2e/stdio.test.ts`: Credentialなし（`env` から `TODOIST_API_TOKEN` 等を除去）でも起動し、`listTools()` が6件、`task_list` 呼び出しが `Credential error` の `isError` を返す（外部通信なし）ことを追加。`.env` を読まないよう、e2eではテスト用の一時ディレクトリを使うか読込を無効化する手段を用意する（実装時に方式を決める）。

---

## 13. Integration Verification

### 13.1 Integration Test（自動、手動起動）

- `npm run test:integration`（`vitest.integration.config.ts`）。通常の `npm test` には含めない。
- `AI_FOUNDATION_INTEGRATION=1` と必要なCredentialがない場合は全件skip。
- **Todoist**: 一意なPrefix付きTitle（`[af-it] <timestamp>`）でTaskを作成 → `list` で取得・Label / Due確認 → `update`（status / area / tags / `due: null`）→ Todoist上のLabelを直接確認 → `complete`。テストTaskは完了状態で残る。加えて、繰り返しTask（`dueString: "every day"` をテストコードから直接設定）を `complete` し、close後に未完了のまま次回分へ進んで返ることを確認する。非繰り返しTaskのclose後に `getTask` が完了Taskを返すか404になるかもここで確定する。
- **Google Calendar**: テスト用Calendar（`writable_calendar_id`）にtimed / 終日1日 / 終日複数日を作成 → `list` で取得・期間確認 → 後片付けとしてテストコードからのみ `events.delete` を呼ぶ（ConnectorにDeleteは実装しない）。
- Todoist Due形状（§6.3）、`process.loadEnvFile` の上書き挙動はここで確定させ、必要ならPlanへ反映して報告する。

### 13.2 LLM Client Verification（手動）

Build後、Claude CodeにServerを登録し（Credentialは `.env` またはMCP Client設定の `env`）、以下を確認して結果をPRに記録する。

| # | 発話例 | 期待 |
|---|---|---|
| 1 | 「金曜までに経費精算、仕事」 | `task_create`（`due` = 直近の金曜, `area: work`）→ Todoist Inboxに `af-area-work` 付きで作成 |
| 2 | 「仕事のタスクを見せて」 | `task_list(area: work)` に1が含まれる |
| 3 | 「経費精算を次にやるに変更」 | `task_list` → `task_update(id, status: next)` → Todoistで `af-next` のみ付与 |
| 4 | 「経費精算終わった」 | `task_complete` → Todoistで完了 |
| 5 | 「土曜14時からAI Foundationを1時間進める」 | `schedule_create`（Offset付き、end = 15:00）→ 専用Calendarに作成 |
| 6 | 「来週月曜から水曜まで出張」 | 終日3日間の予定（Google Calendar上で月〜水） |
| 7 | 「今週の予定を教えて」 | `schedule_list` が専用Calendar以外の予定も含めて返す |
| 8 | 「今週のタスクと予定を見て、今日やることを整理して」 | 複数Toolを組み合わせて回答（MVP §18 Compound Operation） |

---

## 14. 実装順序

各Stepは独立してCommit可能な単位とする。Branchは `feat/phase-2-task-schedule`。

| # | Step | 成果物 | 完了条件 |
|---|---|---|---|
| 1 | Domain / Error / Datetime | `domain/*` 変更、`errors.ts`、`shared/datetime.ts` + Test | Domain / Datetime Test成功、型検査成功 |
| 2 | Config / Credential | `config/schema.ts`, `config.yaml`, `credentials/*`, `.env.example`, `.gitignore` + Test | Config / Credential Test成功 |
| 3 | Connector境界 / Tool Layer | `connectors/types.ts`, `tools/{result,task,schedule,index}.ts`, Fake Connector + Tool Test、`server.test.ts` 更新 | Tool Test成功（Fake Connectorで6 Toolが動作） |
| 4 | Todoist Connector | `engines` 変更（`node >=24`, `npm >=11`）、依存追加（`@doist/todoist-sdk`）、`connectors/todoist/*` + Test | `npm install` で `EBADENGINE` 警告が出ない。Todoist Connector Test成功 |
| 5 | Google Calendar Connector | 依存追加、`connectors/google-calendar/*`, `scripts/google-auth.ts` + Test | Google Calendar Connector Test成功 |
| 6 | 配線 | `connectors/index.ts`, `src/index.ts`（`.env`読込・Credential・Connector生成）、e2e更新 | 全Test成功、Credentialなしで起動可能 |
| 7 | Integration Test / Documentation | `tests/integration/*`, `vitest.integration.config.ts`, README | 実Credentialで `npm run test:integration` 成功 |
| 8 | LLM Client Verification | — | §13.2 の確認結果をPRへ記録 |
| 9 | 最終確認 | — | `git status` / 差分にToken・Refresh Token・Calendar ID・`.env`・`config.local.yaml` が含まれない。`npm run typecheck && npm test && npm run build` 成功 |

Tool Layer（Step 3）をConnector実装より先に行うのは、Domain Input → Connector Interfaceの形をFakeで先に固め、Connector実装をそのInterfaceに合わせるため。

---

## 15. Acceptance Criteriaとの対応

| AC | 対応 | 検証 |
|---|---|---|
| **Todoist接続**: Environment Credential Provider経由で接続 | `EnvCredentialProvider` → `TodoistTaskConnector` | Connector Test、Integration Test |
| **Todoist接続**: Connectorが環境変数を直接読まない | Connectorは `CredentialProvider` のみに依存。`process.env` 参照は `src/index.ts` のみ | Code Review（`grep process.env`）、Connector TestでFake Providerを注入 |
| **task_create**: Inboxへ作成、title/status/due/area/tagsが反映、管理Label Mapping | §6.2〜6.4 | Mapping / Connector Test、Integration Test |
| **task_list**: Inbox未完了Task取得、5種Filter、Domain変換 | §6.4〜6.5 | Filter / Connector Test、Integration Test |
| **task_update**: ID指定の部分更新 | `TaskUpdateInputSchema` + §6.4 | Domain / Connector / Tool Test |
| **task_update**: 古い管理Labelが残らない | カテゴリ単位のLabel差し替え | Connector Test、Integration Test |
| **task_update**: 通常Tag更新で管理Labelが破壊されない | 同上 + `af-*` Namespace全体を保持 | Connector Test、Integration Test |
| **task_complete**: ID指定で完了 | `closeTask` + close後の再取得でSoT状態を返す（§6.4） | Connector Test、Integration Test |
| **Google Calendar接続**: OAuth Credentialで接続 | `OAuth2Client` + Refresh Token、`scripts/google-auth.ts` | Integration Test |
| **schedule_create**: 専用Calendarへ作成 | `writable_calendar_id` 固定 | Connector Test、Integration Test |
| **schedule_create**: 他の書き込み先を指定できない | Input Schemaに書き込み先がなくstrictで拒否、Connectorは常にConfig値を使う | Tool Test（`calendar_id` 拒否）、Connector Test |
| **schedule_create**: 時刻予定のend省略で1時間 | `normalizeScheduleCreateInput` | Domain / Connector Test |
| **schedule_create**: 終日1日 / 複数日 | 包含終了日 → 排他的終了日変換（Connector） | Connector Test、Integration Test |
| **schedule_list**: 期間指定で全閲覧可能Calendarから取得 | §7.3 | Connector Test、Integration Test |
| **Security**: Token等がRepository / config.yamlに保存されない | Credentialは環境変数のみ、Config strict、`.gitignore`、Refresh Tokenは画面表示のみ | Config Test（未知Key拒否）、Step 9 |
| **Security**: 専用Calendar IDを静的Configで設定可能 | `writable_calendar_id` | Config Test |
| **Test**: Tool LayerをFake / Mock Connectorでテスト | §12.6 | `npm test` |
| **Test**: ConnectorのMapping / Validation / Error Handling | §12.4, §12.5 | `npm test` |
| **Test**: 通常Suiteが実外部APIに依存しない | Fake注入、Integration分離 | `npm test`（ネットワークなしで成功） |
| **Test**: 実接続確認の分離 | `npm run test:integration` / 手動Verification | §13 |
| **LLM Client Verification** | §13.2 | PRへ記録 |
| **Error Handling**: 5分類の区別 | `src/errors.ts` + Connector内変換 | Connector / Tool Test |

---

## 16. 懸念点 / 未確定事項

rev.3時点で、Q1〜Q5、Q7〜Q10はレビューで合意済み、Q11・Q12はレビュー指摘を反映済み。未解決の事項はない。Q6とその他は実装時の方針・注意点として残す。

### Q1. Todoist SDKの採用とNode要件（合意済み: A）

公式SDK `@doist/todoist-sdk` を採用する（§6.1、§11）。

SDKのREADMEは「Node 20.18.1+」だが、公開Package（v15.3.1）の `package.json` は `engines.node >=24` / `engines.npm >=11` を宣言している。利用する具体的なVersionのMetadataを優先し、以下とする（PR #3 再レビューでA案に合意）。

- `package.json#engines`: `{ "node": ">=24", "npm": ">=11" }`
- READMEのPrerequisitesをNode.js 24以上 / npm 11以上へ更新
- 開発環境（Node v24.20.0 / npm 11.19.0）は要件を満たす

### Q2. `writable_calendar_id` の保存場所（合意済み）

`config.yaml`（Public Repositoryにコミット）には書かず、`config.local.yaml`（gitignore）を `--config` で指定する。Configでは `optional`。

### Q3. `task_list` Filterの比較規則（合意済み）

- `due_before` / `due_after` は境界を含む。Date-onlyが絡む比較は `defaults.timezone` の日付単位で行う。`due` なしのTaskはDue Filter指定時に除外。
- `tags` はAND、`status` はOR。

### Q4. Scheduleの出力形式（合意済み）

- `id`: `google_calendar:<calendarId>:<eventId>`（Phase 2には `id` を入力に取るSchedule Toolはない）。
- 終日予定の `end`: ユーザー視点の包含終了日（1日予定は `end == start`）。

### Q5. Inbox外TaskのUpdate / Complete（合意済み）

ID指定の `task_update` / `task_complete` はInbox外のTaskも制限しない。

### Q6. Todoist固有の挙動

- **繰り返しTask**: `task_complete` は次回分へ進み、Taskは未完了のまま残る。close後に再取得してSoTの状態を返す（§6.4）。`task_update` で `due` を変更すると繰り返し設定が失われる。Tool Descriptionに両方を記載する。
- **Label更新の競合**: `task_update` はGET → POSTでLabelを差し替えるため、同時に別ClientがLabelを変更すると後勝ちになる。個人利用のため許容する。
- **Labelの自動作成・大文字小文字**: 未作成のLabel名を指定した場合の自動作成、`af-*` Labelの大文字小文字の扱いはIntegration Testで確認する。`af-` Prefixの判定は大文字小文字を区別しない側に倒している。

### Q7. Google OAuthの運用（合意済み）

- OAuth同意画面が「Testing」状態の外部アプリでは、**Refresh Tokenが7日で失効する**。継続利用には「In production」へ変更（未確認アプリ警告は出るが個人利用は可能）するか、Google Workspaceの内部アプリにする必要がある。README手順に明記する。
- 書き込み先をScopeで技術的に制限する案として、`calendar.app.created`（アプリが作成したCalendarのみ操作可能）がある。Phase 2では採用せず、`calendar.events` Scopeのもとで専用Calendar固定をConnectorのHard Ruleとして維持する（§7.1）。

### Q8. `schedule_list` の失敗時挙動（MVPでは合意済み）

一部Calendarの取得失敗時は全体をErrorとする。共有Calendarの権限変更等で日常的に失敗する場合は、部分結果 + 失敗Calendarの警告を返す方式へ変更を検討する。

### Q9. Connector未設定時もToolを公開する（合意済み）

Credentialの有無に関わらず6 Toolを常に登録し、呼び出し時にCredential / Configuration Errorを返す。Phase 1の「公開Tool 0件」前提のテストは変更する。

### Q10. Tool InputをstrictObjectにする（合意済み）

未知Key（`calendar_id`, `project_ref` 等）はValidation Errorとする。

### Q11. `af-*` Namespaceの予約（レビュー反映）

`af-` で始まるLabelをすべてAI Foundation管理用Namespaceとして扱う。`tags` 入力で `af-` Prefixを拒否し（§5.1）、Todoist → Domain変換でも `af-*` を `tags` へ含めず、`task_update` の `tags` 置換でも `af-*` Labelを保持する（§6.2、§6.4）。

### Q12. Phase 1 Schemaの変更（レビュー反映）

- `ScheduleSchema.start` / `end` をDateTimeのみ → Date or DateTimeへ拡張する。MVP §5.3（`date | datetime`）とPhase 2仕様に合わせるもの。
- `related_task` は `ScheduleCreateInputSchema` と `ScheduleSchema`（Entity）の両方から削除する。MVP §5.3からも削除済み。
- Task Input Schemaから `project_ref` を削除する。`TaskSchema`（Entity）には残す（MVP §5.2に定義あり）。

### その他

- **Timezone表記**: Taskの時刻付き `due` はTodoistへUTCで送るため、取得時の表記（Offset）が入力と異なる場合がある（同一時刻）。
- **Tool Description**: 自然言語日時はClientが解釈してOffset付きで渡すこと、ユーザーの既定Timezone（`defaults.timezone` を埋め込む）、IDの取得方法（`task_list` → `id`）、完了は `task_complete`、繰り返しTaskの挙動（Q6）、予定は専用Calendarへ作成されることを記載する。MVP §15のInstructions本文は変更しない。
- **Rate Limit**: 独自のRetryは実装しない。429は `ProviderApiError` として返す。
- **MCP Tool Annotations**: MCPの `destructiveHint: false` は「追加的な更新のみ」を意味するため、既存データを変更するToolには付けない。

  | Tool | Annotation |
  |---|---|
  | `task_list`, `schedule_list` | `readOnlyHint: true` |
  | `task_create`, `schedule_create` | `readOnlyHint: false`, `destructiveHint: false` |
  | `task_update`, `task_complete` | `readOnlyHint: false`, `destructiveHint: true` |

  全Toolで `openWorldHint: true`（外部Serviceを操作するため）。

---

## 17. Review対応履歴

### rev.3（PR #3 再レビュー反映）

再レビューでrev.2の対応はすべて妥当とされ、追加のBlocking Issueはなし。ChatGPTによるPlan Reviewは完了。

| # | 指摘 | 対応 |
|---|---|---|
| Q1 | A案を採用。`engines.node >=24`、npm `>=11` もPrerequisitesに明記（可能なら `engines.npm` にも設定）、READMEをNode 24 / npm 11以上へ更新 | `engines` を `{ "node": ">=24", "npm": ">=11" }` とし、README Prerequisitesを更新する方針に確定（§1、§4.3、§11、§14 Step 4、Q1） |
| — | Plan Statusを承認待ちへ | Statusを「rev.3（Plan Review完了・User承認待ち）」に変更 |

### rev.2（PR #3 レビュー反映）

| # | 指摘 | 対応 |
|---|---|---|
| 1 | Todoist SDKのNode要件を再確認し、SDK採用を第一候補に | `@doist/todoist-sdk ^15.3.1` を採用。Connectorは `Pick<TodoistApi, ...>` のInterfaceに依存し、テストはFake Clientで行う。README（20.18.1+）と公開Packageの `engines`（`>=24`）の食い違いを記載し、Repositoryの `engines` の扱いをQ1で確認（§6.1、§11、§12.4、Q1） |
| 2 | `ScheduleSchema.related_task` も削除 | Entity / Inputの両方から削除（§3、§5.2、§12.2、Q12） |
| 3 | Timed Eventに `defaults.timezone` を強制しない | `dateTime` は入力Offsetのまま送り、`timeZone` を付けない。`defaults.timezone` はDate-only境界とFloating datetime解釈のみに使う（§7.2、§12.5） |
| 4 | Tool Annotationの修正 | create = `destructiveHint: false`、update / complete = `destructiveHint: true`（§16 その他） |
| 5 | 繰り返しTaskで `task_complete` が常に `done` を返す矛盾 | close後に再取得し、未完了なら次回分のTaskを、完了 / 404なら `done` を返す。Integration Testで実挙動を確認（§6.4、§12.4、§13.1） |
| 6 | `af-*` をNamespaceとして扱う | `tags` 入力で `af-` Prefixを拒否（Domain）、Todoist → Domainで `af-*` を `tags` から除外、`tags` 置換で `af-*` を保持（§5.1、§6.2、§6.4、Q11） |
| 他 | `external_ref` のTask URL | API v1に `url` Propertyがないため `https://app.todoist.com/app/task/<id>` を組み立てる（§5.1） |
| 他 | Repository状態の更新 | Base `4a66f7e` と、それまでのコミットを記載（§1） |
| 他 | `calendar.events` Scopeの扱い | 専用Calendar固定をConnectorのHard Ruleとして明記（§7.1、Q7） |
