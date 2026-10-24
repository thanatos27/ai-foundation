# 繰り返しタスク — Design

[Issue #11](https://github.com/thanatos27/ai-foundation/issues/11)（MVP詳細設計 v0.1）と、[Implementation Plan](../plans/task-recurrence-implementation-plan.md) のPlan Review・実装前Probe（PR #25）で確定した事項をまとめる。[MVP v0.1仕様](mvp-v0.1.md) は当時の仕様として維持し、本書をv0.1以降に追加された仕様とする。

## Goal

「毎日」「毎週月曜」などの繰り返しタスクを、AI Foundation経由で作成・取得・変更・解除できるようにする。繰り返し設定が意図せず失われないことを最優先にする。

## MVP方針

- 新しいMCP Toolは追加しない。既存の `task_create` / `task_list` / `task_update` / `task_complete` を拡張する。Credential・Config・DBも追加しない。
- Todoistを正本とし、規則の解釈と次回期限の計算はTodoistに任せる。AI Foundationは日付を再計算しない。
- 繰り返し設定を失わせる操作は、Todoistへ書き込む前に拒否する。解除は `recurrence: null` で明示的に行う。
- Errorを返すときは書き込み前の状態に戻すことを原則とし、戻せなかった場合だけ残った状態を明示する。
- `dueString` / `dueLang` / `isRecurring` の扱いはTodoist Connectorの責務とし、Domain / Toolは「`recurrence` はTodoistの繰り返し規則」という意味だけを持つ。

## Domain / Tool Interface

```text
Task.recurrence: string | null           // Todoistが保持する規則。繰り返さないTaskは null。due は次回の予定日
task_create({ title, …, recurrence?: string })
task_update({ id, recurrence: string | null })   // recurrence は単独で指定する
```

| 操作 | 挙動 |
|---|---|
| `task_create` の `recurrence` | 規則でTaskを作成し、Todoistが計算した次回期限を `due` に返す。`due`（`null` 以外）との同時指定は拒否。`due: null` は省略と同じ扱いで受理 |
| `task_update` の `recurrence: "<規則>"` | 規則を設定・変更する。Todoistが次回期限を計算し直す |
| `task_update` の `recurrence: null` | 規則と期限の両方を消す（繰り返さないTaskでは期限の解除） |
| `task_update` で `recurrence` と他の項目を同時指定 | Input Errorになる（`due`・title・status・area・tagsのいずれも不可） |
| 繰り返しTaskへの `task_update` の `due`（`null` 含む・他の項目との同時指定含む） | 書き込む前に `Invalid input` で拒否し、何も変更しない |
| title / status / area / tags だけの `task_update` | 期限を送らないため、繰り返しは変わらない |
| `task_list` | 従来どおりInboxの未完了Task。各Taskに `recurrence` が付く（繰り返し用のFilterはない） |
| `task_complete` | 繰り返しTaskは次回分へ進み、未完了のまま新しい `due` と同じ `recurrence` で返る |

- `recurrence` は空文字・空白だけ・文字列以外をInput Errorにする。規則として正しいかどうかはTodoistが判断する。

## 規則の書式

- 英語のTodoistの構文で書く（例: `every day`、`every monday`、`every weekday at 9am`、`every month on the 25th`、`every monday starting 2026-11-02`）。AI Foundationは常に `dueLang: "en"` を送る。
- 完了日基準は `every!`（例: `every! 3 days`。`after 3 days` も同じ意味として受理される）。固定日基準は `every`。
- Todoistが解釈できれば日本語（`毎週月曜`）も受理され、日本語のまま（`lang: "ja"`）返る。Todoist UIで日本語で作られた規則も、そのままの文字列で返る。
- 取得結果の `recurrence` はTodoistが保持する文字列で、入力と一致しないことがある（`every month on the 25th` → `every 25th`、`after 3 days` → `every! 3 days`。`starting …` は文字列に残らず、開始日は `due` に反映される）。
- 規則を変更すると、時刻は規則に含めない限り現在の時刻が引き継がれる。
- 曜日・時刻・完了日は、Todoistアカウントのtimezone設定で解釈される。floatingな時刻は `defaults.timezone` のoffset付き日時として返す。

## 受理されない規則

Todoistは `tomorrow` や `2026-12-01` のような繰り返しでない文字列も、単発の期限として受理する。そのためAI Foundationは書き込みの後に、繰り返しとして登録されたか（`isRecurring`）を必ず確認する。

| 場合 | 挙動 |
|---|---|
| 作成時に繰り返しとして解釈されなかった | 作成したTaskを削除し、`Invalid input`（`no task was created`）を返す |
| 上記で、削除できたことを確認できない | 削除の戻り値が `true` 以外、または例外・タイムアウトなら、Taskを読み直す。404なら削除済みとみなす。残っていれば `Todoist API error`（`The task still exists`・Task ID・直し方・`task_create` を再試行しない旨）、読み直しも失敗したら同じErrorで `may still exist` とする |
| 更新時に繰り返しとして解釈されなかった | 期限を更新前の状態に戻し、`Invalid input`（`was left as before`）を返す。繰り返しの期限を戻した場合は、Todoistが次回期限を計算し直すことがあり、そのときは戻した後の次回期限をMessageに含める |
| 時刻付きの繰り返しを戻す | 規則の文字列に時刻がない場合（`every day at 9am` から `every day` に変えて09:00を引き継いだ場合など）も時刻を戻すため、まず時刻を指定した規則（`every day at 09:00`）を設定し、続けて元の規則を送る。Todoistは、規則を単発の期限や期限なしの状態に設定すると時刻を落とすが、規則から規則への変更では時刻を引き継ぐ |
| 戻した結果を確認する | 戻した後の期限を元と比べ、繰り返しの場合は規則の文字列・時刻・timezone、単発の場合は日付・日時が一致したときだけ「元に戻った」とする（繰り返しの次回期限の違いは許容） |
| 上記で、元に戻せなかった・一致しなかった | `Todoist API error` で、現在の期限と元の期限を示す |
| Todoistが規則を含むリクエストをHTTP 400で拒否した | 書き込みは起きていない。`Invalid input: Todoist rejected the request with recurrence "<rule>" (HTTP 400). Check the rule syntax…` を返す（400は原因を返さないため、構文エラーとは断定しない）。規則を含まないリクエストの400は従来どおり `Todoist API error` |

Connectorが削除するのは、同じ `task_create` 呼び出しで作成したTaskだけ。既存のTaskを削除する操作やToolはない。

## 既知の制約

- 作成とロールバックの削除は別リクエストで、Todoist APIにTransactionはない。削除の前に他のTodoist Clientへ同期・表示されることや、削除そのものの失敗は防げない（後者はErrorで明示する）。
- 繰り返しの期限を元に戻すときは元の規則の文字列を送るため、次回期限が元の日付と一致しないことがある（例: 10/26 → 11/02）。floatingな単発時刻は `defaults.timezone` の固定時刻として戻る。
- 期限の変更前の確認と更新の間にTodoist側で繰り返しが設定される競合は防がない（完全な排他制御はしない）。
- 繰り返しTaskへの `due` 更新の確認のため、`due` を含む `task_update` ではTodoistへの読み取りが1回増える。

## MVP対象外

次回1回分だけの延期（繰り返しを保持したまま次回の日付だけ動かす）、繰り返し用の `task_list` Filter、規則の構造化（頻度・曜日等のField化）、独自のRecurrence Engine / Scheduler / DB、`"<規則> starting <日付>"` による次回期限の完全な復元（実装前Probeで英語の規則では有効と確認したが、過去日・完了日基準・日本語などを網羅していないため見送り）。
