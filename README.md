# AI Foundation

各サービスをSource of Truthとして維持しながら、Task / Schedule / Collection / Knowledge / ProjectをAIから統一的に操作するMCPベースの個人AI基盤。

## Source of Truth

| Entity | Source of Truth |
|---|---|
| Task | Todoist |
| Schedule | Google Calendar |
| CollectionItem | Notion |
| Knowledge | Obsidian / Google Drive |
| Project | GitHub / Google Drive |

AI Foundation自身は独自DBを持たず、共通Data Model、Tool Interface、SoTルール、Connector、静的設定を提供する。Routingと複数Toolの組み合わせはAI Clientが判断する。

## Current Phase

Phase 1 — Foundation。MCP Server（stdio）、Domain Model、Config、Tool登録構造、Connector境界を実装済み。

外部Serviceとの実接続はPhase 2以降のため、現時点で公開しているToolは0件。

## Getting Started

### Prerequisites

- Node.js 22.12以上（開発環境: Node.js 24）
- npm

### Install

```sh
npm install
```

### Build

```sh
npm run build
```

`dist/` にJavaScriptが出力される。

### Test

```sh
npm run typecheck
npm test
```

### Start the MCP Server

MCP ServerはMCP Clientからstdioで起動される。手動で起動確認する場合は以下を使う。

```sh
npm start        # node dist/index.js（要Build）
npm run dev      # tsx src/index.ts（Build不要）
```

起動するとstdinでMCPメッセージを待ち受ける。終了はCtrl+C。

## Configuration

静的設定は `config.yaml` に記述する（仕様: [MVP v0.1 §13](docs/specs/mvp-v0.1.md)）。Project一覧などの動的データやToken等の認証情報は記述しない。未知のKeyを含むConfigは起動時にErrorとなる。

読み込むファイルは以下の優先順位で決まる。

1. `--config <path>` 引数
2. 環境変数 `AI_FOUNDATION_CONFIG`
3. Repository直下の `config.yaml`

Configが不正な場合、理由をstderrへ出力して終了コード1で終了する。

```text
[ai-foundation] Invalid configuration in config.yaml:
  - sources.task.provider: Invalid input: expected "todoist"
```

認証情報は環境変数で渡す（Phase 2以降で使用）。変数名は [.env.example](.env.example) を参照。`.env` はCommitしない。

## Register with an MCP Client

Build後、`dist/index.js` の絶対パスを指定して登録する。MCP Clientは任意のディレクトリでServerを起動するため、パスは絶対パスで指定する。

Claude Code:

```sh
claude mcp add ai-foundation -- node /absolute/path/to/ai-foundation/dist/index.js
```

Codex（`~/.codex/config.toml`）:

```toml
[mcp_servers.ai-foundation]
command = "node"
args = ["/absolute/path/to/ai-foundation/dist/index.js"]
```

別の場所のConfigを使う場合は `--config <path>` を引数に追加するか、`AI_FOUNDATION_CONFIG` を設定する。

## Development

### Directory Structure

```text
src/
├─ domain/       Provider非依存のEntity Schema（Zod）
├─ config/       config.yamlのSchemaとLoader
├─ connectors/   Connector境界（Provider固有処理のInterface）
├─ tools/        MCP Toolの登録
├─ instructions.ts  AI Clientへ送るInstructions
├─ server.ts     MCP Serverの組み立て
└─ index.ts      Entry Point（Config読込・stdio起動）
tests/
```

### Adding Tools (Phase 2以降)

Entityごとに `src/tools/<entity>.ts` を作成し、`register<Entity>Tools(server, context)` 内でSDKの `server.registerTool()` を直接呼ぶ。作成した関数を `src/tools/index.ts` の `registerTools` から呼び出す。Provider固有処理は `src/connectors/<provider>/` に置き、Toolからは `context.connectors` 経由で利用する。

### Logging

stdoutはMCPのJSON-RPC専用。`console.log` を使うとstdio通信が壊れるため、ログは `console.error`（stderr）へ出力する。

## Documentation

- [MVP v0.1仕様](docs/specs/mvp-v0.1.md)
- [Phase 1 Design Issue](docs/specs/phase-1-foundation.md)
- [Phase 1 Implementation Plan](docs/plans/phase-1-implementation-plan.md)
- [Development Workflow](docs/development/workflow.md)
- [Agent Guidelines](AGENTS.md)
