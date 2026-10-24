# 複数Calendar・期間イベント・説明欄 — Design

[Issue #12](https://github.com/thanatos27/ai-foundation/issues/12) の仕様。実装の詳細は [Implementation Plan](../plans/schedule-calendars-implementation-plan.md) を参照。[MVP v0.1仕様](mvp-v0.1.md) は当時の仕様として維持し、本書をv0.1以降に追加された仕様とする。[Google Calendar参加済みフラグ](schedule-attendance.md)（Issue #15）は本書で廃止した。

## Goal

気になるイベントの開催期間と、実際に行く予定を、Google Calendarの別々のCalendarに分けて登録・取得できるようにする。予定の説明欄と場所を、Google Calendarの標準Fieldとしてそのまま読み書きする。

## 運用モデル

| 置き場所 | 登録するもの |
|---|---|
| 期間イベント用Calendar | 気になるイベント・開催期間。参加するかどうかは問わない |
| 通常Calendar | 実際に行くと決めた日時・参加予定 |
| Todoist | チケット購入・予約などの行動と期限 |

- 期間イベントを実際に訪問することになっても、開催情報は移動・削除しない。訪問予定を通常Calendarへ別に登録する。
- 通常Calendarに予定があることは「参加予定だった」ことを表すだけで、参加実績とは同一視しない。急な不参加・参加結果・理由は、必要なら説明欄に自由記述する。
- 参加状態の自動推定・専用ステータス・興味状態のFieldは設けない。期間イベントと訪問予定／Todoistの自動連携はしない。
- 期間イベント専用のEntity・DB・状態は持たない。期間イベントも通常予定も `Schedule` として扱い、Google CalendarをSource of Truthとする。

## Configuration

```yaml
sources:
  schedule:
    provider: google_calendar
    default_calendar: personal
    writable_calendars:
      personal: "xxxxxxxx@group.calendar.google.com"
      events: "yyyyyyyy@group.calendar.google.com"
```

| # | 規則 |
|---|---|
| C1 | 旧 `writable_calendar_id` は廃止。設定に残っていると、移行手順を示すConfig Errorで起動しない（自動変換しない） |
| C2 | `writable_calendars` は1件以上 |
| C3 | `writable_calendars` があれば `default_calendar` が必須で、そのKeyのいずれか |
| C4 | `writable_calendars` なしの `default_calendar` は不可 |
| C5 | 同じCalendar IDを複数の別名に割り当てない |
| C6 | Calendar IDに `primary`（大文字小文字を問わない）を使わない |

- 別名は英小文字で始まり、英小文字・数字・`_`・`-` の32文字以内。`@` や `.` を含まないため、Calendar IDと混同しない。
- 両方とも省略した設定は有効。Serverは起動し、`schedule_list` は使える。`schedule_create` / `schedule_update` はConfiguration Errorになる。
- Calendar IDの形式は検証しない。別名が意図したCalendarを指しているかは、設定後に利用者が確認する（Calendarの名前・権限を確認する、または各別名へ予定を作ってGoogle Calendarで表示先を確かめる）。

## Schedule

| Field | 内容 |
|---|---|
| `calendar` | 書き込み先Calendarなら別名（`personal`）、それ以外の読み取り可能CalendarならGoogle CalendarのID |
| `description` | Google Calendarの説明欄の原文（HTMLのことがある）。空なら `null` |
| `location` | Google Calendarの場所の原文。空なら `null` |

- 3 Fieldは常に出力する。`id`（`google_calendar:<calendar-id>:<event-id>`）/ `source` / `external_ref`（Google CalendarのEventへのリンク）/ `type` / `title` / `start` / `end` は従来どおり。
- 公式サイトのURL専用Fieldは設けない。説明欄に書く。
- 説明欄・場所はtrim・HTML解析・Entity decode・正規化をしない（改行・`\r\n`・前後の空白・HTMLがそのまま往復することを実Google Calendarで確認済み）。

## Tool Interface

```text
schedule_create({ title, start, end?, calendar?, description?, location? }) → { schedule }
schedule_list({ start, end, calendar? }) → { schedules }
schedule_update({ id, title?, start?, end?, description?, location? }) → { schedule }
```

### `schedule_create`

- `calendar` は設定済みの別名だけ。省略時は `default_calendar`。Calendar IDや未知の別名はInput Error（Messageには別名だけを列挙し、Calendar IDを含めない）。
- 時刻予定・終日予定・`end` 省略時のDefault（1時間 / 1日）は従来どおり。
- `description` / `location` の `null` は省略と同じ（送らない）。空文字は不可。

### `schedule_list`

- `calendar` を省略すると従来どおり読み取り可能な全Calendar（hidden含む、free/busyのみのものを除く）。
- `calendar` には別名、または結果の `calendar` に出るCalendar IDを渡せる。読み取り可能なCalendarでなければInput Error。
- 期間に**重なる**予定を返す（期間の開始前から続く予定も含む）。並び順・キャンセル済みの除外・1つのCalendarの失敗で全体をErrorにする扱いは従来どおり。

### `schedule_update`

| Input | 扱い |
|---|---|
| 省略したField | 変更しない |
| `description: null` / `location: null` | 消去する |
| `title` / `start` / `end` の `null` | Input Error（`end: null` で既定の長さに戻す、という解釈はしない） |
| `start` だけ / `end` だけ | 指定した側だけを変更し、もう片方はGoogle Calendar上の値のまま。既存の予定と同じ種類（時刻 / 終日）で、順序が正しいこと |
| `start` と `end` の両方 | 両方を変更する。時刻予定 ↔ 終日予定の切替はこの場合だけ |
| `calendar` | 受け付けない（Calendar間の移動はしない） |
| `id` のみ | Input Error（少なくとも1つのFieldが必要） |

- Google Calendarへは `events.patch` で、指定したFieldと端点だけを送る。AI Foundationが扱わないField（参加者・通知・色・添付・会議情報等）は変わらない。
- 片側だけを変えるとき、事前に取得した反対側の値は順序の確認にだけ使い、書き戻さない。取得から更新までの間に反対側が変わって順序が逆転した場合は、Google Calendarが拒否する（Provider API Error）。

## 書き込み制限

| 状況 | 結果 | Google Calendarを呼ぶか |
|---|---|---|
| 書き込み先が未設定 | Configuration Error | 呼ばない |
| 未知の別名（作成） | Input Error | 呼ばない |
| 不正なSchedule ID（更新） | Input Error | 呼ばない |
| 書き込み先以外のCalendarの予定（更新） | Input Error | 呼ばない |
| 存在しない・削除済みの予定（更新） | Not Found | 取得のみ |
| 繰り返しの系列・各回（「この予定のみ」編集した回を含む） | Input Error | 取得のみ |
| `eventType` が `default` 以外（誕生日・不在・作業場所等） | Input Error | 取得のみ |
| 他人が主催する（招待された）予定 | Input Error | 取得のみ |
| 片側だけの時刻変更で種類が変わる・順序が逆転する | Input Error | 取得のみ |
| 設定したCalendarが存在しない・書き込み権限がない | Configuration Error（別名を含む） | 呼んだ結果 |

## 期間イベントと日付

- 期間イベントは日付だけの終日予定で、AI Foundationの `end` は**最終日を含む**。Google Calendarの終日予定は終了日を含まないため、保存時に+1日、取得時に-1日する（作成・一覧・更新のすべて）。
- 日付だけの期間は `defaults.timezone` の日の始まりで区切る。

## 廃止した機能（Issue #15）

`schedule_list.attended_only` と、説明欄の `#attended` タグによる参加済み判定を削除した。`attended_only` を渡すとInput Errorになり、出力は説明欄のタグの有無に依存しない。RSVPによる参加判定も行わない。

## MVP対象外

Calendar間の予定の移動、予定の削除、Calendarの自動作成、設定外のCalendarへの書き込み、繰り返し予定の更新、専用の興味・参加状態、参加実績の自動推定、期間イベントと訪問予定／Todoistの自動紐付け。
