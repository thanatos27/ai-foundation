# 繰り返しタスク — Implementation Plan

- Status: **rev.1（Plan Review待ち・未承認。本実装は未着手）**
- 作成: Coding Agent (Claude Code) / 2026-10-25
- 対象: [Issue #11 繰り返しタスクの作成・変更・取得に対応する](https://github.com/thanatos27/ai-foundation/issues/11)（コメント「MVP詳細設計 v0.1」を正とする）
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md)（**変更しない**）, [Phase 2 Design Issue](../specs/phase-2-task-schedule.md), [Phase 2 Implementation Plan](phase-2-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

詳細設計v0.1で「Implementation Planで検証する / 検討する」とされた事項（`dueString` の言語・形式・Time Zone、非繰り返し文字列の誤受理の検出、`closeTask` 後の保持）は、SDKの型・実装から確定できる部分を [§4](#4-todoist-sdkの仕様sdk-1531) に、実Todoistでしか確定できない部分を [§5 実装前Probe](#5-実装前probe実todoist実装着手前に実施) に分けて記載する。設計に明記がなく本Planで決めた箇所は [§16 懸念点 / 未確定事項](#16-懸念点--未確定事項) にQとしてまとめる。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/task-recurrence-implementation-plan`。Baseは `main` の `afa1d3e`（PR #24 Merge、Google Calendar参加済みフラグMerge済み） |
| 依存 | `@doist/todoist-sdk ^15.3.1`（installed 15.3.1）、`zod 4.6`、Node `>=24`。**追加依存なし** |
| 公開Tool | **本Issueで増減しない**（`task_create` / `task_list` / `task_update` / `task_complete` の入出力を拡張するのみ） |
| Credential / Config | `TODOIST_API_TOKEN`、`defaults.timezone`。**変更しない** |
| CI | なし（`npm test` をローカルのWindows環境で実行） |

### 既存実装の要点（本Issueで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/domain/task.ts` | `TaskSchema`（`due: DateOrDateTimeSchema.nullable().optional()`）、`TaskCreateInputSchema`（strictObject）、`TaskUpdateInputSchema`（strictObject + 「`TASK_UPDATE_FIELDS` のいずれか必須」の `refine`）。`TASK_UPDATE_FIELDS = ['title','status','due','area','tags']` |
| `src/connectors/todoist/client.ts` | `TodoistClient = Pick<TodoistApi, 'getUser'｜'getTasks'｜'getTask'｜'addTask'｜'updateTask'｜'closeTask'>`。`toFoundationError` は認証Error → `CredentialError`、`notFound` 指定時の404 → `NotFoundError`、それ以外（400含む） → `ProviderApiError` |
| `src/connectors/todoist/mapping.ts` | `dueArgs(due)`: 日付 → `{dueDate}`、日時 → UTCの `{dueDatetime}`。`CLEAR_DUE = { dueString: null }`。`dueOf(due, tz)`: `datetime ?? date` を変換（floatingな時刻は `due.timezone ?? defaults.timezone` で解釈）。`toTask` は `due.isRecurring` / `due.string` を**捨てている** |
| `src/connectors/todoist/connector.ts` | `update`: status / area / tags を変えるときだけ `getTask` で現在のLabelを読み、`updateTask` を**1回**呼ぶ。titleだけなら `getTask` しない。`due` は `null` → `CLEAR_DUE`、値 → `dueArgs`。`complete`: `getTask` → `closeTask` → `getTask` で再取得し、未完了なら（繰り返しの次回分）そのまま、完了 / 404なら `done` で返す |
| `src/tools/task.ts` | `task_update` の説明に「Changing the due of a recurring task removes its recurrence.」と現状の危険な挙動を明記している（本Issueで「拒否する」に変わる） |
| `tests/connectors/todoist/fake-api.ts` | `FakeTodoistApi`。`dueFromArgs` は `dueDate` / `dueDatetime` だけを解釈し、`dueString` は（`null` 含め）すべて `due: null` になる。`closeTask` は `due.isRecurring` のTaskの `date` を1日進める |
| `tests/integration/todoist.integration.test.ts` | 実Todoistで作成→一覧→更新→完了。繰り返しTaskは**テストコードから `raw.addTask({ dueString: 'every day' })` で直接作成**し、`complete` 後に未完了・次回分になることを確認済み（Phase 2）。作成したTaskは `afterAll` で `raw.deleteTask` |

---

## 2. 設計方針

1. **新しいMCP Tool・Domain Entity・Credential・Config・DBを追加しない。** 既存4 Toolの入出力に `recurrence` を足すだけにする（v0.1 §方針）。
2. **Todoistを正本にし、次回期限の計算・自然言語の解釈はTodoistに任せる。** AI Foundationは `recurrence` 文字列を `dueString` として渡し、結果の `due.isRecurring` / `due.string` を読むだけで、曜日・日付を再計算しない。
3. **繰り返し設定を意図せず失わせる操作は、Providerへ書き込む前に拒否する。** 繰り返しTaskへの `due` 変更（`null` 含む）は `updateTask` を呼ぶ前に `InputValidationError`。他Fieldと同時に指定されていても全体を拒否し、部分的にも更新しない。
4. **繰り返しの解除は `recurrence: null` だけで行う。** 解除は期限も一緒に消える（Todoistでは繰り返し規則は `due` の一部のため）。「規則だけ外して次回の日付を残す」はMVPで扱わない（§16 Q2）。
5. **Todoistが繰り返しとして受理したかを書き込み後に必ず検証する。** `recurrence` を送った結果 `due.isRecurring !== true` なら、期限を書き込み前の状態へ戻してからErrorを返す（§7.4）。
6. **`recurrence` を含まない操作は従来と同一の呼び出しにする。** title / status / area / tagsだけの更新で `due` 系の引数を送らない（Todoist側で繰り返しが保持される）。titleだけの更新で `getTask` を呼ばない既存の最適化も維持する。
7. **Provider固有の処理はConnectorに閉じる。** Domain / Toolは「`recurrence` はTodoistの繰り返し規則（英語の自然言語）」とだけ知り、`dueString` / `dueLang` / `isRecurring` はTodoist Connectorの責務とする（AGENTS.md Layer責務）。

---

## 3. 既存実装への変更点（概要）

| 対象 | 変更 | 理由 |
|---|---|---|
| `src/domain/task.ts` | `TaskSchema.recurrence`、`TaskCreateInputSchema.recurrence`（非空文字列）、`TaskUpdateInputSchema.recurrence`（非空文字列｜`null`）、`due` との同時指定を拒否する `refine` | v0.1 §Domain / Input |
| `src/connectors/todoist/mapping.ts` | `recurrenceOf(due)`、`recurrenceArgs(rule)`、`restoreDueArgs(due, tz)`、`toTask` に `recurrence` を追加。`dueOf` / `dueArgs` / `CLEAR_DUE` は**変更しない** | v0.1 §Implementerへの注意 |
| `src/connectors/todoist/connector.ts` | `create`: `recurrence` → `dueString` + 受理検証。`update`: `getTask` が必要な条件に `due` / `recurrence` を追加、繰り返しTaskへの `due` 変更を事前拒否、`recurrence` の受理検証と期限の復元。`complete`: **変更しない**（`toTask` 経由で `recurrence` が付く） | v0.1 §Implementerへの注意 |
| `src/tools/task.ts` | 4 Toolの説明を更新（書式・例・解除・Due保護・完了時の挙動） | v0.1 §Implementerへの注意 |
| `README.md` | Tool表、「繰り返しタスク」節、Documentation一覧 | AC9 |
| `docs/specs/task-recurrence.md`（新規） | v0.1と本Planで確定した規則を個別仕様として記録 | AC9 |

**変更しないもの**: `docs/specs/mvp-v0.1.md`（固定済み）、`src/connectors/todoist/client.ts`（`TodoistClient` のPickは既存メソッドで足りる。`toFoundationError` も変更しない）、`src/connectors/todoist/filter.ts` / `TaskListFilterSchema`（`task_list` に新しいFilterを足さない）、`src/connectors/types.ts`（型は推論で追従）、`src/instructions.ts`（§16 Q9）、`src/config/**`・`config.yaml`、`src/credentials/**`、`.env.example`、他Entityの実装、`tests/server.test.ts` / `tests/e2e/stdio.test.ts`（Tool名・件数は不変）。

---

## 4. Todoist SDKの仕様（SDK 15.3.1）

`node_modules/@doist/todoist-sdk/dist` の型定義と実装で確認した事項。

### 4.1 取得（`Task.due` = `DueDate`）

```ts
// dist/types/types/tasks/types.d.ts
DueDateSchema = z.object({
  isRecurring: z.boolean(),
  string: z.string(),            // Todoistが保持する自然言語（例: "every monday"）
  date: z.string(),              // 次回の日付 YYYY-MM-DD（時刻付きでも入る）
  datetime: z.string().nullish(),// 時刻付きのとき。floating（offsetなし）またはUTC
  timezone: z.string().nullish(),// fixed timezoneのときだけ
  lang: z.string().nullish(),    // string の言語
});
```

- `due` 全体は `null` になり得る（期限なし）。`isRecurring` と `string` は `due` がある限り必須。
- 非繰り返しの期限にも `string` は入る（例: `"2026-10-30"`、`"tomorrow"`）。**`recurrence` は `isRecurring === true` のときだけ `string` を採用**し、それ以外は `null` にする（v0.1）。
- 繰り返しTaskの `date` / `datetime` は「次回の予定日」。現在の `Task.due` = `dueOf(due)` の意味は変えない。

### 4.2 作成（`addTask(args: AddTaskArgs)`）

```ts
AddTaskArgs = { content; labels?; dueString?: string; dueLang?: string; … }
            & RequireOneOrNone<{ dueDate?: string; dueDatetime?: string }>
```

- `dueString` / `dueLang` は型上 `dueDate` / `dueDatetime` と排他になっていないが、Todoist APIは `due_*` を1つだけ受け付ける前提で、**`recurrence` 指定時は `dueString` + `dueLang` だけを送る**（`due` との同時指定はDomainで拒否済み）。
- SDKは `args` をsnake_caseへ変換して `POST /tasks` に送るだけで、`dueString` を検証・加工しない。応答は `validateTask`（zod）で検証された `Task`。

### 4.3 更新（`updateTask(id, args: UpdateTaskArgs)`）

```ts
UpdateTaskArgs = { content?; labels?; dueString?: string | 'no date' | null; dueLang?: string | null; … }
               & RequireOneOrNone<{ dueDate?: string; dueDatetime?: string }>
```

- SDK実装（`dist/esm/clients/task-client.js` `updateTask`）は `dueString === null` を `'no date'` に置き換えて送る。既存の `CLEAR_DUE = { dueString: null }` はこの経路で期限（と繰り返し）を消す。
- `due_*` を1つも送らなければTodoistは期限を変えない。title / labelsだけの更新では繰り返しが保持される（Phase 2で `complete` 経由は確認済み。Labels / content更新での保持は §5 P7で確認する）。
- `dueDate` / `dueDatetime` で更新すると繰り返し規則が失われる（現行Tool説明の記載。§5 P7で再確認）。これが §7.3 の事前拒否の根拠。

### 4.4 完了（`closeTask(id)`）

- 繰り返しTaskは完了扱いにならず次回分へ進む（`checked: false` のまま `due.date` が進む）。Phase 2 Integration Testで `every day` について確認済み。`complete` の既存ロジック（close後の `getTask`）で次回期限と `recurrence` の両方が返る。
- 完了日基準（`every!`）の次回日付・規則文字列の保持は §5 P9で確認する。

### 4.5 言語・Time Zone

- `dueLang` はTodoist APIで「`due_string` が英語でない場合に指定する2文字の言語コード」。**本Issueでは `recurrence` を英語のTodoist構文に限定し、常に `dueLang: 'en'` を送る**（§16 Q3）。日本語の依頼（「毎週月曜」）はAI Clientが英語（`every monday`）に直してから渡す。Tool説明にそう書く。
- Todoistは `dueString` を**Todoistアカウントのtimezone設定**（`getUser().tzInfo`）で解釈する。AI Foundationの `defaults.timezone`（`Asia/Tokyo`）はSDKへ送れる値ではなく、出力時にfloatingな時刻を解釈するためだけに使う（既存 `dueOf`）。両者が一致していることを §5 P1で確認し、不一致の場合の影響はREADME / 仕様書の制約として記載する（Configは追加しない）。

---

## 5. 実装前Probe（実Todoist、実装着手前に実施）

§4のうち実APIでしか確定できない挙動を、Plan承認後・実装着手前に確認し、結果を本Planの「実装で確定した事項」に記録する。

- 実行方法: Scratchpadに置く使い捨てScript（Repositoryにcommitしない）から `TodoistApi` を直接使う。Tokenは既存Integration Testと同じく `.env` の `TODOIST_API_TOKEN`。
- 対象: Scriptが作成した `[af-probe <timestamp>]` 接頭辞付きTaskだけを操作し、終了時に `deleteTask` で削除する。**既存のTaskは読み取りも更新もしない**（`getUser` のみ読む）。
- 記録: `due` オブジェクト全体（`isRecurring` / `string` / `date` / `datetime` / `timezone` / `lang`）とHTTP status / Error message。Task名・Tokenは記録しない。

| # | 操作 | 確認したいこと | Planの前提 / 結果が違った場合 |
|---|---|---|---|
| P1 | `getUser()` | `lang`、`tzInfo.timezone` が `defaults.timezone`（`Asia/Tokyo`）と一致するか | 一致を前提。不一致ならREADME / 仕様書に「繰り返しの曜日・時刻・完了日基準の日付はTodoistアカウントのtimezoneで決まる」と明記する（コード変更なし） |
| P2 | `addTask({ dueString: 'every monday', dueLang: 'en' })` と `dueLang` なし | `isRecurring: true`、`string`（入力がそのまま保持されるか正規化されるか）、`date` が次の月曜、`lang` | `isRecurring: true`。`string` が入力と異なる場合はTestで入力との一致を検証しない（§11） |
| P3 | `every day at 9am` / `every weekday` / `every month on the 25th` / `every monday starting 2026-11-02` | 時刻付きの `datetime` がfloatingか、`timezone` が入るか。`starting` 構文の受理 | floating → `dueOf` が `defaults.timezone` で `+09:00` を付けて返す（既存Testで担保済みの経路） |
| P4 | `every! 3 days`、`after 3 days` | 完了日基準として受理され `string` に `every!` が残るか | 受理される前提。Tool説明の例は受理されたものだけを使う |
| P5 | `毎週月曜` を `dueLang` なし / `'ja'` / `'en'` で | 固定 `'en'` で日本語が400になるか、非繰り返しとして受理されるか | `'en'` 固定でも誤った繰り返しにはならない（400または非繰り返し → §7.4で検出）ことを確認。もし `dueLang` を送ると英語の受理に問題があれば `dueLang` を送らない方式へ変更する（Plan修正） |
| P6 | `tomorrow` / `no date` / `every blah` / `2026-12-01` を `dueString` に | 非繰り返し文字列が200で受理されるか（誤受理）、解釈できない文字列が400になるか | 誤受理は §7.4の受理検証で検出。400は `ProviderApiError` のまま（§16 Q6） |
| P7 | 繰り返しTaskに `updateTask` で (a) `content` のみ (b) `labels` のみ (c) `dueDate` (d) `dueDatetime` | (a)(b)で `due` が完全に不変（`string` / `date` / `isRecurring`）、(c)(d)で `isRecurring: false` になるか | (a)(b)保持・(c)(d)解除が前提。(c)(d)で保持されるなら事前拒否は不要になるが、v0.1どおり拒否は維持する（安全側） |
| P8 | 繰り返しTaskに `updateTask({ dueString: 'every day', dueLang: 'en' })`、続けて元の `string` / `lang` で `updateTask` | 規則変更で次回日付がどう再計算されるか、元の規則で戻したときの次回日付 | 規則変更・復元とも「今日以降の最初の該当日」に再計算される前提（§7.4 / §16 Q5の注意書き） |
| P9 | `every! 3 days` のTaskを `closeTask` → `getTask` | 完了日から3日後へ進み、`string` が不変か | `complete` の既存ロジックを変えない前提 |

Probe結果がPlanの前提と異なり設計判断が変わる場合（P5 / P7の想定外など）は、実装前にPlanを修正してReviewを受け直す。

---

## 6. Domain（`src/domain/task.ts`）

```ts
/** A Todoist recurring rule in English, e.g. "every monday" or "every! 3 days". Stored as given. */
const RecurrenceSchema = NonBlankSchema; // common.ts 既存（空白のみを拒否、trimしない）

TaskSchema = z.object({
  …既存,
  /** The recurring rule as Todoist holds it; null when the task does not recur. `due` is the next occurrence. */
  recurrence: z.string().min(1).nullable().optional(),
});

TaskCreateInputSchema = z.strictObject({
  …既存,
  recurrence: RecurrenceSchema.optional(),
}).refine((input) => input.recurrence === undefined || input.due == null, {
  message: 'due and recurrence cannot be specified together; Todoist sets the due from the recurrence',
  path: ['recurrence'],
});

const TASK_UPDATE_FIELDS = ['title', 'status', 'due', 'recurrence', 'area', 'tags'] as const;

TaskUpdateInputSchema = z.strictObject({
  …既存,
  /** Sets or changes the rule; null removes the rule together with the due. */
  recurrence: RecurrenceSchema.nullable().optional(),
})
  .refine(既存の「いずれか必須」)
  .refine((input) => input.due === undefined || input.recurrence === undefined, {
    message: 'due and recurrence cannot be specified together',
    path: ['recurrence'],
  });
```

| 項目 | 決定 |
|---|---|
| `TaskSchema.recurrence` | `optional` にする。Connectorは常に `string｜null` を返すが、`FakeTaskConnector` 等の既存の `Task` 生成箇所を壊さないため（`project_ref` と同じ扱い） |
| 作成時の `due: null` + `recurrence` | **受理**する。作成時の `due: null` は省略と同じ意味のため（§16 Q2） |
| 更新時の `due: null` + `recurrence` | **拒否**する。更新では `due: null` が「期限を消す」操作を意味するため、`recurrence: null` と意味が重なる |
| 作成時の `recurrence: null` | 拒否（v0.1「非空文字列のみ」）。作成で解除する対象はない |
| 文字列の検証 | 空・空白のみ・非文字列を拒否。**繰り返し構文かどうかはDomainで判定しない**（Todoistが正。受理検証はConnector §7.4） |
| `TASK_UPDATE_FIELDS` | `recurrence` を追加。`recurrence: null` 単独でも「いずれか必須」を満たす（`!== undefined` 判定のまま） |

`refine` を追加しても `strictObject` の `additionalProperties: false` と `inputSchema.properties` はMCPのJSON Schemaに残る（既存の `TaskUpdateInputSchema` と同じ構成）。

---

## 7. Connector（`src/connectors/todoist/`）

### 7.1 Mapping（`mapping.ts`）

```ts
/** Language of every recurrence AI Foundation sends; rules are written in English. */
export const RECURRENCE_LANG = 'en';

/** Todoist due → recurrence: the rule text of a recurring due, else null. */
export function recurrenceOf(due: TodoistTask['due']): string | null {
  return due?.isRecurring && due.string ? due.string : null;
}

/** Add / update request fields that set a recurring rule. */
export function recurrenceArgs(rule: string): { dueString: string; dueLang: string } {
  return { dueString: rule, dueLang: RECURRENCE_LANG };
}

/**
 * Update request fields that put back `previous` (the due read before a failed change): the
 * same rule for a recurring due, the same date / time for a one-off due, or no due.
 */
export function restoreDueArgs(previous: TodoistTask['due'], timeZone: string) {
  if (!previous) return CLEAR_DUE;
  if (previous.isRecurring) return { dueString: previous.string, dueLang: previous.lang ?? RECURRENCE_LANG };
  return dueArgs(dueOf(previous, timeZone)!);
}

toTask(...) → { …既存, recurrence: recurrenceOf(task.due) }
```

- `recurrenceOf` は `isRecurring` が真でも `string` が空なら `null`（`TaskSchema` の `min(1)` で出力検証に失敗させない）。事前拒否（§7.3）は `recurrence` ではなく `due.isRecurring` で判定するため、この場合も保護は効く。
- `restoreDueArgs` の非繰り返し分は既存 `dueOf` → `dueArgs` を通す。floatingな時刻は `defaults.timezone` の固定時刻として戻る（§16 Q5）。
- 既存の `dueOf` / `dueArgs` / `CLEAR_DUE` / Label関数は変更しない。

### 7.2 `create`

```text
addTask({ content, labels, ...(recurrence ? recurrenceArgs(recurrence) : due != null ? dueArgs(due) : {}) })
  ↓
recurrence 指定 かつ created.due?.isRecurring !== true
  → updateTask(created.id, CLEAR_DUE) で期限を外す（best-effort）
  → InputValidationError（作成済みTaskのidを含む）
それ以外 → toTask(created)
```

- 受理されなかった場合もTaskは作成済みで、**Connectorは削除しない**（Connectorは削除操作を持たない既存方針）。誤った単発の期限（例: `tomorrow` → 明日）が残らないよう期限だけ外し、Messageで状態を伝える:
  - 期限の除去に成功: `Invalid input: Todoist did not read recurrence "<rule>" as a recurring rule. Task todoist:<id> was created without a due; set a valid rule with task_update (recurrence) instead of creating it again.`
  - 期限の除去に失敗: `ProviderApiError`（`… task todoist:<id> was created with the one-off due <due>, and removing it failed: <message>`）。状態が想定外のため `complete` の再取得失敗と同じ扱いにする。
- `recurrence` を含まない `create` は呼び出し引数・応答とも従来と同一（`recurrence: null` が出力に増えるだけ）。

### 7.3 `update`（Due保護）

```text
todoistId = parseTaskId(id)                         // 既存: 不正idはAPI前に拒否
needsCurrent = status/area/tags !== undefined       // 既存
             || due !== undefined || recurrence !== undefined   // 追加
current = needsCurrent ? getTask : undefined        // 404 → NotFoundError（書き込み前）

if (due !== undefined && current.due?.isRecurring)  // ★ 書き込み前に拒否
  throw InputValidationError(...)

updated = updateTask(todoistId, {
  content?, labels?,                                 // 既存
  ...due === null ? CLEAR_DUE : due ? dueArgs(due)   // 既存
   : recurrence === null ? CLEAR_DUE
   : recurrence ? recurrenceArgs(recurrence) : {},
})

if (typeof recurrence === 'string' && updated.due?.isRecurring !== true)
  → §7.4 復元 + Error
return toTask(updated)
```

- 事前拒否のMessage: `Invalid input: task todoist:<id> recurs ("<current.due.string>"); changing its due would remove the recurrence. Change the rule with recurrence, or remove the rule and the due with recurrence: null. Nothing was changed.`
- `due: null` も拒否の対象（§16 Q1）。`due` と他Field（title / status等）の同時指定でも、`updateTask` を1回も呼ばずに全体を拒否する。
- 非繰り返しTask・期限なしTaskへの `due` 更新は従来どおり。ただし `getTask` が1回増える（事前判定のため。§16 Q7）。
- title / status / area / tagsだけの更新は `due` 系の引数を送らない（従来どおり）。titleだけなら `getTask` も呼ばない。
- `recurrence: null` は対象が繰り返しでも非繰り返しでも `CLEAR_DUE` を送る（非繰り返しTaskでは明示的な期限解除。v0.1）。
- `recurrence` と title / Labelの同時指定は1回の `updateTask` にまとめる（Todoist側で1リクエスト＝原子的）。
- `getTask` と `updateTask` の間に外部で繰り返しが設定される競合は防がない（v0.1 §未確定「完全な排他制御なし」）。

### 7.4 受理検証と期限の復元（`update`）

`recurrence` に文字列を送ったのに応答の `due.isRecurring !== true` の場合（`tomorrow`、`no date`、日本語＋`dueLang: 'en'` 等。§5 P5 / P6）:

1. `updateTask(todoistId, restoreDueArgs(current.due, timeZone))` で**期限だけ**書き込み前に戻す。同じ呼び出しで変えたtitle / Labelは戻さない。
2. 復元に成功: `InputValidationError`: `Todoist did not read recurrence "<rule>" as a recurring rule; the previous due of task todoist:<id> was restored (<previous summary>). Other requested fields were applied.`（他Fieldを指定していないときは最後の文を付けない）。前の期限が繰り返しだった場合は「次回日付はTodoistが再計算する」旨を加える（§16 Q5）。
3. 復元に失敗: `ProviderApiError`: `… recurrence "<rule>" was not read as recurring, and restoring the previous due (<summary>) failed: <message>`。

- 「前の期限」は §7.3 で読んだ `current.due`。`recurrence` 指定時は必ず `getTask` 済みなので追加の読み取りは不要。
- Todoistが `dueString` を400で拒否した場合は書き込みが起きていないので復元しない（既存どおり `ProviderApiError`。§16 Q6）。

### 7.5 `complete` / `list`

- コード変更なし。`toTask` が `recurrence` を付けるため、`complete` は繰り返しTaskの次回分を `recurrence` 付きで、非繰り返しTaskを `status: 'done'` / `recurrence: null` で返す。期限（`until` / `ending`）に達して完了扱いになった繰り返しTaskは、Todoistが返す状態（完了・404）に従い既存分岐で `done` になる。
- `list` は従来どおりInboxの未完了だけを返し、各Taskに `recurrence` が付く。`matchesFilter` は変更しない（`due_before` 等は次回期限で比較される）。

---

## 8. Tool（`src/tools/task.ts`）

`inputSchema` / `outputSchema` はDomainのSchemaをそのまま使うため追加の配線は不要。説明文だけを更新する。

| Tool | 追加・変更する説明（英語、要旨） |
|---|---|
| 共通（`recurrence` 文） | `recurrence is a Todoist recurring rule written in English, e.g. "every day", "every monday", "every weekday at 9am", "every month on the 25th". Use "every!" (e.g. "every! 3 days") to count the next due from the completion date instead of the schedule. Translate the user's words (e.g. 毎週月曜 → "every monday"); Todoist computes the dues, so do not compute dates yourself.` |
| `task_create` | 共通文＋`Do not pass due together with recurrence. If Todoist does not read the rule as recurring, the task is still created without a due and an error tells you its id: fix it with task_update instead of creating it again.` |
| `task_list` | `Each task has recurrence (the rule, or null) and due (the next occurrence for a recurring task).` |
| `task_update` | 共通文＋`recurrence changes the rule (Todoist recomputes the next due from today); recurrence: null removes the rule together with the due. The due of a recurring task cannot be changed or cleared with due — that request is rejected without changing anything, because it would remove the recurrence. Postponing a single occurrence is not supported. title / status / area / tags changes keep the recurrence.` 既存の「Changing the due of a recurring task removes its recurrence.」は削除 |
| `task_complete` | `A recurring task moves to its next occurrence and is returned still open with the new due and the same recurrence.` |

`annotations` は変更しない（`task_update` は既に `destructiveHint: true`）。

---

## 9. 追加・変更予定ファイル

### 9.1 Source

| File | 変更 |
|---|---|
| `src/domain/task.ts` | §6 |
| `src/connectors/todoist/mapping.ts` | §7.1 |
| `src/connectors/todoist/connector.ts` | §7.2〜§7.4 |
| `src/tools/task.ts` | §8 |

### 9.2 Tests

| File | 変更 |
|---|---|
| `tests/domain/task.test.ts` | §11.2 |
| `tests/connectors/todoist/mapping.test.ts` | §11.3 |
| `tests/connectors/todoist/fake-api.ts` | `dueString` の解釈（§11.4冒頭） |
| `tests/connectors/todoist/connector.test.ts` | §11.4 |
| `tests/helpers/fake-connectors.ts` | `FakeTaskConnector.create` が `recurrence: input.recurrence ?? null` を返す |
| `tests/tools/task.test.ts` | §11.5 |
| `tests/integration/todoist-recurrence.integration.test.ts`（新規） | §12.1 |

### 9.3 Documentation

| File | 変更 |
|---|---|
| `README.md` | §14.1 |
| `docs/specs/task-recurrence.md`（新規） | §14.2 |
| `docs/plans/task-recurrence-implementation-plan.md` | Probe結果・実装で確定した事項・Verification結果を追記 |

---

## 10. 実装順序

User承認後、`main` から `feat/task-recurrence` を作成して実装する。

1. §5のProbeを実施し、結果を本Planに記録する（Planの前提が変わる場合はReviewへ戻す）。
2. Domain（§6）とDomain Testを追加する。
3. Mapping（§7.1）とMapping Testを追加する。
4. `FakeTodoistApi` の `dueString` 対応を入れ、**既存のConnector Testが無変更で成功する**ことを確認する。
5. Connector（§7.2〜§7.4）とConnector Testを追加する。
6. Tool説明（§8）とTool Testを更新する。
7. `npm run typecheck`・`npm run build`・`npm test` を全件成功させる。
8. Integration Test（§12.1）を作成し、`npm run test:integration` で実行する。
9. README・`docs/specs/task-recurrence.md` を更新し、本Planに「実装で確定した事項」を追記する。
10. PRを作成し、CodexのImplementation Reviewを受ける。Review後に手動Verification（§12.2）・LLM Client Verification（§13）を実施して記録する。

---

## 11. Automated Test

### 11.1 方針

- 外部Serviceへ通信しない（`FakeTodoistApi` / `FakeTaskConnector`）。
- 安全性（AC5）は「`updateTask` が呼ばれていない」「Fake内のTaskが変更前と `toEqual`」の2点で確認する。
- 後方互換は既存Task系Testを**無変更で**成功させることで確認する。例外は `tests/connectors/todoist/mapping.test.ts` の「maps a Todoist task to a domain task」1件のみで、出力全体を `toEqual` で比較しているため期待値に `recurrence: null` を加える（出力Fieldの追加そのもの）。Domain Testの「いずれか必須」は `toContain('At least one of')`、Tool Testは旧説明文を検査していないため無変更で通る。

### 11.2 Domain（`tests/domain/task.test.ts`）

| ケース | 期待 |
|---|---|
| `TaskSchema` に `recurrence: 'every monday'` / `null` / 省略 | 受理 |
| `TaskSchema` に `recurrence: ''` | 拒否 |
| create `{ title, recurrence: 'every monday' }` | 受理、値をそのまま保持（trimしない） |
| create `{ title, recurrence: 'every day', due: null }` | 受理 |
| create `recurrence: ''` / `'   '` / `123` / `null` | 拒否 |
| create `{ title, recurrence: 'every day', due: '2026-11-01' }` | 拒否（path `recurrence`） |
| update `{ id, recurrence: 'every day' }` / `{ id, recurrence: null }` | 受理（「いずれか必須」を満たす） |
| update `{ id, recurrence: 'every day', due: '2026-11-01' }` / `{ id, recurrence: null, due: null }` / `{ id, recurrence: 'x', due: null }` | 拒否 |
| update `recurrence: ''` / `'  '` / `true` | 拒否 |
| update `{ id }` | 拒否（Messageに `recurrence` を含む） |

### 11.3 Mapping（`tests/connectors/todoist/mapping.test.ts`）

| 関数 | ケース |
|---|---|
| `recurrenceOf` | `null` → `null`／非繰り返し（`string: 'tomorrow'`）→ `null`／繰り返し（日付）→ `string`／繰り返し（floating datetime）→ `string`／`isRecurring: true` で `string: ''` → `null` |
| `toTask` | 繰り返しTask → `due` は次回日付・`recurrence` は規則（AC2）。非繰り返し（`string: 'Oct 16'`）・期限なし → `recurrence: null`。既存の「maps a Todoist task to a domain task」は期待値に `recurrence: null` を加える（§11.1） |
| `recurrenceArgs` | `{ dueString: 'every monday', dueLang: 'en' }` |
| `restoreDueArgs` | `null` → `{ dueString: null }`／繰り返し（`lang: 'ja'`）→ `{ dueString, dueLang: 'ja' }`／繰り返し（`lang` なし）→ `dueLang: 'en'`／日付 → `{ dueDate }`／fixed datetime → UTCの `{ dueDatetime }`／floating datetime → `defaults.timezone` で解釈したUTC |

### 11.4 Connector（`tests/connectors/todoist/connector.test.ts`）

`FakeTodoistApi` の `dueFromArgs` に `dueString` の解釈を追加する（実Todoistを模した最小規則）:

| `dueString` | Fakeの `due` |
|---|---|
| `null` / `'no date'` | `null` |
| `every` / `every!` で始まる | `{ isRecurring: true, string, date: FAKE_TODAY(固定), datetime: null, timezone: null, lang: dueLang }` |
| それ以外 | `{ isRecurring: false, string, date: FAKE_TODAY, … }` |

`failures.updateTask` 等の既存の失敗注入はそのまま使う（2回目の呼び出しだけ失敗させるTestは既存 `failReadBack` と同じ手法で包む）。

| 区分 | ケース | 期待 |
|---|---|---|
| create | `recurrence: 'every monday'` | `addTask` 引数が `{ content, labels, dueString: 'every monday', dueLang: 'en' }`（`dueDate` / `dueDatetime` なし）。返り値 `recurrence: 'every monday'`、`due` は次回日付（AC1） |
| create | `recurrence: 'tomorrow'`（Fakeで非繰り返し） | `updateTask(id, { dueString: null })` が1回、`InputValidationError`（Messageに `todoist:<id>` と「without a due」）。FakeのTaskは期限なしで残る |
| create | 上記で期限除去が失敗 | `ProviderApiError`（idと残った期限を含む） |
| create | `addTask` が400 | `ProviderApiError`、`updateTask` 呼び出しなし |
| create | `recurrence` なし | 引数は従来どおり、返り値 `recurrence: null` |
| update 保持 | 繰り返しTaskの title のみ | `getTask` 呼び出しなし、`updateTask` 引数 `{ content }` のみ、`recurrence` 保持（AC3） |
| update 保持 | 繰り返しTaskの status / area / tags | `updateTask` 引数のキーが `labels`（＋`content`）のみで `due*` を含まない、`recurrence` 保持（AC3） |
| update 変更 | `recurrence: 'every day'` | `getTask` 1回、`updateTask` 引数 `{ dueString: 'every day', dueLang: 'en' }`、返り値の `recurrence` が新規則（AC4） |
| update 変更 | `recurrence` ＋ title ＋ status | `updateTask` 1回にまとまる |
| update 解除 | 繰り返しTaskに `recurrence: null` | `{ dueString: null }`、返り値 `due: null` / `recurrence: null`（AC4） |
| update 解除 | 非繰り返しTaskに `recurrence: null` | `{ dueString: null }`（明示的な期限解除） |
| update 拒否 | 繰り返しTaskに `due: '2026-11-01'` / `due: '…T09:00:00+09:00'` / `due: null` | `InputValidationError`（Messageに現在の規則・`recurrence: null` の案内）、`updateTask` 呼び出し0回、FakeのTaskが変更前と `toEqual`（AC5） |
| update 拒否 | 繰り返しTaskに `due` ＋ title ＋ tags | 同上（Labelもtitleも変わらない） |
| update 従来 | 非繰り返しTask・期限なしTaskに `due` / `due: null` | 従来どおりの `updateTask` 引数（`getTask` が1回先行する）（AC6） |
| update 受理検証 | 繰り返しTaskに `recurrence: 'tomorrow'` | 2回目の `updateTask` が `{ dueString: <元の規則>, dueLang: <元のlang ?? 'en'> }`、`InputValidationError`（「restored」）、FakeのTaskは繰り返しに戻る |
| update 受理検証 | 日付期限 / 日時期限 / 期限なしのTaskに `recurrence: 'tomorrow'` | 復元引数がそれぞれ `{ dueDate }` / `{ dueDatetime }` / `{ dueString: null }` |
| update 受理検証 | `recurrence: 'tomorrow'` ＋ title | Messageに「Other requested fields were applied」、titleは変更後のまま |
| update 受理検証 | 復元の `updateTask` が失敗 | `ProviderApiError`（元の期限の要約を含む） |
| update 不存在 | `recurrence` / `due` 指定で `getTask` が404 | `NotFoundError`、`updateTask` 呼び出しなし |
| complete | 繰り返しTask | 未完了・次回日付・`recurrence` が完了前と同じ（AC7） |
| complete | 非繰り返しTask | `status: 'done'`、`recurrence: null`（AC7） |

### 11.5 Tool Layer（`tests/tools/task.test.ts`、`FakeTaskConnector`）

| ケース | 期待 |
|---|---|
| `listTools` | `task_create` / `task_update` の `inputSchema.properties` に `recurrence` がある。`task_update` の `recurrence` は `null` を許す型。説明に `every!` / `recurrence: null` を含み、`task_update` に「removes its recurrence」の旧文言がない |
| create / update に `recurrence` を指定 | Connectorへ値がそのまま渡る（`null` 含む） |
| 不正Input（既存の `it.each` に追加） | create `{ title, recurrence: '' }`／create `{ title, recurrence: 'every day', due: '2026-11-01' }`／update `{ id, recurrence: 'every day', due: null }`／update `{ id, recurrence: 1 }` → `Input validation error`、Connector呼び出しなし（AC6） |

### 11.6 回帰

- 既存のTask系Test（Domain / Mapping / Connector / Filter / Tool）が無変更で成功する（§11.1の例外を除く）。
- `tests/server.test.ts` / `tests/e2e/stdio.test.ts` のTool名・件数が変わらない。
- `npm run typecheck` / `npm run build` / `npm test` 全件成功。

---

## 12. Integration Verification

### 12.1 Integration Test（`tests/integration/todoist-recurrence.integration.test.ts`、手動起動）

実行条件: `AI_FOUNDATION_INTEGRATION=1` と `TODOIST_API_TOKEN`（既存Todoist Integration Testと同じ）。

- **既存実データを操作しない（AC8）**: Connectorの `create` で `runLabel` 付きのTaskを作り、そのidだけを `update` / `complete` する。期待値の確認は `raw.getTask(<作成したid>)` で行い、`list` の結果は作成したidの有無だけを見る。`afterAll` で作成したTaskだけを `raw.deleteTask`（既存Integration Testと同じ）。
- 受理されなかった `create`（I8）はErrorのMessageからidを取り出して削除対象に加える。
- Todoistが返す `string` が入力と同一とは限らない（§5 P2）ため、規則の確認は「`isRecurring: true` かつ `recurrence === raw.due.string`」で行い、入力との文字列一致はProbe結果で同一と確認できた場合だけ加える。

| # | 操作 | 確認 |
|---|---|---|
| I1 | `create({ recurrence: 'every monday', status: 'next', area: 'work', tags })` | `recurrence` が非null、`raw.due.isRecurring`、`due` が `defaults.timezone` で月曜の日付（AC1） |
| I2 | I1をtitle → status → area → tagsの順に `update` | 各回の後で `raw.due`（`string` / `date` / `isRecurring`）が作成直後と `toEqual`（AC3） |
| I3 | I1に `update({ due: <日付> })`、`update({ due: null, title })` | `InputValidationError`、`raw.getTask` の結果（`due` / `content` / `labels`）が直前と `toEqual`（AC5） |
| I4 | I1に `update({ recurrence: 'every day' })` | `raw.due.isRecurring`、`recurrence` が変わる（AC4） |
| I5 | I1を `complete` | 未完了、`due` が完了前より後、`recurrence` が完了前と同じ（AC7） |
| I6 | I1に `update({ recurrence: null })` | `raw.due === null`、`recurrence: null`（AC4） |
| I7 | `create({ recurrence: 'every! 3 days' })` → `complete` | 受理され、完了後も `recurrence` 維持・未完了（完了日基準） |
| I8 | `create({ recurrence: 'tomorrow' })` | `InputValidationError`、作成されたTaskの `raw.due === null` |
| I9 | `create({ recurrence: 'every day' })` に `update({ recurrence: 'tomorrow' })` | Error、`raw.due.isRecurring === true` に戻っている |
| I10 | `create({ due: <日付> })` に `update({ due: <別の日付> })` | 従来どおり更新される（非繰り返しのdue更新の回帰。AC6） |

- 実行（このファイルだけ）: `AI_FOUNDATION_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts tests/integration/todoist-recurrence.integration.test.ts`
- 既存 `todoist.integration.test.ts` は変更しない（繰り返しTaskの完了は既存Testでも引き続き確認される）。

### 12.2 手動Verification（記録のみ）

本BranchのBuildでMCP Serverを起動し、MCP Client（Claude Code）からToolを直接呼ぶ。対象は検証用に作成したTaskのみで、確認後にTodoist UIで削除する。

| # | 操作 | 期待 |
|---|---|---|
| M1 | `task_create({ title, recurrence: 'every monday' })` → Todoist UI | UIで「毎週月曜」の繰り返しとして表示される |
| M2 | Todoist UIで既存の繰り返しTaskを1件作成（日本語UIで「毎日」等）→ `task_list` | `recurrence` にTodoistが保持する文字列（日本語のまま）が返る |
| M3 | M2のTaskに `task_update({ title })` → UI | 繰り返し表示が変わらない |
| M4 | M2のTaskに `task_update({ due })` | `Invalid input: … recurs …`、UIで変化なし |
| M5 | `task_update({ recurrence: 'every day', due: '2026-11-01' })` | `Input validation error` |

---

## 13. LLM Client Verification

Claude CodeからMCP Server（本Branchの `dist`）へ再接続し、自然文で依頼してTool呼び出しを確認する（記録のみ、検証用Taskのみ）。

| # | 依頼 | 期待 |
|---|---|---|
| L1 | 「毎週月曜にゴミ出しのタスクを作って」 | `task_create` に `recurrence: 'every monday'`（英語）を渡し、`due` を自分で計算して渡さない |
| L2 | 「3日ごとに水やり、完了した日から数えて」 | `recurrence: 'every! 3 days'` |
| L3 | 「ゴミ出しの次回を来週水曜にずらして」 | `due` で更新しようとして拒否された場合、1回分の延期は未対応であることを伝え、勝手に `recurrence: null` で解除しない |
| L4 | 「ゴミ出しの繰り返しをやめて」 | `recurrence: null`（期限も消えることを伝える） |
| L5 | 「ゴミ出しを完了にして」 | `task_complete`。次回分の日付と繰り返しが続くことを答える |

---

## 14. README / 個別仕様

### 14.1 `README.md`

- Tool表: `task_create`（`recurrence` を追加）、`task_update`（`recurrence` で規則の変更・解除）。
- 「繰り返しタスク」節（Task節の下）: 書式（英語のTodoist構文、`every!` の意味、例）、`recurrence` と `due` の関係（規則と次回期限）、`recurrence: null` で期限ごと解除、繰り返しTaskへの `due` 変更は拒否、1回分の延期は未対応、受理されない文字列の扱い、Todoistアカウントのtimezoneで解釈される（§5 P1の結果に応じて）。
- Integration Testの説明に `todoist-recurrence.integration.test.ts` を追記。Documentation一覧に個別仕様を追加。

### 14.2 `docs/specs/task-recurrence.md`（新規）

Issue #11 v0.1と本Planで確定した事項を、`docs/specs/schedule-attendance.md` と同じ構成（目的・Scope・Domain / Input・Tool挙動・安全性・既知の制約・MVP外）で記録する。`mvp-v0.1.md` は変更しない（次期全体仕様書で統合する）。

---

## 15. Acceptance Criteriaとの対応

| # | Acceptance Criteria（具体化） | 確認方法 |
|---|---|---|
| AC1 | `every day` / `every monday` / `every! 3 days` で作成でき、返り値と `task_list` の `recurrence` に規則、`due` に次回日付が入る | §11.4 create、§12.1 I1 / I7、§13 L1 / L2 |
| AC2 | Todoistの `due` が `null` / 非繰り返し / 繰り返し（日付・時刻）のとき、`due` / `recurrence` が正しく変換される | §11.3 |
| AC3 | title / status / area / tags の更新で `due` 系の引数を送らず、Todoist上の規則・次回日付が変わらない | §11.4 update保持、§12.1 I2、§12.2 M3 |
| AC4 | `recurrence: '<規則>'` で規則が変わり、`recurrence: null` で規則と期限が消える | §11.4 update変更 / 解除、§12.1 I4 / I6 |
| AC5 | 繰り返しTaskへの `due`（`null` 含む・他Fieldとの同時指定含む）は `updateTask` を呼ぶ前に `InputValidationError` になり、Todoist上の状態が変わらない | §11.4 update拒否、§12.1 I3、§12.2 M4 |
| AC6 | `due` / `recurrence` の同時指定、空・空白・非文字列の `recurrence` を拒否。非繰り返しTaskの `due` 更新は従来どおり | §11.2、§11.5、§11.4 update従来、§12.1 I10 |
| AC7 | `task_complete` で繰り返しTaskは次回期限へ進み `recurrence` を維持、非繰り返しTaskは `done` | §11.4 complete、§12.1 I5 / I7 |
| AC8 | Fake SDK / Tool / Mapping / Domain Test・既存Task系回帰が成功し、実Todoistで作成→取得→変更→解除→完了を、作成したTaskだけを対象に検証する | §11、§12.1 |
| AC9 | READMEと `docs/specs/task-recurrence.md` を更新し、`docs/specs/mvp-v0.1.md` に差分がない | §14、`git diff main -- docs/specs/mvp-v0.1.md` が空 |
| （追加） | Todoistが繰り返しとして受理しなかった `recurrence` は、期限を元に戻したうえでErrorになる | §7.2 / §7.4、§11.4 受理検証、§12.1 I8 / I9 |

---

## 16. 懸念点 / 未確定事項

### Q1. 繰り返しTaskへの `due: null` も拒否する

v0.1は「`due` だけで更新する場合、対象が繰り返しタスクなら拒否」とし、`null` の扱いは明記していない。`due: null` もTodoistでは規則ごと消えるため、**拒否して `recurrence: null` へ誘導する**。解除操作を `recurrence: null` の1経路に揃え、「期限を消したつもりで繰り返しも消えた」を防ぐ。

### Q2. 作成時の `due: null` は `recurrence` と同時に受理する／「規則だけ外して期限を残す」は扱わない

作成時の `due: null` は省略と同じ意味で、AI Clientが未指定Fieldを `null` で送ることもあるため受理する（更新時は意味が重なるので拒否。§6）。また `recurrence: null` で期限も消えるのはv0.1どおりで、「繰り返しをやめて次回の日付だけ残す」は `recurrence: null` → `due` の2回呼び出しで実現できるため、専用の操作は追加しない（Tool説明に「期限も消える」と明記）。

### Q3. `recurrence` は英語限定、`dueLang: 'en'` を常に送る

`dueLang` を送らない場合、Todoistの解釈言語がアカウント設定・自動判定に依存し得る。英語に固定すると、(1) 同じ入力が常に同じ解釈になる、(2) Tool説明の例と一致する、(3) LLMは日本語の依頼を英語のTodoist構文へ安定して変換できる。日本語のまま渡された場合は §7.4の受理検証で検出される（§5 P5で確認）。Todoist UIで日本語で作られた既存の規則は、取得時にそのままの文字列（`lang: 'ja'`）で返し、復元時もその `lang` を使う。

### Q4. 受理されなかった `recurrence` の扱い（作成済みTaskは削除しない）

書き込み前に「繰り返し構文か」を判定するParse専用APIはなく、Domainで英語の構文を正規表現で判定すると有効な規則を誤って拒否する恐れがある。そのため**Todoistの応答で判定し、期限だけ書き込み前の状態に戻す**。`create` では一時Taskを作って試す・失敗時に削除する案もあるが、Connectorに削除操作を持ち込むことになるため採らない。作成済みのTaskはMessageでidを示し、`task_create` の再試行による重複を避けるよう案内する。

### Q5. 復元は「同じ規則・同じ日時」に戻すが、次回日付は再計算され得る

繰り返しの期限を `dueString` で戻すと、Todoistが次回日付を今日以降で再計算するため、元の次回日付（例: 期限切れの過去日）と一致しない場合がある（§5 P8で確認）。floatingな単発時刻は `defaults.timezone` の固定時刻として戻る。いずれもErrorのMessageに書き、完全な復元は保証しない。発生条件は「受理されない文字列を `recurrence` に渡したとき」に限られる。

### Q6. Todoistの400は `ProviderApiError` のまま

`dueString` が解釈できないときTodoistは400を返すと想定する（§5 P6）が、400は他の原因でも返るため、`toFoundationError` で `InputValidationError` へ変換しない。Messageには既存どおりHTTP statusとTodoistのMessageが入るので、AI Clientは書式の誤りと判断できる。

### Q7. `due` 更新時に `getTask` が1回増える

事前判定のため、非繰り返しTaskへの `due` 更新でも `getTask` を呼ぶ（v0.1「`due` 変更時のみ既存タスクを読んでisRecurringを事前判定」）。titleだけの更新は従来どおり `getTask` なし。

### Q8. `task_list` に繰り返しのFilterを追加しない

v0.1どおり。出力の `recurrence` で判別できる。

### Q9. Instructions（`src/instructions.ts`）は変更しない

Entity定義（Task = Todoist）は変わらず、繰り返しの書式・制約はTool説明に書けばAI Clientが参照できる。§13でL1〜L4が失敗した場合は、Instructionsへの追記をPlan外の変更として提案する。

### Q10. 規則の変更で次回日付がリセットされる

`recurrence` を変更すると、Todoistは新しい規則で次回日付を計算し直す（今日以降の最初の該当日）。特定の日から始めたい場合は `every monday starting 2026-11-02` のようなTodoist構文で指定できる（§5 P3で受理を確認し、Tool説明・READMEの例に含めるか決める）。

### その他（MVP外）

- **次回1回分のみの延期**（v0.1でMVP対象外）: 繰り返しを保持したまま次回日付だけ動かすAPI方式が確認できるまで扱わない。Todoist UIでの操作を案内する。
- Todoistの `deadline`、Sub-task、Inbox以外のProjectの繰り返しTaskは対象外（既存Task Toolの範囲のまま）。
- `recurrence` の構造化（頻度・曜日等のField化）や独自のRecurrence Engine / Scheduler / DBは実装しない。
