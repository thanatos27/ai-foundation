# Phase 4: Knowledge — Implementation Plan

- Status: **rev.3（PR #6 再レビュー反映。最終確認待ち）**
- 作成: Coding Agent (Claude Code) / 2026-10-15（rev.2: PR #6 レビュー反映、rev.3: PR #6 再レビュー反映）
- 対象: [Phase 4 Design Issue](../specs/phase-4-knowledge.md)
- 参照: [MVP v0.1仕様](../specs/mvp-v0.1.md), [Phase 1 Design Issue](../specs/phase-1-foundation.md), [Phase 2 Design Issue](../specs/phase-2-task-schedule.md), [Phase 3 Design Issue](../specs/phase-3-collection.md), [Phase 3 Implementation Plan](phase-3-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

このPlanはReview用であり、本実装は開始していない。Plan Review・User承認後に `main` から `feat/phase-4-knowledge` を作成して実装する。仕様に明記がなく本Planで決めた箇所・判断を仰ぎたい箇所は [§29 懸念点 / 未確定事項](#29-懸念点--未確定事項) にQとしてまとめている（rev.2時点でQ1〜Q12はすべて判断済み）。レビュー指摘への対応は [§30 Review対応履歴](#30-review対応履歴) を参照。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Branch | Plan用Branch `docs/phase-4-implementation-plan`。Baseは `main` の `92e7708 docs: align MVP with Phase 4 knowledge design`（Phase 3実装 PR #5 のMerge `874b5ce` 後に、Phase 4 Design Issue追加 `2812899` とMVP仕様のPhase 4整合 `92e7708` がコミット済み） |
| Repository | `thanatos27/ai-foundation`（**Public**） |
| ローカル環境 | Windows 11 / Node.js v24.20.0。`package.json#engines` は `{ node: ">=24", npm: ">=11" }` |
| 依存 | `@modelcontextprotocol/server ^2.3.1`, `zod ^4.6.7`, `yaml ^2.9.1`, `@doist/todoist-sdk`, `@googleapis/calendar`, `google-auth-library`, `@notionhq/client` |
| 公開Tool | 9件（`task_*` 4件 / `schedule_*` 2件 / `collection_*` 3件） |

### Phase 3までの実装の要点（Phase 4で利用・変更するもの）

| File | 現状 |
|---|---|
| `src/domain/knowledge.ts` | `KnowledgeSourceSchema = enum(['obsidian', 'google_drive'])` と `KnowledgeSchema { id?, type, title, source, external_ref, area?, tags? }` のみ。**`description` がない**。Input Schemaはない |
| `src/domain/common.ts` | `AreaSchema`（`work` / `personal`）、`TagsSchema`（非空文字列の配列） |
| `src/errors.ts` | `FoundationError` と5分類（`InputValidationError` / `CredentialError` / `NotFoundError` / `ProviderApiError(provider, message)` / `ConfigurationError`）。**変更不要** |
| `src/config/schema.ts` | `sources.knowledge = strictObject({ default: KnowledgeSourceSchema, providers: KnowledgeSourceSchema[] })` + 「defaultはprovidersに含まれる」refine。**`obsidian` Blockがない**（strictのため現状は書くと起動Error） |
| `config.yaml` | `knowledge.providers` に `obsidian` と `google_drive` を列挙 |
| `src/connectors/types.ts`, `index.ts` | `Connectors { task?, schedule?, collection? }`。`createConnectors(config, credentials)` は何も接続せず、Client生成・設定検証をTool呼び出し時まで遅延する |
| `src/connectors/notion/connector.ts` | 必須設定（`data_source_id`）が未設定でもConnectorを生成し、呼び出し時に `ConfigurationError`。検索で読めないPageは除外して `warn`（既定stderr）へ件数を出す。Phase 4も同じ形にする |
| `src/tools/*.ts` | `register<Entity>Tools(server, context)`、Connector未設定時は `ConfigurationError`、`jsonResult()` で `structuredContent` + JSON textを返す |
| `config.defaults.area` | Schemaにはあるが **src内で未使用**（Task createは `area` 省略時にareaなし）。Phase 4の `knowledge_create` が初めて利用する |
| `src/instructions.ts` | Knowledge の Source of Truth を「Obsidian / Google Drive」と記載（MVP §15どおり） |
| `.env.example` | `# OBSIDIAN_VAULT_PATH=` がコメントで予約されている（Phase 4仕様ではvault_pathはConfigで持つ） |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 9件を前提とするAssertion |
| `tests/domain/knowledge.test.ts`, `tests/config/schema.test.ts` | 現行Knowledge Schema / Configを前提とするTest |
| `tests/integration/setup.ts` | `AI_FOUNDATION_INTEGRATION=1` でのみ実行。`config.local.yaml` を優先して読む。`runLabel` を提供 |

---

## 2. 設計方針

1. **Phase 1〜3の構造をそのまま使う。** Tool → `ToolContext.connectors.knowledge` → `ObsidianKnowledgeConnector` → `VaultStorage`（Filesystem実装）。
2. **Obsidian（論理SoT）とFilesystem（Storage Access）を分ける。** Markdown / Frontmatter / ID / filename / 検索は「Obsidian Vault内のVault相対パスとテキスト」だけを扱う純粋処理とし、`node:fs` 呼び出し・OS実パス解決（realpath / lstat）・errno・symlink判定は `FilesystemVaultStorage` 1ファイルに閉じ込める（§8）。例外として、Config Schemaは `vault_path` の絶対パス形式判定に `node:path` の `isAbsolute` だけを使う（I/Oなし。§11.1）。汎用Storage Frameworkは作らず、Obsidian Connector内部のInterface 1つに留める。
3. **ローカル絶対パスを外へ出さない。** ID / `external_ref` / Tool Result / Error MessageはVault相対パスのみ。errnoの生Message（絶対パスを含む）はMessageへ入れず `cause` にのみ保持する。
4. **Tool実行時のファイル状態だけを見る。** Cache / Index / Watcher / 独自DBを持たない。毎回Directoryを走査・ファイルを読む。
5. **書き込みは「新規作成（排他）」と「末尾追記」だけ。** 既存ファイルの書き換え（read-modify-write）はしない。Frontmatterを変更しないことを構造的に保証する（§19）。
6. **黙ってデータを失わない・壊さない。** Malformed Frontmatterへのappendは書き込み前にError。filenameが作れないtitleはError。上書きはしない。
7. **起動時にFilesystemへアクセスしない。** Vault / Knowledge Directoryの存在確認はTool呼び出し時に行う（Phase 2・3方針）。設定値の「形式」だけは起動時のConfig Schemaで検証する。

---

## 3. Phase 3までの実装への変更点（概要）

| 対象 | 変更 | 理由 |
|---|---|---|
| `domain/knowledge.ts` | `KnowledgeSchema` に `description: string \| null` を追加し、Tool Input / Result Schemaを追加 | Phase 4 §Knowledge Domain / 各Tool |
| `connectors/types.ts` | `KnowledgeConnector { create, search, get, append }`、`Connectors.knowledge?` を追加 | Connector境界 |
| `connectors/index.ts` | `ObsidianKnowledgeConnector` + `FilesystemVaultStorage` を生成 | 配線 |
| `config/schema.ts`, `config.yaml` | `sources.knowledge.obsidian { storage, vault_path?, knowledge_dir? }` を追加。`config.yaml` の `providers` から `google_drive` を外し、`obsidian` Block（`vault_path` はコメント例示のみ）を追加 | Phase 4 §Configuration、MVP §13（`92e7708` で整合済み） |
| `tools/index.ts` | `registerKnowledgeTools` を呼ぶ | Tool公開 |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 公開Tool 9件 → 13件 | Tool公開 |
| `tests/domain/knowledge.test.ts`, `tests/config/schema.test.ts` | `description`、`obsidian` Blockに合わせて追加・変更 | Domain / Config変更 |
| `.env.example` | `# OBSIDIAN_VAULT_PATH=` を削除し、vault_pathは `config.local.yaml` に書く旨のコメントへ置換 | 仕様ではvault_pathはConfig（Credentialではない） |
| `README.md` | Current Phase、Tool一覧、`config.local.yaml` 例、Obsidian Setup、Directory Structure | 利用手順 |

**変更しないもの**: `src/errors.ts`、`src/credentials/*`（Filesystem方式はCredential不要）、`src/instructions.ts`（MVP §15の文面。KnowledgeのSoT記述「Obsidian / Google Drive」はMVPの論理定義どおりのため変更しない）、Task / Schedule / Collection関連。

---

## 4. 追加・変更予定ファイル

### 4.1 Source

| File | 種別 | 責務 |
|---|---|---|
| `src/domain/knowledge.ts` | 変更 | §5 |
| `src/connectors/types.ts` | 変更 | `KnowledgeConnector`、`Connectors.knowledge?` |
| `src/connectors/index.ts` | 変更 | Obsidian Connectorの生成 |
| `src/connectors/obsidian/connector.ts` | 新規 | `ObsidianKnowledgeConnector`。設定検証、ID検証、Storage呼び出し、Domain変換、Filter / snippet適用 |
| `src/connectors/obsidian/storage.ts` | 新規 | `VaultStorage` Interface（Vault相対パスだけを受け渡す境界、§8.1） |
| `src/connectors/obsidian/filesystem-storage.ts` | 新規 | `FilesystemVaultStorage`。パス解決、実パス検証、symlink拒否、排他作成、追記、走査、errno → Foundation Error変換。**`node:fs` とOS実パス解決を使うのはこのファイルだけ**（`node:path` はConfig Schemaの絶対パス形式判定でも使う） |
| `src/connectors/obsidian/id.ts` | 新規 | Knowledge IDのformat / parse、Vault相対パスの検証（純粋関数） |
| `src/connectors/obsidian/markdown.ts` | 新規 | Frontmatterの分離・parse・既知Field検証・serialize、作成テキスト生成、append区切り計算（純粋関数） |
| `src/connectors/obsidian/filename.ts` | 新規 | title → filename（純粋関数） |
| `src/connectors/obsidian/tags.ts` | 新規 | Obsidian Tag規則の検証と比較Key（純粋関数。create / Frontmatter parse / search filterで共用、§12.6） |
| `src/connectors/obsidian/search.ts` | 新規 | query / area / tags の照合とsnippet生成（純粋関数） |
| `src/config/schema.ts` | 変更 | §11 |
| `src/tools/knowledge.ts` | 新規 | `knowledge_create` / `knowledge_search` / `knowledge_get` / `knowledge_append` の登録、source / area解決 |
| `src/tools/index.ts` | 変更 | `registerKnowledgeTools` 呼び出し |

### 4.2 Tests

| File | 種別 | 内容 |
|---|---|---|
| `tests/domain/knowledge.test.ts` | 変更 | `description`、各Input Schema |
| `tests/config/schema.test.ts` | 変更 | `obsidian` Block、`knowledge_dir` / `vault_path` の形式検証 |
| `tests/connectors/obsidian/id.test.ts` | 新規 | ID parse / format / 拒否パターン |
| `tests/connectors/obsidian/markdown.test.ts` | 新規 | Frontmatterあり / なし / Malformed、serialize、append区切り |
| `tests/connectors/obsidian/filename.test.ts` | 新規 | 安全化ルール・日本語・予約名・長さ |
| `tests/connectors/obsidian/tags.test.ts` | 新規 | Tag規則（§12.6） |
| `tests/connectors/obsidian/search.test.ts` | 新規 | 照合・snippet |
| `tests/connectors/obsidian/filesystem-storage.test.ts` | 新規 | 一時Directoryで実Filesystemの境界・symlink・errno |
| `tests/connectors/obsidian/connector.test.ts` | 新規 | 一時Directoryの検証用Vaultでcreate / search / get / append / 外部編集 |
| `tests/helpers/vault.ts` | 新規 | 一時Vault作成・ファイル配置・後始末のHelper |
| `tests/helpers/fake-connectors.ts` | 変更 | `FakeKnowledgeConnector` |
| `tests/tools/knowledge.test.ts` | 新規 | Fake ConnectorでTool Layer |
| `tests/server.test.ts`, `tests/e2e/stdio.test.ts` | 変更 | Tool 13件 |
| `tests/integration/obsidian.integration.test.ts` | 新規 | 検証専用Vaultに対するIntegration Test（手動起動、§25） |

### 4.3 Project設定 / Documentation

| File | 変更 |
|---|---|
| `config.yaml` | §11 |
| `.env.example` | §3 |
| `README.md` | §3 |
| `vitest.integration.config.ts`, `tests/integration/setup.ts` | Commentの「Todoist / Google Calendar」をObsidianを含む表現へ更新（挙動は変更なし） |
| `docs/plans/phase-4-implementation-plan.md` | 本Plan。実装後に「実装・Integration Verificationで確定した事項」を追記する |

---

## 5. Knowledge Domain / Tool Input / Tool Result Schema変更

Schemaはすべて `src/domain/knowledge.ts` に置く（Provider非依存）。Obsidian固有の制約（filename、tagの空白禁止等）はConnectorで検証する。

### 5.1 Entity

```ts
/** Non-blank text, stored as given (not trimmed). Collection の NoteSchema と同じ定義。 */
const NonBlankSchema = z.string().refine((text) => text.trim().length > 0, { message: 'must not be blank' });

export const KnowledgeSchema = z.object({
  id: z.string().min(1).optional(),       // 既存のまま。返却時は常に設定する
  type: z.literal('knowledge'),
  title: z.string().min(1),
  description: z.string().nullable(),    // 追加
  source: KnowledgeSourceSchema,          // obsidian | google_drive（google_driveは予約のまま維持）
  external_ref: z.string().min(1),
  area: AreaSchema.nullable().optional(),
  tags: TagsSchema.optional(),
});
```

- `description` は `nullable`（必須Key）とする。仕様の `description: string | null` に合わせ、返却時は常に `null` か文字列を返す。
- `KnowledgeSourceSchema` は `google_drive` を含めたまま維持する（仕様: Domain上の予約）。Tool Inputには使わない（§5.2）。
- 本文はEntityに含めない。

### 5.2 Input Schema

```ts
/** Sources a Phase 4 tool input may name. `auto` resolves to `sources.knowledge.default`. */
export const KnowledgeSourceInputSchema = z.enum(['auto', 'obsidian']);

export const KnowledgeCreateInputSchema = z.strictObject({
  title: NonBlankSchema,
  description: NonBlankSchema.nullable().optional(),
  content: NonBlankSchema,
  source: KnowledgeSourceInputSchema.optional(),
  area: AreaSchema.nullable().optional(),
  tags: TagsSchema.optional(),
});

export const KnowledgeSearchFilterSchema = z.strictObject({
  /** Case-insensitive substring of title / description / tags / body. */
  query: NonBlankSchema.optional(),
  /** Exact match. null matches knowledge without an area. */
  area: AreaSchema.nullable().optional(),
  /** Matches knowledge that has all of the given tags. */
  tags: TagsSchema.optional(),
});

export const KnowledgeGetInputSchema = z.strictObject({ id: z.string().min(1) });

export const KnowledgeAppendInputSchema = z.strictObject({
  id: z.string().min(1),
  content: NonBlankSchema,
});
```

- 空白のみの `title` / `content` は仕様「title / contentが空 → Input Validation Error」に含めて拒否する。値はtrimせず与えられたまま保存する。
- `description: null` / 省略はどちらも「descriptionなし」。空白のみの文字列は拒否する（Frontmatterに空のdescriptionを作らない）。
- `source` に `google_drive` を受け付けない（仕様: 未実装ProviderをTool Inputとして公開しない）。Schema Errorになる。
- `knowledge_search.area: null` は MVP §knowledge_search のInput型（`work | personal | null`）に合わせ「areaなしのKnowledge」と一致させる。
- IDの形式検証はSchemaではなくConnectorで行う（Provider固有のため。Collectionと同じ）。

### 5.3 Result Schema

```ts
/** knowledge_search の1件。本文全文は含めない。 */
export const KnowledgeSearchResultSchema = KnowledgeSchema.extend({ snippet: z.string() });

/** knowledge_get の結果。本文はMetadataと分けて返す。 */
export const KnowledgeDocumentSchema = z.object({ knowledge: KnowledgeSchema, content: z.string() });
```

Tool Result（`structuredContent`）:

| Tool | Result |
|---|---|
| `knowledge_create` | `{ knowledge: Knowledge }` |
| `knowledge_search` | `{ items: KnowledgeSearchResult[] }` |
| `knowledge_get` | `{ knowledge: Knowledge, content: string }` |
| `knowledge_append` | `{ knowledge: Knowledge }`（追記後の最新Metadata。本文は返さない） |

`knowledge_get` で本文を `knowledge` の外に置くのは、仕様「本文そのものは共通Knowledge Domainへ複製せず、Tool Resultとして必要時に返す」に合わせ、`KnowledgeSchema` を本文なしのまま保つため。返却例:

```json
{
  "knowledge": {
    "id": "obsidian:AI Foundation/Knowledge/CAP定理.md",
    "type": "knowledge",
    "title": "CAP定理",
    "description": "CAP定理と分散システムでの考え方",
    "source": "obsidian",
    "external_ref": "AI Foundation/Knowledge/CAP定理.md",
    "area": "personal",
    "tags": ["database", "distributed-systems"]
  },
  "content": "CAP定理では……\n"
}
```

---

## 6. knowledge_get追加

- Tool名 `knowledge_get`、Input `{ id }`、Result `{ knowledge, content }`（§5.3）。
- exact IDのみ（§10）。Titleによる取得・fuzzy matchingはしない。Tool Descriptionで「idは `knowledge_search` / `knowledge_create` の結果のものを使う」と案内する。
- `content` はFrontmatterを除いたMarkdown本文全文（§12.4）。未知Frontmatter Keyは返さない（Domain外のため）。
- Annotations: `readOnlyHint: true`, `openWorldHint: false`。
- MVP仕様は `92e7708` で `knowledge_get` 追加済みのため、仕様変更は不要。

---

## 7. Obsidian Connector設計

### 7.1 KnowledgeConnector Interface（`src/connectors/types.ts`）

```ts
/** Source of Truth: Obsidian. Reads and writes only Markdown files under the configured knowledge_dir. */
export interface KnowledgeConnector {
  /** Creates a new file directly under knowledge_dir. Never overwrites. `area` is already resolved by the tool. */
  create(input: KnowledgeCreate): Promise<Knowledge>;
  /** Knowledge under knowledge_dir (recursive) matching every given filter. Malformed files are skipped. */
  search(filter: KnowledgeSearchFilter): Promise<KnowledgeSearchResult[]>;
  /** Metadata and the full body of the knowledge with this exact ID. */
  get(id: string): Promise<KnowledgeDocument>;
  /** Appends to the end of the body without touching the frontmatter; returns the metadata afterwards. */
  append(input: KnowledgeAppendInput): Promise<Knowledge>;
}

export interface Connectors {
  task?: TaskConnector;
  schedule?: ScheduleConnector;
  collection?: CollectionConnector;
  knowledge?: KnowledgeConnector;
}
```

`KnowledgeCreate` はTool Inputから `source` を除き、`area` を `Area | null` に確定させた型（`Omit<KnowledgeCreateInput, 'source' | 'area'> & { area: Area | null }`）。source / areaの既定値解決はConfigの知識が必要なためTool Layerで行い（§9.1）、Connectorは確定値だけを受け取る。

### 7.2 ObsidianKnowledgeConnector（`connector.ts`）

```ts
export interface ObsidianKnowledgeConnectorOptions {
  /** `sources.knowledge.obsidian.knowledge_dir`（Vault相対、未設定ならundefined） */
  knowledgeDir: string | undefined;
  /** Storage。Phase 4は FilesystemVaultStorage。 */
  storage: VaultStorage;
  /** 検索で除外したファイルの報告先。既定はstderr。 */
  warn?: (message: string) => void;
}
```

処理の流れ（共通）:

1. `knowledgeDir` 未設定 → `ConfigurationError('sources.knowledge.obsidian.knowledge_dir is not set')`。
2. `storage.checkKnowledgeDir()` でVault / Knowledge Directoryが利用可能か確認（§8.2。未設定・不在は `ConfigurationError`）。
3. ID / filenameを純粋関数で検証（§10, §13）。
4. Storageへ読み書きし、`markdown.ts` / `search.ts` でDomainへ変換する。

ConnectorはOSパス・`fs` を一切扱わない。扱うのは `VaultPath`（Vault相対・`/` 区切りの検証済み文字列）とテキストだけ。

### 7.3 create / search / get / append の概要

| 操作 | Storage呼び出し | 詳細 |
|---|---|---|
| create | `createExclusive(path, text)` | §13, §14 |
| search | `list()` → 各 `read(path)` | §15 |
| get | `read(path)` | §12.4, §18 |
| append | `read(path)` → 検証 → `append(path, text)` | §19 |

---

## 8. Filesystem依存を閉じ込める境界

### 8.1 VaultStorage Interface（`storage.ts`）

```ts
/** Vault-relative POSIX path, already validated to be a .md path under knowledge_dir (see id.ts). */
export type VaultPath = string & { readonly __brand: 'VaultPath' };

export interface VaultFile {
  path: VaultPath;
  text: string;          // UTF-8 decoded, BOM removed
  modifiedAt: number;    // epoch ms（search結果の並び順に使う）
}

/**
 * How the Obsidian connector reaches the vault. Phase 4: the local filesystem.
 * Everything crossing this boundary is vault-relative; absolute paths, OS separators
 * and errno never leave the implementation.
 */
export interface VaultStorage {
  /** Throws ConfigurationError when the vault or knowledge_dir is not usable. */
  checkKnowledgeDir(): Promise<void>;
  /** Every regular .md file under knowledge_dir, recursively, at any depth (symlinks are not followed). */
  list(): Promise<{ path: VaultPath; modifiedAt: number }[]>;
  /** NotFoundError when it does not exist (or is not a regular file). */
  read(path: VaultPath): Promise<VaultFile>;
  /** Creates the file; InputValidationError(already exists) when anything exists at the path. */
  createExclusive(path: VaultPath, text: string): Promise<void>;
  /** Appends to an existing regular file; NotFoundError when it does not exist. */
  append(path: VaultPath, text: string): Promise<void>;
}
```

- 実装は `FilesystemVaultStorage({ vaultPath: string | undefined, knowledgeDir })`。`vault_path` 未設定は各メソッドで `ConfigurationError`。
- 将来 `GoogleDriveVaultStorage` を追加する場合も、このInterfaceとVaultPathの意味（Vault相対）を変えずに差し替えられる（§28）。
- 「汎用Storage Framework」にはしない: Obsidian Connector専用で、Plugin機構・Registry・設定駆動のFactoryは作らない。`connectors/index.ts` で `storage: filesystem` のときに直接 `new FilesystemVaultStorage(...)` するだけ。

### 8.2 パス解決（`filesystem-storage.ts` のみ）

| 対象 | 解決 |
|---|---|
| Vault Root | `vault_path` をそのまま `path.resolve`（絶対パスであることはConfig Schemaで検証済み、§11）→ `fs.realpath`。ENOENT / ENOTDIR / EACCES → `ConfigurationError('the Obsidian vault (sources.knowledge.obsidian.vault_path) does not exist or cannot be read')`（絶対パスはMessageに含めない） |
| Knowledge Directory | `vaultReal` から `knowledge_dir` のsegmentを1つずつ辿り、各要素を `fs.lstat`。**symlink / Junction → `ConfigurationError`**（`the knowledge directory "AI Foundation/Knowledge" goes through a symbolic link or junction, which is not supported`）、不在 / Directoryでない → `ConfigurationError('the knowledge directory "AI Foundation/Knowledge" does not exist in the vault')`（Vault相対の設定値は出してよい）。最後に `knowledgeDirReal = fs.realpath(...)` が `vaultReal` 配下（`path.relative` が空でなく `..` で始まらず絶対パスでない）であることを確認し、外れていれば `ConfigurationError` |
| 対象ファイル | `path.join(knowledgeDirReal, ...(VaultPathのknowledge_dir以降のsegment))`（§20の検証込み） |

- Vault Root / Knowledge Directoryの実パスは **呼び出しごとに解決する**（Cacheしない。人間がVaultを移動・同期フォルダを再マウントしても次回呼び出しで追従し、方針4に従う）。
- Knowledge Directoryの自動作成はしない（Q4）。
- symlink / Junctionを許可するのは **`vault_path` で指定したVault Rootそのもの（とその上位）だけ**（例: 同期フォルダへのリンク。利用者が設定した値のため信頼する）。`vaultReal` から `knowledge_dir` までの途中segment、`knowledge_dir` 自体、その内側のsymlinkはすべて拒否する。`knowledge_dir` はVault相対パスであり、Vault外を指すリンクを置くとVault外を正規のKnowledge Directoryとしてread / writeできてしまうため（PR #6 [P1]）。
- この検証は `checkKnowledgeDir()` で行い、`list` / `read` / `createExclusive` / `append` はすべて先にこれを通す（呼び出しごと、Cacheなし）。

---

## 9. Tool Layer（`src/tools/knowledge.ts`）

### 9.1 source / area の解決

```ts
function resolveSource(source: 'auto' | 'obsidian' | undefined, config: Config): 'obsidian' {
  const resolved = source === undefined || source === 'auto' ? config.sources.knowledge.default : source;
  if (resolved !== 'obsidian' || !config.sources.knowledge.providers.includes('obsidian')) {
    throw new ConfigurationError(`the knowledge source "${resolved}" is not available in this version (only obsidian)`);
  }
  return resolved;
}
```

- `source` 省略 / `auto` → `knowledge.default`。Configの `default` は `obsidian | google_drive` を許す（Domain予約を維持、§11）ため、`default: google_drive` の環境では `ConfigurationError` になる（仕様: 最終的にObsidianへ解決される場合のみ実行可能）。
- `area` 省略（`undefined`）→ `config.defaults.area`、`null` → areaなし、値 → その値。
- search / get / append はObsidian固定（search は `source` Inputを持たない、get / append はIDのprefixで決まる）。`providers` に `obsidian` がない場合は `ConfigurationError`。

### 9.2 Tool定義

| Tool | Annotations | Description要点 |
|---|---|---|
| `knowledge_create` | `readOnlyHint: false, destructiveHint: false, openWorldHint: false` | Obsidian VaultにKnowledge（再利用する学習・気づき・考察）を1 Markdownとして新規作成。既存ファイルは上書きしない。同名が既にある場合はErrorになるので、追記したいときは `knowledge_search` でidを得て `knowledge_append` を使う。`area` 省略時は既定area（Configの値をDescriptionに埋め込む）、`null` でなし。tagsはObsidianのTag規則に従う（`#` なし、空白なし、英字・数字・`_` `-` `/`・日本語等、数字のみ不可）。Task / Schedule / Collectionとの使い分け |
| `knowledge_search` | `readOnlyHint: true, openWorldHint: false` | 全Filter optional。`query` はtitle / description / tags / 本文の大文字小文字無視の部分一致、`area` 完全一致（null=なし）、`tags` はすべて持つもの（大文字小文字無視）。`{}` で一覧。結果は本文全文を含まずsnippetのみ。本文は `knowledge_get`、追記は `knowledge_append` へ返却idを渡す |
| `knowledge_get` | `readOnlyHint: true, openWorldHint: false` | exact id（`obsidian:<vault-relative-path>`）でMetadataと本文全文を取得。idは推測せず `knowledge_search` で得る。ファイルが移動されると旧idはNot foundになるので再検索する |
| `knowledge_append` | `readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false` | exact idの本文末尾へ `content` をそのまま追記。Frontmatterや既存本文は変更しない。日時・見出しは付与しないので必要なら `content` に含める。同じ呼び出しを繰り返すと重複して追記される |

- `openWorldHint: false`: ローカルFilesystem上の設定済みDirectoryのみを扱うため。
- Connector未設定時は他Entityと同じく `ConfigurationError('the knowledge source (Obsidian) is not configured')`。

---

## 10. Knowledge ID parse / validation（`id.ts`）

### 10.1 形式

```text
obsidian:<vault-relative-path>
例: obsidian:AI Foundation/Knowledge/AI/RAG.md
```

- `formatKnowledgeId(path: VaultPath) = 'obsidian:' + path`、`external_ref = path`。
- Vault相対パスは常に `/` 区切り（Windowsでも）。Storageが返すパスもStorage内部で `/` へ変換してから返す。
- Unicode正規化はしない（実ファイル名のcode pointをそのまま使う。Q9）。

### 10.2 parseKnowledgeId(id, knowledgeDir): VaultPath

以下を順に検証し、違反はすべて `InputValidationError`（Messageにidを含める。idは利用者が渡した値であり個人絶対パスの漏洩にはならないが、長すぎる場合は先頭200文字に切る）。

| # | 条件 | 例（拒否） |
|---|---|---|
| 1 | `obsidian:` で始まる | `notion:abc`, `AI Foundation/Knowledge/a.md` |
| 2 | 本体が空でない、NUL・制御文字（U+0000–U+001F, U+007F）を含まない | `obsidian:` |
| 3 | `\` を含まない（区切りは `/` のみ。Windowsで区切りとして解釈されるのを防ぐ） | `obsidian:AI Foundation\Knowledge\a.md` |
| 4 | 絶対パスでない: `/` 始まり、`C:` 等のdrive letter、`//` / UNC | `obsidian:/etc/a.md`, `obsidian:C:/Users/a.md` |
| 5 | segmentに空（`//`）・`.`・`..` がない | `obsidian:AI Foundation/Knowledge/../a.md` |
| 6 | 末尾segmentが `.md` で終わり、`.md` 以外の名前部分がある | `obsidian:AI Foundation/Knowledge/a.txt`, `.../.md` |
| 7 | segment列の先頭が `knowledgeDir` のsegment列と **segment単位で完全一致** し、その後に1つ以上のsegmentがある（文字列prefix比較はしない。`AI Foundation/Knowledge2/a.md` を拒否） | `obsidian:AI Foundation/Other/a.md`, `obsidian:Daily/a.md` |

- `.md` の判定は大文字小文字を区別する（`.MD` は対象外。Q10）。
- `.` で始まるsegment（`.archive/note.md` 等）は拒否しない。searchが返すIDはすべてそのままget / appendできる（§15.1と対称。PR #6 再レビュー [P2]）。
- この検証はIDの「論理形式」の検証。実ファイルの位置（symlink等）は §20 でStorageが別途検証する（二重防御）。
- `knowledgeDir` 側も同じsegment規則でConfig Schemaにより検証済み（§11）。

---

## 11. Configuration変更

### 11.1 Schema（`src/config/schema.ts`）

```ts
knowledge: z
  .strictObject({
    default: KnowledgeSourceSchema,                        // obsidian | google_drive（変更なし）
    providers: z.array(KnowledgeSourceSchema).min(1),      // 変更なし
    /**
     * Obsidian vault access. Optional so the server still starts; the knowledge tools return a
     * configuration error without it. vault_path is personal: set it in config.local.yaml.
     */
    obsidian: z
      .strictObject({
        storage: z.literal('filesystem'),
        vault_path: z.string().min(1).refine(isAbsolutePath, { message: 'must be an absolute path' }).optional(),
        knowledge_dir: VaultRelativeDirSchema.optional(),
      })
      .optional(),
  })
  .refine(/* 既存: default は providers に含まれる */),
```

- `VaultRelativeDirSchema`: 非空、`\` / 制御文字なし、絶対パスでない、先頭・末尾 `/` なし、空・`.`・`..` segmentなし。`.` / 空（Vault全体）は拒否（仕様Out of Scope「Vault全体のRead / Write」）。
- `isAbsolutePath`: `path.isAbsolute`（実行OSの規則）。`~` 展開はしない（Q5）。
- `storage` は `filesystem` のみ（Phase 4）。`google_drive` 等は起動時Config Error。
- **未設定は起動時Errorにしない**（`vault_path` / `knowledge_dir` / `obsidian` Block）。仕様のError Mappingどおり、Tool呼び出し時に `ConfigurationError`。既存の `config.local.yaml`（Phase 3以前に作ったもの）でServerが起動しなくなるのを防ぐ。
- **形式不正は起動時 `ConfigError`**（例: `knowledge_dir: ../outside`、`vault_path: relative/path`）。既存の `timezone` 検証と同じ扱い。
- `providers` / `default` の型は変更しない（Domain予約の `google_drive` を残す）。`google_drive` を選んだ場合はTool呼び出し時にError（§9.1）。

### 11.2 `config.yaml`

```yaml
  knowledge:
    default: obsidian
    providers:
      - obsidian
    obsidian:
      storage: filesystem
      knowledge_dir: "AI Foundation/Knowledge"
      # The Obsidian vault on this machine (required by the knowledge tools). It may be
      # inside a Google Drive (or other) sync folder; AI Foundation does not manage syncing.
      # This repository is public: do not set it here. Set it in config.local.yaml.
      # vault_path: "C:/Users/<you>/Obsidian/MyVault"
```

`providers` から `google_drive` を外すのはMVP §13（`92e7708`）の例に合わせるため。

### 11.3 `config.local.yaml`（README記載例）

```yaml
  knowledge:
    default: obsidian
    providers:
      - obsidian
    obsidian:
      storage: filesystem
      vault_path: "G:/マイドライブ/Obsidian/MyVault"
      knowledge_dir: "AI Foundation/Knowledge"
```

YAMLのWindowsパスは `/` 区切りか単一引用符で書く（`"C:\Users"` はYAMLのescapeになる）旨をREADMEに書く。

---

## 12. Markdown / YAML Frontmatter parser・serializer（`markdown.ts`）

### 12.1 依存

既存依存の `yaml`（v2, YAML 1.2 core schema）を使う。`gray-matter` 等のFrontmatter専用Packageは追加しない（`gray-matter` はjs-yaml依存・YAML 1.1で `yes` / `no` 等の解釈が異なり、既存のConfig parserと挙動が揃わないため）。

### 12.2 分離（split）

入力は `VaultFile.text`（BOM除去済み）。

1. 1行目が厳密に `---`（直後が `\n` または `\r\n`）でなければ **Frontmatterなし**。本文 = 全テキスト。
2. 1行目が `---` なら、2行目以降で最初に現れる `---` だけの行（行末の空白は許容）を閉じ区切りとする。
   - 閉じ区切りがない → **Malformed**（`frontmatter is not closed`。Q3）。
3. 区切りの間をYAML、閉じ区切り行の後を本文とする。閉じ区切り直後の空行1つ（`\n` / `\r\n`）は区切り用として本文から除く（作成時に入れる空行。§14.2）。それ以外は本文をそのまま保持する（CRLFも保持）。

### 12.3 parse・既知Field検証

```ts
type ParsedFile =
  | { ok: true; meta: { title: string; description: string | null; area: Area | null; tags: string[] }; body: string }
  | { ok: false; reason: string };   // Malformed
```

- `yaml.parseDocument(src, { uniqueKeys: true })`。`doc.errors` が1件以上 → Malformed（`invalid YAML`）。警告（`doc.warnings`）は無視。
- Rootが `null`（空のFrontmatter `---\n---`）→ 空Mappingとして扱う。RootがMapping以外（配列・スカラー）→ Malformed。
- 既知Field（未知Keyは読まずに無視）:

| Key | 不在 / `null` | 有効 | Malformed |
|---|---|---|---|
| `title` | 拡張子を除いたfilename | 空白のみでない文字列 | 文字列以外、空白のみ |
| `description` | `null` | 文字列（空文字は `null` として扱う） | 文字列以外 |
| `area` | `null` | `work` / `personal` | それ以外の値（`Work` も含む） |
| `tags` | `[]` | §12.6のTag規則を満たす文字列の配列 | 配列以外、要素が文字列以外・Tag規則違反（`#ai`、`1984`、空白を含む等） |

- Key不在と `null` を同じ扱いにするのは、ObsidianのProperty UIが値を消したときに `key:`（null）を残すため。
- `tags` に単一文字列（`tags: ai`）が書かれている場合はMalformedとする（仕様「既知Fieldが不正な型」。Obsidianは受け付けるが、AI Foundationの `tags: string[]` に一致しない。Q2）。
- YAMLのDate / 数値等がtitleに入った場合（`title: 2026-10-15`）はYAML 1.2 coreでは `2026-10-15` が文字列になる。`title: 123` は数値のためMalformed。
- Tag規則違反をMalformedとするのは、create / parse / search filterで「有効なTag」の意味を揃えるため（PR #6 [P2]）。人間が書いた `tags: ["#ai"]` はMalformedとしてsearchから除外され、get / appendはErrorになる（Obsidianで `ai` へ直せば次回から読める）。
- **Frontmatterなし** → `{ title: filename, description: null, area: null, tags: [] }`、本文=全テキスト。

### 12.4 get の本文

`content` は §12.2 で得た本文（Frontmatter・閉じ区切り・直後の空行1つを除いたもの）をそのまま返す。改行コードは変換しない。

### 12.5 serialize（作成時のFrontmatter）

```ts
function createFileText(meta: { title; description; area; tags }, content: string): string
```

- Key順は `title` → `description` → `area` → `tags` 固定。値がない `description`（null）・`area`（null）・`tags`（`[]`）は **Keyごと省略** する（Q1）。読み取りでは不在 = 既定値のため、round tripは一致する。
- 生成: `new yaml.Document(meta)` を `toString({ lineWidth: 0 })`。文字列のQuoteは `yaml` に任せる（`:` や `#` を含むtitle、`yes` 等も安全にQuoteされる）。`lineWidth: 0` で長いdescriptionを折り返さない。
- 出力形式: `---\n<yaml>---\n\n<content>`（YAMLは末尾 `\n` 付き）。
- 改行はLF: `content` の `\r\n` / `\r` を `\n` に変換する。YAML出力もLF。
- `content` が `\n` で終わらない場合は末尾に `\n` を1つ付ける（POSIXテキストファイルの慣習。内容の整形ではない）。
- 書き込み前に生成テキストを §12.3 のparserに通し、title / description / area / tags が入力と一致することを確認する（serializerの自己検証。不一致は実装バグとして `ProviderApiError`）。

### 12.6 Obsidian Tag規則（`tags.ts`）

[Obsidian Help / Tags](https://obsidian.md/help/tags) に沿った規則を1箇所に集約し、**create（入力検証）・Frontmatter parse（§12.3）・search filter（§16）の3箇所で同じ関数を使う**。Domainの `TagsSchema`（非空文字列配列）はProvider非依存のまま変更せず、Obsidian固有の規則はConnector側に置く（Phase 3のNotion Select名制約と同じ扱い）。

```ts
/** Why `tag` is not a valid Obsidian tag, or undefined when it is. */
export function tagProblem(tag: string): string | undefined;
/** Comparison key: Obsidian tags are case-insensitive. */
export function tagKey(tag: string): string;   // tag.toLowerCase()
```

| 規則 | 根拠 | 例（拒否） |
|---|---|---|
| 空でない | — | `""` |
| 空白類（`\s`。全角空白を含む）を含まない | Obsidian: Tags can't contain blank spaces | `distributed systems` |
| `#` を含まない（Frontmatterのtagsは `#` なしで書く） | Obsidian: YAMLではlistで `#` なしの例 | `#ai` |
| ASCII記号は `_` `-` `/` 以外を含まない（`!` `"` `$` `%` `&` `'` `(` `)` `*` `+` `,` `.` `:` `;` `<` `=` `>` `?` `@` `[` `\` `]` `^` `` ` `` `{` `\|` `}` `~`） | Obsidian: 許可文字は英字・数字・`_`・`-`・`/`・一般的なUnicode | `c++`, `a,b`, `v1.0` |
| 英字以外のUnicode（日本語・絵文字等）は許可 | Obsidian: Commonly accepted Unicode characters | （許可）`分散システム`, `📚` |
| 数字と `/` 以外の文字を1つ以上含む | Obsidian: at least one non-numerical character | `1984`, `2024/10` |
| Nested tagの `/` は先頭・末尾・連続に置かない | Nested tagは `parent/child` | `/ai`, `ai/`, `ai//rag` |

- **create**: 違反するtagがあれば `InputValidationError`（`tag "1984" is not a valid Obsidian tag: must contain at least one non-numeric character`）。保存は入力の表記のまま（小文字化しない）。
- **Frontmatter parse**: 違反する要素があれば **Malformed**（§12.3）。
- **search filter**: `filter.tags` に違反するtagがあれば `InputValidationError`（保存されたtagはすべて規則を満たすため、違反tagは決して一致しない。黙って0件にせず誤りを返す）。比較は `tagKey()` 同士（大文字小文字を区別しない）。
- Nested tagの親による一致（`inbox` で `inbox/to-read` に一致）はしない。完全一致（大文字小文字無視）のみ。
- 一般的なUnicodeの範囲は厳密に列挙しない（Obsidian自身も明示していない）。上表で拒否するのはASCII記号・空白・数字のみのtagだけで、非ASCII文字は許可する。

---

## 13. titleからfilenameを生成するルール（`filename.ts`）

`toFileName(title: string): string`（拡張子 `.md` を付けた1 segment）。仕様「OSでファイル名として利用できない文字・形式は安全化する」を、Windows / macOS / Linux / Google Drive / Obsidianの共通部分で満たす。

1. **禁止文字を空白へ置換**: `/ \ : * ? " < > |`（Windows・POSIX）、`# ^ [ ]`（ObsidianのLink構文と衝突しWikilinkで参照できなくなる）、制御文字 U+0000–U+001F / U+007F。
2. **空白の正規化**: 連続する空白類（改行・タブ・全角空白を含む `\s`）を半角空白1つにする。
3. **前後のtrim**、先頭の `.`（隠しファイル化を防ぐ）と末尾の `.` / 空白を除去。
4. **空になった → `InputValidationError`**（`title "???" cannot be turned into a file name`）。
5. **Windows予約名**（`CON` `PRN` `AUX` `NUL` `COM1`–`COM9` `LPT1`–`LPT9`。大文字小文字無視、`CON.txt` のような拡張子付きも）→ `InputValidationError`（Q6）。
6. **長さ**: 名前部分（`.md` を除く）がUTF-8で200 byteを超える → `InputValidationError`（`title is too long for a file name; shorten it`）。truncateしない（同名衝突や意図しない名前を避ける。日本語なら約66文字）。Q6。
7. `.md` を付ける。

例:

| title | filename |
|---|---|
| `CAP定理` | `CAP定理.md` |
| `RAG: 構成と役割` | `RAG 構成と役割.md` |
| `A/B テスト` | `A B テスト.md` |
| `[[リンク]] #tag` | `リンク tag.md` |
| `.env の扱い` | `env の扱い.md` |
| `???` | Validation Error |

- titleそのもの（Frontmatterの `title`）は入力のまま保存する。filenameだけが安全化される。
- Unicode正規化（NFC等）はしない（Q9）。
- 大文字小文字だけ異なる既存ファイル（`cap定理.md` がある状態で `CAP定理`）は、Windows / macOS（大文字小文字非区別FS）では排他作成が `EEXIST` になり「既に存在」として扱われる。Linuxでは別ファイルとして作成される（FSの挙動に従い、Foundation側で正規化しない）。

---

## 14. create時の排他的な新規作成・上書き防止

### 14.1 手順

1. Tool Layerで source / area を解決（§9.1）。
2. Connector: `knowledgeDir` 確認 → `storage.checkKnowledgeDir()`。
3. tagsをObsidian Tag規則（§12.6）で検証し、違反は `InputValidationError`（Q7）。
4. `toFileName(title)` → `VaultPath = knowledgeDir + '/' + filename`（`knowledge_dir` **直下**のみ。サブDirectoryは作らない）。
5. `createFileText(...)` → `storage.createExclusive(path, text)`。
6. 返却: 書いた内容から組み立てたKnowledge（再読込はしない。作成直後に同期クライアント等が触る可能性を考慮しても、書いた内容が正）。

### 14.2 排他作成（`FilesystemVaultStorage.createExclusive`）

- `fs.open(target, 'wx')`（`O_CREAT | O_EXCL`）で開く。**存在確認と作成が1つのsyscallで原子的** に行われるため、確認後に別プロセスが作成しても上書きしない。ファイル・Directory・symlink（壊れたものを含む）のいずれかが存在すれば `EEXIST`。
- `EEXIST` → `InputValidationError('knowledge "obsidian:<path>" already exists; use knowledge_search and knowledge_append to add to it')`（idを示してAIが次の手を選べるようにする）。
- 開いたHandleへ `writeFile(text, 'utf8')`（BOMなし）→ `close`。
- 書き込み途中で失敗した場合は、作成した空・途中のファイルを `unlink` してから `ProviderApiError`（中途半端なKnowledgeを残さない。unlink失敗は握りつぶし、`cause` に残す）。
- 一時ファイル + rename方式は採らない（`rename` は既存ファイルを上書きするため排他にならない。`link` 方式は同期フォルダの仮想FSで使えない場合がある）。
- 同名チェックは `knowledge_dir` 直下のみ。サブDirectoryに同名ファイル（`AI/CAP定理.md`）があっても直下には作成できる（Q8）。

---

## 15. recursive search

### 15.1 走査（`FilesystemVaultStorage.list`）

- `knowledge_dir` の実パスから `fs.readdir(dir, { withFileTypes: true })` で再帰的に走査（自前の再帰。`recursive: true` オプションはsymlinkの扱いを制御しにくいため使わない）。
- 対象: `Dirent.isFile()` かつ名前が `.md` で終わるもの。
- 除外:
  - symlink / Junction（`Dirent.isSymbolicLink()`。Windows JunctionもNodeではsymlinkとして報告される）: ファイル・Directoryとも辿らない（§20）。
  - その他（FIFO等）。
- `.` で始まる名前のFile / Directory（`.archive/note.md` 等）は **除外しない**。仕様は「`knowledge_dir` 以下を再帰的に検索」「対象は `.md`」のみを定めており、dot-prefixによる除外は定義していないため。`.obsidian` 等を除外したい要件が出た場合は、明示的なignore仕様として別途追加する（PR #6 再レビュー [P2]）。
- 各ファイルの `mtime` を `fs.stat` で取得（並び順用）。
- 走査中に消えたエントリ（`ENOENT`）は黙ってスキップ（同期・人間の操作との競合）。それ以外のerrnoは `ProviderApiError`（§21）。
- 深さ上限は設けない。symlink / Junctionを辿らないためDirectory循環は起きない。再帰はDirectoryごとの非同期呼び出し（またはDirectoryのstack）で行い、深いDirectory構造でもcall stackに依存しない実装にする。

### 15.2 読み込みと照合（Connector）

1. `list()` の各ファイルを `read()`（逐次ではなく並列度8程度で読む。`Promise.all` に全件を投げるとFile Handleを使い切るため、小さなconcurrency helperをConnector内に置く）。
2. `parseFile()` → Malformedなら除外して件数を数える（他ファイルの検索は継続）。`read()` 時に `NotFoundError`（走査後に削除）なら黙って除外。
3. `matches(meta, body, filter)`（§16）。
4. 一致したものを `KnowledgeSearchResult`（metadata + snippet）へ変換。
5. Malformedが1件以上なら `warn('knowledge_search skipped N file(s) with malformed frontmatter: <vault-relative paths, 最大10件>')`。Tool Resultには含めない（Collectionと同じ扱い）。

並び順: `modifiedAt` 降順、同値は `id` 昇順（「前に何をメモした？」で最近のものが先に来るように。Notionの `last_edited_time` 降順と揃える）。

件数上限は設けない（Collectionと同じ）。Vaultが大きくなった場合の懸念は §29 その他。

---

## 16. query / area / tags filter（`search.ts`）

```ts
function matches(meta, body, filter): boolean
```

| Filter | 規則 |
|---|---|
| `query` | `fold(x) = x.toLowerCase()` とし、`fold(query)` が `fold(title)` / `fold(description ?? '')` / 各 `fold(tag)` / `fold(body)` のいずれかの部分文字列ならHit。本文はFrontmatterを除いたもの（未知Frontmatter Keyは検索しない）。queryはtrimしない |
| `area` | 値 → `meta.area === area`。`null` → `meta.area === null` |
| `tags` | 指定されたすべてのtagを持つ（AND）。各tagを §12.6 で検証（違反は `InputValidationError`）し、`tagKey()` 同士で比較する（大文字小文字を区別しない。Q7）。Nested tagの親一致はしない |
| 空Filter `{}` | 全件（Malformed除く） |

- `toLowerCase()` はロケール非依存。全角英字も小文字化される。ひらがな / カタカナの同一視、Unicode正規化、fuzzyはしない（仕様Out of Scope）。

## 17. snippet生成（`search.ts`）

```ts
const SNIPPET_LENGTH = 160;   // code point数
const SNIPPET_LEAD = 40;      // Hit位置より前に含める code point数
```

1. 本文の空白類（改行含む）を半角空白1つに畳み、trimしたテキスト `flat` を作る（snippetは表示用の抜粋のため）。
2. `query` があり、`fold(flat)` 中に `fold(query)` がHitし、かつ `fold(flat).length === flat.length`（小文字化で長さが変わる特殊文字がない）なら、Hit位置の `SNIPPET_LEAD` code point前から `SNIPPET_LENGTH` code pointを切り出す。
3. それ以外（queryなし・本文にHitなし（title等でHit）・長さ不一致）は `flat` の先頭から `SNIPPET_LENGTH` code point。
4. 切り詰めた側に `…` を付ける。本文が空なら `""`。
5. 切り出しは `Array.from()` のcode point単位（サロゲートペアを分断しない）。

snippetは最大 `160 + 2` code pointで、本文全文の代替にはならない。

---

## 18. get

1. `knowledgeDir` 確認 → `parseKnowledgeId(id, knowledgeDir)`（§10。形式違反は `InputValidationError`）。
2. `storage.checkKnowledgeDir()`。
3. `storage.read(path)`:
   - 実パス検証（§20）。範囲外 → `InputValidationError`。
   - `ENOENT` / `ENOTDIR` / 対象がDirectory等の通常ファイル以外 → `NotFoundError('knowledge "obsidian:<path>" was not found; it may have been moved or deleted — search again with knowledge_search')`。
4. `parseFile()` → Malformed → `ProviderApiError('Obsidian', 'the frontmatter of "obsidian:<path>" is malformed (<reason>); fix it in Obsidian')`。自動修復しない。
5. `{ knowledge, content }` を返す。

## 19. append時のFrontmatter非変更・改行処理

### 19.1 手順

1. `parseKnowledgeId` → `checkKnowledgeDir` → `storage.read(path)`（get と同じError）。
2. `parseFile()` → Malformed → `ProviderApiError`（**書き込みを行わない**）。
3. 追記テキストを計算（§19.2）。
4. `storage.append(path, text)`: `fs.open(target, O_WRONLY | O_APPEND)`（`O_CREAT` なし）で開いて **末尾へのみ書く**（ファイル先頭のFrontmatterバイト列には一切触れない）。開く前に実パス検証を再度行う（§20.2）。`ENOENT` → `NotFoundError`。
5. 返却: 読み込み時のmetaとID（Frontmatterは変更していないため、読み込み時の値が追記後の値）。

ファイル全体を書き直さない（read-modify-write しない）ことで、Frontmatter非変更を保証し、読込〜書込の間に人間が編集した内容を失う可能性を最小にする（末尾以外の同時編集は保持される）。

### 19.2 改行処理

`computeAppendText(existing: string, content: string): string`（純粋関数）:

1. 改行コード: 既存ファイルに `\r\n` が含まれる場合はCRLF、それ以外はLFを使う。`content` 内の改行をその改行コードへ統一する（1ファイル内で混在させない）。
2. 区切り（既存テキスト全体の末尾を見る。Frontmatterのみのファイルも同じ規則）:

| 既存の末尾 | 補う区切り | 結果 |
|---|---|---|
| 空ファイル | なし | `content` |
| 改行なしで終わる | 改行2つ | `…本文\n\ncontent` |
| 改行1つで終わる | 改行1つ | `…本文\n\ncontent` |
| 空行（改行2つ以上）で終わる | なし | 既存の空行を保持 |

3. `content` が改行で終わらない場合は末尾に改行を1つ付ける（次のappendや人間の編集で行が繋がらないように）。
4. それ以外の整形（日時・見出し・箇条書き化・空白除去・既存の末尾空行の削除）はしない。

空行1つで区切るのは、Markdownでは単一改行だけだと前の段落と1つの段落に結合されて「潰れる」ため（Q11）。

### 19.3 例

```text
既存: "---\ntitle: CAP定理\n---\n\nCAP定理では……\n"
content: "PACELCについても関連して調べた。"
結果:   "---\ntitle: CAP定理\n---\n\nCAP定理では……\n\nPACELCについても関連して調べた。\n"
```

### 19.4 読込と書込の間の競合

`read()` と `append()` の間にファイルが移動・削除された場合、`append()` は `ENOENT` → `NotFoundError`（`O_CREAT` なしで開くため、消えたファイルを新規作成しない）。末尾の内容が変わった場合、区切りの改行数がずれる可能性は残る（単一利用者のローカル利用で許容。Multi-device Lockは仕様Out of Scope）。

---

## 20. Path Traversal / symlink対策

二重防御とする。

### 20.1 論理検証（`id.ts`、I/Oなし）

§10.2の規則でID / Config値を検証する。`..`、絶対パス、`\`、drive letter、NUL、非.md、`knowledge_dir` 外をここで拒否する。

### 20.2 実パス検証（`filesystem-storage.ts`）

対象ファイルへアクセスする前に毎回行う。

1. `rootReal = knowledgeDirReal`（§8.2の検証済み実パス。Vault Rootから `knowledge_dir` までにsymlink / Junctionがなく、`vaultReal` 配下であることを確認済み。違反は `ConfigurationError`）。
2. `rootReal` からVaultPathの残りsegmentを1つずつ辿り、各要素を `fs.lstat`:
   - `isSymbolicLink()`（Windows Junction含む）→ `InputValidationError('"obsidian:<path>" goes through a symbolic link, which is not supported')`。
   - 途中のsegmentがDirectoryでない / `ENOENT` → `NotFoundError`。
   - 最後の要素が通常ファイルでない → `NotFoundError`。
3. 最後に `realpath(target)` を取り、`path.relative(rootReal, targetReal)` が空でなく、`..` で始まらず、絶対パスでないことを確認（文字列prefix比較ではなくsegment関係で判定）。満たさない → `InputValidationError`。Windowsの大文字小文字非区別は `path.relative` が吸収する。
4. createでは、親（`rootReal` 自身）を辿るだけで、作成対象は `wx` が「既存のsymlink」でも `EEXIST` で失敗するため、symlink経由で外へ書くことはない。

- symlinkはサポートしない（仕様: 要件としない）。search では辿らずスキップ、get / append では拒否する。
- TOCTOU（検証後・open前のsymlink差し替え）は、単一利用者のローカル環境では脅威モデル外とする。Linuxの `O_NOFOLLOW` 等の追加対策はしない（Windowsで同等の手段がなく挙動が揃わないため）。

---

## 21. Filesystem Error Mapping

`FilesystemVaultStorage` 内の `toFoundationError(error, context)` で変換する。Messageには **Vault相対のid / 設定Key名だけ** を入れ、errnoの生Message（絶対パスを含む）は入れない。元のErrorは `cause` に保持する（MCP Clientへは `message` のみが返る、`src/errors.ts` 冒頭のとおり）。

| 状況 | errno / 条件 | AI Foundation Error |
|---|---|---|
| `vault_path` 未設定 | — | `ConfigurationError`（Key名を示す） |
| `knowledge_dir` 未設定 | — | `ConfigurationError` |
| Vault不在・Directoryでない・読めない | `ENOENT` / `ENOTDIR` / `EACCES` / `EPERM`（Root解決時） | `ConfigurationError`（絶対パスなし） |
| Knowledge Directory不在・Directoryでない | 同上 | `ConfigurationError`（Vault相対の `knowledge_dir` を示す） |
| Vault Rootから `knowledge_dir` までにsymlink / Junction、または実パスがVault外 | §8.2 | `ConfigurationError`（Tool呼び出し時の環境不正） |
| 不正ID形式・範囲外・非.md・symlink経由 | §10 / §20 | `InputValidationError` |
| 同名ファイルが存在（create） | `EEXIST` | `InputValidationError`（idと `knowledge_append` を案内） |
| 生成filenameが不正・長すぎる | §13 | `InputValidationError` |
| exact ID対象が存在しない | `ENOENT` / `ENOTDIR` / 非通常ファイル | `NotFoundError` |
| Malformed Frontmatter（get / append） | §12.3 | `ProviderApiError('Obsidian', ...)` |
| 対象ファイルの読み書き権限なし | `EACCES` / `EPERM`（ファイル単位） | `ProviderApiError('Obsidian', 'cannot read/write "obsidian:<path>" (EACCES)')` |
| ファイル名がFSで使えない（予期しない文字等） | `EINVAL` / `ENAMETOOLONG`（create） | `InputValidationError`（titleの見直しを案内） |
| ディスク容量不足・I/O Error・その他 | `ENOSPC` / `EIO` / `EBUSY` / その他 | `ProviderApiError('Obsidian', 'filesystem error (<code>)')` |

- errno `code` だけはMessageに含めてよい（パスを含まず、原因調査に有用）。
- Retryはしない（仕様: 独自Retry FrameworkはPhase 4では追加しない）。Google Drive同期中の一時的な `EBUSY` 等もそのまま `ProviderApiError` を返す。
- Credential Errorは使わない。

---

## 22. 実装順序

各Stepの終わりで `npm run typecheck` と `npm test` を通す。Commitは概ねStep単位。

1. **Domain**: `KnowledgeSchema.description`、Input / Result Schema。`tests/domain/knowledge.test.ts`。
2. **Config**: `obsidian` Block、`VaultRelativeDirSchema`、`config.yaml`、`.env.example`。`tests/config/*`。
3. **純粋関数**: `id.ts` → `filename.ts` → `markdown.ts` → `search.ts` と各Test。
4. **Storage**: `storage.ts`（Interface）→ `filesystem-storage.ts`。一時DirectoryでのTest（symlink・errno含む）。
5. **Connector**: `types.ts` の `KnowledgeConnector` → `connector.ts`。一時Vaultでのcreate / search / get / append / 外部編集Test。
6. **Tools**: `tools/knowledge.ts`（source / area解決）、`FakeKnowledgeConnector`、`tests/tools/knowledge.test.ts`。
7. **配線**: `connectors/index.ts`、`tools/index.ts`、`tests/server.test.ts`、`tests/e2e/stdio.test.ts`（13 Tool）。
8. **Docs**: README（Current Phase、Tool一覧、Obsidian Setup、`config.local.yaml` 例、Directory Structure）。
9. **Integration Test** を追加し、検証専用Vaultで実行（§25）。
10. **手動Verification / LLM Client Verification**（§25, §26）。結果を本Planの「実装・Integration Verificationで確定した事項」に追記。
11. Codex Implementation Review → 指摘修正。

## 23. 依存Package

**追加なし。**

| 用途 | 利用 |
|---|---|
| YAML Frontmatter parse / serialize | 既存 `yaml ^2.9.1`（Configでも使用中） |
| Filesystem | `node:fs/promises`, `node:path`（`filesystem-storage.ts`。Config Schemaは `path.isAbsolute` のみ） |
| Test用一時Directory | `node:fs/promises.mkdtemp` + `node:os.tmpdir()` |

Markdown parser（remark等）は使わない。本文はテキストとして扱い、Frontmatter区切りだけを解釈する。

---

## 24. Test Strategy

### 24.1 方針

- 通常のTest Suite（`npm test`）は個人Vault・Google Drive同期・ネットワークに依存しない。Filesystemを使うTestは `mkdtemp` で作る一時Vaultのみを使い、`afterEach` で削除する。
- Tool LayerはFake Connectorで、Connector / StorageはOSの一時Directory上の実Filesystemでテストする（仕様: Filesystem / Obsidian Connectorのテストでは一時Directory等を利用）。
- 日本語のfilename / 本文を各層のTestに含める。

### 24.2 Domain / Config

- `KnowledgeSchema`: `description` が `null` / 文字列で通り、不在で失敗。`source: google_drive` は通る（予約）。
- `KnowledgeCreateInputSchema`: title / content必須・空白のみ拒否、`source: google_drive` 拒否、`area: null` 許容、未知Key拒否。
- `KnowledgeSearchFilterSchema`: `{}` 許容、`area: null` 許容。
- `KnowledgeAppendInputSchema`: 空白のみcontent拒否。
- Config: `obsidian` Blockなしで起動可、`storage: google_drive` 拒否、`knowledge_dir` の `..` / 絶対パス / `\` / `.` / 先頭 `/` 拒否、`vault_path` 相対パス拒否、既存fixtures（`google_drive` を含むproviders）が引き続き通る。

### 24.3 純粋関数

| File | 主なケース |
|---|---|
| `id.test.ts` | 正常（日本語・サブDirectory）、§10.2の各拒否（prefix違い、`..`、`/`始まり、`C:/`、`\`、NUL、`.txt`、`.md`のみ、`knowledge_dir` 外、`Knowledge2` のprefix類似）、`.archive/a.md` のようなdot始まりsegmentは受け付ける |
| `filename.test.ts` | §13の例、禁止文字、制御文字・改行、先頭`.`、末尾`.`、予約名（`con`, `COM1.md`）、200 byte境界（日本語で境界前後）、空になるtitle |
| `markdown.test.ts` | Frontmatterあり（全Key / 一部Key / 未知Key / `key:` null / 空Frontmatter）、Frontmatterなし（filename→title）、Malformed（不正YAML、重複Key、閉じなし、Rootが配列、`area: Work`、`tags: ai`、`tags: [1]`、`tags: ["#ai"]`、`tags: ["1984"]`、`title: 123`）、CRLFファイル、BOM付き、serialize round trip（`:` `#` 含むtitle、`yes`、日本語、null / []の省略）、`computeAppendText` の表（§19.2）全行、CRLF既存ファイルへのappend |
| `tags.test.ts` | §12.6の各規則（許可: `ai`, `distributed-systems`, `inbox/to-read`, `y1984`, `分散システム`, 絵文字 / 拒否: 空、空白・全角空白、`#ai`, `c++`, `a,b`, `1984`, `2024/10`, `/ai`, `ai/`, `ai//rag`）、`tagKey` |
| `search.test.ts` | query: title / description / tag / 本文、大文字小文字、未Hit、Frontmatter中の未知Keyにのみ含まれる語はHitしない。area値 / null、tags AND・大文字小文字無視・違反tagのfilterは `InputValidationError`、snippet: Hit周辺・先頭・`…`・空本文・160 code point上限・サロゲートペア非分断 |

### 24.4 Storage（`filesystem-storage.test.ts`、一時Directory）

- `checkKnowledgeDir`: vault不在 / knowledge_dir不在 / ファイルだった → `ConfigurationError`、Messageに一時Directoryの絶対パスを含まないこと。
- **knowledge_dir経由の境界外アクセス（PR #6 [P1] 回帰Test）**: (a) `knowledge_dir` 自体がVault外DirectoryへのJunction / symlink、(b) 途中segment（`AI Foundation`）がVault外へのJunction / symlink、の各ケースで `checkKnowledgeDir` / `list` / `read` / `createExclusive` / `append` がすべて `ConfigurationError` になり、Vault外Directoryにファイルが作成・変更されないこと。(c) Vault Root自体がJunction / symlinkの場合は正常に動作すること。
- `list`: 再帰、`.md` のみ（`.txt` / `.MD` / 拡張子なしを除外）、dot始まりのDirectory・ファイル（`.archive/a.md`, `.hidden.md`）も返す、深い階層（例: 40階層）も返す、symlinkファイル・Directory（Junction）を辿らない。
- `read`: 不在 → `NotFoundError`、Directory → `NotFoundError`、BOM除去。
- `createExclusive`: 新規作成、既存ファイル / 既存Directory / 既存symlink → `InputValidationError`、内容が上書きされていないこと。
- `append`: 末尾追記のみ（先頭バイト列が不変）、不在 → `NotFoundError`（ファイルが作成されないこと）。
- **境界外アクセス**: `knowledge_dir` 内に外部ファイル / 外部Directoryを指すsymlink・Junctionを置き、`read` / `append` が `InputValidationError` になり外部ファイルが変更されないこと。
- symlink作成はWindowsで権限（Developer Mode / 管理者）が必要なため、Directoryは `junction` 型（権限不要）で作成する。ファイルsymlinkが `EPERM` で作れない環境では該当ケースを `it.skipIf` でスキップし、Junctionケースは常に実行する。CI（未導入）・Linux / macOSでは全ケース実行される。

### 24.5 Connector（`connector.test.ts`、一時Vault）

仕様Automated Test一覧に対応:

| 仕様の項目 | Test |
|---|---|
| create | 違反tag（`1984`, `#ai`, 空白）で `InputValidationError` かつファイル未作成、Frontmatter + 空行 + 本文、UTF-8 / LF（CRLF入力もLFで保存）、末尾改行、返却Metadata、null / []のKey省略 |
| recursive search | 直下・サブDirectory・2階層以上・dot始まりDirectory（`.archive/`）。searchで返したIDでget / appendできること |
| query / area / tags filter | §16の規則をVault上で |
| get | Metadata + 本文、FrontmatterなしMarkdown |
| append | 本文末尾追記・Frontmatterバイト列不変・区切り改行 |
| Frontmatterあり / なし | 両方をsearch / get / append |
| Malformed Frontmatter | searchで除外され他ファイルは返る・`warn` 呼び出し、getは `ProviderApiError`、appendは `ProviderApiError` かつファイル内容不変（バイト比較） |
| 日本語filename / content | create → search → get → append |
| 同名File上書き防止 | 2回目のcreateが `InputValidationError`、1回目の内容が不変 |
| Path Traversal / 絶対パス / 非.md | get / append が `InputValidationError`、Vault外のファイルが不変 |
| symlink等の境界外アクセス | §24.4と同様をConnector経由で（`knowledge_dir` 自体・途中segmentのJunctionでcreate / appendが `ConfigurationError` となりVault外へ書かないことを含む） |
| 外部移動 / 削除後 | Testから `fs.rename` でサブDirectoryへ移動 → 旧idのget / appendが `NotFoundError`、searchで新id。削除 → get / append `NotFoundError` |
| 外部編集 | Testからファイルを書き換え → 次回get / searchに反映（Cacheがないこと） |
| 設定 | `knowledgeDir` / `vault_path` 未設定 → `ConfigurationError` |
| Error Message | すべてのErrorのMessageに一時Vaultの絶対パスが含まれないこと（共通Assertion） |

### 24.6 Tool Layer（`tests/tools/knowledge.test.ts`、Fake Connector）

- 4 Toolの登録、Input Schema検証（`source: google_drive` 拒否など）、Result形状（`structuredContent` とtext JSONが一致）。
- `source` 省略 / `auto` / `obsidian` の解決、`knowledge.default: google_drive` のConfigで `ConfigurationError`。
- `area` 省略 → `defaults.area`、`null` → null がConnectorへ渡ること。
- Connector未設定で `ConfigurationError`、Connectorの `FoundationError` が `isError` 結果になること。

### 24.7 Server / e2e

- `tests/server.test.ts`、`tests/e2e/stdio.test.ts`: Tool一覧13件。e2eは `obsidian` 設定なしの `config.yaml` で起動できること（既存どおり）。

---

## 25. Integration Verification

### 25.1 Integration Test（`tests/integration/obsidian.integration.test.ts`、手動起動）

- `AI_FOUNDATION_INTEGRATION=1 npm run test:integration` で実行。`config.local.yaml`（または `AI_FOUNDATION_CONFIG`）の `sources.knowledge.obsidian` を使う。`vault_path` / `knowledge_dir` 未設定ならskip。
- **検証専用Vault**（または実Vault内の検証専用 `knowledge_dir`）を推奨する旨をREADMEに書く。作成するファイル名には `runLabel` を含め、`afterAll` でTestが作ったファイル・Directoryだけを削除する（Test Code内で `fs` を使う。製品Codeに削除機能は追加しない）。
- 確認: create → Vault上にファイルが存在・内容（Frontmatter / LF / UTF-8）、search（本文query・recursive・area / tags）、get、append、Testからのrename後の旧id NotFound / 新id再発見、外部書き換えの再読込。

### 25.2 手動Verification（Obsidianアプリ）

仕様Integration Verificationの項目をチェックリストとしてPRに記録する。

| 項目 | 手順 |
|---|---|
| Knowledge作成 / Obsidianで閲覧 | `knowledge_create` 後、ObsidianでファイルとPropertiesパネル（title / description / area / tags）が正しく表示される |
| Metadataの読取 | ObsidianでPropertiesを編集 → `knowledge_search` / `knowledge_get` に反映 |
| 本文query / recursive search | Obsidianでサブフォルダへ手動作成したノートが本文queryでHit |
| exact IDによるget / append | append後、Obsidianで本文末尾に追記され、Propertiesが変わっていない |
| Obsidianで編集した内容の再読込 | 本文編集 → get に反映 |
| Obsidianで移動 | ファイルをサブフォルダへドラッグ → 旧idがNot found、searchで新id |
| Google Drive同期フォルダ | Vaultが同期フォルダ内にある場合、AI Foundationは同期操作をせず、ローカルFSの見え方だけで動作すること（同期サービスのE2Eはしない） |

---

## 26. LLM Client Verification

Claude CodeからAI Foundation（stdio）へ接続し、以下を確認してPRに記録する。

| # | 発話 | 期待するTool呼び出し |
|---|---|---|
| 1 | 「今日CAP定理について理解した内容をメモして」 | `knowledge_create`（Task / Collectionと誤ルーティングしない） |
| 2 | 「CAP定理について前に何をメモした？」 | `knowledge_search` → 返却 `id` で `knowledge_get` |
| 3 | 「CAP定理のメモにPACELCについて追記して」 | `knowledge_search` → exact `id` で `knowledge_append`（`knowledge_create` で重複作成しない） |
| 4 | 「distributed-systemsタグのメモを探して」 | `knowledge_search({ tags: ["distributed-systems"] })` |

#3で同名createを試みた場合も、Error Messageが `knowledge_append` を案内するため回復できることを確認する。

---

## 27. Acceptance Criteriaとの対応

| Acceptance Criteria | 対応箇所 | Test / Verification |
|---|---|---|
| Obsidianを論理SoT、Storage AccessはFilesystem | §2, §8 | 構造（`node:fs` / 実パス解決は `filesystem-storage.ts` のみ）をReviewで確認 |
| 絶対パスをID / Tool Resultへ漏らさない | §10, §21 | §24.5 Error Message共通Assertion、id / external_refの形式 |
| Filesystem依存をConnector内に閉じ込める | §8.1 | 同上 |
| 同期Vaultを利用可・同期は管理しない | §8.2, §25.2 | 手動Verification |
| `vault_path` / `knowledge_dir` 設定、Vault相対 | §11 | §24.2 |
| `vault_path` 実値をCommitしない | §11.2 | `config.yaml` はコメント例示のみ |
| `storage: filesystem` | §11.1 | §24.2 |
| 1 Knowledge = 1 Markdown、UTF-8 / LF | §12.5 | §24.5 create |
| Frontmatter ↔ Domain Mapping | §12.3, §12.5, §12.6 | §24.3 markdown / tags |
| 本文をMetadataへ複製しない | §5.1, §5.3 | Result Schema |
| 未知Frontmatter Keyを許容 | §12.3 | §24.3 |
| ID `obsidian:<vault-relative-path>`、移動で新ID | §10 | §24.5 外部移動 |
| create（title / content、description / area / tags） | §14 | §24.5, §24.6 |
| source省略 / auto → default、Obsidianのみ実行可 | §9.1 | §24.6 |
| 安全なfilename、直下作成、上書きしない | §13, §14 | §24.3, §24.4, §24.5 |
| recursive search、.mdのみ | §15 | §24.4, §24.5 |
| query（title / description / tags / body、大文字小文字無視の部分一致）、area完全一致、tags AND、`{}` で一覧 | §16 | §24.3, §24.5 |
| 本文全文を含まずsnippet、RAG非依存 | §5.3, §17 | §24.3 |
| get（exact ID、Metadata + 本文、fuzzyなし） | §6, §18 | §24.5 |
| append（末尾・非破壊・Frontmatter不変・自動整形なし・必要な改行） | §19 | §24.3, §24.5 |
| FrontmatterなしのMarkdown（Default Mapping） | §12.3 | §24.3, §24.5 |
| Malformed: search除外・get / append Error・append非書込・自動修復なし | §12.3, §15.2, §18, §19.1 | §24.5 |
| 独自DB / Cacheなし、外部編集・移動・削除の反映 | §2, §8.2 | §24.5 |
| Read / Write範囲をknowledge_dirに限定、Traversal・絶対パス・非.md・範囲外・symlink拒否 | §8.2, §10, §20 | §24.3, §24.4, §24.5 |
| createで上書きしない | §14.2 | §24.4, §24.5 |
| Error分類（4分類）、Credential Error不要、Messageに絶対パス / Secretなし | §21 | §24.4, §24.5 |
| Tool LayerはFake Connector、Connectorは一時Directory、個人Vault非依存 | §24.1 | `npm test` |
| Integration Verification | §25 | PR記録 |
| LLM Client Verification | §26 | PR記録 |

---

## 28. クラウドStorage差し替え時に維持する境界

将来 `storage: google_drive`（`vault_folder_id`）等を追加する場合に **変えないもの**:

| 維持するもの | 内容 |
|---|---|
| Knowledge ID | `obsidian:<vault-relative-path>`。Storageに依らずVault相対パス（Drive File IDをIDにしない） |
| `external_ref` | Vault相対パス |
| Tool IF | 4 ToolのInput / Result Schema |
| Domain | `KnowledgeSchema`（`source: obsidian`。Storage種別はDomainに出さない） |
| Markdown構造 | Frontmatter規則・append区切り（`markdown.ts` はStorage非依存の純粋関数） |
| filename規則 / 検索規則 / snippet | `filename.ts` / `search.ts`（純粋関数） |
| `knowledge_dir` の意味 | Vault相対のDirectory |

**差し替えるもの**: `VaultStorage` の実装1つ（`FilesystemVaultStorage` → 例 `GoogleDriveVaultStorage`）と、`config/schema.ts` の `obsidian.storage` の判別Union、`connectors/index.ts` の生成分岐。Drive側では「排他作成」「末尾追記」「symlink」の意味が異なるため、`VaultStorage` の各メソッドの契約（存在すればError、末尾のみ変更、knowledge_dir外に出ない）をInterfaceのdoc commentとして明記しておく。

Phase 4ではGoogle Drive実装・判別Unionは作らない（`storage: z.literal('filesystem')` のみ）。

---

## 29. 懸念点 / 未確定事項

Plan Reviewで判断をお願いした項目。PR #6 レビューでQ1〜Q6, Q8〜Q12は提案どおり合意、Q7は [P2] を受けて修正した（rev.2）。

### Q1. 作成時、値のないKey（description / area / tags）を省略する（合意済み）

- 提案: `description: null`、`area: null`、`tags: []` のKeyはFrontmatterに書かない。`title` は常に書く。
- 理由: Obsidianで `description: null` と表示されるのを避け、人間が読むFrontmatterを簡潔に保つ。読み取り時は不在 = 既定値のためDomain上の差はない。
- 代替: 常に4 Keyを書く（`description:` 空、`tags: []`）。

### Q2. `tags: ai`（単一文字列）・`tags:` に `#` 付き文字列（合意済み。`#` 付きはrev.2でMalformedに変更）

- 決定: 単一文字列はMalformed（仕様「既知Fieldが不正な型」）。配列要素の `#ai` はrev.2で §12.6 のTag規則違反としてMalformedにする（rev.1の「そのまま扱う」から変更。[P2]）。
- 懸念: Obsidianは `tags: ai` やカンマ区切りを受け付けるため、人間が手書きしたノートがsearchから外れる可能性がある。寛容に `[ai]` として読む案もあるが、仕様文言に合わせて厳格側を提案する。

### Q3. 開始 `---` はあるが閉じ区切りがないファイル（合意済み）

- 提案: Malformed（search除外・get / append Error）。
- 理由: 本文の先頭が水平線 `---` のノートとFrontmatter書きかけの区別がつかず、appendで誤って書き込むより安全側に倒す。Obsidianはこの場合Frontmatterなしとして表示する点が異なる。

### Q4. Knowledge Directoryが存在しない場合に自動作成しない（合意済み）

- 提案: 自動作成せず `ConfigurationError`（仕様Error Mapping「Vault / Knowledge Directoryが利用不能」）。READMEのSetupで作成手順を示す。
- 代替: `knowledge_create` 時のみ `mkdir -p` する。誤った `vault_path` で意図しない場所にDirectoryを作るリスクがあるため提案しない。

### Q5. `vault_path` は絶対パス必須、`~` / 環境変数の展開なし（合意済み）

- 提案: 絶対パスのみ（相対パスはServerの作業Directoryに依存し、MCP Clientから起動すると予測しにくいため）。展開機能は追加しない。

### Q6. filename: 予約名・200 byte超はError（truncateしない）（合意済み）

- 提案: Windows予約名と、名前部分がUTF-8で200 byteを超えるtitleは `InputValidationError`。
- 理由: 黙って別名（`CON_` や切り詰め）にすると、AIとUserがファイル名を予測できず同名チェックの意味も変わる。200 byteは255 byte制限（ext4 / Google Drive）に余裕を持たせた値。

### Q7. tagsのObsidian制約と大文字小文字（rev.2で修正済み: §12.6）

- 決定（rev.2）: Obsidian公式のTag規則（§12.6）を `tags.ts` に集約し、create（`InputValidationError`）・Frontmatter parse（Malformed）・search filter（`InputValidationError`）で同じ規則を使う。比較は大文字小文字を区別しない。
- 以下はrev.1の提案（create時のみ検証しparseと不整合、数字のみtagを見ていなかったため [P2] で修正）。

- 提案: create時、空白・`,` を含むtag、`#` 始まりのtagは `InputValidationError`（Obsidian上でTagとして認識されないため）。search の `tags` Filterは大文字小文字を区別しない（Obsidianの挙動に合わせる）。保存は入力の表記のまま。
- 代替: 制約なし・完全一致。

### Q8. 同名チェックは `knowledge_dir` 直下のみ（合意済み）

- 仕様どおり直下へ作成し、直下の同名だけを防ぐ。サブDirectoryへ整理済みの同名ノートがあっても新規作成される。Tool Descriptionで「作成前に `knowledge_search` で既存を確認する」ことを案内するに留め、Foundation側では全体の同名検索をしない（作成のたびに全走査になるため）。

### Q9. Unicode正規化しない（合意済み）

- ID・filename・検索でNFC / NFD正規化をしない。macOS上のNFDファイル名でもOSが返すcode pointのままIDにする。IDはsearchから得たものをそのまま使う前提のため実害は小さい。

### Q10. `.md` は小文字のみ（合意済み）

- `.MD` / `.Md` は対象外（search除外・ID拒否）。Obsidianも `.md` を前提とする。

### Q11. appendの区切りは空行1つ（合意済み）

- 仕様「必要な改行のみ補う」を「段落が結合しない最小の改行（空行1つ）」と解釈した（§19.2）。既存末尾が空行ならなにも足さない。単一改行のみにする（リスト項目の追記で空行が入らない）案もあるが、段落結合を防ぐ方を提案する。

### Q12. searchの並び順と件数（合意済み）

- 提案: 更新日時（mtime）降順、上限なし。同期フォルダではmtimeが同期で変わり得るが、並び順の参考値として許容する。

### その他

- **検索性能**: 毎回全ファイルを読む（Index非保持は仕様要件）。数千ファイル規模までは問題ない見込みだが、Google Driveの「ストリーミング」モード（オンライン専用ファイル）では読み込みがダウンロードを伴い遅くなる。Phase 4では対策しない（READMEで「ミラーリング」推奨を記載）。
- **同期による競合ファイル**: Google Driveが作る `CAP定理 (1).md` 等も通常のKnowledgeとして検索に出る（自動解決しない。仕様Out of Scope）。
- **大きなファイル**: サイズ上限は設けない。巨大な `.md` があるとsearchが遅くなる。
- **Windows長パス**: Node.jsは `fs` で長いパスを扱えるが、Obsidian / 同期クライアント側の制限は別。filename 200 byte制限で実用上は回避できる見込み。
- **TOCTOU**: §19.4 / §20.2 のとおり、単一利用者ローカル環境のため追加対策しない。
- **`instructions.ts`**: KnowledgeのSoT記述（Obsidian / Google Drive）はMVP §15の論理定義のため変更しない。

---

## 30. Review対応履歴

### rev.2（PR #6 レビュー反映）

| 指摘 | 対応 |
|---|---|
| [P1] `knowledge_dir` 自体・途中segmentのsymlink / JunctionでVault外へ抜けられる | §8.2: symlinkを許可するのはVault Root（`vault_path`）のみとし、`vaultReal` から `knowledge_dir` までの各segmentを `lstat` してsymlink / Junctionを `ConfigurationError` で拒否、`knowledgeDirReal` が `vaultReal` 配下であることを検証。§20.2 / §21を整合。§24.4 / §24.5に回帰Test（knowledge_dir自体・途中segmentのJunction / symlinkで書き込めない、Vault Root自体のJunctionは動作する）を追加 |
| [P2] Tag validationがcreate / readで不整合、Obsidian規則（数字のみ不可等）の一部しか見ていない | §12.6を新設し、Obsidian公式規則に沿った `tagProblem` / `tagKey` を `tags.ts` に集約。create・Frontmatter parse・search filterで同じ規則を使う。§12.3 / §14.1 / §16 / §9.2 / Q2 / Q7 / Testを更新 |
| 軽微: `node:path` の利用範囲の記述不整合 | §2 / §4.1 / §23 / §27を「`node:fs` とOS実パス解決はStorageに閉じ込め、Config Schemaは絶対パス形式判定に `node:path` を使う」に統一 |
| Q1〜Q12 | Q7以外は提案どおり合意として記録（§29） |

### rev.3（PR #6 再レビュー反映）

| 指摘 | 対応 |
|---|---|
| [P2] recursive searchが仕様より狭い（dot-prefixed entry除外 + depth 32上限） | §15.1: dot始まりのFile / Directoryを除外せず、固定の深さ上限も撤廃（symlinkを辿らないため循環しない）。§10.2: dot始まりsegmentの拒否（旧規則8）を削除し、searchで返したIDをそのままget / appendできるようにした。§11.1の `knowledge_dir` 形式検証からもdot始まりsegmentの禁止を外して整合。§8.1のdoc comment、§24.3 / §24.4 / §24.5のTestを更新。将来 `.obsidian` 等を除外する場合は明示的なignore仕様として追加する |
