# Phase 1: Foundation — Design Issue

## Goal

AI Foundation MVPの基盤となるMCP Server、共通Data Model、Configuration、Tool登録機構、Connector境界を構築する。

このPhaseではTodoist、Google Calendar、Notion等との本格的な外部Service連携は行わない。

外部Connectorを追加できるFoundationを完成させることを目的とする。

## References

- `docs/specs/mvp-v0.1.md`
- `docs/development/workflow.md`
- `AGENTS.md`

## Scope

Phase 1では以下を対象とする。

```text
MCP Server
Domain Model
Config Loader / Validation
MCP Tool Registration Structure
Connector Interface / Boundary
Automated Test Infrastructure
```

技術スタックは以下を基本とする。

```text
Node.js
TypeScript
Model Context Protocol
Zod
YAML
Vitest
stdio transport
```

## Domain Model

MVP仕様に従い、以下のEntityを扱える構造を用意する。

```text
Task
Schedule
Project
CollectionItem
Knowledge
```

Provider固有のData ModelをDomainへ持ち込まないこと。

## Config

MVP仕様に従った静的Configurationを読み込めること。

個別Project名やProject IDなどの動的データはconfigへ含めない。

認証情報はconfigおよびRepositoryへ保存しない。

## Out of Scope

Phase 1では以下を実装しない。

```text
Todoist実接続
Google Calendar実接続
Notion実接続
Google Drive実接続
GitHub実接続

独自Database
Registry
RAG
Intent Classifier
Workflow Engine
Agent Runtime
Dashboard
Voice
Cross-source Search
```

必要以上の抽象化を追加しないこと。

## Acceptance Criteria

### MCP Server

ローカル環境からstdio transportでMCP Serverを起動できる。

ClientからServerへ接続し、Tool一覧を取得できる。Phase 1ではProduction Toolが0件でもよい。

Tool登録機構はTest内のtest-only Toolを用いて、ClientからTool情報取得・呼出が可能であることを検証する。

### Domain Model

Task、Schedule、Project、CollectionItem、Knowledgeの共通Schemaが定義されている。

Schema Validationが可能である。

Domain ModelがTodoist、Notion等のProvider SDK型へ直接依存していない。

### Configuration

`config.yaml`を読み込める。

Configuration SchemaによるValidationが行われる。

不正なConfigurationの場合、理解可能なErrorを返して起動に失敗する。

個別Project情報がConfiguration Schemaへ含まれていない。

### Tool Structure

MCP Toolを追加・登録するための基本構造が存在する。

Phase 2以降でTask / Schedule Toolを追加できる構成になっている。

Phase 1で外部Serviceの疑似実装を大量に作る必要はない。

### Connector Boundary

Provider固有処理をDomain / Toolから分離するためのConnector境界が定義されている。

実サービスConnectorの実装はPhase 2以降とする。

### Security

Token、API Key、Credential等がRepositoryへCommitされない。

`.env.example`にはSecretそのものを記載しない。

### Automated Test

Config Validationおよび主要Domain SchemaについてAutomated Testが存在する。

Test Suiteが正常終了する。

### Documentation

ローカルでのInstall、Build、Test、MCP Server起動方法がREADMEから確認できる。

## Coding Agent Task

Repository全体と上記Referenceを確認し、Phase 1のImplementation Planを作成すること。

Implementation Planには少なくとも以下を含める。

```text
現在のRepository状態
追加・変更予定ファイル
実装順序
各変更の責務
依存Package
Test Strategy
Acceptance Criteriaとの対応
懸念点 / 未確定事項
```

Implementation Plan作成時点では本実装を開始しないこと。

PlanをRepository内の適切な場所へMarkdownとして作成し、レビュー可能な状態にすること。
