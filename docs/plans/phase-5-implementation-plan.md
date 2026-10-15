# Phase 5: Project — Implementation Plan

- Status: **rev.2（Plan Review完了・User承認済み）**
- 作成: Coding Agent (Claude Code) / 2026-10-15（rev.2: 2026-10-16 PR #8 レビュー反映）
- 対象: [Phase 5 Design Issue](../specs/phase-5-project.md)
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Phase 1 Design Issue](../specs/phase-1-foundation.md), [Phase 2 Design Issue](../specs/phase-2-task-schedule.md), [Phase 3 Design Issue](../specs/phase-3-collection.md), [Phase 4 Design Issue](../specs/phase-4-knowledge.md), [Phase 4 Implementation Plan](phase-4-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

ChatGPTによるPlan Review（PR #8、rev.2でOK）は完了し、User承認済み。実装は `main` から作成する `feat/phase-5-project` で行う。仕様に明記がなく本Planで決めた箇所は [§29 懸念点 / 未確定事項](#29-懸念点--未確定事項) にQとしてまとめている（rev.2時点でQ1〜Q11はすべて判断済み）。レビュー指摘への対応は [§30 Review対応履歴](#30-review対応履歴) を参照。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/phase-5-implementation-plan`。Baseは `main` の `3e14d4a docs: align MVP with Phase 5 project design`（Phase 4実装 PR #7 のMerge `f416102` 後に、Phase 5 Design Issue追加 `926e0bf` とMVP仕様のPhase 5整合 `3e14d4a` がコミット済み） |
| Repository | `thanatos27/ai-foundation`（**Public**） |
| ローカル環境 | Windows 11 / Node.js v24.20.0。`package.json#engines` は `{ node: ">=24", npm: ">=11" }`（グローバル `fetch` が利用可能） |
| 依存 | `@modelcontextprotocol/server ^2.3.1`, `zod ^4.6.7`, `yaml ^2.9.1`, `@doist/todoist-sdk`, `@googleapis/calendar`, `google-auth-library`, `@notionhq/client`。**GitHub関連の依存はない** |
| 公開Tool | 13件（`task_*` 4件 / `schedule_*` 2件 / `collection_*` 3件 / `knowledge_*` 4件） |

### Phase 4までの実装の要点（Phase 5で利用・変更するもの）

| File | 現状 |
|---|---|
| `src/domain/project.ts` | `ProjectSourceSchema = enum(['github', 'google_drive'])` と `ProjectSchema { id?, type, title, source, external_ref }` のみ。Tool Input / Result Schemaはない |
| `src/errors.ts` | `FoundationError` と5分類（`InputValidationError` / `CredentialError` / `NotFoundError` / `ProviderApiError(provider, message)` / `ConfigurationError`）。**変更不要** |
| `src/credentials/types.ts`, `env.ts` | `CredentialProvider { getTodoistApiToken, getGoogleOAuthCredentials, getNotionApiToken }`。`EnvCredentialProvider.require()` は未設定の変数名だけをMessageに含め、値は含めない |
| `src/config/schema.ts` | `sources.project = strictObject({ providers: ProjectSourceSchema[].min(1) })` が **既に存在**。strictのためProject一覧等は書けない（`tests/config/schema.test.ts` に拒否Testあり） |
| `config.yaml` | `project.providers` に `github` と `google_drive` を列挙 |
| `src/connectors/types.ts`, `index.ts` | `Connectors { task?, schedule?, collection?, knowledge? }`。`createConnectors(config, credentials)` は何も接続せず、Credential取得・Client生成をTool呼び出し時まで遅延する（`lazyNotionClient` 等） |
| `src/connectors/notion/client.ts` | SDK ClientのInterfaceを最小限に `Pick` し、Testでは Fake を注入。`lazyNotionClient` はCredential取得失敗時に次回再試行。`toFoundationError` でHTTP Error → Foundation Errorに変換し、Messageに Token / Headerを含めない。Phase 5も同じ形にする |
| `src/tools/*.ts` | `register<Entity>Tools(server, context)`、Connector未設定時は `ConfigurationError`、`jsonResult()` で `structuredContent` + JSON textを返す。`knowledge.ts` はConfigのprovider判定をTool側で行う |
| `src/instructions.ts` | ProjectのSoTを「GitHub / Google Drive」と記載（MVP §15どおり） |
| `.env.example` | `# GITHUB_TOKEN=` が「Phase 5 and later (not used yet)」としてコメントで予約されている |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 13件を前提とするAssertion。e2eは `CREDENTIAL_VARS` を子プロセス環境から削除して実Providerへ到達しないようにしている |
| `tests/domain/project.test.ts` | 現行 `ProjectSchema` のTestのみ |
| `tests/integration/setup.ts` | `AI_FOUNDATION_INTEGRATION=1` でのみ実行。`.env` と `config.local.yaml` を読む。`hasEnv` / `runLabel` を提供 |

---

## 2. 設計方針

1. **Phase 1〜4の構造をそのまま使う。** Tool → `ToolContext.connectors.project` → `GitHubProjectConnector` → `GitHubClient`（HTTP）。
2. **Discovery集合 = アクセス境界。** `project_list` が返す集合（`GET /user/repos`）と `project_get` で取得できる集合を一致させる。`project_get` はexact IDで直接取得したうえで、そのRepositoryがDiscovery集合に含まれることを確認する（§11.1）。これによりFine-grained PATのRepository選択がそのままPhase 5のアクセス境界になる。
3. **GitHubが唯一の正本。** Project Registry / Cache / Index / allowlistを持たない。`project_list` / `project_get` は毎回GitHub APIを呼び、Process内にもResponseを保持しない（Credentialを持つClient instanceのMemoizeのみ）。
4. **構造的にRead-only。** `GitHubClient` Interfaceは「Repository一覧の全件取得」「Repository 1件取得」の2メソッドだけを持ち、HTTP Methodは `GET` 固定。書き込みAPIを呼ぶコードパスを作らない。
5. **SDKを使わず `fetch` で薄く実装する。** 必要なEndpointは2つだけで、Pagination（Link Header）・Redirect・Error分類・Header（Token）の扱いを自前で明示的に制御したいため（§23、Q2）。
6. **明示したFieldだけを取り出す。** GitHub API ResponseはZodで必要Fieldだけparseし、Domain / Detailsへ手で詰め替える。Response全体や未知Fieldを返さない（`temp_clone_token`、`permissions` 等を含め得るため）。
7. **Secretを外へ出さない。** Tokenは `Authorization` Headerにのみ載せ、Error Message / `cause` / Log / Tool Resultへ入れない。Token送信先は `https://api.github.com` のみに限定する（Pagination / RedirectのURLも検証、§21）。
8. **起動時にGitHubへアクセスしない。** Credential取得・API呼び出しはTool呼び出し時（Phase 2〜4方針）。
9. **独自Retry / Sleepを持たない。** Rate Limit・5xxは即 `ProviderApiError`。応答待ちが無限にならないよう、1 Requestごとのtimeoutのみ設ける（Retryではない）。

---

## 3. Phase 4までの実装への変更点（概要）

| 対象 | 変更 | 理由 |
|---|---|---|
| `domain/project.ts` | Tool Input（`ProjectListFilterSchema` / `ProjectGetInputSchema`）、ID必須の `ProjectResultSchema`、`GitHubProjectDetailsSchema`、`ProjectGetResultSchema` を追加。既存 `ProjectSchema` は変更しない | Phase 5 §Project Domain / 各Tool |
| `credentials/types.ts`, `env.ts` | `getGitHubToken()` を追加（`GITHUB_TOKEN`） | Phase 5 §Authentication |
| `connectors/types.ts` | `ProjectConnector { list, get }`、`Connectors.project?` を追加 | Connector境界 |
| `connectors/index.ts` | `GitHubProjectConnector` + `lazyGitHubClient` を生成 | 配線 |
| `tools/index.ts` | `registerProjectTools` を呼ぶ | Tool公開 |
| `config.yaml` | `project.providers` から `google_drive` を外し `github` のみにする（Q6） | Phase 5ではGitHubのみ実装。Phase 4でknowledgeの `google_drive` を外した前例に合わせる |
| `.env.example` | `GITHUB_TOKEN=` を有効な項目として記載（Fine-grained PAT推奨のコメント付き） | Phase 5 §Authentication |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 13件 → 15件。e2eの `CREDENTIAL_VARS` に `GITHUB_TOKEN` を追加 | Tool公開、実APIへ到達させない |
| `tests/domain/project.test.ts`, `tests/credentials/env.test.ts` | 追加Schema・`getGitHubToken` のTest | Domain / Credential変更 |
| `README.md` | Current Phase、Tool一覧、GitHub Token Setup、Directory Structure、Documentation | 利用手順 |

**変更しないもの**: `src/errors.ts`、`src/config/schema.ts`（`sources.project.providers` は既存のまま使う。コメント追記のみの可能性あり）、`src/instructions.ts`（MVP §15の文面。ProjectのSoT「GitHub / Google Drive」はMVPの論理定義どおり）、`src/domain/task.ts`（`project_ref` との関連付けはPhase 5対象外）、Task / Schedule / Collection / Knowledge関連。

---

## 4. 追加・変更予定ファイル

### 4.1 Source

| File | 種別 | 責務 |
|---|---|---|
| `src/domain/project.ts` | 変更 | §5 |
| `src/credentials/types.ts` | 変更 | `getGitHubToken(): Promise<string>` |
| `src/credentials/env.ts` | 変更 | `GITHUB_TOKEN` の読み取り |
| `src/connectors/types.ts` | 変更 | `ProjectConnector`、`Connectors.project?` |
| `src/connectors/index.ts` | 変更 | GitHub Connectorの生成 |
| `src/connectors/github/client.ts` | 新規 | `GitHubClient` Interface、`fetch` 実装（`createGitHubClient`）、`lazyGitHubClient`。Header付与、Pagination、Redirect、timeout、Origin検証。**Tokenに触れるのはこのファイルだけ** |
| `src/connectors/github/errors.ts` | 新規 | HTTP Status / Header / 例外 → Foundation Error変換（Rate Limit判定、Message生成）。純粋関数 |
| `src/connectors/github/id.ts` | 新規 | `github:<owner>/<repository>` のparse / format（純粋関数） |
| `src/connectors/github/mapping.ts` | 新規 | GitHub Repository ResponseのZod Schema（必要Fieldのみ）、Repository → `Project` / Details Mapping（純粋関数） |
| `src/connectors/github/filter.ts` | 新規 | query / owner照合、重複除去、stable sort（純粋関数） |
| `src/connectors/github/connector.ts` | 新規 | `GitHubProjectConnector`。ID検証、Client呼び出し、Mapping・Filter・Sortの適用 |
| `src/tools/project.ts` | 新規 | `project_list` / `project_get` の登録、`providers` 判定 |
| `src/tools/index.ts` | 変更 | `registerProjectTools` 呼び出し |

### 4.2 Tests

| File | 種別 | 内容 |
|---|---|---|
| `tests/domain/project.test.ts` | 変更 | Input / Result Schema |
| `tests/credentials/env.test.ts` | 変更 | `getGitHubToken`（設定 / 未設定 / 空白のみ、Messageに値を含まない） |
| `tests/connectors/github/id.test.ts` | 新規 | ID parse / format / 拒否パターン |
| `tests/connectors/github/mapping.test.ts` | 新規 | Project / Details Mapping、visibility、不要Field除外、不正Response |
| `tests/connectors/github/filter.test.ts` | 新規 | query / owner / AND / 重複除去 / sort |
| `tests/connectors/github/errors.test.ts` | 新規 | Status → Error分類、Rate Limit Message |
| `tests/connectors/github/client.test.ts` | 新規 | Fake `fetch` でHeader・Pagination・Redirect・Error・timeout・Credential漏洩防止 |
| `tests/connectors/github/fake-client.ts` | 新規 | Fake `GitHubClient`（Repository配列 / Errorを注入） |
| `tests/connectors/github/connector.test.ts` | 新規 | Fake GitHubClientで list / get / rename / Error伝播 |
| `tests/helpers/fake-connectors.ts` | 変更 | `FakeProjectConnector` |
| `tests/tools/project.test.ts` | 新規 | Fake ConnectorでTool Layer |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 変更 | Tool 15件、Token未設定時の `project_list` がCredential Error |
| `tests/integration/github.integration.test.ts` | 新規 | 実GitHub APIへのRead-only Integration Test（手動起動、§25） |

### 4.3 Project設定 / Documentation

| File | 変更 |
|---|---|
| `config.yaml` | §10 |
| `.env.example` | §9 |
| `README.md` | §3 |
| `vitest.integration.config.ts`, `tests/integration/setup.ts` | Commentの対象サービス列挙にGitHubを追加（挙動は変更なし） |
| `docs/plans/phase-5-implementation-plan.md` | 本Plan。実装後に「実装・Integration Verificationで確定した事項」を追記する |

---

## 5. Project Domain / Tool Input / Tool Result Schema

Schemaはすべて `src/domain/project.ts` に置く。Provider固有のID形式（`github:<owner>/<repo>`）の検証はConnector（`id.ts`）で行い、Domain Schemaは `min(1)` 程度に留める（Phase 3・4と同じ分担）。

### 5.1 Entity（既存を維持）

```ts
export const ProjectSchema = z.object({
  id: z.string().min(1).optional(),   // 既存のまま（google_drive等の将来互換）
  type: z.literal('project'),
  title: z.string().min(1),
  source: ProjectSourceSchema,        // github | google_drive（google_driveは予約のまま維持）
  external_ref: z.string().min(1),
});

/** A project returned by a tool: Phase 5 always carries the exact id. */
export const ProjectResultSchema = ProjectSchema.extend({ id: z.string().min(1) });
export type ProjectResult = z.infer<typeof ProjectResultSchema>;
```

### 5.2 Input Schema

```ts
/** Input of `project_list`. Both filters are optional; `{}` lists every repository the token can see. */
export const ProjectListFilterSchema = z.strictObject({
  /** Case-insensitive substring of the repository name, owner/repository or description. */
  query: NonBlankSchema.optional(),
  /** Case-insensitive exact match of the owner login (user or organization). */
  owner: NonBlankSchema.optional(),
});

/** Input of `project_get`: an exact id (`github:<owner>/<repository>`). */
export const ProjectGetInputSchema = z.strictObject({ id: z.string().min(1) });
```

- `NonBlankSchema` は `knowledge.ts` と同じ定義（空白のみを拒否、値はtrimしない）。共通化のため `common.ts` へ移すかは実装時に判断（挙動は同じ）。空文字・空白のみの `query` / `owner` を拒否する点は仕様の `string | undefined` より狭い（Q4）。
- `page` / `cursor` / `limit` は持たない（strictなので渡すとSchema Error）。

### 5.3 Result Schema

```ts
export const GitHubVisibilitySchema = z.enum(['public', 'private', 'internal']);

/** GitHub-specific details of `project_get`, kept apart from the provider-independent project. */
export const GitHubProjectDetailsSchema = z.strictObject({
  description: z.string().nullable(),
  owner: z.string().min(1),
  default_branch: z.string().min(1),
  visibility: GitHubVisibilitySchema,
  archived: z.boolean(),
  fork: z.boolean(),
  updated_at: DateTimeSchema,           // 既存 common.ts（offset / Z 必須のISO 8601）
});

export const ProjectGetResultSchema = z.object({
  project: ProjectResultSchema,
  details: GitHubProjectDetailsSchema,
});

// project_list の outputSchema（tools/project.ts 内）
const ProjectListOutputSchema = z.object({ items: z.array(ProjectResultSchema) });
```

`details` はPhase 5ではGitHub固有Schemaのみ。将来Google Drive Projectを追加する場合は `project.source` で判別するUnionへ拡張する（§28）。

---

## 6. Tool設計（`src/tools/project.ts`）

### 6.1 Provider判定

```ts
/** Phase 5 serves projects from GitHub only, and only while it is enabled in sources.project.providers. */
function githubConnector(config: Config, connectors: Connectors): ProjectConnector {
  if (!config.sources.project.providers.includes('github')) {
    throw new ConfigurationError('the project provider "github" is not enabled in sources.project.providers');
  }
  if (!connectors.project) throw new ConfigurationError('the project source (GitHub) is not configured');
  return connectors.project;
}
```

判定は呼び出しのたびにTool Handler内で行う（Toolは常に登録し、呼び出し時にErrorを返す。Phase 1方針）。判定順は **Config → ID形式 → Credential → GitHub API**。ID形式の検証はConnectorの `get` 冒頭で、Credential取得より前に行う（Token未設定でも不正IDは `InputValidationError`）。

### 6.2 Tool定義

| Tool | inputSchema | outputSchema | annotations |
|---|---|---|---|
| `project_list` | `ProjectListFilterSchema` | `{ items: ProjectResult[] }` | `readOnlyHint: true, openWorldHint: true` |
| `project_get` | `ProjectGetInputSchema` | `ProjectGetResultSchema` | `readOnlyHint: true, openWorldHint: true` |

Description（案。英語、既存Toolと同じ書き方）:

- `project_list`: "List projects: GitHub repositories the configured token can access (1 repository = 1 project). Every filter is optional and narrows the result: query is a case-insensitive substring of the repository name, owner/repository or description; owner matches the owner login (user or organization) exactly, ignoring case. An empty filter lists every repository. Repository names often use '-' instead of spaces, so prefer a single distinctive word as query, or list all and choose. Results are sorted by owner/repository and carry no README or contents: pass the returned id to project_get for details."
- `project_get`: "Get one project by its exact id ("github:<owner>/<repository>", from project_list) with GitHub details (description, owner, default branch, visibility, archived, fork, updated_at). Do not guess ids: find the project with project_list first. If the repository was renamed or transferred, the current id is returned. Only repositories that project_list can return are available; any other repository is reported as not found. README, files, issues and pull requests are not included."

Handler:

```ts
async (filter) => jsonResult({ items: await githubConnector(config, connectors).list(filter) })
async ({ id }) => jsonResult(await githubConnector(config, connectors).get(id))
```

---

## 7. ProjectConnector設計（`src/connectors/types.ts`）

```ts
/** Source of Truth: GitHub (Phase 5). Read-only: projects are discovered from the provider on every call. */
export interface ProjectConnector {
  /** Every project the credential can access that matches `filter`, sorted by canonical owner/repository. */
  list(filter: ProjectListFilter): Promise<ProjectResult[]>;
  /**
   * The project with this exact id and its provider details, as the provider currently resolves it.
   * Only projects that `list` can return are available (the same access boundary); others are not found.
   */
  get(id: string): Promise<ProjectGetResult>;
}

export interface Connectors {
  task?: TaskConnector;
  schedule?: ScheduleConnector;
  collection?: CollectionConnector;
  knowledge?: KnowledgeConnector;
  project?: ProjectConnector;
}
```

Phase 4の `knowledge?: KnowledgeConnector`（Obsidianのみ）と同じく、Phase 5では `project` = GitHub Connector 1つとする。複数Provider化の扱いは §28。

---

## 8. GitHubProjectConnector / GitHubClient設計

### 8.1 層の分担

```text
GitHubProjectConnector (connector.ts)
  ├─ id.ts       parseGitHubProjectId / formatGitHubProjectId
  ├─ filter.ts   matchesFilter / dedupe / sortProjects
  ├─ mapping.ts  GitHubRepositorySchema → Repository record → Project / Details
  └─ GitHubClient (client.ts)  ← Token / HTTP / Pagination / Redirect / timeout
        └─ errors.ts  HTTP status・例外 → Foundation Error
```

### 8.2 GitHubClient Interface（`client.ts`）

```ts
/** The read-only part of the GitHub REST API the connector uses. Tests inject a fake. */
export interface GitHubClient {
  /** Every page of GET /user/repos, as unparsed JSON items. Throws without a partial result if any page fails. */
  listRepositories(): Promise<unknown[]>;
  /** GET /repos/{owner}/{repo}, following GitHub's redirects for renamed / transferred repositories. */
  getRepository(owner: string, repo: string): Promise<unknown>;
}

export type GitHubClientFactory = (token: string) => GitHubClient;

/** Creates the client on first use, so the server starts without GITHUB_TOKEN; retries the lookup after a failure. */
export function lazyGitHubClient(credentials: CredentialProvider, factory = createGitHubClient): () => Promise<GitHubClient>;
```

- `unknown` を返し、parseは `mapping.ts`（Connector側）で行う。Clientは「HTTPとして成功したJSON」までに責務を限定する。
- `createGitHubClient(token, { fetch = globalThis.fetch, timeoutMs = 30_000 })`。Testでは `fetch` を注入する。

### 8.3 HTTP Request（`client.ts` 内部の `request(url)`）

| 項目 | 値 |
|---|---|
| Base URL | `https://api.github.com`（定数。設定可能にしない＝GHESはPhase 5対象外） |
| Method | `GET` 固定 |
| Header | `Authorization: Bearer <token>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`（安定性優先で固定。SDK既定に任せず明示、Notionと同方針。Q8）、`User-Agent: ai-foundation/0.1.0`（GitHub APIは必須） |
| Redirect | `redirect: 'manual'`。`301` / `302` / `307` / `308` の `Location` が `https://api.github.com` Originの場合のみ追従（最大3回）。それ以外のOriginは `ProviderApiError`（Tokenを付けて別Hostへ送らない） |
| timeout | `AbortSignal.timeout(30_000)` / Request。超過は `ProviderApiError`（Retryしない） |
| 成功判定 | `200` のみ成功。Body JSON parse失敗は `ProviderApiError` |
| 失敗 | `errors.ts` の `toFoundationError` で変換（§20） |

### 8.4 GitHubProjectConnector（`connector.ts`）

```ts
export class GitHubProjectConnector implements ProjectConnector {
  constructor(private readonly options: { client: () => Promise<GitHubClient> }) {}

  async list(filter: ProjectListFilter): Promise<ProjectResult[]> {
    const api = await this.options.client();                 // CredentialError here if GITHUB_TOKEN is missing
    const repositories = (await api.listRepositories()).map(parseRepository);  // ProviderApiError on unexpected shape
    return sortProjects(dedupe(repositories.filter((r) => matchesFilter(r, filter)))).map(toProject);
  }

  async get(id: string): Promise<ProjectGetResult> {
    const { owner, repo } = parseGitHubProjectId(id);       // InputValidationError, before any credential / API use
    const api = await this.options.client();
    // 1. Resolve the exact id directly (follows rename / transfer redirects; 404 / 403 -> NotFoundError).
    const repository = parseRepository(await api.getRepository(owner, repo).catch(notFoundAs(id)));
    // 2. Same access boundary as list: the repository must be in the token's discovery set.
    const discovered = (await api.listRepositories()).map(parseRepository);  // any page failure -> ProviderApiError
    if (!discovered.some((r) => r.repositoryId === repository.repositoryId)) throw projectNotFound(id);
    return { project: toProject(repository), details: toDetails(repository) };
  }
}
```

- Connectorは `process.env` もLogも使わない。`warn` も持たない（除外して続行するケースがないため）。
- `get` の境界確認は §11.1。直接取得 → Discovery確認の順に **逐次** 実行する（存在しないIDは1 Requestで `NotFoundError` を返せる。直接取得が成功した場合のみ全件Paginationする）。

---

## 9. GitHub認証 / Credential Provider変更

```ts
// src/credentials/types.ts
export interface CredentialProvider {
  ...
  /** GitHub token (fine-grained personal access token with read-only access recommended). */
  getGitHubToken(): Promise<string>;
}

// src/credentials/env.ts
async getGitHubToken(): Promise<string> {
  return this.require('GitHub', ['GITHUB_TOKEN'])[0];
}
```

- 未設定・空白のみ → `CredentialError: GitHub credential is not configured: set GITHUB_TOKEN`（既存 `require()` の挙動。値はMessageに入らない）。
- **Header値として送れない文字の事前検証**: `createGitHubClient` で Tokenが可視ASCII（`/^[\x21-\x7e]+$/`）以外を含む場合は `CredentialError('GITHUB_TOKEN contains characters that cannot be sent in an HTTP header')` とする。理由: Nodeの `fetch`（undici）は不正なHeader値のErrorMessageに **値そのもの** を含めるため、検証せずに送るとTokenがError Messageへ漏れ得る（§21）。
- `.env.example`: `GITHUB_TOKEN=` を「Phase 5 and later (not used yet)」から `--- Project: GitHub ---` 節へ移し、Fine-grained PAT（Repository access: 対象Repositoryを選択、Repository permissions: Metadata Read-only）を推奨するコメントを付ける。
- `src/index.ts` は変更不要（`new EnvCredentialProvider(process.env)` がそのまま `getGitHubToken` を提供する）。

---

## 10. Configuration変更

### 10.1 Schema（`src/config/schema.ts`）

変更なし。既存の `sources.project = strictObject({ providers: z.array(ProjectSourceSchema).min(1) })` をそのまま使う。

- `providers` に `github` がない（例: `[google_drive]`）場合も起動は成功し、`project_list` / `project_get` は `ConfigurationError`（§6.1）。
- Project一覧・Repository ID・owner allowlist等のKeyはstrictObjectにより起動時Errorのまま（既存Testで担保）。
- Token・Base URL等もConfigに持たない。

### 10.2 `config.yaml`

```yaml
  project:
    # Projects are GitHub repositories the GITHUB_TOKEN can access (1 repository = 1 project).
    # Do not list projects or repositories here; limit them with the token's repository access.
    providers:
      - github
```

`google_drive` を外す提案（Q6）。Schema上は `google_drive` を引き続き受け付ける（将来互換）。`tests/config/schema.test.ts` の既存fixture（`['github', 'google_drive']`）は引き続き通ることを確認する。

---

## 11. GitHub Repository Discovery方式

`GET /user/repos` を使う。

```text
GET https://api.github.com/user/repos?per_page=100&visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&direction=asc
```

| Parameter | 理由 |
|---|---|
| `per_page=100` | 利用可能な最大Page Size（仕様 §Pagination） |
| `visibility=all` | public / private / internal を除外しない |
| `affiliation=owner,collaborator,organization_member` | 個人所有・Collaborator・Organization所有を区別せず含める（既定値と同じだが意図を明示） |
| `sort=full_name&direction=asc` | Pagination中の順序を安定させ、取りこぼし・重複を減らす（最終的な順序はローカルでsortする、§14） |

- archived / fork はAPI側で除外されないため、そのまま含まれる。
- `owner` 指定時も `/users/{owner}/repos` や `/orgs/{org}/repos` は使わず、常に `/user/repos` を取得してローカルで絞る。理由: 前者は「Tokenから参照可能な範囲」とは別の集合（他人のpublic Repository全体など）を返し、仕様の「Token accessをアクセス境界とする」と意味が変わるため。
- GitHub Search APIは使わない（仕様）。

### 11.1 Discovery集合をアクセス境界にする（rev.2、PR #8 [P1]）

`GET /user/repos` は認証ユーザーが明示的なRepository権限を持つRepository（Fine-grained PATでは選択したRepository）を列挙する。一方 `GET /repos/{owner}/{repo}` はpublic RepositoryであればTokenの選択対象外でも取得できる。直接取得だけでは「Token access = アクセス境界」を満たせないため、`project_get` は次の手順とする。

1. exact IDで `GET /repos/{owner}/{repo}` を直接取得する（rename / owner移管の301追従を維持、§18）。`404` / `403` / `451` は `NotFoundError`（§19）。
2. 取得できた場合、`GET /user/repos` を最後までPaginationしてDiscovery集合を得る（`project_list` と同じ `listRepositories()`）。
3. 1のRepositoryがDiscovery集合に含まれなければ `NotFoundError`（不存在・アクセス権なしと同一Message）。含まれれば1のResponseからProject / Detailsを返す。

- 照合はGitHubの数値Repository ID（Responseの `id`。Mapping内部の `repositoryId` としてのみ保持し、Tool Resultには出さない）で行う。owner / name文字列での照合と違い、大文字小文字の差・rename・owner移管・照合中の改名に影響されない。
- 2のPaginationが途中で失敗した場合は `ProviderApiError`（境界を確認できないままRepositoryを返さない）。
- コスト: `project_get` 1回あたり 1 + Discoveryのページ数 のRequestになる。MVPでは許容する（PR #8 レビューで合意）。Cacheは導入しない（§2）。
- 結果として `project_list` に出ないRepository（他人のpublic Repository等。仕様例の `github:openai/example` もTokenのDiscovery集合に含まれない限りNot found）は `project_get` でも取得できない。

---

## 12. Pagination

- Connector内部で `Link` Headerの `rel="next"` を最後まで辿る（`listRepositories()` が全ページ分の配列を返す）。
- `Link` のparseは `<url>; rel="next"` の最小限の正規表現。`next` のURLは **Originが `https://api.github.com` であることを検証** し、違えば `ProviderApiError`（Tokenを別Hostへ送らない）。
- 同じURLを2回辿ろうとした場合は `ProviderApiError`（無限ループ防止）。ページ数の上限は設けない（仕様「最後まで」）。
- **途中ページの失敗**（HTTP Error / Network / timeout / JSON不正 / 配列でないBody）は、それまでに取得した分を捨てて例外を投げる。`listRepositories()` は全ページ成功時にのみ配列を返すので、部分結果がConnectorへ渡る経路がない。
- `page` / `cursor` / `limit` はTool Inputに公開しない。

---

## 13. query / owner Filter（`filter.ts`）

Mapping済みのRepository record（`{ owner, name, description, ... }`）に対して適用する。

```ts
const fold = (text: string) => text.toLowerCase();

export function matchesFilter(repo: GitHubRepository, { query, owner }: ProjectListFilter): boolean {
  if (owner !== undefined && fold(repo.owner) !== fold(owner)) return false;
  if (query !== undefined) {
    const q = fold(query);
    const targets = [repo.name, `${repo.owner}/${repo.name}`, repo.description ?? ''];
    if (!targets.some((target) => fold(target).includes(q))) return false;
  }
  return true;
}
```

- `query`: repository name / `owner/repository` / description への大文字小文字を区別しない部分一致。`description == null` は空文字列。trim・空白正規化・`-` と空白の同一視はしない（Q3）。
- `owner`: owner loginへの大文字小文字を区別しない完全一致。User / Organizationを区別しない。
- 両方指定時はAND。
- `fold` は `toLowerCase()`（Phase 4 `search.ts` と同じ）。owner / repository名はASCIIのみだが、descriptionは日本語等を含み得るのでUnicode全体で同じ関数を使う。

---

## 14. stable sort（`filter.ts`）

```ts
const key = (repo: GitHubRepository) => `${repo.owner}/${repo.name}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function sortProjects(repos: GitHubRepository[]): GitHubRepository[] {
  return [...repos].sort((a, b) => compare(fold(key(a)), fold(key(b))) || compare(key(a), key(b)));
}
```

- canonicalな `owner/repository` の昇順。大文字小文字を無視した序数比較を主キー、元の文字列の序数比較を副キーとする（全順序のため結果が一意に定まる）。`localeCompare` は実行環境のlocaleに依存するため使わない（Q5）。
- Provider側の順序・`updated_at` に依存しない。
- **重複除去**: Pagination中にRepositoryが追加・削除されると同じRepositoryが2ページに現れ得るため、`fold(key)` が同じものは最初の1件だけ残す（`dedupe`）。

---

## 15. GitHub Project ID parse / validation（`id.ts`）

### 15.1 形式

```text
github:<owner>/<repository>
```

### 15.2 `parseGitHubProjectId(id): { owner, repo }`

すべて `InputValidationError`（Messageは期待形式を示す。例: `project id must be "github:<owner>/<repository>", got "..."`）とする条件:

| 条件 | 例 |
|---|---|
| `github:` で始まらない（大文字小文字も区別） | `physical-ai-robot`, `GitHub:a/b`, `google_drive:xxx` |
| `/` がちょうど1つでない | `github:a`, `github:a/b/c` |
| owner がGitHub loginの文字種・長さに合わない: `^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$` | `github:-a/b`, `github:a b/c`, `github:/b` |
| repository がGitHub Repository名の文字種・長さに合わない: `^[A-Za-z0-9._-]{1,100}$` | `github:a/`, `github:a/b c`, `github:a/日本語` |
| repository が `.` / `..` | `github:a/..` |
| 前後の空白・制御文字・URL（`https://github.com/a/b`）・`.git` 付きURL | 文字種規則で拒否 |

- 正規化（trim、大文字小文字変換、URLからの変換、Repository名だけでの補完）は一切しない。
- 検証済みのowner / repoはURL生成時にさらに `encodeURIComponent` する（多層防御。文字種規則上は変化しない）。
- owner の `_` は Enterprise Managed Users（`octocat_acme`）のため許可する。規則を厳しくしすぎると実在Repositoryを拒否し、緩い分にはGitHubが404を返すだけなので、文字種の目的は「API Pathを壊さない」ことに置く。
- 大文字小文字だけが異なるID（`github:Thanatos27/AI-Foundation`）はGitHub APIが解決するため取得でき、返却IDはcanonical表記になる（§18。Q7）。

### 15.3 `formatGitHubProjectId(owner, repo)`

`github:${owner}/${repo}`。値は常にGitHub Responseの `owner.login` と `name` から作る（Inputから作らない）。

---

## 16. Repository → Project Mapping（`mapping.ts`）

### 16.1 Response Schema（必要Fieldのみ）

```ts
const GitHubRepositorySchema = z.object({
  id: z.number().int().positive(),          // 境界確認（§11.1）専用。Tool Resultへ出さない
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  html_url: z.url({ protocol: /^https$/ }),
  description: z.string().nullable(),
  default_branch: z.string().min(1),
  private: z.boolean(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
  archived: z.boolean(),
  fork: z.boolean(),
  updated_at: z.iso.datetime({ offset: true }),
});
```

- `z.object` は未知Keyを捨てる。さらに出力は手で組み立てるので、Responseの他Field（`permissions`, `temp_clone_token`, `owner.avatar_url` 等）が結果へ入る経路はない。
- parse失敗は `ProviderApiError('GitHub', 'unexpected repository data: <field path>')`（値は含めない）。`project_list` で1件でも失敗した場合は全体をErrorとする（部分結果を返さない方針と揃える。Notionの「読めないPageを除外して続行」はユーザー入力起因だったが、GitHub ResponseはAPI契約なので不一致はProvider側の異常として扱う）。
- `visibility` が欠ける場合（古いAPI挙動）は `private ? 'private' : 'public'` で補う。

### 16.2 Project

| Project | 値 |
|---|---|
| `id` | `github:${owner.login}/${name}` |
| `type` | `project` |
| `title` | `name` |
| `source` | `github` |
| `external_ref` | `html_url`（GitHubが返すcanonical URL。例: `https://github.com/thanatos27/physical-ai-robot`） |

`project_list` の各要素はこの5 Fieldのみ（README / contents / Issue / PR / Response全体を含めない）。

---

## 17. project_get Details Mapping

| Details | GitHub Response |
|---|---|
| `description` | `description`（`null` はそのまま `null`） |
| `owner` | `owner.login` |
| `default_branch` | `default_branch` |
| `visibility` | `visibility`（欠落時は `private` から補完） |
| `archived` | `archived` |
| `fork` | `fork` |
| `updated_at` | `updated_at`（GitHubのISO 8601 UTC、例 `2026-10-15T13:00:00Z`。変換しない） |

- `updated_at` はGitHubの「Repository objectの更新時刻」。push時刻（`pushed_at`）は仕様にないため返さない。
- README / contents を取得するAPIは呼ばない。

---

## 18. rename / owner移管時のcanonical mapping

- `GET /repos/{old-owner}/{old-name}` に対しGitHubは `301 Moved Permanently`（`Location: https://api.github.com/repositories/{numeric-id}`）を返す。Clientは同一Originのため追従し（§8.3）、現在のRepositoryを取得する。
- 返却する `id` / `title` / `external_ref` / `details.owner` はすべて **取得したResponse** から作るため、自動的に新しいcanonical値になる（例: `github:thanatos27/old-name` → `github:thanatos27/new-name`）。
- 旧IDとの対応表は持たない。旧IDのRedirectをGitHubがやめた場合（旧名で新Repository作成等）はGitHubの解決結果に従う。
- 境界確認（§11.1）は数値Repository IDで行うため、旧IDで解決したRepositoryも、Discovery集合に現在の名前で含まれていれば取得できる。
- `project_list` は常に現在の名前で返す（Redirectは発生しない）。
- Unit Test: Fake fetchで `301` → `/repositories/123` → 新名のResponse を返し、結果がcanonical IDになること、Redirect先でも `Authorization` が付くこと、別Originへの `Location` は追従せず `ProviderApiError` になること。

---

## 19. Repository不存在 / access deniedの扱い

| 状況（`project_get`） | GitHubの応答 | Foundation Error |
|---|---|---|
| Repositoryが存在しない / 削除済み | `404` | `NotFoundError` |
| private Repositoryへのアクセス権がない | `404`（GitHubは存在を隠す） | `NotFoundError` |
| Fine-grained Tokenの対象外 / SSO未承認 / Organizationのポリシーで拒否 | `403`（Rate Limit以外） | `NotFoundError` |
| DMCA等で利用不可 | `451` | `NotFoundError`（Q9） |
| 直接取得はできるがTokenのDiscovery集合（`/user/repos`）に含まれない（Fine-grained PATの選択対象外のpublic Repository、他人のpublic Repository等） | `200`（境界確認で不一致） | `NotFoundError`（§11.1） |

- Messageは全ケース同一: `Not found: project github:<owner>/<repo> (it does not exist or the GitHub token cannot access it)`。外向けには不存在とアクセス権なしを区別しない。区別に使ったStatusは `cause` のみに残す。
- `project_list` では対象外Repositoryは単に一覧に現れない。

---

## 20. Rate Limit / Network / GitHub API Error Mapping（`errors.ts`）

`toFoundationError(input, context)`。`context` は `'list' | { get: id }`。

| 状況 | 判定 | Error | Message例 |
|---|---|---|---|
| `GITHUB_TOKEN` 未設定 | CredentialProvider | `CredentialError` | `GitHub credential is not configured: set GITHUB_TOKEN` |
| Tokenに送信不可能な文字 | §9 | `CredentialError` | 値を含めない |
| Token無効 / 期限切れ / 失効 | `401` | `CredentialError` | `GitHub rejected the token (HTTP 401)` |
| Primary Rate Limit | `403` or `429` かつ `x-ratelimit-remaining: 0` | `ProviderApiError` | `GitHub API error: rate limit exceeded; resets at 2026-10-15T13:00:00Z`（`x-ratelimit-reset` のepoch秒をISOへ） |
| Secondary Rate Limit | `403` / `429` かつ `retry-after` あり、またはBody `message` に `rate limit`（大文字小文字無視） | `ProviderApiError` | `GitHub API error: secondary rate limit exceeded; retry after 60 seconds` |
| `project_get` のaccess denied | `403`（上記以外）, `404`, `451` | `NotFoundError` | §19 |
| `project_list` の `403`（上記以外） | `403` | `CredentialError` | `the GitHub token is not allowed to list repositories (HTTP 403)`（Q10） |
| その他4xx | `400`, `404`（list）, `410`, `422` 等 | `ProviderApiError` | `GitHub API error: HTTP 422` |
| GitHub 5xx | `>= 500` | `ProviderApiError` | `GitHub API error: HTTP 502` |
| Network Error | `fetch` がreject（`TypeError`） | `ProviderApiError` | `GitHub API error: could not reach api.github.com (ECONNRESET)`（`cause.code` のみ） |
| timeout | `AbortSignal.timeout` | `ProviderApiError` | `GitHub API error: no response within 30 seconds` |
| Redirect / Pagination先が別Origin、Redirect回数超過、Linkループ | Client検証 | `ProviderApiError` | URLは含めない |
| 不正JSON / 想定外の形 | parse | `ProviderApiError` | `unexpected repository data: owner.login` |
| Pagination途中失敗 | 上記いずれか | 上記と同じ（部分結果なし） | |

- Rate Limit到達時にRetry / Sleep / 待機Schedulerを実装しない。`reset` / `retry-after` は数値として検証できた場合のみMessageへ入れる。
- GitHubのError Body `message` は **Messageへ入れない**（Rate Limit判定に使うだけ）。仕様「Secretを含み得る生Message」を外へ出さない方針を単純に守るため。`cause` には `{ status, githubMessage, documentationUrl }` の小さなPlain Objectを入れる（Request Header・Responseオブジェクト自体は入れない）。
- Network例外は `cause` に元の例外を保持する（undiciのNetwork Errorは送信Headerを含まない。Header値起因のErrorは§9の事前検証で発生させない）。

---

## 21. Secret / Authorization情報の漏洩防止

| 経路 | 対策 |
|---|---|
| Tool Result | Mappingで明示Fieldのみ（§16, §17）。Response全体・未知Field（`temp_clone_token` 等）を返さない |
| Error Message | Status・固定文言・検証済み数値・ユーザー入力のIDのみ。Token・Header・GitHub生Message・URL（Query含む）を入れない |
| `cause` | Plain Object（status / GitHub message / documentation_url）または Network例外。Request Header / `Authorization` を含むオブジェクトを入れない |
| Log | GitHub Connector / Clientは一切Logを出さない（`console.*` を使わない） |
| 送信先 | Tokenを付けるRequestは `https://api.github.com` Originのみ。Pagination `Link` / Redirect `Location` のOriginを検証し、Redirectは `manual` で自前追従（Fetchの自動追従に任せない） |
| Header値Error | Tokenの文字種を事前検証し、undiciのHeader値ErrorにTokenが載る経路を塞ぐ（§9） |
| Config / Repository | Tokenは環境変数（`.env`、Git管理外）のみ。`config.yaml` に書く場所がない（strict Schema） |
| e2e | 子プロセス環境から `GITHUB_TOKEN` を削除（`CREDENTIAL_VARS`） |

Test: 既知のダミーToken（例 `ghp_TESTSECRET0000`）を使い、Client / Connector / Tool Testの全Error MessageとTool Result textにTokenが含まれないことを共通Assertionで確認する（§24）。

---

## 22. 実装順序

各Stepの終わりで `npm run typecheck` と `npm test` を通す。Commitは概ねStep単位。

1. **Domain**: `project.ts` のInput / Result / Details Schema。`tests/domain/project.test.ts`。
2. **Credential**: `getGitHubToken`。`tests/credentials/env.test.ts`。`.env.example`。
3. **Config**: `config.yaml` の `providers`（Q6の結論に従う）。`tests/config/*` が通ることを確認。
4. **純粋関数**: `id.ts` → `mapping.ts` → `filter.ts` → `errors.ts` と各Test。
5. **Client**: `client.ts`（Header、Pagination、Redirect、timeout、Origin検証、Token文字種検証、`lazyGitHubClient`）。Fake `fetch` でのTest。
6. **Connector**: `types.ts` の `ProjectConnector` → `connector.ts`。Fake GitHubClientでのTest。
7. **Tools**: `tools/project.ts`、`FakeProjectConnector`、`tests/tools/project.test.ts`。
8. **配線**: `connectors/index.ts`、`tools/index.ts`、`tests/server.test.ts`、`tests/e2e/stdio.test.ts`（15 Tool）。
9. **Docs**: README（Current Phase、Tool一覧、GitHub Token Setup、Directory Structure、Documentation）。
10. **Integration Test** を追加し、実GitHub APIで実行（§25）。
11. **LLM Client Verification**（§26）。結果を本Planの「実装・Integration Verificationで確定した事項」に追記。
12. Codex Implementation Review → 指摘修正。

---

## 23. 依存Package

**追加なし。**

| 用途 | 利用 |
|---|---|
| HTTP | Node.js 24 のグローバル `fetch`（undici） |
| Response検証 | 既存 `zod ^4.6.7` |
| timeout | `AbortSignal.timeout` |

`@octokit/rest` 等のSDKは使わない（Q2）。理由: 必要なEndpointが2つだけ、Link Pagination・Redirect先のOrigin検証・Error分類・Header管理を明示的に制御・テストしたい、依存とその更新を増やさない。Octokitを使う場合も `GitHubClient` Interfaceの内側だけの差し替えで済む。

---

## 24. Test Strategy

### 24.1 方針

- 通常のTest Suite（`npm test`）は外部GitHub APIへ依存しない。Clientは注入した **Fake `fetch`**、Connectorは **Fake `GitHubClient`**、Tool Layerは **Fake `ProjectConnector`** でテストする。
- Fake fetchは呼び出されたURL・Headerを記録し、`Authorization` が `https://api.github.com` 以外へ送られていないことを全Client Testで検証する。
- ダミーToken `ghp_TESTSECRET0000` を使い、全Error Message / Tool Result textにTokenが含まれないことを共通Assertionで確認する。

### 24.2 Domain / Credential / Config

- `ProjectListFilterSchema`: `{}` 可、`query` / `owner` 単独・両方可、空白のみ拒否、未知Key（`page`, `limit`, `cursor`）拒否。
- `ProjectGetInputSchema`: `id` 必須、未知Key拒否。
- `ProjectResultSchema`: `id` なしで失敗。`GitHubProjectDetailsSchema`: `visibility` 3値、`description: null` 可、`updated_at` 形式、未知Key拒否。既存 `ProjectSchema` Test（`google_drive` 許容）は維持。
- `getGitHubToken`: 設定 / 未設定 / 空白のみ、trim、Messageに値を含まない。
- Config: `providers: [github]` / `[google_drive]` / `[github, google_drive]` がいずれも起動可、Project一覧Keyは引き続き拒否。

### 24.3 純粋関数

| File | 主なケース |
|---|---|
| `id.test.ts` | 正常（大文字小文字混在、`.`/`_`/`-` を含む名前、EMU owner `a_b`）、§15.2の各拒否、format round trip |
| `mapping.test.ts` | public / private / internal、`visibility` 欠落時の補完、archived / fork、Organization所有、`description: null`、日本語description、**不要Fieldを返さない**（`permissions`, `temp_clone_token`, `owner.avatar_url` 等を含むResponseから5 Field / 7 Fieldだけになる）、必須Field欠落・型違い → `ProviderApiError`（Messageに値を含まない）、数値 `id` がTool Result（Project / Details）に出ないこと |
| `filter.test.ts` | query: name / owner/repository / description・大文字小文字無視・`null` description・未Hit。owner: 完全一致・大文字小文字無視・部分一致しない（`thanatos` は `thanatos27` にHitしない）・User / Org区別なし。query + owner AND。sort: Provider順と無関係・大文字小文字混在・副キー。重複除去 |
| `errors.test.ts` | 401、403 Rate Limit（`remaining: 0`、resetのISO化）、403 secondary（`retry-after`）、429、403 access denied（get → NotFound / list → Credential）、404（get / list）、451、410、5xx、Network（`code` のみ）、timeout、GitHub Body `message` がErrorMessageに入らないこと |

### 24.4 Client（`client.test.ts`、Fake fetch）

| 仕様の項目 | Test |
|---|---|
| Header | `Authorization: Bearer <token>`、`Accept`、`X-GitHub-Api-Version`、`User-Agent`、Method GET |
| pagination | `Link: rel="next"` を3ページ辿り全件を返す、`per_page=100` 等のQuery、`Link` なしで終了 |
| pagination途中失敗で部分結果を返さない | 2ページ目が `500` / Network Error / 不正JSON → `ProviderApiError`、戻り値なし |
| 別Origin / ループ | `next` が別Hostなら `ProviderApiError` かつそのHostへRequestしない、同一URLの再出現で `ProviderApiError` |
| rename後のcanonical mapping | `301` → 同一Originへ追従し `Authorization` 付きで再Request、別Originの `Location` は追従しない、Redirect回数超過 |
| invalid credential | `401` → `CredentialError` |
| rate limit | `403` + `x-ratelimit-remaining: 0`、`429` → `ProviderApiError`、Retryしない（fetch呼び出し回数1） |
| network / 5xx | `fetch` reject、`502` / `503`、timeout |
| Credential漏洩防止 | 全Errorの `message` にToken不在、Tokenに改行を含む場合 `CredentialError` かつfetch未呼び出し・値なし |
| lazy | Token未設定で `CredentialError`、後から設定すると次回成功（`lazyNotionClient` と同様） |

### 24.5 Connector（`connector.test.ts`、Fake GitHubClient）

| 仕様の項目 | Test |
|---|---|
| project_list {} | 全Repositoryをcanonical順で、5 Fieldのみ |
| query / owner / query + owner | §13の規則がConnector経由で効く |
| stable sort | Fakeが逆順・ランダム順で返しても同じ結果 |
| public / private / internal / archived / fork / Organization | いずれも除外されない |
| project_get exact ID | `getRepository('thanatos27', 'physical-ai-robot')` が呼ばれ、`{ project, details }` |
| invalid ID | `InputValidationError`、Client（Credential取得含む）を呼ばない |
| rename後のcanonical mapping | `github:thanatos27/old-name` で新名のResponse → `id` / `title` / `external_ref` が新名 |
| 404 / access denied | Clientの `NotFoundError` が同一Messageで伝播し、Discovery（`listRepositories`）を呼ばない |
| Discovery集合 = アクセス境界（[P1]） | 直接取得は成功するがDiscovery集合に含まれないpublic Repository → `NotFoundError`（不存在と同一Message）。含まれる場合のみ返す |
| 境界確認は数値IDで照合 | 大文字小文字違いのID・rename後の旧IDで直接取得したRepositoryが、Discovery集合に新名 / canonical表記で含まれていれば取得できる。同名でも数値IDが違えば `NotFoundError` |
| 境界確認中のPagination失敗 | 直接取得は成功し `listRepositories` が `ProviderApiError` → `ProviderApiError`、Repositoryを返さない |
| 外部変更の反映 | Fakeの内容を書き換えた後の次回呼び出しに反映される（Cacheなし） |
| Provider生Responseの不要Field | Tool Resultに未知Fieldが出ない |

### 24.6 Tool Layer（`tests/tools/project.test.ts`、Fake Connector）

- 2 Toolの登録、annotations（readOnly）、Input Schema検証（未知Key・空白query拒否）、Result形状（`structuredContent` とtext JSONが一致、`outputSchema` 適合）。
- `providers` に `github` がないConfig → 両Toolが `ConfigurationError`（Connectorは呼ばれない）。
- Connector未設定 → `ConfigurationError`。Connectorの `FoundationError`（Credential / NotFound / ProviderApi）が `isError` 結果になる。

### 24.7 Server / e2e

- `tests/server.test.ts`、`tests/e2e/stdio.test.ts`: Tool一覧15件。
- e2e: `GITHUB_TOKEN` を削除した子プロセスで `project_list` が `Credential error: GitHub credential is not configured` を返し、Serverが落ちないこと。不正IDの `project_get` がToken未設定でも `Invalid input` になること。

---

## 25. Integration Verification

### 25.1 Integration Test（`tests/integration/github.integration.test.ts`、手動起動）

- `AI_FOUNDATION_INTEGRATION=1 npm run test:integration` で実行。`hasEnv('GITHUB_TOKEN')` でなければskip。**Read-only（GETのみ）でRepositoryへ書き込まない**（Clientに書き込み経路がない）。
- 既知のpublic Repositoryとして本Repository `thanatos27/ai-foundation` を使う（Public）。private Repository名は個人情報のためCommitせず、任意の環境変数 `AI_FOUNDATION_IT_GITHUB_PRIVATE_REPO=<owner>/<repo>` が設定されている場合のみ確認する。
- 確認項目:
  - `list({})` が空でなく、`github:thanatos27/ai-foundation` を含み、canonical順にsortされている。
  - `list({ query: 'foundation' })` / 大文字 `'FOUNDATION'` で含まれる。
  - `list({ owner: 'THANATOS27' })` が全件 owner `thanatos27`。
  - `get('github:thanatos27/ai-foundation')` の `details`（`default_branch: 'main'`、`visibility: 'public'`、`archived: false`、`fork: false`、`updated_at` 形式）。
  - private Repository（設定時）が `list` に含まれ、`get` で `visibility: 'private'`。
  - 存在しないRepository（`github:thanatos27/af-it-missing-<timestamp>`）で `NotFoundError`。
  - Discovery集合に含まれないpublic Repository（既定 `github:octocat/Hello-World`。任意の環境変数 `AI_FOUNDATION_IT_GITHUB_OUTSIDE_REPO` で上書き可）で `NotFoundError`。Test冒頭で `list({})` に含まれないことを確認し、含まれる環境ではskipする。
  - 無効Token（`ghp_invalid...` を渡したClient）で `CredentialError`、MessageにTokenを含まない。
- rename / owner移管は書き込みが必要なため自動Integrationでは扱わず、Unit Test（§24.4, §24.5）で担保する。過去にrenameしたRepositoryが手元にあれば手動で旧IDの `project_get` を確認し、結果をPRに記録する。

### 25.2 手動Verification（記録のみ）

| 項目 | 手順 |
|---|---|
| Repository一覧取得 | `project_list {}` の件数がGitHub上で見えるRepository数（Token対象範囲）と一致 |
| Token access境界 | Fine-grained PATで対象Repositoryを限定した場合、対象外（自分のpublic Repositoryを含む）が一覧に出ず、`project_get` も `NotFoundError`（§11.1） |
| Metadata取得 | GitHub上でdescriptionを変更 → 次回 `project_get` に反映 |

---

## 26. LLM Client Verification

Claude CodeからAI Foundation（stdio）へ接続し、以下を確認してPRに記録する。

| # | 発話 | 期待するTool呼び出し |
|---|---|---|
| 1 | 「physical-ai-robotの情報を確認して」 | `project_list`（query等）→ 返却されたexact `id` → `project_get`（IDを推測で組み立てない） |
| 2 | 「AI Foundationのプロジェクトを探して」 | `project_list({ query: "AI Foundation" })`。Hitしない場合に `query: "foundation"` や `{}` で再検索して `ai-foundation` に辿り着くこと（Q3。Repository descriptionは変更しない） |
| 3 | 「thanatos27のプロジェクトを一覧して」 | `project_list({ owner: "thanatos27" })` |

加えて、Project以外の発話（「Rustをいつか触りたい」等）でProject Toolが呼ばれず、既存Toolへのルーティングが変わらないことを1〜2件確認する。

---

## 27. Acceptance Criteriaとの対応

| Acceptance Criteria | 対応箇所 | Test / Verification |
|---|---|---|
| 1 GitHub Repository = 1 Project、GitHubがSoT、Registry / DB / Cache / Indexなし | §2, §8.4, §11 | §24.5 外部変更の反映、構造をReview |
| Google Drive Project Connectorへ依存しない | §3, §7 | 構造をReview |
| `GITHUB_TOKEN` をCredential Provider経由、Connectorが `process.env` を参照しない | §9 | §24.2、`process.env` 参照は `src/index.ts` のみ（Review） |
| Project一覧を `config.yaml` に記述しない | §10 | 既存strict Schema Test |
| `providers` に `github` なしで `ConfigurationError` | §6.1 | §24.6 |
| Project Mapping（id / type / title / source / external_ref）、exact IDを必ず返す | §5.1, §16 | §24.3, §24.5 |
| Details（description / owner / default_branch / visibility / archived / fork / updated_at） | §17 | §24.3, §25.1 |
| README / contents / Issue / PRを取得しない | §16, §17 | Client Endpointが2つのみ（§24.4でRequest URLを検証） |
| 動的列挙、`{}` で全件 | §11 | §24.5, §25.1 |
| query（name / owner/repository / description、大文字小文字無視の部分一致） | §13 | §24.3, §24.5, §25.1 |
| owner（大文字小文字無視の完全一致）、AND | §13 | §24.3, §24.5, §25.1 |
| Paginationを最後まで、途中失敗で部分結果なし | §12 | §24.4 |
| canonical owner/repository昇順で安定 | §14 | §24.3, §24.5 |
| exact IDでget、名前だけ / fuzzyでgetしない | §15 | §24.3, §24.5 |
| rename / owner移管後のcanonical ID / URL | §18 | §24.4, §24.5 |
| public / private / internal / archived / fork / Organization | §11, §16 | §24.3, §24.5, §25.1 |
| 次回呼び出しで現在状態を反映（Cacheなし） | §2 | §24.5, §25.2 |
| 削除済み / アクセス権喪失で `NotFoundError` | §11.1, §19 | §24.3, §24.5, §25.1 |
| Token access = アクセス境界 | §11, §11.1 | §24.5 境界確認、§25.1 Discovery外public Repository、§25.2 Fine-grained PAT |
| Token / Authorization HeaderをResult / Error / Logへ出さない | §9, §20, §21 | §24.1 共通Assertion、§24.4 |
| Response全体を返さず定義済みFieldのみ | §16 | §24.3 |
| 不存在とアクセス権なしを区別しない | §19 | §24.3 |
| Error 5分類、Rate Limit / Network / 5xx → `ProviderApiError` | §20 | §24.3, §24.4 |
| 独自Retry / Rate Limit待機なし | §2, §20 | §24.4（fetch呼び出し回数） |
| Fake / Mock GitHub Clientで外部非依存 | §24.1 | `npm test` |
| Automated Test一覧の各項目 | §24 | §24.3〜§24.5 の表 |
| Integration Verification（Repositoryへ書き込まない） | §25 | PR記録 |
| LLM Client Verification | §26 | PR記録 |

---

## 28. Google Drive Project Connector追加時に維持する境界

将来Google Drive Projectを追加する場合に **変えないもの**:

| 維持するもの | 内容 |
|---|---|
| Project Domain | `ProjectSchema`（`id` / `type` / `title` / `source` / `external_ref`）。Provider固有情報はDomainへ足さず `details` に置く |
| GitHub Project ID | `github:<owner>/<repository>`。Drive側は別prefix（例 `google_drive:<folder-id>`）とし、prefixでProviderを判別できる形を保つ |
| Tool名・Input | `project_list { query?, owner? }` / `project_get { id }`。Drive追加時に必要なFilterは追加Field（Optional）で拡張する |
| `project_list` の結果 | 共通Project 5 Fieldのみ |
| `project_get` の結果構造 | `{ project, details }` の分離。`details` は `project.source` で判別するUnionへ拡張 |
| SoT規則 | Registry / Cache / 関連付けを持たない（GitHubとDriveの紐付けは別途設計） |
| Credential境界 | Provider固有Credentialは `CredentialProvider` のメソッド追加で渡す |

**変えるもの**: `Connectors.project` を Provider別（例 `Partial<Record<ProjectSource, ProjectConnector>>`）にし、Tool Layerが `providers` に応じて `list` は有効な全Providerを集約してsort、`get` はID prefixで振り分ける。Phase 5の `GitHubProjectConnector` はそのまま `github` 用として使える（`ProjectConnector` Interfaceに `google_drive` 依存を入れないため）。

Phase 5ではUnion化・複数Provider集約は作らない。

---

## 29. 懸念点 / 未確定事項

Plan Reviewで判断をお願いした項目。PR #8 レビューでQ2〜Q7, Q9〜Q11は提案どおり合意、Q1は [P1] を受けて修正、Q8は値を確定した（rev.2）。

### Q1. 一覧の範囲とgetの範囲の差（rev.2で修正済み: §11.1）

- rev.1の提案: `project_get` は `/repos/{owner}/{repo}` の直接取得のみとし、`project_list` に出ない任意のpublic Repositoryも取得できる差を許容する。
- PR #8 [P1]: Fine-grained PATのRepository選択がアクセス境界にならず、仕様（Token access = 境界）と §25.2 の手動Verificationとも矛盾する。
- rev.2の決定: 直接取得後、数値Repository IDがDiscovery集合（`/user/repos`）に含まれることを確認し、含まれなければ `NotFoundError`。get時の全件Paginationは許容する。

### Q2. SDK（Octokit）を使わず `fetch` で実装する（合意済み）

- 提案: §23のとおり依存追加なし。
- 代替: `@octokit/rest` + `octokit.paginate`。Redirect / Origin検証・Error分類は結局自前のラップが要り、Phase 5の2 Endpointには過剰と判断。

### Q3. query の空白と `-` を同一視しない（合意済み）

- 懸念: LLM Client Verification例「AI Foundationのプロジェクトを探して」→ `query: "AI Foundation"` は、Repository名 `ai-foundation` に仕様どおりの部分一致ではHitしない（descriptionに "AI Foundation" が含まれない限り）。
- 決定: 仕様（大文字小文字無視の部分一致、fuzzyなし）を厳守し、Tool descriptionで「名前は `-` 区切りが多いので単語1つで検索するか全件から選ぶ」と案内する。LLMの再検索で到達できることをVerificationで確認する。Test都合でRepository descriptionは変更しない（PR #8 レビュー）。
- 代替: 照合時に空白・`-`・`_` を同一視する正規化を入れる（仕様の「部分一致」の解釈拡張になるため、採用する場合は仕様側の確認が必要）。

### Q4. 空文字・空白のみの `query` / `owner` を拒否する（合意済み）

- 提案: Phase 4 `knowledge_search.query` と同じく `NonBlankSchema`（Schema Error）。空文字queryは「全件一致」になり意図と異なる可能性が高いため。
- 代替: 空文字を「指定なし」と同じ扱いにする。

### Q5. sortの比較方法（合意済み）

- 提案: 大文字小文字を無視した序数比較 + 元文字列の序数比較（§14）。owner / repository名はASCIIのみなので実質的にアルファベット順。
- 代替: 大文字小文字を区別する純粋な序数比較（`Zeta` が `alpha` より前になる）。

### Q6. `config.yaml` の `project.providers` から `google_drive` を外す（合意済み）

- 提案: `[github]` のみにする。Phase 5では実装がなく、Phase 4でknowledgeの `google_drive` を外した前例に合わせる。Schemaは `google_drive` を受け付けたまま（将来互換）。
- 代替: そのまま残す（Phase 5では `github` が含まれていれば動作するため挙動は変わらない）。

### Q7. 大文字小文字だけ異なるIDの `project_get`（合意済み）

- 事実: GitHubは `GET /repos/Thanatos27/AI-Foundation` を正しく解決する。
- 提案: GitHubの解決に任せて取得し、canonical表記のIDを返す（rename時と同じ扱い）。これは「Foundationによる変換・fuzzy matching」ではなくProviderのcanonical化と整理する。
- 代替: 入力IDと返却IDが大文字小文字まで一致しない場合 `NotFoundError` → rename時のcanonical mapping要件と整合しないため非推奨。

### Q8. `X-GitHub-Api-Version` の固定値（rev.2で確定）

- 決定: **`2022-11-28` を安定性優先で固定する**。実装時判断には残さない。
- 理由: Plan承認時点の最新は `2026-03-10` だが、`2022-11-28` も現在サポート中（GitHubは新version公開後も旧versionを最低24か月サポートする）。Phase 5で使う `/user/repos` / `/repos/{owner}/{repo}` のFieldを、公開情報・事例が最も多いversionで実装・検証する。
- 将来: `2022-11-28` のサポート終了告知時、または必要なFieldが新versionにしかない場合に、別PRで更新する（`client.ts` の定数1か所）。

### Q9. `451`（DMCA等）を `NotFoundError` とする（合意済み）

- 提案: 外部から利用できない点はアクセス不可と同じため `NotFoundError`。
- 代替: `ProviderApiError`。

### Q10. `project_list` の `403`（Rate Limit以外）を `CredentialError` とする（合意済み）

- 背景: 仕様の表は `project_get` 視点（アクセス権なし → NotFound）。一覧APIの `403` はToken / OrganizationポリシーによりRepository一覧自体が許可されていない状況と考えられる。
- 提案: `CredentialError`（Token側の設定見直しを促すMessage）。
- 代替: `ProviderApiError`。

### Q11. Request timeout 30秒（合意済み）

- 提案: 1 Requestあたり30秒で `ProviderApiError`。Retryではなく、MCP Tool呼び出しが無期限に止まるのを防ぐため。Pagination全体の上限は設けない。

### その他

- GitHub App Installation Token（`/installation/repositories` で列挙する方式）はPhase 5対象外。PAT（Fine-grained推奨 / Classic可）を前提とし、READMEに記載する。Classic PATでprivate Repositoryを含める場合は `repo` scopeが必要（Read-onlyに限定できない）ため、READMEでFine-grained PATを推奨する理由として明記する。
- GitHub Enterprise Server（Base URL変更）は対象外。Base URLは定数とし、Configに持たない。
- Organizationが「SAML SSO」を要求している場合、未承認Tokenでは該当OrganizationのRepositoryが一覧に出ない / `project_get` が `NotFoundError` になる。仕様どおり区別しないが、READMEのTroubleshootingに記載する。

---

## 30. Review対応履歴

### rev.2（PR #8 レビュー反映）

| 指摘 | 対応 |
|---|---|
| [P1] `project_get` がFine-grained PATのRepository選択をアクセス境界として守れない（直接取得で選択外のpublic Repositoryも返る。§25.2とも矛盾） | §11.1を追加。直接取得（Redirect追従は維持）→ `/user/repos` 全件Pagination → 数値Repository IDで所属確認 → 不所属は `NotFoundError`。§2（方針2追加）、§6.2 Tool description、§7、§8.4、§16.1（`id` をparse・非公開）、§18、§19、§24.3、§24.5、§25.1、§25.2、§27、Q1を更新 |
| Q8: API versionを実装時判断に残さず明記 | `2022-11-28` を安定性優先で固定と確定（§8.3、Q8） |
| Q2〜Q7, Q9〜Q11 | 提案どおり合意。Q3はRepository descriptionを変更しない旨に修正（§26、Q3） |

---

## 31. 実装・Integration Verificationで確定した事項

実装（`feat/phase-5-project`）、実GitHub APIに対するIntegration Test、Claude CodeからのLLM Client Verificationで確定した事項。

### 31.1 Verification結果

| 項目 | 結果 |
|---|---|
| Automated Test（`npm test`） | 963件中959件成功、4件skip（Phase 4からの既存skip: Windowsでファイルsymlinkの作成権限がない環境のケース） |
| Integration Test（`tests/integration/github.integration.test.ts`） | 7件成功、1件skip（private Repository名を渡す `AI_FOUNDATION_IT_GITHUB_PRIVATE_REPO` が未設定のため）。一覧取得・canonical順sort・query（name / 大文字 / owner/repository）・owner絞り込み・exact IDによる `project_get` とDetails・存在しないRepositoryの `NotFoundError`・Token対象外のpublic Repository（`octocat/Hello-World`）の `NotFoundError`・無効Tokenの `CredentialError`（MessageにTokenなし） |
| Discovery集合 | Tokenから27件（public 25 / private 2 / fork 1 / archived 0 / internal 0、owner 1）。`physical-ai-robot` と `ai-foundation` を含む |
| private Repository | Repository名を記録しない形で、private 2件がいずれも `project_list` に含まれ、`project_get` で `visibility: private` かつ同一IDで取得できることを確認 |
| 書き込み | なし（Clientは `GET` のみ） |
| rename / owner移管 | 手元にrename済みRepositoryがないため実APIでは未確認。Unit Test（§24.4 / §24.5）で担保 |

### 31.2 Plan外の変更（Implementation Reviewで確認してほしい点）

- **`User-Agent`**: §8.3の `ai-foundation/0.1.0` ではなく `ai-foundation` とした。Version番号を `package.json` / `SERVER_INFO` と三重管理しないため。
- **`NonBlankSchema` の共通化**: §5.2のとおり `domain/knowledge.ts` から `domain/common.ts` へ移し、Projectと共有（挙動は不変）。
- **Tokenの文字種検証の必要性を確認**: Node 24の `fetch` で不正なHeader値を送ると、Error Messageに値そのもの（`Headers.append: "Bearer a\nb" is an invalid header value.`）が含まれることを実機で確認した。§9の事前検証で、この経路でTokenが漏れないようにしている。
- **timeout Message**: 秒数は切り上げで表示する（`no response within 30 seconds`）。
