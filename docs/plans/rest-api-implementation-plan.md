# REST API化（Hono・OpenAPI・単一APIキー認証） — Implementation Plan

- Status: **Plan Review待ち**
- 作成: Coding Agent (Claude Code) / 2026-11-14
- 対象: [Issue #31](https://github.com/thanatos27/ai-foundation/issues/31)
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md)（変更しない）, [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

既存の21操作を、既存のDomain Schema・Connector・操作ルールのままREST APIとして公開する。HTTPサーバーはstdio MCPとは別の起動口とし、MCPの起動・動作は変えない。Knowledge／Life LogのGoogle Drive対応、クラウド配置、HTTPS終端、実クライアント接続は本Planの対象外。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Base | `main` の `2698458`（v0.2.0） |
| 実行環境 | Node `>=24`、TypeScript 5.9、ESM（NodeNext）、`zod 4.6.7`（重複なし）、Vitest 5 |
| 公開Tool | 7 Entity・21 Tool（`tests/e2e/stdio.test.ts` の `TOOL_NAMES`） |
| HTTP関連依存 | なし |
| CI | なし（`npm test` をローカルWindowsで実行） |

### 既存実装の要点（本Planで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/index.ts` | `parseArgs`（`--config` / `--no-env-file`）→ `.env` 読み込み → `loadConfig` → `createConnectors(config, new EnvCredentialProvider(process.env))` → `serveStdio`。SIGINT/SIGTERMで終了。`ConfigError` は理由だけを表示して `exit(1)` |
| `src/tools/<entity>.ts` | Toolごとに `server.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, handler)`。handlerは「Connector未設定なら `ConfigurationError`」の確認、Knowledgeのsource解決と既定area補完を行い、`jsonResult(payload)` を返す。説明文は `config`（タイムゾーン・Calendar別名・既定area）から組み立てる |
| `src/tools/result.ts` | `jsonResult(data)` = `{ content: [{ type: 'text', text }], structuredContent: data }`。HTTPへ持ち込むのは `data` だけ |
| `src/domain/*.ts` | 入力は `z.strictObject`。`TaskCreateInputSchema` / `TaskUpdateInputSchema` / `ScheduleCreateInputSchema` / `ScheduleListFilterSchema` / `ScheduleUpdateInputSchema` / `CollectionUpdateInputSchema` は `.refine()` 付き。`.transform` / `.preprocess` は使っていない |
| `src/errors.ts` | `FoundationError`（`code`: `invalid_input` / `credential` / `not_found` / `provider_api` / `configuration`）。メッセージは分類の接頭辞付きで、資格情報を含めない約束 |
| `src/connectors/{google-calendar,notion,todoist}/client.ts` の `toFoundationError`、`todoist/connector.ts`・`notion/connector.ts` の結果不明メッセージ | SDK例外・Providerの `message` や下位Errorの `message` を本文へ埋め込む（12か所、§6.3）。GitHubは固定文のみ、Obsidianはerrnoのcodeのみ |
| `src/credentials/env.ts` | 環境変数の未設定を `CredentialError` で通知 |
| `src/connectors/*/client.ts` 等 | Providerの401・403（権限）も `CredentialError`。未設定と拒否が同じクラス |
| `src/connectors/obsidian/filesystem-storage.ts` / `filesystem-lifelog-storage.ts` | 同名ファイルの作成を `InputValidationError`（"already exists"）で拒否 |
| `src/connectors/*/client.ts` の `lazy*Client` | 初回呼び出しのPromiseをmemoizeする。同時リクエストでも初期化は1回 |
| `tests/helpers/fake-connectors.ts` | 7 EntityのFake Connector。呼び出しのDomain入力を `calls` に記録し、`failWith` で任意の例外を投げる |
| `tests/helpers/vault.ts` | 一時Vault |

### 実装前検証（scratchpadで実施、`hono 4.13.18` / `@hono/zod-openapi 1.6.3` / `zod 4.6.7`）

| 確認 | 結果 | 本Planへの影響 |
|---|---|---|
| refine付き `z.strictObject` への `.omit()` | `.omit() cannot be used on object schemas containing refinements` で例外 | Update系Schemaを「shape＋検査関数」に分割する（§5） |
| 配列queryの値が1つ（`?tags=a`） | Honoの検証は単一値を文字列で渡すため `expected array, received string` で400 | 配列queryは `z.preprocess(toArray, z.array(...))` で受ける。OpenAPIには `type: array` で出力されることを確認（§9.2） |
| 未知のquery key・同一scalar keyの重複 | strictObjectで400、重複は配列になり400 | そのまま利用 |
| queryの `+` | 空白に変換される（`%2B` は `+`） | OpenAPIとREADMEに記載（§9.3） |
| pathの `%2F` `%25` `%23` 日本語・空白 | `encodeURIComponent` した値が1セグメントとしてroutingされ、paramは1回だけデコードされる（`%41` は `%41` のまま） | path IDはそのまま利用。`..%2F..` は `../..` としてhandlerへ届くため、Connectorの既存ID検証に任せる（§9.3） |
| 不正JSON・Content-Type不一致 | `HTTPException`（400 / 415）が `onError` に届く | 400 `invalid_input` へ変換（§6） |
| refine付きbody・nullable・`z.iso.date()`・union | refineは実行時のみ。OpenAPIは `additionalProperties: false`、`type: ["string","null"]`、`format: date` / `date-time`、`anyOf` | OpenAPI 3.1で出力する（§10） |
| plain zod Schemaの `.openapi()` | `@hono/zod-openapi` 読み込み後は既存Domain Schemaでも利用可能 | Component名はHTTP層で付与し、Domainは変更しない |

---

## 2. 設計方針

1. **操作ルールは1か所。** Tool固有だった「Connector選択・未設定時のError・既定値の補完・説明文」を `src/operations/` へ移し、MCP ToolとHTTP Routeの両方がそれを呼ぶ。入力の検証規則はDomain Schemaのまま共有する。
2. **HTTP層は変換だけ。** 認証、path / query / bodyの読み取りと検証、Domain入力への組み立て、payloadとErrorのJSON化だけを持つ。Connectorと `src/operations/` はHono・MCPに依存しない。
3. **payloadはMCPと同一。** `jsonResult` に渡していた `data` をそのままHTTPのJSON bodyにする。
4. **OpenAPIはRoute定義から生成する。** `@hono/zod-openapi` の `createRoute` とDomain Schemaを正本とし、手書きのYAML・コミット済みのJSONを持たない。
5. **認証はConnectorより前。** 全Route（`/openapi.json`、存在しないpathを含む）をBearer認証の後ろに置く。
6. **再試行しない・推測しない。** HTTP層は自動再試行・ロールバックをせず、各操作の再実行時の性質をOpenAPIに書く。

---

## 3. 基本設計の具体化・変更点

| # | 内容 | 技術的な理由 | 影響AC |
|---|---|---|---|
| D1 | 同名記事の作成を新しい `ConflictError`（code `conflict`）で通知する。メッセージ接頭辞は既存の `Invalid input:` を維持し、MCPのTool結果は変わらない | 409を返すには入力不正と競合を例外で区別する必要がある。MCPクライアントへの表示は変える必要がない | AC-04, AC-06, AC-08 |
| D2 | `CredentialError` から「未設定」を `MissingCredentialError`（`CredentialError` のサブクラス、code `credential_missing`）として分ける。MCPのメッセージは変えない | 503（設定不足）と502（外部サービスの認証拒否）を区別するため | AC-06 |
| D3 | `knowledge_search` の `area: null`（areaのないノート）をqueryでは `area=none` で表す | queryには `null` の表現がない | AC-01, AC-07 |
| D4 | 配列queryは同名keyの繰り返し（`?tags=a&tags=b`、OpenAPI `style: form, explode: true`）。値1つも配列として受ける | §1の検証結果 | AC-01, AC-07 |
| D5 | 不正JSON・JSON以外のContent-Typeは400 `invalid_input` | Issueの表に415がなく、どちらも入力不正 | AC-06 |
| D6 | リクエストbodyの上限を1 MiBとし、超過は413 `payload_too_large` | クラウド配置時に無制限のbodyを受けない。Knowledge・Life Logの本文として十分な大きさ | AC-06 |
| D7 | 未知のquery parameter・body fieldは400 | Domain入力が `strictObject` で、MCPと同じく誤記を黙って無視しない | AC-04 |
| D8 | operationIdは既存Tool名（`task_list` 等）にする | 既存の説明文はTool名で他操作を参照しており（"use task_complete"）、そのまま共有できる | AC-07 |
| D9 | `AI_FOUNDATION_API_KEY` は32文字以上の印字可能ASCII（`\x21-\x7e`）とし、満たさなければ起動しない | 推測されにくいキーを強制し、HTTP headerで送れない値を起動時に弾く | AC-03 |
| D10 | Obsidian（ローカルFilesystem）のI/O失敗は既存どおり `ProviderApiError` として502 | Knowledge・Life LogのSource of Truthへのアクセス失敗で、他Providerと同じ扱い | AC-06 |
| D11 | Errorメッセージを「AI Foundationが書いた文」と「SDK・Provider由来の文」に分けて保持し、HTTPには前者だけを返す。MCPには従来どおり両方を連結した文を返す（§6.3） | SDK例外のmessageは内容を保証できず、HTTP境界の後処理では埋め込まれた後の文字列から取り除けない。対象ID・結果不明・手動確認の案内はAI Foundationが書いた文なので残る | AC-06 |
| D12 | 再実行の性質は入力によって変わり得るものとして操作ごとに定義する。`task_update` は `recurrence` を含むと再実行で次回期限が再計算され得るため `conditional`、`collection_update` は `append_note` を含むと `conditional` | 同じ要求の再送が安全と誤解されないようにする | AC-07 |

---

## 4. 層構成と共通化範囲

```text
src/index.ts (stdio)        src/serve-http.ts (HTTP)
      │                              │
      ├── src/startup.ts（引数・.env・config・Connector生成の共通部分）
      │                              │
src/tools/*.ts (MCP)        src/http/routes/*.ts (REST)
      └──────────┬───────────────────┘
          src/operations/*.ts  ← Connector選択・既定値・説明文・入出力Schema
                 │
          src/connectors/*  ← 変更しない（D1・D2のError送出箇所のみ）
          src/domain/*      ← Update系Schemaの分割のみ（§5）
```

### 4.1 `src/operations/`（新規）

```ts
// src/operations/types.ts
export interface OperationContext { config: Config; connectors: Connectors }

/** One public operation, shared by the MCP tool and the HTTP route of the same name. */
export interface Operation<In extends z.ZodType, Out extends z.ZodType> {
  name: OperationName;          // 'task_create' … (= MCP tool name = OpenAPI operationId)
  title: string;
  description: string;          // built from config, as the tools do today
  input: In;                    // full domain input (the MCP inputSchema)
  output: Out;                  // payload ({ task: TaskSchema } …)
  /**
   * How a repeated request behaves; HTTP turns it into the retry note. `conditional` names the
   * inputs that make a repeat change the state again (e.g. task_update with recurrence).
   */
  repeat:
    | { kind: 'safe' | 'idempotent' | 'not_idempotent' | 'conflict_on_repeat'; note?: string }
    | { kind: 'conditional'; note: string };
  run(input: z.infer<In>): Promise<z.infer<Out>>;
}
```

- `src/operations/<entity>.ts` に `create<Entity>Operations(context)` を置き、Tool名をkeyとするobjectを返す。
- 移すもの：`connector()`（未設定時の `ConfigurationError`）、Knowledgeの `resolveSource` と既定area補完、Projectの `providers` 確認、Area・Life Logの `sources.*` 確認、説明文と共通の説明断片（`STATUS` / `TAGS` / `IDS` 等）、payloadのwrap（`{ task }` 等）、Output Schema。
- 移さないもの：MCP `annotations`（MCP固有、`src/tools/` に残す）、`jsonResult`。
- `src/operations/index.ts` に `createOperations(context)` と `OPERATION_NAMES`（21件）を置く。

### 4.2 `src/tools/*.ts`（薄くする）

Toolごとの `registerTool` 呼び出しは残し（MCP SDKの型推論を保つため一括loopにしない）、中身を `ops.task_create.title` / `.description` / `.input` / `.output` / `run` の参照へ置き換える。`ToolContext` は `OperationContext` の別名にする。既存の `tests/tools/*.test.ts`・`tests/server.test.ts`・`tests/e2e/stdio.test.ts` を変更せずに通すことを、この段階の完了条件とする（D1の箇所を除く）。

### 4.3 `src/startup.ts`（`src/index.ts` から抽出）

`repoFile`、`resolveConfigPath`、`loadEnvFile`、`buildContext(configPath)`（`loadConfig` → `createConnectors`）、起動Errorの表示を共通化する。`src/index.ts` の挙動・メッセージは変えない。

---

## 5. Domainの変更

`.omit()` がrefine付きSchemaで使えないため、`id` を除いたbody Schemaを作れるように3つのUpdate Schemaを分割する。検証規則・メッセージ・pathは変えない。

```ts
// src/domain/task.ts
export const TaskUpdateFields = { title: …, status: …, due: …, area: …, tags: …, recurrence: … };
export function checkTaskUpdate(input: TaskUpdateFieldsInput, ctx: z.RefinementCtx): void { /* 既存2つのrefineと同じissue */ }
export const TaskUpdateInputSchema = z.strictObject({ id: z.string().min(1), ...TaskUpdateFields }).superRefine(checkTaskUpdate);
```

| Domain | 分割するもの | HTTP body Schema（`src/http/schemas.ts`） |
|---|---|---|
| Task | `TaskUpdateFields` / `checkTaskUpdate` | `z.strictObject(TaskUpdateFields).superRefine(checkTaskUpdate)` |
| Schedule | `ScheduleUpdateFields` / `checkScheduleUpdate` | 同上 |
| Collection | `CollectionUpdateFields` / `checkCollectionUpdate` | 同上 |
| Knowledge / Life Log append | 分割不要（refineなし） | `KnowledgeAppendInputSchema.omit({ id: true })` / `LifeLogAppendInputSchema.omit({ id: true })` |

`id` を先頭に置くshapeの合成にするため、MCPの `inputSchema` のproperty順は変わらない。

配列query用のSchemaもHTTP層で合成する（Domainの `TaskListFilterSchema` 等はrefineなしなので `.shape` を再利用できる）。

---

## 6. エラー分類

### 6.1 `src/errors.ts` の変更

```ts
export type FoundationErrorCode =
  'invalid_input' | 'credential' | 'credential_missing' | 'not_found' | 'conflict' | 'provider_api' | 'configuration';

/** Credentials are rejected or expired by the provider. */
export class CredentialError extends FoundationError {
  readonly code: 'credential' | 'credential_missing' = 'credential';   // 接頭辞 "Credential error:" は維持
}
/** A credential AI Foundation needs is not set (or cannot be sent). */
export class MissingCredentialError extends CredentialError { override readonly code = 'credential_missing'; }

/** The request conflicts with the current state (e.g. a file with that name exists). Never overwrites. */
export class ConflictError extends FoundationError { readonly code = 'conflict'; /* 接頭辞は "Invalid input: " を維持 */ }
```

各Errorのconstructorは、従来の `string` に加えて §6.3 の `MessagePart[]` も受け付ける。

送出箇所の変更：

| File | 変更 |
|---|---|
| `src/credentials/env.ts` | 未設定を `MissingCredentialError` |
| `src/connectors/github/client.ts:50` | headerで送れない `GITHUB_TOKEN` を `MissingCredentialError`（設定の不備） |
| `src/connectors/obsidian/filesystem-storage.ts` / `filesystem-lifelog-storage.ts` | `alreadyExists` を `ConflictError` |
| `src/connectors/obsidian/storage.ts` / `lifelog-storage.ts` | JSDocの「InputValidationError when … exists」を `ConflictError` に |

### 6.2 HTTPへの変換（`src/http/errors.ts`）

レスポンスは常に `{ "error": { "code": string, "message": string } }`。`cause`・`stack`・例外名・入力値の全文は含めない。表の `publicMessage` は §6.3 のとおり、SDK・Provider由来の文を除いたメッセージ。

| 発生源 | HTTP | `error.code` | `message` |
|---|---|---|---|
| Zod検証失敗（path / query / body） | 400 | `invalid_input` | `Invalid input: <path>: <issue>; …`（Zodのissueのpathとmessageのみ） |
| 不正JSON・JSON以外のContent-Type（`HTTPException` 400 / 415） | 400 | `invalid_input` | 固定文 |
| `InputValidationError` | 400 | `invalid_input` | `publicMessage` |
| APIキー未指定・不一致 | 401 | `unauthorized` | 固定文。`WWW-Authenticate: Bearer` を付ける |
| `NotFoundError` | 404 | `not_found` | `publicMessage` |
| 存在しないpath・method（認証後） | 404 | `route_not_found` | 固定文 |
| `ConflictError` | 409 | `conflict` | `publicMessage` |
| body上限超過 | 413 | `payload_too_large` | 固定文 |
| `CredentialError`（Providerが拒否） | 502 | `provider_auth_failed` | `publicMessage` |
| `ProviderApiError` | 502 | `provider_error` | `publicMessage` |
| `MissingCredentialError` | 503 | `credential_missing` | `publicMessage`（環境変数名のみ。値は含まない） |
| `ConfigurationError` | 503 | `configuration_error` | `publicMessage` |
| 上記以外 | 500 | `internal_error` | 固定文 `Internal server error`。例外はstderrへ記録 |

- 変換表は `FoundationErrorCode` をkeyとする `satisfies Record<FoundationErrorCode, …>` で定義し、codeの追加時に型エラーで漏れを検出する。
- stderrの記録は5xxのときだけ行い（MCPと同じ `message` と `cause` を含む）、`Authorization` headerは記録しない。

### 6.3 SDK・Provider由来の文の分離（`src/errors.ts`）

```ts
/** Text an SDK or a provider wrote. Shown to MCP clients as before; never sent over HTTP. */
export function providerText(text: string): MessagePart;      // { full: text, public: '(provider details omitted)' }
/** The message of another error, keeping its own split (e.g. the cause of a failed rollback). */
export function errorText(error: unknown): MessagePart;        // FoundationError: { full: message本文, public: publicMessage本文 }
                                                               // それ以外: providerText(String(error.message))
export type MessagePart = string | { full: string; public: string };

export abstract class FoundationError extends Error {
  /** `message` without the provider-written parts: what the HTTP API returns. */
  readonly publicMessage: string;
}
```

- `message`（MCP）は全partの `full` を連結した従来と同一の文、`publicMessage`（HTTP）は `public` を連結した文。どちらにも分類の接頭辞を付ける。`string` だけで作ったErrorは両者が同じ。
- 変更する12か所（MCPのメッセージは変えない）：

| File | 箇所 | publicMessageに残る内容（例） |
|---|---|---|
| `google-calendar/client.ts` `toFoundationError` | 401・403の `CredentialError`、その他の `ProviderApiError`（3か所） | `Google rejected the credentials (HTTP 401)` / `Google Calendar API error: <context>: HTTP 500` |
| `notion/client.ts` `toFoundationError` | `RestrictedResource` の `ConfigurationError`、HTTP errorとその他の `ProviderApiError`（3か所） | `…lacks a required capability … (HTTP 403)` / `Notion API error: HTTP 502 <code>` |
| `todoist/client.ts` `toFoundationError` | HTTP errorとその他の `ProviderApiError`（2か所） | `Todoist API error: HTTP 500` |
| `todoist/connector.ts` | `complete` の読み戻し失敗、`rollBackCreated` の削除失敗、`restoreDue` の復元失敗（3か所） | 対象Task ID、「作成済みで削除に失敗」「may still exist」「do not call task_create again」等の結果と手動確認の案内 |
| `notion/connector.ts` | `append_note` の追記失敗（1か所） | 「propertiesは更新済み、noteは未追記」と対象ID |

- Providerのcode（Notionの `code`、HTTP status、GitHubのrate limit文言、Obsidianのerrno）は形式が決まった値なので、AI Foundationが書いた文として扱う。Notionの `code` は既存の形式チェックがないため `/^[a-z_]+$/` に一致するときだけ残す。
- 漏れの防止：`tests/errors-provider-text.test.ts` で `src/connectors/**` を走査し、`.message` / `String(error)` / Notion・Googleの `message` 変数をtemplate literalへ直接埋め込む箇所があれば失敗させる（`providerText` / `errorText` 経由のみ許可）。

---

## 7. 認証（`src/http/auth.ts`）

- `app.use('*', bearerAuth(apiKey))` を全Route・`notFound` より前に置く。
- `Authorization` が `Bearer <token>`（scheme大文字小文字は区別しない、区切りは1個以上の空白）でなければ401。
- tokenと設定値をそれぞれSHA-256にしてから `crypto.timingSafeEqual` で比較する（長さの違いで分岐しない）。
- Honoの `hono/bearer-auth` は使わない（失敗時のレスポンス形式を共通JSONにするため）。
- APIキーは `createHttpApp({ config, connectors, apiKey })` の引数で受け取り、`process.env` を読むのは起動口だけにする。

---

## 8. 21操作のHTTP仕様

`{id}` はpath、`?id=` は必須query（OpenAPIのpathには含めない）。payloadは既存Toolの `jsonResult` に渡していた値と同じ。

| operationId | Method・Path | 入力 | 成功 | payload | 再実行（`repeat`） |
|---|---|---|---|---|---|
| `task_list` | `GET /v1/tasks` | query: `status[]` `area` `due_before` `due_after` `tags[]` | 200 | `{ tasks: Task[] }` | safe |
| `task_create` | `POST /v1/tasks` | body: `TaskCreateInputSchema` | 201 | `{ task: Task }` | not_idempotent（重複作成） |
| `task_update` | `PATCH /v1/tasks/{id}` | body: Task Update body | 200 | `{ task: Task }` | conditional（`title`/`status`/`due`/`area`/`tags` は同じ要求の再送で同じ状態。`recurrence` を含むと規則を再設定し、Todoistが次回期限を再計算し得る） |
| `task_complete` | `POST /v1/tasks/{id}/complete` | bodyなし | 200 | `{ task: Task }` | not_idempotent（繰り返しTaskは再実行で次回分も完了） |
| `schedule_list` | `GET /v1/schedules` | query: `start`* `end`* `calendar` | 200 | `{ schedules: Schedule[] }` | safe |
| `schedule_create` | `POST /v1/schedules` | body: `ScheduleCreateInputSchema` | 201 | `{ schedule: Schedule }` | not_idempotent |
| `schedule_update` | `PATCH /v1/schedules/{id}` | body: Schedule Update body | 200 | `{ schedule: Schedule }` | idempotent（指定した値で上書きするだけ） |
| `collection_search` | `GET /v1/collection-items` | query: `query` `collection_type` `status` `tags[]` | 200 | `{ items: CollectionItem[] }` | safe |
| `collection_create` | `POST /v1/collection-items` | body: `CollectionCreateInputSchema` | 201 | `{ item: CollectionItem }` | not_idempotent |
| `collection_update` | `PATCH /v1/collection-items/{id}` | body: Collection Update body | 200 | `{ item: CollectionItem }` | conditional（`append_note` を含むと再実行で追記が重複） |
| `knowledge_search` | `GET /v1/knowledge` | query: `query` `area`（`work`/`personal`/`none`） `tags[]` | 200 | `{ items: KnowledgeSearchResult[] }` | safe |
| `knowledge_create` | `POST /v1/knowledge` | body: `KnowledgeCreateInputSchema` | 201 | `{ knowledge: Knowledge }` | conflict_on_repeat（成功後の再実行は409） |
| `knowledge_get` | `GET /v1/knowledge/entry?id=` | query: `id`* | 200 | `{ knowledge: Knowledge, content: string }` | safe |
| `knowledge_append` | `POST /v1/knowledge/entry/append?id=` | query: `id`*、body: `{ content }` | 200 | `{ knowledge: Knowledge }` | not_idempotent |
| `project_list` | `GET /v1/projects` | query: `query` `owner` | 200 | `{ items: Project[] }` | safe |
| `project_get` | `GET /v1/projects/entry?id=` | query: `id`* | 200 | `{ project: Project, details: GitHubProjectDetails }` | safe |
| `area_list` | `GET /v1/areas` | query: `query` | 200 | `{ items: Area[] }` | safe |
| `area_get` | `GET /v1/areas/{id}` | なし | 200 | `{ area: Area, content: string }` | safe |
| `lifelog_create` | `POST /v1/lifelogs` | body: `LifeLogCreateInputSchema` | 201 | `{ lifelog: LifeLog }` | conflict_on_repeat |
| `lifelog_get` | `GET /v1/lifelogs/{id}` | なし | 200 | `{ lifelog: LifeLog, content: string }` | safe |
| `lifelog_append` | `POST /v1/lifelogs/{id}/append` | body: `{ content }` | 200 | `{ lifelog: LifeLog }` | not_idempotent |

`*` は必須。各Routeのhandlerは「検証済みのpath / query / bodyをDomain入力に組み立てる → `ops.<name>.run()` → `c.json(payload, status)`」だけを行う。

再実行の注記は `repeat` からOpenAPIのdescriptionへ出力する。どの操作でもHTTP層は自動再試行せず、タイムアウト・切断で結果が不明な場合は読み取り操作で状態を確認してから再送するよう記載する。

### 8.1 Entity別に引き継ぐルール（Domain Schema・Connectorで既に保証されるもの）

| Entity | 引き継ぐルール | 保証している場所 |
|---|---|---|
| Task | `status: done` 不可、`due` と `recurrence` の同時指定不可、`recurrence` 更新は単独、予約タグ `af-` 不可、`due`/`area` の `null` で解除、`tags` 全置換、完了で繰り返しTaskは次回分へ | Domain refine・`TodoistTaskConnector` |
| Schedule | 操作ごとに異なる（§8.2） | Domain refine・`GoogleCalendarScheduleConnector` |
| Collection | 更新は1項目以上、`status: null` で解除、`tags` 全置換、`metadata` shallow merge、`append_note` 末尾追記、カンマ不可 | Domain refine・`NotionCollectionConnector` |
| Knowledge | 同名不上書き、追記はFrontmatter・既存本文を変えない、保存範囲・パス検証・壊れたFrontmatter | `ObsidianKnowledgeConnector`・`FilesystemVaultStorage` |
| Project / Area | 読み取り専用、アクセス境界、ネスト上限・非対応Block表現 | 各Connector |
| Life Log | 同日・同タイトル不上書き、ID形式、本文へ見出し等を自動追加しない | `ObsidianLifeLogConnector`・`FilesystemLifeLogStorage` |

### 8.2 Scheduleの操作別の制約

| 操作 | `start` / `end` | 日付・日時の種別 | 前後関係 | 検証する層 |
|---|---|---|---|---|
| `schedule_list` | 両方必須 | 混在可（例：`start=2026-11-01&end=2026-11-01T18:00:00+09:00`）。日付は `defaults.timezone` で解釈し、日付の `end` はその日の終わりまで | 同じ種別どうしはDomain refine、混在時はConnector（`toTimeRange`）がtimezoneで解釈して検証 | HTTP（Zod：必須・形式・同種の前後）、Connector（混在時の前後） |
| `schedule_create` | `start` 必須、`end` 省略可（時刻予定は1時間、終日は1日） | 指定するなら同じ種別 | `end` は `start` 以降。終日の `end` は当日を含む | HTTP（Zod refine） |
| `schedule_update` | どちらも省略可。片方だけなら他方は現予定の値を維持 | 両方指定なら同じ種別。片方だけなら現予定と同じ種別（時刻予定⇔終日の切り替えは両方必要） | 両方指定ならDomain refine。片方だけならConnector（`mapping.ts`）が現予定と組み合わせて検証 | HTTP（Zod：1項目以上・両方指定時の種別と前後）、Connector（片方指定時） |

共通：`description` / `location` は `null` で消去（createでは省略と同じ）、`calendar` は更新bodyにない（strictで400）、書き込み先Calendarの単発予定のみ更新、繰り返し予定・招待された予定・Calendar間移動・削除は扱わない。

---

## 9. 入力の読み取り

### 9.1 body

- 全POST・PATCHの `request.body` に `required: true` と `application/json` のみを宣言する（`task_complete` はbodyなし）。
- `hono/body-limit` で1 MiBを超えるbodyを413にする（D6）。

### 9.2 query（`src/http/schemas.ts`）

```ts
const toArray = (value: unknown) => (typeof value === 'string' ? [value] : value);
export const queryArray = <T extends z.ZodType>(item: T) => z.preprocess(toArray, z.array(item));
```

| 操作 | query Schema |
|---|---|
| `task_list` | `z.strictObject({ ...TaskListFilterSchema.shape, status: queryArray(ActiveTaskStatusSchema).optional(), tags: queryArray(…).optional() })` |
| `collection_search` | `CollectionSearchFilterSchema` の `tags` を `queryArray` に置換 |
| `knowledge_search` | `tags` を `queryArray`、`area` を `none` → `null` のpreprocessにし、OpenAPIは `.openapi({ enum: ['work','personal','none'] })` で上書き（D3） |
| `schedule_list` / `project_list` / `area_list` | Domain Schemaをそのまま使う |
| `knowledge_get` / `project_get` | `KnowledgeGetInputSchema` / `ProjectGetInputSchema`（`{ id }`） |
| `knowledge_append` | query `KnowledgeGetInputSchema`、body `KnowledgeAppendInputSchema.omit({ id: true })` |

空の値（`?query=`）は既存の `min(1)` / NonBlankで400になる。

### 9.3 ID

| ID | 渡し方 | 予約文字の扱い |
|---|---|---|
| `todoist:<id>` / `notion:<page-id>` | path | `:` を含む。`encodeURIComponent` で渡す |
| `google_calendar:<calendar-id>:<event-id>` | path | Calendar IDの `@` `#` を `%40` `%23` で渡す |
| `lifelog:<ファイル名>` | path | 日本語・空白・`%` を含み得る。`/` は含まない（含む値はConnectorが400） |
| `obsidian:<vault-relative-path>` / `github:<owner>/<repository>` | query `id` | `/` を含む。`+` は空白として解釈されるため `%2B` で渡す |

- HTTP層はIDを1回だけデコードし（Hono）、その文字列を既存のID parser（`parseLifeLogId`、Obsidianの `id.ts`、`github/id.ts`、`notion/id.ts`、Google Calendarの `parseScheduleId`）へ渡す。HTTP層では正規化・再デコードをしない。
- 保存範囲外の拒否（`..`、絶対パス、`\`、制御文字、symlink・junction、Windowsの代替データストリーム）は既存のConnector・Vault境界が担う。§14のAC-05テストで、HTTP経由でもこれらが400になり範囲外のファイルを読まないことを確認する。
- ルート衝突：`/v1/knowledge/entry` と `/v1/knowledge/entry/append` は固定セグメントで、`{id}` を持つRouteは `/v1/tasks/{id}` 等の末尾または `/{id}/complete` `/{id}/append` のみ。`%2F` は1セグメントのままroutingされるため（§1）、IDの内容でRouteが変わらない。

---

## 10. OpenAPI生成

- `app.getOpenAPI31Document()` でOpenAPI 3.1.0を生成する。全Route登録後にアプリ生成時に1回だけ生成して保持し、`GET /openapi.json`（認証対象、Route定義には載せない）で返す。
- `info`：title `AI Foundation`、version `1.0.0`（`/v1` のAPI版）、descriptionは `src/instructions.ts` の `INSTRUCTIONS`（Entity・Source of Truthの説明）＋HTTP共通の注意（IDのエンコード、日付形式、再試行、タイムアウト時に結果を推測しないこと）。
- `components.securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer' }`、document全体に `security: [{ bearerAuth: [] }]`。
- 各operation：`operationId`（Tool名）、`summary`（`title`）、`description`（共有の説明文＋`repeat` から作る再実行の注記＋HTTP固有の注記）、`tags`（Entity名）、request（path / query / body）、成功レスポンス（Output Schema）、エラーレスポンス（共通 `Error` component）。
- エラーレスポンスの宣言：全operationに400・401・500・502・503、IDを受けるoperationに404、`knowledge_create` / `lifelog_create` に409、bodyを受けるoperationに413。
- Component名をHTTP層で付与する：`Task`、`Schedule`、`CollectionItem`、`Knowledge`、`KnowledgeSearchResult`、`Project`、`GitHubProjectDetails`、`Area`、`LifeLog`、`Error`、各入力body。
- refineで表す項目間の制約（`due` と `recurrence`、更新は1項目以上、日付と日時の混在等）は、共有の説明文に既に書かれている文言で示し、実行時は同じrefineで検証する。
- `servers` は設定しない（配置先が決まる後続工程で追加）。
- 確認・差分用に `npm run openapi`（`scripts/openapi.ts`：configを読み、APIキー・ネットワークなしでdocumentをstdoutへ出力）を追加する。生成物はコミットしない。

---

## 11. 起動・設定・終了（`src/serve-http.ts`）

| 項目 | 内容 |
|---|---|
| npm script | `dev:http`（`tsx src/serve-http.ts`）、`start:http`（`node dist/serve-http.js`） |
| 引数 | `--config <path>`、`--no-env-file`（stdioと同じ）、`--host <host>`、`--port <port>` |
| 環境変数 | `AI_FOUNDATION_API_KEY`（必須、D9）、`AI_FOUNDATION_HTTP_HOST`（既定 `127.0.0.1`）、`AI_FOUNDATION_HTTP_PORT`（既定 `8787`）、`AI_FOUNDATION_CONFIG`（既存） |
| 優先順位 | 引数 > 環境変数 > 既定値。portは0〜65535の整数（0は空きport、テスト用） |
| 起動順 | 引数解析 → `.env` → **APIキー検証**（失敗なら理由をstderrに出して `exit(1)`、configを読む前） → `buildContext` → `createHttpApp` → `@hono/node-server` の `serve` |
| ログ | stderrに `[ai-foundation] HTTP server listening on http://<host>:<port>`。hostがloopback以外なら「HTTPS終端の後ろで公開すること」を併記する |
| 失敗 | `EADDRINUSE` 等のlisten失敗、`ConfigError` は理由を出して `exit(1)` |
| 終了 | SIGINT / SIGTERMで新規接続を止めて `server.close()`、10秒で強制終了 |
| MCP | `src/index.ts` はAPIキーを読まない。stdio e2eテストでキー未設定のまま起動することを確認する |

CORSとRate Limitは設けない（サーバー間通信のみを想定。配置時に再検討する）。

---

## 12. 追加・変更予定ファイル

### 12.1 Source

| File | 種別 | 内容 |
|---|---|---|
| `package.json` / `package-lock.json` | 変更 | dependencies `hono` `@hono/node-server` `@hono/zod-openapi`、devDependencies `ajv` `ajv-formats` `@seriousme/openapi-schema-validator`、scripts `dev:http` `start:http` `openapi` |
| `src/errors.ts` | 変更 | `MissingCredentialError`、`ConflictError`、`FoundationErrorCode` 追加（§6.1）、`MessagePart` / `providerText` / `errorText` / `publicMessage`（§6.3） |
| `src/credentials/env.ts` | 変更 | `MissingCredentialError` |
| `src/connectors/github/client.ts` | 変更 | 1か所を `MissingCredentialError` |
| `src/connectors/google-calendar/client.ts` / `notion/client.ts` / `todoist/client.ts` / `todoist/connector.ts` / `notion/connector.ts` | 変更 | 外部由来の文を `providerText` / `errorText` で組み立てる（§6.3の12か所。MCPのメッセージは不変） |
| `src/connectors/obsidian/filesystem-storage.ts` / `filesystem-lifelog-storage.ts` / `storage.ts` / `lifelog-storage.ts` | 変更 | `ConflictError` |
| `src/domain/task.ts` / `schedule.ts` / `collection.ts` | 変更 | Update Schemaの分割（§5） |
| `src/operations/types.ts` / `index.ts` / `task.ts` / `schedule.ts` / `collection.ts` / `knowledge.ts` / `project.ts` / `area.ts` / `lifelog.ts` | 新規 | 操作定義（§4.1） |
| `src/tools/*.ts`（7 Entity）/ `src/tools/index.ts` | 変更 | operationsを参照（§4.2） |
| `src/startup.ts` | 新規 | 起動の共通部分（§4.3） |
| `src/index.ts` | 変更 | `startup.ts` を使う（挙動不変） |
| `src/http/app.ts` | 新規 | `createHttpApp({ config, connectors, apiKey })`：`OpenAPIHono`、`defaultHook`、body上限、認証、Route登録、`/openapi.json`、`onError`、`notFound` |
| `src/http/auth.ts` | 新規 | Bearer認証（§7） |
| `src/http/errors.ts` | 新規 | 例外→HTTP変換（§6.2） |
| `src/http/schemas.ts` | 新規 | `ErrorResponseSchema`、`queryArray`、body / query Schema、Component名、エラーレスポンス宣言helper |
| `src/http/openapi.ts` | 新規 | document設定、再実行の注記文、HTTP共通の説明 |
| `src/http/routes/{task,schedule,collection,knowledge,project,area,lifelog}.ts` / `index.ts` | 新規 | Route定義（§8） |
| `src/serve-http.ts` | 新規 | HTTP起動口（§11） |
| `scripts/openapi.ts` | 新規 | OpenAPIをstdoutへ出力 |

Connectorの処理本体、`src/config/schema.ts`、`config.yaml` は変更しない。

### 12.2 Tests

| File | 種別 | 内容 |
|---|---|---|
| `tests/helpers/http.ts` | 新規 | `createTestApp(connectors, config?)`（固定テスト用キー）、`call(method, path, { query, body, key })`、OpenAPI documentとAjvによるレスポンス検証helper |
| `tests/http/routes.test.ts` | 新規 | AC-01 |
| `tests/http/auth.test.ts` | 新規 | AC-02 |
| `tests/http/rules.test.ts` | 新規 | AC-04 |
| `tests/http/ids.test.ts` | 新規 | AC-05 |
| `tests/http/errors.test.ts` | 新規 | AC-06 |
| `tests/http/openapi.test.ts` | 新規 | AC-07 |
| `tests/startup/http-options.test.ts` | 新規 | 引数・環境変数・APIキー検証の単体テスト |
| `tests/e2e/http.test.ts` | 新規 | AC-03（実プロセス起動） |
| `tests/e2e/stdio.test.ts` | 変更 | `CREDENTIAL_VARS` に `AI_FOUNDATION_API_KEY` を追加（キーなしでMCPが起動することを保証） |
| `tests/credentials/env.test.ts` | 変更 | `MissingCredentialError` であることを追加で確認 |
| `tests/connectors/obsidian/filesystem-storage.test.ts` / `filesystem-lifelog-storage.test.ts` / `lifelog-connector.test.ts` / `vault-directory.test.ts`、`tests/tools/lifelog.test.ts` | 変更 | 同名衝突の期待クラスを `ConflictError` に（D1。メッセージの期待値は不変） |
| `tests/errors.test.ts` | 新規 | `MessagePart` の連結、`string` だけのErrorで `message === publicMessage`、`errorText` の入れ子 |
| `tests/errors-provider-text.test.ts` | 新規 | `src/connectors/**` に外部由来の文の直接埋め込みがないことの走査（§6.3） |
| `tests/connectors/{google-calendar,notion,todoist}/*.test.ts` | 変更 | 既存のメッセージ期待値はそのまま。12か所それぞれでSDK例外の `message` に秘密文字列を入れ、`message` には含まれ `publicMessage` には含まれないことを追加 |
| `tests/domain/task.test.ts` / `schedule.test.ts` / `collection.test.ts` | 変更なし | 分割後も同じissueになることの回帰 |

### 12.3 Documentation

| File | 内容 |
|---|---|
| `docs/specs/rest-api.md` | 新規。REST APIの仕様（エンドポイント、認証、共通仕様、エラーcode表、IDの渡し方、起動方法） |
| `README.md` | 「REST API」節：起動方法、環境変数、ランダムなAPIキーの生成例（`.env.example` と同じコマンド）、curl例、`/openapi.json` の取得、HTTPS終端が必要なこと |
| `.env.example` | `AI_FOUNDATION_API_KEY`（生成例 `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`）、`AI_FOUNDATION_HTTP_HOST`、`AI_FOUNDATION_HTTP_PORT` |
| `AGENTS.md` | Layer表に Operations（MCP・HTTP共通の操作定義）とHTTP（REST API。認証・入出力・エラー変換）を追加 |

---

## 13. 実装順序

各ステップの終わりに `npm run typecheck` と `npm test` を通す。

1. **Branch・依存**：`feat/rest-api` を作成し、§12.1の依存を追加。`npm ls zod` で重複がないことを確認。
2. **Error**：§6.1を実装し、既存テストの期待クラスを更新（D1・D2）。続けて§6.3の `MessagePart` と12か所の組み立てを変更し、既存Connectorテストのメッセージ期待値が無変更で通ること・走査テストが通ることを確認する。
3. **Domain分割**：§5。既存のDomain・Tool・Connectorテストが無変更で通ること。
4. **Operations**：`src/operations/` を作り、7 EntityのToolを置き換える。既存のTool・Server・stdio e2eテストが無変更で通ること（MCP回帰の確認点）。
5. **HTTP基盤**：`errors.ts` → `auth.ts` → `schemas.ts` → `openapi.ts` → `app.ts`（Routeなし・`/openapi.json` のみ）。`auth.test.ts` と `errors.test.ts` の基盤部分を書く。
6. **Route**：Task → Schedule → Collection → Knowledge → Project → Area → Life Log の順に、Routeと `routes.test.ts` / `rules.test.ts` の該当部分を追加。
7. **ID境界**：`ids.test.ts`（Fake Connectorと一時Vault上の実Obsidian Connector）。
8. **OpenAPI検証**：`openapi.test.ts`、全HTTPテストのレスポンスをAjvで検証するhelperを有効化。
9. **起動口**：`src/startup.ts` 抽出 → `src/serve-http.ts` → `http-options.test.ts` → `tests/e2e/http.test.ts`。
10. **Script・Documentation**：`scripts/openapi.ts`、§12.3。
11. **最終確認**：`npm run typecheck` / `npm run build` / `npm test`、`npm run start:http` でbuild成果物が起動すること。

---

## 14. Automated Test

### 14.1 方針

- 通常のテストは実サービスへ接続しない。HTTPテストはHonoの `app.request()` で行い、ネットワークを使わない（AC-03のe2eのみloopbackでlistenする）。
- Connectorは `tests/helpers/fake-connectors.ts` を使う。Knowledge・Life Logのファイル境界は一時Vault上の実Connectorで確かめる。
- 成功・失敗レスポンスはすべて、生成したOpenAPI documentの該当operation・statusのSchemaでAjv（2020-12、`ajv-formats`）検証する。Zod Schemaとは独立に、documentと実際の入出力の一致を確かめるため。

### 14.2 ACごとのテスト

| AC | テスト | 確認内容 |
|---|---|---|
| AC-01 | `routes.test.ts` | 21操作の表（§8）をデータとして持ち、各操作について Method・Path・成功status（201 / 200）、payloadがFakeの戻り値と一致、Fakeが受け取ったDomain入力が期待どおり（path / query / bodyの組み立て）。documentのoperationIdの集合が `OPERATION_NAMES` と `TOOL_NAMES` に一致 |
| AC-02 | `auth.test.ts` | header なし・`Basic`・空token・不一致・長さ違い・前後に余分な文字 → 401 共通JSON＋`WWW-Authenticate`。21操作すべてでFakeの `calls` が空のまま。`bearer`（小文字）は通る。`/openapi.json` はキーなし401・ありで200。存在しないpathもキーなしなら401（404ではない） |
| AC-03 | `tests/e2e/http.test.ts`、`http-options.test.ts` | キー未設定・空白のみ・31文字・非ASCIIで、`src/serve-http.ts` が `AI_FOUNDATION_API_KEY` を含む理由をstderrに出して終了コード1、listenしない。キーありで `--port 0` 起動 → ログからportを取得 → `/openapi.json` がキーありで200・なしで401 → 終了。引数 > 環境変数 > 既定値、不正port。stdio e2eはキー未設定のまま既存テストが通る |
| AC-04 | `rules.test.ts`（＋既存のDomain・Connector・Toolテスト） | Task：PATCHの省略項目がDomain入力に現れない、`due: null` / `area: null` がnullで届く、`tags` が置換値で届く、`recurrence` と他項目の同時指定・`due`+`recurrence` の作成・`status: done`・`af-` タグ・空bodyは400でConnector未呼び出し、繰り返しTaskの完了は未完了の次回Taskを200で返す。Schedule（§8.2の操作別）：list は `start`/`end` の欠落が400、同種の逆順が400、**日付と日時の混在は200でそのままConnectorへ届く**、混在時の逆順はConnector由来の400（実Connector＋Fake Calendar APIで確認）。create は `end` 省略が201で `end` なしのまま届く、種別の混在・逆順が400。update は `start` だけ・`end` だけが200で片方だけ届く、両方指定の混在・逆順が400、空bodyが400、片方指定で現予定と矛盾する場合はConnector由来の400（実Connector＋Fake Calendar API）。共通で `description: null` がnullで届く、bodyの `calendar` は400。Collection：`tags: []`、`metadata` のshallow merge結果（`mergeMetadata` を使うFake）、`append_note` のみ、`append_note: null` のみは400。Knowledge：`area` 省略で既定area・`null` でnull、一時Vaultで同名作成が409かつ既存ファイル不変、追記がFrontmatter・既存本文を変えない、`?area=none` がnullで届く。Life Log：一時Vaultで同日同タイトルが409かつ不変、追記が段落として末尾に付く |
| AC-05 | `ids.test.ts` | 往復：日本語・空白・`/`・`%`・`#`・`+`・`@` を含むID（`obsidian:AI_Foundation/Knowledge/日本語 メモ/a+b%.md`、`lifelog:2026-10-03-東京 散策 100%.md`、`google_calendar:ja.japanese#holiday@group.v.calendar.google.com:abc`、`github:owner/repo`）を `encodeURIComponent` で渡し、Fakeが同一文字列を受け取る。`%252F` は `%2F` のまま届く（二重デコードしない）。境界：一時Vaultに範囲外のsentinelファイルを置き、`lifelog:..%2F..%2Fx.md`、`lifelog:` に `\`・制御文字・`:` を含むもの、`obsidian:../x.md`・絶対パス・`\` 区切りが400で、レスポンスにsentinelの内容・Vaultの絶対パスが含まれない |
| AC-06 | `errors.test.ts` | §6.2の各行：Fakeの `failWith` に各例外を設定して status・`error.code`・`message` を確認。`MissingCredentialError` は503 `credential_missing`、Providerの拒否 `CredentialError` は502 `provider_auth_failed`。Connector未設定（`connectors: {}`）は503。実 `EnvCredentialProvider`（空env）と実Connectorで503（ネットワーク前に失敗）。`new Error('secret-value')`（stackと `cause` に秘密を含む）は500で、bodyに `secret-value`・`stack`・`at `・例外名が含まれない。`FoundationError` の `cause` に入れた値もbodyに出ない。**実際の変換経路での秘密文字列**：実Connectorに秘密文字列入りのmessageを持つSDK例外を投げるFake client（Todoist・Notion・Google Calendar）を渡し、各 `toFoundationError` の分岐と、Taskの作成ロールバック失敗・復元失敗・完了後の読み戻し失敗、Collectionの追記失敗を起こす。HTTPレスポンスに秘密文字列が含まれず、対象ID・「may still exist」・「do not call task_create again」等の案内は含まれることを確認する。不正JSON・`text/plain`・1 MiB超・未知route。変換表が全 `FoundationErrorCode` を網羅することの型・実行時確認 |
| AC-07 | `openapi.test.ts`（＋全HTTPテストのAjv検証） | documentが `@seriousme/openapi-schema-validator` でOpenAPI 3.1として妥当。21 operationについて method・path・operationId・summary・description（再実行の注記を含む。`task_update` は `recurrence`、`collection_update` は `append_note` で性質が変わることを含む）・`security`・成功status・宣言したエラーstatus・`Error` component参照を確認。必須項目：path `id`・query `id`・`schedule_list` の `start`/`end` が `required`、bodyの `required` 配列がDomainの必須項目と一致。配列queryが `type: array`、`area` に `none`。項目間制約の説明文（例：`due` と `recurrence`）がdescriptionに含まれる。実際の入出力はAjvで照合 |
| AC-08 | 全体 | `npm run typecheck` / `npm run build` / `npm test`。既存テストの変更は、D1・D2に伴う期待クラスの更新、D11の `publicMessage` の追加検証、`CREDENTIAL_VARS` の追加だけであること（既存のメッセージ期待値は変えない） |

---

## 15. 実接続での確認（記録のみ）

自動テストとは分けて、実施日・環境（ローカルWindows、Node版、configの種別）・結果を本Planの「実装で確定した事項」に記録する。ローカルHTTPでの確認だけでクラウド化の完了とは判定しない。

1. 実 `.env` で `npm run start:http`、curlで `GET /openapi.json`、`task_list`、`project_list`、`area_list`、`schedule_list`。
2. テスト用データで `task_create` → `task_update` → `task_complete`、`knowledge_create` を2回（2回目409）、`lifelog_create` → `lifelog_append` → `lifelog_get`。作成したデータは手動で削除する。
3. 外部サービスの認証失敗（無効なトークン）で502 `provider_auth_failed`、トークン未設定で503 `credential_missing`。

---

## 16. 懸念点 / 未確定事項

### Q1. 説明文は英語のままMCPと共有する

既存のTool説明はAIクライアント向けの英語で、operationIdをTool名にすることで他操作への参照もそのまま成り立つ（D8）。HTTP固有の注記（IDの渡し方・再実行）だけを追記する。

### Q2. 未知のquery parameterを400にする

MCPの `strictObject` と同じ挙動にする（D7）。接続先クライアントが独自のqueryを付ける場合は、実接続検証の段階で個別に許可する。

### Q3. `task_complete` の再実行時の挙動

完了済みの単発Taskを再度完了したときのTodoistの応答（成功・404等）は本Planでは確定しない。OpenAPIでは「自動再試行しない。結果が不明なら `task_list` で確認する」と記載する。
