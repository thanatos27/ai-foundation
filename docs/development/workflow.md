# Development Workflow

AI Foundationでは、設計・実装・レビューの責務を分離する。

## Roles

### User + ChatGPT

以下を担当する。

- 要件整理
- 基本設計
- MVP / Phase Scopeの決定
- Acceptance Criteriaの策定
- Implementation Planのレビュー
- 最終的な設計承認

### Coding Agent

Claude Code等のCoding Agentは以下を担当する。

- Repositoryの調査
- Implementation Planの作成
- Implementation Planのレビュー指摘反映
- 実装
- Automated Testの作成・実行
- 実装レビュー指摘の修正

Implementation Planでは、現在のRepository構成・依存関係・既存実装を調査したうえで、変更対象ファイル、実装順序、テスト方針を具体化する。

要件・Acceptance Criteriaそのものを変更する場合は、実装前に確認する。

### Codex

実装完了後の独立したImplementation Reviewを担当する。

主な確認対象：

- Acceptance Criteriaへの適合
- 設計との整合性
- 不具合
- エラーハンドリング
- Security
- Maintainability
- Test Coverage

## Workflow

```text
Requirements / Design
        ↓
Acceptance Criteria
        ↓
Implementation Plan
   (Coding Agent)
        ↓
Plan Review
   (ChatGPT)
        ↓
Plan Fix
   (Coding Agent)
        ↓
User Approval
        ↓
Implementation
   (Coding Agent)
        ↓
Automated Test
        ↓
Implementation Review
      (Codex)
        ↓
Fix / Re-review
        ↓
Merge
```

Implementation Planが承認されるまでは、本実装を開始しない。

実装後はAutomated Testを成功させたうえでImplementation Reviewへ進む。
