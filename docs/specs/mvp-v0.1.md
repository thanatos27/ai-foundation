# AI Foundation MVP v0.1 仕様書

## 1. 目的

AI Foundationは、私生活・仕事で利用している各種サービスをAIから統一的に扱うための基盤である。

各サービスに存在するデータをAI Foundation内部へ集約するのではなく、情報の性質に適したサービスを **Source of Truth（SoT）** として維持する。

AI Foundationは、それらのサービスをAIから統一的に読み書きするための共通インターフェースを提供する。

主な利用例：

- 今日やるタスクを確認する
- 期限付きタスクを登録する
- カレンダーへ予定を登録する
- 読みたい本・遊びたいゲームを登録する
- 本やゲームの感想・攻略情報を追記する
- 学習内容や気づきをKnowledgeとして保存する
- GitHub上のProject情報を参照する

---

## 2. 基本方針

### 2.1 Source of Truthは各サービス側に置く

AI Foundation独自DBへ各サービスのデータを複製しない。

例：

```text
Task
→ Todoist

Schedule
→ Google Calendar

Collection
→ Notion

Knowledge
→ Google Drive / Obsidian

Project
→ GitHub / Google Drive
```

AI Foundationはこれらを操作するためのハブとして機能する。

---

### 2.2 AI FoundationはRouting + Tool Layer

ユーザーは原則として保存先を意識しない。

例えば、

```text
「金曜までに経費精算」
→ Task
→ Todoist
```

```text
「この映画面白そう」
→ Collection
→ Notion
```

```text
「今日CAP定理について理解したことをメモ」
→ Knowledge
→ Obsidian
```

AI自身がデータ構造・SoT・Tool定義をもとに適切な操作を判断する。

MVPでは専用のIntent ClassifierやWorkflow Engineは実装しない。

---

### 2.3 情報を重複して管理しない

同じ情報の正本を複数サービスに作らない。

特にKnowledgeについては以下のルールとする。

### Notion

対象そのものに依存する情報。

例：

- 本の感想
- 本の読了状態
- ゲーム攻略メモ
- ゲームのプレイ状況
- 映画の評価
- Collection固有メモ

### Obsidian / Google Drive

対象から独立して再利用できる知識。

例：

- 本から学んだ分散システムの知識
- ゲームから得たUI設計上の気づき
- AWSの学習内容
- 技術調査
- 個人的な考察

### GitHub

Projectそのものを進めるための情報。

例：

- README
- 設計書
- ADR
- Issue
- 実装仕様
- 開発メモ

---

## 3. Entity

MVPでは以下の5種類を共通Entityとする。

```text
Task
Schedule
Project
CollectionItem
Knowledge
```

`Today`、`Waiting`、`Someday`などは独立Entityではなく、StatusやViewとして扱う。

---

## 4. Area

仕事と私生活はEntityとは独立した属性として扱う。

```text
work
personal
```

例：

```yaml
type: task
title: 経費精算
area: work
```

学習などは独立Areaとせず、必要に応じてTagを利用する。

---

## 5. Data Model

### 5.1 共通Metadata

必要に応じて各Entityは以下の情報を持つ。

```yaml
id: string
type: string
title: string

area: work | personal | null
tags: string[]

source: string
external_ref: string | null
```

MVPではAI Foundation独自DBを持たないため、`id` は以下のような外部Source由来のIDでもよい。

```text
todoist:<id>
notion:<page-id>
github:<owner>/<repository>
```

---

### 5.2 Task

実行する必要がある具体的な行動。

Source of Truth:

```text
Todoist
```

Schema:

```yaml
type: task
title: string

status:
  inbox |
  next |
  waiting |
  someday |
  done

due: date | datetime | null

area: work | personal | null

project_ref: string | null

tags: string[]
```

例：

```yaml
type: task
title: 経費精算
status: next
due: 2026-10-16
area: work
project_ref: null
tags:
  - accounting
```

### TaskとScheduleの違い

```text
10/20までに資料提出
→ Task

10/18 20:00から資料を書く
→ Schedule
```

Taskの`due`は締切であり、Calendar上の作業時間とは分離する。

---

### 5.3 Schedule

特定日時に存在する予定・作業時間。

Source of Truth:

```text
Google Calendar
```

Schema:

```yaml
type: schedule
title: string

start: date | datetime
end: date | datetime | null

tags: string[]
```

