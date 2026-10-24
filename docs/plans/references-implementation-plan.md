# Google Sheets Reference — Implementation Plan

- Status: **Plan（未実装）**
- 作成: Coding Agent (Claude Code) / 2026-10-25
- 対象: [Issue #16 Google スプレッドシートを外部 Reference として登録できるようにする（MVP）](https://github.com/thanatos27/ai-foundation/issues/16)（本文 + コメント「MVP方針変更：ReferenceはEntity自身へ直接記載」）
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md)（**変更しない**）, [Phase 4 Design Issue](../specs/phase-4-knowledge.md), [Areas Design](../specs/areas.md), [Phase 5 Design Issue](../specs/phase-5-project.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

Referenceは、各EntityのSource of Truthに関連資料のリンクを書く**記述規約**として定義する。AI Foundationに新しい保存領域・Tool・Domain Entityは追加しない。本Planの変更はドキュメントと回帰Testだけで、`src/` は変更しない（§4）。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/references-implementation-plan`。Baseは `main` の `c9d6f1b` |
| 依存 | **追加なし** |
| 公開Tool | 21件のまま（**追加・変更なし**） |
| OAuth Scope / Credential | **変更しない** |
| CI | なし（`npm test` をローカルのWindows環境で実行） |

### 既存実装で確認したこと

| 対象 | 現状 | 関連資料リンクへの影響 |
|---|---|---|
| `src/domain/*` の `external_ref` | 各Entity**自身**の所在（Obsidianのパス、GitHub URL、Notion URL等）を表す1値 | 変更しない。関連資料のリストとは別の意味 |
| `src/connectors/obsidian/markdown.ts` `parseKnowledgeFile` | frontmatterの `title` / `description` / `area` / `tags` だけを読み、他のKeyは検証も変更もしない（"Other keys are left alone"） | `references` を書いてもNoteは有効なまま。`references` の中身が配列でもObjectでも文字列でも、Noteの有効性は変わらない |
| 同 `createFileText` / `knowledge_create` | `title` / `description` / `area` / `tags` だけを書く | `knowledge_create` は `references` を書かない |
| `knowledge_append` | 本文末尾への追記のみ。frontmatterはbyte単位で保持（既存Test: `unknown_key: keep me`） | 既存の `references` は保持される |
| `knowledge_get` / `knowledge_search` | `Knowledge`（`title` / `description` / `area` / `tags` 等）と、frontmatterを除いた本文を返す。検索対象はtitle / description / tags / 本文 | frontmatterの `references` は**返らず、検索対象にもならない**（§6 Q1） |
| `src/connectors/notion/area-content.ts` | 文中リンク・mentionは `[テキスト](URL)`、bookmark / embed / link_previewは `[caption or URL](URL)`。URLは先頭が `/` のNotion内リンクだけを絶対URLにし、他は原文のまま | Areaページに書いたGoogle Sheetsリンクは `area_get` の `content` にURL原文で出る |
| `project_get` | Repositoryのメタデータのみ。README・ファイルは返さない | READMEに書いたリンクはAI Foundationからは見えない。GitHubで確認する |
| YAMLとして読めないfrontmatter | Noteは検索から除外（stderrに件数とPath）、`knowledge_get` / `knowledge_append` はError | `references` の書き間違いでYAMLが壊れた場合も同じ扱い（既存の規則） |

---

## 2. 設計方針

1. **Referenceは記述規約。** 概念上のFieldは `type`（MVPは `google_sheets`）、`title`（表示名）、`url`（Google SheetsのURL）の3つ。AI Foundationはこの規約を解析・検証・集約しない。
2. **各EntityのSource of Truthに書く。** KnowledgeはObsidian frontmatter、AreaはNotionページ内のリンク、ProjectはGitHubのREADME等のリンク。3 Providerに同じYAML構造を強制しない。
3. **`external_ref` は変更しない。** Entity自身の所在のまま。
4. **書き込みは既存の手段で行う。** LLMが既存の外部Plugin / Connector（ObsidianやNotion、GitHubのMCP等）で編集できる場合はそれを使い、できない場合は利用者が手で編集する。AI FoundationのKnowledge / Project / Area Toolに書き込み機能を追加しない。
5. **リンクは内容取得を意味しない。** URL先のシートの読み取り・存在確認・権限確認はしない。Google Sheets API / OAuth Scopeは追加しない。
6. **既存の本文中のリンクを移行・自動登録しない。**

---

## 3. 記述規約

### 3.1 共通の意味

| Field | 意味 |
|---|---|
| `type` | 参照先の種類。MVPは `google_sheets` のみ。将来の種類は値を追加して表す |
| `title` | 利用者が付ける表示名。シートのファイル名と一致しなくてよい |
| `url` | Google Sheetsの文書URL（`https://docs.google.com/spreadsheets/d/<id>/...`）。`/edit#gid=0` 等を含めて原文のまま書く |

`external_ref` との違い: `external_ref` は「このEntityがどこにあるか」、Referenceは「このEntityに関連する別の文書はどこか」。

### 3.2 Knowledge（Obsidian frontmatter）

```markdown
---
title: 家計の見直し
area: personal
tags: [money]
references:
  - type: google_sheets
    title: 家計簿 2026
    url: https://docs.google.com/spreadsheets/d/<id>/edit#gid=0
---

本文…
```

- 任意のKey。AI Foundationは読まず、書かず、検証しない（Noteの有効性に影響しない）。
- URLに `#` を含むため、YAMLのコメントにならないよう `url:` の値は `#` の前に空白を入れない（上の例のまま書けばよい）。不安なら引用符で囲む。
- ObsidianのProperties表示は、Objectの配列を編集できない。Source modeでYAMLとして編集する。
- `knowledge_get` / `knowledge_search` の結果には含まれない（§6 Q1）。AI Clientに見せたい場合は、本文にもリンクを書いてよい（規約上は任意）。

### 3.3 Area（Notionページ）

```markdown
# 家計管理

## 関連資料
- [家計簿 2026](https://docs.google.com/spreadsheets/d/<id>/edit)（Google Sheets）
```

- 「関連資料」見出しの下に、リンク（文中リンク、bookmark、embed、link_preview のどれでもよい）として書く。YAML・コードブロックは使わない。
- `area_get` の `content` に `[家計簿 2026](https://docs.google.com/...)` として出る。`type` はリンク先のドメインから分かるため、別途書かなくてよい（書く場合は上の例のように表示テキストに添える）。
- Google Sheets専用のNotion埋め込み（Google Drive連携のプレビュー）は、Notion APIで `embed` / `link_preview` 等として返るものだけが `area_get` でリンクになる。

### 3.4 Project（GitHub README等）

```markdown
## 関連資料

- [家計簿 2026](https://docs.google.com/spreadsheets/d/<id>/edit)（Google Sheets）
```

- READMEの「関連資料」節等にMarkdownリンクとして書く。
- `project_get` はREADMEを返さないため、AI Foundationからは確認できない。GitHub上、またはLLMが使えるGitHubのPlugin / Connectorで確認する。
- PublicなRepositoryに書いたURLは公開される。共有範囲の限られたシートでもURL自体は見える点に注意する（アクセスはGoogle側の共有設定で制御される）。

---

## 4. 変更対象

### 4.1 Source

**変更なし。** 未知のfrontmatter Keyを無視する既存の挙動で `references` を受け付けられることを確認したため、互換対応は不要（§1）。`src/instructions.ts` と各Toolのdescriptionも変更しない。

### 4.2 Tests（回帰のみ）

| File | 追加するケース |
|---|---|
| `tests/connectors/obsidian/markdown.test.ts` | `references`（Objectの配列、`url` に `#gid=0` と `?usp=sharing`）を含むfrontmatterが `ok: true` で、`meta` が `references` なしの場合と同じ。`references` が文字列・空配列・`null` でも `ok: true` |
| `tests/connectors/obsidian/connector.test.ts` | `references` 付きNoteの `knowledge_get` が成功し、`content` にfrontmatterを含まない。`knowledge_search({})` に含まれる。`knowledge_append` 後もfrontmatter（`references` を含む）がbyte単位で変わらない |
| `tests/connectors/notion/area-content.test.ts` | 文中リンクとbookmarkのGoogle Sheets URL（`/edit#gid=0`、`?usp=sharing`）が `[テキスト](URL)` としてURL原文のまま出る |

既存の全Testは変更なしで成功させる。

### 4.3 Documentation

| File | 内容 |
|---|---|
| `docs/specs/references.md`（新規） | §2・§3（意味、Entityごとの書き方、`external_ref` との違い、AI Foundationが行わないこと） |
| `README.md` | 「Obsidian」節に `references` frontmatterの1項目と例、「Areas」の目次テンプレートに「関連資料」見出し、Projectの関連資料の書き方を短く追加。`docs/specs/references.md` へのリンクを「Documentation」節に追加 |

`docs/specs/mvp-v0.1.md` / `phase-4-knowledge.md` / `areas.md` / `phase-5-project.md` は変更しない（規約は `references.md` にまとめる）。

---

## 5. 実装順序とAcceptance Criteria

### 5.1 順序

1. 回帰Test（§4.2）を追加し、`npm test` / `npm run typecheck` が成功することを確認する
2. `docs/specs/references.md` を作成する
3. README（§4.3）を更新する

### 5.2 Acceptance Criteria

| Acceptance Criteria | 対応 | 確認 |
|---|---|---|
| Entityに関連リンク（`type` / `title` / `url`）を保持・確認できる規約がある | §3の規約を `docs/specs/references.md` とREADMEに記載 | ドキュメント |
| Knowledge / Project / Areaのそれぞれに記述例がある | §3.2〜§3.4 | ドキュメント |
| Knowledge frontmatterの `references` で既存Tool・Schemaが壊れない | 既存Parserの挙動のまま | §4.2 Obsidian Test |
| Areaページに書いたGoogle SheetsリンクがURL原文のまま確認できる | 既存の `area_get` | §4.2 Notion Test |
| 既存の `external_ref` と既存Toolの入出力を変えない | `src/` 変更なし | 既存Test全件 |
| Sheets API・OAuth追加・統一Reference APIがない | 依存・Tool・Scopeの変更なし | 差分の確認 |

### 5.3 Verification

- Automated Test: §4.2。外部Serviceへ通信しない。
- 手動Verification（任意・記録のみ）: 実Vaultの検証用Noteに `references` を書き、`knowledge_get` / `knowledge_append` が従来どおり動くこと。実AreaページにSheetsリンクを書き、`area_get` に出ること。
- LLM Client Verification: 完全任意。未実施でも残件としない。

---

## 6. 懸念点 / 未確定事項

### Q1. Knowledgeの `references` はAI Foundationの結果に出ない

`knowledge_get` はfrontmatterを返さないため、frontmatterに書いた `references` はAI Clientから見えない（Obsidianでは見える）。本Planでは既存Schemaを変えず、Obsidianで確認する運用とする。AI Clientに見せる必要がある場合の選択肢は次の2つで、どちらも本Planの範囲外:

- 規約として本文にもリンクを書く（コード変更なし。frontmatterと本文で二重管理になる）
- `Knowledge` 出力に読み取り専用の `references` を追加する（Schemaの追加、不正な値の扱いの設計が必要。別Issue）

### Q2. Project / AreaはYAML構造を持たない

NotionページとREADMEはリンクとして書くため、`type` / `title` は表示テキストとリンク先のドメインで表す。機械的な一覧化はできない。統一的な登録・一覧が必要になった時点で別Issueとする。

### Q3. `references` の書式を検証しない

AI Foundationは `references` を読まないため、`type` の綴り違い・URLの誤りは検出されない。YAMLとして壊れた場合だけ、既存の規則どおりNoteが無効になる（検索から除外、stderrに件数とPath）。
