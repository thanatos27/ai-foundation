# REST API — Design

[Issue #31](https://github.com/thanatos27/ai-foundation/issues/31) の仕様。実装の詳細は [Implementation Plan](../plans/rest-api-implementation-plan.md) を参照。

## Goal

既存の7 Entity・21操作を、MCPと同じ操作ルールのままREST API（JSON over HTTP）から利用できるようにし、OpenAPIで仕様を公開する。クラウド化の第一段階で、各外部サービスをSource of Truthとする方針と、AI Foundation自身に業務データのDBを持たない方針を維持する。

## 対象外

Knowledge／Life LogのGoogle Drive対応、クラウド配置・デプロイ・HTTPS終端、接続先クライアントとの実接続、ダッシュボード、Remote MCP。REST APIとOpenAPIを公開するだけで、AIサービスへ自動登録・接続されるものではない。

## 構成

| Layer | 責務 |
|---|---|
| `src/operations/` | MCP・HTTP共通の操作定義：説明、入出力Schema、Connector選択、未設定時のError、既定値、再実行時の性質 |
| `src/tools/` | MCP Toolとして登録（annotationsはMCP固有） |
| `src/http/` | 認証、path / query / bodyの読み取りと検証、Domain入力の組み立て、payload・ErrorのJSON化、OpenAPI生成 |
| `src/connectors/` | Provider固有処理。HTTP・MCPに依存しない |

HTTP ServerはMCP Server（stdio）とは別の起動口（`src/serve-http.ts`）で、MCP Serverの起動・動作は変えない。

## 起動・設定

| 項目 | 内容 |
|---|---|
| 起動 | `npm run start:http`（`dist/serve-http.js`）/ `npm run dev:http` |
| 引数 | `--config <path>`、`--no-env-file`、`--host <host>`、`--port <port>` |
| `AI_FOUNDATION_API_KEY` | 必須。32文字以上の印字可能ASCII（`\x21-\x7e`）。前後の空白は無視する。未設定・不正なら理由をstderrに出して終了コード1で終了する（Configより先に検査する）。MCP Serverはこの変数を読まない |
| `AI_FOUNDATION_HTTP_HOST` | 既定 `127.0.0.1`。loopback以外で待ち受けるとHTTPS終端の後ろに置くよう警告する |
| `AI_FOUNDATION_HTTP_PORT` | 既定 `8787`。0〜65535（0は空きPort） |
| 優先順位 | 引数 > 環境変数 > 既定値。APIキーは環境変数からのみ読む（Process一覧に出さないため） |
| 終了 | SIGINT / SIGTERMで受付を止めて終了する（最大10秒） |

APIキーはRepository・Configに保存しない。キーの変更は環境変数の更新と再起動で行う。

## 認証

- `Authorization: Bearer <APIキー>`（schemeは大文字小文字を区別しない）。
- 全Request（`/openapi.json`、存在しないpathを含む）でRoutingより前に検査し、未指定・不一致はConnectorを呼ばずに401（`unauthorized`、`WWW-Authenticate: Bearer`）を返す。
- 比較は両者のSHA-256に対する定数時間比較で、キーの長さを推測させない。
- 認証できれば全操作を利用できる。利用者管理・OAuth・接続先別キー・権限分割は持たない。
- HTTP Server自体はHTTPSを終端しない。公開運用ではHTTPSを終端するReverse Proxy等の後ろに置く。

## HTTP共通仕様

- ベースパスは `/v1`。Request・ResponseはJSON。Request bodyは `application/json` のみで、上限は1 MiB。
- 一覧・検索の条件はquery parameter、作成・更新・追記の内容はJSON body。
- 作成成功は `201`、それ以外の成功は `200`。
- 更新は `PATCH`。省略した項目は変えず、`null` は既存仕様で解除できる項目にのみ使える。
- 日付は `YYYY-MM-DD`、日時は明示的なオフセット付きISO 8601。
- 未知のquery parameter・body fieldは400（MCPの入力と同じく誤記を無視しない）。
- 自動再試行はしない。タイムアウト・切断で結果が分からない場合も、成功やロールバックを推測しない。

## エンドポイント

| operationId | Method・Path | 入力 | 成功 | payload |
|---|---|---|---|---|
| `task_list` | `GET /v1/tasks` | query `status[]` `area` `due_before` `due_after` `tags[]` | 200 | `{ tasks: Task[] }` |
| `task_create` | `POST /v1/tasks` | body | 201 | `{ task: Task }` |
| `task_update` | `PATCH /v1/tasks/{id}` | body | 200 | `{ task: Task }` |
| `task_complete` | `POST /v1/tasks/{id}/complete` | なし | 200 | `{ task: Task }` |
| `schedule_list` | `GET /v1/schedules` | query `start`* `end`* `calendar` | 200 | `{ schedules: Schedule[] }` |
| `schedule_create` | `POST /v1/schedules` | body | 201 | `{ schedule: Schedule }` |
| `schedule_update` | `PATCH /v1/schedules/{id}` | body | 200 | `{ schedule: Schedule }` |
| `collection_search` | `GET /v1/collection-items` | query `query` `collection_type` `status` `tags[]` | 200 | `{ items: CollectionItem[] }` |
| `collection_create` | `POST /v1/collection-items` | body | 201 | `{ item: CollectionItem }` |
| `collection_update` | `PATCH /v1/collection-items/{id}` | body | 200 | `{ item: CollectionItem }` |
| `knowledge_search` | `GET /v1/knowledge` | query `query` `area` `tags[]` | 200 | `{ items: KnowledgeSearchResult[] }` |
| `knowledge_create` | `POST /v1/knowledge` | body | 201 | `{ knowledge: Knowledge }` |
| `knowledge_get` | `GET /v1/knowledge/entry` | query `id`* | 200 | `{ knowledge: Knowledge, content: string }` |
| `knowledge_append` | `POST /v1/knowledge/entry/append` | query `id`*、body `{ content }` | 200 | `{ knowledge: Knowledge }` |
| `project_list` | `GET /v1/projects` | query `query` `owner` | 200 | `{ items: Project[] }` |
| `project_get` | `GET /v1/projects/entry` | query `id`* | 200 | `{ project: Project, details: GitHubProjectDetails }` |
| `area_list` | `GET /v1/areas` | query `query` | 200 | `{ items: Area[] }` |
| `area_get` | `GET /v1/areas/{id}` | なし | 200 | `{ area: Area, content: string }` |
| `lifelog_create` | `POST /v1/lifelogs` | body | 201 | `{ lifelog: LifeLog }` |
| `lifelog_get` | `GET /v1/lifelogs/{id}` | なし | 200 | `{ lifelog: LifeLog, content: string }` |
| `lifelog_append` | `POST /v1/lifelogs/{id}/append` | body `{ content }` | 200 | `{ lifelog: LifeLog }` |

`*` は必須。operationIdはMCPのTool名と同じで、説明文中の他操作への参照（"use task_complete" 等）がそのまま通じる。payloadはMCP Toolの `structuredContent` と同一で、MCP固有のContent envelopeは含まない。bodyの項目・各操作のルールはMCP Toolと同じ（同じDomain Schemaと操作定義を使う）。

### 入力の渡し方

- 配列のqueryは同名keyの繰り返し（`?tags=a&tags=b`、OpenAPIの `style: form, explode: true`）。値が1つでも配列として扱う。
- `knowledge_search` の `area=none` は `area: null`（areaのないKnowledge）。queryでは `null` を表せないため。
- IDは既存のFoundation IDを、返された値のままURLエンコード（`encodeURIComponent`）して渡す。HTTP層は1回だけデコードし、正規化しない。
- `/` を含むKnowledge（`obsidian:<vault-relative-path>`）・Project（`github:<owner>/<repository>`）のIDは `id` query parameterで渡す。queryの `+` は空白として読まれるため `%2B` で送る。
- pathの `%2F` はIDの一部として1セグメントのまま扱い、Routeは変わらない。保存範囲外へのアクセス（`..`、絶対パス、`\`、制御文字、symlink・junction、代替データストリーム）は既存のConnector・Vault境界が400で拒否する。

### Scheduleの操作別の制約

| 操作 | `start` / `end` |
|---|---|
| `schedule_list` | 両方必須。日付と日時の混在を許し、混在時の前後関係は設定timezoneでConnectorが検証する |
| `schedule_create` | `start` 必須、`end` 省略可（時刻予定は1時間、終日は1日）。指定するなら同じ種別で `start` 以降 |
| `schedule_update` | どちらも省略可。片方だけなら他方は現予定を維持し、組み合わせをConnectorが検証する |

### 再実行時の性質

各操作のOpenAPI descriptionに記載する。

| 性質 | 操作 |
|---|---|
| 状態を変えない | 一覧・検索・取得 |
| 同じ要求の再送で同じ状態 | `schedule_update` |
| 入力による | `task_update`（`recurrence` を含むと規則を再設定し、次回期限が再計算され得る）、`collection_update`（`append_note` を含むと追記が重複する） |
| 再送で重複・追加の変更 | `task_create` `schedule_create` `collection_create`（重複作成）、`task_complete`（繰り返しTaskは次回分も完了）、`knowledge_append` `lifelog_append`（再追記） |
| 成功後の再送は409 | `knowledge_create` `lifelog_create`（上書きしない） |

## エラー

```json
{ "error": { "code": "invalid_input", "message": "Invalid input: recurrence: due and recurrence cannot be specified together; ..." } }
```

| HTTP | `code` | 発生条件 |
|---|---|---|
| 400 | `invalid_input` | Schema・項目間ルールの違反、不正JSON、JSON以外のContent-Type、Connectorが拒否した入力（不正ID・保存範囲外等） |
| 401 | `unauthorized` | APIキーの未指定・不一致 |
| 404 | `not_found` | 対象がSource of Truthに存在しない |
| 404 | `route_not_found` | 存在しないpath・method（認証後） |
| 409 | `conflict` | 同名のKnowledge・Life Logがある（上書きしない） |
| 413 | `payload_too_large` | Request bodyが1 MiBを超える |
| 502 | `provider_auth_failed` | 外部サービスがAI Foundationの認証情報を拒否した |
| 502 | `provider_error` | 外部サービス（Obsidian Vaultのファイル操作を含む）との通信・処理の失敗 |
| 503 | `credential_missing` | 必要な外部サービスの認証情報が未設定 |
| 503 | `configuration_error` | 必要な設定が未設定・不正 |
| 500 | `internal_error` | 想定外の内部エラー（固定文） |

- レスポンスには例外のcause・stack trace・例外名を含めない。
- SDK・Providerが書いた文（SDK例外のmessage等）は内容を保証できないため、HTTPのmessageでは `(provider details omitted)` に置き換える。対象ID・結果不明・手動確認の案内など、AI Foundationが書いた文は残す。MCPのTool結果は従来どおり全文を返す。
- 5xxはServer側のstderrへ記録する（500はstack trace付き、502・503は1行）。`Authorization` headerは記録しない。

## OpenAPI

- Route定義（`@hono/zod-openapi` の `createRoute`）とZod Schemaから OpenAPI 3.1.0 を生成する。手書きの仕様ファイル・コミット済みの生成物は持たない。
- 認証付きの `GET /openapi.json` で取得する。`npm run --silent openapi` はServerを起動せずに同じdocumentをstdoutへ出力する（APIキー不要、外部通信なし。`--silent` はnpmの実行バナーを出力に混ぜないため）。
- 各operationに operationId、summary、description（共有の説明文、HTTP固有の注記、再実行時の性質）、tag、request（path / query / body）、成功レスポンス、エラーレスポンス（共通 `Error` component）を定義する。全operationに400・401・500・502・503、IDを受けるoperationに404、`knowledge_create` / `lifelog_create` に409、bodyを受けるoperationに413を宣言する。
- 項目間の制約（`due` と `recurrence`、更新は1項目以上、日付と日時の混在等）はOpenAPIのSchemaでは表せないため、descriptionで説明し、実行時に同じルールで検証する。
- `info.description` にSource of Truthの説明とHTTP共通の注意を記載する。説明文中の時間帯・書き込み先Calendar名はConfigから組み立てる。
- `servers` は設定しない（配置先が決まる段階で追加する）。
