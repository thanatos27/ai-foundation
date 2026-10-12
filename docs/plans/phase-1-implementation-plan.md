# Phase 1: Foundation — Implementation Plan

- Status: **Draft rev.2（再レビュー待ち）**
- 作成: Coding Agent (Claude Code) / 2026-10-12（rev.2: 2026-10-13 PR #1 レビュー反映）
- 対象: [Phase 1 Design Issue](../specs/phase-1-foundation.md)
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

本Planが承認されるまで実装は開始しない。レビュー指摘への対応は [§10 Review対応履歴](#10-review対応履歴) を参照。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | `main`。Commitは `183147b first commit`, `ece2767 docs: add MVP specification and Phase 1 design materials` の2件 |
| Tracked Files | `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/development/workflow.md`, `docs/specs/mvp-v0.1.md`, `docs/specs/phase-1-foundation.md` のみ |
| Source Code | なし（`src/`, `tests/` 未作成） |
| Package管理 | `package.json`, lockfile なし |
| `.gitignore` | **なし**（Secret混入防止のため最初に追加が必要） |
| GitHub Issue | `thanatos27/ai-foundation` にIssueは0件。Design Issueは `docs/specs/phase-1-foundation.md` として管理されている |
| ローカル環境 | Node.js v24.20.0, npm 11.19.0（pnpm / yarn は未導入）, Windows 11, `core.autocrlf=false` |

既存実装・既存依存関係が存在しないため、Phase 1はGreenfieldとして構築する。

---

## 2. 設計方針（Plan全体の前提）

1. **仕様のDirectory Structure（MVP §12）に従う。** ただしPhase 1で中身を持たないファイル（`src/tools/task.ts` 等、`src/connectors/todoist/` 等）は作成しない。各Phaseで追加する。
2. **Zod SchemaをDomain Modelの正とする。** TypeScript型は `z.infer` で導出し、型とValidationを二重定義しない。
3. **MCP SDKの上に独自Frameworkを作らない。** Tool登録はSDK v2の `McpServer.registerTool()` を直接使う。独自の `ToolDefinition` 型・Registry・重複検出・Error変換は作らない。
4. **Entity SchemaとTool / Connector Input Schemaを分離する。** Entity Schemaは仕様§5の各Entityの必須項目のみを必須とし、Input Schemaは仕様§9に定義があり、かつPhase 1で必要なものだけ定義する。
5. **抽象化は最小限。** Plugin Loader、DI Container、Base Class、Connector Registry、Generic Repository等は作らない。
6. **stdout はMCP JSON-RPC専用。** Logやエラー出力はすべて stderr に出す（stdio transportの破損防止）。
7. **Config読込とServer生成を分離する。** `serveStdio(factory)` は接続ごとにfactoryを呼び出し得るため、Config読込・Validationは起動時に1回だけEntry Pointで行い、factory（`createServer`）は副作用なしでServerを組み立てるだけにする。

---

## 3. 追加・変更予定ファイル

### 3.1 Project設定

| File | 種別 | 責務 |
|---|---|---|
| `.gitignore` | 追加 | `node_modules/`, `dist/`, `coverage/`, `.env`, `.env.*`（`!.env.example`）, `credentials*.json`, `token*.json`, `*.pem` 等を除外 |
| `.env.example` | 追加 | 使用予定の環境変数**名のみ**を記載（値は空）。Phase 1で使うのは `AI_FOUNDATION_CONFIG` のみ。Phase 2以降の変数はコメントで予告のみ |
| `package.json` | 追加 | `"type": "module"`, `engines.node >=22.12`, scripts（§5）。`bin` は設定しない（ローカル利用のため） |
| `package-lock.json` | 追加 | npm install により生成 |
| `tsconfig.json` | 追加 | `strict: true`, `module/moduleResolution: NodeNext`, `target: ES2023`, `noUncheckedIndexedAccess: true`。`src` と `tests` を型検査対象とする（`noEmit`） |
| `tsconfig.build.json` | 追加 | `tsconfig.json` を継承し `rootDir: src`, `outDir: dist` で `src` のみをBuild |
| `vitest.config.ts` | 追加 | `tests/**/*.test.ts` を対象とするVitest設定 |
| `config.yaml` | 追加 | MVP §13 の内容。ただし `version: "0.1"`（文字列）とする（§9 Q3）。Secret・動的データは含めない |

### 3.2 Domain（`src/domain/`）

Entity Schemaの必須項目は仕様§5のEntityごとのSchemaに従う。共通Metadata（§5.1 `id`, `source`, `external_ref`）は「必要に応じて」のため、**Entity側で仕様が明示的に定義している場合のみ**持たせる。

| File | 責務 |
|---|---|
| `common.ts` | 共通の値Schemaのみ: `AreaSchema`（`work \| personal`）, `TagsSchema`（`string[]`）, `DateSchema`（`YYYY-MM-DD`）, `DateTimeSchema`（ISO 8601、**Offset必須**） |
| `task.ts` | Entity: `TaskStatusSchema`, `TaskSchema`。Input（仕様§9定義済み）: `TaskCreateInputSchema`, `TaskListFilterSchema` |
| `schedule.ts` | Entity: `ScheduleSchema`。Input（仕様§9定義済み）: `ScheduleCreateInputSchema` |
| `collection.ts` | Entity: `CollectionTypeSchema`, `CollectionItemSchema` |
| `knowledge.ts` | Entity: `KnowledgeSourceSchema`, `KnowledgeSchema`（本文は持たない＝§5.6準拠） |
| `project.ts` | Entity: `ProjectSourceSchema`, `ProjectSchema`（§5.4の最低限項目のみ） |
| `index.ts` | 再Export |

Entity Schemaの項目定義（仕様§5より）:

| Entity | 必須 | null許容 / 任意 | 備考 |
|---|---|---|---|
| Task | `type: "task"`, `title`, `status` | `due`（Date または DateTime, nullable）, `area`（nullable）, `project_ref`（nullable）, `tags` | `id` / `source` / `external_ref` は任意 |
| Schedule | `type: "schedule"`, `title`, `start` | `end`（nullable）, `related_task`（nullable）, `tags` | `end < start` はValidation Error |
| CollectionItem | `type: "collection"`, `title`, `collection_type`, `status`（string） | `metadata`（object）, `tags` | 仕様例（§5.5）は `tags` を省略しているため任意 |
| Knowledge | `type: "knowledge"`, `title`, `source`, `external_ref` | `area`（nullable）, `tags` | `source` / `external_ref` は§5.6で必須 |
| Project | `type: "project"`, `title`, `source`, `external_ref` | — | `source` / `external_ref` は§5.4で必須 |

Input Schemaは仕様§9のJSONに従い、`id` / `source` / `external_ref` / `type` を持たない。§9に定義のない入力（`task_update`, `schedule_list` 等）はPhase 1では定義しない。

### 3.3 Config（`src/config/`）

| File | 責務 |
|---|---|
| `schema.ts` | `ConfigSchema`。全Objectを `.strict()` とし未知Keyを拒否（→ `projects:` やToken等の混入をValidation Errorにする）。`version` は文字列 `"0.1"` 固定。Provider値はEntityごとのEnum。`knowledge.default ∈ knowledge.providers` を `refine` で検証。`defaults.timezone` は `Intl.DateTimeFormat` で有効性検証 |
| `loader.ts` | `loadConfig(path)`: 与えられたパスのファイル読込 → YAML parse → Schema Validation → 型付きConfigを返す。**パス解決は行わない。** 失敗時は `ConfigError` を投げ、メッセージにファイルパス・Key Path・理由を含める（例: `config.yaml: sources.task.provider: Invalid option: expected "todoist"`） |

### 3.4 Connectors（`src/connectors/`）

| File | 責務 |
|---|---|
| `types.ts` | Connector境界の定義。Domain型のみを用いたInterfaceとして、Phase 2対象の `TaskConnector` / `ScheduleConnector` を定義。全Connectorを束ねる `Connectors` 型（`task?`, `schedule?`）を定義 |

メソッドは仕様§9でInputが定義済みの操作のみとする（§9 Q2）。

```ts
interface TaskConnector {
  create(input: TaskCreateInput): Promise<Task>;
  list(filter: TaskListFilter): Promise<Task[]>;
}
interface ScheduleConnector {
  create(input: ScheduleCreateInput): Promise<Schedule>;
}
```

`task_update` / `task_complete` / `schedule_list` のメソッドは、入力仕様が決まるPhase 2で追加する。Phase 1では実装クラス・Mock Connectorは作成しない。Collection / Knowledge / Project のInterfaceは各Phaseで追加する。

### 3.5 Tools（`src/tools/`）

| File | 責務 |
|---|---|
| `index.ts` | `ToolContext`（`config`, `connectors`）型と、`registerTools(server, context)` を定義。`registerTools` はEntityごとの登録関数を呼び出すだけの薄い関数で、**Phase 1では登録するToolがないため本体は空**。Phase 2で `registerTaskTools(server, context)` 等の呼び出しを追加する |

Phase 2以降のTool追加パターン（参考。Phase 1では作成しない）:

```ts
// src/tools/task.ts（Phase 2）
export function registerTaskTools(server: McpServer, { connectors }: ToolContext) {
  server.registerTool('task_create', { description, inputSchema: TaskCreateInputSchema },
    async (input) => { /* connectors.task を呼ぶ */ });
}
```

Tool名の重複・Handler例外のMCP Error結果への変換はSDKの挙動に任せる（独自実装しない）。

### 3.6 Server

| File | 責務 |
|---|---|
| `src/instructions.ts` | MVP §15 のAI向けInstructions文字列。MCP initialize時の `instructions` として送る |
| `src/server.ts` | `createServer({ config, connectors })`: `McpServer` を生成（`capabilities: { tools: {} }` を明示し、公開Tool 0件でも `tools/list` が空配列で応答するようにする）、Instructionsを設定、`registerTools` を呼んで返す。副作用なし |
| `src/index.ts` | Entry Point: Config Path解決（`--config` → `AI_FOUNDATION_CONFIG` → Repository Rootの `config.yaml`）→ `loadConfig(path)` → `serveStdio(() => createServer({ config, connectors: {} }))`。`ConfigError` 時は stderr にメッセージを出し `exit code 1`。SIGINT/SIGTERMで `handle.close()` |

### 3.7 Tests（`tests/`）

| File | 内容 |
|---|---|
| `tests/domain/*.test.ts` | Entity Schema / Input Schemaの正常系・異常系Validation |
| `tests/config/schema.test.ts` | Config Schemaの正常系・異常系 |
| `tests/config/loader.test.ts` | ファイル読込・YAML構文エラー・Error Messageの可読性 |
| `tests/fixtures/config/*.yaml` | 正常 / 異常Config Fixture |
| `tests/server.test.ts` | `InMemoryTransport` + `@modelcontextprotocol/client` でClient接続し、(1) 公開Toolが0件で `listTools()` が成功すること、(2) test-only Toolを `ToolContext` 経由で登録した場合に `listTools()` / `callTool()` で取得・実行できることを検証 |
| `tests/e2e/stdio.test.ts` | 実プロセスをstdioで起動し（`StdioClientTransport`）、接続・`listTools()` 成功、`--config` / `AI_FOUNDATION_CONFIG` の優先順位、不正Configでの起動失敗（非0終了・stderrメッセージ）を検証 |

### 3.8 Documentation

| File | 変更 |
|---|---|
| `README.md` | 「Current Phase」更新、Prerequisites（Node.js ≥22.12）、Install / Build / Test / 起動手順、MCP Client（Claude Code / Codex等）への登録例、Config Pathの指定方法を追記 |
| `docs/plans/phase-1-implementation-plan.md` | 本ファイル |

---

## 4. 依存Package

npm を使用する（ローカルに pnpm / yarn がなく、既存の慣習もないため）。バージョンは2026-10-13時点の最新安定版。

### dependencies

| Package | Version | 用途 |
|---|---|---|
| `@modelcontextprotocol/server` | `^2.3.1` | MCP SDK v2 Server（`McpServer`, `serveStdio` は `@modelcontextprotocol/server/stdio`） |
| `zod` | `^4.6.6` | Domain / Config / Tool Input Schema（SDK v2の依存 `zod ^4.2.0` を満たす） |
| `yaml` | `^2.9.1` | `config.yaml` の読込 |

### devDependencies

| Package | Version | 用途 |
|---|---|---|
| `@modelcontextprotocol/client` | `^2.3.1` | テスト用Client（`InMemoryTransport` 接続、`StdioClientTransport` によるe2e） |
| `typescript` | `~5.9.3` | Build / 型検査（§9 Q5） |
| `@types/node` | `^24` | Node.js型（実行環境 v24 に合わせる） |
| `vitest` | `^5.0.4` | Test Runner（engines: Node `^22.12 \|\| ^24`） |
| `tsx` | `^4.23` | `npm run dev` でのTS直接実行、e2eテストでのServer起動 |

**追加しないもの:** `@modelcontextprotocol/sdk`（v1 maintenance line）, `dotenv`（Phase 1でSecretを読まないため不要。Phase 2で必要になればNode標準の `process.loadEnvFile()` を優先検討）, ESLint/Prettier, Provider SDK類（Phase 2以降）。

---

## 5. npm scripts

```text
build      tsc -p tsconfig.build.json
typecheck  tsc -p tsconfig.json
test       vitest run
dev        tsx src/index.ts
start      node dist/index.js
```

---

## 6. Test Strategy

### 6.1 方針

- Vitestによる自動テストのみ。外部Serviceへの通信は一切発生しない。
- 「Validationが通ること」だけでなく「拒否されるべき入力が拒否されること」を重点的に検証する。
- Layer間の依存方向（DomainがProvider SDKをimportしない等）は独自のArchitecture Testを作らず、TypeScriptの型検査とCode Reviewで担保する。
- `npm run typecheck && npm test` の成功をImplementation Review前の必須条件とする。

### 6.2 Domain Schema

| Schema | 正常系 | 異常系 |
|---|---|---|
| Task | 仕様例（§5.2）/ `id` なし / `due: null` / 日付のみの `due` / Offset付き日時の `due` | 不正status、`title` 空、Offsetなし日時の `due` |
| TaskCreateInput / TaskListFilter | 仕様§9の例 | `status: done` での作成、不正area |
| Schedule / ScheduleCreateInput | `end: null` / `related_task` 指定 | `start` 欠落、Offsetなし日時、`end < start` |
| CollectionItem | 仕様例（§5.5 game / book、`tags` 省略） | 不正 `collection_type`、`metadata` が非Object |
| Knowledge | obsidian / google_drive | 不正source、`external_ref` 欠落 |
| Project | github / google_drive | 不正source、`external_ref` 欠落 |

### 6.3 Config

| Case | 期待結果 |
|---|---|
| リポジトリ同梱の `config.yaml` | 成功 |
| ファイルが存在しない | `ConfigError`（パスを含むメッセージ） |
| YAML構文エラー | `ConfigError`（行番号を含む） |
| `version: 0.1`（数値） | `ConfigError`（文字列であることを要求） |
| 必須Key欠落（`sources.task`） | `ConfigError`（Key Pathを含む） |
| 不正Provider（`task.provider: asana`） | `ConfigError` |
| `knowledge.default` が `providers` に含まれない | `ConfigError` |
| 不正timezone | `ConfigError` |
| 未知Key（`projects: [...]`, `sources.task.api_token: ...`） | `ConfigError`（動的データ・Secret混入の防止を検証） |

### 6.4 Server / Tool登録

- InMemoryTransport経由で接続し、Phase 1の公開Toolが0件の状態で `listTools()` が空配列で成功する。
- テスト内で `ToolContext` を受け取るtest-only登録関数（Phase 2の `registerTaskTools` と同じ形）を用意し、`createServer` 後に登録したToolが `listTools()` に現れ、`callTool()` でContext経由の値を返すことを確認する。test-only Toolは `tests/` 配下のみに置き、productionコードには含めない。
- e2e: `tsx src/index.ts` をstdioで起動し接続・`listTools()` が成功する。`--config` が `AI_FOUNDATION_CONFIG` より優先される。不正Config指定時は非0終了し、stderrに理由が出る。

---

## 7. 実装順序

各Stepは独立してCommit可能な単位とする。

| # | Step | 成果物 | 完了条件 |
|---|---|---|---|
| 1 | Project Scaffold | `.gitignore`, `package.json`, `tsconfig*.json`, `vitest.config.ts`, 依存Install | `npm run typecheck` / `npm test`（0件）が成功 |
| 2 | Domain Model | `src/domain/*` + Domain Test | Domain Testが成功 |
| 3 | Config | `src/config/*`, `config.yaml`, `.env.example` + Config Test | Config Testが成功 |
| 4 | Connector境界 | `src/connectors/types.ts` | 型検査成功 |
| 5 | MCP Server / Tool登録 | `src/tools/index.ts`, `src/instructions.ts`, `src/server.ts`, `src/index.ts` + Server / e2e Test | 全Test成功、`npm run build && npm start` で起動 |
| 6 | Documentation | `README.md` 更新 | READMEの手順のみで Install → Build → Test → 起動 が再現できる |
| 7 | 最終確認 | — | `git status` にSecret・`dist/`・`.env` が含まれない。`npm run typecheck && npm test` 成功 |

Step 1を最初に行うのは、`.gitignore` を依存Install・設定ファイル作成より前に置くため。

---

## 8. Acceptance Criteriaとの対応

| AC | 対応 | 検証 |
|---|---|---|
| **MCP Server**: stdioで起動できる | `src/index.ts` + `serveStdio` | e2e Test、README手順 |
| **MCP Server**: ClientからTool情報を取得できる | `capabilities.tools` を宣言し、`tools/list` に応答（Phase 1の公開Toolは0件）。登録機構はtest-only Toolで検証（§9 Q1） | `server.test.ts`, e2e Test |
| **Domain**: 5 Entityの共通Schemaが定義されている | `src/domain/*.ts` | Domain Test |
| **Domain**: Schema Validationが可能 | Zod Schema + `z.infer` | Domain Test |
| **Domain**: Provider SDK型へ依存しない | Domainは `zod` のみ依存（Provider SDKはPhase 1で未導入） | 型検査、Code Review |
| **Config**: `config.yaml` を読み込める | `loadConfig` | Config Test（同梱config.yaml） |
| **Config**: Schema Validationが行われる | `ConfigSchema` | Config Test |
| **Config**: 不正時に理解可能なErrorで起動失敗 | `ConfigError` + Key Path付きメッセージ + exit 1 | Loader Test, e2e Test |
| **Config**: 個別Project情報がSchemaに含まれない | `project.providers` のみ。`.strict()` で未知Key拒否 | Config Test（`projects:` 拒否） |
| **Tool**: 追加・登録の基本構造 | `ToolContext` + `registerTools` + SDK `registerTool` 直接利用 | Server Test（test-only Tool） |
| **Tool**: Phase 2でTask/Schedule Tool追加可能 | `src/tools/task.ts` 等を追加し `registerTools` から呼ぶだけ。Connectorは `ToolContext.connectors` 経由 | 構造レビュー |
| **Tool**: 疑似実装を大量に作らない | Mock Connector・未実装Tool・仕様外Toolを作らない | 構造レビュー |
| **Connector**: 境界が定義されている | `connectors/types.ts`（Domain型のみのInterface） | 型検査、Code Review |
| **Security**: SecretがCommitされない | `.gitignore`、Config `.strict()`、Secretを読まない | Step 7 で `git status` 確認 |
| **Security**: `.env.example` にSecretなし | 変数名のみ・値は空 | レビュー |
| **Test**: Config / 主要Domain SchemaのTestが存在 | §6 | `npm test` |
| **Test**: Test Suiteが正常終了 | — | `npm test` |
| **Docs**: Install / Build / Test / 起動方法がREADMEにある | README更新 | Step 6 |

---

## 9. 懸念点 / 未確定事項

### Q1. AC「ClientからTool情報を取得できる」の解釈（要確認）

レビュー指摘に従い、公開Tool 0件を許容し「stdioでClient接続でき、`tools/list` が応答する」「Tool登録機構はtest-only Toolで検証できる」と解釈する。

- Design Issue（`docs/specs/phase-1-foundation.md`）のAC文言をこの解釈に合わせて更新するかは、User / ChatGPT側の判断とする（Coding Agentは仕様を勝手に変更しない）。本PRでの更新が必要であれば指示いただきたい。

### Q2. Connector Interfaceのメソッド範囲

Task / Schedule のみ定義する方針はレビューで合意済み。そのうえで、メソッドは**仕様§9でInputが定義されている `task.create` / `task.list` / `schedule.create` のみ**とし、`task_update` / `task_complete` / `schedule_list` はPhase 2で入力仕様と合わせて追加する。Phase 1で入力型を推測して固定しないため。

### Q3. Config `version` と仕様例の差分

`version` は文字列 `"0.1"` 固定とする（レビュー指摘）。MVP仕様§13の例は `version: 0.1`（数値）のため、同梱 `config.yaml` と仕様例に差分が出る。仕様§13の例を `version: "0.1"` に更新するかはUser / ChatGPT側で判断いただきたい。

### Q4. 日時表現

- Task `due`: 日付のみ（`YYYY-MM-DD`）またはOffset付き日時を受け付ける。
- Schedule `start` / `end` 等その他のdatetime: Offset必須。
- Offsetなし日時へ `defaults.timezone` を適用する変換はConnector / Tool側の責務とし、Phase 2で扱う。

### Q5. TypeScriptのバージョン

`typescript@~5.9.3` を採用する。npm最新の7系（ネイティブ実装の新Major）はTool Chainとの互換性実績が浅く、Phase 1でリスクを取る理由がないため。安定確認後に別途Upgradeする。

### Q6. Directory Structureの差分

MVP §12からの差分として以下を追加する。

- `src/index.ts`（Entry Point。`server.ts` から起動処理を分離しテスト可能にするため）
- `src/instructions.ts`（§15のInstructions）
- `src/domain/common.ts`, `src/domain/index.ts`
- `src/tools/index.ts`
- `src/connectors/types.ts`
- `tsconfig.build.json`, `vitest.config.ts`
- `docs/plans/`（Implementation Plan置き場）

逆に、仕様にある `src/tools/{task,schedule,...}.ts` と `src/connectors/{todoist,...}/` はPhase 1では作成しない。

### その他の懸念

- **SDK v2の挙動確認:** `serveStdio` は接続のOpening（2025年版 `initialize` か新方式か）によって扱いを切り替える。Claude Code / Codex等、利用予定のClientから接続できることをStep 5で実機確認する。また、Tool 0件時の `tools/list` 応答、重複Tool名・Handler例外時のSDKの挙動は実装時に確認し、想定と異なればPlanを更新して報告する。
- **stdout汚染:** `console.log` を1行でも出すとstdio transportが壊れる。Logは `console.error` のみ使用する方針をREADME（開発者向け節）に明記する。
- **Windows:** e2e Testで子プロセスを起動するため、`tsx` 起動時のパス・`shell` 差異に注意する（`@modelcontextprotocol/client` の `StdioClientTransport` は `cross-spawn` を使用しており対応済みの見込み）。
- **Delete操作:** §16「Delete → 原則ユーザー確認」はPhase 1にDelete Toolがないため対象外。

---

## 10. Review対応履歴

### rev.2（PR #1 レビュー反映）

| # | 指摘 | 対応 |
|---|---|---|
| 1 | MCP SDKをv2へ変更 | `@modelcontextprotocol/server@^2.3.1` を採用、テスト用に `@modelcontextprotocol/client@^2.3.1`。起動は `serveStdio(() => createServer(...))`（§3.6, §4） |
| 2 | `foundation_info` を追加しない | 削除。公開Tool 0件を許容し、登録機構はtest-only Toolで検証（§3.5, §6.4, §9 Q1） |
| 3 | 独自Tool frameworkを薄く | `ToolDefinition` / `registry.ts` / 独自重複検出・Error変換を削除。SDK `registerTool` を直接使い、`registerTools(server, context)` のみ残す（§3.5） |
| 4 | Domain ModelとTool Inputを分離 | Entity SchemaはEntityごとの必須項目のみ。`id` / `source` / `external_ref` の共通必須を撤回。Input Schemaは§9定義済みでPhase 1に必要なもののみ（§3.2） |
| 5 | Config versionを文字列固定 | `version: "0.1"` 固定、数値は拒否（§3.3, §6.3, §9 Q3） |
| 6 | Architecture Testを削除 | 削除。型検査 + Code Reviewで担保（§6.1） |
| 他 | Config Path解決をEntry Pointへ | `loadConfig(path)` は読込・Validationのみ。解決は `src/index.ts`（§3.3, §3.6） |
| 他 | Connector Interfaceのメソッド | 合意済みのTask / Scheduleに加え、§9定義済み入力の操作のみに限定（§9 Q2） |