---

### 5.4 Project

複数Taskや成果物を含む活動単位。

Source of Truth:

```text
GitHub
Google Drive
```

MVPではProjectの詳細Metadata設計は行わない。

最低限以下のみ扱う。

```yaml
type: project
title: string

source: github | google_drive

external_ref: string
```

Project一覧を`config.yaml`へ記述しない。

Projectは各SoT上に存在する動的データとして扱う。

ProjectのDiscovery方法、Status、Area、複数Source間の関連付け等は将来設計する。

---

### 5.5 CollectionItem

本、ゲーム、映画など、所有・候補・消費状況を管理するEntity。

Source of Truth:

```text
Notion
```

Schema:

```yaml
type: collection
title: string

collection_type:
  game |
  book |
  movie |
  other

status: string

metadata: object

tags: string[]
```

例：

```yaml
type: collection
title: ペルソナ3 リロード

collection_type: game
status: playing

metadata:
  platform: Xbox
  rating: null
```

本の場合：

```yaml
type: collection
title: Designing Data-Intensive Applications

collection_type: book
status: read

metadata:
  author: Martin Kleppmann
  rating: 5
```

Collection固有の感想・攻略情報等はNotion Page本文へ保存してよい。

---

### 5.6 Knowledge

長期的に再利用可能な学習内容・気づき・考察。

Source of Truth:

```text
Obsidian / Google Drive
```

Schema:

```yaml
type: knowledge
title: string

source:
  obsidian |
  google_drive

external_ref: string

area: work | personal | null

tags: string[]
```

本文そのものは共通Metadataへ複製せず、必要時にSoTから取得する。

---

## 6. Source of Truth

MVPでは以下を正式なSoTとする。

| Entity | Source of Truth |
|---|---|
| Task | Todoist |
| Schedule | Google Calendar |
| CollectionItem | Notion |
| Knowledge | Obsidian / Google Drive |
| Project | GitHub / Google Drive |
| 一般ファイル | Google Drive |

---

## 7. AI向けRouting Rule

専用Routing Engineは実装しない。

AIへ以下の意味を伝え、Tool Callingによって判断させる。

```text
Task
= ユーザーが実行する必要のある具体的な行動

Schedule
= 特定日時に発生するイベント・作業時間

Collection
= 本、ゲーム、映画などのCollectionと、
  そのアイテム固有の情報

Knowledge
= 他の文脈でも再利用できる学習・知識・気づき

Project
= Projectそのものに関連する設計・進捗・成果物
```

### Someday

「いつか」は保存先ではない。

例：

```text
Rustをいつか触りたい
→ Task / someday

映画○○をいつか見たい
→ Collection / wishlist
```

情報の性質によって判断する。

---

## 8. AI Foundation Interface

MVPでは以下の最低限のIFを提供する。

### Task

```text
task_create
task_list
task_update
task_complete
```

### Schedule

```text
schedule_create
schedule_list
```

### Collection

```text
collection_create
collection_search
collection_update
```

### Knowledge

```text
knowledge_create
knowledge_search
knowledge_append
```

### Project

```text
project_get
project_list
```

CRUDを完全に揃えることはMVPの要件としない。

必要になった操作から追加する。

---

## 9. Tool Example

### task_create

Input:

```json
{
  "title": "string",
  "status": "inbox | next | waiting | someday",
  "due": "date | datetime | null",
  "area": "work | personal | null",
  "tags": ["string"]
}
```

---

### task_list

```json
{
  "status": ["next"],
  "area": "work",
  "due_before": "date | datetime | null",
  "due_after": "date | datetime | null",
  "tags": ["string"]
}
```

---

### schedule_create

```json
{
  "title": "string",
  "start": "date | datetime",
  "end": "date | datetime | null"
}
```

---

### collection_create

```json
{
  "title": "string",
  "collection_type": "game | book | movie | other",
  "status": "string",
  "metadata": {},
  "tags": [],
  "note": "string | null"
}
```

---

### collection_update

```json
{
  "id": "string",
  "status": "string | null",
  "metadata": {},
  "tags": ["string"],
  "append_note": "string | null"
}
```

---

### knowledge_create

```json
{
  "title": "string",
  "content": "string",
  "source": "obsidian | google_drive | auto",
  "area": "work | personal | null",
  "tags": ["string"]
}
```

