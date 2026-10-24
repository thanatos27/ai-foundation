# Life Log MVP — Implementation Plan

- Status: **rev.2（Plan Review完了・User承認済み。実装済み: §23）**
- 作成: Coding Agent (Claude Code) / 2026-10-24（rev.2: 2026-10-24 PR #20 レビュー反映）
- 対象: [Issue #14 [MVP] Life Log：Markdownによる個人活動アーカイブ](https://github.com/thanatos27/ai-foundation/issues/14)（本文 + コメント「詳細設計 v0.1」「詳細設計 v0.2」。**v0.2を正**とし、v0.1のGoogle Drive直結案は採らない）
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Phase 4 Design Issue](../specs/phase-4-knowledge.md), [Phase 4 Implementation Plan](phase-4-implementation-plan.md), [Areas Implementation Plan](areas-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

仕様に明記がなく本Planで決めた箇所は [§21 懸念点 / 未確定事項](#21-懸念点--未確定事項) にQとしてまとめている。ChatGPTによるPlan Review（PR #20）でQ1〜Q10はすべて採用となった（一部は条件付き。§21に記載）。追記の指摘への対応は [§22 Review対応履歴](#22-review対応履歴) を参照。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/lifelog-implementation-plan`。Baseは `main` の `cf229ae`（PR #19 Merge） |
| Repository | `thanatos27/ai-foundation`（**Public**） |
| 依存 | `zod 4.6`、Node `>=24`。**追加依存なし**（Filesystemのみ） |
| 公開Tool | 17件（`task_*` 4 / `schedule_*` 2 / `collection_*` 3 / `knowledge_*` 4 / `project_*` 2 / `area_*` 2） |
| CI | なし（`npm test` をローカルのWindows環境で実行） |

### 既存実装の要点（Life Logで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/connectors/obsidian/storage.ts` | `VaultStorage` Interface（`checkKnowledgeDir` / `list` / `read` / `createExclusive` / `append`）。境界を越える値はVault相対パス（`VaultPath`）のみで、将来のGoogle Drive Storageへの差し替えを想定したコメントがある |
| `src/connectors/obsidian/filesystem-storage.ts` | `FilesystemVaultStorage`。唯一 `node:fs` を触るクラス。**境界処理**（Vault rootのrealpath、Vault → `knowledge_dir` の各SegmentをlstatしてLinkを拒否、`knowledge_dir` 内のLink拒否、realpathでの内側確認）、**排他作成**（`open(target, 'wx')` = `O_CREAT \| O_EXCL`、書き込み失敗時はunlink）、**追記**（`O_WRONLY \| O_APPEND`、`O_CREAT` なし）、**errno→Error変換**（絶対パスをMessageに出さない）を持つ。ただしOption名（`knowledgeDir`）、Config Key名、`"obsidian:<path>"` の引用、`knowledge_search` / `knowledge_append` を案内するMessageが**Knowledge固有にハードコード**されている |
| `src/connectors/obsidian/id.ts` | `VaultPath` brand、`obsidian:` prefix、`isValidSegment`、`parseKnowledgeId`。`quoteId` はKnowledge ID形式 |
| `src/connectors/obsidian/filename.ts` | `toFileName(title)`: 危険文字（`/ \ : * ? " < > \| # ^ [ ]`・制御文字）を空白へ置換、先頭`.`/末尾`.`・空白の除去、Windows予約名拒否、200 byte上限 |
| `src/connectors/obsidian/markdown.ts` | Frontmatterの解析・生成（Knowledge固有）と、汎用の `appendText(existing, content)`（段落区切り・既存ファイルの改行コード維持） |
| `src/connectors/obsidian/connector.ts` | `ObsidianKnowledgeConnector`。Frontmatter・Tag・検索などKnowledgeの規約を持つ |
| `src/config/schema.ts` | `sources.knowledge.obsidian { storage: 'filesystem', vault_path?, knowledge_dir? }`、`VaultRelativeDirSchema`（相対・`/`区切り・`.`/`..`/空Segment拒否）。Optionalな `sources.area` の前例あり |
| `src/domain/common.ts` | `DateSchema = z.iso.date()`（Zod 4は実在日を検証する。`2026-02-29` は拒否、`2028-02-29` は受理を確認済み）、`NonBlankSchema` |
| `src/connectors/index.ts` | `knowledgeConnector(config)` で `FilesystemVaultStorage` を生成。起動時にFileを触らない |
| `tests/helpers/vault.ts` | OS temp上の使い捨てVault（`AI Foundation/Knowledge` と隣接 `outside`）、Junction / File symlinkの作成Helper、Messageに出してはいけない絶対パス（`secrets`） |
| `tests/connectors/obsidian/filesystem-storage.test.ts` | Knowledge storageのMessage（`"obsidian:<path>"`、`already exists.*knowledge_append`、`symbolic link or junction` 等）を固定している |

---

## 2. 設計方針

1. **Life LogはKnowledgeと別Entity・別Tool・別Connector・別Directory**（v0.2）。KnowledgeのFrontmatter・Tag・検索の規約をLife Logへ持ち込まない。
2. **保存先は既存Obsidian Vault**（Filesystem）。Google Drive API・OAuth・移行処理は実装しない（v0.2）。
3. **境界処理は1箇所に保つ。** `FilesystemVaultStorage` が持つ「Linkを辿らない・Directory外に出ない・排他作成・追記のみ・絶対パスを漏らさない」処理を、Directory名とMessageを引数にとる内部クラスへ抽出し、KnowledgeとLife Logの両方がそれを使う。Life Log用にファイル操作を書き直さない（§4）。
4. **Knowledgeの外部挙動は変えない。** `FilesystemVaultStorage` / `VaultStorage` の公開API・Error Message・`knowledge_*` の入出力を維持し、既存Knowledge Testを**無変更で**通す（後方互換の検証手段）。
5. **Providerに依存しないID。** Life Log IDは `lifelog:<Life Log Directory内のファイル名>` とし、Vault内の位置（`AI Foundation/LifeLog/`）もProvider固有ID（Drive file ID）も含めない（§6、Q2）。将来の移行でIDを維持できるかは、ファイル名規則を保ったまま移す移行規則に依存する（§13。現時点で完全な移行互換は保証しない）。
6. **Storage境界をProvider差し替え点にする。** Life Log Connectorはファイル名・ID・本文の組み立てだけを持ち、ファイル操作は `LifeLogStorage` Interface越しに行う。将来のGoogle Drive版はこのInterfaceの別実装として追加できる（§13）。
7. **黙って上書きしない。** 作成は `O_EXCL` の排他作成、追記は `O_APPEND` のみで、既存ファイルを書き換える（truncate / rename）コードパスを作らない。
8. **自動作成・走査をしない。** Life Log Directoryは手動で作成する。ToolはVault全体を走査せず、Directoryも作らない（v0.2）。MVPに一覧・検索がないため `list` も呼ばない。

---

## 3. 既存実装への変更点（概要）

| 対象 | 変更 | 理由 |
|---|---|---|
| `domain/lifelog.ts`（新規）, `domain/index.ts` | `LifeLog` / Tool Input / Result Schema | v0.2 §MCP |
| `config/schema.ts` | `sources.lifelog`（Optional、§8）、Knowledge Directoryとの重なりの拒否（Q7） | v0.2 §既存コードを踏まえた実装 |
| `config.yaml` | `sources.lifelog` の設定例 | 設定例 |
| `connectors/obsidian/vault-directory.ts`（新規） | `FilesystemVaultDirectory`: `FilesystemVaultStorage` から抽出した境界処理・ファイル操作（§4） | 共通化 |
| `connectors/obsidian/filesystem-storage.ts` | `FilesystemVaultDirectory` へ委譲する薄いAdapterにする。公開API・Messageは同一 | 共通化・後方互換 |
| `connectors/obsidian/filename.ts` | `toFileName` からタイトルの無害化部分を `sanitizeFileTitle` として切り出す。`toFileName` の挙動・Messageは同一 | Life Logのファイル名に再利用 |
| `connectors/obsidian/markdown.ts` → `text.ts`（新規） | 汎用の `appendText` と本文の改行正規化を `text.ts` へ移し、`markdown.ts` からre-export | Knowledge固有ModuleにLife Logを依存させない |
| `connectors/obsidian/lifelog-id.ts`（新規） | Life Log IDのformat / parse、ファイル名の生成・解析 | §6 |
| `connectors/obsidian/lifelog-storage.ts`（新規） | `LifeLogStorage` Interface | Provider差し替え点 |
| `connectors/obsidian/filesystem-lifelog-storage.ts`（新規） | `FilesystemLifeLogStorage`（`FilesystemVaultDirectory` のAdapter、Life Log用Message、厳格なUTF-8 decode） | §9 |
| `connectors/obsidian/lifelog-connector.ts`（新規） | `ObsidianLifeLogConnector` | §10 |
| `connectors/types.ts` | `LifeLogConnector`、`Connectors.lifelog?` | Connector境界 |
| `connectors/index.ts` | `lifeLogConnector(config)` の配線 | 配線 |
| `tools/lifelog.ts`（新規）, `tools/index.ts` | `lifelog_create` / `lifelog_get` / `lifelog_append` | Tool公開 |
| `instructions.ts` | `Life Log:` の項を追記（Q8） | LLMがLife LogとKnowledgeを区別するため |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 17件 → 20件、Instructions文面 | Tool公開 |
| `README.md` | Source of Truth表、Tool一覧、「Life Log」節、Directory Structure | Issue AC |
| `docs/specs/lifelog.md`（新規）, `docs/specs/mvp-v0.1.md` | Issue #14本文 + v0.2 + 本Planで確定した事項を仕様として記録。MVP仕様には追補節（§23）を非破壊的に追加（Areasの §22 と同じ形） | 仕様をRepositoryに残す（Q8） |

**変更しないもの**: `src/errors.ts`、`src/domain/knowledge.ts`、`src/tools/knowledge.ts`、`src/connectors/obsidian/connector.ts`（import先の変更のみ。挙動は同一）、`id.ts` / `search.ts` / `tags.ts`、`VaultStorage` Interface、`src/credentials/**`（Credential不要）、`.env.example`、`sources.knowledge` のSchema、Knowledgeの既存Test、Area / Project / Collection / Task / Scheduleの実装。

---

## 4. FilesystemVaultStorageの再利用・共通化範囲

### 4.1 現状の結び付き

`FilesystemVaultStorage` の処理は、次の2つに分けられる。

| 区分 | 内容 | Life Logで |
|---|---|---|
| **汎用（Directory非依存）** | Vault rootのrealpath確認 / Vault → 対象DirectoryまでのSegmentごとのLink拒否 / Directory内の `walk`・`existingFile`・`assertInside` / `open('wx')` による排他作成と失敗時のunlink / `O_APPEND` 追記 / BOM除去 / `fsError`（errno codeのみ表示、`cause` に保持） / 再帰 `list` | そのまま使う（`list` 以外） |
| **Knowledge固有** | Option名 `knowledgeDir` / `sources.knowledge.obsidian.knowledge_dir is not set` / `the knowledge directory "…"` / `"obsidian:<path>"` の引用 / NotFoundの `search again with knowledge_search` / EEXISTの `use knowledge_search and knowledge_append` / `is outside the knowledge directory` | 置き換える |

### 4.2 抽出する内部クラス（`vault-directory.ts`）

```ts
/** What a caller calls its directory and how its errors read. Messages never contain OS paths. */
export interface VaultDirectoryLabels {
  /** e.g. `sources.knowledge.obsidian.knowledge_dir` — named when the directory is not set. */
  dirConfigKey: string;
  /** e.g. `knowledge directory` / `life log directory`. */
  dirName: string;
  /** How a file is quoted in messages, e.g. `"obsidian:AI Foundation/Knowledge/x.md"`. */
  quote(segments: readonly string[]): string;
  notFound(segments: readonly string[], cause?: unknown): NotFoundError;
  alreadyExists(segments: readonly string[], cause: unknown): InputValidationError;
}

export interface FilesystemVaultDirectoryOptions {
  vaultPath: string | undefined; // sources.knowledge.obsidian.vault_path
  dir: string | undefined;       // vault-relative, `/`-separated
  labels: VaultDirectoryLabels;
}

/** The file system below one vault directory. Segments are relative to `dir` and already valid. */
export class FilesystemVaultDirectory {
  check(): Promise<void>;
  list(): Promise<{ segments: string[]; modifiedAt: number }[]>; // recursive, Knowledge only
  read(segments: string[]): Promise<{ bytes: Buffer; modifiedAt: number }>;
  createExclusive(segments: string[], text: string): Promise<void>;
  append(segments: string[], text: string): Promise<void>;
}
```

- 現在の `knowledgeRoot` / `existingFile` / `walk` / `assertInside` / `fsError` / `isInside` / `errnoOf` / `isMissing` を**ロジックを変えずに**移動し、Messageの組み立てだけを `labels` 経由にする。
- `read` はBufferを返し、decodeはAdapterが行う（KnowledgeはLenient、Life LogはStrict。Q5）。**fatal decodeはLife Log Adapterだけ**で行い、共通コアはdecodeしない。
- 共通コアの `read` は現行の `Promise.all([readFile(target, 'utf8'), stat(target)])` を `readFile(target)`（Buffer）に変えるだけで、`existingFile` による事前の境界確認・`isMissing` → NotFound・`fsError` の分岐は現行と同じ順序・同じ分類で保つ。
- `vault_path` 未設定 / Vaultが読めない場合のMessage（`sources.knowledge.obsidian.vault_path …`）は両者で同じKeyを使うため共通のままにする（§8.2）。

### 4.3 Knowledge Adapter（`filesystem-storage.ts`）

```ts
export class FilesystemVaultStorage implements VaultStorage {
  constructor(options: FilesystemVaultStorageOptions) // { vaultPath, knowledgeDir } — 変更なし
  // VaultPath ⇄ segments の変換（segmentsBelow / vaultPathBelow）と、現行と同一文言のlabelsを渡すだけ
}
```

- 公開API（Constructor Option、`VaultStorage` の5メソッド）と全Messageを**1文字も変えない**。`tests/connectors/obsidian/filesystem-storage.test.ts` / `connector.test.ts` / `tests/integration/obsidian.integration.test.ts` を無変更で通すことを、リファクタリングの完了条件にする（§15 手順2）。
- `text.replace(/^\uFEFF/, '')` と `readFile(…, 'utf8')` 相当のLenient decode（不正なbyteはU+FFFD）は現行どおり。
- Byte → 文字列の境界（Review指摘2）: Knowledge Adapterは `bytes.toString('utf8')`（`readFile(…, 'utf8')` と同じNode.jsのdecoder。不正なbyteはU+FFFDへ置換し、例外にしない）→ BOM除去の順で、現行と同じ文字列を返す。エラーメッセージも現行と同一。
- これを次の2つで固定する。
  - 既存Test（`filesystem-storage.test.ts` / `connector.test.ts` / `markdown.test.ts`）を**無変更で**成功させる（BOM除去・Messageを含む）。
  - 既存TestにLenient decodeのケースがないため、**新規ファイル** `tests/connectors/obsidian/filesystem-storage-decoding.test.ts` を追加し、Knowledgeについて「BOM付きファイルはBOMなしで読める」「不正なUTF-8 byteを含むファイルはErrorにならずU+FFFDを含む文字列として読め、`knowledge_search` の対象になる」を固定する（既存Testファイルは変更しない）。

### 4.4 共通化しないもの（理由）

| 対象 | 理由 |
|---|---|
| `VaultStorage` Interface | Knowledge用（`VaultPath`・再帰 `list`・`checkKnowledgeDir`）。Life Logに不要な `list` を持たせない。別Interface `LifeLogStorage`（§9.1）にする |
| `ObsidianKnowledgeConnector` / `markdown.ts` のFrontmatter処理 | Knowledge固有（v0.2「規約をLife Logへ強制しない」） |
| `id.ts` の `parseKnowledgeId` | ID形式（prefix・Vault相対）が異なる。`isValidSegment` だけ再利用する |
| Domain Schema（`KnowledgeSchema`） | Field構成が異なる（`date` あり、`description` / `area` / `tags` なし）。共通Baseへの抽出は既存Schemaの変更になるため行わない |

---

## 5. Domain / Tool Input / Tool Result Schema（`src/domain/lifelog.ts`）

ID形式の検証はConnector（`lifelog-id.ts`）で行い、Domain Schemaは `min(1)` に留める（Phase 3〜5、Areasと同じ分担）。

```ts
/** `google_drive` is reserved for the planned migration; only `obsidian` is implemented. */
export const LifeLogSourceSchema = z.enum(['obsidian']);

/**
 * One life log article: an occasional personal event (trip, outing, event) kept as free-form
 * Markdown. Not knowledge: nothing is extracted or organized. The body is read when needed.
 */
export const LifeLogSchema = z.object({
  id: z.string().min(1),           // "lifelog:<file name>"
  type: z.literal('lifelog'),
  date: DateSchema,                // the day the article is about, from the file name
  title: z.string().min(1),        // from the file name (Q3)
  source: LifeLogSourceSchema,
  external_ref: z.string().min(1), // vault-relative path, e.g. "AI Foundation/LifeLog/2026-10-03-東京散策.md"
});

export const LifeLogCreateInputSchema = z.strictObject({
  date: DateSchema,       // YYYY-MM-DD, a real calendar date
  title: NonBlankSchema,
  content: NonBlankSchema, // Markdown body, saved as given
});

export const LifeLogGetInputSchema = z.strictObject({ id: z.string().min(1) });

export const LifeLogAppendInputSchema = z.strictObject({
  id: z.string().min(1),
  content: NonBlankSchema,
});

export const LifeLogDocumentSchema = z.object({ lifelog: LifeLogSchema, content: z.string() });
```

- `LifeLogSourceSchema` に `google_drive` を**今は入れない**（未実装の値をTool出力の型に出さない）。移行時に追加する（Knowledgeは `google_drive` をDomainに予約しているが、Inputでは提供していない。Life Logは出力専用なので追加時の後方互換問題はない）。
- `content` は空文字を許可しない（作成・追記）。取得結果の `content` は空文字を許可する（Obsidianで本文を消した場合）。

---

## 6. ID・ファイル名（`src/connectors/obsidian/lifelog-id.ts`）

### 6.1 ファイル名

```text
<date>-<sanitized title>.md        例: 2026-10-03-東京散策.md
```

| 関数 | 内容 |
|---|---|
| `lifeLogFileName(date, title)` | `sanitizeFileTitle(title)`（`toFileName` と同じ危険文字置換・前後の`.`/空白除去）→ `${date}-${name}.md`。無害化後に空 → `InputValidationError("title … cannot be turned into a file name")`。**ファイル名全体**で200 byteを超える → `InputValidationError`（Knowledgeと同じ上限。日付分を含めて判定） |
| `parseLifeLogFileName(name)` | `^(\d{4}-\d{2}-\d{2})-(.+)\.md$` かつ日付が `DateSchema` で実在日 → `{ date, title }`。合わなければ `undefined` |

- 拡張子は小文字 `.md` のみ（Knowledgeの `isKnowledgeFileName` と同じ）。
- Windows予約名は日付で始まるため発生しない。
- 日付は入力をそのまま使う（Time Zone変換なし。記録日はユーザー指定。v0.2）。

### 6.2 ID

```text
lifelog:<Life Log Directory内のファイル名>        例: lifelog:2026-10-03-東京散策.md
```

| 関数 | 内容 |
|---|---|
| `formatLifeLogId(name)` | `lifelog:${name}` |
| `parseLifeLogId(id)` | prefix `lifelog:` 必須 / 制御文字・`/`・`\` を含まない（**直下のファイルのみ**。v0.2）/ `isValidSegment` / `parseLifeLogFileName` が成功 → `name`。不正なら `InputValidationError('life log id "<id>" <reason>; use an id returned by lifelog_create')`。表示するidは200文字で切る（Knowledgeと同じ） |

- `obsidian:` で始まるKnowledge ID、絶対パス、`../`、`AI Foundation/Knowledge/…` などは**parseの段階で**拒否する（Storageに渡る前）。Storage側でもLink・realpathを確認する二重の境界（§9.3）。
- `external_ref` はVault相対パス（`<directory>/<name>`）。Knowledgeの `external_ref` と同じ形で、絶対パスは含めない。
- IDに年別Directoryを含める拡張（`lifelog:2026/2026-10-03-….md`）は将来の形式として予約し、MVPのparseでは拒否する。

### 6.3 Obsidianで手動作成した記事（Review指摘3）

**Life Logの記事 = 設定DirectoryのDirectory直下にある、ファイル名規則（§6.1の `parseLifeLogFileName` が成功する名前）に合う通常ファイル** と定義する。作成経路は問わない。

| ファイル | `lifelog_get` / `lifelog_append` |
|---|---|
| `lifelog_create` で作成した記事 | 可 |
| ユーザーがObsidianで手動作成した `2026-10-05-鎌倉.md`（設定Directory直下） | **可**（IDは `lifelog:2026-10-05-鎌倉.md`）。中身はFrontmatterの有無を問わずそのまま扱う |
| 手動作成したが規則外の名前（`鎌倉旅行.md`、`2026-10-5-鎌倉.md`、`2026-02-30-x.md`、`2026-10-05-x.MD`） | 不可（IDとして表現できないため `InputValidationError`）。規則に合う名前へObsidianで変更すれば対象になる |
| 規則に合うが、サブDirectoryや他のDirectoryにある | 不可（直下のみ） |
| 手動作成のファイル名にLife Logの無害化で置換される文字（例 `#`）を含む | 規則（日付 + `-` + 1文字以上 + `.md`）と `isValidSegment` を満たせば可。無害化は**新規作成時のファイル名生成**にだけ適用し、既存ファイルの参照では行わない |

- 同名判定（`lifelog_create` の拒否）も作成経路を問わない。手動作成した `2026-10-05-鎌倉.md` があれば、同じ日付・タイトルの `lifelog_create` は失敗する（排他作成のため）。
- 将来の移行（§13）でも、このファイル名規則が **IDとして参照し続けられることの前提** になる。

---

## 7. Tool設計（`src/tools/lifelog.ts`）

```ts
export function registerLifeLogTools(server: McpServer, { config, connectors }: ToolContext): void {
  const connector = (): LifeLogConnector => {
    if (!config.sources.lifelog) throw new ConfigurationError('sources.lifelog is not configured');
    if (!connectors.lifelog) throw new ConfigurationError('the life log source (Obsidian) is not configured');
    return connectors.lifelog;
  };
}
```

| Tool | Input | Output | annotations |
|---|---|---|---|
| `lifelog_create` | `{ date, title, content }` | `{ lifelog }` | `readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false` |
| `lifelog_get` | `{ id }` | `{ lifelog, content }` | `readOnlyHint: true, openWorldHint: false` |
| `lifelog_append` | `{ id, content }` | `{ lifelog }` | `readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false` |

Description（要旨）:

- `lifelog_create`: 旅行・外出・イベントなど、**ある日の出来事**を自由形式のMarkdown記事として新規保存する（再利用する学び・考察は `knowledge_create`、予定は `schedule_create`）。ファイル名は `YYYY-MM-DD-<title>.md`。同日に別タイトルの記事は作れるが、同じ日付・タイトルの記事があれば上書きせず失敗するので、追記したいときは `lifelog_append`。contentはそのまま保存され、見出し・日付・Frontmatterは付け足さない。画像・動画は外部ストレージのURLを本文に書く。返るidで後から取得・追記する。
- `lifelog_get`: idで記事の全文を取得する。**一覧・検索Toolはない**。idは `"lifelog:" + Life Logフォルダ内のファイル名`（例 `lifelog:2026-10-03-東京散策.md`）なので、`lifelog_create` が返したid、またはユーザーがObsidianで見た**正確なファイル名**を伝えた場合はそれを使える。ファイル名を推測で作らない。idもファイル名も分からない記事はこのToolでは取得できないので、ユーザーにObsidianでファイル名を確認してもらう（Q9）。
- `lifelog_append`: 既存記事の末尾へ段落として追記する。既存本文は変更しない。日時・見出しは付けない。呼び直すと再度追記される。

---

## 8. Configuration

### 8.1 Schema（`src/config/schema.ts`）

```ts
sources: z.strictObject({
  …,
  /**
   * Life log articles. Optional so that existing local configs keep working; the lifelog tools
   * return a configuration error without it. The vault is sources.knowledge.obsidian.vault_path.
   */
  lifelog: z
    .strictObject({
      provider: LifeLogSourceSchema,
      obsidian: z
        .strictObject({
          /** The only directory the lifelog tools read and write, relative to the vault. */
          directory: VaultRelativeDirSchema.optional(),
        })
        .optional(),
    })
    .optional(),
}).refine(lifeLogApartFromKnowledge, { message: '…', path: ['lifelog', 'obsidian', 'directory'] }),
```

- 形はv0.2の設定案（`provider` + `directory`）を、既存の `sources.knowledge.obsidian` / `sources.area.notion` に合わせてProvider名の下へ入れたもの（Q1）。将来 `provider: google_drive` を追加するとき、`google_drive: { folder_id }` を並べられる。
- **Vault Pathは新設しない。** `sources.knowledge.obsidian.vault_path`（と `storage: filesystem`）を再利用する（v0.2）。
- `directory` は `VaultRelativeDirSchema`（Vault root自体は不可）。
- `lifeLogApartFromKnowledge`: `lifelog.obsidian.directory` と `knowledge.obsidian.knowledge_dir` が**同じ、または一方が他方の内側**なら起動時 `ConfigError`（大文字小文字を無視してSegment比較。Q7）。どちらかが未設定なら判定しない。
- Life Logの記事・IDはConfigに書けない（strict）。

### 8.2 未設定時の挙動

| 状態 | Server起動 | Life Log Tool | 既存Tool |
|---|---|---|---|
| `sources.lifelog` なし | 起動する | `ConfigurationError('sources.lifelog is not configured')` | 影響なし |
| `obsidian.directory` なし | 起動する | `ConfigurationError('sources.lifelog.obsidian.directory is not set')` | 影響なし |
| `knowledge.obsidian.vault_path` なし | 起動する | `ConfigurationError('sources.knowledge.obsidian.vault_path is not set')`（Knowledgeと同じ） | Knowledge Toolも同様（現行どおり） |
| Directoryが存在しない / Linkを経由する / Directoryでない | 起動する | `ConfigurationError('the life log directory "<dir>" …')`。自動作成しない | 影響なし |
| Knowledge Directoryと重なる | `ConfigError`（起動しない） | — | — |

### 8.3 `config.yaml`

```yaml
  lifelog:
    # Occasional life events (trips, outings, events) as free-form Markdown articles,
    # one file per article: <directory>/YYYY-MM-DD-<title>.md (see README "Life Log").
    # The vault is sources.knowledge.obsidian.vault_path. Create the directory yourself;
    # it must not be inside (or contain) knowledge_dir.
    provider: obsidian
    obsidian:
      directory: "AI Foundation/LifeLog"
```

`directory` は個人情報ではない（`knowledge_dir` と同じ扱いでCommitしてよい）。`vault_path` は従来どおり `config.local.yaml` のみ。

---

## 9. LifeLogStorage

### 9.1 Interface（`lifelog-storage.ts`）

```ts
export interface LifeLogFile {
  /** File name directly in the life log directory, e.g. `2026-10-03-東京散策.md`. */
  name: string;
  /** Location for `external_ref`: vault-relative for Obsidian. Never an absolute OS path. */
  ref: string;
  /** UTF-8 text without a byte order mark. */
  text: string;
}

/**
 * How life log articles are stored (MVP: one directory in the Obsidian vault on the file system).
 * Everything that crosses this boundary is a file name in the life log directory, so another storage
 * (e.g. a Google Drive folder) can replace it without changing life log IDs. Every method first
 * checks that the directory is usable (ConfigurationError) and never touches anything outside it.
 */
export interface LifeLogStorage {
  /** `external_ref` of `name` without touching the storage. */
  refOf(name: string): string;
  /** NotFoundError when no regular file is there; ProviderApiError when it is not valid UTF-8. */
  read(name: string): Promise<LifeLogFile>;
  /** Creates the file; InputValidationError when anything already exists with that name. Never overwrites. */
  createExclusive(name: string, text: string): Promise<void>;
  /** Adds `text` to the end of the existing file only; NotFoundError when it is gone. */
  append(name: string, text: string): Promise<void>;
}
```

### 9.2 `FilesystemLifeLogStorage`（`filesystem-lifelog-storage.ts`）

- `FilesystemVaultDirectory` に `segments = [name]`（常に1要素）で委譲する。
- labels: `dirConfigKey = 'sources.lifelog.obsidian.directory'`、`dirName = 'life log directory'`、`quote = "lifelog:<name>"`、NotFound = `life log "lifelog:<name>" was not found; it may have been renamed, moved or deleted in Obsidian`、EEXIST = `life log "lifelog:<name>" already exists; choose another title, or use lifelog_append to add to it`。
- decode: `new TextDecoder('utf-8', { fatal: true })` → 失敗時 `ProviderApiError('Obsidian', 'life log "lifelog:<name>" is not valid UTF-8; fix it in Obsidian')`。BOMは除去（Q5）。

### 9.3 境界（Knowledgeと同じ規則を共有）

| 対象 | 挙動 |
|---|---|
| Vault rootより上のLink / Junction | 許可（Knowledgeと同じ。同期フォルダへのLinkを想定） |
| Vault → Life Log DirectoryのSegmentがLink | `ConfigurationError` |
| 記事ファイルがSymbolic Link | `InputValidationError`（`goes through a symbolic link or junction`）。Linkは辿らない |
| 記事名の場所にDirectoryがある | `NotFoundError` |
| realpathがDirectory外 | `InputValidationError`（`is outside the life log directory`） |
| サブDirectory内のファイル | IDのparseで拒否（`/` を含められない） |
| errno（EACCES / EPERM / EBUSY 等） | `ProviderApiError('Obsidian', 'cannot read|write … (<code>)')`。絶対パスはMessageに出さず `cause` に保持（既存 `fsError`） |

---

## 10. LifeLogConnector

### 10.1 Interface（`src/connectors/types.ts`）

```ts
/** Source of Truth: Obsidian. Reads and writes only Markdown files directly in the configured life log directory. */
export interface LifeLogConnector {
  /** Creates a new article. Never overwrites an existing file. */
  create(input: LifeLogCreateInput): Promise<LifeLog>;
  /** The article with this exact id and its full Markdown text. */
  get(id: string): Promise<LifeLogDocument>;
  /** Appends `content` as a new paragraph at the end without changing the existing text. */
  append(input: LifeLogAppendInput): Promise<LifeLog>;
}
```

### 10.2 `ObsidianLifeLogConnector`（`lifelog-connector.ts`）

```ts
export interface ObsidianLifeLogConnectorOptions {
  directory: string | undefined; // sources.lifelog.obsidian.directory
  storage: LifeLogStorage;
}
```

| メソッド | 処理 |
|---|---|
| `create({ date, title, content })` | `directory` 未設定 → `ConfigurationError` → `name = lifeLogFileName(date, title)` → `text = normalizeBody(content)`（CRLF/CR → LF、末尾改行を1つ保証。Knowledgeの本文処理と同じ。`text.ts`）→ `storage.createExclusive(name, text)` → `toLifeLog(name)` |
| `get(id)` | `name = parseLifeLogId(id)` → `storage.read(name)` → `{ lifelog: toLifeLog(name), content: file.text }`（ファイル全文。Frontmatterを解析しない。Q4） |
| `append({ id, content })` | `name = parseLifeLogId(id)` → `file = storage.read(name)`（存在・UTF-8・境界の確認を兼ねる）→ `storage.append(name, appendText(file.text, content))` → `toLifeLog(name)` |
| `toLifeLog(name)` | `{ id: formatLifeLogId(name), type: 'lifelog', ...parseLifeLogFileName(name), source: 'obsidian', external_ref: storage.refOf(name) }` |

- 本文に見出し・日付・Frontmatterを付け足さない（v0.2「Markdown本文は呼出元LLMが整える」）。**例外**として、作成時は改行をLFへ正規化し末尾改行を1つ保証する。追記時は既存ファイルの改行コードへ揃え、段落区切りの改行と末尾改行を補う（`appendText`）。これ以外の加工はしない（Q4）。
- `appendText` は既存ファイルの改行コード（CRLFがあればCRLF）を維持し、段落区切りの空行を必要な分だけ入れる（Knowledgeと同じ関数）。

### 10.3 同時実行・外部編集（v0.1で求められた競合方針）

| 状況 | 挙動 | 保証 |
|---|---|---|
| 同じ日付・タイトルの `lifelog_create` が同時に2件 | `O_CREAT \| O_EXCL` により**ちょうど1件**が成功し、他は `InputValidationError`（already exists）。後着が先着の内容を上書きすることはない | Automated Testで固定（§16.4） |
| 書き込み途中で失敗 | 作成したファイルをunlinkし、半端な記事を残さない（既存処理） | 既存Test |
| 同じ記事への `lifelog_append` が同時に2件 | 各書き込みはファイル末尾から行われ（`O_APPEND`）、truncateしないため、**既存の本文は消えない**。2件の追記テキストがそれぞれ1つの塊として残ることは、§16.4のTest条件（同一プロセス・小さい追記テキスト）では確認するが、**任意サイズ・複数プロセスでの追記テキスト全体の不可分性は保証しない**（下記）。順序も保証しない。区切りの空行は各呼び出しの読み込み時点で決めるため、競合時に空行の数がずれることはある | §16.4（条件付きの検証） |
| 読み込み後、追記前にObsidian等で編集された | 追記は末尾へのappendのみなので、外部の編集内容を消さない。区切りの空行だけが読み込み時点基準になり得る | §16.4 |
| 追記の書き込み途中で失敗（ディスク容量不足・同期ソフトのロック等） | 作成時と異なりunlinkできない（既存本文があるため）。**末尾に追記テキストの一部だけが残ることがある**。Errorは `ProviderApiError` で返す。既存本文は変わらない | **MVP制約**としてREADMEに記載 |
| 読み込み後、追記前に削除・改名された | `O_CREAT` なしで開くため再作成せず `NotFoundError` | 既存処理 + Test |
| Obsidianが未保存の古い内容でファイル全体を保存し直す | AI Foundation側では検知・防止できない（Obsidianの保存はAI Foundationの外）。**MVP制約**としてREADMEに記載 | — |

**`O_APPEND` が保証すること・しないこと**（Review指摘1）:

- 保証すること: 各書き込み（`write` システムコール）の開始位置がその時点のファイル末尾になること。AI Foundationは既存内容をtruncate / rename / 置換しないので、**AI Foundationの書き込みが既存の本文を消すことはない**。
- 保証しないこと: 1回の `lifelog_append` の追記テキスト全体が、1回の書き込みとして不可分に入ること。Node.jsの `FileHandle.writeFile` は大きなデータを複数回の `write` に分けることがあり、その間に別プロセス（別のMCP Server instance、Obsidian、同期ソフト）の書き込みが入ると、2つの追記テキストが**交互に混ざる**可能性がある。また、ローカル以外のFilesystem（ネットワークドライブ等）では `O_APPEND` 自体の原子性が弱い場合がある。
- 同時追記のAutomated Testは、この条件付きの性質（同一プロセス・小さいテキスト）の確認であり、一般的な原子性の証明ではない。

ロック・Version比較は導入しない。上書き系の書き込み（truncate / rename / writeFileでの置換）を一切行わないことで「AI Foundationが黙って上書きしない」を構造的に満たす。

---

## 11. Error Mapping

| 状況 | Error |
|---|---|
| `sources.lifelog` なし | `ConfigurationError`（Tool層） |
| `directory` / `vault_path` 未設定、Directory不在・Link経由 | `ConfigurationError`（§8.2） |
| 日付形式不正・実在しない日付、空白のみのtitle / content、未知Key | Schemaの入力Error（MCP SDKのValidation） |
| 無害化後に空のtitle、ファイル名が長すぎる、OSが受け付けないファイル名（`EINVAL` / `ENAMETOOLONG`） | `InputValidationError` |
| 壊れたID（prefix違い・サブDirectory・`..`・絶対パス・`.md` 以外・ファイル名規則外・実在しない日付） | `InputValidationError` |
| 同名記事が存在 | `InputValidationError`（already exists。上書きしない） |
| 記事が存在しない / Directoryである | `NotFoundError` |
| Link経由 / Directory外 | `InputValidationError` |
| 非UTF-8 | `ProviderApiError('Obsidian', …)` |
| 権限・その他のFilesystem Error | `ProviderApiError('Obsidian', '… (<errno code>)')` |

すべてのMessageに絶対パス・Vault Pathを含めない（Vault相対の `"lifelog:<name>"` とDirectory名のみ）。

---

## 12. 配線（`src/connectors/index.ts`）

```ts
/** The life log connector: articles in a directory of the Knowledge vault (MVP: the file system only). */
function lifeLogConnector(config: Config): ObsidianLifeLogConnector {
  const directory = config.sources.lifelog?.obsidian?.directory;
  return new ObsidianLifeLogConnector({
    directory,
    storage: new FilesystemLifeLogStorage({ vaultPath: config.sources.knowledge.obsidian?.vault_path, directory }),
  });
}

return { …, lifelog: lifeLogConnector(config) };
```

起動時にFileを触らない（Phase 2〜5方針）。

---

## 13. 将来のGoogle Drive移行への配慮

MVPでは実装しないが、次の構成により移行を妨げない。

| 層 | 移行時の変更 | MVPでの配慮 |
|---|---|---|
| Domain | `LifeLogSourceSchema` に `google_drive` を追加 | IDにProvider名・Provider固有ID・Vault内パスを含めない（`lifelog:<file name>`） |
| Tool | 変更なし | Tool入出力にファイルシステム概念（絶対パス・errno）を出さない |
| Connector | ファイル名・ID・本文組み立てはそのまま再利用 | ロジックを `LifeLogStorage` 越しに書き、`node:fs` を `FilesystemVaultDirectory` に閉じ込める |
| Storage | `GoogleDriveLifeLogStorage implements LifeLogStorage`（folder_id直下を名前で解決）を追加 | Interfaceはファイル名単位・Directory直下のみ |
| Config | `provider: google_drive` + `google_drive: { folder_id }` を追加 | Provider名の下に設定をまとめる（Q1） |
| データ移行 | ファイル名規則（§6.1）を保ったまま移す移行規則を別途定める | IDはファイル名だけから決まる |

**IDの互換性について**: IDがファイル名だけから決まるため、同じファイル名・Directory直下という構成のまま移せば、同じIDで参照し続けられる**見込み**がある。ただし、移行先の命名制約（Driveは同名ファイルを複数持てる、など）や、同名ファイルの扱い・名前の対応付け（マッピング）を含む移行規則は移行時に設計する。現時点で完全な移行互換を保証するものではない（Q2）。前提になるのは、手動作成の記事を含め §6.3 のファイル名規則に合うことである。

移行時に別途設計が必要な点（本MVPでは扱わない）: Drive APIには原子的な名前一意制約がないため `createExclusive` の競合方針、`drive.file` Scopeで手動配置ファイルを扱えない点（Issue #14 v0.1の論点）。KnowledgeのGoogle Drive化（IDが `obsidian:<vault path>` でVault位置に依存する）は本Issueの範囲外。

---

## 14. 追加・変更予定ファイル

### 14.1 Source

| File | 種別 | 責務 |
|---|---|---|
| `src/domain/lifelog.ts` | 新規 | §5 |
| `src/domain/index.ts` | 変更 | `export * from './lifelog.js'` |
| `src/config/schema.ts` | 変更 | §8.1 |
| `src/connectors/obsidian/vault-directory.ts` | 新規 | §4.2 |
| `src/connectors/obsidian/filesystem-storage.ts` | 変更 | §4.3（委譲のみ） |
| `src/connectors/obsidian/filename.ts` | 変更 | `sanitizeFileTitle` の切り出し |
| `src/connectors/obsidian/text.ts` | 新規 | `appendText` / `normalizeBody`（`markdown.ts` から移動し、`markdown.ts` はre-export） |
| `src/connectors/obsidian/markdown.ts` | 変更 | 上記の移動のみ |
| `src/connectors/obsidian/lifelog-id.ts` | 新規 | §6 |
| `src/connectors/obsidian/lifelog-storage.ts` | 新規 | §9.1 |
| `src/connectors/obsidian/filesystem-lifelog-storage.ts` | 新規 | §9.2 |
| `src/connectors/obsidian/lifelog-connector.ts` | 新規 | §10.2 |
| `src/connectors/types.ts` | 変更 | §10.1 |
| `src/connectors/index.ts` | 変更 | §12 |
| `src/tools/lifelog.ts` | 新規 | §7 |
| `src/tools/index.ts` | 変更 | `registerLifeLogTools` |
| `src/instructions.ts` | 変更 | Q8 |

### 14.2 Tests

| File | 種別 | 内容 |
|---|---|---|
| `tests/domain/lifelog.test.ts` | 新規 | Schema |
| `tests/config/schema.test.ts` | 変更（追加のみ） | `sources.lifelog` |
| `tests/connectors/obsidian/lifelog-id.test.ts` | 新規 | ID・ファイル名 |
| `tests/connectors/obsidian/filename.test.ts` | 変更（追加のみ） | `sanitizeFileTitle`。既存ケースは無変更 |
| `tests/connectors/obsidian/text.test.ts` | 新規 | `markdown.test.ts` の `appendText` ケースはそのまま残し（re-export経由で通る）、`normalizeBody` を追加 |
| `tests/connectors/obsidian/vault-directory.test.ts` | 新規 | 抽出したクラスをlabels付きで直接検証（labelsがMessageに使われること、`read` がdecodeせずBufferを返すこと） |
| `tests/connectors/obsidian/filesystem-storage-decoding.test.ts` | 新規 | Knowledge storageのByte → 文字列境界（BOM除去・不正UTF-8のLenient decode）を固定（§4.3。既存Testファイルは変更しない） |
| `tests/connectors/obsidian/filesystem-lifelog-storage.test.ts` | 新規 | temp Vaultで境界・Error |
| `tests/connectors/obsidian/lifelog-connector.test.ts` | 新規 | temp Vaultで作成→取得→追記・競合・独立性 |
| `tests/helpers/vault.ts` | 変更 | `LIFELOG_DIR = 'AI Foundation/LifeLog'` を作成対象に追加（既存の構成・関数は不変） |
| `tests/helpers/fake-connectors.ts` | 変更 | `FakeLifeLogConnector` |
| `tests/tools/lifelog.test.ts` | 新規 | Tool層 |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 変更 | Tool 20件、Instructions、未設定時の `ConfigurationError` |
| `tests/integration/obsidian-lifelog.integration.test.ts` | 新規 | 実Vault（手動起動、§17） |
| `tests/connectors/obsidian/filesystem-storage.test.ts`, `connector.test.ts`, `markdown.test.ts`, `id.test.ts`, `search.test.ts`, `tags.test.ts`, `tests/tools/knowledge.test.ts`, `tests/integration/obsidian.integration.test.ts` | **変更なし** | Knowledge回帰（§16.6） |

### 14.3 Project設定 / Documentation

| File | 変更 |
|---|---|
| `config.yaml` | §8.3 |
| `README.md` | Source of Truth表にLife Log、Current Phase / Tool一覧、「Life Log」節（§18）、Directory Structure、Documentation |
| `docs/specs/lifelog.md` | 新規（Q8） |
| `docs/specs/mvp-v0.1.md` | 末尾に「§23 MVP v0.1以降の拡張 — Life Log」を追加（既存節は書き換えない） |
| `docs/plans/lifelog-implementation-plan.md` | 本Plan。実装後に「実装・Verificationで確定した事項」を追記する |

---

## 15. 実装順序

1. `domain/lifelog.ts` + Test
2. **共通化リファクタリング（機能追加なし）**: `vault-directory.ts` 抽出、`filesystem-storage.ts` 委譲化、`text.ts` 移動、`sanitizeFileTitle` 切り出し → `npm run typecheck` / `npm test` で**既存Knowledge Testが無変更で全件成功**することを確認してから次へ進む（別Commitにする）
3. `config/schema.ts` + `config.yaml` + Test
4. `lifelog-id.ts` + Test
5. `lifelog-storage.ts` / `filesystem-lifelog-storage.ts` + `tests/helpers/vault.ts` + Test
6. `lifelog-connector.ts` + Test
7. `connectors/types.ts` / `index.ts`
8. `tools/lifelog.ts` / `tools/index.ts` + `FakeLifeLogConnector` + Tool Test
9. `instructions.ts`、`server.test.ts` / e2e更新 → `npm run typecheck` / `npm test` / `npm run build`
10. `docs/specs/lifelog.md`、`mvp-v0.1.md` 追補、README
11. Integration Test・手動Verification・LLM Client Verification（§17、§19）、本Planへ結果を追記

実装Branchは `main` から作成する `feat/lifelog`。

---

## 16. Automated Test

### 16.1 方針

- 通常Test（`npm test`）は**OS temp上の使い捨てVault**（`tests/helpers/vault.ts`）とFake Connectorのみ。ユーザーのVaultへ到達しない。
- 純粋関数（ID / ファイル名 / 本文）は単体、Storage・ConnectorはTemp Vault、Tool層はFake Connectorで検証する（Phase 4と同じ層分け）。
- すべてのError Messageについて、Temp Vaultの絶対パス（`vault.secrets`）を含まないことを確認する（既存 `expectError` と同じ）。
- File symlinkはWindowsで開発者モードがないと作れないため、既存の `canLinkFiles()` で `it.skipIf` する。Directory Junctionは常に検証する。

### 16.2 Domain / Config

- `LifeLogCreateInputSchema`: 正常、`2026-02-29` / `2026-13-01` / `2026-1-1` / `2026/10/03` 拒否、`2028-02-29` 受理、空白のみのtitle・content拒否、未知Key拒否
- `LifeLogDocumentSchema`: `content: ''` を許可
- Config: `sources.lifelog` 省略で起動可、`provider` が `obsidian` 以外は拒否、`directory` の相対・`/`区切り検証（`VaultRelativeDirSchema` の既存ケースと同等）、未知Key拒否、`knowledge_dir` と同一 / 内側 / 外側（包含）/ 大文字小文字違いの同一を拒否、兄弟Directory（`AI Foundation/Knowledge` と `AI Foundation/LifeLog`）は受理、どちらか未設定なら判定しない。**`sources.lifelog` を含まない既存の設定（`tests/fixtures/config/*`、Repositoryの `config.yaml` からlifelogを除いたもの）は、現行と同じ結果（受理 / 同じError）になる**（Q7の条件）

### 16.3 純粋関数

- `lifeLogFileName`: 通常、危険文字の置換（`/ \ : * ? " < > | # ^ [ ]`・制御文字）、前後の`.`・空白、無害化後に空 → Error、日本語、日付込みで200 byte境界（ちょうど / 超過）
- `parseLifeLogFileName`: 正常、日付なし、実在しない日付、`.MD`、`.md` のみ、タイトル部が空
- `parseLifeLogId`: 正常、`obsidian:…`（Knowledge ID）、prefixなし、`lifelog:` のみ、`lifelog:sub/x.md`、`lifelog:../x.md`、`lifelog:..\\x.md`、`lifelog:C:/x.md`、`lifelog:/x.md`、制御文字、`.txt`、長いidの表示切り詰め
- `normalizeBody` / `appendText`（既存ケース維持）: CRLF / CR → LF、末尾改行、既存CRLFファイルへの追記はCRLF、空ファイルへの追記

### 16.4 Storage / Connector（Temp Vault）

| 観点 | ケース |
|---|---|
| 作成→取得→追記 | `create` → 返ったidで `get`（`content` が入力と一致、`date` / `title` / `external_ref` が正しい）→ `append` → `get` で**元の本文と追記内容の両方**が残り、段落区切りが1つ |
| 同日複数記事 | 同じ日付・異なるタイトルで2件作成でき、別ID・別ファイル |
| 同名拒否 | 同じ日付・タイトルの2回目は `InputValidationError`、既存ファイルの内容が**バイト単位で不変** |
| 無害化で衝突 | `東京:散策` と `東京 散策` → 同じファイル名になり2件目は拒否（上書きしない） |
| 同時作成 | 同じ日付・タイトルで `Promise.allSettled` 10件 → fulfilled 1件・rejected 9件（すべてalready exists）、ファイルの内容は成功した1件のもの |
| 同時追記（条件付き） | **同一プロセス・数KB以下の追記テキスト**で、同じ記事へ `Promise.all` で2件 → 元の本文が先頭にそのまま残り、両方の追記テキストがそれぞれ連続した塊として含まれる。§10.3のとおり、任意サイズ・複数プロセスでの不可分性を示すTestではないことをTest名・コメントに明記する |
| 追記の書き込み失敗 | `FilesystemVaultDirectory` の書き込みが失敗する状況（`append` の書き込みでErrorを投げるStub）で `ProviderApiError` になり、既存本文が変わらない（部分追記が残り得ることはREADMEの制約として扱い、Testでは既存本文の保持のみ確認） |
| 手動作成の記事（§6.3） | Temp Vaultの `LifeLog` 直下に手で置いた `2026-10-05-鎌倉.md`（Frontmatterあり / なし）を `lifelog:2026-10-05-鎌倉.md` で取得・追記できる。規則外の名前（`鎌倉旅行.md`、`2026-10-5-鎌倉.md`）は `InputValidationError`。手動作成の記事と同じ日付・タイトルの `lifelog_create` は失敗し、手動の記事が不変 |
| UTF-8の完全性 | 作成・追記したファイルを**Bufferで読み**、`TextDecoder({ fatal: true })` で例外なくdecodeでき、BOMを含まず、期待する文字列と一致する（日本語・絵文字・サロゲートペアを含む本文、CRLFファイルへの追記を含む） |
| 外部編集との共存 | `read` 後に外部で末尾へ書き足した状態を再現（Storage Fakeで `read` と `append` の間にファイルを書き換える）→ 外部の書き足しが消えない |
| 削除・改名後 | 取得・追記で `NotFoundError`、追記で**ファイルが再作成されない** |
| 本文 | 作成時にFrontmatter・見出しを付けない（ファイル全体 = 正規化した `content`）、BOM付きファイルの取得でBOMを除去、Obsidianで追加されたFrontmatterは `content` にそのまま含まれる、非UTF-8 → `ProviderApiError` かつ追記もしない |
| Directory境界 | Vault外 `outside` へのJunctionを `LifeLog` 内に置いても辿らない、記事ファイルのSymbolic Link（skipIf）→ `InputValidationError`、記事名と同名のDirectory → `NotFoundError`、Vault → `LifeLog` の途中がJunction → `ConfigurationError` |
| 設定 | `directory` 未設定 / `vault_path` 未設定 / Directory不在 → `ConfigurationError`、**Directoryを自動作成しない**（不在のまま） |
| Knowledgeとの独立 | Life Logの作成・追記の前後で `Knowledge` 配下のファイル一覧と内容が不変。Knowledge ID（`obsidian:AI Foundation/Knowledge/x.md`）を `lifelog_get` / `append` に渡すと `InputValidationError`。`knowledge_search` の結果にLife Log記事が出ない |
| 権限 | POSIXでは `chmod 000` のファイルで `ProviderApiError`（`EACCES`、絶対パスなし）。Windowsでは `it.skipIf` とし、代わりに `FilesystemVaultDirectory` のerrno変換を、`EACCES` / `EPERM` のErrorを投げる関数で単体検証する |
| ファイル名 | OSが拒否する名前（`EINVAL`）→ `InputValidationError` |

### 16.5 Tool Layer / Server / e2e

- `tests/tools/lifelog.test.ts`: 入出力Schema（output schemaとの一致）、`sources.lifelog` なし / Connectorなしで `ConfigurationError`、Connector Errorの伝播、annotations
- `server.test.ts`: 公開Tool 20件、Instructions文面
- e2e: Repository `config.yaml`（`vault_path` なし）で起動し、Tool 20件、`lifelog_create` が `ConfigurationError`

### 16.6 回帰

- Knowledge: `tests/connectors/obsidian/*`（既存）、`tests/tools/knowledge.test.ts` を**無変更で**成功させる。特に `filesystem-storage.test.ts` が固定しているMessage（`"obsidian:<path>"`、`already exists.*knowledge_append`、`symbolic link or junction`、Configuration ErrorのMessage）が同一であること。Byte → 文字列の境界は `filesystem-storage-decoding.test.ts`（新規）で補う（§4.3）
- Area / Project / Collection / Task / Schedule: 既存Testを無変更で成功させる

---

## 17. Integration Verification

### 17.1 Integration Test（`tests/integration/obsidian-lifelog.integration.test.ts`、手動起動）

`AI_FOUNDATION_INTEGRATION=1` かつ `config.local.yaml` に `vault_path` と `sources.lifelog.obsidian.directory` がある場合のみ実行。**テスト用のLife Log Directory（またはテスト用Vault）を使う**ことをREADMEとTest冒頭のコメントに明記する。

- 作成するのは本Testの記事のみ。タイトルに一意のMarker（`af-it-<timestamp>`）を含め、`afterAll` で**このRunが作成したファイル名だけ**を削除する（Directory単位の削除はしない）
- `create` → `get` → `append` → `get` で元の本文と追記が残る。ファイルがUTF-8・LF・Frontmatterなしで書かれている
- 同日に別タイトルの記事を作成できる。同名の2回目は失敗し、既存内容が不変
- Knowledge Directoryのファイル一覧（名前とmtime）がTestの前後で不変
- Knowledge IDで `lifelog_get` → `InputValidationError`、存在しない記事名 → `NotFoundError`

### 17.2 手動Verification（記録のみ）

- Obsidianで作成された記事が表示され、Obsidianで編集した内容が `lifelog_get` に反映される
- Obsidianで手動作成した規則どおりの名前の記事を、ファイル名から作ったIDで取得・追記できる（§6.3）
- Obsidianで記事を開いたまま `lifelog_append` → Obsidian側に追記が反映される（§10.3の制約の確認）
- Google Drive for desktopの同期フォルダ上のVaultで作成・追記できる（同期はAI Foundationの責務外）

---

## 18. README

- Source of Truth表に `Life Log | Obsidian`、Tool一覧に `lifelog_*` 3件
- 「Life Log」節:
  1. Vault内に `AI Foundation/LifeLog` を手動で作成する（自動作成しない）。`knowledge_dir` の内側・外側（包含関係）には置けない
  2. `sources.lifelog.obsidian.directory` を設定する（`config.yaml` に既定値あり）。Vaultは `sources.knowledge.obsidian.vault_path` を使う
  3. ファイル名は `YYYY-MM-DD-<title>.md`。危険文字の置換はKnowledgeと同じ。同名は上書きせずError
  4. 一覧・検索Toolはない。IDは `lifelog:<ファイル名>`。`lifelog_create` が返したIDか、Obsidianで確認した**正確なファイル名**で取得・追記する。どちらも分からない記事はAI Foundationからは取得できない
  5. Obsidianで手動作成した記事も、設定Directory直下で `YYYY-MM-DD-<タイトル>.md` の規則に合えば取得・追記できる（規則外の名前は対象外）。将来の移行でもこの規則が参照の前提になる
  6. MVPの制約:
     - 同時追記の順序は保証しない。複数プロセスから同時に大きな内容を追記した場合、追記内容が混ざることがあり得る（既存本文は消えない）
     - 追記の書き込み途中で失敗した場合（ディスク容量不足・同期ソフトのロック等）、末尾に追記内容の一部だけが残ることがある。Obsidianで確認・修正する
     - Obsidianで開いたまま未保存の編集がある記事へ追記した場合、Obsidian側の保存で追記が失われることがあり得る（AI Foundationからは検知できない）
     - 大文字小文字だけが異なるタイトルは、Windows / macOSでは同名扱いになる
  7. 画像・動画は外部ストレージのURLを本文に書く。Project / Area / Knowledgeへの参照はIDやURLを任意に書いてよい（自動の紐付けはしない）

---

## 19. LLM Client Verification

Claude Codeから以下を依頼し、Tool選択と出力を記録する。

- 「今日（日付指定）東京散策に行った記録を残して」→ `lifelog_create`（`knowledge_create` ではない）
- 続けて「さっきの記録に夕食のことを追記して」→ 返ったidで `lifelog_append`
- 「2026-10-03-東京散策.md を見せて」→ `lifelog:2026-10-03-東京散策.md` で `lifelog_get`
- 「分散システムで学んだことをまとめて保存して」→ `knowledge_create`（Life Logではない）

---

## 20. Acceptance Criteriaとの対応

| AC（Issue #14 本文 / v0.2） | 対応 |
|---|---|
| 任意の日付・タイトル・本文からMarkdown記事を新規作成できる | `lifelog_create`（§7、§10.2）、§16.4 |
| 既存記事を取得できる | `lifelog_get`、§16.4 |
| 既存記事へ追記でき、元の本文が失われない | `lifelog_append`（`O_APPEND` のみ）、§10.3、§16.4 |
| 同日に複数の異なる記事を保存できる | ファイル名 `YYYY-MM-DD-<title>.md`（§6.1）、§16.4 |
| Knowledgeと独立した領域に保存され、既存Knowledgeを変更しない | 別Directory・別ID・重なりの拒否（§8.1、Q7）、§16.4「Knowledgeとの独立」、§16.6、§17.1 |
| ファイル未存在・同名記事・（v0.2: Filesystem）エラー時の挙動が定義・テストされている | §11、§16.4（Issue本文の「Drive APIエラー」はv0.2により「Filesystemエラー」と読み替える） |
| 同名は上書きしない（原子的な排他作成） | `O_CREAT \| O_EXCL`、同時作成Test（§10.3、§16.4） |
| Directory外のget/append不可、シンボリックリンク・悪意あるパスの拒否 | §6.2、§9.3、§16.3、§16.4 |
| 存在しない記事、ファイル名の不正/競合、権限エラー | §11、§16.4 |
| 日付は `YYYY-MM-DD`（実在日チェック） | `DateSchema`、§16.2 |
| `sources.lifelog` Optional、未設定でも既存Server/Toolは動作 | §8.2、§16.5 |
| Directoryを自動作成しない・Vault全体を走査しない | §2 方針8、§16.4 |
| Fake/Temp VaultでAutomated Test、実VaultのIntegrationはテスト用領域のみ | §16.1、§17.1 |
| Knowledge全既存テスト・Area/Project等の回帰 | §16.6 |
| README・全体仕様書の更新 | §14.3、§18 |
| 一覧・検索・削除・タグ・自動Knowledge化・Google Drive移行はMVP外 | Toolを3件に限定（§7）、§13 |
| 追記の競合保証の範囲が正確に定義されている（Review指摘1） | §10.3「`O_APPEND` が保証すること・しないこと」、§16.4（条件付きの同時追記・書き込み失敗）、§18 |
| Knowledgeのdecode挙動が変わらず、Life Logだけ厳格・作成/追記後のUTF-8が完全（Review指摘2） | §4.2、§4.3、§16.4「UTF-8の完全性」、§16.6 |
| Obsidianで手動作成した規則どおりの記事を取得・追記できる（Review指摘3） | §6.3、§16.4「手動作成の記事」、§17.2、§18 |

---

## 21. 懸念点 / 未確定事項

PR #20 のPlan Review（rev.1）でQ1〜Q10はすべて **採用**（rev.2）。各Qの末尾に決定を記す。

### Q1. Configの形を `sources.lifelog.obsidian.directory` にする（採用）

- 提案: v0.2の設定案（`provider` と `directory` を `sources.lifelog` 直下に置く）を、既存の `sources.knowledge.obsidian.*` / `sources.area.notion.*` に揃えてProvider名の下へ入れる。将来 `provider: google_drive` のとき `google_drive: { folder_id }` を並べられ、Provider固有の値が混ざらない。
- 代替: v0.2の案どおり `sources.lifelog.directory`（Drive移行時は `directory` をobsidian専用Keyとして扱うか、Keyを移す）。
- 決定（rev.2）: 提案どおり。Provider固有の設定を分離する。

### Q2. IDを `lifelog:<ファイル名>`（Life Log Directory相対）にする（採用）

- 提案: v0.2の優先候補「`lifelog:<LifeLogルート以下の相対Markdownパス>`」を採用し、MVPでは直下のみなのでファイル名1つになる。Vault内の位置（`AI Foundation/LifeLog`）を含めないため、Directoryの移動でIDが変わらず、Google Driveへの移行でもファイル名規則を保てばIDを維持しやすい。`external_ref` はVault相対パス（Knowledgeと同じ形）。
- 代替: Knowledgeと同じVault相対パス（`lifelog:AI Foundation/LifeLog/2026-….md`）。Directory変更・移行でIDが変わる。
- 帰結: Obsidianでファイル名を変更するとIDも変わる（Knowledgeと同じ）。
- 決定（rev.2）: 提案どおり。直下1階層のみ許可する。移行でIDを維持するには同名ファイルの扱い・対応付けを含む移行規則が必要なため、**完全な移行互換を現時点で保証する表現は使わない**（§2 方針5、§13を修正）。

### Q3. 返却する `title` はファイル名から得た値（無害化後）にする（採用）

- 背景: Frontmatterを使わないため、取得時のタイトルの情報源はファイル名だけになる。
- 提案: `create` も `get` もファイル名から `title` を返し、同じ記事で両Toolの結果を一致させる（`東京:散策` で作成すると `title: "東京 散策"`）。
- 代替: `create` だけ入力どおりのtitleを返す（同じ記事で値がずれる）。
- 決定（rev.2）: 提案どおり。

### Q4. 本文は加工せず保存し、取得はファイル全文を返す（採用）

- 提案: 作成時に見出し（`# title`）・日付・Frontmatterを付け足さない（v0.2「呼出元LLMが整える」「Frontmatterなし」）。改行はLFへ正規化し末尾改行を保証する（Knowledgeと同じ）。取得はファイル全文（ユーザーがObsidianでFrontmatterを足した場合もそのまま）を `content` に返す。
- 代替: 本文先頭に `# <title>` を自動挿入する（Obsidianでの見た目は良いが、LLMが本文に見出しを書くと重複する）。
- 決定（rev.2）: 提案どおり。改行のLF正規化・末尾改行の追加（追記時は既存の改行コードへの統一と段落区切り）は**例外**として明示する（§10.2）。

### Q5. 非UTF-8の記事はLife Logだけ厳格にErrorにする（採用）

- 背景: 現行Knowledgeは `readFile(…, 'utf8')` で不正byteをU+FFFDへ置換して読む。v0.1/v0.2はLife Logの「UTF-8・破損ファイル」の検証を求めている。
- 提案: Life Logは `TextDecoder({ fatal: true })` で読み、非UTF-8は `ProviderApiError`（取得も追記もしない）。Knowledgeの挙動は変えない（後方互換を優先。必要なら別Issue）。
- 代替: Knowledgeと同じLenient decode（置換文字を含む本文を返し、追記もする）。
- 決定（rev.2）: 提案どおり。共通コアはdecodeせず、Knowledgeの挙動が変わらないことをTestで固定する（§4.2、§4.3）。

### Q6. 追記の競合はロックせず、append-onlyで「上書きしない」を保証する（採用）

- 提案: §10.3のとおり。`O_APPEND` のみでtruncate / renameをしないので、AI Foundationの書き込みが既存内容を消すことはない。区切りの空行の数が競合時にずれ得ること、Obsidianが古い内容で保存し直す場合はAI Foundationから検知できないことはMVP制約としてREADMEに書く。
- 代替: 読み込み時のmtime / sizeを追記直前に比較し、変化していたら `ProviderApiError` で中止する（区切りのずれは防げるが、Filesystem上で比較と追記を原子的にできないため完全ではなく、Obsidianの保存し直しも防げない）。
- 決定（rev.2）: 提案どおり `O_APPEND` のみ。Obsidianの未保存編集による上書きを防げないことをREADMEに明記する。保証範囲は §10.3 で正確化した（追記テキスト全体の不可分性は保証しない、書き込み失敗時の部分追記）。

### Q7. Life Log DirectoryとKnowledge Directoryの重なりを起動時に拒否する（採用・条件付き）

- 背景: `knowledge_search` はサブフォルダを再帰検索する。Life LogをKnowledge Directoryの内側に置くと、Life Log記事がKnowledgeとして検索・追記対象になり「独立した領域」（AC）に反する。逆（Knowledge DirectoryがLife Log Directoryの内側）は実害は小さいが、構成として紛らわしい。
- 提案: 同一・包含関係を `ConfigError` にする（大文字小文字を無視。Windows / macOSのFilesystemに合わせる）。
- 代替: 内側だけ拒否する / 判定しない（READMEの注意のみ）。
- 決定（rev.2）: 提案どおり同一・包含を拒否する。ただし既存設定に影響を出さないよう、**`sources.lifelog`（または `directory`）が未設定のときは現行と同じ挙動**にする（判定しない。§8.1、§16.2）。

### Q8. Instructions・仕様書への反映（採用）

- `src/instructions.ts` に以下を追記したい（Areas Q6と同じ扱い）。

  ```text
  Life Log:
  Occasional personal events such as trips, outings and events, kept as free-form Markdown articles.
  Source of Truth: Obsidian.
  ```

- `docs/specs/lifelog.md` を新規作成し（Issue #14本文 + v0.2 + 本Planで確定したQ）、`docs/specs/mvp-v0.1.md` 末尾に追補節（§23）を追加する。既存節は書き換えない。
- `AGENTS.md` のSource of Truth表に `LifeLog | Obsidian` を追加するか（Areasでは追加していない）。提案: 追加しない（Areasと揃え、MVP仕様の追補とREADMEで示す）。
- 決定（rev.2）: `instructions.ts`、`docs/specs/lifelog.md`、MVP仕様の追補を更新する。`AGENTS.md` の更新は今回必須としない。

### Q9. 一覧・検索なしでの記事の特定方法（採用）

- 背景: v0.2は3 Tool MVP（一覧・検索なし）。作成直後以外は、LLMがidを得る手段がない。
- 提案: IDをファイル名から決まる形式にし（Q2）、Tool descriptionでその形式を明示する。ユーザーがObsidianで見たファイル名を伝えれば `lifelog_get` / `append` できる。存在しなければ `NotFoundError` なので、推測した名前で誤った記事を書き換えることはない（追記は存在する記事のみ）。
- 代替: 形式をdescriptionに書かず「作成時のidのみを使う」と案内する。
- 決定（rev.2）: 一覧・検索なしの3 Tool。`lifelog_create` が返したID、またはObsidianで確認した正確なファイル名で取得・追記する。**ユーザーにIDもファイル名も分からない場合は取得できない**という制約をTool description（§7）とREADME（§18）に明記する。

### Q10. 大文字小文字・Unicode正規化の違いによる同名判定（採用）

- 事実: 同名判定はOSの排他作成に任せるため、Windows / macOS（大文字小文字を区別しない）では `Tokyo` と `tokyo` が同名としてErrorになり、Linuxでは別記事になる。macOSではファイル名がNFDで保存されることがある。
- 提案: MVPではOSの挙動に従い、正規化・独自の重複検査をしない（READMEに記載）。
- 代替: 作成前にDirectoryを列挙して正規化後の名前で重複を検査する（v0.2「Vaultを走査しない」には反しないがRequestが増え、列挙と作成の間の競合は残る）。
- 決定（rev.2）: 提案どおりOSの同名判定に従う。独自の重複Indexは作らない。

### その他

- Issue本文の保存例は `LifeLog/2026/…`（年別）だが、v0.2で「年別ディレクトリは作らない」と確定しているため直下に保存する。
- 記事の削除・名前変更・タイトル変更はToolを提供しない。Obsidianで行う。
- Life Logは `defaults.area`（work / personal）を持たない（v0.2のDomainにない）。

---

## 22. Review対応履歴

### rev.2（PR #20 レビュー反映）

判定: 設計方針は承認相当。Q1〜Q10はすべて採用（§21。Q2・Q4・Q6・Q7・Q9は決定に条件・補足あり）。

| 指摘 | 対応 |
|---|---|
| Q2: 完全な移行互換を現時点で保証する表現を避ける | §2 方針5、§13（データ移行の行と「IDの互換性について」）、Q2を修正 |
| Q4: LF正規化・末尾改行の追加を例外として明示 | §10.2、Q4 |
| Q7: Life Log未設定時は現行と同じ挙動 | §16.2（既存設定が現行と同じ結果になるTest）、Q7 |
| Q9: IDが不明な場合は取得不能という制約を明示 | §7（`lifelog_get` のdescription）、§18、Q9 |
| 1. `O_APPEND` の競合保証を正確に。任意サイズ・複数プロセスでの全体原子性は保証しない。書き込み失敗時の部分追記 | §10.3 に「`O_APPEND` が保証すること・しないこと」と書き込み失敗の行を追加。§16.4 の同時追記Testを「同一プロセス・小さいテキストでの条件付き検証」と位置付け、書き込み失敗のTestを追加。§18 のMVP制約に追記 |
| 2. 共通コアのBuffer化でKnowledgeのBOM除去・Lenient decode・Messageが変わらないことを既存Test無変更で固定。Life Logのみfatal decode。作成・追記後のUTF-8の完全性もテスト | §4.2（共通コアはdecodeしない、`read` の分岐は現行どおり）、§4.3（Knowledge Adapterのdecode手順。既存Test無変更 + 新規 `filesystem-storage-decoding.test.ts`）、§14.2、§16.4「UTF-8の完全性」、§16.6 |
| 3. Obsidianで手動作成した規則どおりの記事も取得・追記可能と明示。移行時もファイル名規則が参照互換の前提 | §6.3 を新設。§13、§16.4「手動作成の記事」、§17.2、§18 に反映 |

---

## 23. 実装で確定した事項

実装Branch: `feat/lifelog`（Base: `main` の `492bf4c`、PR #20 Merge後）。§15の順に、手順ごとにCommitした（手順2の共通化リファクタリングは単独Commit `fa0d837`）。

### 23.1 Verification結果（2026-10-24）

| 項目 | 結果 |
|---|---|
| 手順2の完了条件 | リファクタリング後、既存Test（46 files / 1089 passed / 4 skipped）が**Testファイル無変更で**成功 |
| Knowledgeの文字コード挙動 | 新規 `filesystem-storage-decoding.test.ts` を、リファクタリング前のソースに対しても実行して成功することを確認（変更前の挙動を固定していることの確認） |
| `npm run typecheck` | 成功 |
| `npm test` | 成功（53 files / 1233 passed / 5 skipped。skipはWindowsで開発者モードがないため作れないFile symlinkのTestで、Life Log分の1件を含む。Directory Junctionの境界Testは実行している） |
| `npm run build` | 成功 |
| Integration Test（`tests/integration/obsidian-lifelog.integration.test.ts`） | 5件成功（実Vault、Userが作成した空の `AI Foundation/LifeLog`）。作成→取得→追記、UTF-8・LF・Frontmatterなし、同日別記事、同名拒否で既存不変、Knowledge IDの拒否・存在しない記事のNotFound、Knowledge Directoryのファイル一覧とmtimeが不変。終了後のLife Log Directoryは空（作成した記事だけを削除）。Knowledgeの既存Integration Test（`obsidian.integration.test.ts`、5件）も同時に実行して成功。既定（`AI_FOUNDATION_INTEGRATION` なし）でskipされることも確認済み |
| 手動Verification（§17.2）/ LLM Client Verification（§19） | 未実施（MCP Serverを本Branchの `dist` で再接続して実施する） |

### 23.2 Planからの細部の変更・Plan外の変更（Implementation Reviewで確認してほしい点）

| 箇所 | 内容 |
|---|---|
| `vault-directory.ts` | Markdownファイル名の判定（再帰 `list` 用）を、Knowledge固有名の `isKnowledgeFileName` ではなくModule内の `isMarkdownFileName`（同じ条件）にした |
| `filesystem-storage.ts` | `segmentsBelow` は `knowledge_dir` 未設定時に `''` を基準に計算するが、`FilesystemVaultDirectory` が先に `ConfigurationError` を投げるため使われない（コメントで明記） |
| `filename.ts` | 上限値を `MAX_FILE_NAME_BYTES` としてexportした（値・Messageは同一） |
| `lifelog-id.ts` | 200 byteの上限は、Knowledgeと同じく**拡張子を除いた**ファイル名（日付を含む）で判定する（§6.1の「ファイル名全体」を、Knowledgeの測り方に合わせた）。超過時のMessageは `…(over 200 bytes with the date)…` |
| `lifelog-id.ts` | IDのMessageは `use the id returned by lifelog_create or "lifelog:" followed by the exact file name`（Q9の参照方法に合わせた） |
| `lifelog-storage.ts` | `LifeLogFile` から `ref` を除いた（`external_ref` は `refOf(name)` だけで作るため） |
| `filesystem-lifelog-storage.ts` | `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })` でdecodeしたうえでBOMを除去する |
| `lifelog-connector.ts` | `get` / `append` はIDの検証を `directory` 未設定の確認より先に行う（不正なIDは設定に関係なく `InputValidationError`） |
| `config/schema.ts` | 重なりの判定はsourcesをまたぐため、`ConfigObjectSchema`（従来の `ConfigSchema` の中身）に `.refine` をかけたものを `ConfigSchema` としてexportした（既存部分の差分を小さくするため） |
| `vault-directory.test.ts` | 権限Errorの変換（§16.4「権限」）は、`node:fs/promises` の `readFile` / `open` を `vi.mock` で包み、`EACCES` / `EPERM` / `EBUSY` を投げてMessage（errno codeのみ・絶対パスなし）と `cause` を確認した。POSIXの `chmod` Testは追加していない（OSに依存せず同じ経路を検証できるため） |
| `lifelog-connector.test.ts` | 「外部編集との共存」「追記の書き込み失敗」は、実Storageを包む `LifeLogStorage` で読み込みと追記の間の書き込み・追記の失敗を再現した |
| `tests/helpers/vault.ts` | 一時Vaultに `AI Foundation/LifeLog` も作るようにした（既存Testへの影響なし） |
| e2e | Repositoryの `config.yaml`（`vault_path` なし）で `lifelog_create` が `vault_path is not set`、Knowledge IDの `lifelog_get` が `must start with "lifelog:"` になるCaseを追加 |

### 23.3 Implementation Review（PR #21、Codex）

| 指摘 | 対応 |
|---|---|
| [P2] NTFSの8.3短縮名（`KNOWLE~1`）でKnowledge / Life Logのディレクトリ重複判定（Configの文字列比較）を回避でき、`lifelog_create` がKnowledge Directoryへ書き込めた | `FilesystemVaultDirectory` に `apartFrom` を追加し、Directoryの解決時（毎回のTool呼び出し）に相手Directoryの**実パス**（`realpath` は短縮名・大文字小文字を実際の名前へ解決する）と同一・包含関係を確認して `ConfigurationError` にした。Life Log Storageは `knowledge_dir`、Knowledge Storageは `sources.lifelog.obsidian.directory` を受け取り、**両方向**で確認する（短縮名でLife LogをKnowledgeの内側に置くと `knowledge_search` に混ざるため）。相手が未設定・不在なら判定しない。Configの文字列比較（起動時）はそのまま残す |
| [P2] 記事IDにNTFSの代替データストリーム構文（`lifelog:2026-10-24-private.txt:notes.md`）を指定でき、`.txt` のストリームを取得・追記できた | `parseLifeLogId` で `:` を全OSで拒否（新規作成のファイル名に `:` は含まれない）。加えて、**Knowledgeにも同じ穴があった**（`obsidian:…/private.txt:notes.md`）ため、共通の `FilesystemVaultDirectory` でWindowsでは `:` を含むSegmentを `InputValidationError` にした（Knowledgeの変更はWindowsの `:` を含むパスのみ。macOS / Linuxの `:` を含むKnowledgeファイルの扱いは変えない） |

回帰Test（11件）を追加し、修正前のソースでは11件すべてが失敗し、修正後は成功することを確認した。

- `lifelog-id.test.ts`: `:` を含むID（ADS・`::$DATA`・通常名）の拒否
- `filesystem-lifelog-storage.test.ts`: 8.3短縮名で同一 / 内側、大文字小文字違い、包含のDirectoryを拒否し、Knowledge Directoryが変わらない。隣接・未設定・不在なら動作する。ADSの読み書き・作成を拒否し、ストリームが変わらない（Windowsのみ）
- `filesystem-storage.test.ts`（Knowledge）: 同じ確認を逆方向で行う。ADSの拒否（Windowsのみ）
- `lifelog-connector.test.ts`: ADSのIDで `get` / `append` が入力Errorになりストリームが変わらない（Windowsのみ）
- 8.3短縮名・大文字小文字のTestは、その別名が実際に使えるFilesystemでのみ実行する（この環境では実行された）

修正後: `npm test` 53 files / 1246 passed / 5 skipped、`npm run build` 成功、実VaultのIntegration Test（Life Log 5件・Knowledge 5件）成功。

再レビュー（対象 `3af403c`）: 2件とも解消を確認、新たな修正必須の指摘なし。Codexは実際の8.3短縮名 `KNOWLE~1` による拒否6ケース（Life Logの作成・取得・追記、Knowledgeの検索、双方の包含関係）と、ADSの拒否8ケース（Life Log Connectorのget / append、両Storageのread / append / createExclusive）を一時Vaultで確認し、既存Knowledge本文・NTFSストリームが変わらないことを確認した。
