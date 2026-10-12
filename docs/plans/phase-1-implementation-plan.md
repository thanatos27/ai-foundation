# Phase 1: Foundation — Implementation Plan

- Status: **Draft（Plan Review待ち）**
- 作成: Coding Agent (Claude Code) / 2026-10-12
- 対象: [Phase 1 Design Issue](../specs/phase-1-foundation.md)
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

本Planが承認されるまで実装は開始しない。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | `main`（clean）。Commitは `183147b first commit`, `ece2767 docs: add MVP specification and Phase 1 design materials` の2件 |
| Tracked Files | `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/development/workflow.md`, `docs/specs/mvp-v0.1.md`, `docs/specs/phase-1-foundation.md` のみ |
| Source Code | なし（`src/`, `tests/` 未作成） |
| Package管理 | `package.json`, lockfile なし |
| `.gitignore` | **なし**（Secret混入防止のため最初に追加が必要） |
| GitHub Issue | `thanatos27/ai-foundation` にIssueは0件。Design Issueは `docs/specs/phase-1-foundation.md` として管理されている |
| ローカル環境 | Node.js v24.20.0, npm 11.19.0（pnpm / yarn は未導入）, Windows 11, `core.autocrlf=false` |

既存実装・既存依存関係が存在しないため、Phase 1はGreenfieldとして構築する。

---

## 2. 設計方針（Plan全体の前提）

1. **仕様のDirectory Structure（MVP §12）に従う。** ただしPhase 1で中身を持たないファイル（`src/tools/task.ts` 等の空ファイル、`src/connectors/todoist/` 等の空ディレクトリ）は作成しない。各Phaseで追加する。
2. **Zod SchemaをDomain Modelの正とする。** TypeScript型は `z.infer` で導出し、型とValidationを二重定義しない。
3. **抽象化は最小限。** Plugin Loader、DI Container、Base Class、Connector Registry、Generic Repository等は作らない。
4. **stdout はMCP JSON-RPC専用。** Logやエラー出力はすべて stderr に出す（stdio transportの破損防止）。
5. **Serverの組み立てと起動を分離する。** `createServer()` は副作用なしで生成のみ行い、プロセス起動（Config読込・stdio接続・終了コード）はEntry Pointが担う。これによりIn-Memory Transportでのテストが可能になる。

---

## 3. 追加・変更予定ファイル

### 3.1 Project設定

| File | 種別 | 責務 |
|---|---|---|
| `.gitignore` | 追加 | `node_modules/`, `dist/`, `coverage/`, `.env`, `.env.*`（`!.env.example`）, `credentials*.json`, `token*.json`, `*.pem` 等を除外 |
| `.env.example` | 追加 | 使用予定の環境変数**名のみ**を記載（値は空）。Phase 1で実際に使うのは `AI_FOUNDATION_CONFIG` のみ。Phase 2以降の変数はコメントで予告のみ |
| `package.json` | 追加 | `"type": "module"`, `engines.node >=22.12`, scripts（§5）, `bin` は設定しない（ローカル利用のため） |
| `package-lock.json` | 追加 | npm install により生成 |
| `tsconfig.json` | 追加 | `strict: true`, `module/moduleResolution: NodeNext`, `target: ES2023`, `outDir: dist`, `rootDir: src`, `noUncheckedIndexedAccess: true` |
| `tsconfig.test.json` または `vitest.config.ts` | 追加 | Vitest設定（`tests/**/*.test.ts`）。tsconfig側で `tests/` を型検査対象に含めるための分割 |
| `config.yaml` | 追加 | MVP §13 の内容そのもの。Secret・動的データは含めない |

### 3.2 Domain（`src/domain/`）

| File | 責務 |
|---|---|
| `common.ts` | 共通Schema: `AreaSchema`（`work \| personal`）, `TagsSchema`, `DateTimeSchema`（ISO 8601）, 共通Metadata（`id`, `source`, `external_ref`） |
| `task.ts` | `TaskStatusSchema`（`inbox/next/waiting/someday/done`）, `TaskSchema`, および仕様§9に定義済みの `TaskCreateInputSchema`, `TaskListFilterSchema` |
| `schedule.ts` | `ScheduleSchema`, `ScheduleCreateInputSchema`（§9）。`end` が `start` より前の場合はValidation Error |
| `collection.ts` | `CollectionTypeSchema`（`game/book/movie/other`）, `CollectionItemSchema`（`type: "collection"`, `status: string`, `metadata: Record<string, unknown>`） |
| `knowledge.ts` | `KnowledgeSourceSchema`（`obsidian/google_drive`）, `KnowledgeSchema`（本文は持たない＝§5.6準拠） |
| `project.ts` | `ProjectSourceSchema`（`github/google_drive`）, `ProjectSchema`（`title`, `source`, `external_ref` のみ。§5.4準拠で詳細Metadataは持たない） |
| `index.ts` | Domain Schema/型の再Export |

