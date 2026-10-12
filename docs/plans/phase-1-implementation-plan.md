# Phase 1: Foundation — Implementation Plan

- Status: **Draft（Plan Review反映済み・再レビュー待ち）**
- 作成: Coding Agent (Claude Code) / 2026-10-12
- レビュー反映: ChatGPT / 2026-10-12
- 対象: [Phase 1 Design Issue](../specs/phase-1-foundation.md)
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

本Planが承認されるまで実装は開始しない。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Base Branch | `main` |
| Source Code | なし（`src/`, `tests/` 未作成） |
| Package管理 | `package.json`, lockfile なし |
| `.gitignore` | なし。Secret混入防止のため最初に追加する |
| Design | MVP仕様、Phase 1 Design Issue、Development Workflow、AGENTS.mdが存在 |
| 開発環境 | Node.js / npm / Windows 11。Phase 1はGreenfieldとして構築する |

---

## 2. 設計方針

1. **MVPを薄く保つ。** Phase 1ではFoundationを構成する最低限のMCP Server、Domain Model、Config、Tool登録構造、Connector境界のみを実装する。
2. **MCP TypeScript SDK v2を使用する。** Serverは `@modelcontextprotocol/server`、テスト用Clientは `@modelcontextprotocol/client` を利用する。v1の単一Package `@modelcontextprotocol/sdk` は使用しない。
3. **MCP SDKの機能を直接利用する。** 独自Tool Framework、Plugin Loader、DI Container、Base Class、Connector Registry、Generic Repository等は作らない。
4. **Zod SchemaをDomain Modelの正とする。** TypeScript型は `z.infer` で導出する。
5. **Domain EntityとTool Inputを分離する。** Entity SchemaはSoTから取得したデータの共通表現、Tool Input SchemaはAIから受け取る操作入力として別に扱う。Phase 1では実Toolを公開しないため、Tool Input Schemaを先行して大量定義しない。
6. **Provider固有型をDomainへ持ち込まない。**
7. **stdoutはMCP Protocol専用とする。** ログ・エラーはstderrへ出力する。
8. **Server生成とProcess起動を分離する。** `createServer()` はServerを構築し、Entry PointでConfig解決と `serveStdio()` を行う。
9. **Production Tool 0件を許容する。** Phase 1では外部Service Toolを公開しない。Tool登録構造はtest-only Toolで検証する。

---

## 3. 追加・変更予定ファイル

### 3.1 Project設定

| File | 種別 | 責務 |
|---|---|---|
| `.gitignore` | 追加 | `node_modules/`, `dist/`, `coverage/`, `.env`, Credential類を除外 |
| `.env.example` | 追加 | Phase 1で利用する環境変数名のみ記載。Secret値は記載しない |
| `package.json` | 追加 | ESM、Node.js要件、scripts、Dependencies |
| `package-lock.json` | 追加 | npmによる依存固定 |
| `tsconfig.json` | 追加 | strict TypeScript設定。Node.js型を明示 |
| `vitest.config.ts` | 追加 | Test設定 |
| `config.yaml` | 追加 | MVP §13の静的設定。Versionは文字列 `"0.1"` とする |

### 3.2 Domain（`src/domain/`）

| File | 責務 |
|---|---|
| `common.ts` | `AreaSchema`, `TagsSchema`, Date/DateTimeの共通Schemaなど、実際に複数Entityで共有する最小要素 |
| `task.ts` | `TaskStatusSchema`, `TaskSchema` |
| `schedule.ts` | `ScheduleSchema`。必要に応じて `end >= start` をValidation |
| `collection.ts` | `CollectionTypeSchema`, `CollectionItemSchema` |
| `knowledge.ts` | `KnowledgeSourceSchema`, `KnowledgeSchema` |
| `project.ts` | `ProjectSourceSchema`, `ProjectSchema` |
| `index.ts` | Domain Schema / Typeの再Export |

#### Domain Metadata方針

MVP仕様 §5.1 の共通Metadataは「必要に応じて」であり、全Entityへ一律必須とはしない。

- `Task`: 仕様§5.2の項目を基準とする。外部取得後のID等が必要になった場合に拡張する。
- `Schedule`: 仕様§5.3を基準とする。
- `Project`: `title`, `source`, `external_ref` を必須とする。
- `Knowledge`: `title`, `source`, `external_ref` を必須とする。
- `CollectionItem`: 仕様§5.5を基準とする。

`id` / `source` / `external_ref` を共通Base Schemaとして強制しない。

Tool Create / List / Update用のInput SchemaはPhase 2以降、Tool実装時にEntity Schemaとは別に定義する。

### 3.3 Config（`src/config/`）

| File | 責務 |
|---|---|
| `schema.ts` | `ConfigSchema`。未知Keyを拒否し、Provider値、Knowledge default/providers整合、Timezone等をValidation |
| `loader.ts` | `loadConfig(path)`: ファイル読込 → YAML parse → Schema Validation。失敗時はPath・Key Path・理由を含む `ConfigError` |

