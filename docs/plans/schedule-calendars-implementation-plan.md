# 複数Calendar・期間イベント・説明欄 — Implementation Plan

- Status: **rev.2（Plan Review rev.2で承認。User承認済み）**
- 作成: Coding Agent (Claude Code) / 2026-10-25（rev.2: 2026-10-25 PR #27 Review反映。§19）
- 対象: [Issue #12](https://github.com/thanatos27/ai-foundation/issues/12)（コメント「MVP方針更新：カレンダーによる分類＋説明欄の汎用利用」と「MVP詳細設計 v0.1（ユーザー承認済み / 2026-10-25）」を正とする）
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md)（**変更しない**）, [Phase 2 Design Issue](../specs/phase-2-task-schedule.md), [Phase 2 Implementation Plan](phase-2-implementation-plan.md), [Google Calendar参加済みフラグ Design](../specs/schedule-attendance.md)（本Issueで廃止）, [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

詳細設計v0.1で「Implementation Planで詰めること」とされた4項目は、§6（Calendar別名・設定移行）、§4・§8.6（`events.patch`・繰り返しの識別）、§7.3・§8.6（start / end の部分更新・`end: null`）、§8.7（許可されないCalendar・招待予定）で決める。設計に明記がなく本Planで決めた箇所は [§18 懸念点 / 未確定事項](#18-懸念点--未確定事項) にQとしてまとめる。実APIでしか確定できない挙動は [§5 実装前Probe](#5-実装前probe実google-calendar実装着手前に実施) で確認してから実装する。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/schedule-calendars-implementation-plan`。Baseは `main` の `9236a48`（PR #26 Merge、繰り返しタスク実装済み） |
| 依存 | `@googleapis/calendar ^20.1.0`、`zod 4.6`、Node `>=24`。**追加依存なし** |
| 公開Tool | 20件 → **21件**（`schedule_update` を追加） |
| OAuth Scope | `calendar.calendarlist.readonly` / `calendar.events`。`events.get` / `events.patch` も `calendar.events` で可能なため**変更しない**（再認可不要） |
| CI | なし（`npm test` をローカルのWindows環境で実行） |

### 既存実装の要点（本Issueで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/config/schema.ts` | `sources.schedule = strictObject({ provider: 'google_calendar', writable_calendar_id?: string })`。未設定でもServerは起動し、`schedule_create` だけがConfiguration Errorになる |
| `src/connectors/index.ts` | `writableCalendarId: config.sources.schedule.writable_calendar_id` をConnectorへ渡す |
| `src/domain/schedule.ts` | `ScheduleSchema`（`id` / `source` / `external_ref` / `type` / `title` / `start` / `end` / `tags`）、`ScheduleCreateInputSchema`（`title` / `start` / `end`）、`ScheduleListFilterSchema`（`start` / `end` / `attended_only`）、`normalizeScheduleCreateInput`（時刻予定は1時間、終日は1日のDefault） |
| `src/connectors/google-calendar/client.ts` | `CalendarApi` は `insertEvent` / `listCalendars`（`minAccessRole: 'reader'`・`showHidden: true`）/ `listEvents`（`singleEvents: true`・`orderBy: 'startTime'`・`showDeleted: false`）。`toFoundationError` は401・403（Rate Limit以外）を `CredentialError`、404を `notFound` で差し替え、それ以外を `ProviderApiError` にする |
| `src/connectors/google-calendar/connector.ts` | `create` は `writableCalendarId` だけへ書く（Inputは `calendarId` に届かない）。`list` は全Calendarを `Promise.all` で読み、1つでも失敗すれば全体Error、`cancelled` 除外 → `attended_only` filter → `toSchedule` → `startInstant` + `title` でソート |
| `src/connectors/google-calendar/mapping.ts` | `toGoogleEvent`（終日のendを+1日）、`toTimeRange`（日付は `defaults.timezone` の日の始まり、end日付は翌日0時まで）、`toScheduleId` = `google_calendar:<calendarId>:<eventId>`、`toSchedule`（終日のexclusive endを-1日、`description` は出力しない） |
| `src/connectors/google-calendar/attendance.ts` | `hasAttendedFlag`（Issue #15、本Issueで削除） |
| `src/tools/schedule.ts` | `schedule_create` / `schedule_list` を登録 |
| `tests/helpers/fake-connectors.ts` | `FakeScheduleConnector`（`create` / `list` の呼び出しを記録） |
| `tests/connectors/google-calendar/connector.test.ts` | `FakeCalendarApi`（Calendar別の `events`、`failEvents` 等） |
| `tests/integration/google-calendar.integration.test.ts` | `writable_calendar_id` へ作成・一覧し、`afterAll` で削除。読み取り可能な全Calendar（hidden含む）を読むことも確認 |
| `tests/integration/google-calendar-attendance.integration.test.ts` | Issue #15のRead-only Test（本Issueで削除） |

---

## 2. 設計方針

1. **既存の `Schedule` Entityを拡張する。** 期間イベント専用のEntity・DB・状態は作らない。期間イベントは「期間イベント用Calendarにある終日予定」にすぎない（v0.1 §基本方針）。
2. **書き込み先は設定済みの別名だけ。** Tool Inputの `calendar` は `writable_calendars` の別名としてのみ解釈し、Google CalendarのIDとして書き込み先に採用しない。更新もIDに含まれるCalendar IDが設定済みの書き込み先であることを、APIを呼ぶ前に確認する。
3. **読み取りは従来どおり全Calendar。** `schedule_list` の `calendar` 省略時の挙動（対象Calendar・期間解釈・ソート・Error）は変えない。出力にFieldが3つ増える点だけが変わる。
4. **説明欄・場所は原文のまま。** `description` / `location` はtrim・HTML解析・Entity decode・正規化をしない。空文字だけは「未設定」として `null` に揃える（§8.2）。
5. **更新は変更Fieldだけを送る（`events.patch`）。** AI Foundationが扱わないField（参加者・通知・色・添付・会議情報等）を上書きしない。
6. **単発イベントだけを更新する。** 繰り返しの系列・個々の回はAPIを呼ぶ前に拒否する（v0.1 §期間イベントと日付）。
7. **`#attended` / `attended_only` は完全に削除する。** 後方互換・非推奨期間は設けない（Issue #12 MVP方針更新）。
8. **Provider固有処理はConnectorに閉じる。** Domain / Toolは「別名」「説明欄」「場所」という意味だけを持ち、IDの分解・exclusive end・patchのnull表現はGoogle Calendar Connectorの責務とする（AGENTS.md Layer責務）。

---

## 3. 既存実装への変更点（概要）

| 対象 | 変更 |
|---|---|
| `src/config/schema.ts` | `writable_calendar_id` を廃止し、`default_calendar` / `writable_calendars` を追加。旧Keyは移行手順付きのErrorで拒否（§6） |
| `src/domain/schedule.ts` | `Schedule` に `calendar` / `description` / `location`。Create Inputに `calendar` / `description` / `location`。List Filterに `calendar`、`attended_only` 削除。`ScheduleUpdateInputSchema` 新設（§7） |
| `src/connectors/types.ts` | `ScheduleConnector.update` を追加 |
| `src/connectors/google-calendar/client.ts` | `CalendarApi.getEvent` / `patchEvent` を追加。`toFoundationError` に `forbidden` Optionを追加（§8.1） |
| `src/connectors/google-calendar/calendars.ts`（新規） | 別名 ↔ Calendar IDの解決（§8.3） |
| `src/connectors/google-calendar/mapping.ts` | `toGoogleEvent` / `toSchedule` に3 Field、`parseScheduleId`、`toEventPatch`（§8.2） |
| `src/connectors/google-calendar/connector.ts` | `create` の別名解決、`list` の `calendar` 絞り込みと `attended_only` 削除、`update` 新設（§8.4〜§8.6） |
| `src/connectors/google-calendar/attendance.ts` | **削除** |
| `src/connectors/index.ts` | Connectorへ `writableCalendars` / `defaultCalendar` を渡す |
| `src/tools/schedule.ts` | 3 Toolのdescription、`schedule_update` 登録（§9） |
| `config.yaml` | コメントの設定例を新形式へ |
| README / 個別仕様 | §16 |

**変更しないもの**: `docs/specs/mvp-v0.1.md`、`GOOGLE_CALENDAR_SCOPES`、`listCalendars` / `listEvents` のParameter、`toTimeRange`、`startInstant`、ソート規則、`src/instructions.ts`（Q8）、`src/credentials/**`、`.env.example`、他Entityの実装。

---

## 4. Google Calendar APIの仕様（本Planが前提とするもの）

| 項目 | 前提 | Probe |
|---|---|---|
| `events.get(calendarId, eventId)` | 存在しなければ404、削除済みは `status: 'cancelled'` で返る場合がある | P2 |
| 繰り返しの識別 | 系列（親）は `recurrence: string[]` を持つ。`singleEvents: true` で展開された回は `id` が `<親id>_<日付/日時>` で `recurringEventId` を持つ。「この予定のみ」編集した回も `recurringEventId` を持つ | P2 |
| `events.patch(calendarId, eventId, requestBody)` | 送ったFieldだけ変更。入れ子Object（`start` / `end`）は送ったKeyだけマージされ、配列は置き換え | P3 / P4 |
| Fieldのクリア | `description` / `location` をpatchで消すには `null` を送る（不可なら空文字） | P1 |
| 時刻予定 ↔ 終日予定の切替 | `start: { date, dateTime: null }` のように反対側を `null` にすると切り替わる。既存の `timeZone` が残っても終日予定として受理される | P3 |
| 時刻予定の `timeZone` | patchで `start.dateTime` だけ送ると、UIで作った予定が持つ `start.timeZone`（例: `Asia/Tokyo`）は保持される | P4 |
| 片側だけのpatch | 種類を変えない更新では `start` だけ（または `end` だけ）を送れば、送らなかった側は変わらない。結果が `end < start` になるpatchは400で拒否される | P9 |
| 本文 | `description` はUIで書式を付けるとHTML、APIで送った改行（`\n`）はそのまま保存・返却される | P5 |
| 書き込み権限のないCalendar | `events.insert` / `events.patch` は403。`error.errors[].reason` が `forbidden` / `requiredAccessLevel` 等 | P6 |
| Event ID | `[a-v0-9]` の base32hex、展開された回は `_<YYYYMMDD>` / `_<YYYYMMDDTHHMMSSZ>` が付く | P7 |
| 招待された予定 | 自分が主催者でない予定は `organizer.self` が `true` でない。主催者以外が `summary` 等を変更すると403（`forbiddenForNonOrganizer`）、または自分のコピーだけが変わる | P8 |

---

## 5. 実装前Probe（実Google Calendar、実装着手前に実施）

§4のうち実APIでしか確定できない挙動を、Plan承認後・実装着手前に確認し、結果を本Planの「実装で確定した事項」に記録する。

- 実行方法: Scratchpadに置く使い捨てScript（Repositoryにcommitしない）から `@googleapis/calendar` を直接使う。Credentialは既存Integration Testと同じ `.env` の `GOOGLE_OAUTH_*`。
- 対象: **現在の `writable_calendar_id`（AI Foundation専用Calendar）にScriptが作成した `[af-probe <timestamp>]` 接頭辞付きEventだけ**を書き換え、終了時に削除する。既存の予定は読み取りのみ（P7の件数・P8の該当有無だけ）で、更新しない。
- 記録: HTTP status、`error.errors[].reason`、返却Eventの該当Field（`start` / `end` / `description` / `location` / `recurrence` / `recurringEventId` / `organizer` / `eventType`）。タイトル・説明欄の実データ・Calendar IDは記録しない。

| # | 操作 | 確認したいこと | Planの前提 / 結果が違った場合 |
|---|---|---|---|
| P1 | 作成したEventに `patch({ description: null })`、別のEventに `patch({ description: '' })`。`location` も同様 | `get` で `description` / `location` が消えるか（Keyなし or 空文字） | `null` で消える前提。消えなければ `''` を送る（`toEventPatch` の1箇所だけが変わる。Domainは `null` のまま） |
| P2 | `recurrence: ['RRULE:FREQ=DAILY;COUNT=3']` で作成 → `list(singleEvents)` → 親と回を `get`。1回を「この予定のみ」相当に `patch` してから `get`。単発Eventを削除してから `get` | 親の `recurrence`、回の `recurringEventId`・ID形式、編集した回も `recurringEventId` を持つか、削除済みが404か `cancelled` か | 前提どおりなら §8.6の判定のまま。編集した回が `recurringEventId` を持たない場合は `originalStartTime` の有無も判定に加える |
| P3 | 時刻予定を `patch({ start: { date, dateTime: null }, end: { date, dateTime: null } })`、その逆 | 種類を切り替えられるか、`timeZone` が残っていても拒否されないか | 切り替えられる前提。拒否されるなら `timeZone: null` も送る。それでも不可なら「種類の切替」をMVP外にしてPlanを修正する |
| P4 | `start.timeZone: 'Asia/Tokyo'` 付きで作成した時刻予定に `patch({ start: { dateTime: '…+09:00' }, end: {…} })` | `timeZone` が保持されるか | 保持される前提（UIでの表示Zoneを変えない） |
| P5 | `description: '1行目\n2行目\n<b>太字</b> &amp; <a href="https://example.com">x</a>'`、`location: '東京都千代田区…'` で作成・patch → `get` | 文字列が完全一致で返るか | 完全一致の前提。Googleが正規化する場合は、その変換をTestの期待値に反映し、仕様書に「Google Calendarが保存時に変換する」と書く（AI Foundation側では変換しない） |
| P6 | `listCalendars` で `accessRole: 'reader'` のCalendar（例: 日本の祝日）へ `insert` | 403の `reason` | `forbidden` / `requiredAccessLevel` → §8.7の `ConfigurationError`。別の値なら判定対象のreasonを差し替える |
| P7 | 前後1年の `list`（Read-only） | 全EventのIDが `^[A-Za-z0-9_]+$` に合うか（件数だけ記録） | 合う前提。合わないIDがあれば `parseScheduleId` の許容文字を広げる |
| P8 | 前後1年の `list` で `organizer.self !== true` のEvent、AI Foundation専用Calendarに作ったEventの `organizer` を `get`（Read-only） | 専用Calendarの予定の `organizer.email` がCalendar ID・`self` の値、招待予定の `organizer` / `eventType` | 専用Calendarの予定は `organizer.email === calendarId` の前提。違えば §8.6 手順5の判定を合わせる |
| P9 | 時刻予定（`timeZone` 付き / なし）と終日予定（3日間）に、(a) `patch({ start })` だけ (b) `patch({ end })` だけ (c) `end` より後の `start` だけ | (a)(b)で送らなかった側と `timeZone` が完全に不変か。(c)のHTTP statusとreason | (a)(b)は不変の前提（§8.6の片側patch）。片側だけでは受理されない・反対側が変わる場合は、両端点の送信に戻し、同時編集で反対側を上書きし得ることをQ6・仕様書に明記したうえでPlanを修正する。(c)は400の前提（§8.6の競合時の扱い） |

Probe結果がPlanの前提と異なり設計判断が変わる場合（P3で種類の切替ができない等）は、実装前にPlanを修正してReviewを受け直す。

---

## 6. Configuration（`src/config/schema.ts`）

### 6.1 新しい形式

```yaml
sources:
  schedule:
    provider: google_calendar
    default_calendar: personal
    writable_calendars:
      personal: "xxxxxxxx@group.calendar.google.com"   # 通常の予定
      events: "yyyyyyyy@group.calendar.google.com"     # 期間イベント
```

```ts
/** A writable calendar's name in config and tool input, e.g. `personal`. Never a calendar ID (no `@`). */
export const CalendarAliasSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, {
  message: 'must be lowercase letters, digits, "_" or "-", starting with a letter (max 32)',
});

schedule: z
  .strictObject({
    provider: z.enum(['google_calendar']),
    default_calendar: CalendarAliasSchema.optional(),
    writable_calendars: z.record(CalendarAliasSchema, z.string().trim().min(1)).optional(),
    /** Removed by Issue #12: rejected with a migration message instead of "unrecognized key". */
    writable_calendar_id: z.never({ error: WRITABLE_CALENDAR_ID_REMOVED }).optional(),
  })
  .superRefine(/* §6.2 の C2〜C5 */),
```

### 6.2 検証規則

| # | 規則 | Error（`ConfigError` の `path: message`） |
|---|---|---|
| C1 | 旧 `writable_calendar_id` があれば拒否 | `sources.schedule.writable_calendar_id: was replaced by writable_calendars and default_calendar; e.g. writable_calendars: { personal: "<this ID>" } and default_calendar: personal (see README "Google Calendar")` |
| C2 | `writable_calendars` は1件以上 | `sources.schedule.writable_calendars: must list at least one calendar` |
| C3 | `writable_calendars` があれば `default_calendar` 必須、かつそのKeyの1つ | `sources.schedule.default_calendar: must be one of personal, events` |
| C4 | `default_calendar` だけがある設定は拒否 | `sources.schedule.default_calendar: needs writable_calendars` |
| C5 | 同じCalendar IDを複数の別名に割り当てない | `sources.schedule.writable_calendars.<alias>: same calendar ID as <alias>` |
| C6 | Calendar IDに `primary`（大文字小文字を問わない）を使わない（rev.2） | `sources.schedule.writable_calendars.<alias>: "primary" is not allowed; set the calendar's own ID from its settings` |

- C6: `primary` はGoogle Calendar APIが認証ユーザーのメインCalendarへ動的に解決する特別な識別子で、設定値として固定のCalendarを指さない。ID形式の厳密な検証（`@` の有無など）は行わない。誤ったCalendar IDの検出は §6.4のセットアップ確認で行う。

- 別名に `@` や `.` を許さないため、別名とGoogle Calendar ID（必ず `@` を含む）は文字列として衝突しない（§8.3の `schedule_list` の解決で利用）。
- 両方とも省略した設定は有効（Serverは起動し、`schedule_list` は使える。`schedule_create` / `schedule_update` は `ConfigurationError`）。従来の「未設定でもServerは起動する」を維持する。

### 6.3 旧設定からの移行（Q1）

- 旧 `writable_calendar_id` を含む設定は**起動時に `ConfigError` で停止**し、上記C1のMessageで新形式を案内する（自動変換・非推奨期間なし）。
- 利用者の作業: `config.local.yaml` の1行を次の3行へ置き換え、期間イベント用Calendarを使うなら1行足す。
  ```yaml
  default_calendar: personal
  writable_calendars:
    personal: "<旧writable_calendar_idの値>"
  ```
- READMEの「ローカル設定」「Google Calendar」節に移行手順を書く。実装時は、利用者の承認を得て手元の `config.local.yaml`（Git管理外）を移行してからIntegration Testを行う。

### 6.4 書き込み先Calendarの実体確認（rev.2）

設定値は非空文字列であれば許可リストとして有効になるため、**別名が意図したCalendarを指していること**を運用手順として確認する。

本番運用での対応:

| 別名 | 意図するGoogle Calendar |
|---|---|
| `personal`（default） | 「AI Foundation」（既存の専用Calendar。旧 `writable_calendar_id`） |
| `events` | 「Event Catalog」（期間イベント用。2026-10-25に利用者が作成済み） |

確認手順（実装の手順2で `config.local.yaml` を移行した直後、Integration Testの前に実施）:

1. 読み取り専用のScratchpad Script（Repositoryにcommitしない）で、`writable_calendars` の各IDについて `calendarList.get` / `listCalendars` の結果から `summary` と `accessRole` を取得し、(a) `summary` が上表と一致、(b) `accessRole` が `owner` または `writer`、(c) 2つのIDが異なる、を確認する。
2. §14.1の Integration Test で `personal` / `events` の両方へテスト用Eventを作成し、生のAPIで**設定したCalendar ID側**から `events.get` できること、もう一方のCalendarには存在しないことを確認する（作成したEventは削除）。
3. 結果は「別名 → `summary` / `accessRole` / 一致したか」だけをPlanに記録する。**Calendar IDはPlan・PR・Review Comment・Commitに書かない。**

READMEにも、Calendar IDは各Calendarの「カレンダーの設定 → カレンダーの統合」から写すこと、`primary` やメールアドレスを推測して使わないこと、設定後に上記1と同じ確認（`summary` が意図どおりか）をすることを書く。

---

## 7. Domain（`src/domain/schedule.ts`）

### 7.1 `Schedule`（出力）

```ts
export const ScheduleSchema = z
  .object({
    ...OptionalMetadataShape,
    type: z.literal('schedule'),
    /** A configured alias (`personal`) for a writable calendar; otherwise the provider's calendar ID. */
    calendar: z.string().min(1),
    title: z.string().min(1),
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema.nullable().optional(),
    /** The source's free-form body as stored (may be HTML); null when empty. */
    description: z.string().nullable(),
    location: z.string().nullable(),
    tags: TagsSchema.optional(),
  })
  // 既存のrefine 2つは維持
```

- 3 Fieldは**常に出力する**（未設定は `null`）。`id` / `source` / `external_ref` / `type` / `title` / `start` / `end` は従来どおり。
- 公式URL専用Fieldは設けない（説明欄に書く。v0.1）。

### 7.2 `schedule_create` / `schedule_list` Input

```ts
const ScheduleTextSchema = z.string().min(1); // description / location: stored as given, not trimmed

export const ScheduleCreateInputSchema = z
  .strictObject({
    title: z.string().min(1),
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema.nullable().optional(),
    /** A writable calendar alias from config; omitted: default_calendar. */
    calendar: z.string().min(1).optional(),
    description: ScheduleTextSchema.nullable().optional(),
    location: ScheduleTextSchema.nullable().optional(),
  })
  // 既存のrefine 2つは維持

export const ScheduleListFilterSchema = z
  .strictObject({
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema,
    /** A writable calendar alias or a readable calendar's ID (as in Schedule.calendar); omitted: every calendar. */
    calendar: z.string().min(1).optional(),
  })
  .refine(/* 既存 */);
```

- `calendar` の形式（別名か）はDomainでは検証せず、Connectorが設定と照合して「設定済みの別名」を列挙したErrorを返す（Q2）。Schemaは文字列であることだけを保証する。
- Createの `description: null` / `location: null` は省略と同じ（送らない）。空文字は拒否（クリアの表現は `null` に一本化する）。
- `attended_only` を削除する。`strictObject` のため `attended_only` を渡すと `Input validation error` になる（AC）。

`NormalizedScheduleCreate` の両分岐に `description: string | null` / `location: string | null` を追加し、`normalizeScheduleCreateInput` が `?? null` で埋める。別名の解決は設定に依存するためDomainでは行わない（`calendar` はConnectorがInputから直接読む）。

### 7.3 `schedule_update` Input（新規）

```ts
const SCHEDULE_UPDATE_FIELDS = ['title', 'start', 'end', 'description', 'location'] as const;

export const ScheduleUpdateInputSchema = z
  .strictObject({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    start: DateOrDateTimeSchema.optional(),
    end: DateOrDateTimeSchema.optional(),
    /** null clears the field; omitted keeps it. */
    description: ScheduleTextSchema.nullable().optional(),
    location: ScheduleTextSchema.nullable().optional(),
  })
  .refine((input) => SCHEDULE_UPDATE_FIELDS.some((field) => input[field] !== undefined), {
    message: `At least one of ${SCHEDULE_UPDATE_FIELDS.join(', ')} must be specified`,
  })
  .refine(sameDateKind, MIXED_DATE_KIND)
  .refine((value) => !sameDateKind(value) || endNotBeforeStart(value), END_BEFORE_START);
```

| 判断 | 内容 |
|---|---|
| 未指定と `null` | `description` / `location` は「Keyなし = 保持」「`null` = クリア」。`title` / `start` / `end` は `null` を拒否（Q3） |
| `end: null` | **拒否する**。`schedule_create` の「`end` 省略 / `null` = Default」を更新へ持ち込むと「保持」との区別が曖昧になるため（Q3） |
| `calendar` | 受け取らない（strictで拒否）。Calendar間の移動はMVP外 |
| 少なくとも1 Field | `id` だけの呼び出しは拒否（`task_update` と同じ方式） |
| start / end の両方を指定 | 種類の混在と逆順をSchemaで拒否 |
| 片方だけ指定 | 既存のもう片方との整合はEventを取得してからConnectorが検証する（§8.6） |

---

## 8. Connector（`src/connectors/google-calendar/`）

### 8.1 Client（`client.ts`）

```ts
export interface CalendarApi {
  insertEvent(calendarId: string, event: GoogleEvent): Promise<GoogleEvent>;
  getEvent(calendarId: string, eventId: string): Promise<GoogleEvent>;
  /** Changes only the fields present in `patch` (events.patch). */
  patchEvent(calendarId: string, eventId: string, patch: GoogleEvent): Promise<GoogleEvent>;
  listCalendars(): Promise<GoogleCalendarListEntry[]>;
  listEvents(calendarId: string, range: { timeMin: string; timeMax: string }): Promise<GoogleEvent[]>;
}
```

- `CalendarResources.events` に `get` / `patch` を追加し、`calendarApiFrom` で `{ calendarId, eventId }` / `{ calendarId, eventId, requestBody }` をそのまま渡す。`sendUpdates` は指定しない（Default: 通知しない）。
- `events.update` ではなく `events.patch` を使う（Q4）。
- `toFoundationError` に `forbidden?: () => FoundationError` を追加する。403のうち `reason` が `forbidden` / `requiredAccessLevel` / `forbiddenForNonOrganizer`（P6 / P8で確定）のときだけ差し替え、`insufficientPermissions`（Scope不足）等は従来どおり `CredentialError`。
- コメント「restricts writes to the configured calendar」を「configured calendars」へ直す。

### 8.2 Mapping（`mapping.ts`）

| 関数 | 変更 |
|---|---|
| `toGoogleEvent(schedule)` | `description` / `location` が `null` でなければ同名Fieldで送る（`null` はKeyごと送らない） |
| `toSchedule(event, calendarId, calendar)` | 第3引数に出力用の `calendar`（別名 or ID）。`description: event.description \|\| null`、`location: event.location \|\| null`（空文字も `null`、それ以外は**完全に原文**）。その他は不変 |
| `parseScheduleId(id)`（新規） | `google_calendar:` で始まり、最後の `:` の前をCalendar ID、後をEvent IDとする。Calendar IDは空でないこと、Event IDは `^[A-Za-z0-9_]+$`（P7）。違反は `InputValidationError('schedule id must look like "google_calendar:<calendar-id>:<event-id>", got "…"')` |
| `toEventPatch(input, current)`（新規） | §8.6の手順6 |

- Calendar IDには `:` が入らない前提だが、最後の `:` で分けるため、仮に入っていてもEvent IDの切り出しは正しい（Event IDには `:` が入らない）。
- `toScheduleId` は変更しない。既存の `id` はそのまま `schedule_update` に渡せる。

### 8.3 Calendar解決（`calendars.ts`、新規）

```ts
export class WritableCalendars {
  constructor(aliases: Record<string, string> | undefined, defaultAlias: string | undefined);
  /** schedule_create: alias (or default) → calendar ID. Unknown → InputValidationError; none configured → ConfigurationError. */
  forCreate(alias: string | undefined): { alias: string; calendarId: string };
  /** schedule_update: whether `calendarId` (from the schedule id) is configured, and its alias. */
  aliasOf(calendarId: string): string | undefined;
  /** schedule_list `calendar`: alias → its ID; anything else is taken as a calendar ID to look up. */
  resolveForList(calendar: string): string;
  /** Schedule.calendar: alias for a configured calendar, the ID otherwise. */
  label(calendarId: string): string;
}
```

- 別名はConfigで `@` を含まないことが保証されるため、`resolveForList` で別名と一致しなければCalendar IDとして扱う。Calendar IDとして読めるかは `listCalendars` の結果で確認する（§8.5）。
- Error Messageには別名だけを列挙し、Calendar IDは含めない（Tool結果としてAI Clientに返るため）。

### 8.4 `create`

1. `const { alias, calendarId } = calendars.forCreate(input.calendar)`。
   - 書き込み先が1件も設定されていない → `ConfigurationError('sources.schedule.writable_calendars is not set; schedule_create needs at least one writable calendar')`
   - 未知の別名（Calendar IDを渡した場合を含む） → `InputValidationError('calendar must be one of the configured calendars: personal, events (got "…")')`
2. `api.insertEvent(calendarId, toGoogleEvent(normalizeScheduleCreateInput(input)))`。
   - 404 → `ConfigurationError('writable calendar "<alias>" was not found or is not accessible with these credentials')`（従来のMessageを別名基準に）
   - 403（§8.1の `forbidden`） → `ConfigurationError('writable calendar "<alias>" is not writable with these credentials')`
3. `toSchedule(created, calendarId, alias)`。

終日予定のexclusive end（+1日）、時刻予定の1時間Default、終日の1日Defaultは既存の `toGoogleEvent` / `normalizeScheduleCreateInput` のまま（期間イベントは `start` / `end` の日付指定で作るだけ）。

### 8.5 `list`

```ts
async list(filter: ScheduleListFilter): Promise<Schedule[]> {
  const range = toTimeRange(filter, timeZone);           // 変更なし
  const calendars = await api.listCalendars()…;          // 変更なし
  const wanted = filter.calendar === undefined ? undefined : this.calendars.resolveForList(filter.calendar);
  const targets = calendars.filter((e) => !!e.id && (wanted === undefined || e.id === wanted));
  if (wanted !== undefined && targets.length === 0) {
    throw new InputValidationError(`calendar "${filter.calendar}" is neither a configured calendar (…) nor a calendar you can read`);
  }
  // 以降は従来と同じ: Promise.all(listEvents) → cancelled除外 → toSchedule(event, id, label(id)) → ソート
}
```

| 観点 | 挙動 |
|---|---|
| `calendar` 省略 | 対象Calendar・API Parameter・ソート・Errorは従来と同じ。`attended_only` のfilterだけを削除する |
| 別名指定 | 設定済みIDのCalendarだけを `listEvents`。`listCalendars` に現れない（削除済み・権限なし）場合は上記 `InputValidationError` |
| ID指定 | `listCalendars`（reader以上）に含まれるIDだけ受理。freeBusyReaderのCalendarは従来どおり対象外 |
| 期間重複 | `listEvents` の `timeMin` / `timeMax` が「期間に重なる」Eventを返す（Google Calendar APIの仕様）。検索開始前から続く終日予定・期間全体を跨ぐ予定も返る（§13.4で境界を固定） |
| 出力 | 各要素に `calendar`（別名 or ID）、`description`、`location` |

### 8.6 `update`（新規）

```text
1. writable_calendars 未設定                  → ConfigurationError（APIを呼ばない）
2. parseScheduleId(input.id)                  → 不正形式は InputValidationError（APIを呼ばない）
3. calendars.aliasOf(calendarId) が undefined → InputValidationError（APIを呼ばない）
4. api.getEvent(calendarId, eventId)          → 404/410 は NotFoundError、status 'cancelled' も NotFoundError
5. 更新できないEventを拒否（PATCHしない）:
   - recurrence がある（系列）／recurringEventId がある（回）
   - eventType が 'default' 以外（focusTime / outOfOffice / workingLocation / birthday / fromGmail）
   - organizer があり、organizer.self !== true かつ organizer.email !== calendarId（招待された予定）
6. 新しい start / end を決めて検証し、patchを組み立てる（toEventPatch）
7. api.patchEvent(calendarId, eventId, patch) → 404 は NotFoundError、403 は ConfigurationError（§8.1）
8. toSchedule(updated, calendarId, alias)
```

**手順6 — start / end（Q5）**

| Input | 扱い |
|---|---|
| どちらも未指定 | `start` / `end` をpatchに含めない |
| 両方指定 | 種類・順序はSchemaで検証済み。同じ種類のまま、または時刻予定 ↔ 終日予定の切替として送る |
| `start` だけ | 既存Eventの種類と同じでなければ拒否（`give both start and end to switch between a timed and an all-day event`）。既存の `end` を保持し、新しい `start` より前になるなら拒否（`end … would be earlier than the new start; give end as well`） |
| `end` だけ | 同様に、種類が既存と同じで、既存 `start` 以上であること |

- 既存Eventの値の比較は既存の `toSchedule` と同じ変換（終日のendはinclusive）で行う。時刻予定は `Date.parse` で瞬間を比較し、終日予定は日付文字列で比較する。
- patchには**Inputで指定した端点だけ**を送る（rev.2。未指定の端点は送らず、Google Calendar側の値をそのまま残す）:

| Input | patchの `start` / `end` |
|---|---|
| `start` だけ（時刻） | `start: { dateTime }` のみ。`end` と `timeZone` は送らない（P4 / P9） |
| `end` だけ（時刻） | `end: { dateTime }` のみ |
| `start` だけ（終日） | `start: { date }` のみ |
| `end` だけ（終日） | `end: { date: addDays(endInclusive, 1) }` のみ |
| 両方・同じ種類 | 両方を上の形で送る |
| 両方・時刻 → 終日 | `start: { date, dateTime: null }`、`end: { date: addDays(endInclusive, 1), dateTime: null }`（P3の結果次第で `timeZone: null` も） |
| 両方・終日 → 時刻 | `start: { dateTime, date: null }`、`end: { dateTime, date: null }` |

- 片側だけの更新で `get` の値を使うのは**検証（種類・順序）のためだけ**で、その値を書き戻さない。
- `title` → `summary`、`description` / `location` → 同名Field（`null` はP1で確定した表現）。未指定のFieldはpatchに含めない。

**同時編集**: 手順4と7の間にUI等で変更されても検出しない（`If-Match` / ETagは使わない）。patchはInputで指定したFieldと端点だけを送るため、未指定のField・端点への同時変更は失われない。`get` 後に反対側の端点が変わり、patch結果が `end < start` になる場合はGoogle Calendarが400で拒否する前提（P9）で、既存の `toFoundationError` により `ProviderApiError` として返す（Q6）。

### 8.7 Error一覧

| 状況 | Error | APIを呼ぶか |
|---|---|---|
| 書き込み先が未設定（create / update） | `ConfigurationError` | 呼ばない |
| 未知の別名（create） | `InputValidationError`（設定済み別名を列挙） | 呼ばない |
| 不正なSchedule ID（update） | `InputValidationError` | 呼ばない |
| 設定外Calendarの予定（update。読み取り専用・他人のCalendar・祝日等を含む） | `InputValidationError('schedule … is on a calendar AI Foundation does not write to; writable calendars: …')` | 呼ばない |
| 予定が存在しない・削除済み（update） | `NotFoundError('schedule <id>')` | `get` のみ |
| 繰り返しの系列・回（update） | `InputValidationError('recurring events cannot be updated yet; change them in Google Calendar')` | `get` のみ |
| 特殊な種類・招待された予定（update） | `InputValidationError`（理由を明記） | `get` のみ |
| start / end の整合性（update） | `InputValidationError` | `get` のみ |
| 設定したCalendarが存在しない・書き込み不可（create / update） | `ConfigurationError`（別名を含む） | 呼んだ結果 |
| 一覧の `calendar` が読めない（list） | `InputValidationError` | `listCalendars` のみ |
| その他 | 既存の `toFoundationError`（401 / 403 → Credential、他 → ProviderApiError） | — |

---

## 9. Tool（`src/tools/schedule.ts`）

Tool description（英語）は登録時のConfigから別名一覧を埋め込む（`timeZone` と同じ方式。別名は静的設定であり動的データではない）。

```ts
const aliases = Object.keys(config.sources.schedule.writable_calendars ?? {});
const calendarsText = aliases.length
  ? `Writable calendars: ${aliases.join(', ')} (default: ${config.sources.schedule.default_calendar}).`
  : 'No writable calendar is configured.';
```

| Tool | description（要旨） | annotations |
|---|---|---|
| `schedule_create` | 設定済みの書き込み先Calendarへ作成。`calendar` は別名（省略時default）、`${calendarsText}`。期間イベント（開催期間）は日付だけの `start` / `end`（endは最終日を含む）。`description` は公式URL・メモ等の自由記述、HTMLも原文で保存。`location` は場所。参加予定は通常のCalendar、気になる開催情報は期間イベント用Calendarへ、という使い分けは利用者の設定した別名に従う。既存の時刻・終日・Default・`task_create` への誘導は維持 | 変更なし（`destructiveHint: false`） |
| `schedule_list` | 従来文 + `calendar` で1つのCalendarに絞れる（別名、または結果の `calendar` 値）。結果の `description` は原文（HTMLのことがある）。**`attended_only` / `#attended` の記述を削除** | 変更なし |
| `schedule_update`（新規） | `schedule_list` / `schedule_create` が返した `id` の単発予定を、書き込み先Calendar上でだけ更新。指定Fieldだけ変更、`description` / `location` は `null` で消去。片方の時刻だけ変えるときは種類を変えない。繰り返し予定・招待された予定・Calendar間の移動・削除は不可 | `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }`（`task_update` と同じ） |

- `inputSchema` / `outputSchema` はDomain Schemaをそのまま使う。`schedule_update` の出力は `{ schedule }`。
- `src/instructions.ts` は変更しない（Q8）。

---

## 10. `#attended` / `attended_only` の削除

| 対象 | 処置 |
|---|---|
| `src/connectors/google-calendar/attendance.ts` | 削除 |
| `tests/connectors/google-calendar/attendance.test.ts` | 削除 |
| `tests/integration/google-calendar-attendance.integration.test.ts` | 削除 |
| `ScheduleListFilterSchema.attended_only`、Connectorの `attendedOnly` filter、`schedule_list` の説明文 | 削除 |
| `tests/domain/schedule.test.ts` / `tests/connectors/google-calendar/connector.test.ts`（`describe('list with attended_only')`）/ `tests/tools/schedule.test.ts` の `attended_only` 関連 | 削除し、「`attended_only` は拒否される」Testへ置き換える（§13） |
| README「参加済みフラグ（Google Calendar）」節、Tool表、Integration Test節の `AI_FOUNDATION_IT_ATTENDANCE_*` | 削除 |
| `docs/specs/schedule-attendance.md` | 本文は履歴として残し、冒頭に「**廃止**（Issue #12で削除。後継: [schedule-calendars.md](schedule-calendars.md)）。以下はIssue #15時点の記録で、現行機能ではない」と表示する |
| `docs/plans/schedule-attendance-implementation-plan.md` | 冒頭のStatusに「機能はIssue #12で削除済み」と1行追記する（本文は変更しない） |
| README Documentation一覧のIssue #15の2件 | 「（廃止）」を付けて残す |

削除後、Repository全体（`docs/plans/`・`docs/specs/` の履歴文書と `mvp-v0.1.md` を除く）に `attended` が残っていないことを `git grep` で確認する。

---

## 11. 追加・変更予定ファイル

### 11.1 Source

| File | 区分 |
|---|---|
| `src/config/schema.ts` | 変更（§6） |
| `src/domain/schedule.ts` / `src/domain/index.ts` | 変更（§7。`ScheduleUpdateInputSchema` 等をexport） |
| `src/connectors/types.ts` | 変更（`update`） |
| `src/connectors/index.ts` | 変更（Connector Option） |
| `src/connectors/google-calendar/client.ts` | 変更（§8.1） |
| `src/connectors/google-calendar/calendars.ts` | 新規（§8.3） |
| `src/connectors/google-calendar/mapping.ts` | 変更（§8.2） |
| `src/connectors/google-calendar/connector.ts` | 変更（§8.4〜§8.6） |
| `src/connectors/google-calendar/attendance.ts` | 削除 |
| `src/tools/schedule.ts` | 変更（§9） |
| `config.yaml` | 変更（コメントの設定例） |

### 11.2 Tests

| File | 区分 |
|---|---|
| `tests/config/schema.test.ts` | 変更（§13.2） |
| `tests/domain/schedule.test.ts` | 変更（§13.3） |
| `tests/connectors/google-calendar/mapping.test.ts` | 追加（§13.4） |
| `tests/connectors/google-calendar/calendars.test.ts` | 新規（§13.4） |
| `tests/connectors/google-calendar/client.test.ts` | 追加（`get` / `patch` のParameter、`forbidden`） |
| `tests/connectors/google-calendar/connector.test.ts` | 変更（§13.5） |
| `tests/connectors/google-calendar/attendance.test.ts` | 削除 |
| `tests/helpers/fake-connectors.ts` | 変更（`FakeScheduleConnector.update`、出力に3 Field） |
| `tests/tools/schedule.test.ts` | 変更（§13.6） |
| `tests/server.test.ts` / `tests/e2e/stdio.test.ts` | 変更（Tool一覧に `schedule_update`） |
| `tests/integration/google-calendar.integration.test.ts` | 変更（§14.1） |
| `tests/integration/google-calendar-attendance.integration.test.ts` | 削除 |

### 11.3 Documentation

| File | 区分 |
|---|---|
| `README.md` | 変更（§16.1） |
| `docs/specs/schedule-calendars.md` | 新規（§16.2） |
| `docs/specs/schedule-attendance.md` / `docs/plans/schedule-attendance-implementation-plan.md` | 廃止表示（§10） |
| `docs/plans/schedule-calendars-implementation-plan.md` | 本Plan（実装後に「実装で確定した事項」を追記） |
| `docs/specs/mvp-v0.1.md` / `docs/specs/phase-2-task-schedule.md` | **変更しない**（歴史的仕様） |

---

## 12. 実装順序

User承認後、`main` から `feat/schedule-calendars` を作成して実装する。

0. **前提**: 期間イベント用Calendar「Event Catalog」は利用者が作成済み（2026-10-25）。そのIDを `config.local.yaml` へ設定することの承認を得る（§6.3。Calendar IDはRepositoryに書かない）。
1. 実装前Probe（§5）を実施し、結果を本Planに記録する。前提と違えばPlanを修正してReviewを受け直す。
2. Config Schemaと `tests/config/schema.test.ts`、`config.yaml`、`src/connectors/index.ts`。手元の `config.local.yaml` を新形式へ移行し、**§6.4の実体確認（手順1）を行う**。
3. Domain（§7）と `tests/domain/schedule.test.ts`。
4. `attended` 関連の削除（§10のSource・Test）。
5. Client・`calendars.ts`・Mapping とそのTest。
6. Connectorの `create` / `list`、続けて `update` とConnector Test。
7. Tool・Fake Connector・Tool Test・Tool一覧Test。
8. `npm run typecheck`・`npm run build`・`npm test` を全件成功させる。
9. Integration Test（§14.1）を実行し、手動Verification（§14.2）を記録する。
10. README・`docs/specs/schedule-calendars.md`・廃止表示を更新し、本Planに「実装で確定した事項」を追記する。
11. PRを作成し、CodexのImplementation Reviewを受ける。

---

## 13. Automated Test

### 13.1 方針

- 外部Serviceへ通信しない（`FakeCalendarApi` / `FakeScheduleConnector`）。
- 書き込み先の制限は「Inputに何を入れても設定外のCalendar IDへ `insert` / `patch` が届かない」ことを、`FakeCalendarApi` の記録で確認する。
- 説明欄は「未設定（Keyなし / `null` / 空文字）」「HTML」「複数行」「更新時の未指定」「明示クリア」を別々のケースにする。

### 13.2 Config（`tests/config/schema.test.ts`）

| ケース | 期待 |
|---|---|
| `default_calendar` + `writable_calendars` 2件 | 受理 |
| 両方省略 | 受理 |
| `writable_calendar_id` あり（新Keyの有無を問わず） | 拒否。Messageに `writable_calendars` と `default_calendar` |
| `writable_calendars: {}` | 拒否（C2） |
| `default_calendar` が未定義の別名 / `writable_calendars` なしで `default_calendar` のみ / `writable_calendars` のみ | 拒否（C3 / C4） |
| 別名 `Personal` / `my.cal` / `a@b` / `1st` / 33文字 / 空 | 拒否 |
| 同じIDを2つの別名へ | 拒否（C5） |
| Calendar IDが `primary` / `Primary` | 拒否（C6） |
| Calendar IDが空・空白のみ | 拒否 |

既存の `writable_calendar_id` を受理する3ケースは削除・置換する。

### 13.3 Domain（`tests/domain/schedule.test.ts`）

| 対象 | ケース |
|---|---|
| `ScheduleSchema` | 3 Fieldを含む出力を受理、`description: null` 受理、`calendar` 欠落は拒否 |
| Create | `calendar` / `description` / `location` あり・なし・`null` を受理。`description: ''` / `location: ''` 拒否。HTML・複数行の `description` を**変更せずに**保持。既存ケース（混在・逆順・Default）は維持 |
| Create正規化 | `description` / `location` が `null` で埋まる、値はそのまま |
| List | `calendar` あり・なし受理、`calendar: ''` 拒否、**`attended_only: true` / `false` は拒否**（strict） |
| Update | `id` だけは拒否、各Field単独で受理、`description: null` / `location: null` 受理（Keyが `null` として残る）、未指定はKeyなし、`title: null` / `start: null` / `end: null` / `title: ''` 拒否、`calendar` 拒否、両方指定の混在・逆順は拒否、片方だけは受理 |

### 13.4 Mapping / Calendar解決

- `toSchedule`: `description` / `location` のKeyなし・`''` → `null`、HTML・改行・前後空白を含む値は完全一致、`calendar` 引数がそのまま出力される。
- `toGoogleEvent`: `null` のときKeyを送らない、値は原文。期間イベント（`2026-11-01`〜`2026-11-03`）の `end.date` が `2026-11-04`。
- `parseScheduleId`: 正常（グループCalendar、`ja.japanese#holiday@group.v.calendar.google.com` のような `#` を含むID、`abc_20261020T010000Z`、`abc_20261020`）、異常（接頭辞違い、`google_calendar:` のみ、Calendar IDなし、Event ID空、`../x`、空白、`todoist:1`）。
- `toEventPatch`: 未指定Fieldが含まれない、`null` クリア、時刻 → 終日・終日 → 時刻の切替で反対側が `null`、終日のend +1、**`start` だけ / `end` だけの指定では反対側の端点がpatchに含まれない**（時刻・終日の両方）。
- `WritableCalendars`: `forCreate` の省略 → default、未知の別名・Calendar ID → `InputValidationError`（Messageに別名一覧、Calendar IDを含まない）、未設定 → `ConfigurationError`。`label` / `aliasOf` / `resolveForList`。

### 13.5 Connector（`tests/connectors/google-calendar/connector.test.ts`）

`setup()` を `{ writableCalendars: { personal: WRITABLE, events: EVENTS }, defaultCalendar: 'personal' }` に変え、`FakeCalendarApi` に `getEvent` / `patchEvent`（`gets` / `patches` を記録、`events` から検索、`failGet` / `failPatch`）を追加する。

**create**

| ケース | 期待 |
|---|---|
| `calendar` 省略 | `WRITABLE` へinsert、出力 `calendar: 'personal'` |
| `calendar: 'events'`・終日 `2026-11-01`〜`2026-11-03` | `EVENTS` へ `end.date: '2026-11-04'`、出力 `end: '2026-11-03'`、`calendar: 'events'` |
| `calendar: 'primary@example.com'` / `'unknown'` | `InputValidationError`、`inserts` が空 |
| `description`（複数行・HTML）/ `location` | insertするEventと出力に原文のまま |
| `description: null` | insertするEventに `description` Keyがない、出力 `null` |
| 未設定 | `ConfigurationError`（`writable_calendars`）、`inserts` 空 |
| 404 / 403(forbidden) / 403(insufficientPermissions) | `ConfigurationError`（別名を含む） / `ConfigurationError` / `CredentialError` |
| 既存の時刻・Default・offset保持・終日のケース | 期待値に3 Fieldを足すだけで維持 |

**list**

| ケース | 期待 |
|---|---|
| `calendar` 省略 | 従来どおり全Calendarを読み、マージ・ソート。`WRITABLE` の予定は `calendar: 'personal'`、`primary@example.com` の予定は `calendar: 'primary@example.com'` |
| `calendar: 'events'` | `listEvents` は `EVENTS` の1回だけ、`range` は省略時と同じ |
| `calendar: 'primary@example.com'` | そのCalendarだけ |
| `calendar: 'unknown'` / 読めないID | `InputValidationError`、`listEvents` 未呼び出し |
| 設定済みだが `listCalendars` に現れない別名 | `InputValidationError` |
| 期間重複（終日 10/30〜11/05 の期間イベントに対して） | 期間 11/01〜11/02（内側）・10/25〜10/30（最終日が開始日）・11/05〜11/10（開始日が最終日）・10/01〜12/31（全体を含む）で返る（`FakeCalendarApi` は渡された `range` に重なるものだけを返すよう拡張し、`toTimeRange` との組み合わせで検証） |
| 境界外 | 10/20〜10/29、11/06〜11/10 では返らない |
| 説明欄 | Keyなし / `''` → `null`、HTML・改行はそのまま |
| `attended_only` 相当のfilterがない | `#attended` を説明欄に持つEventも持たないEventも同じく返る（専用タグに依存しない） |
| 既存ケース | 書き込みなし、混在期間の逆順拒否、1 Calendar失敗で全体Error |

**update**

| ケース | 期待 |
|---|---|
| `title` だけ | `patches` が `[{ calendarId: WRITABLE, eventId, patch: { summary } }]`、出力は更新後 |
| `description: '新\n<b>本文</b>'` | patchに原文 |
| `description: null` / `location: null` | patchに `null`（P1の表現） |
| `description` 未指定 | patchにKeyなし |
| 時刻予定の `start` / `end` 両方（同じ種類） | 両方 `{ dateTime }`（`date` Keyなし。§8.6「両方・同じ種類」） |
| 時刻 → 終日（両方指定） | `{ date, dateTime: null }`、endは+1 |
| 終日 → 時刻（両方指定） | `{ dateTime, date: null }` |
| `start` だけ（時刻、既存end以前） | patchが `{ start: { dateTime } }` だけ（`end` Keyなし） |
| `end` だけ（時刻、既存start以後） | patchが `{ end: { dateTime } }` だけ（`start` Keyなし） |
| `start` だけ（種類が違う） / 既存endより後 | `InputValidationError`、`patches` 空 |
| `end` だけ（既存startより前） | `InputValidationError`、`patches` 空 |
| 終日予定の `end` だけ延長 | patchが `{ end: { date: 新しい最終日+1 } }` だけ |
| 終日予定の `start` だけ前倒し | patchが `{ start: { date } }` だけ |
| patch 400（競合で `end < start`） | `ProviderApiError` |
| 設定外Calendar（`primary@example.com`）のID | `InputValidationError`、`gets` / `patches` とも空 |
| 不正ID | `InputValidationError`、`gets` 空 |
| 存在しない（get 404） / `status: 'cancelled'` | `NotFoundError`、`patches` 空 |
| 系列（`recurrence` あり） / 回（`recurringEventId` あり） / 「この予定のみ」編集済みの回 | `InputValidationError`、`patches` 空 |
| `eventType: 'outOfOffice'` 等 / 招待された予定（`organizer: { email: 'x@example.com' }`） | `InputValidationError`、`patches` 空 |
| `organizer: { email: WRITABLE }` / `organizer.self: true` | 更新される |
| 未設定 | `ConfigurationError`、APIを呼ばない |
| patch 403(forbidden) / 404 | `ConfigurationError` / `NotFoundError` |

### 13.6 Tool Layer（`tests/tools/schedule.test.ts`）

| ケース | 期待 |
|---|---|
| Tool一覧 | `schedule_create` / `schedule_list` / `schedule_update` と各annotations |
| `schedule_list` のSchema | propertiesが `start` / `end` / `calendar`（`attended_only` なし）、`additionalProperties: false` |
| `schedule_list` に `attended_only: true` | `Input validation error`、Connector未呼び出し |
| `schedule_update` のSchema | `required: ['id']`、`description` / `location` がnullable、`calendar` なし |
| `schedule_update` に `{ id, description: null }` | Connectorへ `description: null` がそのまま渡る |
| `schedule_update` に `{ id }` / `{ id, end: null }` / `{ id, calendar: 'events' }` | `Input validation error`、Connector未呼び出し |
| `schedule_create` に `calendar` / `description` / `location` | そのまま渡る |
| description | `schedule_create` に設定済み別名とdefault、`schedule_list` に `attended_only` / `#attended` を含まない |
| 未設定Connector | 3 ToolともConfiguration Error |

### 13.7 回帰

- `npm test` 全件成功。`npm run typecheck` / `npm run build` 成功。
- `tests/server.test.ts` / `tests/e2e/stdio.test.ts` はTool一覧に `schedule_update` を足すだけ（Instructionsは不変）。

---

## 14. Integration Verification

### 14.1 Integration Test（`tests/integration/google-calendar.integration.test.ts`、手動起動）

実行条件: `AI_FOUNDATION_INTEGRATION=1`、`GOOGLE_OAUTH_*`、新形式の `writable_calendars` / `default_calendar`。作成したEventは `afterAll` で生のAPIから削除する（従来どおり。作成先Calendarごとに記録）。

| Test | 内容 |
|---|---|
| 既存2件 | default別名へ時刻・終日・複数日を作成して一覧（期待値に3 Fieldを追加）、hidden含む全Calendarを読む |
| 説明欄・場所 | 複数行＋HTMLの `description` と `location` 付きで作成 → 生のAPIの `events.get` と `schedule_list` の両方で原文と一致 |
| 期間イベント | 終日3日間を作成 → 生のAPIの `end.date` が最終日+1、`schedule_list` で最終日inclusive。開始前から跨ぐ期間・最終日だけの期間・全体を含む期間で返り、直前・直後の期間で返らない |
| `calendar` 絞り込み | default別名で絞ると作成した予定が返り、`calendar` が別名。2つ目の別名が設定されている場合だけ、そこへ作成して互いの絞り込みに混ざらないこと（`it.runIf`） |
| 書き込み先の分配（rev.2、§6.4 手順2） | 設定済みの各別名へ1件ずつ作成し、生のAPIで設定したCalendar IDから `events.get` でき、他の別名のCalendar IDからは404になる。各IDの `calendarList` の `accessRole` が `owner` / `writer`。`summary` はstderrへ出すだけで判定しない（個人の命名をTestに持ち込まない。照合は §6.4 手順1） |
| update | `title` だけ変更で他Fieldが保持、`description` 変更、`description: null` / `location: null` で生のAPIの値が消える、時刻予定の `start` だけ移動（生のAPIで `end` と `timeZone` が不変）、終日予定の `end` だけ延長（`start` 不変）、時刻 → 終日の切替、逆順は拒否 |
| 繰り返し | 生のAPIで `COUNT=2` の系列を作成 → 一覧の回のIDと系列のIDの両方で `schedule_update` が拒否され、生のAPIで値が変わっていない |
| 設定外Calendar | `listCalendars` から設定外の読めるCalendar（例: メインCalendar）のIDで `google_calendar:<id>:nonexistent` を作り、`schedule_update` が `InputValidationError`（APIへの書き込みなし。該当Calendarがなければskip） |

- 実データでの招待予定（他人が主催）の更新拒否は、Integration Testで予定を作れないためAutomated Test（§13.5）とProbe P8で担保する。

### 14.2 手動Verification（記録のみ）

本BranchのBuildでMCP Serverを起動し、MCP Client（Claude Code）から直接Toolを呼んで確認する（または同等のRead/Write Script）。作成した予定は確認後に削除する。

| # | 操作 | 期待 |
|---|---|---|
| M0 | §6.4 手順1（読み取り専用Script） | `personal` →「AI Foundation」、`events` →「Event Catalog」、両方 `owner` / `writer`、IDが異なる |
| M1 | 旧 `writable_calendar_id` のままServer起動 | 起動時に移行手順付きのConfigError |
| M2 | `schedule_create`（`calendar` 省略、時刻） | 通常Calendarに作成、`calendar` がdefault別名 |
| M3 | `schedule_create`（`calendar: 'events'`、終日3日間、`description` にURL） | Google Calendar UIで期間イベント用Calendarに3日間で表示、説明欄にURL |
| M4 | UIでM3の説明欄を太字にしてから `schedule_list({ …, calendar: 'events' })` | HTMLの説明欄が原文で返る |
| M5 | `schedule_update({ id, description: null })` | UIで説明欄が空になる |
| M6 | 繰り返し予定・メインCalendarの予定のIDで `schedule_update` | 拒否され、UIで変化なし |
| M7 | `schedule_list` に `attended_only: true` | `Input validation error` |
| M8 | Google Cloud ConsoleのOAuth同意画面・`.env` | 変更なし、再認可不要 |

---

## 15. LLM Client Verification（任意）

Issue #12の方針どおり**完全に任意**で、Planの必須項目・マージ条件・残件にしない。実施した場合だけ結果を記録する（例: 「来月の気になるイベントを登録して」で `calendar: 'events'` の終日予定を作るか）。

---

## 16. README / 個別仕様

### 16.1 `README.md`

- Tool表: `schedule_create`「設定した書き込み先Calendar（別名）へ予定・期間イベントを作成（説明欄・場所）」、`schedule_list`「期間に重なる予定を全Calendar、または1つのCalendarから取得」、`schedule_update`（新規）「書き込み先Calendarの単発予定を更新」。
- 「ローカル設定」: `writable_calendar_id` の例を `default_calendar` / `writable_calendars` へ。旧設定は起動時Errorになることと移行手順（§6.3）。未設定時にConfiguration Errorになる3 Tool。
- 「Google Calendar」節（Credentials）: 手順5を「通常予定用と期間イベント用（任意）のCalendarを作り、IDを `writable_calendars` に別名で設定」へ。IDは各Calendarの「カレンダーの設定 → カレンダーの統合」から写し、`primary` やメールアドレスを推測して使わない（`primary` は起動時Error）。設定後に別名が意図したCalendarを指しているか確認する（§6.4）。Scopeの文を「`writable_calendars` 以外へ書き込まない」へ。
- 「参加済みフラグ（Google Calendar）」節を削除し、「Calendarの使い分け（Google Calendar）」節を追加: 期間イベント用Calendar（気になる開催情報、参加の有無を問わない）と通常Calendar（行くと決めた日時）、Todoistは購入・予約の行動。訪問が決まっても開催情報は動かさず通常Calendarに別途登録。通常Calendarの予定は参加実績ではなく、不参加・結果は説明欄に自由記述。説明欄・場所は原文で保存・取得（HTMLを含みうる）。公式URLは説明欄へ。更新は単発予定だけ。
- Integration Test節: `AI_FOUNDATION_IT_ATTENDANCE_*` の記述を削除し、2つ目の別名がある場合の追加検証を記載。
- 「Current Phase」: Issue #15の記述を「複数Calendar・期間イベント（Issue #12）」へ置き換え。
- Documentation一覧: 本Planと `docs/specs/schedule-calendars.md` を追加、Issue #15の2件に「（廃止）」。

### 16.2 `docs/specs/schedule-calendars.md`（新規）

既存の個別仕様（`docs/specs/task-recurrence.md` 等）と同じ形式。冒頭で「[MVP v0.1仕様](mvp-v0.1.md) は当時の仕様として維持し、本書をv0.1以降に追加された仕様とする。[参加済みフラグ](schedule-attendance.md)（Issue #15）は本書で廃止した」と明記する。

| 節 | 内容 |
|---|---|
| Goal / 運用モデル | Issue #12 MVP方針更新の運用モデル |
| Configuration | §6（形式・検証規則・移行） |
| Schedule | §7.1（3 Field、`calendar` の値、`null` の意味） |
| Tool Interface | 3 ToolのInput / 出力、未指定と `null`、start / end の規則（§7.3・§8.6） |
| 書き込み制限 | §8.7 |
| 期間イベントと日付 | inclusive / exclusive変換、期間重複 |
| 廃止した機能 | `#attended` / `attended_only`（Issue #15） |
| MVP対象外 | v0.1 §MVP対象外 |

---

## 17. Acceptance Criteriaとの対応

| # | Acceptance Criteria（具体化） | 確認方法 |
|---|---|---|
| AC1 | 設定済み別名で通常／期間イベント用Calendarへ作成でき、`calendar` 省略時は `default_calendar`。旧 `writable_calendar_id` は移行手順付きの起動時Errorになり、新形式で従来どおり作成できる。各別名が意図したCalendarを指し、作成が正しいCalendarに分配される | §6.4、§13.2、§13.5 create、§14.1（書き込み先の分配）、§14.2 M0〜M3 |
| AC2 | 期間イベントを終日・最終日inclusiveで作成し、Googleのexclusive endと相互変換する（作成・一覧・更新） | §13.4、§13.5（create / update）、§14.1 期間イベント |
| AC3 | `calendar` 省略で読み取り可能な全Calendar、指定で1つのCalendarから、期間に重なるEventを取得（開始前から跨ぐ・境界日・全期間を含む）。ソート規則は不変 | §13.5 list、§14.1 |
| AC4 | `description` / `location` を作成・取得・更新でき、改行・HTMLを原文で保持。更新時の未指定（保持）と `null`（クリア）を区別 | §13.3〜§13.6、§14.1 説明欄・update、§14.2 M4 / M5 |
| AC5 | 設定外Calendar・読み取り専用Calendar・書き込み権限のない設定Calendarへの作成／更新を拒否。不正ID・存在しない予定・繰り返しの系列／回・招待予定・特殊な種類を更新しない | §8.7、§13.5、§14.1 繰り返し・設定外Calendar、§14.2 M6、§5 P6 / P8 |
| AC6 | `#attended` 判定・`attended_only` をSource・Tool Schema・現行ドキュメントから削除。`attended_only` はstrict schemaで拒否、出力は専用タグに依存しない | §10、§13.3、§13.5 list、§13.6、§14.2 M7 |
| AC7 | 既存の通常予定・時刻・終日・期間重複・一覧ソート・全Calendar読み取りの回帰Test、Fake Google Calendar API / Domain / Tool Test、実Google Calendar Integration Testが成功 | §13、§14.1 |
| AC8 | README・`docs/specs/schedule-calendars.md` を更新、Issue #15の個別仕様に廃止表示、`docs/specs/mvp-v0.1.md` に差分なし | §10、§16、`git diff main -- docs/specs/mvp-v0.1.md` が空 |

LLM Client VerificationはACに含めない（§15）。

---

## 18. 懸念点 / 未確定事項

### Q1. 旧 `writable_calendar_id` は自動移行せず起動時Errorにする

旧Keyを「別名 `default` の1件」として読み替える案もあるが、(1) 読み替え用のコードパスとTestが残り続ける、(2) 利用者は1人で `config.local.yaml` の数行の修正で済む、(3) MVP段階で後方互換は不要とされている（Issue #12）ため、移行手順をMessageに含めたErrorで止める。`strictObject` の「Unrecognized key」ではなく専用のMessageを出すため、Schemaに `z.never()` として旧Keyを残す。起動時に止まるのはSchedule以外のToolも含むが、設定の誤りに気付かないまま書き込み先が変わるより安全と判断した。

### Q2. `calendar` の形式をDomain Schemaで制限しない

`schedule_create.calendar` を別名の正規表現でSchema検証すると、Calendar IDを渡されたときに「regexに合わない」という分かりにくいErrorになる。Connectorで設定と照合し、設定済みの別名を列挙して返すほうがAI Clientが自己修正しやすい。Tool descriptionにも別名一覧を載せる。`schedule_list.calendar` は別名に加え、出力の `calendar` に出るCalendar IDも受け付ける（読み取りのみのため制限しない）。

### Q3. 更新で `null` を許すのは `description` / `location` だけ

`end: null` を「Default（1時間 / 1日）に戻す」と解釈する案もあるが、`schedule_create` と意味が揃わず、「保持」との違いがLLMに伝わりにくい。Google Calendarの予定は常に終了を持つため、更新では `end` を省略（保持）か値の指定だけにする。`title` も空にできないため `null` を拒否する。

### Q4. `events.update` ではなく `events.patch`

`update` は全Fieldの置き換えで、取得したEventを書き戻す実装になり、AI Foundationが扱わないField（参加者・通知・会議・添付・色）を取得〜書き込みの間の変更ごと上書きする危険がある。`patch` は指定Fieldだけを送れるため、未指定Fieldの保持がAPIの仕様として保証される。取得（`get`）は繰り返し・招待・種類の判定と片方だけのstart / endの検証のために行う。

### Q5. start / end の片方だけの更新

片方だけ変えた場合は、もう片方を保持したうえで順序と種類を検証し、違反したら両方の指定を求める。patchには指定した端点だけを送り、保持する側は送らない（rev.2）。「長さを保って移動する」解釈は採らない（未指定Fieldは保持、という詳細設計の原則に合わせる）。そのため時刻予定の開始だけを後ろへずらすと、終了より後になる場合はErrorになる。Tool descriptionで「移動するときは `start` と `end` を両方渡す」と案内する。

### Q6. 同時編集の検出をしない

`get` と `patch` の間にUIで同じEventが変更された場合、`patch` で送ったFieldと端点だけが上書きされる（未指定のFieldと、片側更新での反対側の端点は保たれる）。反対側の変更で順序が逆転する場合はGoogle Calendarの400に任せる（P9）。両端点を送るのは利用者が両方を指定したときだけで、そのときは指定値で上書きするのが意図どおり。個人利用・単発予定のMVPではETagによる競合検出は過剰と判断した。

### Q7. 招待された予定と特殊な種類の予定を事前に拒否する

書き込み先Calendarに他人が主催する予定が入っている場合、主催者以外の変更はAPIで拒否されるか自分のコピーだけが変わり、主催者側の予定と食い違う。`eventType` が `default` 以外の予定（不在・作業場所・誕生日・Gmailから作成）は更新できるFieldが制限される。いずれもAPIの結果に任せず `get` の時点で理由を明示して拒否する。判定に使うFieldの値はProbe P8で確認する。

### Q8. Instructions（`src/instructions.ts`）は変更しない

Entity定義（Schedule = Google Calendar）は変わらず、Calendarの使い分けは利用者が設定する別名とTool descriptionで伝わると考える。LLM Client Verificationは任意のため、問題が見つかった場合のみ別途提案する。

### Q9. 出力の `calendar` に設定外CalendarのIDを出す

`Schedule.calendar` は「設定済み別名、または他の読み取り可能Calendarの識別子」（v0.1）。識別子にはGoogle CalendarのIDを使う（既存の `id` にも同じ値が含まれており、新たに露出する情報はない）。Calendarの表示名（`summary`）は一意でなく変更されうるため使わない。

---

## 19. Review対応履歴

### rev.2（PR #27 Plan Review rev.1反映）

ChatGPTのPlan Review rev.1は「修正推奨（P2 1件、P3 1件）」。

| 指摘 | 対応 |
|---|---|
| [P2] §8.6 / §13.5 — 片方だけの日時更新でも、事前に `get` した値で両端点をpatchしており、「未指定Fieldは保持」「指定Fieldだけ変更」と矛盾する。`get`→`patch` 間にUIで反対側が変わると古い値を書き戻す | 種類を変えない片側更新では指定した端点だけを送るよう §8.6を変更（両端点は両方指定時だけ。種類の切替は従来どおり両方指定が必須）。`get` の値は検証にだけ使う。競合で `end < start` になる場合はGoogle Calendarの400 → `ProviderApiError`。§4に前提、§5にProbe P9（片側patchで反対側と `timeZone` が不変か、逆転時の400）を追加し、P9が前提と違う場合は両端点送信へ戻して上書きの可能性を明記する方針とした。§13.4 / §13.5のTest期待値（反対側がpatchに含まれない）、§14.1、Q5 / Q6を更新 |
| [P3] §6 / §12 / §14 — 設定値は非空文字列なら有効なため、`primary` や誤ったCalendar IDも許可リストに入る。意図したCalendarに結び付いていることの確認手順が必要 | §6.4を新設: `personal` →「AI Foundation」、`events` →「Event Catalog」を、読み取り専用Scriptで `summary` / `accessRole` を取得して確認（手順1）、Integration Testで各別名へ作成して設定したCalendar ID側にだけ存在することを確認（手順2）。記録は別名と `summary` / `accessRole` だけでCalendar IDは書かない。§12 手順2、§14.1（書き込み先の分配）、§14.2 M0、AC1に反映。READMEに「IDは設定画面から写す・`primary` を使わない・設定後に確認する」注意書きを追加（§16.1）。加えて、`primary` はAPIが動的に解決する識別子のため、Config検証C6で拒否する（ID形式の厳密な検証はしない） |

### rev.2 承認（PR #27 Plan Review rev.2）

ChatGPTのPlan Review rev.2で承認（P2 / P3 解消）。軽微な整合確認として、§13.5「時刻予定の `start` / `end` 両方」の期待値を §8.6「両方・同じ種類」の定義（`{ dateTime }`、`date` Keyなし）に揃えた。

---

## 20. 実装で確定した事項

Branch `feat/schedule-calendars`（Base: `main` の `766115a`、PR #27 Merge）。

### 20.1 実装前Probe（2026-10-25、実Google Calendar）

ScratchpadのScript（Repositoryにcommitしない）で、AI Foundation Calendarに `[af-probe …]` 付きの一時Eventを10件作成して確認し、すべて削除した（残存0件を確認）。既存の予定は読み取りのみ。**結果はすべてPlanの前提どおりで、Planの修正は不要だった。**

| # | 結果 | Planへの反映 |
|---|---|---|
| P1 | `patch({ description: null, location: null })` で両Fieldが消える（`get` でKeyなし）。空文字のpatchも同じく消える | `null` を送る（§8.6のまま） |
| P2 | 系列は `recurrence` を持ち `recurringEventId` なし。展開された回は `<base>_20261204T000000Z`（終日は `<base>_20261203`）で `recurringEventId` と `originalStartTime` を持つ。「この予定のみ」編集した回も同じ。削除した単発Eventの `get` は404ではなく `status: 'cancelled'` | §8.6の判定のまま（`originalStartTime` の追加判定は不要）。`cancelled` は `NotFoundError` |
| P3 | `timeZone` 付きの時刻予定を `{ date, dateTime: null }` で終日へ切り替えられる（`timeZone` は自動で外れる）。逆の切替も可（`timeZone` はCalendarの既定値が入る） | `timeZone: null` は送らない |
| P4 | `start` / `end` の `dateTime` だけをpatchしても `timeZone: 'Asia/Tokyo'` は保持される | §8.6のまま |
| P5 | 改行・`\r\n`・HTML・Entity・前後の空白を含む説明欄、場所が作成・patchとも完全一致で返る | 変換しない（Testの期待値は原文） |
| P6 | 読み取り専用Calendar（祝日）への `insert` は `403 requiredAccessLevel`（"You need to have writer access to this calendar."） | `forbidden` の判定reasonに含める |
| P7 | 前後1年の全Calendarの100件すべてのEvent IDが `^[A-Za-z0-9_]+$` に一致 | 正規表現のまま |
| P8 | 作成したEventは `organizer.self: true`、`organizer.email` がCalendar ID。書き込み先Calendarの既存予定12件も同様で、招待された予定は0件。全Calendarの `eventType` は `default` 84件・`birthday` 16件 | §8.6のまま。招待予定の拒否はAutomated Testで担保 |
| P9 | 時刻予定（`timeZone` の有無とも）・終日予定とも、`start` だけ / `end` だけのpatchで反対側と `timeZone` が完全に不変。逆転する片側patchは `400 timeRangeEmpty` | §8.6の片側patchを採用。400は `ProviderApiError` |

### 20.2 書き込み先Calendarの実体確認（§6.4、2026-10-25）

| 別名 | `summary` | `accessRole` |
|---|---|---|
| `personal`（default） | AI Foundation | owner |
| `events` | Event Catalog | owner |

2つのIDは異なる。Integration Test（§14.1「書き込み先の分配」）で、各別名へ作成した予定が設定したCalendarにだけ存在すること（他方の `events.get` が404）も確認した。Calendar IDは記録しない。手元の `config.local.yaml` は利用者の承認のもとで新形式へ移行済み。

### 20.3 Verification結果（2026-10-25）

| 項目 | 結果 |
|---|---|
| `npm run typecheck` / `npm run build` | 成功 |
| `npm test` | 54 files / 1497 passed / 5 skipped（skipは既存のもの） |
| Integration Test（`tests/integration/google-calendar.integration.test.ts`、実Google Calendar） | 10 passed。終了後、両Calendarに `[af-it` / `[af-probe` の予定が残っていないことを確認 |
| `git diff main -- docs/specs/mvp-v0.1.md` | 差分なし |

### 20.4 手動Verification（§14.2）

| # | 結果 |
|---|---|
| M0 | §20.2 |
| M1 | 旧 `writable_calendar_id` を含むConfigの読み込みが `sources.schedule.writable_calendar_id: was replaced by writable_calendars and default_calendar; e.g. …` で失敗することを確認 |
| M2 / M3 / M5 / M6 | MCP Serverは経由せず、Integration Test（実Google Calendar、本BranchのConnector）で同じ操作を確認: 既定Calendarへの作成と `calendar` の別名、`events` への3日間の終日予定（Google側のendが+1日）、`description: null` で生のAPIから値が消えること、繰り返しの系列・回と設定外Calendarの予定の更新拒否 |
| M4 | 未実施（Google Calendar UIで説明欄に書式を付ける操作が必要）。HTMLの原文保持はProbe P5とIntegration Testで確認済み |
| M7 | `attended_only` の拒否をDomain / Tool Test（MCP経由の `Input validation error`）で確認 |
| M8 | OAuth同意画面・`.env` は変更なし。既存のRefresh TokenでProbe・Integration Testを実行でき、再認可は不要だった |

### 20.5 Planからの細部の変更・Plan外の変更（Implementation Reviewで確認してほしい点）

- `toFoundationError` の `notFound` を404に加えて410でも使うようにした（§8.7の「404/410 は NotFoundError」を実装するため。既存の呼び出し元は `create` だけで、挙動への影響はない）。
- `tests/helpers/mcp.ts` の `connectClient` に任意の `config` 引数を追加した（別名一覧がTool descriptionに出ることのTestのため）。
- `FakeCalendarApi.listEvents` が `range` に重なるEventだけを返すようにした（§13.5「期間重複」をConnectorと `toTimeRange` の組み合わせで確認するため。開始のないEventはそのまま返す）。
- `schedule_list` のTool descriptionにも書き込み先の別名一覧を載せた（`calendar` に渡せる値を示すため）。