MVPでは、

```text
source = auto
```

の場合、Obsidianを既定値としてよい。

---

## 10. Architecture

AI Foundationは独自Agent Runtimeではなく、MCP Serverとして実装する。

```text
ChatGPT / Codex / Claude Code / Gemini / Future UI
                         │
                        MCP
                         │
                         ▼
                AI Foundation
                ┌──────────────┐
                │ Domain Model │
                │ Tool IF      │
                │ SoT Rules    │
                └──────┬───────┘
                       │
                   Connectors
       ┌────────┬──────┼───────┬────────┐
       ▼        ▼      ▼       ▼        ▼
    Todoist  Calendar Notion Obsidian  GitHub
```

MVPではローカル利用を前提とする。

Transport:

```text
stdio
```

将来的に必要となった場合、

```text
Streamable HTTP
```

等へ拡張する。

---

## 11. Technology Stack

```text
Runtime:
Node.js

Language:
TypeScript

MCP:
Model Context Protocol TypeScript SDK

Schema:
Zod

Task:
Todoist API / TypeScript SDK

Schedule:
Google Calendar API

Collection:
Notion API

Knowledge:
Node.js File System
→ Obsidian Vault

Project:
GitHub API
Google Drive API

Config:
YAML

Secret:
Environment Variable / .env

Test:
Vitest
```

---

## 12. Directory Structure

```text
ai-foundation/
├─ src/
│  ├─ domain/
│  │  ├─ task.ts
│  │  ├─ schedule.ts
│  │  ├─ collection.ts
│  │  ├─ knowledge.ts
│  │  └─ project.ts
│  │
│  ├─ tools/
│  │  ├─ task.ts
│  │  ├─ schedule.ts
│  │  ├─ collection.ts
│  │  ├─ knowledge.ts
│  │  └─ project.ts
│  │
│  ├─ connectors/
│  │  ├─ todoist/
│  │  ├─ google-calendar/
│  │  ├─ notion/
│  │  ├─ obsidian/
│  │  └─ github/
│  │
│  ├─ config/
│  │  ├─ schema.ts
│  │  └─ loader.ts
│  │
│  └─ server.ts
│
├─ tests/
├─ config.yaml
├─ .env.example
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

## 13. Config

`config.yaml`は静的なFoundation設定のみ保持する。

個別Project等の動的データは保存しない。

```yaml
version: "0.1"

defaults:
  area: personal
  timezone: Asia/Tokyo

sources:
  task:
    provider: todoist

  schedule:
    provider: google_calendar
    writable_calendar_id: "<AI Foundation Calendar ID>"

  collection:
    provider: notion
    data_source_id: "<AI Foundation Collection Data Source ID>"

  knowledge:
    default: obsidian
    providers:
      - obsidian
      - google_drive

  project:
    providers:
      - github
      - google_drive
```

認証情報はconfigへ保存しない。

以下のいずれかを使用する。

```text
Environment Variables
.env
OS Credential Store
```

---

## 14. Connector責務

Connectorは外部サービス固有処理のみ担当する。

例：

```text
Task Domain Model
        ↓
TodoistConnector
        ↓
Todoist API
```

Connectorの責務：

```text
Authentication
API communication
Domain → Provider conversion
Provider → Domain conversion
```

以下はConnectorへ実装しない。

```text
AI判断
Task優先順位付け
Planning
Intent Routing
Workflow
```

---

## 15. AI側へ提供するInstructions

AIには少なくとも以下を伝える。

```text
AI Foundation manages information across multiple Sources of Truth.

Task:
Executable actions.
Source of Truth: Todoist.

Schedule:
Events and time blocks tied to a specific time.
Source of Truth: Google Calendar.

Collection:
Books, games, movies and item-specific information.
Source of Truth: Notion.

Knowledge:
Reusable learning, thoughts and insights.
Source of Truth: Obsidian / Google Drive.

Project:
Project-specific information.
Source of Truth: GitHub / Google Drive.

Use the provided tools to read and modify these sources.

Do not create duplicate authoritative information across multiple sources.
```

Routingや複雑な操作手順はAI自身に判断させる。

---

## 16. Safety / Operation Policy

MVPでは複雑なRisk Engineは実装しない。

最低限以下のみ守る。

```text
Read
→ 原則許可

Create
→ 原則許可

Update
→ 通常操作は許可

