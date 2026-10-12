# AI Foundation Agent Guidelines

## Project

各サービスをSource of Truthとして維持し、AIから統一的に読み書きするMCP Serverを開発する。

## Source of Truth

| Entity | Source of Truth |
|---|---|
| Task | Todoist |
| Schedule | Google Calendar |
| CollectionItem | Notion |
| Knowledge | Obsidian / Google Drive |
| Project | GitHub / Google Drive |

AI Foundation自身を情報の正本にしない。同一情報のAuthoritative Copyを複数Sourceへ作成しない。

## Architecture Principles

Foundationの責務はDomain Model、Tool Interface、SoTルール、Connector、Configurationに限定する。

MVPではAI Agent Runtime、Workflow Engine、Intent Classifier、独自Databaseを実装しない。Routingや複数Toolの組み合わせはAI Client側に任せる。

| Layer | 責務 |
|---|---|
| Domain | Providerに依存しない共通Data Model |
| Tools | AIへ公開するMCP Interface。Provider固有APIを直接公開しない |
| Connectors | Provider固有処理。AI判断やPlanningを持たない |
| Config | 静的設定。個別Project名・Project ID・Task等の動的データを列挙しない |

認証情報をconfigへ保存せず、RepositoryへCommitしない。

## Development Workflow

[Development Workflow](docs/development/workflow.md)に従う。

- 要件・基本設計・Acceptance CriteriaはUserとChatGPTが確定する
- Coding AgentはRepositoryを調査してImplementation Planを作成する
- ChatGPTのPlan Review、Coding Agentの修正、User承認を終えてから実装する
- 実装後はAutomated Testを成功させ、Codexによる独立したImplementation Reviewを受ける

## Specification

MVPの要件とData Modelは[MVP v0.1仕様](docs/specs/mvp-v0.1.md)を正とする。Phase 1のScopeとAcceptance Criteriaは[Phase 1 Design Issue](docs/specs/phase-1-foundation.md)を参照する。

変更前に既存ドキュメントとRepositoryを確認する。仕様と実装計画が衝突した場合は、仕様を勝手に変更せず確認する。
