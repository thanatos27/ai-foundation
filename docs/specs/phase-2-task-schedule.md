# Phase 2: Task / Schedule — Design Issue

## Goal

AI FoundationからTodoistとGoogle Calendarを実際に操作できるようにし、日常のTask / Schedule管理に利用可能な状態にする。

Phase 1で構築したMCP Server、Domain Model、Tool登録構造、Connector境界を利用し、Provider固有処理はConnectorへ閉じ込める。

## References

- `docs/specs/mvp-v0.1.md`
- `docs/specs/phase-1-foundation.md`
- `docs/development/workflow.md`
- `AGENTS.md`

## Scope

### Task / Todoist

実装するTool:

```text
task_create
task_list
task_update
task_complete
```

### Schedule / Google Calendar

実装するTool:

```text
schedule_create
schedule_list
```

## Task / Todoist Design

### Storage Location

AI Foundationから作成するTaskはすべてTodoist Inboxへ保存する。

Todoist Projectへの振り分けはPhase 2では行わない。

### Task ID

Taskの識別にはTodoist Task IDを利用し、AI Foundationでは以下の形式で返す。

```text
todoist:<task-id>
```

更新・完了はID指定で行う。Titleによる直接更新や曖昧検索ロジックはFoundationへ実装しない。

自然言語から対象Taskを特定する必要がある場合は、AI Clientが`task_list`で候補を取得し、取得したIDを用いて更新する。

### Status Mapping

AI Foundation管理用Labelとして以下を利用する。

| AI Foundation | Todoist |
|---|---|
| `inbox` | Status Labelなし |
| `next` | `af-next` |
| `waiting` | `af-waiting` |
| `someday` | `af-someday` |
| `done` | Todoistの完了状態 |

Status用Labelは同時に1つだけ存在するものとする。

`task_update`でStatusを変更する場合、既存のStatus Labelを除去して新しいStatus Labelを設定する。

`done`への変更は`task_update`ではなく`task_complete`で行う。

### Area Mapping

AI Foundation管理用Labelとして以下を利用する。

| AI Foundation | Todoist |
|---|---|
| `work` | `af-area-work` |
| `personal` | `af-area-personal` |
| `null` | Area Labelなし |

Area用Labelは同時に1つだけ存在するものとする。

### Tags

通常のTodoist LabelをTaskの`tags`として扱う。

AI Foundation管理用Labelである以下は`tags`へ含めない。

```text
af-next
af-waiting
af-someday
af-area-work
af-area-personal
```

`task_update(tags=...)`は通常Labelの置換として扱い、AI Foundation管理用Labelには影響させない。

### Due

`due`は以下を許可する。

```text
YYYY-MM-DD
offset付きdatetime
null
```

Date-onlyは期限日のみを表す。

Datetimeは時刻付き期限を表す。

`task_update`で`due: null`を指定した場合は期限を削除する。

「明日」「金曜」等の自然言語日時の解釈はAI Clientが行い、AI Foundationには具体的な日付またはoffset付きdatetimeを渡す。

### task_create

入力対象:

```text
title
status
due
area
tags
```

`status`省略時は`inbox`として扱う。

`project_ref`はPhase 2では入力として扱わず、Todoistへ永続化しない。

### task_list

Todoist Inbox内の未完了Taskのみを対象とする。

Filter:

```text
status
area
due_before
due_after
tags
```

空Filterの場合はInbox内の未完了Taskをすべて返す。

`status`の対象は以下とする。

```text
inbox
next
waiting
someday
```

完了Taskの履歴検索はPhase 2対象外とする。

`project_ref`によるFilterはPhase 2では実装しない。

### task_update

必須:

```text
id
```

更新可能:

```text
title
status
due
area
tags
```

指定された項目だけを部分更新する。

`id`以外の更新項目が1つも指定されていない場合はValidation Errorとする。

`status=done`は受け付けず、完了は`task_complete`を利用する。

### task_complete

```text
id
```

でTaskを特定し、Todoist上で完了させる。

### Future Extension

Taskの`description`は将来追加候補とする。

Phase 2ではDomain / Toolへ追加しない。

## Schedule / Google Calendar Design

### Calendar Policy

AI Foundation専用Calendarを1つ用意する。

```text
AI Foundation専用Calendar
  Read:  OK
  Write: OK

その他の閲覧可能なCalendar
  Read:  OK
  Write: NG
```

書き込み先CalendarはConfigurationで固定し、Tool InputからCalendar IDを指定できないようにする。

Google Credential自体が技術的に他Calendarへの書き込み権限を持つ場合でも、AI Foundation Connectorは専用Calendar以外へ書き込まない。

Config例:

```yaml
sources:
  schedule:
    provider: google_calendar
    writable_calendar_id: "<calendar-id>"
```

Calendar IDはSecretではないためConfigurationへ保存してよい。

### schedule_create

Input:

```text
title
start
end
```

`related_task`はPhase 2では実装しない。

#### Timed Event

`start`がoffset付きdatetimeの場合は時刻予定として扱う。

`end`指定あり:

```text
start → end
```

`end`省略:

```text
end = start + 1 hour
```

#### All-day Event

