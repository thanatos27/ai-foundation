# Life Log MVP — Design

[Issue #14](https://github.com/thanatos27/ai-foundation/issues/14)（本文、詳細設計 v0.1 / v0.2）と、[Implementation Plan](../plans/lifelog-implementation-plan.md) のPlan Review（PR #20）で確定した事項をまとめる。[MVP v0.1仕様](mvp-v0.1.md) は既存節を変更せず（§23に追補）、本書をLife Logの仕様とする。詳細設計はv0.2を正とし、v0.1のGoogle Drive直結案は採らない。

## Goal

旅行・イベント・外出などの出来事を不定期に記録する **Life Log（個人活動アーカイブ）** を追加する。体系化された知識を扱うKnowledgeとは独立した保存領域とし、非公開の超簡易ブログのようにMarkdown記事を蓄積する。毎日の日記や構造化ライフログを前提にしない。

## MVP方針

- Life LogはKnowledgeとは別のEntity・Tool・Connector・保存Directory。KnowledgeのFrontmatter・タグ規約をLife Logに適用しない。
- 保存先は既存のObsidian Vault（Filesystem）。Google Drive API・OAuth・移行処理は実装しない。将来のWeb対応でKnowledge / Life LogをまとめてGoogle Drive等へ移行する際に、Storageを差し替えられる構成にする。
- 記録したいときだけ作成する。内容や見出しの整形・意味解釈は呼び出し元LLMが行い、AI Foundationはファイルの入出力に徹する。
- 画像・動画は外部ストレージのリンクを本文に書く。Projects / Areas / Knowledgeへの参照リンクは任意で、自動の紐付け・同期はしない。

## 保存構成

```text
Obsidian Vault/
  AI Foundation/
    Knowledge/   # 既存、変更しない
    LifeLog/
      2026-10-03-東京散策.md
      2026-10-18-EVE-Online開始.md
```

- 1記事 = 1ファイル。名前は `YYYY-MM-DD-<タイトル>.md`。年別ディレクトリは作らない（将来検討）。
- 日付はユーザー指定（`YYYY-MM-DD`、実在日のみ）。
- タイトルのうちファイル名に使えない文字（`/ \ : * ? " < > | # ^ [ ]`・制御文字）は空白に置き換える（Knowledgeと同じ規則）。日付を含むファイル名（拡張子を除く）は200 byteまで。
- 本文は自由形式のMarkdownで、渡されたとおりに保存する。例外として改行をLFにそろえ、末尾改行を1つ保証する。Frontmatter・見出し・日付は付け足さない。

## Domain

```ts
LifeLog {
  id: "lifelog:<file name>",      // 例: lifelog:2026-10-03-東京散策.md
  type: "lifelog",
  date: "YYYY-MM-DD",             // ファイル名から
  title: string,                  // ファイル名から（無害化後の値）
  source: "obsidian",
  external_ref: string,           // Vault相対パス
}
```

- IDはLife Log Directory内のファイル名だけから決まり、Vault内の位置・Provider固有IDを含まない。MVPではDirectory直下（1階層）のみ。
- Obsidianでファイル名を変更するとIDも変わる。
- 将来の移行でIDを維持できるかは、ファイル名規則を保つ移行規則（同名ファイルの扱い・対応付けを含む）に依存し、現時点で完全な移行互換は保証しない。

## 記事の定義

**Life Log Directory直下にある、`YYYY-MM-DD-<タイトル>.md`（実在日、小文字 `.md`）に合う通常ファイル**を記事とする。作成経路は問わず、Obsidianで手動作成したファイルも取得・追記できる。無害化は新規作成時のファイル名生成にのみ適用し、既存ファイルの参照では行わない。規則外の名前・サブディレクトリ内のファイルは対象外。

## MCP Tool

| Tool | Input | Output |
|---|---|---|
| `lifelog_create` | `{ date, title, content }` | `{ lifelog }` |
| `lifelog_get` | `{ id }` | `{ lifelog, content }` |
| `lifelog_append` | `{ id, content }` | `{ lifelog }` |

- `lifelog_create`: 新規のみ。同日に別タイトルの記事は作れる。同じ日付・タイトル（無害化後に同じファイル名）は上書きせず `InputValidationError`。同時に作成しても成功するのは1件だけ（`O_CREAT | O_EXCL`）。
- `lifelog_get`: ファイル全文を返す（Frontmatterがあってもそのまま）。
- `lifelog_append`: 既存の本文を保持し、末尾へ段落として追記する（既存ファイルの改行コードに合わせる）。日時・見出しは付けない。
- 一覧・検索・全文分析・削除・名前変更・UI・タグ・自動Knowledge化は対象外。記事は `lifelog_create` が返したID、またはObsidianで確認した正確なファイル名から作ったIDで参照する。どちらも分からない記事はAI Foundationからは取得できない。

## Configuration

```yaml
sources:
  lifelog:
    provider: obsidian
    obsidian:
      directory: "AI Foundation/LifeLog"
```

- `sources.lifelog` / `directory` はOptional。未設定でもServerと既存Toolは動作し、Life Log ToolはConfiguration Errorを返す。
- Vaultは `sources.knowledge.obsidian.vault_path` を使う。
- Directoryは手動で作成する。AI Foundationは作成せず、Vault全体の走査もしない。
- `directory` が `knowledge_dir` と同一・その内側・それを含む場合は起動時にConfiguration Error（大文字小文字を無視して比較）。`sources.lifelog` 未設定時は判定せず、既存設定の挙動は変わらない。

## Access / Errors

- 読み書きはLife Log Directory直下のファイルのみ。IDのパス区切り・`..`・絶対パス・Knowledge IDは拒否する。Vaultから辿る途中・Directoryの内側のSymbolic Link / Junctionは辿らない（Knowledgeと同じ境界処理を共有）。
- UTF-8でないファイルは `ProviderApiError`（取得も追記もしない）。Knowledgeの読み込み（不正なbyteを置換文字にする）は変更しない。
- Error Messageに絶対パスを含めない。

| 状況 | Error |
|---|---|
| `sources.lifelog` / `directory` / `vault_path` 未設定、Directory不在・Link経由 | Configuration Error |
| 不正な日付・空白のみのtitle / content | 入力Error |
| 壊れたID、ファイル名にできないタイトル、同名記事、Link経由、Directory外 | Input Validation Error |
| 記事が存在しない | Not Found |
| UTF-8でない、権限・その他のFilesystem Error | Provider API Error（Obsidian） |

## 同時実行・外部編集

- AI Foundationは既存ファイルをtruncate・rename・置換しない。追記は `O_APPEND` によるファイル末尾への書き込みのみで、既存の本文を消さない。
- 1回の追記内容全体の不可分性は保証しない（大きな内容を複数プロセスから同時に追記すると混ざり得る）。追記の順序も保証しない。
- 追記の書き込み途中で失敗した場合、末尾に一部だけが残ることがある。
- Obsidianが未保存の古い内容でファイルを保存し直した場合の上書きは検知・防止できない（MVP制約）。
- 同名判定はOSに従う（Windows / macOSでは大文字小文字だけが異なるタイトルは同名）。

## Acceptance Criteria

- 任意の日付・タイトル・本文からMarkdown記事を新規作成できる
- 既存記事を取得できる
- 既存記事へ内容を追記でき、元の本文が失われない
- 同日に複数の異なる記事を保存できる
- Knowledgeと独立した領域に保存され、既存Knowledgeを変更しない
- ファイル未存在・同名記事・Filesystemエラー時の挙動が定義され、テストされている（v0.2により「Drive APIエラー」を読み替え）
- Fake / 一時VaultでAutomated Test、実VaultのIntegration Testはテスト用領域のみを使う
- Knowledgeの既存テスト・Area / Project等の回帰テストが成功する