Config Pathの決定はLoaderへ入れない。

Entry Pointで以下の優先順位により解決する。

1. `--config <path>`
2. `AI_FOUNDATION_CONFIG`
3. Repository同梱の `config.yaml`

`loadConfig(path)` は与えられたPathを読み込むことだけに責務を限定する。

### 3.4 Connectors（`src/connectors/`）

| File | 責務 |
|---|---|
| `types.ts` | Phase 2で必要になる `TaskConnector` / `ScheduleConnector` のProvider非依存境界を最小限定義 |

Connector InterfaceではProvider SDK型を使わない。

Task / Schedule以外のConnector Interfaceは各Phaseで、実際のIFが確定してから追加する。

Phase 1ではProvider実装クラスやMock Connectorを作らない。

### 3.5 Tools（`src/tools/`）

Phase 1ではProduction Toolを公開しない。

| File | 責務 |
|---|---|
| `index.ts` | `registerTools(server, context)` を提供する。Phase 1では登録対象なし。Phase 2以降にMCP SDKの `server.registerTool()` を直接呼ぶTool登録処理を追加する |

独自 `ToolDefinition` 型、独自Registry、重複名検出Framework、共通Handler例外変換FrameworkはPhase 1では作らない。

Tool登録可能であることは、Test内でtest-only Toolを `McpServer.registerTool()` してClientから取得・呼出できることで検証する。

### 3.6 Server

| File | 責務 |
|---|---|
| `src/instructions.ts` | MVP §15 のAI向けInstructions |
| `src/server.ts` | `createServer({ config, connectors })`: `McpServer` を生成しInstructionsとProduction Tool登録処理を組み立てる。stdio接続は行わない |
| `src/index.ts` | Config Path解決 → `loadConfig` → `serveStdio(() => createServer(...))`。Errorはstderr、失敗時は非0終了 |

stdioはMCP TypeScript SDK v2の `@modelcontextprotocol/server/stdio` を使用する。

### 3.7 Tests（`tests/`）

| File | 内容 |
|---|---|
| `tests/domain/*.test.ts` | Entityごとの正常系・異常系Validation |
| `tests/config/schema.test.ts` | Config Schema正常系・異常系 |
| `tests/config/loader.test.ts` | File読込、YAML Error、Validation Error、可読なError Message |
| `tests/fixtures/config/*.yaml` | Config Fixture |
| `tests/server.test.ts` | InMemoryTransportでClient/Server接続。Production Tool 0件を確認し、test-only Toolを用いたTool登録・呼出を別ケースで検証 |
| `tests/e2e/stdio.test.ts` | `@modelcontextprotocol/client` の `StdioClientTransport` で実Processへ接続。Handshake / Tool一覧取得、不正Config時の起動失敗を検証 |

import文を走査する独自Architecture TestはPhase 1では作らない。Domain / Connector境界はTypeScript型検査とCode Reviewで確認する。

### 3.8 Documentation

| File | 変更 |
|---|---|
| `README.md` | Prerequisites、Install / Build / Test / 起動、MCP Client登録例、Config Path、stdout/stderr注意事項 |
| `docs/plans/phase-1-implementation-plan.md` | 本Plan |

---

## 4. 依存Package

npmを使用する。実装時点のStable版を採用し、`package-lock.json` で固定する。

### dependencies

| Package | 用途 |
|---|---|
| `@modelcontextprotocol/server` | MCP Server v2 / stdio / InMemoryTransport |
| `zod` | Domain / Config / Tool Schema |
| `yaml` | `config.yaml` 読込 |

### devDependencies

| Package | 用途 |
|---|---|
| `@modelcontextprotocol/client` | MCP v2 Test Client / StdioClientTransport |
| `typescript` | Build / Typecheck。Stable版を使用 |
| `@types/node` | Node.js型 |
| `vitest` | Test Runner |
| `tsx` | Development / e2e実行 |

MCP v1 Package `@modelcontextprotocol/sdk` は使用しない。

Phase 1ではProvider SDK、dotenv、ESLint / Prettier / Biomeは導入しない。

---

## 5. npm scripts

```text
build      tsc -p tsconfig.json
typecheck  tsc --noEmit
test       vitest run
dev        tsx src/index.ts
start      node dist/index.js
```

---

## 6. Test Strategy

### 6.1 方針

- 外部Serviceへの通信は行わない。
- Schemaは正常系だけでなく、拒否すべき入力を重点的にTestする。
- MCP ServerはInMemoryと実stdioの両方を最低限確認する。
- Implementation Review前に `npm run typecheck && npm test && npm run build` を成功させる。

### 6.2 Domain Schema

| Entity | 主な確認 |
|---|---|
| Task | status、title、dueの日付-only / offset付きdatetime、nullable項目 |
| Schedule | start必須、offset付きdatetime、不正日時、`end < start` |
| CollectionItem | collection_type、status、metadata |
| Knowledge | source、external_ref |
| Project | source、external_ref |

