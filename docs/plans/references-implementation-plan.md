# Google Sheets Reference — Implementation Plan

- Status: **Plan（未実装）**
- 作成: Coding Agent (Claude Code) / 2026-10-25
- 対象: [Issue #16 Google スプレッドシートを外部 Reference として登録できるようにする（MVP）](https://github.com/thanatos27/ai-foundation/issues/16)（本文 + コメント「MVP設計整理」）
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md)（**変更しない**）, [Phase 4 Design Issue](../specs/phase-4-knowledge.md), [Areas Design](../specs/areas.md), [Life Log Design](../specs/lifelog.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

保存方式の比較と選定理由は§3、Reference Fileの形式とIDは§6、登録時の参照元Entity確認は§8、重複登録の扱いは§7.4・§8、URL検証は§5.2で扱う。設計判断の理由は [§17 懸念点 / 未確定事項](#17-懸念点--未確定事項) にまとめる。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/references-implementation-plan`。Baseは `main` の `c9d6f1b` |
| 依存 | `yaml ^2.9.1`、`zod 4.6`、Node `>=24`。**追加依存なし**（`node:crypto` の `createHash` のみ追加利用） |
| 公開Tool | 21件 → **23件**（`reference_add` / `reference_list` を追加） |
| OAuth Scope / Credential | **変更しない**（Google Sheets APIもDrive APIも呼ばない） |
| CI | なし（`npm test` をローカルのWindows環境で実行） |

### 既存実装の要点（本Issueで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/domain/common.ts` | `OptionalMetadataShape.external_ref`（`string \| null`）。各Entityの `external_ref` は**そのEntity自身の所在**（Obsidianのパス、GitHub URL、Notion URL等）を表す1値で、関連資料のリストではない |
| `src/domain/knowledge.ts` / `project.ts` / `area-resource.ts` | `Knowledge`（`id: obsidian:<vault-relative-path>`）、`Project`（`id: github:<owner>/<repository>`）、`AreaResource`（`id: notion:<page-id>`）。3つとも `external_ref: string` を持つ |
| `src/connectors/types.ts` | `KnowledgeConnector`（create / search / get / append）、`ProjectConnector`（list / get、read-only）、`AreaConnector`（list / get、read-only） |
| `src/connectors/obsidian/vault-directory.ts` | `FilesystemVaultDirectory`。Vault相対Directory 1つだけを境界とし、`list`（再帰、Linkを辿らない）/ `read` / `createExclusive`（既存なら `alreadyExists`、上書きしない）/ `append`。`apartFrom` で他Directoryとの重なりを実パスで拒否する |
| `src/connectors/obsidian/filesystem-lifelog-storage.ts` | Life Log用Storage。`FilesystemVaultDirectory` をLife Log Directoryに向け、UTF-8をstrictにdecodeする。`apartFrom: knowledge_dir` |
| `src/connectors/obsidian/filesystem-storage.ts` | Knowledge用Storage。`apartFrom: lifelog directory` |
| `src/connectors/obsidian/markdown.ts` | Knowledgeのfrontmatter（`---` 区切りYAML）の分割・解析。`yaml` の `parseDocument(…, { uniqueKeys: true })` |
| `src/connectors/notion/id.ts` | `parseNotionPageId` / `formatNotionId` / `sameNotionId`（ハイフン・大小文字を無視して比較） |
| `src/config/schema.ts` | `sources.lifelog`（optional、`VaultRelativeDirSchema`）と、`knowledge_dir` との重なりを拒否する `ConfigSchema.refine`（`dirsOverlap`） |
| `src/tools/*.ts` | Entityごとに `register<Entity>Tools`。Connector未設定でもToolは登録し、呼び出し時に `ConfigurationError` |
| `src/instructions.ts` | 初期化時にAI Clientへ送るEntityとSource of Truthの一覧 |
| `tests/helpers/vault.ts` | 一時Vault（`KNOWLEDGE_DIR` / `LIFELOG_DIR`）、`linkDirectory` / `linkFile` |
| `tests/helpers/fake-connectors.ts` | Entity別のFake Connector |

3 Entityに共通する書き込み可能なReferenceモデルは存在しない。Project（GitHub）とArea（Notion）は毎回Providerから取得するread-onlyで、AI Foundationは本体へ書き込まない。

---

## 2. 設計方針

1. **Referenceは「参照元Entityと外部文書URLの紐付け」を表す小さなメタデータとする。** `{ type: 'google_sheets', title, url }` と参照元Entity（種別 + ID）だけを持ち、シートの内容・権限・存在は扱わない。
2. **既存の `external_ref` は変更しない。** 各Entityの `external_ref` の意味・型・値、および `knowledge_get` / `project_get` / `area_get` 等の既存Toolの入出力は変えない。Referenceは別Toolで登録・一覧する。
3. **保存先は既存のSource of Truth（Obsidian Vault）の1 Directory。** 新しいDatabase、Notion Data Source、Google Sheets用Connector・保存先は作らない。Life Logと同じ `FilesystemVaultDirectory` の境界規則で読み書きする（§3）。
4. **GitHub / Notion本体は書き換えない。** Project / Areaへの紐付けはVault側のReference Fileが参照元IDを持つことで表し、Repository・Notion Pageには何も書かない。
5. **Google Sheets固有の処理はURL書式の確認だけ。** Reference Typeは列挙型で識別し、Type別に異なるのはURL検証規則のみとする。将来のType追加は列挙値と検証規則の追加で済む形にする。
6. **既存の本文中のリンクは移行・自動登録しない。** Referenceは `reference_add` で明示的に登録したものだけ。

---

## 3. 保存方式の比較

| 案 | 内容 | Knowledge | Project | Area | 判定 |
|---|---|---|---|---|---|
| A. 各Entity本体に書く | Knowledgeのfrontmatterに `references:`、Notion目次Pageにリンク追記、GitHubはREADME等 | 可 | **不可**（read-only・GitHubへ書かない） | Notionへの書き込みが必要（read-onlyを破る） | 不採用。3 Entityで同じ操作にならない |
| B. 本文のリンクを一覧APIで抽出 | Knowledge本文・Notion目次のURLを解析して返す | 可 | 不可 | 可 | 不採用。登録操作がなく、タイトル・Typeを保持できない |
| C. 新規Database / Notion Data Source | Reference用のDB・Data Sourceを新設 | 可 | 可 | 可 | 不採用。独自Database・新しい保存先を増やす |
| **D. Vault内のReference Directory** | `sources.reference.obsidian.directory` 直下に1 Reference = 1 Markdown file（frontmatterのみ）。参照元はfrontmatterの `target_type` / `target_id` | 可 | 可（本体を書き換えない） | 可（本体を書き換えない） | **採用** |

案Dの理由:

- Life Logで実績のある `FilesystemVaultDirectory`（Link拒否・Directory外への書き込み不可・排他作成）をそのまま使え、パストラバーサル・上書きの防止を新たに実装しない。
- ファイル名を参照元とURLから決定的に作る（§6.2）ため、排他作成だけで重複登録を検出できる。
- 利用者はObsidianでReferenceを確認・削除でき、AI Foundation自身が見えない正本を持たない。
- Project / Areaの取得処理（GitHub / Notion Connector）には一切手を入れない。

Reference FileはVault内のファイルだが、KnowledgeでもLife Logでもない。`knowledge_dir` / Life Log Directoryとは重ならない別Directoryに置き、`knowledge_search` の結果に混ざらないようにする（§4）。

---

## 4. Configuration（`src/config/schema.ts`）

```yaml
sources:
  reference:
    # External document links (MVP: Google Sheets) registered to knowledge, projects and areas,
    # one file per link directly in this directory (see README "References").
    # The vault is sources.knowledge.obsidian.vault_path. Create the directory yourself;
    # it must not be the same as, inside or contain knowledge_dir or the life log directory.
    provider: obsidian
    obsidian:
      directory: "AI Foundation/References"
```

```ts
export const ReferenceSourceSchema = z.enum(['obsidian']); // src/domain/reference.ts

reference: z
  .strictObject({
    provider: ReferenceSourceSchema,
    obsidian: z.strictObject({ directory: VaultRelativeDirSchema.optional() }).optional(),
  })
  .optional(),
```

| # | 規則 | Error |
|---|---|---|
| C1 | `sources.reference` は省略可。省略時もServerは起動し、Reference Toolは `ConfigurationError`（`sources.reference.obsidian.directory is not set`） | — |
| C2 | `directory` は `VaultRelativeDirSchema`（Life Logと同じ） | 既存のmessage |
| C3 | `directory` が `knowledge_dir` と同じ・内側・外側なら拒否 | `sources.reference.obsidian.directory: must not be the same as, inside or contain sources.knowledge.obsidian.knowledge_dir` |
| C4 | `directory` がLife Log Directoryと同じ・内側・外側なら拒否 | `sources.reference.obsidian.directory: must not be the same as, inside or contain sources.lifelog.obsidian.directory` |

C3 / C4は既存の `ConfigSchema.refine`（`dirsOverlap`）と同じ方法で、`.refine` を2つ追加する。実パスでの重なり（大文字小文字違い、8.3短縮名）はStorageの `apartFrom` で確認する（§7.1）。Directoryは自動作成しない。

`config.yaml` には上記の `sources.reference` を追加する（Directory名は個人情報ではないため、`sources.lifelog` と同様にcommitする）。

---

## 5. Domain（`src/domain/reference.ts`、新規）

### 5.1 Schema

```ts
/** Kinds of external document a reference points to. Each kind has its own URL rule (§5.2). */
export const ReferenceTypeSchema = z.enum(['google_sheets']);

/** Entities a reference can be registered to. */
export const ReferenceTargetTypeSchema = z.enum(['knowledge', 'project', 'area']);

/** A registered link from an entity to an external document. Source of Truth: Obsidian. */
export const ReferenceSchema = z.object({
  id: z.string().min(1),                 // `reference:<file name>`（§6.2）
  type: ReferenceTypeSchema,
  title: z.string().min(1),
  url: z.string().min(1),                // 登録時の原文
  target_type: ReferenceTargetTypeSchema,
  target_id: z.string().min(1),          // 参照元EntityのID（§8で正規化済み）
  source: ReferenceSourceSchema,         // 'obsidian'
  external_ref: z.string().min(1),       // Reference File自身のVault相対パス
});

/** Input of `reference_add`. */
export const ReferenceAddInputSchema = z
  .strictObject({
    target_type: ReferenceTargetTypeSchema,
    target_id: z.string().min(1),
    type: ReferenceTypeSchema,
    title: ReferenceTitleSchema,
    url: z.string(),
  })
  .superRefine(checkReferenceUrl);       // type別のURL規則（§5.2）

/** Input of `reference_list`. Every field narrows the result; `{}` lists every reference. */
export const ReferenceListFilterSchema = z
  .strictObject({
    target_type: ReferenceTargetTypeSchema.optional(),
    target_id: z.string().min(1).optional(),
    type: ReferenceTypeSchema.optional(),
  })
  .refine((f) => f.target_id === undefined || f.target_type !== undefined, {
    message: 'target_id needs target_type',
    path: ['target_id'],
  });

/** `reference_add` result: `created` is false when the same link was already registered. */
export const ReferenceAddResultSchema = z.object({ reference: ReferenceSchema, created: z.boolean() });
```

- `type` はReference Typeを表す（Issueの `{ type: 'google_sheets', title, url }` に合わせる）。参照元のEntity種別は `target_type`。
- `ReferenceTitleSchema`: `NonBlankSchema` + 200文字以下 + 改行・制御文字を含まない。原文のまま保持する（trimしない）。
- `type` は省略不可。Typeが1つでも明示させ、Type追加時に既存呼び出しの意味が変わらないようにする。

### 5.2 URL検証（`google_sheets`）

`checkReferenceUrl` はType別の規則表 `REFERENCE_URL_RULES: Record<ReferenceType, (url: string) => string | undefined>` を引く。`google_sheets` の規則:

| # | 規則 | 例（不可） |
|---|---|---|
| U1 | 2048文字以下、前後の空白・制御文字なし | `" https://docs…"` |
| U2 | `new URL(url)` で解析できる | `docs.google.com/spreadsheets/d/…`（Schemeなし） |
| U3 | `protocol === 'https:'` | `http://docs.google.com/…` |
| U4 | `hostname === 'docs.google.com'`（完全一致）、`port === ''`、`username` / `password` が空 | `https://docs.google.com.example.com/…`、`https://x@docs.google.com/…`、`https://docs.google.com:8443/…`、`https://drive.google.com/…` |
| U5 | `pathname` が `^/spreadsheets/(?:u/\d+/)?d/[A-Za-z0-9_-]{20,}(?:/.*)?$` | `/document/d/…`、`/spreadsheets/`、`/spreadsheets/d/e/2PACX-…/pubhtml`（`e` は20文字未満） |

- Query（`?usp=sharing`）・Fragment（`#gid=0`）・`/edit` 等の後続Pathは許可し、**原文のまま保存・返却**する（正規化・URL再構築をしない）。
- URL先へのアクセス、シートの存在・共有権限の確認はしない。
- U5の文書IDは、Google Sheetsの文書ID（英数字・`_`・`-`、実際は44文字程度）を最低限確認するための下限で、IDの長さの正確な仕様ではない。

---

## 6. Reference File

### 6.1 形式

```markdown
---
reference_type: google_sheets
title: 家計簿 2026
url: https://docs.google.com/spreadsheets/d/1AbC…xyz/edit#gid=0
target_type: knowledge
target_id: obsidian:AI Foundation/Knowledge/家計の見直し.md
---
```

- UTF-8（BOMなし）、改行 `\n`。frontmatterのみで本文は書かない。
- 値は `yaml` の `Document` で書き出す（文字列は必要に応じて引用される。`: `・`#`・引用符を含むタイトルも往復で一致する）。
- 読み取りは `parseDocument(…, { uniqueKeys: true })`。上記5 Keyが揃い、`reference_type` / `target_type` が既知の列挙値で、`url` / `title` がDomainの規則を満たすものだけを有効なReferenceとする。その他のKeyと本文は無視する（利用者がObsidianでメモを足しても壊れない）。
- 無効なfile（frontmatterなし・YAML不正・Key欠落・**未知の `reference_type`**・UTF-8不正）は一覧から除外する。Errorにはせず、書き換えもしない。

### 6.2 ファイル名とID

- ファイル名: `<hash>.md`。`hash` は `sha256(JSON.stringify([target_type, target_id, url]))` の先頭32桁（16進小文字）。`target_id` は§8で正規化した後の値。
- ID: `reference:<ファイル名>`（例: `reference:3f2a…9c1d.md`）。Directoryの場所もProvider固有IDも含まない（Life Logと同じ考え方）。
- `external_ref`: `<directory>/<ファイル名>`（Vault相対パス）。利用者がObsidianで探す・削除するための所在。
- 同じ参照元 + 同じURLは常に同じファイル名になり、排他作成で重複を検出できる。ファイル名は入力から機械的に計算するだけで、入力の文字列をパスに使わない（パストラバーサルの余地がない）。

---

## 7. Connector（`src/connectors/obsidian/`）

### 7.1 Storage

`reference-storage.ts`（Interface）と `filesystem-reference-storage.ts`（実装）。Life Log Storageと同じ構成:

```ts
export interface ReferenceStorage {
  refOf(name: string): string;
  /** File names directly in the directory (subdirectories are not read). */
  list(): Promise<string[]>;
  /** NotFoundError when no regular file is there; ProviderApiError when it is not valid UTF-8. */
  read(name: string): Promise<{ name: string; text: string }>;
  /** InputValidationError when anything already has that name. Never overwrites. */
  createExclusive(name: string, text: string): Promise<void>;
}
```

- `FilesystemVaultDirectory`（`dirConfigKey: 'sources.reference.obsidian.directory'`、`dirName: 'reference directory'`）。
- `apartFrom: [knowledge_dir, life log directory]`。
- `list` は `directory.list()` の結果のうち `segments.length === 1` だけを返す。
- `append` は持たない（Referenceを変更するToolはない）。

既存Storageへの追加: `FilesystemVaultStorage`（Knowledge）と `FilesystemLifeLogStorage` の `apartFrom` に `reference directory` を加える。Config文字列では検出できない重なり（大文字小文字違い・8.3短縮名）でも、Knowledge / Life Log Toolが Reference Fileを読み書きしないようにするため。`sources.reference` 未設定時は `dir: undefined` で、既存の `apartFrom` と同じく確認対象にならない。

### 7.2 Pure処理

| File | 内容 |
|---|---|
| `reference-id.ts` | `referenceFileName(target_type, target_id, url)`、`formatReferenceId(name)`、`isReferenceFileName(name)`（`^[0-9a-f]{32}\.md$`） |
| `reference-file.ts` | `formatReferenceFile(meta): string`、`parseReferenceFile(text): ReferenceMeta \| undefined`（§6.1） |

`markdown.ts` の frontmatter分割処理（`split`）を共用できるように export する（挙動は変えない）。

### 7.3 `ObsidianReferenceConnector`

```ts
export interface ReferenceConnector {
  /** Registers the link; returns the existing reference (created: false) when it is already there. */
  add(input: ReferenceAdd): Promise<{ reference: Reference; created: boolean }>;
  /** References matching every given filter, sorted by target_type, target_id, title, then id. */
  list(filter: ReferenceListFilter): Promise<Reference[]>;
}

/** `reference_add` input once the tool has confirmed the target and its canonical id (§8). */
export type ReferenceAdd = ReferenceAddInput;
```

`list`:

1. `directory` 未設定なら `ConfigurationError`。
2. `storage.list()` のうち `.md` の各fileを `read` → `parseReferenceFile`。無効は除外（§6.1）。ハッシュ名でない（利用者がObsidianで作成した）fileも、形式が有効なら含める。
3. Filterを適用: `type` / `target_type` は完全一致。`target_id` は完全一致、ただし `target_type: 'area'` のときは `sameNotionId` で比較する（`notion:` のハイフン有無・大小文字の違いを同じページとみなす）。
4. `target_type` → `target_id` → `title`（大小文字無視）→ `id` の順にソート。

`add`:

1. `directory` 未設定なら `ConfigurationError`。
2. `list({ target_type, target_id, type })` の中に同じ `url`（完全一致）があれば、そのReferenceを `created: false` で返す。fileは変更しない（`title` が異なっても更新しない）。
3. なければ `referenceFileName(…)` に `createExclusive`。
4. 3で既に同名fileがある場合（同時実行、または無効な内容の同名file）は、そのfileを読み、有効で同じ参照元・URLなら `created: false` で返す。そうでなければ `InputValidationError`（`reference "<id>" already exists but is not a valid reference for this link; fix or delete it in Obsidian`）。上書きはしない。
5. 作成したReferenceを `created: true` で返す。

### 7.4 Error一覧

| 状況 | Error |
|---|---|
| `sources.reference` / `directory` 未設定 | `ConfigurationError` |
| Vault / Directoryが無い・Link・`knowledge_dir` / Life Log Directoryと実パスで重なる | `ConfigurationError`（`FilesystemVaultDirectory` の既存message） |
| URL / title / target_type / type が不正 | `InputValidationError`（Tool Input Schema） |
| 参照元が存在しない・ID形式が不正 | 各Connectorの `NotFoundError` / `InputValidationError`（§8） |
| 同名fileが無効な内容 | `InputValidationError`（§7.3 手順4） |
| file I/O | `FilesystemVaultDirectory` の既存のErrorに従う（errnoの絶対パスを出さない） |

---

## 8. Tool（`src/tools/reference.ts`、新規）

### 8.1 `reference_add`

handlerは、Reference Connectorへ渡す前に**参照元Entityの存在を既存のread-only操作で確認し、正規のIDに置き換える**。

| `target_type` | 呼ぶ操作 | 正規ID |
|---|---|---|
| `knowledge` | `connectors.knowledge.get(target_id)` | `result.knowledge.id` |
| `project` | `connectors.project.get(target_id)`（`sources.project.providers` に `github` が必要。既存の `project_get` と同じ確認） | `result.project.id`（Rename・Transfer後の現在のID） |
| `area` | `connectors.area.get(target_id)`（`sources.area` が必要） | `result.area.id` |

- 参照元が無い・ID形式が不正なら、そのConnectorのErrorをそのまま返し、Reference Fileは作らない。
- 参照元のConnectorが未設定なら `ConfigurationError`（各Entityの既存Toolと同じmessage）。
- GitHub / Notion / Knowledge Noteへは**書き込まない**（`get` のみ）。
- 確認用の関数 `resolveTarget(target_type, target_id, context)` を `src/tools/reference.ts` に置く。
- annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`（Project / Areaの確認でGitHub / Notionへ接続するため）。
- outputSchema: `ReferenceAddResultSchema`。

description（要旨）:

> Register a link to a Google Sheets spreadsheet (type "google_sheets") for a knowledge note, project or area, so it can be listed later with reference_list. target_id is the exact id from knowledge_search, project_list or area_list; the target must exist. url must be a Google Sheets document URL ("https://docs.google.com/spreadsheets/d/<id>/..."); it is stored and returned as given. The spreadsheet itself is never opened, read or changed, and its existence or sharing is not checked. Registering the same url for the same target again returns the existing reference (created: false) without changing its title. References cannot be edited or removed with a tool; the user deletes the file in Obsidian (external_ref).

### 8.2 `reference_list`

- `ReferenceListFilterSchema`。参照元の存在確認はしない（外部APIを呼ばない）。
- annotations: `readOnlyHint: true, openWorldHint: false`。
- outputSchema: `{ items: Reference[] }`。

description（要旨）:

> List registered references (links to external documents such as Google Sheets). Every filter is optional: target_type and target_id narrow to one knowledge note, project or area (pass the exact id from knowledge_search, project_list or area_list; target_id needs target_type); type narrows to one kind of document. An empty filter lists every reference. Results carry type, title and the url as registered; open the url to see the document — its contents are not available through AI Foundation.

### 8.3 その他

- `src/tools/index.ts` に `registerReferenceTools` を追加。
- `src/connectors/index.ts` で `ObsidianReferenceConnector` を組み立てる（Vaultは `sources.knowledge.obsidian.vault_path`）。`Connectors.reference` を追加。
- `src/instructions.ts` に1項目追加:

```text
Reference:
Links to external documents (currently Google Sheets) registered to a knowledge note, project or area. Only the title and URL are kept; document contents are not read.
Source of Truth: Obsidian.
```

---

## 9. 既存Entityとの関係（変更しないもの）

| 対象 | 扱い |
|---|---|
| `Knowledge` / `Project` / `AreaResource` / `LifeLog` / `Schedule` / `Task` / `CollectionItem` の `external_ref` | 型・値・意味を変えない |
| `knowledge_*` / `project_*` / `area_*` / `lifelog_*` 等の既存Tool | 入出力・descriptionを変えない（Referenceを結果に含めない） |
| GitHub Connector / Notion Area Connector | 変更しない |
| Knowledge Noteの本文・frontmatter、Notion目次Page | 書き換えない。本文中の既存リンクをReferenceへ移行しない |
| `docs/specs/mvp-v0.1.md`、`src/credentials/**`、`.env.example`、OAuth Scope | 変更しない |

変更する既存ファイルは、`src/config/schema.ts`（`sources.reference` とrefine）、`src/connectors/index.ts`、`src/connectors/types.ts`、`src/connectors/obsidian/filesystem-storage.ts` / `filesystem-lifelog-storage.ts`（`apartFrom` 追加）、`src/connectors/obsidian/markdown.ts`（`split` の export）、`src/domain/index.ts`、`src/tools/index.ts`、`src/instructions.ts`、`config.yaml`、README。

---

## 10. 追加・変更予定ファイル

### 10.1 Source

| File | 区分 | 内容 |
|---|---|---|
| `src/domain/reference.ts` | 新規 | §5 |
| `src/domain/index.ts` | 変更 | export追加 |
| `src/config/schema.ts` | 変更 | §4 |
| `src/connectors/types.ts` | 変更 | `ReferenceConnector`、`Connectors.reference` |
| `src/connectors/obsidian/reference-id.ts` | 新規 | §6.2 |
| `src/connectors/obsidian/reference-file.ts` | 新規 | §6.1 |
| `src/connectors/obsidian/reference-storage.ts` | 新規 | §7.1 Interface |
| `src/connectors/obsidian/filesystem-reference-storage.ts` | 新規 | §7.1 実装 |
| `src/connectors/obsidian/reference-connector.ts` | 新規 | §7.3 |
| `src/connectors/obsidian/markdown.ts` | 変更 | `split` を export |
| `src/connectors/obsidian/filesystem-storage.ts` / `filesystem-lifelog-storage.ts` | 変更 | `apartFrom` に reference directory |
| `src/connectors/index.ts` | 変更 | Reference Connectorの組み立て、Knowledge / Life Log Storageへ `referenceDir` を渡す |
| `src/tools/reference.ts` | 新規 | §8 |
| `src/tools/index.ts` | 変更 | 登録 |
| `src/instructions.ts` | 変更 | §8.3 |
| `config.yaml` | 変更 | §4 |

### 10.2 Tests

| File | 区分 |
|---|---|
| `tests/domain/reference.test.ts` | 新規 |
| `tests/config/schema.test.ts` | 変更 |
| `tests/connectors/obsidian/reference-id.test.ts` / `reference-file.test.ts` | 新規 |
| `tests/connectors/obsidian/reference-connector.test.ts` | 新規（一時Vault） |
| `tests/connectors/obsidian/filesystem-storage*.test.ts` / `filesystem-lifelog-storage.test.ts` | 変更（reference directoryとの重なり） |
| `tests/tools/reference.test.ts` | 新規 |
| `tests/helpers/fake-connectors.ts` | 変更（`FakeReferenceConnector`） |
| `tests/helpers/vault.ts` | 変更（`REFERENCE_DIR` を作成） |
| `tests/server.test.ts` / `tests/e2e/stdio.test.ts` | 変更（Tool一覧に2件） |
| `tests/integration/obsidian-reference.integration.test.ts` | 新規（手動起動） |

### 10.3 Documentation

| File | 内容 |
|---|---|
| `docs/specs/references.md` | 新規。Reference Model、保存形式、Tool、URL規則、対象外 |
| `README.md` | Tool一覧、Source of Truth表、「References」節（Directoryの作成、削除方法、制限） |

---

## 11. 実装順序

1. Domain（`reference.ts`）+ Domain Test
2. Config（`sources.reference`、refine）+ Config Test、`config.yaml`
3. `reference-id.ts` / `reference-file.ts`（`markdown.ts` の `split` export）+ Test
4. Storage（`filesystem-reference-storage.ts`）、Knowledge / Life Log Storageの `apartFrom` + Test
5. `ObsidianReferenceConnector` + Connector Test（一時Vault）
6. Tool（`reference.ts`）、`connectors/index.ts`、`tools/index.ts`、`instructions.ts` + Tool Test、Server / e2e Test
7. `npm run typecheck`、`npm test`
8. Integration Test、手動Verification（§13）
9. `docs/specs/references.md`、README

---

## 12. Automated Test

### 12.1 方針

- `npm test` は外部Serviceへ通信しない。Connector Testは `tests/helpers/vault.ts` の一時Vault、Tool TestはFake Connectorを使う。
- Google Sheets / Drive APIはどのTestでも呼ばない（呼ぶ実装が存在しないことを含む）。

### 12.2 Domain（`tests/domain/reference.test.ts`）

- URL可: `/spreadsheets/d/<44文字>`、`/edit`、`/edit#gid=0`、`/edit?usp=sharing`、`/u/0/d/<id>/edit`、`/htmlview`。
- URL不可: U1〜U5の各例（§5.2の表）、`http:`、`drive.google.com`、`docs.google.com/document/d/…`、`docs.google.com.example.com`、userinfo付き、Port付き、前後空白、2049文字、文書ID 19文字、`/d/e/2PACX-…`。
- title: 空白のみ・改行・201文字は不可。日本語・`: `・`#`・引用符は可。
- `type` 省略・未知の `type`（`google_docs`）・未知の `target_type`（`lifelog`）・未知のKeyは不可。
- List Filter: `{}` 可、`target_id` だけは不可、`target_type` だけは可。

### 12.3 Config（`tests/config/schema.test.ts`）

- `sources.reference` なしで有効（既存Fixtureが通る）。
- `directory` が `knowledge_dir` / Life Log Directoryと同じ・内側・外側（大文字小文字違いを含む）で拒否。
- 絶対パス・`..`・`\` を含む `directory` を拒否。未知のKey・`provider: notion` を拒否。

### 12.4 Pure処理（`reference-id.test.ts` / `reference-file.test.ts`）

- 同じ入力は同じファイル名、`target_type` / `target_id` / `url` のどれかが違えば別のファイル名。区切りの曖昧さ（`["a","bc"]` と `["ab","c"]`）で衝突しない。
- `format` → `parse` の往復でtitle / URL（Fragment・Query含む）が完全一致。YAML特殊文字（`: `、`#`、`'`、`"`、`- `、`true`、数字のみ）を含むtitle。
- `parse` が `undefined` を返す: frontmatterなし、閉じていない、YAML不正、重複Key、Key欠落、未知の `reference_type`、未知の `target_type`、URLが規則違反。余分なKey・本文があっても有効。

### 12.5 Connector（`tests/connectors/obsidian/reference-connector.test.ts`）

- `add` がReference Directory直下に `<hash>.md` を1つ作り、内容が§6.1の形式。Directory外（Vault root、`knowledge_dir`、Life Log Directory）に何も作らない。
- 同じ参照元・同じURLの再登録は `created: false`、既存Referenceを返し、fileのbytes・mtimeが変わらない。titleを変えて再登録しても元のtitleのまま。
- 同じURLを `knowledge` / `project` / `area` の3参照元に登録すると3件になり、それぞれの `target_id` で1件ずつ取得できる。同じ参照元に別URLを2件登録すると2件。
- 同名fileが無効な内容で存在する場合、`InputValidationError` で上書きしない。同名fileが有効で同じリンクなら `created: false`。
- `list`: Filterの各組み合わせ、ソート順、`area` の `target_id` をハイフンなし・大文字で渡しても一致、無効file・未知の `reference_type`・サブDirectory内のfile・`.md` 以外を除外、利用者が作成したハッシュ名でない有効fileを含める。
- 設定・境界: `directory` 未設定、Directoryが無い、DirectoryがLink、Reference fileがLink（`canLinkFiles` 時）、`knowledge_dir` と実パスで重なる場合に `ConfigurationError` / 既存Error。
- UTF-8不正のfileは除外される。

### 12.6 Storageの境界（既存Testへの追加）

- `FilesystemVaultStorage` / `FilesystemLifeLogStorage` が、reference directoryと実パスで重なるとき `ConfigurationError`。`referenceDir` 未指定時は従来どおり動く。

### 12.7 Tool Layer（`tests/tools/reference.test.ts`）

- `reference_add` が `target_type` ごとに対応するConnectorの `get` だけを呼び、返った正規ID（Projectは改名後のID、Areaはハイフン付きID）でReference Connectorを呼ぶ。
- 参照元が `NotFoundError` のとき、Reference Connectorの `add` を呼ばない。
- 参照元Connector未設定・`sources.project.providers` に `github` が無い・`sources.area` 未設定で `ConfigurationError`。
- Knowledge / Project / AreaのFakeに対し、`create` / `append` 等の書き込み系メソッドが呼ばれない。
- `reference_list` がFilterをそのまま渡し、参照元Connectorを呼ばない。
- 出力が `outputSchema` に適合（`structuredContent` と text JSONが一致）。

### 12.8 回帰

- 既存の全Test（`knowledge_*` / `project_*` / `area_*` の入出力・`external_ref` を含む）が変更なしで成功する。
- `tests/server.test.ts`: Tool一覧に `reference_add` / `reference_list` が加わり、計23件。Instructionsが `INSTRUCTIONS` と一致。
- `npm run typecheck` が成功。

---

## 13. Integration Verification

### 13.1 Integration Test（`tests/integration/obsidian-reference.integration.test.ts`、手動起動）

- 検証用Vaultの `sources.reference.obsidian.directory` に対し、Connector（Storageは実ファイル）で `add`（Knowledge参照元のIDは文字列で与える）→ `list` → 再 `add` で `created: false` を確認し、終了時にそのRunで作成したfileだけを削除する。
- 外部API（GitHub / Notion）は呼ばない。

### 13.2 手動Verification（記録のみ）

MCP Inspector等で実Server（実Vault・実GitHub・実Notion）に対し:

1. `knowledge_search` で得たIDに `reference_add`（Google Sheets URL）→ `reference_list({ target_type: 'knowledge', target_id })` で同じ `type` / `title` / `url` が返る。
2. `project_list` / `area_list` で得たIDにも同じURLを登録し、それぞれ一覧できる。
3. 存在しない `github:` / `notion:` IDで `NotFoundError`、Reference Fileが増えない。
4. `knowledge_get` / `project_get` / `area_get` の出力が登録前後で同じ。
5. GitHub Repository・Notion Pageに変更が無い。
6. 作成したReference FileをObsidianで削除し、一覧から消える。

---

## 14. LLM Client Verification（任意）

Claude Desktop等で「このKnowledgeに家計簿のスプレッドシートを登録して」「Areaの食事に紐づいたシートを見せて」を試す。実施は任意で、未実施でも残件としない。

---

## 15. README / 個別仕様

- README: Tool一覧に2件、Source of Truth表に `Reference | Obsidian`、「References」節（Directoryを作成すること、`knowledge_dir` / Life Log Directoryと重ねられないこと、編集・削除はObsidianで行うこと、§17の制限）。
- `docs/specs/references.md`: §5〜§8の仕様部分（Reference Model、File形式、ID、URL規則、重複時の挙動、Tool、対象外）。

---

## 16. Acceptance Criteriaとの対応

| Acceptance Criteria | 対応 | Test |
|---|---|---|
| Google Sheets URLをKnowledgeのReferenceとして登録・取得できる | `reference_add` / `reference_list`（`target_type: 'knowledge'`） | §12.5、§12.7、§13.2-1 |
| Projects / Areasにも同じReference機構を利用できる | 同じ2 Tool・同じ保存形式。GitHub / Notionはread-onlyのまま `get` で存在確認だけ行う | §12.5（3参照元）、§12.7、§13.2-2・5 |
| Referenceの一覧でタイプ・タイトル・URLが保持される | Reference Fileの `reference_type` / `title` / `url`、URLは原文 | §12.4（往復）、§12.5 |
| 従来のReferenceタイプの動作を壊さない | `external_ref` と既存Toolの入出力を変更しない（§9） | §12.8、§13.2-4 |
| Sheets APIを呼ばず、参照先URLの管理のみで成立する | URLは書式確認のみ。Google Sheets / Drive APIの依存・呼び出しなし、OAuth Scope変更なし | §12.1、§12.2 |

---

## 17. 懸念点 / 未確定事項

### Q1. 保存先をVault内の専用Directoryにする

3 Entityに同じ操作で紐付けられ、Project / Areaの本体を書き換えず、新しいDatabaseを作らない案は§3の案Dだけである。Reference FileはVaultを使うため、Reference Toolは `sources.knowledge.obsidian.vault_path` が設定されていることを前提とする（Project / Areaへの登録でも必要）。

### Q2. ファイル名をハッシュにする

`<hash>.md` はObsidianのファイル一覧で内容が分からない。代わりに、同じ参照元・URLの重複を排他作成だけで検出でき、入力文字列をファイル名に使わないためパスの安全性を新たに検証しなくて済む。Obsidianではfrontmatter（Properties）で内容を確認できる。

### Q3. 重複の判定は「同じ参照元 + 同じURL文字列」

`/edit` と `/edit?usp=sharing` のように同じ文書を指す別表記は別Referenceになる。URLを原文で保持する方針と両立させるため正規化しない。同じ文書の別シート（`#gid=`）を別Referenceとして登録できる利点もある。

### Q4. 再登録はtitleを更新しない

`reference_add` は冪等（`created: false`）とし、AI Clientの再試行で同じリンクが増えないようにする。titleの変更・Referenceの削除を行うToolは作らず、Obsidianでfileを編集・削除する。

### Q5. 登録時に参照元の存在を確認する

存在しないIDや推測したIDへの登録を防ぐため、`reference_add` は既存の `get` を呼ぶ。Projectでは GitHub API、Areaでは Notion API（目次の取得を含む）への通信が発生する。`reference_list` は外部へ通信しない。

### Q6. 参照元IDの変化には追従しない

Knowledge Noteの移動・Repositoryの改名でIDが変わると、旧IDで登録したReferenceは新IDの一覧に出ない（`reference_list` の全件一覧には残る）。自動追従はしない。必要なら新IDで登録し直し、旧fileをObsidianで削除する。

### Q7. 既存の取得Toolの出力にReferenceを含めない

`knowledge_get` / `project_get` / `area_get` の出力を変えないため、Referenceは `reference_list` でのみ返す。AI Clientは必要に応じて2つのToolを組み合わせる。

### Q8. 公開版（`/spreadsheets/d/e/<id>/pubhtml`）のURLは対象外

U5の文書ID下限により拒否される。共有用の通常の文書URLだけを対象とする。

### Q9. 未知の `reference_type` のfileは一覧から除外する

将来のTypeで作られたfileや、利用者が手で書いたfileでServerが失敗しないようにする。除外したfileは書き換えない。
