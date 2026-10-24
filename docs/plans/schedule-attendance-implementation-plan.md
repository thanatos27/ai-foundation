# Google Calendar参加済みフラグ — Implementation Plan

- Status: **rev.2（Plan Review完了・承認済み。実装済み: §18）**
- 作成: Coding Agent (Claude Code) / 2026-10-24（rev.2: 2026-10-24 PR #23 レビュー反映・実装）
- 対象: [Issue #15 Google Calendar参加済みフラグ](https://github.com/thanatos27/ai-foundation/issues/15)（コメント「MVP詳細設計 v0.1」を正とする）
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md)（**変更しない**）, [Phase 2 Design Issue](../specs/phase-2-task-schedule.md), [Phase 2 Implementation Plan](phase-2-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

詳細設計v0.1で「Implementation Planで明文化する」とされた判定規則（HTMLタグ内の文字列の扱いなど）は [§5](#5-フラグ判定srcconnectorsgoogle-calendarattendancets) で決め、設計に明記がなく本Planで決めた箇所は [§16 懸念点 / 未確定事項](#16-懸念点--未確定事項) にQとしてまとめる。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/schedule-attendance-implementation-plan`。Baseは `main` の `1814099`（PR #22 Merge、Life Log MVP Merge済み） |
| 依存 | `@googleapis/calendar ^20.1.0`、`zod 4.6`、Node `>=24`。**追加依存なし** |
| 公開Tool | 20件。**本Issueで増減しない** |
| OAuth Scope | `calendar.calendarlist.readonly` / `calendar.events`（`src/connectors/google-calendar/client.ts` の `GOOGLE_CALENDAR_SCOPES`）。**変更しない** |
| CI | なし（`npm test` をローカルのWindows環境で実行） |

### 既存実装の要点（本Issueで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/domain/schedule.ts` | `ScheduleListFilterSchema = z.strictObject({ start, end }).refine(…)`。日付同士・日時同士のときだけ `end >= start` を検証し、混在時の順序はConnector（`toTimeRange`）が検証する |
| `src/connectors/google-calendar/client.ts` | `CalendarApi.listEvents(calendarId, range)` は `events.list` を `singleEvents: true` / `orderBy: 'startTime'` / `showDeleted: false` / `maxResults: 2500` でページングし、**`GoogleEvent`（`calendar_v3.Schema$Event`）全体**を返す。`description` も含まれるため追加API・追加Fieldの指定は不要（`fields` 指定なし） |
| `src/connectors/google-calendar/connector.ts` | `list(filter)`: `toTimeRange` → `listCalendars` → 全Calendarを `Promise.all` で `listEvents`（1つでも失敗すれば `toFoundationError(…, { context: 'calendar "<name>"' })` で全体Error）→ `status !== 'cancelled'` を除外 → `toSchedule`（startなしは `undefined` で除外）→ `startInstant` + `title` でソート |
| `src/connectors/google-calendar/mapping.ts` | `toSchedule(event, calendarId)`: `description` は出力に含めない。終日予定はexclusive endをinclusiveへ変換。**変更しない** |
| `src/tools/schedule.ts` | `schedule_list` は `inputSchema: ScheduleListFilterSchema` をそのまま公開し、検証済みInputをそのまま `connector().list(filter)` へ渡す。出力は `{ schedules: Schedule[] }` |
| `tests/helpers/fake-connectors.ts` | `FakeScheduleConnector.list` は受け取った `filter` を `calls` に記録し、`schedules` をそのまま返す |
| `tests/connectors/google-calendar/connector.test.ts` | `FakeCalendarApi`（Calendar別の `events` を保持、`failEvents` で特定Calendarを失敗させられる） |
| `tests/integration/google-calendar.integration.test.ts` | `AI_FOUNDATION_INTEGRATION=1` とGoogle Credentialがある場合のみ実行。作成したEventは `afterAll` で削除 |

---

## 2. 設計方針

1. **既存 `schedule_list` のOptional Filterとして追加する。** 新しいTool・Domain Field・DB・Credential・OAuth Scope・Configは追加しない（v0.1 §Scope / §設計判断）。
2. **省略・`false` は完全に従来挙動。** 呼び出すAPI、取得範囲、除外条件、変換、ソート、Error、出力形のいずれも変えない。既存のSchedule系Testを**無変更で**通すことを後方互換の完了条件にする（Tool Testの `inputSchema.properties` を確認する箇所は追加プロパティ分だけ更新する。§11.4）。
3. **`true` のときだけ、変換前の `GoogleEvent` の `description` で絞り込む。** 判定は副作用のない小関数 `hasAttendedFlag` に分離し、Connectorは「既存の除外の後・`toSchedule` の前」に1つfilterを挟むだけにする。
4. **判定は `description` の独立トークン `#attended` のみ。** RSVP（`attendees[].responseStatus`）・`status`（cancelled以外）・`transparency`・`eventType`・Calendarの種類は判定に使わない。
5. **AI FoundationはフラグをGoogle Calendarへ書き込まない。** フラグの記入はユーザーがGoogle Calendar UIで手動で行う。Connectorに新しい書き込みコードパスを作らない。
6. **フラグなし = 未確認。** 「不参加」とは扱わず、Tool説明にもそう書く。返却値に `attended` は追加しない。
7. **Provider固有の判定はConnectorに閉じる。** Domain / Toolは `attended_only` が「参加済みフラグの付いた予定だけ」を意味することだけを知り、`description` やHTMLの扱いはGoogle Calendar Connectorの責務とする（AGENTS.md Layer責務）。

---

## 3. 既存実装への変更点（概要）

| 対象 | 変更 | 理由 |
|---|---|---|
| `src/domain/schedule.ts` | `ScheduleListFilterSchema` に `attended_only: z.boolean().optional()` を追加。既存の `refine` は維持 | v0.1 §設計 / 実装ポイント |
| `src/connectors/google-calendar/attendance.ts`（新規） | `hasAttendedFlag(description)`（純粋関数） | 判定の分離 |
| `src/connectors/google-calendar/connector.ts` | `list` で `filter.attended_only === true` のときだけ `hasAttendedFlag(event.description)` でfilter | 抽出 |
| `src/tools/schedule.ts` | `schedule_list` のdescriptionに `attended_only` の意味・未確認の扱い・RSVP非依存・例を追記 | v0.1 §設計 / 実装ポイント |
| `README.md` | Tool表の `schedule_list`、「参加済みフラグ（`#attended`）」節、Documentation一覧 | Issue AC 8 |
| `docs/specs/schedule-attendance.md`（新規） | Issue #15のv0.1と本Planで確定した判定規則・運用を個別仕様として記録 | Issue AC 8 |

**変更しないもの**: `docs/specs/mvp-v0.1.md`（固定済み。次期全体仕様書で統合する）、`src/connectors/google-calendar/client.ts`（`GOOGLE_CALENDAR_SCOPES`・`events.list` のParameter含む）、`src/connectors/google-calendar/mapping.ts`、`ScheduleSchema` / `ScheduleCreateInputSchema`、`schedule_create`、`src/connectors/types.ts`（`ScheduleConnector.list(filter: ScheduleListFilter)` の型は `ScheduleListFilter` の推論で自動的に追従する）、`src/instructions.ts`（Q4）、`src/config/**`・`config.yaml`、`src/credentials/**`、`.env.example`、他Entityの実装、`tests/server.test.ts` / `tests/e2e/stdio.test.ts`（Tool名・件数・Instructionsは不変）。

---

## 4. Domain（`src/domain/schedule.ts`）

```ts
/**
 * Input of `schedule_list`: events overlapping [start, end]. A date `end` includes that whole day.
 * Dates are resolved in the configured time zone by the connector, which also checks the order
 * when dates and date-times are mixed.
 * `attended_only: true` keeps only events the user marked as attended in the source
 * (Google Calendar: `#attended` in the description). Omitted or false: every event.
 */
export const ScheduleListFilterSchema = z
  .strictObject({
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema,
    attended_only: z.boolean().optional(),
  })
  .refine((value) => !sameDateKind(value) || endNotBeforeStart(value), END_BEFORE_START);
```

- `strictObject` を維持するため、未知のKey（`attended`、`attendedOnly` 等）は従来どおり拒否される。
- `null`・文字列（`"true"`）・数値は拒否する（Zodの `boolean()` は型変換しない）。
- **Default値は付けない**（`.default(false)` にしない）。省略時に `attended_only` Keyが付加されないため、Connectorへ渡るObjectも従来と同一になる（既存Tool Test `connector.calls` の完全一致を無変更で通す）。
- `ScheduleListFilter` 型は `{ start; end; attended_only?: boolean }` になる。

---

## 5. フラグ判定（`src/connectors/google-calendar/attendance.ts`）

### 5.1 規則

| # | 規則 |
|---|---|
| R1 | 対象は `GoogleEvent.description` のみ。`summary`・`location`・`attachments`・`extendedProperties` 等は見ない |
| R2 | `description` が `undefined` / `null` / 空文字 → `false`（未確認） |
| R3 | 大文字小文字を区別した文字列 `#attended` が**独立トークン**として現れれば `true`。出現位置・回数は問わない |
| R4 | 直前の文字が次のいずれかなら独立していない: 文字（`\p{L}`）、数字（`\p{N}`）、結合文字（`\p{M}`）、`_`、`-`、`#`、`&`、`/`、`\` |
| R5 | 直後の文字が次のいずれかなら独立していない: 文字、数字、結合文字、`_`、`-`、`#`、`/`、`\` |
| R6 | それ以外の前後（文字列の先頭・末尾、空白・改行・NBSP、`.` `,` `:` `;` `!` `?` `(` `)` `「」` `、` `。` `*` 等の句読点・記号、HTMLタグ境界）は許容する |
| R7 | 判定前に**HTMLタグとHTMLコメントを空白1文字へ置換する**（可視文字抽出・Entityのdecodeは行わない）。タグの属性値（例: `href="…#attended"`）とコメント内の文字列は判定対象から外れ、タグの前後はトークン境界になる |
| R8 | Unicode正規化・全角半角変換・HTML Entityのdecodeは行わない（`＃attended`、`&#35;attended` は検出しない） |

### 5.2 実装

```ts
/** HTML comments and tags as Google Calendar stores them in a description (`<b>`, `<br>`, `<a href>`…). */
const HTML_MARKUP = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
/** `#attended` as a standalone, case-sensitive token (spec: docs/specs/schedule-attendance.md). */
const ATTENDED_FLAG = /(?<![\p{L}\p{N}\p{M}_\-#&/\\])#attended(?![\p{L}\p{N}\p{M}_\-#/\\])/u;

/**
 * Whether the user marked the event as attended: a standalone `#attended` in its description.
 * Markup is replaced by a space first, so attribute values and comments never count and
 * a tag boundary separates tokens. Not a visible-text extraction: entities stay as written.
 */
export function hasAttendedFlag(description: string | null | undefined): boolean {
  if (!description) return false;
  return ATTENDED_FLAG.test(description.replace(HTML_MARKUP, ' '));
}
```

- `ATTENDED_FLAG` はglobal flagなしのため `test` が `lastIndex` を持ち越さない。
- `HTML_MARKUP` のタグは `<` の直後が英字または `/英字` のものに限る。`a < b`・`<3` のような本文中の `<` はタグと見なさない。
- 正規表現はどちらもネストした量指定子を持たず、`description` の長さに対して線形。
- 本Planの作成時に、§5.3の判定表の全ケース（検出する23件・検出しない28件・挙動の固定3件）がこの2つの正規表現で期待どおりになることをNode.js 24で確認済み。
- 未終端のコメント（`<!-- #attended`）はコメントと見なさず、本文として判定する（Google Calendar UIでは生成されない入力。Testで挙動を固定する）。

### 5.3 判定表（`tests/connectors/google-calendar/attendance.test.ts` でそのまま固定する）

**検出する（`true`）**

| 入力 | 理由 |
|---|---|
| `#attended` | 単独 |
| `#attended\n` / `\n#attended` / `  #attended  ` | 前後の改行・空白 |
| `参加しました #attended` | 文章末尾（空白区切り） |
| `#attended 楽しかった` / `メモ\n#attended\n詳細` | 行頭・単独行 |
| `参加。#attended` / `#attended。` / `(#attended)` / `「#attended」` / `#attended!` / `**#attended**` | 句読点・記号 |
| `メモ #attended` | NBSP |
| `<b>#attended</b>` / `<p>#attended</p>` / `メモ<br>#attended` / `参加<br/>#attended<br>` | HTMLタグ境界（Google Calendar UIの太字・改行） |
| `参加<b>#attended</b>` | タグ境界は文字の直後でも境界になる（R7） |
| `<a href="https://example.com">#attended</a>` | リンクのテキストは対象 |
| `&nbsp;#attended` / `#attended&nbsp;` | Entityは未decodeのまま、`;` / `&` が境界になる |
| `#attended #attended2` | 独立した `#attended` が1つあれば検出 |

**検出しない（`false`）**

| 入力 | 理由 |
|---|---|
| `undefined` / `null` / `''` / `'   '` | R2（空白のみはトークンなし） |
| `参加しました` | タグなし |
| `#attended2` / `#attended-other` / `#attended_x` / `#attendedです` / `#attended２`（全角数字） | 後続文字（R5） |
| `#Attended` / `#ATTENDED` / `#attendeD` | 大文字小文字を区別（R3） |
| `＃attended` / `#ａｔｔｅｎｄｅｄ` / `&#35;attended` | 正規化・decodeしない（R8） |
| `attended` / `# attended` | `#` と直結していない |
| `##attended` / `x#attended` / `参加#attended` / `foo-#attended` / `a_#attended` | 直前文字（R4。Q2） |
| `https://example.com/#attended` / `https://example.com/page#attended` | URLのfragment（`/` または文字が直前） |
| `<a href="https://example.com/#attended">資料</a>` | 属性値はタグごと除去（R7） |
| `<span title="#attended">x</span>` | 同上 |
| `<!-- #attended -->` | コメントは除去（R7） |

**挙動を固定するだけのケース（仕様書の「既知の制約」に記載）**

| 入力 | 結果 | 理由 |
|---|---|---|
| `<!-- #attended` | `true` | 未終端コメントはコメントと見なさない |
| `x<y #attended>z` | `false` | `<y …>` をタグと見なす（本文に `<英字` を書いた場合の制約） |
| `a < b #attended` | `true` | `<` の直後が空白なのでタグではない |

---

## 6. Connector（`src/connectors/google-calendar/connector.ts`）

```ts
async list(filter: ScheduleListFilter): Promise<Schedule[]> {
  // …toTimeRange / listCalendars は変更なし…
  const attendedOnly = filter.attended_only === true;
  const perCalendar = await Promise.all(
    calendars
      .filter(/* 変更なし */)
      .map(async (entry) => {
        const events = await api.listEvents(entry.id, range).catch(/* 変更なし */);
        return events
          .filter((event) => event.status !== 'cancelled')
          // attended_only: only events the user tagged #attended by hand; untagged ones are unconfirmed.
          .filter((event) => !attendedOnly || hasAttendedFlag(event.description))
          .map((event) => toSchedule(event, entry.id))
          .filter((schedule): schedule is Schedule => schedule !== undefined);
      }),
  );
  // …ソートは変更なし…
}
```

| 観点 | 挙動 |
|---|---|
| `toTimeRange` | `filter` から `start` / `end` だけを読む（`attended_only` は時間範囲に影響しない）。変更なし |
| 取得するCalendar | `attended_only` に関係なく、従来どおり読み取り可能な全Calendar（hidden含む、freeBusyReader除外） |
| `events.list` のParameter | 変更なし（`singleEvents: true` / `showDeleted: false` 等）。`attended_only` をAPIのQuery（`q`）に変換しない（Q3） |
| キャンセル | 既存の `status !== 'cancelled'` の後に判定するため、フラグがあってもcancelledは返らない |
| 繰り返し予定 | `singleEvents: true` により各インスタンスが個別の `GoogleEvent` として返り、各インスタンスの `description` で判定する。「この予定のみ」を編集したインスタンスは自身の説明欄、未編集のインスタンスは系列の説明欄を持つ（Google Calendar APIの仕様） |
| 終日予定 | 判定は `description` のみで、`start.date` / `end.date` の変換は `toSchedule` のまま |
| startなし | 既存どおり `toSchedule` が `undefined` を返し除外 |
| API失敗 | 判定より前の `listEvents` で失敗するため、従来どおり全体Error（部分結果を返さない） |
| ソート | 変更なし（filter後に同じ比較関数でソート） |
| 書き込み | `list` は `insertEvent` を呼ばない（既存Test「never writes while listing」を `attended_only: true` でも確認） |

---

## 7. Tool（`src/tools/schedule.ts`）

`inputSchema` / `outputSchema` / `annotations`（`readOnlyHint: true`）は変更しない（Schemaは §4 の追加分が自動で公開される）。descriptionを次のように拡張する（英語、既存文に追記）。

```ts
description:
  `List events overlapping a period across every Google Calendar the user can read. ` +
  `start / end are "YYYY-MM-DD" (whole days, end inclusive, in ${timeZone}) or ISO 8601 date-times with an offset. ` +
  `All-day events are returned with "YYYY-MM-DD" start / end, end inclusive. ` +
  `Set attended_only to true to return only events the user marked as attended by writing the standalone, ` +
  `case-sensitive tag #attended in the event description in Google Calendar; ` +
  `an event without the tag is unconfirmed, not "not attended". RSVP responses are not used. ` +
  `For an attendance history, pass the period yourself, e.g. ` +
  `{"start":"2026-09-01","end":"2026-09-30","attended_only":true} for events attended in September.`,
```

- 過去期間であることの強制（`end <= today` の検証）は行わない（v0.1）。
- Toolはフラグを書き込まないため、「参加済みにして」という依頼に対してはGoogle Calendar UIでの記入を案内するのがAI Client側の振る舞いになる（Tool説明の「the user marked … by writing」で表現する。Instructionsは変更しない。Q4）。

---

## 8. Error / Configuration / OAuth

- 新しいErrorクラス・Messageは追加しない。`attended_only` の型不正はMCP SDKの `Input validation error` で、Connectorは呼ばれない（既存の `it.each` に追加）。
- Config・Credential・`npm run auth:google` の手順は変更しない。説明欄は現在のScope（`calendar.events`）で既に取得できており、追加の同意は不要。
- READMEの「要求するScope」の記載も変更しない（参加済みフラグの節に「追加Scope不要」と書く）。

---

## 9. 追加・変更予定ファイル

### 9.1 Source

| File | 区分 |
|---|---|
| `src/domain/schedule.ts` | 変更（§4） |
| `src/connectors/google-calendar/attendance.ts` | 新規（§5） |
| `src/connectors/google-calendar/connector.ts` | 変更（§6） |
| `src/tools/schedule.ts` | 変更（§7） |

### 9.2 Tests

| File | 区分 |
|---|---|
| `tests/domain/schedule.test.ts` | 追加（§11.2） |
| `tests/connectors/google-calendar/attendance.test.ts` | 新規（§11.3） |
| `tests/connectors/google-calendar/connector.test.ts` | 追加（§11.4）。既存ケースは無変更 |
| `tests/tools/schedule.test.ts` | 追加・1箇所更新（§11.5） |
| `tests/integration/google-calendar-attendance.integration.test.ts` | 新規（§12.1、手動起動・Read-only） |

### 9.3 Documentation

| File | 区分 |
|---|---|
| `README.md` | 変更（§14.1） |
| `docs/specs/schedule-attendance.md` | 新規（§14.2） |
| `docs/plans/schedule-attendance-implementation-plan.md` | 本Plan（実装後に「実装で確定した事項」を追記） |
| `docs/specs/mvp-v0.1.md` | **変更しない** |

---

## 10. 実装順序

User承認後、`main` から `feat/schedule-attendance` を作成して実装する。

1. `attendance.ts` と `attendance.test.ts`（§5.3の判定表）を作成し、純粋関数のTestを成功させる。
2. `ScheduleListFilterSchema` に `attended_only` を追加し、Domain Testを追加する。
3. Connectorにfilterを追加し、Connector Testを追加する。**既存のConnector Testを無変更で成功させる**ことを確認する。
4. Tool descriptionを更新し、Tool Testを追加する。
5. `npm run typecheck`・`npm run build`・`npm test` を全件成功させる。
6. Integration Test（§12.1）を作成し、手動Fixture（§12.2）を用意して `npm run test:integration` で実行する。
7. README・`docs/specs/schedule-attendance.md` を更新し、本Planに「実装で確定した事項」を追記する。
8. PRを作成し、CodexのImplementation Reviewを受ける。Review後に手動Verification・LLM Client Verification（§13）を実施して記録する。

---

## 11. Automated Test

### 11.1 方針

- 外部Serviceへ通信しない（既存の `FakeCalendarApi` / `FakeScheduleConnector` を使う）。
- 判定規則は純粋関数のTestで網羅し、Connector Testは「どこで・どの順に絞り込むか」を確認する。
- 後方互換は「既存Testを無変更で成功させる」ことと、「`attended_only` 省略 / `false` / `true` で同じFixtureを比較する」ことの2つで確認する。

### 11.2 Domain（`tests/domain/schedule.test.ts`）

| ケース | 期待 |
|---|---|
| `{ start, end, attended_only: true }` / `false` | 受理し、値をそのまま保持 |
| `attended_only` 省略 | 受理し、parse結果に `attended_only` Keyが**存在しない** |
| `attended_only: null` / `"true"` / `1` | 拒否 |
| `attended: true` / `attendedOnly: true`（未知Key） | 拒否（strict） |
| `attended_only: true` かつ `end < start`（日付同士） | 従来どおり `end` にIssueを付けて拒否 |

### 11.3 判定関数（`tests/connectors/google-calendar/attendance.test.ts`）

- §5.3の3つの表を `it.each` でそのまま固定する（検出する / 検出しない / 挙動の固定）。
- 同じ関数を連続で呼んでも結果が変わらない（`lastIndex` を持ち越さない）ことを1ケース確認する。

### 11.4 Connector（`tests/connectors/google-calendar/connector.test.ts`）

既存の `describe('list')` の後に `describe('list with attended_only')` を追加する。Fixture: 2つのCalendar（`WRITABLE` / `primary@example.com`）に次のEventを置く。

| Event | Calendar | 内容 |
|---|---|---|
| A | WRITABLE | 時刻予定、`description: '#attended'` |
| B | primary | 終日予定（`date` 2日間）、`description: '<b>#attended</b>'` |
| C | primary | 時刻予定、`description: '#attended2'` |
| D | WRITABLE | 時刻予定、`description` なし |
| E | primary | `attendees: [{ self: true, responseStatus: 'accepted' }]`、タグなし |
| F | WRITABLE | `attendees: [{ self: true, responseStatus: 'declined' }]`、`description: '#attended'` |
| G | WRITABLE | `status: 'cancelled'`、`description: '#attended'` |
| H | primary | `description: '#attended'`、`start` なし |
| R1 / R2 / R3 | WRITABLE | 同じ `recurringEventId` を持つ3インスタンス。R2だけ `description: '#attended'`、R1 / R3 はタグなし |
| S1 / S2 | primary | 同じ `recurringEventId`。両方 `description: '系列メモ #attended'`（系列の説明欄に付けた場合） |
| T | primary | `description: '<a href="https://example.com/#attended">資料</a>'` |

| ケース | 期待 |
|---|---|
| `attended_only: true` | A, B, F, R2, S1, S2 だけが返り、**順序は既存のソート規則どおり**（終日Bは日の始まり、同時刻はtitle順） |
| 同上の出力形 | 各要素が `attended_only` なしで取得した同じEventの要素と `toEqual`（Field追加なし、終日Bの `end` はinclusive） |
| 複数Calendar | 両Calendarに `listEvents` が同じ `range` で呼ばれ、両方から抽出される |
| RSVPと独立 | Eは除外、Fは返る |
| キャンセル | Gは `attended_only: true` でも返らない |
| 繰り返し | R2だけ返る（R1 / R3は返らない）。S1 / S2は両方返る |
| startなし | Hは返らない |
| 属性値 | Tは返らない |
| `attended_only` 省略 / `false` | A〜F, R1〜R3, S1, S2, T（G・H以外）が返り、**省略時と `false` の結果が `toEqual`**。`listEvents` の呼び出し（Calendar・range）も3通りで同一 |
| 書き込みなし | `attended_only: true` で `api.inserts` が空 |
| 一部Calendar失敗 | `failEvents[primary]` を設定し `attended_only: true` → 既存と同じ `ProviderApiError`（Calendar名を含む）で全体が失敗し、WRITABLE分を部分的に返さない |
| 一致0件 | タグ付きEventがない期間で `attended_only: true` → `[]`（Errorにしない） |

### 11.5 Tool Layer（`tests/tools/schedule.test.ts`、`FakeScheduleConnector`）

| ケース | 期待 |
|---|---|
| `schedule_list` のSchema | `Object.keys(inputSchema.properties)` が `['start', 'end', 'attended_only']`、`required` は `['start', 'end']` のまま、`attended_only` は `type: 'boolean'`、`additionalProperties: false`、`annotations.readOnlyHint: true`。**既存の `required: ['start','end']` の確認はそのまま** |
| `attended_only: true` を渡す | `connector.calls` が `[{ method: 'list', arg: { start, end, attended_only: true } }]`、結果は `{ schedules }` |
| `attended_only: false` を渡す | `arg` に `attended_only: false` がそのまま渡る |
| 省略 | 既存Test「lists schedules for a period」を無変更で成功（`arg` は `{ start, end }` のみ） |
| 不正Input（既存 `it.each` に追加） | `{ start, end, attended_only: 'true' }` / `{ start, end, attended_only: null }` / `{ start, end, attended: true }` → `Input validation error`、Connector未呼び出し |
| description | `schedule_list` のdescriptionが `attended_only` と `#attended` を含む |

### 11.6 回帰

- `npm test` 全件成功。特に `tests/connectors/google-calendar/{client,connector,mapping}.test.ts`・`tests/domain/schedule.test.ts` の既存ケース、`tests/server.test.ts`・`tests/e2e/stdio.test.ts`（Tool 20件・Instructions不変）を無変更で成功させる。
- `npm run typecheck` / `npm run build` が成功する。

---

## 12. Integration Verification

フラグの記入はGoogle Calendar UIでのみ行う（v0.1）。Integration TestはAI FoundationのConnectorで**読み取りのみ**を行い、Eventの作成・更新・削除をしない。

### 12.1 Integration Test（`tests/integration/google-calendar-attendance.integration.test.ts`、手動起動・Read-only）

実行条件: `AI_FOUNDATION_INTEGRATION=1` と `GOOGLE_OAUTH_*`（既存Google Calendar Integration Testと同じ）。

| Test | 内容 |
|---|---|
| 不変条件（常に実行） | 期間 `daysFromToday(-30)`〜`daysFromToday(30)` で `list({start,end})` と `list({start,end,attended_only:true})` を取得し、(1) `attended_only:true` の結果が全件結果の部分列である（同じidの要素は `toEqual`、相対順序も同じ）、(2) `attended_only:false` の結果が省略時と `toEqual`、を確認する。件数をstderrへ出す（タイトル・説明欄は出さない） |
| Fixture（`AI_FOUNDATION_IT_ATTENDANCE_DATE=YYYY-MM-DD` 設定時のみ） | §12.2のFixtureを置いた日付 `D`〜`D+2` で `attended_only:true` を取得し、タイトルが `AF-ATT ` で始まる予定の**集合と順序**が期待一覧と一致すること、省略時には全Fixture（繰り返しは3回分）が返ることを確認する。Fixtureが1件も見つからない場合は失敗させる（skipで成功扱いにしない） |

- Fixtureの期待値はTest内に定数で持ち、`hasAttendedFlag` を使って期待値を計算しない（判定関数とは独立に確認する）。
- 既存 `google-calendar.integration.test.ts` は変更しない。

### 12.2 手動Fixture（Google Calendar UIで作成、検証後にユーザーが削除）

> **rev.2（Plan Reviewの任意提案を反映）**: 手動Fixtureは代表7件に絞った。文章末尾・大文字小文字違い・リンク先URL・系列の説明欄・キャンセル・RSVPのケースはAutomated Test（§11.3 / §11.4）で確認する。

検証用の日付 `D`（未来・過去どちらでもよい）に、Google Calendar UIで次の予定を作成する。WRITABLE＝AI Foundation専用Calendar、OTHER＝それ以外の自分のCalendar（例: メインCalendar）。時刻は `defaults.timezone` のもの。

| Title | Calendar | 種別 | 説明欄（UIでの入力） | `attended_only:true` |
|---|---|---|---|---|
| `AF-ATT 1 plain` | WRITABLE | 時刻 `D` 10:00 | `#attended` | 返る |
| `AF-ATT 2 bold` | WRITABLE | 時刻 `D` 11:00 | `#attended` をUIで**太字**にする（HTMLとして保存される） | 返る |
| `AF-ATT 3 other calendar` | OTHER | 時刻 `D` 12:00 | `#attended` | 返る |
| `AF-ATT 4 all-day` | OTHER | 終日 `D`〜`D+1` | 2行目に `#attended` | 返る（`start: D`, `end: D+1`） |
| `AF-ATT 5 suffix` | WRITABLE | 時刻 `D` 13:00 | `#attended2` | 返らない |
| `AF-ATT 6 empty` | WRITABLE | 時刻 `D` 14:00 | （なし） | 返らない |
| `AF-ATT 7 daily` | WRITABLE | 繰り返し（毎日 09:00、`D`〜`D+2`の3回） | 系列はタグなし。`D+1` の回だけ「この予定のみ」で説明欄に `#attended` | `D+1` の回だけ返る |

- 期待順序（`attended_only:true`）: `4 all-day` → `1 plain` → `2 bold` → `3 other calendar` → `7 daily`（`D+1`）。
- 実行（このファイルだけ）: `AI_FOUNDATION_INTEGRATION=1 AI_FOUNDATION_IT_ATTENDANCE_DATE=<D> npx vitest run --config vitest.integration.config.ts tests/integration/google-calendar-attendance.integration.test.ts`。

### 12.3 手動Verification（記録のみ）

本BranchのBuildでMCP Serverを起動し、MCP Client（Claude Code）から `schedule_list` を直接呼んで確認する。

| # | 操作 | 期待 |
|---|---|---|
| M1 | `{start: D, end: D+2}` | 従来と同じ結果（全Fixture＋同期間の他の予定）。出力に `attended` / `description` Fieldがない |
| M2 | `{start: D, end: D+2, attended_only: false}` | M1と同一 |
| M3 | `{start: D, end: D+2, attended_only: true}` | §12.2の「返る」予定だけ。終日予定は `YYYY-MM-DD` のinclusive end |
| M4 | `{start: D, end: D+2, attended_only: "true"}` | `Input validation error` |
| M5 | `AF-ATT 5 suffix` の説明欄をUIで `#attended` に直してからM3 | `AF-ATT 5 suffix` が追加で返る（キャッシュなし・即時反映） |
| M6 | Google Cloud ConsoleのOAuth同意画面・`.env`・`config.local.yaml` | 変更なし、再認可不要 |

---

## 13. LLM Client Verification

Claude CodeからMCP Server（本Branchの `dist`）へ再接続し、自然文で依頼してTool呼び出しを確認する（記録のみ）。

| # | 依頼 | 期待 |
|---|---|---|
| L1 | 「`D` から3日間で参加済みにした予定を教えて」 | `schedule_list` に `attended_only: true` と期間を付けて呼び、§12.2の「返る」予定だけを答える |
| L2 | 「`D` から3日間の予定を教えて」 | `attended_only` を付けない（または `false`）で呼ぶ |
| L3 | 「`AF-ATT 6 empty` には参加しなかった？」 | フラグなしを「未確認」として扱い、「不参加」と断定しない |
| L4 | 「`AF-ATT 6 empty` を参加済みにして」 | 書き込みToolを探さず、Google Calendar UIで説明欄に `#attended` を書くよう案内する（`schedule_create` で新規作成しない） |

---

## 14. README / 個別仕様

### 14.1 `README.md`

- Tool表の `schedule_list`: 「期間を指定し、閲覧可能な全Calendarから予定を取得（`attended_only: true` で参加済みフラグ `#attended` の付いた予定だけ）」
- 「Configuration」配下（`### Areas` の後）に `### 参加済みフラグ（Google Calendar）` 節を追加:
  - Google Calendar UIで予定の説明欄に `#attended` を手動で書く（大文字小文字を区別、独立した語として。文章末尾なら前に空白を入れる）
  - AI Foundationはフラグを書き込まない。フラグなしは未確認であり不参加ではない。RSVPは使わない
  - 繰り返し予定は各回の説明欄で判定する。系列の説明欄に書くと全回が対象になるため、参加した回だけ記録するときは「この予定のみ」を編集する
  - 他の参加者がいる予定の説明欄は他の参加者にも見える。編集権限のない招待予定には付けられない（Q6）
  - Config・Credential・OAuth Scopeの追加は不要
  - 詳細は [docs/specs/schedule-attendance.md](docs/specs/schedule-attendance.md)
- 「Current Phase」の文に本Issueを追記（例: 「…Life Log MVP（Issue #14）、Google Calendar参加済みフラグ（Issue #15）」）
- Documentation一覧に `Schedule Attendance Flag Design` と本Planを追加

### 14.2 `docs/specs/schedule-attendance.md`（新規）

`docs/specs/lifelog.md` と同じ形式で、Issue #15の詳細設計v0.1と本PlanのPlan Reviewで確定した事項をまとめる。冒頭で「[MVP v0.1仕様](mvp-v0.1.md) は当時の仕様として維持し、本書をv0.1以降に追加された仕様とする」と明記する。

| 節 | 内容 |
|---|---|
| Goal | 参加した予定をGoogle Calendar上で手動記録し、AIから参加履歴として取り出す |
| MVP方針 | §2の1〜7 |
| Tool Interface | `schedule_list` の `attended_only?: boolean`、省略 / `false` の挙動、出力形不変 |
| フラグ判定 | §5.1の規則R1〜R8と§5.3の判定表（代表例） |
| 運用 | 記入方法、未確認の扱い、繰り返し予定、共有予定の可視性・編集権限 |
| 既知の制約 | Entity非decode、本文中の `<英字`、文字直後の `#attended`（Q2）、未終端コメント |
| MVP対象外 | v0.1 §MVP対象外（自動判定、RSVP連動、API書き込み、専用DB / UI、Life Log自動連携、Calendar CRUD拡張） |

---

## 15. Acceptance Criteriaとの対応

Issue #15 v0.1のAcceptance Criteriaを、検証可能な形に具体化する。

| # | Acceptance Criteria（具体化） | 確認方法 |
|---|---|---|
| AC1 | Google Calendar UIで予定の説明欄に `#attended` を手動で記入でき、AI Foundation側に記入用の操作・Toolは存在しない | §12.2（Fixture作成）、§11.6（Tool 20件不変）、§13 L4 |
| AC2 | `schedule_list({start, end, attended_only: true})` が、読み取り可能な**全Calendar**の期間内の予定から、説明欄に独立した `#attended` を持つものだけを返す。時間範囲の解釈・終日予定の `YYYY-MM-DD` inclusive end・ソート順は省略時と同じ | §11.4（複数Calendar・終日・順序・出力の同一性）、§12.1、§12.3 M3 |
| AC3 | `attended_only` 省略 / `false` の結果・呼び出すAPI・Error・出力形が変更前と同一。Toolの必須Inputは `start` / `end` のまま | §11.4（省略と `false` の比較）、§11.5、既存Testの無変更成功（§11.6）、§12.1不変条件、§12.3 M1 / M2 |
| AC4 | 説明欄なし・空・タグなし・部分一致（`#attended2` / `#attended-other`）・大文字小文字違い（`#Attended`）・URL fragment・HTML属性値内の `#attended` は返らない。RSVP `accepted` でもタグがなければ返らず、`declined` でもタグがあれば返る | §11.3（判定表）、§11.4（C / D / E / F / T）、§12.2 5・6 |
| AC5 | `status: cancelled` の予定はタグがあっても返らない。繰り返し予定は各インスタンスの説明欄で判定し、「この予定のみ」編集した回だけ、または系列に付けた場合は全回が返る | §11.4（G / R / S）、§12.2 7 |
| AC6 | 一部Calendarの取得失敗時は `attended_only` に関係なく全体がError（Calendar名を含む `ProviderApiError`）になり、部分結果を返さない。OAuth Scope・Config・Credentialは変更しない | §11.4（一部Calendar失敗）、§3「変更しないもの」、§12.3 M6 |
| AC7 | Domain / 判定関数 / Connector / Tool（FakeScheduleConnector）のAutomated Testと既存回帰Testが成功し、実Google CalendarでのRead-only Integration Test・手動Verification・LLM Client Verificationの結果をPlanに記録する | §11、§12、§13 |
| AC8 | READMEと `docs/specs/schedule-attendance.md` を更新し、`docs/specs/mvp-v0.1.md` に差分がない | §14、PRの差分（`git diff main -- docs/specs/mvp-v0.1.md` が空） |

---

## 16. 懸念点 / 未確定事項

### Q1. 判定前にHTMLタグ・コメントを空白へ置換する

v0.1は「HTMLの可視文字抽出までは実装しない」「HTMLタグ内の文字列の扱いはPlanで明文化する」としている。何も除去せずに判定すると、`<a href="https://example.com/x#attended">` のようにリンク先URLの文字列でも、直前の文字次第で検出され得る（例: `title="#attended"` は `"` が境界になり検出される）。UIでリンクを挿入しただけで参加済みになるのは意図に反するため、**タグとコメントだけを空白1文字へ置換**してから判定する案を採る。Entityのdecode・`<script>` 等の特別扱い・ブロック要素の解釈は行わず、「可視文字抽出」ではない範囲に留める。

### Q2. 文字の直後に続く `#attended` は検出しない

v0.1の許容境界は「空白、改行、句読点、HTMLタグ境界」で、文字との隣接は含まれない。そのため `参加#attended` のように日本語の直後に空白なしで書いた場合は**検出しない**。日本語の文章では空白を入れずに書く可能性があるが、`x#attended` やURL fragmentとの区別を単純に保つため、READMEと仕様書で「前に空白か改行を入れる」と案内する。検出対象に含めたい場合は、R4から `\p{L}` のうちCJK文字だけを外す変更になる（要判断）。

### Q3. Google Calendar APIの `q`（全文検索）を使わない

`events.list` の `q` で `#attended` を検索すれば転送量は減るが、`q` は大文字小文字・トークン化・検索対象Field（summary / location / attendees等）の仕様がAI Foundationの判定規則と一致せず、結果を再判定する必要がある。期間指定の一覧は既に全件取得しているため、`q` は使わずConnector内の判定だけにする（APIのParameterを変えないことで、省略時との差分もfilter 1行に限定できる）。

### Q4. Instructions（`src/instructions.ts`）は変更しない

`schedule_list` のTool説明に `attended_only` の意味・例を書けば、AI Clientは期間＋フラグの呼び出しを選べると考える（§13で確認）。Entity定義（Schedule = Google Calendar）は変わらないため、Instructionsに参加履歴の項は追加しない。LLM Client VerificationでL1が失敗した場合は、Instructionsへの1行追加をPlan外の変更として提案する。

### Q5. Integration TestはRead-only、Fixtureは手動作成

v0.1の「書き込みはGoogle Calendar UI操作のみ」に従い、Integration TestではTest用EventをAPIで作成しない（既存のGoogle Calendar Integration Testは作成・削除を行うが、本Issueでは踏襲しない）。そのため実データでの判定はユーザーがUIで作成したFixture（§12.2）に依存し、`AI_FOUNDATION_IT_ATTENDANCE_DATE` が設定されたときだけ検証する。HTML（太字・リンク）・繰り返し予定の「この予定のみ」編集・削除は、APIではなくUIで作った実データで確認できる利点もある。

### Q6. 共有予定・招待予定の扱い

説明欄は予定ごとに1つで、他の参加者がいる予定に `#attended` を書くと**他の参加者にも見える**。また、編集権限のない招待予定には書けない。v0.1のScope（説明欄のみ、新しいDB・UIなし）ではこれを解決しないため、運用上の制約としてREADME・仕様書に明記するに留める。自分のCalendarにコピーした予定へ書く等の回避策は案内しない（重複予定が `schedule_list` に増えるため）。

### Q7. `attended_only: false` を正規化せずConnectorへ渡す

Tool層で `false` を削除・省略へ正規化しない。Connectorは `=== true` のときだけ絞り込むため結果は省略時と同一で、Tool Testでは渡した値がそのまま記録されることを確認する（§11.5）。Domainに `.default(false)` を付けない理由は §4。

### その他

- フラグの書式（`#attended` 以外の別名、日本語タグ `#参加済み` 等）は追加しない。
- 返却値への `attended: boolean` 追加、`attended_only: false` を「フラグなしだけ」と解釈する案は採らない（v0.1 §設計判断。`false` は省略と同じ）。

---

## 17. Review対応履歴

### rev.2（PR #23 Plan Review反映）

ChatGPTのPlan Review rev.1は「修正必須事項なし・承認相当」。Q1〜Q7はすべて採用。

| 指摘（任意） | 対応 |
|---|---|
| §12.2の手動Fixtureが変更規模に対して多い。代表例に減らし、残りはAutomated Testで担保してよい | 13件（任意2件を含む）を代表7件（単純・太字・別Calendar・終日・非フラグ・説明欄なし・繰り返しの1回だけ編集）に削減。文章末尾・大文字小文字違い・リンク先URL・系列の説明欄・キャンセル・RSVPはAutomated Test（§11.3 / §11.4）で確認する |
| HTMLマークアップ判定は軽量な近似処理で完全なHTML Parserではない旨を、仕様書の制約として維持する | `docs/specs/schedule-attendance.md` のフラグ判定（R7の直後）と「既知の制約」に明記。`hasAttendedFlag` のコメントにも記載 |

---

## 18. 実装で確定した事項

Branch `feat/schedule-attendance`（Base: `main` の `1a4ec01`、PR #23 Merge）。

### 18.1 Verification結果（2026-10-24）

| 項目 | 結果 |
|---|---|
| `npm run typecheck` / `npm run build` | 成功 |
| `npm test` | 54 files / 1323 passed / 5 skipped（skipは既存のもの）。既存のSchedule系Test（Domain / Connector / Mapping / Client / Tool）・`server.test.ts`・`e2e/stdio.test.ts` は**無変更で**成功 |
| Integration Test（§12.1 不変条件、実Google Calendar、Read-only） | 成功（`daysFromToday(-30)`〜`daysFromToday(30)` で、`attended_only:true` が全件結果の部分列、`false` が省略時と同一） |
| Integration Test（§12.1 Fixture） | **未実施**。§12.2のFixtureをユーザーがGoogle Calendar UIで作成した後、`AI_FOUNDATION_IT_ATTENDANCE_DATE` を指定して実行する |
| 手動Verification（§12.3）/ LLM Client Verification（§13） | **未実施**。Implementation Review後に実施して記録する |

### 18.2 Planからの細部の変更・Plan外の変更（Implementation Reviewで確認してほしい点）

- Plan外のSource変更なし。変更は §9.1 の4ファイルのみ（`mapping.ts` / `client.ts` / `instructions.ts` / Config / Credentialは無変更）。
- `tests/tools/schedule.test.ts` の既存Test「lists the two schedule tools…」は**変更せず**、`inputSchema.properties` の確認は新規Test「offers attended_only…」に分けた（§11.5では既存箇所の更新を想定していたが、既存Testは `schedule_list` のproperties一覧を確認していなかったため）。
- READMEでは、Integration Test節にFixture検証の実行条件を追記した（§14.1に加えて）。

### 18.3 Implementation Review（PR #24、Codex）

対象 `9a466e1`。指摘は修正推奨1件で、それ以外（省略 / `false` の互換性、キャンセル除外、既存ソート、API失敗時の処理、§18.2、README追記）は問題なし。

| 指摘 | 対応 |
|---|---|
| [P2] HTML除去の `[^>]*>` が引用符内の `>` でタグを終了させ、`<span title="a > #attended">資料</span>`（単一引用符も同様）を参加済みと誤判定する（R7違反） | タグの正規表現を `<\/?[A-Za-z](?:[^<>"']\|"[^"]*"\|'[^']*')*>` に変更し、引用符で囲まれた属性値の中の `>` ではタグを終えないようにした。引用符の外の `<` で照合を打ち切るため、閉じないタグが大量に並ぶ入力でも線形になる（修正前の正規表現は `<a ` × 20,000 で約340ms、修正後は1ms未満）。回帰Testとして二重引用符・単一引用符・もう一方の引用符を含む値・`<` を含む値の4件、挙動の固定2件（閉じない引用符、閉じない `<` の後のタグ）、性能1件を追加。仕様書の代表例・既知の制約に追記 |

修正後: `npm run typecheck` 成功、`npm test` 54 files / 1330 passed / 5 skipped。

- 残る既知の性能特性: 閉じないHTMLコメント（`<!--`）が大量に並ぶ入力は、修正前と同じく長さの二乗に比例する（`<!-- ` × 20,000 で約330ms）。Google Calendar UIでは生成されない入力のため、MVPでは対応しない。

#### Re-review（対象 `c1ad7bf`）

前回の [P2] は解消済み、新たな修正必須事項なし。Codexが対象Commitの判定関数とTest定義で62ケース、追加の6ケース（本文側のフラグ、コメント内、属性値と本文の双方にフラグ等）を独立に確認。残る確認事項は実Google CalendarのFixture検証・手動Verification・LLM Client Verification（§12・§13）。