`start`が`YYYY-MM-DD`の場合は終日予定として扱う。

`end`省略:

```text
1日の終日予定
```

`end`指定あり:

ユーザー視点ではstart日からend日までを含む複数日の終日予定として扱う。

Google Calendar APIの終日Eventは終了日が排他的であるため、Provider固有の変換はConnector側で吸収する。

DateとDatetimeを混在させたstart/endは受け付けない。

### schedule_list

閲覧可能な全Google Calendarを対象とする。

MVPのFilterは期間のみとする。

```text
start
end
```

Calendar名、色、参加者、場所、Meet URL等の追加情報やFilterは、必要性が確認された段階で追加する。

## Credential / Authentication

認証情報は`config.yaml`へ保存しない。

Phase 2では以下を基本とする。

```text
Todoist
→ Personal API Token

Google Calendar
→ OAuth 2.0
```

ローカルMVPではSecretをEnvironment Variable等から取得する。

Connectorが`process.env`等を直接参照する構造にはせず、薄いCredential Provider境界を設ける。

概念:

```text
Tool
  ↓
Connector
  ↓
CredentialProvider
  ↓
Environment Variable (Phase 2)
```

将来クラウド化した場合は、Domain / Tool / Connectorの責務を維持したままCredential StoreをSecret Manager等へ差し替えられる構造とする。

Remote MCPのClient Authentication、Multi-user Credential管理、Secret Manager実装そのものはPhase 2対象外とする。

## Error Handling

最低限以下を区別して扱えること。

```text
Input Validation Error
Authentication / Credential Error
Target Not Found
Provider API Error
Configuration Error
```

Provider固有ErrorをそのままDomainへ漏らす必要はないが、利用者が原因を判断できるMessageを返すこと。

## Out of Scope

Phase 2では以下を実装しない。

```text
Todoist Project振り分け
project_refのTodoist永続化 / Filter
Task description
完了Task履歴検索
TaskとScheduleのrelated_task連携
専用Calendar以外への書き込み
Calendarの高度なFilter
Calendar参加者 / 場所 / Meet URL等の編集
Cross-source Search
Workflow Engine
Intent Classifier
独自Planner
Remote MCP
Multi-user Authentication
Cloud Credential Store
```

## Acceptance Criteria

### Todoist Connection

Environment Credential Provider経由でTodoistへ接続できる。

Connectorが認証情報を直接Environment Variableから読み取らない。

### task_create

Todoist InboxへTaskを作成できる。

以下がTodoistへ正しく反映される。

```text
title
status
due
area
tags
```

Status / AreaのAI Foundation管理用Labelが正しくMappingされる。

### task_list

Inbox内の未完了Taskを取得できる。

以下でFilterできる。

```text
status
area
due_before
due_after
tags
```

Todoistから取得したTaskをAI Foundation Taskへ正しく変換できる。

### task_update

`todoist:<task-id>`を指定して以下を部分更新できる。

```text
title
status
due
area
tags
```

Status / Area変更時に古いAI Foundation管理用Labelが残らない。

通常Tag更新でAI Foundation管理用Labelが破壊されない。

### task_complete

`todoist:<task-id>`を指定してTaskを完了できる。

### Google Calendar Connection

OAuth Credentialを利用してGoogle Calendarへ接続できる。

### schedule_create

AI Foundation専用Calendarへ予定を作成できる。

Toolから専用Calendar以外の書き込み先を指定できない。

時刻予定で`end`を省略した場合、1時間の予定になる。

Date-onlyで1日の終日予定を作成できる。

Date-onlyのstart/endで複数日の終日予定を作成できる。

### schedule_list

指定期間について、閲覧可能な全Calendarから予定を取得できる。

### Security / Configuration

Token、OAuth Secret、Refresh Token等がRepositoryや`config.yaml`へ保存されない。

専用Calendar IDは静的Configurationとして設定できる。

### Automated Test

Tool LayerはFake / Mock Connectorを利用して自動テストできる。

ConnectorのMapping、Validation、Error Handlingについて自動テストが存在する。

通常のTest Suiteが実外部APIへの依存なしで実行できる。

実Todoist / Google Calendarとの接続確認はIntegration Testまたは手動Verificationとして分離する。

### LLM Client Verification

実装完了後、Claude Code等の実LLM ClientからAI Foundationへ接続し、少なくとも以下を確認する。

```text
自然言語からTodoist Taskを作成・取得できる
自然言語からGoogle Calendar Eventを作成・取得できる
```

## Coding Agent Task

Repository全体と上記Referenceを確認し、Phase 2のImplementation Planを作成すること。

Implementation Planには少なくとも以下を含める。

```text
現在のRepository状態
既存Phase 1実装への変更点
追加・変更予定ファイル
Domain / Tool Input Schema変更
Todoist Connector設計
Google Calendar Connector設計
Credential Provider設計
Configuration変更
実装順序
依存Package
Test Strategy
Integration Verification
Acceptance Criteriaとの対応
懸念点 / 未確定事項
```

Implementation Plan作成時点では本実装を開始しないこと。

PlanをRepository内の適切な場所へMarkdownとして作成し、レビュー可能な状態にすること。
