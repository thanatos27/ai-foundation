# クラウド配置（Cloud Run） — Design

[Issue #39](https://github.com/thanatos27/ai-foundation/issues/39) の仕様。実装の詳細と実配置の記録は [Implementation Plan](../plans/cloud-run-implementation-plan.md)、手順は [Cloud Run配置手順](../deploy/cloud-run.md) を参照。

## Goal

PCを起動せず、スマホ・Web上のAIクライアントからAI FoundationのREST APIをHTTPSで使えるようにする。既存のHTTP Server（`dist/serve-http.js`）をLinuxコンテナにし、Google Cloud Runへ手動で配置する。

- Domain・操作・REST API・MCP Toolは変えない。stdio MCPはコンテナで起動しない。
- データは既存のSource of Truthにだけ置く。Knowledge／Life Logは `storage: google_drive` を使い、ローカルVault・永続ディスク・独自DBは持たない。

## 対象外

独自ドメイン、ロードバランサー、VPC Connector、独自DB、常駐処理、Cloudflare、ダッシュボード、ChatGPT／Muse向けAdapter、クライアント向けOAuth・ユーザー管理・複数APIキー、分散ロック・複数writerの名前の一意性保証、自動マージ・競合ファイルの整理、自動デプロイ・IaC、全SoTへの書き込みを網羅するE2E基盤、更新日時を維持する特殊な更新への追加対策。

## 構成

| 項目 | 内容 |
|---|---|
| 配置 | Cloud Run Service、`asia-northeast1` |
| イメージ | Node.js 24（`node:24-bookworm-slim`）、マルチステージビルド。実行イメージは `package.json`・production依存・`dist/` のみ。非root（`node`）で実行し、アプリのファイルはroot所有 |
| 起動 | `node dist/serve-http.js --no-env-file --host 0.0.0.0`（exec形式、1コンテナ1 Node Process） |
| Port | `--port` > `AI_FOUNDATION_HTTP_PORT` > `PORT` > `8787`。Cloud Runが設定する `PORT` を使い、`AI_FOUNDATION_HTTP_PORT` は設定しない |
| HTTPS | Cloud Runが終端し、標準URL（`*.run.app`）を使う |
| 認証 | Cloud RunはIAMの認証を要求しない（`allUsers` に `roles/run.invoker`）。アプリの既存Bearer認証（`AI_FOUNDATION_API_KEY`）が全ルート・`/openapi.json` に掛かる。認証なしのヘルスチェック用ルートは持たない |
| 起動確認 | 既定のTCP startup probe |
| 課金・規模 | request-based、最小インスタンス0、最大インスタンス1、1 vCPU、512 MiB、concurrency 80、timeout 300秒、startup CPU boost |
| イメージ保管 | Artifact Registry（同一リージョン）。ローカルDockerでビルドし、テストしたイメージをpushする |

## Config・Credential

- Config: 既存形式の個人用YAML（`storage: google_drive`）をSecret Managerに置き、`/etc/ai-foundation/config.yaml` へファイルとしてマウントする。`AI_FOUNDATION_CONFIG` でそのパスを指定する。イメージに `config.yaml` は含めない。
- Credential: `AI_FOUNDATION_API_KEY`・`TODOIST_API_TOKEN`・`GOOGLE_OAUTH_CLIENT_ID`・`GOOGLE_OAUTH_CLIENT_SECRET`・`GOOGLE_OAUTH_REFRESH_TOKEN`・`NOTION_API_TOKEN`・`GITHUB_TOKEN` を、Secret Managerから同名の環境変数へ注入する。
- Secretはversion番号を指定して注入し、`latest` を使わない。1つのrevisionがイメージdigest・Config・Credentialの組を固定する。
- Google OAuthはCalendar＋Drive認可済みの既存Refresh Tokenを使う。再認可はローカルの `npm run auth:google -- --drive` で行い、新versionとして登録する。
- 実行用Service AccountはSecretごとの `secretAccessor` だけを持つ。デプロイ実行者の権限とは分ける。
- イメージ・ビルドコンテキスト・Repositoryの文書に、Credential・個人用Configの実値、公開URL、Project ID・Project番号を含めない。

## 同時実行（運用条件）

- 最大インスタンス1、1コンテナ1 Processとし、複数のService、revision間のトラフィック分割、同じVaultを使うローカルのMCP Server／HTTP Serverとの並行稼働を意図的には行わない。
- 更新時は呼び出し元からの書き込みを止め、処理中のリクエストが終わってから切り替える。
- 最大インスタンス1は排他の保証ではない。Cloud Runによる一時的な複数インスタンス、更新・ロールバック時の新旧revisionの並行は、[Google Drive保存](google-drive-storage.md)の「名前の一意性は保証しない」（複数Process）の範囲とする。追記は条件付き更新のため、古い内容からの上書きはしない。
- 分散ロック・追加の版履歴検査は持たない。

## 更新・復旧

- 配置は手動。対象commitでtypecheck・build・テストを通し、ローカルでコンテナテストを通したイメージをpushし、digestで配置する。
- ロールバックは前のrevisionへのトラフィック切り替え（100%）で行い、前のイメージ・Config・Credentialの組に戻る。SoTへの書き込みは戻らない。
- 古いイメージはArtifact Registryのcleanup policyで整理し、Secretは直前より古いversionを破棄する。

## 費用

個人・低頻度の利用で、Cloud Run・Artifact Registry・Secret Manager・Cloud Logging・通信を見積もる。0円や月額上限は保証しない。予算アラートは通知であり上限ではない。見積りの前提と確認方法は [Cloud Run配置手順](../deploy/cloud-run.md) に書く。

## Acceptance Criteria

| ID | 条件・観測結果 | 検証方法 |
|---|---|---|
| AC-C01 | Node.js 24コンテナが外部VaultなしでHTTP起動し、設定されたポートを0.0.0.0で待ち受ける。SIGTERMで終了する | ローカルコンテナ起動・終了確認。PORTの優先順位の自動テスト |
| AC-C02 | クラウド上のHTTPS URLでAPIを呼べる。キーなし・不正キーは既存の401、正しいキーで/openapi.jsonと読み取りAPIを利用できる | Cloud Run実配置後の外部HTTP確認 |
| AC-C03 | コンテナを再作成しても同じSoTを参照し、Knowledge 4操作・Life Log 3操作がローカルVaultなしで利用できる | 検証用Driveによるクラウドからの7操作と再起動後の取得 |
| AC-C04 | Secret ManagerからCredentialと個人用Configを注入して既存loaderを利用でき、イメージ・ビルド送信対象・公開資料に実値を含めない | ビルド対象とイメージ内容の確認、注入した設定での実起動。ログ・出力の確認 |
| AC-C05 | APIキー未設定／不正・Config不正では起動失敗を確認できる。既存Provider失敗時のHTTP分類を維持する | コンテナの起動異常系、既存HTTPテスト |
| AC-C06 | request-based、min 0、max 1、1コンテナ1プロセスの設定と、複数writerを意図的に起動しない運用を手順に反映する。Cloud Runの一時的な複数インスタンスを含め、プロセス間の名前の排他を保証しない | 配置設定の確認、既存Drive仕様との整合 |
| AC-C07 | 手順に沿って新しいrevisionへ更新し、問題時に前のイメージ・Config／Secret構成へ戻せる。SoTの更新結果が自動で戻るとは扱わない | 実配置で更新・復旧確認、バージョン対応の記録 |
| AC-C08 | Todoist・Calendar・Notion・GitHubの読み取りと、既存REST API／stdio MCP・Filesystem保存に回帰がない | クラウドからの読み取りsmoke、typecheck・build・通常テスト |
| AC-C09 | Cloud Run以外の保管・ビルド・Secret・通信費を含めた見積りの前提と確認場所、古いイメージの整理方針を残す。無料を無条件に保証しない | 料金表と設定の照合、配置後の利用量確認手順 |

AC-C02〜C04・C07・C08のクラウド側の確認は実配置後に行う。書き込みの確認は検証用データで行い、片付け方法も記録する。