Domain層は `zod` と `./` 相対importのみ許可する（Provider SDK・`connectors/`・`tools/` をimportしない）。この制約はTestで検証する（§6.4）。

### 3.3 Config（`src/config/`）

| File | 責務 |
|---|---|
| `schema.ts` | `ConfigSchema`。全Objectを `.strict()` とし未知Keyを拒否（→ `projects:` やToken等の混入をValidation Errorにする）。Provider値はEntityごとのEnum。`knowledge.default ∈ knowledge.providers` を `refine` で検証。`defaults.timezone` は `Intl.DateTimeFormat` で有効性検証 |
| `loader.ts` | `loadConfig(path)`: ファイル読込 → YAML parse → Schema Validation → 型付きConfigを返す。失敗時は `ConfigError` を投げ、メッセージにファイルパス・該当Key Path・理由を含める（例: `config.yaml: sources.task.provider: Invalid option: expected "todoist"`）。Config Pathの解決（§9 Q3）もここで行う |

### 3.4 Connectors（`src/connectors/`）

| File | 責務 |
|---|---|
| `types.ts` | Connector境界の定義。Phase 2対象の `TaskConnector`（`create/list/update/complete`）, `ScheduleConnector`（`create/list`）を **Domain型のみ** を用いたInterfaceとして定義。全Connectorを束ねる `Connectors` 型（各Entity optional）を定義 |

Phase 1では実装クラス・Mock Connectorは作成しない（Design Issue「疑似実装を大量に作る必要はない」）。Collection / Knowledge / Project のInterfaceは各Phaseで追加する（§9 Q2）。

### 3.5 Tools（`src/tools/`）

| File | 責務 |
|---|---|
| `types.ts` | `ToolDefinition`（`name`, `description`, `inputSchema`（Zod）, `handler(input, context)`）と `ToolContext`（`config`, `connectors`）の定義 |
| `registry.ts` | `registerTools(server, tools, context)`: `ToolDefinition[]` をMCP SDKの `server.registerTool()` へ登録する薄いAdapter。Tool名の重複を検出してErrorにする。Handlerの例外をMCPの `isError: true` 結果へ変換する |
| `index.ts` | 公開Tool一覧（`ToolDefinition[]`）の集約。Phase 2ではここに `taskTools`, `scheduleTools` を追加するだけで登録される |
| `foundation.ts` | Phase 1唯一のTool `foundation_info`（§9 Q1 で要承認）。外部通信なし。Entity定義・SoT対応・有効Provider（Configから）を返す |

### 3.6 Server

| File | 責務 |
|---|---|
| `src/instructions.ts` | MVP §15 のAI向けInstructions文字列。MCP initialize時の `instructions` として送る |
| `src/server.ts` | `createServer({ config, connectors })`: `McpServer` を生成し、Instructionsを設定、`tools/index.ts` のToolを登録して返す（起動はしない） |
| `src/index.ts` | Entry Point: Config Path解決 → `loadConfig` → `createServer` → `StdioServerTransport` 接続。`ConfigError` 時は stderr にメッセージを出し `exit code 1`。SIGINT/SIGTERMでclose |

### 3.7 Tests（`tests/`）

| File | 内容 |
|---|---|
| `tests/domain/*.test.ts` | Entityごとの正常系・異常系Validation |
| `tests/domain/architecture.test.ts` | `src/domain/**` のimport文を走査し、`zod` と相対パス以外への依存がないことを検証 |
| `tests/config/schema.test.ts` | Config Schemaの正常系・異常系 |
| `tests/config/loader.test.ts` | ファイル読込・YAML構文エラー・Error Messageの可読性 |
| `tests/fixtures/config/*.yaml` | 正常 / 異常Config Fixture |
| `tests/tools/registry.test.ts` | Tool登録・重複名Error・Handler例外の `isError` 変換 |
| `tests/server.test.ts` | SDKの `InMemoryTransport` でClient接続し `listTools()` / `callTool("foundation_info")` を検証 |
| `tests/e2e/stdio.test.ts` | 実プロセスをstdioで起動し（`StdioClientTransport`）、Tool一覧取得と、不正Configでの起動失敗（非0終了・stderrメッセージ）を検証 |