Delete
→ 原則ユーザー確認

大量変更
→ ユーザー確認

外部への情報送信
→ ユーザー確認
```

Tool Schemaによる入力Validationは必須とする。

---

## 17. MVP Development Phases

### Phase 1 — Foundation

実装対象：

```text
MCP Server
Domain Model
Config
Tool registration
Connector interface
```

外部Connectorを追加できる基盤を構築する。実サービスConnectorの実装・実接続はPhase 2以降とする。

詳細なScopeとAcceptance Criteriaは[Phase 1 Design Issue](phase-1-foundation.md)を参照する。

---

### Phase 2 — Task / Schedule

対象：

```text
Todoist
Google Calendar
```

対応操作：

```text
task_create
task_list
task_update
task_complete

schedule_create
schedule_list
```

このPhase終了時点で日常タスク管理に利用可能とする。

詳細なScopeとAcceptance Criteriaは[Phase 2 Design Issue](phase-2-task-schedule.md)を参照する。

---

### Phase 3 — Collection

対象：

```text
Notion
```

対応操作：

```text
collection_create
collection_search
collection_update
```

本・ゲーム・映画の管理と、アイテム固有メモを扱えること。

詳細なScopeとAcceptance Criteriaは[Phase 3 Design Issue](phase-3-collection.md)を参照する。

---

### Phase 4 — Knowledge

対象：

```text
Obsidian
```

対応操作：

```text
knowledge_create
knowledge_search
knowledge_append
```

Google Drive対応は必要性に応じて追加する。

---

### Phase 5 — Project

対象：

```text
GitHub
Google Drive
```

MVPでは主に参照用途とする。

```text
project_get
project_list
```

Project MetadataやDiscovery方式は将来設計する。

---

## 18. Acceptance Criteria

AI Foundation MVPは、AIクライアントから自然言語で依頼し、定義済みData Model / SoT / IFに従って各サービスを読み書きできれば成立とする。

最低限以下のシナリオを確認する。

### Task

```text
「金曜までに経費精算」
```

TodoistへTaskが作成される。

---

### Schedule

```text
「土曜14時からAI Foundationを1時間進める」
```

Google Calendarへ予定が作成される。

---

### Collection

```text
「この本を積読に追加」
```

NotionへCollectionItemが作成される。

---

### Collection Note

```text
「このゲームをクリアした。感想は○○」
```

Notion上の既存Itemが更新され、感想が追記される。

---

### Knowledge

```text
「今日CAP定理について理解した内容をメモして」
```

ObsidianへKnowledgeが保存される。

---

### Project

```text
「physical-ai-robotの情報を確認」
```

GitHubからProject情報を取得できる。

---

### Compound Operation

```text
「今週のタスクと予定を見て、今日やることを整理して」
```

AIが必要な複数Toolを自律的に呼び出し、結果を組み合わせて回答できる。

専用Workflowの実装は不要とする。

---

## 19. MVP対象外

以下はv0.1では実装しない。

```text
独自Database
Registry DB
Vector DB
RAG
横断検索 / compare
Multi-Agent
Workflow Engine
Intent Classifier
独自Planner
自動Task抽出
メール・Slack自動監視
Dashboard
Voice UI
Robot UI
Project Metadataの詳細設計
高度なPermission / Risk Engine
自動Scheduler
```

必要性が確認できた段階で追加する。

---

## 20. 将来拡張

想定する拡張：

```text
Knowledge Registry
Cross-source Search
RAG
Dashboard
Voice Input / Speaker
Smart Speaker
Robot Interface
Gmail / Slack Integration
Task Auto Extraction
Automation
Remote MCP
Multi AI
compare / discuss
```

これらはMVPのData Model / SoT / Tool IFを維持したまま追加可能な構造とする。

---

## 21. MVP設計原則

AI Foundation v0.1では以下を優先する。

1. Source of Truthを守る
2. データ構造をAIへ明確に伝える
3. AIへ操作可能なIFを明確に提供する
4. AIがToolを組み合わせて柔軟に判断できるようにする
5. Foundation自身は可能な限り薄く保つ
6. 必要性が確認されるまで抽象化・自動化を追加しない

AI Foundationの役割は、

```text
「情報を保存する場所」
```

ではなく、

```text
「AIが自分のデジタル環境を統一的に扱うための基盤」
```

とする。
