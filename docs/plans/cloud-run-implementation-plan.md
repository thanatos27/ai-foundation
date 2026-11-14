# クラウド配置（Cloud Run・コンテナ・Config／Secret・更新手順） — Implementation Plan

- Status: **Plan Review待ち**
- 作成: 2026-11-15
- 対象: [Issue #39](https://github.com/thanatos27/ai-foundation/issues/39)
- 参照: [REST API](../specs/rest-api.md), [Google Drive保存](../specs/google-drive-storage.md), [REST API Implementation Plan](rest-api-implementation-plan.md), [Google Drive保存 Implementation Plan](google-drive-storage-implementation-plan.md), [Development Workflow](../development/workflow.md), [AGENTS.md](../../AGENTS.md)

既存のHTTP Server（`dist/serve-http.js`）をLinuxコンテナにし、Cloud Run Service（`asia-northeast1`）へ手動で配置する。Domain・操作・REST APIの仕様・MCP Toolは変えない。コードの変更は待ち受けPortの決め方（`PORT`）だけで、残りはコンテナ定義・テスト・配置手順・ドキュメントである。

本Planは2段階で進める。

1. **Repository変更**: §12の順序でコンテナ定義・Port対応・コンテナテスト・手順書を実装し、ローカルでAC-C01・C04・C05を確認する。
2. **実配置**: Google Cloudのプロジェクト・課金・権限を確認したうえで§9の手順で配置し、AC-C02〜C09のクラウド側の確認を§17に記録する。

ChatGPT／Muse向けの接続設定・Adapter、自動デプロイ、IaCは対象外。

---

## 1. 現在のRepository状態

| 項目 | 状態 |
|---|---|
| Base | `main` の `d509e1a`（Google Drive保存実装済み） |
| 実行環境 | Node `>=24`（手元 24.20.0）、npm `>=11`、TypeScript 5.9、ESM、Vitest 5 |
| ローカルツール | Docker 29.3.1あり。Google Cloud CLI（`gcloud`）は未導入 |
| コンテナ関連ファイル | なし（Dockerfile・.dockerignore・.gcloudignoreなし） |
| CI | なし（`npm test` をローカルWindowsで実行） |

### 既存実装の要点（本Planで利用・変更するもの）

| File | 現状 |
|---|---|
| `src/serve-http.ts` | 引数（`--config` / `--no-env-file` / `--host` / `--port`）→ `.env` → `resolveHttpOptions`（APIキー検証）→ `loadContext` → `serve`。待ち受け開始を `HTTP server listening on http://<addr>:<port>` としてstderrへ出す。loopback以外では警告を出す。SIGINT/SIGTERMで `server.close`、10秒で強制終了 |
| `src/http/options.ts` | Port: `--port` > `AI_FOUNDATION_HTTP_PORT` > `8787`。Host: `--host` > `AI_FOUNDATION_HTTP_HOST` > `127.0.0.1`。`PORT` は参照しない |
| `src/http/auth.ts` | `AI_FOUNDATION_API_KEY` は32文字以上の印字可能ASCII。全ルート（`/openapi.json`・存在しないpathを含む）をBearer認証の後ろに置く |
| `src/http/app.ts` | body上限1 MiB。5xxは1行でstderrへ記録（Provider文を含み得るが資格情報は含まない）。アクセスログは出さない |
| `src/startup.ts` | Config: `--config` > `AI_FOUNDATION_CONFIG` > リポジトリ直下の `config.yaml`（`dist/` の1つ上）。`.env` もリポジトリ直下から読み、`--no-env-file` で読まない |
| `src/config/loader.ts` | 1ファイルだけを読む（重ね合わせなし）。読めない・YAML不正・Schema不正は `ConfigError` で起動失敗 |
| `src/credentials/env.ts` | 7つの環境変数を、各Providerの初回呼び出し時に読む。未設定は `MissingCredentialError`（HTTP 503 `credential_missing`）。起動時には検査しない |
| `src/connectors/obsidian/*` | `storage: google_drive` ではローカルディスクを使わない。作成の直列化はProcess内のみ（[Google Drive保存](../specs/google-drive-storage.md)「作成」） |
| 実行時のファイル参照 | `src/config/loader.ts`（Config）と `src/startup.ts`（`.env`）だけ。他に `readFile`・`cwd`・一時ディレクトリへの書き込みはない |
| `tests/e2e/http.test.ts` | `tsx` で `src/serve-http.ts` を起動する。子Processの環境から `AI_FOUNDATION_*` とCredential変数を除く（`PORT` は除いていない） |
| `tests/startup/http-options.test.ts` | Host・Portの優先順位とAPIキーの検証 |
| `.gitignore` | `.env`・`.env.*`・`config.local.yaml`・`credentials*.json`・`token*.json`・`*.pem`・`*.key` |
| 作業ツリー | 追跡外の `ai-foundation-local-plugin.zip` など、Repositoryに属さないファイルが置かれ得る |

---

## 2. 設計方針

1. **アプリは変えず、外側で合わせる。** Cloud Runのコンテナ契約（`PORT`・`0.0.0.0`・SIGTERM）に合わせるための変更は、`PORT` の読み取りだけにする。Host・`--no-env-file`・Configのパスはコンテナの起動コマンドと環境変数で決める。
2. **イメージに個人の値を入れない。** Config・Credentialは実行時にSecret Managerから注入する。ビルド送信対象は許可リスト（allowlist）で決め、追加したファイルが誤って入らないようにする。
3. **1つのrevisionが「イメージ＋Config＋Secret」の組を固定する。** イメージはdigest、SecretはversionをCloud Runのrevisionに固定する。ロールバックはrevisionの切り替えで行う。
4. **ローカルで確認したイメージをそのまま配置する。** 配置候補は1回だけビルドし、テストしたイメージIDにタグを付けてArtifact Registryへpushし、そのdigestで配置する。テスト後に再ビルドしない。
5. **単一writerは運用条件であり保証ではない。** 最大インスタンス1・1コンテナ1プロセスにするが、名前の排他は既存仕様どおり保証しない。
6. **確認用の認証なしAPIを追加しない。** 起動確認はCloud Runの既定のTCP startup probeに任せる。

---

## 3. 基本設計の具体化・変更点

| # | 内容 | 技術的な理由 | 影響AC |
|---|---|---|---|
| D1 | Portの優先順位を `--port` > `AI_FOUNDATION_HTTP_PORT` > `PORT` > `8787` にする。`PORT` が不正なら `PORT must be a port number …` で起動失敗 | Cloud Runは `PORT` を設定し、利用者は変更できない。`PORT` を読めば同じ値を `AI_FOUNDATION_HTTP_PORT` に二重設定しなくてよい。アプリ固有の変数を優先するのは、手元で別ツールが `PORT` を設定していても既存の起動方法の結果を変えないため（Cloud Runで `AI_FOUNDATION_HTTP_PORT` を誤設定すると待ち受けPortがずれ、startup probeが失敗して新revisionにトラフィックが移らない） | AC-C01 |
| D2 | Hostはコンテナの起動コマンドで `--host 0.0.0.0` に固定する。アプリの既定（`127.0.0.1`）は変えない | ローカル起動の既定を外部公開側へ変えない。コンテナでは常に `0.0.0.0` が必要 | AC-C01 |
| D3 | 起動コマンドは `node dist/serve-http.js --no-env-file --host 0.0.0.0`（exec形式、Nodeが PID 1） | シェルを挟まずSIGTERMがNodeへ直接届く。既存の `process.once('SIGTERM')` で終了する。プロセスマネージャー・複数workerは使わない | AC-C01, AC-C06 |
| D4 | イメージに `config.yaml` を入れない。Configは `AI_FOUNDATION_CONFIG=/etc/ai-foundation/config.yaml` で、Secret Managerからマウントしたファイルを読む | Repositoryの `config.yaml` は `storage: filesystem` で、クラウドでは動かない。入れないことで `AI_FOUNDATION_CONFIG` を付け忘れると `Config file not found` で起動失敗し、誤ったConfigで動かない | AC-C04, AC-C05 |
| D5 | ビルドはローカルDockerで `linux/amd64` を作り、Artifact Registryへpushする。Cloud Buildは使わない | ローカルでテストしたイメージとdigestが一致する。ソースのアップロード（.gcloudignoreの管理）、Cloud Buildのservice account権限・料金が不要になる | AC-C04, AC-C09 |
| D6 | `.dockerignore` は全除外＋許可リスト（`package.json` / `package-lock.json` / `tsconfig.json` / `tsconfig.build.json` / `src/`）にする | 拒否リストでは、作業ツリーに置かれた新しい個人ファイル（`.env.cloud`・zip等）がビルドコンテキストに入り得る | AC-C04 |
| D7 | マルチステージビルド。ビルド段階で `npm ci --ignore-scripts` → `npm run build` → `npm prune --omit=dev`、実行段階には `package.json`・production依存・`dist/` だけを置く。ファイルはroot所有、実行ユーザーは公式Nodeイメージの `node`（uid 1000） | 実行イメージにソース・テスト・devDependenciesを残さない。実行ユーザーはアプリのファイルを書き換えられない。依存にinstall scriptを必要とするものはない（`--ignore-scripts` でビルド・テストが通ることをコンテナテストで確認） | AC-C01, AC-C04 |
| D8 | ベースイメージは `node:24-bookworm-slim` のタグをDockerfileに書き、ビルド時に解決されたdigestを配置記録に残す | Node 24の更新（セキュリティ修正）をビルドのたびに取り込む。実際に配置した中身はイメージdigestで再現できる | AC-C01, AC-C07 |
| D9 | Credential 7つは環境変数として、Configはファイルとして、いずれも**version番号を指定して**注入する（`latest` を使わない） | `latest` だとrevisionが同じでもSecret更新後の起動で値が変わり、ロールバックで前の組に戻らない | AC-C04, AC-C07 |
| D10 | Cloud Run設定: request-based課金（CPUはリクエスト処理中のみ）、`--min-instances 0`、`--max-instances 1`、1 vCPU、512 MiB、`--concurrency 80`（既定値を明示）、`--timeout 300`（既定値を明示）、`--cpu-boost`、`--allow-unauthenticated`、`--ingress all` | 既定値も明示して、配置コマンドから設定を読み取れるようにする。1 Process内では同時リクエストがあっても既存の作成の直列化が効く。`--cpu-boost` は起動時だけCPUを増やしてcold startを短くする | AC-C02, AC-C06, AC-C09 |
| D11 | 起動確認は既定のTCP startup probe。liveness probe・ヘルスチェック用ルートは追加しない | 全ルートを認証の後ろに置く既存設計を保つ。`listen` 前に `ConfigError`・APIキー不正で終了するため、TCPで待ち受けた時点で起動処理は完了している | AC-C01, AC-C05 |
| D12 | 単一writerの記述を「意図的に複数起動しない（運用条件）」と「プラットフォームの一時的な複数インスタンス・更新時の切り替えでは名前の排他を保証しない」に分けて書き直す（§8） | Cloud Runの最大インスタンス数はrevisionごとの設定で、一時的に超えることがある。更新時は旧revisionの処理中インスタンスと新revisionが並ぶ。「replicaを1つにする」では保証と誤読される | AC-C06 |
| D13 | 公開URL・Project ID・Project番号・Secretの値は、Repository内の文書（本Planの記録を含む）に書かない。記録するのは日付・commit・イメージdigest・revision名・Secret version番号・テスト結果 | Repositoryは公開。Cloud RunのURLにはProject番号が含まれる。digest・revision名・version番号は個人を特定しない | AC-C04, AC-C07 |

---

## 4. コンテナ

### 4.1 `Dockerfile`（新規）

```dockerfile
# syntax=docker/dockerfile:1
# The REST API (src/serve-http.ts) for Cloud Run. No config or credential is baked in:
# AI_FOUNDATION_CONFIG and the credential variables are set at run time (docs/deploy/cloud-run.md).

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# exec form: node is PID 1 and receives SIGTERM itself. Cloud Run sets PORT (D1).
CMD ["node", "dist/serve-http.js", "--no-env-file", "--host", "0.0.0.0"]
```

- `COPY` したファイルはroot所有のまま（`--chown` しない）。`node` ユーザーは読み取りのみ。
- `EXPOSE` は書かない（Cloud Runは参照しない。ローカルでは `-p` と `PORT` で指定する）。
- `HEALTHCHECK` は書かない（D11）。

### 4.2 `.dockerignore`（新規）

```text
# Allowlist: only what the image is built from. Anything else in the working tree
# (.env*, config.local.yaml, credentials, archives) never reaches the build context.
*
!package.json
!package-lock.json
!tsconfig.json
!tsconfig.build.json
!src/
```

### 4.3 イメージに含まれないことの確認（AC-C04）

コンテナテスト（§13.2）で次を確認する。

- `/app` 以下が `package.json`・`node_modules/`・`dist/` だけである。
- イメージ全体に `.env*`・`config*.yaml`・`credentials*.json`・`token*.json`・`*.pem`・`*.key` がない（`node_modules` 内のパッケージ同梱ファイルは対象外として、ファイル名の一致だけでなくパスも出力して確認する）。
- `docker image inspect` の `Config.Env` に `AI_FOUNDATION_*`・Credential変数がない。`docker history --no-trunc` に `.env`・Secretの値が現れない。

---

## 5. 待ち受けPort（`src/http/options.ts`）

```ts
export const PORT_VARIABLE = 'AI_FOUNDATION_HTTP_PORT';
/** Set by Cloud Run (and other container platforms) to the port the container must listen on. */
export const PLATFORM_PORT_VARIABLE = 'PORT';

// --port > AI_FOUNDATION_HTTP_PORT > PORT > 8787
const fromEnv = [PORT_VARIABLE, PLATFORM_PORT_VARIABLE].find((name) => env[name]?.trim());
const port =
  args.port !== undefined ? parsePort(args.port, '--port')
  : fromEnv !== undefined ? parsePort(env[fromEnv]!, fromEnv)
  : DEFAULT_PORT;
```

- JSDocの優先順位の説明を更新する。
- 空白だけの `PORT` は未設定と同じ（既存の `AI_FOUNDATION_HTTP_PORT` と同じ扱い）。
- `serve-http.ts` は変更しない（loopback以外の警告はCloud Runでも出るが、HTTPSはCloud Runが終端するので内容は正しい）。
- `.env.example` と READMEの環境変数表に `PORT` の行を追加する。

---

## 6. Config・Secret

### 6.1 Secret一覧

| Secret名 | 注入先 | 内容 |
|---|---|---|
| `ai-foundation-config` | ファイル `/etc/ai-foundation/config.yaml` | クラウド用の個人Config（`storage: google_drive`・`vault_folder_id`・Calendar ID・Notion ID等）。既存のConfig形式そのまま |
| `ai-foundation-api-key` | `AI_FOUNDATION_API_KEY` | HTTP APIキー |
| `ai-foundation-todoist-api-token` | `TODOIST_API_TOKEN` | |
| `ai-foundation-google-oauth-client-id` | `GOOGLE_OAUTH_CLIENT_ID` | |
| `ai-foundation-google-oauth-client-secret` | `GOOGLE_OAUTH_CLIENT_SECRET` | |
| `ai-foundation-google-oauth-refresh-token` | `GOOGLE_OAUTH_REFRESH_TOKEN` | Calendar＋Drive認可済みの値（`npm run auth:google -- --drive`） |
| `ai-foundation-notion-api-token` | `NOTION_API_TOKEN` | |
| `ai-foundation-github-token` | `GITHUB_TOKEN` | |

- `AI_FOUNDATION_CONFIG=/etc/ai-foundation/config.yaml` は秘密ではないので通常の環境変数で設定する。
- `ai-foundation-config` は `config.local.yaml` とは別のローカルファイル（`config.cloud.yaml`、`.gitignore` に追加）から作る。`storage: filesystem` のConfigではKnowledge・Life Logが `configuration_error` になるため、クラウド用は `storage: google_drive` にする。
- Client IDは秘密ではないが、他の値と同じ手順で更新・ロールバックできるようSecretにする。
- マウントしたファイルが `node` ユーザーから読めることを実配置で確認する（読めなければ `Cannot read config file` で起動失敗し、AC-C05の観測と区別できる）。

### 6.2 値の登録（実値をコマンド引数・履歴・ログに出さない）

- Config: `gcloud secrets versions add ai-foundation-config --data-file=config.cloud.yaml`
- Credential: ローカルの `.env`（または配置用の `.env.cloud`、`.gitignore` 済み）から標準入力で渡す。

  ```sh
  node --env-file=.env -e "process.stdout.write(process.env.TODOIST_API_TOKEN)" \
    | gcloud secrets versions add ai-foundation-todoist-api-token --data-file=-
  ```

  値はpipeだけを通り、コマンドラインには変数名だけが現れる。`gcloud` の出力にはversion番号だけが出る。
- APIキーはクラウド専用に新しく生成する（ローカルのキーと分ける）。生成は既存のREADMEのコマンドで行い、`.env.cloud` に保存してから上記の方法で登録する。
- Secretは `--replication-policy=user-managed --locations=asia-northeast1` で作る（データの保管場所をサービスと同じリージョンにする）。

### 6.3 version管理

- 配置ごとに、各Secretのversion番号をrevisionに固定する（D9）。
- 直前のrevisionが参照するversionは、次の更新が安定するまで無効化・破棄しない。それより古いversionは破棄する（§11、費用はversion数に比例する）。
- Google OAuthの再認可が必要になった場合は、ローカルで `npm run auth:google -- --drive` を実行し、新しいRefresh Tokenを新versionとして登録して、そのversionで新revisionを配置する。

---

## 7. 権限

### 7.1 有効化するAPI

`run.googleapis.com`、`artifactregistry.googleapis.com`、`secretmanager.googleapis.com`（既存のCalendar・Drive APIはそのまま）。

### 7.2 実行用Service Account

- `ai-foundation-run@<PROJECT_ID>.iam.gserviceaccount.com` を新規作成し、Cloud Runの `--service-account` に指定する（Compute Engineの既定Service Accountを使わない）。
- 付与するのは §6.1 の8つのSecretそれぞれへの `roles/secretmanager.secretAccessor`（Secret単位のIAM）だけ。Project単位のRoleは付与しない。
- Google APIへのアクセスは既存のOAuth Refresh Tokenで行うため、Service AccountにCalendar・Drive等の権限は不要。

### 7.3 デプロイ実行者

個人Projectでは利用者のアカウント（Owner）で実行してよいが、手順書には必要な権限を明記する。

| 作業 | 必要なRole（最小） |
|---|---|
| Artifact Registryの作成・cleanup policy | `roles/artifactregistry.admin` |
| イメージのpush | `roles/artifactregistry.writer` |
| Secretの作成・version追加・破棄 | `roles/secretmanager.admin` |
| Service Accountの作成・Secretへの付与 | `roles/iam.serviceAccountAdmin`、`roles/secretmanager.admin` |
| Cloud Runへの配置・公開設定 | `roles/run.admin`、実行用SAへの `roles/iam.serviceAccountUser` |

Cloud RunのService Agentは同じProjectのArtifact Registryからpullできるため、追加の付与はしない。

### 7.4 公開設定

`--allow-unauthenticated`（`allUsers` に `roles/run.invoker`）で、Google IAMの認証を要求しない。アプリのBearer認証が全ルートに掛かることはAC-C02で外部から確認する。組織ポリシー（Domain Restricted Sharing）で `allUsers` を付与できない場合は配置前に分かるので、その時点で `--no-invoker-iam-check` を使う（どちらもIAMの認証を要求しない点は同じ）。

---

## 8. 同時実行・単一writer

### 8.1 配置設定と運用条件

- `--max-instances 1`、1コンテナ1プロセス（D3）。複数のCloud Run Service、revision間のトラフィック分割（`--to-revisions A=50,B=50` 等）、同じVaultを使うローカルのMCP Server／HTTP Serverとの並行稼働を**意図的には行わない**。
- 更新時は呼び出し元からの書き込みを止め、処理中のリクエストが終わってから新revisionへ切り替える（§10）。
- 最大インスタンス1は排他の保証ではない。Cloud Runが一時的に上限を超えてインスタンスを起動する場合、更新・ロールバックで旧revisionのインスタンスがリクエストを処理し終えるまで新revisionと並ぶ場合は、[Google Drive保存](../specs/google-drive-storage.md)の「名前の一意性は保証しない」（複数Process）の範囲として扱う。重複が残った場合は既存仕様どおり以後の操作が409になり、Google Driveで整理する。
- 追記は取得した版に対する条件付き更新なので、複数インスタンスでも古い内容からの上書きはしない（既存のAC-D05・AC-D06の範囲で変わらない）。
- 分散ロック・追加の版履歴検査は導入しない。

### 8.2 既存文書の書き換え

| 文書 | 現在 | 変更後 |
|---|---|---|
| `docs/specs/google-drive-storage.md`「運用条件」 | 書き込みを行うServerは1 Processにする（…クラウドではreplicaを1つにする） | 書き込みを行うServerを意図的に複数起動しない（同じVaultでMCP Server〈stdio〉とHTTP Serverを同時に起動しない。Cloud Runでは最大インスタンス1・トラフィック分割なし）。これは運用条件で、プラットフォームによる一時的な複数インスタンスや更新時の切り替えを含め、Process間の名前の排他は保証しない（「作成」の複数Process） |
| `README.md`（Google Drive「同時に書き込んだ場合」） | **書き込むServerは1 Processにする。** …クラウドで複数のreplicaを動かしたりすると、作成の直列化が効かない | **書き込むServerを意図的に複数起動しない。** 同じVaultに対してMCP ServerとHTTP Serverを同時に起動しない。Cloud Runでは最大インスタンス1にするが、一時的に複数のインスタンスが動く場合があり、その間は作成の直列化が効かない（[Cloud Run](docs/deploy/cloud-run.md)の更新手順で書き込みを止める） |

---

## 9. 配置手順（`docs/deploy/cloud-run.md` に記載する内容）

`<PROJECT_ID>` 等は利用者の環境の値で、文書には書かない。シェルはGit Bash／POSIX shで書き、Windowsのパスも `/` 区切りにする。

### 9.1 準備（初回のみ）

1. Google Cloud CLIを導入し、`gcloud auth login`、`gcloud config set project <PROJECT_ID>`、`gcloud config set run/region asia-northeast1`。
2. 課金アカウントが紐付いていることを確認し、予算アラートを設定する（費用の上限ではなく通知、§11）。
3. §7.1のAPIを有効化する。
4. Artifact Registry: `gcloud artifacts repositories create ai-foundation --repository-format=docker --location=asia-northeast1`、§11.3のcleanup policyを設定、`gcloud auth configure-docker asia-northeast1-docker.pkg.dev`。
5. 実行用Service Accountを作成する（§7.2）。
6. §6.1のSecretを作成して値を登録し（§6.2）、Secretごとに実行用Service Accountへ `secretAccessor` を付与する。

### 9.2 配置（初回・更新共通）

1. 対象commitで `npm ci && npm run typecheck && npm run build && npm test` を実行する。
2. 配置候補のイメージを1回だけビルドし、そのイメージIDを指定してコンテナテストを実行する（§13.2）。
3. テストしたイメージIDにタグを付けてpushし、digestを控える。ここで再ビルドしない。

   ```sh
   IMAGE=asia-northeast1-docker.pkg.dev/<PROJECT_ID>/ai-foundation/ai-foundation
   IID_FILE=$(mktemp)
   docker build --platform linux/amd64 --iidfile "$IID_FILE" .
   IMAGE_ID=$(cat "$IID_FILE")                       # sha256:…
   AI_FOUNDATION_CONTAINER_IMAGE="$IMAGE_ID" npm run test:container
   docker tag "$IMAGE_ID" "$IMAGE:$(git rev-parse --short HEAD)"
   docker push "$IMAGE:$(git rev-parse --short HEAD)"
   # digest: the "digest: sha256:…" line of the push output
   ```

   タグはイメージIDを指すため、pushされるのはテストしたイメージそのものである。テストが失敗したら3以降に進まない。

4. 書き込みを止める（更新時、§10.1）。
5. digestとSecret versionを指定して配置する。

   ```sh
   gcloud run deploy ai-foundation \
     --image "$IMAGE@sha256:<digest>" \
     --service-account ai-foundation-run@<PROJECT_ID>.iam.gserviceaccount.com \
     --cpu-throttling --cpu 1 --memory 512Mi --cpu-boost \
     --min-instances 0 --max-instances 1 --concurrency 80 --timeout 300 \
     --allow-unauthenticated --ingress all \
     --set-env-vars AI_FOUNDATION_CONFIG=/etc/ai-foundation/config.yaml \
     --set-secrets "/etc/ai-foundation/config.yaml=ai-foundation-config:<v>,AI_FOUNDATION_API_KEY=ai-foundation-api-key:<v>,TODOIST_API_TOKEN=ai-foundation-todoist-api-token:<v>,GOOGLE_OAUTH_CLIENT_ID=ai-foundation-google-oauth-client-id:<v>,GOOGLE_OAUTH_CLIENT_SECRET=ai-foundation-google-oauth-client-secret:<v>,GOOGLE_OAUTH_REFRESH_TOKEN=ai-foundation-google-oauth-refresh-token:<v>,NOTION_API_TOKEN=ai-foundation-notion-api-token:<v>,GITHUB_TOKEN=ai-foundation-github-token:<v>"
   ```

   （`--cpu-throttling` はrequest-based課金の明示。`--set-env-vars` / `--set-secrets` は既存の値を置き換えるので、毎回すべてを指定する。）

6. §9.3で確認し、revision名・digest・Secret version・結果を記録する（D13）。

### 9.3 配置後の確認（curl）

```sh
URL=$(gcloud run services describe ai-foundation --format='value(status.url)')
curl -s -o /dev/null -w '%{http_code}\n' "$URL/openapi.json"                                   # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer wrong-key' "$URL/openapi.json" # 401
curl -s -H "Authorization: Bearer $(node --env-file=.env.cloud -p process.env.AI_FOUNDATION_API_KEY)" "$URL/openapi.json" | head -c 200
```

APIキーはファイルから読み、コマンドラインに直接書かない（`-H` の値は自分のProcess一覧には現れるが、シェル履歴には残らない）。

---

## 10. 更新・ロールバック

### 10.1 書き込みの停止

1. 呼び出し元（スマホ・WebのAIクライアント、curl）からの書き込み操作をやめる。個人利用なので、利用者自身が使わない状態にすることを手順とする。
2. 直前の書き込みの応答を受け取ってから、§9.2の5で新revisionを配置する（Cloud Runは旧revisionの処理中リクエストを終えてから旧インスタンスへSIGTERMを送る）。
3. §9.3の確認後に書き込みを再開する。

### 10.2 ロールバック

```sh
gcloud run revisions list --service ai-foundation       # revision name, image digest per revision
gcloud run services update-traffic ai-foundation --to-revisions <previous-revision>=100
```

- revisionはイメージdigestとSecret versionを固定しているため（D9）、切り替えるだけで前の組に戻る。
- ロールバック後に新しい配置を行うと、トラフィックは自動では最新revisionに戻らない場合がある（`update-traffic` でrevisionを指定した後）。次の配置では `--to-latest` で最新へ戻すことを手順に書く。
- SoTへの書き込みはロールバックされない。新revisionで作成・追記した内容はTodoist・Calendar・Notion・Driveに残る。
- ロールバックでもトラフィック分割はしない（100%を1つのrevisionへ）。

### 10.3 Secretの更新だけを行う場合

新versionを追加し、そのversionを指定した §9.2の5 を（同じdigestで）実行する。新revisionが作られ、ロールバックは§10.2と同じ。

---

## 11. 費用

単価・無料枠は2026-11時点の料金表で実装時に照合し、照合結果（確認日と参照ページ）を `docs/deploy/cloud-run.md` に書く（AC-C09）。以下は見積りの前提で、0円や上限を保証しない。

### 11.1 前提の利用量（個人・低頻度）

| 項目 | 見積り |
|---|---|
| リクエスト数 | 最大 3,000回／月（1日100回） |
| 処理時間 | 平均2秒／回（cold startを含む。Driveの `knowledge_search` は長くなり得る） |
| インスタンス時間 | 3,000 × 2秒 = 6,000 vCPU秒、3,000 GiB秒（512 MiB） |
| cold start回数 | 最大 3,000回（最小インスタンス0のため、最悪ほぼ毎回） |
| イメージサイズ | 圧縮後 約100〜150 MB／世代（実測して記録する） |
| 保存するイメージ世代 | 最大3（現行・直前・予備） |
| Secret version | 8 Secret × 最大2 version（現行・直前） = 最大16 |
| Secretのアクセス | 環境変数・ファイルとも起動時に取得。最大 3,000起動 × 8 = 24,000回／月 |

### 11.2 サービス別

| サービス | 料金表で照合する項目 | 見積り |
|---|---|---|
| Cloud Run（request-based、Tier 1リージョン） | vCPU秒・GiB秒・リクエスト数の無料枠と単価 | 無料枠（毎月 180,000 vCPU秒・360,000 GiB秒・200万リクエスト）内 |
| Artifact Registry | 保存容量の無料枠（0.5 GB）と単価、同一リージョン内のpullの転送料 | 3世代で0.5 GB以内。超えた分は保存量に比例 |
| Secret Manager | active versionの単価（無料枠6）、アクセス操作の単価（無料枠10,000回） | versionが無料枠を超える分（最大10 version）と、アクセスが10,000回を超える分で月数十円程度 |
| Cloud Logging | 取り込み量の無料枠（50 GiB／月） | 起動ログ・5xxの1行・Cloud Runのリクエストログのみで無料枠内 |
| ネットワーク | Cloud Runからインターネットへの送信の単価 | 応答はJSONで小さく、月数百MB未満 |
| Cloud Build | — | 使わない（D5） |

### 11.3 古いイメージ・versionの整理

- Artifact Registryにcleanup policyを設定する: 最新3世代を残し（`keep` の `mostRecentVersions: 3`）、それ以外で30日を過ぎたものを削除する。dry-runで対象を確認してから有効化する。
- ロールバック先のrevisionが参照するdigestがcleanupで消えないよう、配置記録で直前のdigestを確認する（3世代を残せば直前は残る）。
- Secretは §6.3 のとおり、直前より古いversionを破棄する。
- 使わなくなったrevisionはトラフィックがなければ課金されないため、削除は必須にしない。

### 11.4 配置後の利用量確認

Cloud Consoleの「お支払い → レポート」でサービス別に、配置後1週間・1か月の費用を確認し、見積りとの差を記録する。

---

## 12. 追加・変更予定ファイル

| File | 種別 | 内容 |
|---|---|---|
| `src/http/options.ts` | 変更 | `PORT` の読み取り（§5） |
| `Dockerfile` | 新規 | §4.1 |
| `.dockerignore` | 新規 | §4.2 |
| `.gitignore` | 変更 | `config.cloud.yaml` を追加（`.env.cloud` は既存の `.env.*` で除外済み） |
| `.env.example` | 変更 | `PORT` の説明（Cloud Runが設定する、`AI_FOUNDATION_HTTP_PORT` が優先） |
| `package.json` | 変更 | `test:container` scriptの追加（`AI_FOUNDATION_CONTAINER_IMAGE` で既存イメージを指定可能、§13.2） |
| `vitest.config.ts` | 変更 | `tests/container/**` を `npm test` の対象から除く |
| `vitest.container.config.ts` | 新規 | コンテナテスト用（timeout延長、ファイル直列） |
| `tests/startup/http-options.test.ts` | 変更 | Portの優先順位（§13.1） |
| `tests/e2e/http.test.ts` | 変更 | `DROPPED_VARS` に `PORT` を追加（開発者の環境の `PORT` で結果が変わらないように） |
| `tests/container/http.container.test.ts` | 新規 | §13.2 |
| `tests/fixtures/container/config.yaml` | 新規 | コンテナテスト用Config（`storage: google_drive`、ダミーの `vault_folder_id`、Calendar ID等なし） |
| `docs/deploy/cloud-run.md` | 新規 | §6〜§11の手順・設定・費用（個人の値なし） |
| `docs/specs/cloud-run.md` | 新規 | 配置構成・Config／Secretの注入・単一writerの運用条件・AC-C01〜C09（Issueの設計をRepositoryの仕様にする） |
| `docs/specs/google-drive-storage.md` | 変更 | 「運用条件」（§8.2） |
| `README.md` | 変更 | REST APIの環境変数表に `PORT`、「クラウドに配置する」節（`docs/deploy/cloud-run.md` へのリンク）、Google Driveの単一writerの記述（§8.2）、Documentationの一覧 |

---

## 13. テスト

### 13.1 Automated Test（`npm test`）

`tests/startup/http-options.test.ts` に追加する。

- `PORT` だけが設定されていればそのPortで待ち受ける。
- `AI_FOUNDATION_HTTP_PORT` と `PORT` の両方なら `AI_FOUNDATION_HTTP_PORT`。`--port` は両方より優先。
- 空白の `PORT` は未設定扱い（既定 8787）。
- 不正な `PORT`（`-1` / `65536` / `http`）は `PORT must be a port number` で失敗し、`AI_FOUNDATION_HTTP_PORT` が有効なら `PORT` は検査しない。

既存の `tests/e2e/http.test.ts`・`tests/e2e/stdio.test.ts`・その他のテストが変更なしで通ること（`DROPPED_VARS` を除く）をAC-C08の回帰確認とする。

### 13.2 コンテナテスト（`npm run test:container`、Docker必須）

`tests/container/http.container.test.ts`。外部Providerへは接続しない（Credentialを渡さない）。

- テスト対象のイメージ: `AI_FOUNDATION_CONTAINER_IMAGE`（イメージIDまたはタグ）が設定されていればそのイメージをビルドせずに使う（配置時、§9.2）。未設定なら `beforeAll` で `docker build --platform linux/amd64 --iidfile` し、得たイメージIDを使う（開発時）。T1〜T8はこのイメージに対して `docker run` する。
- T9だけは `.dockerignore` の規則を確かめるため、隔離したビルドコンテキストで別にビルドする。`fs.mkdtemp` で作ったOSの一時ディレクトリへ `Dockerfile`・`.dockerignore`・`package.json`・`package-lock.json`・`tsconfig.json`・`tsconfig.build.json`・`src/` をコピーし、その中にダミーファイルを作ってビルドする。テスト後はその一時ディレクトリだけを削除し、作ったイメージも削除する。Repositoryの作業ツリーには何も作成・削除しない（実運用の `.env.cloud`・`config.cloud.yaml` は同名なので触れない）。

| # | 確認内容 | AC |
|---|---|---|
| T1 | `PORT=8080`、APIキー、`tests/fixtures/container/config.yaml` を `/etc/ai-foundation/config.yaml` に読み取り専用でマウント（0444）して起動すると、`listening on http://0.0.0.0:8080` を出力する | AC-C01 |
| T2 | 公開したPortに対し、キーなし・不正キーの `/openapi.json` は401、正しいキーは200（OpenAPI 3.1文書） | AC-C01, AC-C02（ローカル） |
| T3 | 正しいキーで `GET /v1/tasks` は503 `credential_missing`（Credential未注入、外部へは送信しない） | AC-C05 |
| T4 | `docker stop`（SIGTERM）で10秒以内に終了コード0で終わる | AC-C01 |
| T5 | APIキーなし／31文字のキーで終了コード1、stderrに `AI_FOUNDATION_API_KEY` の理由。値は出力しない | AC-C05 |
| T6 | `AI_FOUNDATION_CONFIG` なしで終了コード1・`Config file not found`。不正なYAML・Schema違反のConfigで終了コード1・`Invalid configuration` | AC-C04, AC-C05 |
| T7 | 実行ユーザーのuidが0でない。`/app` のファイルを書き換えられない | AC-C01 |
| T8 | §4.3（イメージ内のファイル・環境変数・history） | AC-C04 |
| T9 | `.dockerignore` の確認: 隔離したビルドコンテキスト（上記）にダミーの `.env`・`.env.cloud`・`config.local.yaml`・`config.cloud.yaml`・`credentials.json`・`archive.zip` を置いてビルドしても、イメージに含まれない | AC-C04 |

ProcessはNode 1つであること（`ps` でPID 1が `node`）もT1で確認する（AC-C06）。

### 13.3 ACと検証の対応

| AC | ローカル（実装時） | クラウド（実配置時、§14） |
|---|---|---|
| AC-C01 | §13.1、T1・T4・T7 | 新revisionがstartup probeを通る |
| AC-C02 | T2 | §9.3 |
| AC-C03 | — | §14.2 |
| AC-C04 | T6・T8・T9 | 注入したConfigで起動、Cloud Loggingに値がないこと |
| AC-C05 | T3・T5・T6、既存のHTTPテスト | — |
| AC-C06 | T1（1 Process） | `gcloud run services describe` で設定を確認 |
| AC-C07 | — | §14.3 |
| AC-C08 | `npm run typecheck`・`build`・`test` | §14.4 |
| AC-C09 | — | §11の照合と §11.4 |

---

## 14. 実配置での確認

### 14.1 検証用Configで配置する

最初の配置は、Knowledge・Life Logを**検証用Vault**（既存のIntegration Test用フォルダ `GOOGLE_DRIVE_IT_VAULT_FOLDER_ID` と同じもの）へ向けたConfig（`ai-foundation-config` のversion A）で行う。それ以外のSourceは本番と同じConfigにする。

### 14.2 AC-C03（Knowledge 4操作・Life Log 3操作）

1. revision 1（Config version A）で `knowledge_create` → `knowledge_append` → `knowledge_get` → `knowledge_search`、`lifelog_create` → `lifelog_append` → `lifelog_get` を実行する。作成するタイトルには日時を含め、既存のファイルと重ならないようにする。
2. 同じdigest・同じSecret versionで新revisionを作る（`gcloud run services update ai-foundation --update-labels verify=<n>` 等。コンテナが作り直される）。
3. 1で得たIDを `knowledge_get` / `lifelog_get` で取得し、内容が同じであることを確認する。
4. 片付け: 作成したファイルをGoogle Driveでゴミ箱へ移す（AI Foundationは削除しない）。

### 14.3 AC-C07（更新・ロールバック）

1. Config version B（本番Vault）を登録し、§10.1の手順で同じdigestの新revisionを配置する。`knowledge_search` の結果が本番Vaultのものになることを確認する。
2. §10.2で直前のrevision（version A）へ戻し、`knowledge_search` が検証用Vaultの結果になることを確認する。
3. `--to-latest` で本番revisionへ戻す。
4. 各revisionのdigestとSecret versionを `gcloud run revisions describe` で確認して記録する。

### 14.4 AC-C08（読み取りsmoke）

本番Configのrevisionで、`GET /v1/tasks`・`/v1/schedules`（今日から7日間）・`/v1/collection-items`（検索1件）・`/v1/projects`・`/v1/areas` を実行して200を確認する（読み取りのみ）。stdio MCP・Filesystem保存はローカルの `npm test`（既存のe2e・storage-compat）で回帰を確認する。

### 14.5 AC-C04（ログ）

Cloud Loggingで配置時刻以降のログを `Bearer`・各Credentialの先頭数文字で検索し、値が出ていないことを確認する。Cloud Runのリクエストログにはpathとqueryが記録されるが、Authorization headerは記録されないことも確認する。

---

## 15. 実装順序

1. `src/http/options.ts` と `tests/startup/http-options.test.ts`、`tests/e2e/http.test.ts` の `DROPPED_VARS`。`npm test`。
2. `Dockerfile`・`.dockerignore`・`.gitignore`。ローカルで `docker build` と手動起動。
3. `vitest.container.config.ts`・`tests/fixtures/container/config.yaml`・`tests/container/http.container.test.ts`・`package.json`・`vitest.config.ts`。`npm run test:container`。
4. `docs/specs/cloud-run.md`・`docs/deploy/cloud-run.md`・`docs/specs/google-drive-storage.md`・`README.md`・`.env.example`。
5. `npm run typecheck && npm run build && npm test && npm run test:container`。Implementation Review。
6. 実配置（§9・§14）。結果を本Plan §17と `docs/deploy/cloud-run.md`（費用の照合結果）に記録する。

---

## 16. 懸念点 / 未確定事項

### Q1. `PORT` と `AI_FOUNDATION_HTTP_PORT` の優先順位

D1はアプリ固有の変数を優先する。逆（`PORT` 優先）にするとCloud Runでの誤設定は起こらないが、手元で `PORT` が設定された環境（他の開発ツール）で既存の `AI_FOUNDATION_HTTP_PORT` が無視される。どちらでもCloud Runの配置手順では `AI_FOUNDATION_HTTP_PORT` を設定しない。

### Q2. Cloud Buildを使わないこと

D5のとおりローカルDockerでビルドする。Docker Desktopが使えない環境で配置する場合はCloud Build（`gcloud builds submit`）と、許可リスト形式の `.gcloudignore` を後から追加する。本Planでは追加しない。

### Q3. Cloud Runのリクエストログに残るquery

`knowledge_search` 等の検索語はqueryとしてCloud Runのリクエストログ（既定の保持期間30日）に残る。Project内に閉じた情報で、APIキーは残らない。除外する場合はCloud Loggingの除外フィルタ（`run.googleapis.com/requests`）を設定できるが、障害調査に使えなくなるため初期は設定しない。

### Q4. 最小インスタンス0のcold start

最初のリクエストはコンテナ起動（Nodeの起動・Configの読み込み）を待つ。実測値を§17の記録に残し、AIクライアントのタイムアウトに対して問題があれば、最小インスタンス1（常時課金）を費用とともに再検討する。

### Q5. Refresh Tokenの失効

OAuth同意画面が「テスト中」だとRefresh Tokenは7日で失効し、クラウドのCalendar・Driveが `provider_auth_failed`（502）になる。配置前に「本番環境」であることを確認する手順を `docs/deploy/cloud-run.md` の準備に入れる。

### Q6. 配置記録の置き場所

D13のとおりURL・Project IDはRepositoryに書かない。revision・digest・Secret versionはCloud Run自体（`gcloud run revisions describe`）にも残るため、Repository外の個人用の控えは必須にしない。

---

## 17. 実配置の記録

（実配置後に記入する。日付、対象commit、イメージdigest、revision名、各Secretのversion番号、cold startの実測、§13・§14の結果。URL・Project ID・Project番号は書かない。）