Task `due` はISO 8601の日付（`YYYY-MM-DD`）またはOffset付きdatetimeを許可する。

Scheduleの `start/end` はOffset付きdatetimeを基本とする。Timezone補完等はPhase 2のConnector設計で扱う。

### 6.3 Config

| Case | 期待結果 |
|---|---|
| 同梱 `config.yaml` | 成功 |
| Fileなし | `ConfigError` |
| YAML構文Error | `ConfigError` |
| 必須Key欠落 | `ConfigError` |
| 不正Provider | `ConfigError` |
| knowledge.default不整合 | `ConfigError` |
| 不正Timezone | `ConfigError` |
| 未知Key（`projects`, Token等） | `ConfigError` |
| `version: "0.1"` | 成功 |
| 数値 `version: 0.1` | Error |

### 6.4 MCP Server / Tool Structure

- `createServer()` がInMemory TransportでClient接続できる。
- Phase 1 Production ServerのTool一覧は空でよい。
- Test専用ServerまたはTest Setupで `registerTool()` したToolがClientからlist/callできる。
- stdio e2eでServer起動とTool一覧取得が成功する。
- stdoutへProtocol以外の文字列を出さない。
- 不正Configでは非0終了し、stderrに理由を出す。

---

## 7. 実装順序

| # | Step | 成果物 | 完了条件 |
|---|---|---|---|
| 1 | Project Scaffold | `.gitignore`, package設定、TypeScript / Vitest、Dependencies | Build / Typecheck / Test環境が動作 |
| 2 | Domain Model | `src/domain/*` + Domain Test | Domain Test成功 |
| 3 | Config | `src/config/*`, `config.yaml`, `.env.example` + Test | Config Test成功 |
| 4 | Connector Boundary | `src/connectors/types.ts` | Typecheck成功 |
| 5 | Tool Registration Boundary | `src/tools/index.ts` | Phase 2でToolを追加可能な薄い構造 |
| 6 | MCP Server | `instructions.ts`, `server.ts`, `index.ts` + InMemory / stdio Test | Server接続、Tool一覧取得、Error処理が成功 |
| 7 | Documentation | README更新 | READMEのみでSetup / Test / 起動を再現可能 |
| 8 | Final Check | — | Build / Typecheck / Test成功、Secretや生成物がCommit対象外 |

---

## 8. Acceptance Criteriaとの対応

| AC | 対応 / 検証 |
|---|---|
| stdioでMCP Serverを起動できる | `serveStdio()` + stdio e2e |
| ClientからServerへ接続しTool一覧を取得できる | Production Tool 0件を許容し、stdio / InMemoryで `listTools()` 成功を確認 |
| Tool登録構造が存在する | test-only ToolをSDK `registerTool()` で登録しlist/callを検証 |
| 5 EntityのSchema | `src/domain/*.ts` + Domain Test |
| Provider SDK型非依存 | Provider SDK自体をPhase 1で導入せず、Code Review / Typecheckで確認 |
| `config.yaml` 読込 / Validation | Config Test |
| 不正Configで理解可能なError | Loader Test + e2e |
| 個別Project情報をConfigへ含めない | strict Config Schema +未知Key Test |
| Connector境界 | Task / Schedule Connector Interface + Typecheck |
| SecretをCommitしない | `.gitignore`, `.env.example`, Final Check |
| Automated Test | Domain / Config / MCP Server tests |
| README | Install / Build / Test / 起動方法を記載 |

---

## 9. Plan Reviewで確定した事項

1. **MCP SDK:** v2 stableを使用する。Serverは `@modelcontextprotocol/server`、テストClientは `@modelcontextprotocol/client`。
2. **Phase 1 Production Tool:** 追加しない。`foundation_info` は作成しない。Production Tool 0件を許容する。
3. **Tool登録:** MCP SDK `registerTool()` を直接利用し、独自Tool Frameworkは作らない。
4. **Connector Interface:** Phase 2対象のTask / Scheduleのみ先行定義する。
5. **Config Path:** `--config` → `AI_FOUNDATION_CONFIG` → Repository同梱Config。Path解決はEntry Pointの責務。
6. **Config version:** `"0.1"` の文字列固定。数値との両対応やnormalizeは行わない。
7. **Domain Metadata:** `id/source/external_ref` を全Entity共通必須にしない。仕様の各Entity定義を優先する。
8. **日時:** Task dueは日付-onlyまたはOffset付きdatetime。ScheduleはOffset付きdatetimeを基本とする。
9. **Architecture Test:** import走査等の独自Testは導入しない。必要性が出た時点で追加する。
10. **Lint / Format:** Phase 1では導入しない。
11. **Directory Structure:** Phase 1で必要なFileのみ作る。空File / 空Directoryを仕様に合わせるためだけに作らない。
12. **stdout:** Protocol専用。Logはstderrのみ。
