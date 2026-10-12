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

Phase 1 — Foundationの実装計画作成前。仕様・開発ルール・Design Issueのみを配置した状態であり、コードは未実装。

Coding AgentがRepositoryを調査してImplementation Planを作成し、ChatGPTによるレビューとUser承認後に実装する。Install、Build、Test、起動手順はPhase 1の実装時に追加する。

## Documentation

- [MVP v0.1仕様](docs/specs/mvp-v0.1.md)
- [Phase 1 Design Issue](docs/specs/phase-1-foundation.md)
- [Development Workflow](docs/development/workflow.md)
- [Agent Guidelines](AGENTS.md)