### 3.8 Documentation

| File | 変更 |
|---|---|
| `README.md` | 「Current Phase」更新、Prerequisites（Node.js ≥22.12）、Install / Build / Test / 起動手順、MCP Client（Claude Code / Codex等）への登録例、Config Pathの指定方法を追記 |
| `docs/plans/phase-1-implementation-plan.md` | 本ファイル |

---

## 4. 依存Package

npm を使用する（ローカルに pnpm / yarn がなく、既存の慣習もないため）。バージョンは2026-10-12時点の最新安定版。

### dependencies

| Package | Version | 用途 |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.32.1` | MCP Server / stdio transport / テスト用Client・InMemoryTransport |
| `zod` | `^4.6.6` | Domain / Config / Tool Input Schema（SDKのpeer: `^3.25 \|\| ^4.0` を満たす） |
| `yaml` | `^2.9.1` | `config.yaml` の読込 |

### devDependencies

| Package | Version | 用途 |
|---|---|---|
| `typescript` | §9 Q5 参照 | Build / 型検査 |
| `@types/node` | `^24` | Node.js型（実行環境 v24 に合わせる） |
| `vitest` | `^5.0.4` | Test Runner（engines: Node `^22.12 \|\| ^24`） |
| `tsx` | `^4.23` | `npm run dev` でのTS直接実行、e2eテストでのServer起動 |

**追加しないもの:** `dotenv`（Phase 1でSecretを読まないため不要。Phase 2で必要になればNode標準の `process.loadEnvFile()` を優先検討）, ESLint/Prettier（§9 Q6）, Provider SDK類（Phase 2以降）。

---

## 5. npm scripts

```text
build      tsc -p tsconfig.json
typecheck  tsc --noEmit（src + tests）
test       vitest run
dev        tsx src/index.ts
start      node dist/index.js
```

---

## 6. Test Strategy

### 6.1 方針

- Vitestによる自動テストのみ。外部Serviceへの通信は一切発生しない。
- 「Validationが通ること」だけでなく「拒否されるべき入力が拒否されること」を重点的に検証する。
- `npm run typecheck && npm test` の成功をImplementation Review前の必須条件とする。

### 6.2 Domain Schema

| Entity | 正常系 | 異常系 |
|---|---|---|
| Task | 全項目指定 / `due: null` / `area: null` / 日付のみの`due` | 不正status、`title`空、`tags`が配列でない |
| Schedule | `end: null` / `related_task` 指定 | `start`欠落、不正日時、`end < start` |
| CollectionItem | book / game の仕様例そのもの | 不正`collection_type`、`metadata`が非Object |
| Knowledge | obsidian / google_drive | 不正source、`external_ref`欠落 |
| Project | github / google_drive | 不正source |

仕様書に記載された例（§5.2, §5.5）はそのままFixture化して通ることを確認する。

### 6.3 Config

| Case | 期待結果 |
|---|---|
| リポジトリ同梱の `config.yaml` | 成功 |
| ファイルが存在しない | `ConfigError`（パスを含むメッセージ） |
| YAML構文エラー | `ConfigError`（行番号を含む） |
| 必須Key欠落（`sources.task`） | `ConfigError`（Key Pathを含む） |
| 不正Provider（`task.provider: asana`） | `ConfigError` |
| `knowledge.default` が `providers` に含まれない | `ConfigError` |
| 不正timezone | `ConfigError` |
| 未知Key（`projects: [...]`, `sources.task.api_token: ...`） | `ConfigError`（動的データ・Secret混入の防止を検証） |

### 6.4 Architecture

- `src/domain/**/*.ts` のimportが `zod` または相対パスのみであること。
- `src/domain` / `src/tools` が `src/connectors/<provider>/` 配下を直接importしていないこと（Phase 2以降の回帰防止）。

### 6.5 Tool / Server

- `registerTools` が定義済みToolをすべて登録し、重複名でErrorになる。
- Handler例外がClientへ `isError: true` として返る（プロセスが落ちない）。
- InMemoryTransport経由で `listTools()` が `foundation_info` を返し、`inputSchema` を含む。
- e2e: `tsx src/index.ts` をstdioで起動し `listTools()` が成功する。不正Config指定時は非0終了し、stderrに理由が出る。

---

## 7. 実装順序

各Stepは独立してCommit可能な単位とする。

| # | Step | 成果物 | 完了条件 |
|---|---|---|---|
| 1 | Project Scaffold | `.gitignore`, `package.json`, `tsconfig*.json`, `vitest.config.ts`, 依存Install | `npm run typecheck` / `npm test`（0件）が成功 |
| 2 | Domain Model | `src/domain/*` + Domain Test + Architecture Test | Domain Testが成功 |
| 3 | Config | `src/config/*`, `config.yaml`, `.env.example` + Config Test | Config Testが成功 |
| 4 | Connector境界 | `src/connectors/types.ts` | 型検査成功 |
| 5 | Tool登録構造 | `src/tools/*` + Registry Test | Registry Testが成功 |
| 6 | MCP Server | `src/instructions.ts`, `src/server.ts`, `src/index.ts` + Server / e2e Test | 全Test成功、`npm run build && npm start` で起動 |
| 7 | Documentation | `README.md` 更新 | READMEの手順のみで Install → Build → Test → 起動 が再現できる |
| 8 | 最終確認 | — | `git status` にSecret・`dist/`・`.env` が含まれない。`npm run typecheck && npm test` 成功 |

Step 1を最初に行うのは、`.gitignore` を依存Install・設定ファイル作成より前に置くため。

---

## 8. Acceptance Criteriaとの対応

| AC | 対応 | 検証 |
|---|---|---|
| **MCP Server**: stdioで起動できる | `src/index.ts` + `StdioServerTransport` | e2e Test、README手順 |
| **MCP Server**: ClientからTool情報を取得できる | `foundation_info` を登録 | `server.test.ts`, e2e Test |
| **Domain**: 5 Entityの共通Schemaが定義されている | `src/domain/*.ts` | Domain Test |
| **Domain**: Schema Validationが可能 | Zod Schema + `z.infer` | Domain Test |
| **Domain**: Provider SDK型へ依存しない | Domainは `zod` のみ依存 | Architecture Test |
| **Config**: `config.yaml` を読み込める | `loadConfig` | Config Test（同梱config.yaml） |
| **Config**: Schema Validationが行われる | `ConfigSchema` | Config Test |
| **Config**: 不正時に理解可能なErrorで起動失敗 | `ConfigError` + Key Path付きメッセージ + exit 1 | Loader Test, e2e Test |
| **Config**: 個別Project情報がSchemaに含まれない | `project.providers` のみ。`.strict()` で未知Key拒否 | Config Test（`projects:` 拒否） |
| **Tool**: 追加・登録の基本構造 | `ToolDefinition` + `registerTools` + `tools/index.ts` | Registry Test |
| **Tool**: Phase 2でTask/Schedule Tool追加可能 | `tools/index.ts` に追加するだけ。`ToolContext.connectors.task/schedule` 経由でConnector利用 | 構造レビュー |
| **Tool**: 疑似実装を大量に作らない | Mock Connector・未実装Toolを作らない | 構造レビュー |
| **Connector**: 境界が定義されている | `connectors/types.ts`（Domain型のみのInterface） | 型検査、Architecture Test |
| **Security**: SecretがCommitされない | `.gitignore`、Config `.strict()`、Secretを読まない | Step 8 で `git status` 確認 |
| **Security**: `.env.example` にSecretなし | 変数名のみ・値は空 | レビュー |
| **Test**: Config / 主要Domain SchemaのTestが存在 | §6 | `npm test` |
| **Test**: Test Suiteが正常終了 | — | `npm test` |
| **Docs**: Install / Build / Test / 起動方法がREADMEにある | README更新 | Step 7 |

---

## 9. 懸念点 / 未確定事項

Plan Reviewで判断をお願いしたい事項。各項目に推奨案を記載する。

### Q1. Phase 1で公開するToolがない問題（要判断）

AC「ClientからServerが公開するTool情報を取得できる」に対し、Phase 1の仕様上のTool（§8）はすべて外部接続が必要でPhase 2以降。Toolが0件だと `tools/list` は空配列となり、ACの検証として弱い。

- **推奨: A.** 外部通信を持たない `foundation_info` Toolを追加する（Entity定義・SoT対応・有効Providerを返す）。§8のIF一覧にないToolを追加することになるため、仕様への追記可否を確認したい。
- B. Tool 0件のまま、`tools/list` が空配列で成功することをもってACを満たすとみなす。
- C. Phase 2のTool（`task_create` 等）を「未実装Error」を返す形で登録する。→ AIが呼び出して失敗するため非推奨。

### Q2. Connector Interfaceの範囲

- **推奨:** Phase 2対象の `TaskConnector` / `ScheduleConnector` のみ定義し、他EntityのInterfaceは各Phaseで追加する。未設計のIF（`collection_search` 等の入力仕様は§9に未定義）を先回りで固定しないため。
- 代替: 5 Entity分すべてのInterfaceを§8のIF名から定義する（入力型の一部は推測になる）。

### Q3. Config Pathの解決方法

MCP ClientはServerを任意のcwdで起動するため、相対パス `./config.yaml` は不安定。

- **推奨:** 優先順位 `--config <path>` 引数 → 環境変数 `AI_FOUNDATION_CONFIG` → Repository Root（`dist/` / `src/` からの相対で解決）の `config.yaml`。

### Q4. 日時表現・仕様内の細部

- Task `due` は仕様上 `datetime | null` だが例は `2026-10-16`（日付のみ）。**推奨:** ISO 8601の日付（`YYYY-MM-DD`）と日時（Offset付き）の両方を受け付ける。Offsetなし日時の扱い（`defaults.timezone` 適用）はPhase 2のConnectorで決める。
- `config.yaml` の `version: 0.1` はYAML上で数値になる。**推奨:** 数値 `0.1` と文字列 `"0.1"` の両方を受け付け、内部では文字列 `"0.1"` に正規化する。
- CollectionItemのEntity名は `CollectionItem` だが `type` 値は `collection`（§5.5）。**推奨:** 仕様通り `type: "collection"`。
- 共通Metadataの `id` / `source` は「必要に応じて」とされている。**推奨:** Entity Schemaでは `id` 必須（外部Source由来の `todoist:<id>` 形式を想定）、Create Input Schemaでは `id` を持たない。

### Q5. TypeScriptのバージョン

npm最新は `7.0.2`（ネイティブ実装の新Major）、旧系は `6.0.3` / `5.9.3`。

- **推奨:** `typescript@~5.9.3` を採用する。7系はTool Chain（Vitest・エディタ統合等）との互換性実績が浅く、Phase 1の目的に対してリスクを取る理由がないため。安定確認後に別途Upgradeする。
- 代替: `^6.0.3` または `^7.0.2`。

### Q6. Lint / Format

Design Issueに記載がないため、Phase 1では導入しない（`tsc --strict` による型検査のみ）。必要であれば別Issueで ESLint + Prettier（またはBiome）を検討する。

### Q7. Directory Structureの差分

MVP §12からの差分として以下を追加する。仕様Directory構成への追記が必要か確認したい。

- `src/index.ts`（Entry Point。`server.ts` から起動処理を分離しテスト可能にするため）
- `src/instructions.ts`（§15のInstructions）
- `src/domain/common.ts`, `src/domain/index.ts`
- `src/tools/types.ts`, `src/tools/registry.ts`, `src/tools/index.ts`, `src/tools/foundation.ts`
- `src/connectors/types.ts`
- `docs/plans/`（Implementation Plan置き場）

逆に、仕様にある `src/tools/{task,schedule,...}.ts` と `src/connectors/{todoist,...}/` はPhase 1では作成しない。

### その他の懸念

- **stdout汚染:** `console.log` を1行でも出すとstdio transportが壊れる。Logは `console.error` のみ使用する方針をREADME（開発者向け節）に明記する。
- **Windows:** e2e Testで子プロセスを起動するため、`npx`/`tsx` 起動時のパス・`shell` 差異に注意する（SDKの `StdioClientTransport` は `cross-spawn` を使用しており対応済みの見込み）。
- **Delete操作:** §16「Delete → 原則ユーザー確認」はPhase 1にDelete Toolがないため対象外。Phase 2以降で扱う。
