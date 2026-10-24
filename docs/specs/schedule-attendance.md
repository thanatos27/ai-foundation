# Google Calendar参加済みフラグ — Design

[Issue #15](https://github.com/thanatos27/ai-foundation/issues/15)（MVP詳細設計 v0.1）と、[Implementation Plan](../plans/schedule-attendance-implementation-plan.md) のPlan Review（PR #23）で確定した事項をまとめる。[MVP v0.1仕様](mvp-v0.1.md) は当時の仕様として維持し、本書をv0.1以降に追加された仕様とする。

## Goal

参加した予定をGoogle Calendar上で手動で記録し、AIから期間を指定して参加履歴として取り出せるようにする。

## MVP方針

- 既存の `schedule_list` にOptionalな `attended_only` を追加する。新しいTool・Domain Field・DB・Credential・OAuth Scope・Configは追加しない。
- `attended_only` を省略、または `false` にした場合の挙動・出力は従来と同じ。
- 判定に使うのはGoogle Calendar Eventの説明欄（`description`）の独立したトークン `#attended` だけ。RSVP（出欠の回答）・予定の種類・Calendarの種類は使わない。
- AI Foundationはフラグを書き込まない。記入はユーザーがGoogle Calendar UIで行う。
- フラグのない予定は **未確認** であり、不参加とは扱わない。
- 説明欄・HTMLの解釈はGoogle Calendar Connectorの責務とし、Domain / Toolは「参加済みフラグの付いた予定だけ」という意味だけを持つ。

## Tool Interface

```text
schedule_list({ start, end, attended_only?: boolean }) → { schedules: Schedule[] }
```

| `attended_only` | 結果 |
|---|---|
| 省略 / `false` | 従来どおり、期間内の全予定 |
| `true` | 期間内の予定のうち、説明欄に `#attended` がある予定だけ |

- `true` でも、対象Calendar（読み取り可能な全Calendar）、期間の解釈、キャンセル済みの除外、終日予定の `YYYY-MM-DD`（endはinclusive）への変換、並び順、Errorは従来と同じ。
- 1つのCalendarの取得に失敗した場合は、従来どおり全体をErrorにする（部分的な結果を返さない）。
- 戻り値の `Schedule` に `attended` や `description` は追加しない。
- `null`・文字列（`"true"`）など、boolean以外の値はInput Errorになる。
- 過去の期間であることは検証しない。期間は呼び出し側が指定する。

## フラグ判定

| # | 規則 |
|---|---|
| R1 | 対象は説明欄（`description`）だけ。タイトル・場所・添付は見ない |
| R2 | 説明欄がない・空の予定は未確認 |
| R3 | 大文字小文字を区別した `#attended` が独立したトークンとして1つ以上あれば参加済み |
| R4 | 直前が文字・数字・結合文字・`_` `-` `#` `&` `/` `\` の場合は独立していない |
| R5 | 直後が文字・数字・結合文字・`_` `-` `#` `/` `\` の場合は独立していない |
| R6 | それ以外（先頭・末尾、空白・改行・NBSP、句読点・括弧などの記号、HTMLタグの境界）は区切りとして許容する |
| R7 | 判定前にHTMLタグとHTMLコメントを空白1文字に置き換える。タグの属性値（リンク先URLなど）とコメントの中身は判定しない |
| R8 | Unicode正規化・全角半角の変換・HTML Entityのdecodeはしない |

R7は軽量な近似処理であり、HTML Parserでも可視文字の抽出でもない。

### 代表例

| 説明欄 | 判定 |
|---|---|
| `#attended` / `参加しました #attended` / `メモ\n#attended` | 参加済み |
| `参加。#attended` / `(#attended)` / `「#attended」` | 参加済み |
| `<b>#attended</b>`（UIで太字）/ `メモ<br>#attended` / `参加<b>#attended</b>` | 参加済み |
| `<a href="https://example.com">#attended</a>`（リンクの表示文字） | 参加済み |
| （なし）/ `参加しました` | 未確認 |
| `#attended2` / `#attended-other` / `#attendedです` | 未確認 |
| `#Attended` / `#ATTENDED` / `＃attended` | 未確認 |
| `参加#attended` / `x#attended` / `##attended` | 未確認（前に空白か改行を入れる） |
| `https://example.com/#attended` / `<a href="https://example.com/#attended">資料</a>` | 未確認 |
| `<!-- #attended -->` / `<span title="#attended">x</span>` | 未確認 |

判定の全ケースは `tests/connectors/google-calendar/attendance.test.ts` で固定している。

## 運用

- 参加した予定をGoogle Calendarで開き、説明欄に `#attended` を書く。文章の後に書く場合は前に空白か改行を入れる。
- 繰り返し予定は各回の説明欄で判定する。系列の説明欄に書くと全回が対象になるため、参加した回だけ記録する場合は「この予定のみ」を編集する。
- キャンセル（削除）した予定はフラグがあっても返らない。
- 他の参加者がいる予定の説明欄は、他の参加者にも見える。編集権限のない招待予定にはフラグを付けられない（MVPでは解決しない）。
- RSVPを「はい」にしただけでは参加済みにならない。逆にRSVPが「いいえ」でもフラグがあれば参加済みとして返る。

## 既知の制約

- HTML Entityはdecodeしない。`&#35;attended` は検出しない。一方、`&nbsp;#attended` は `;` が区切りになるため検出する。
- 本文に `<` と英字を続けて書くとタグと見なす（`x<y #attended>z` は検出しない）。`<` の後に空白がある場合（`a < b #attended`）は本文として扱う。
- 閉じていないコメント（`<!-- #attended`）はコメントと見なさず、検出する（Google Calendar UIでは生成されない）。
- 日本語の文字の直後に空白なしで書いた `#attended` は検出しない（R4）。

## MVP対象外

参加判定の自動化、RSVPとの連動、説明欄へのAPI書き込み、参加状態専用のDB・UI、Life Logへの自動記録、一覧以外のCalendar操作の拡張、`#attended` 以外の別名タグ。
