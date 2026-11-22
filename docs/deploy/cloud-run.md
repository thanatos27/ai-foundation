# Cloud Run配置手順

## 自動デプロイ（既存サービスの更新）

Node.js 24以降で、PowerShell／Git Bashから同じnpmコマンドを使う。初回インフラ作成・初回サービス配置は下記の手動手順で行う。自動化は既存のCloud Runサービスを対象とし、Secretの登録やversion追加は行わない。

最初の1回だけ、個人用設定を作る。既存の `deploy.cloud.local.json` は上書きしない。

```powershell
if (!(Test-Path deploy.cloud.local.json)) {
    Copy-Item deploy.cloud.example.json deploy.cloud.local.json
}
code deploy.cloud.local.json
```

`project` を対象のProject IDへ、Secret versionを現在の番号へ変更する。今回配置済みの構成はConfig 2・他7 Secretは1。ファイルはGit対象外。設定内のProjectを各gcloud操作へ明示するため、gcloudの既定Projectに依存しない。

```sh
npm run cloud:status
npm run cloud:deploy -- --writes-paused
npm run cloud:rollback -- --revision <revision名> --writes-paused
npm run test:cloud
```

- `status`: 現在100%を受けるrevision、イメージ、リソース、Secret参照番号を表示する。認証情報の実値は取得しない。
- `deploy`: Git作業ツリーの確認 → npm ci／typecheck／build／通常テスト／自動化テスト → Docker --pullビルド → 同じイメージIDのコンテナテスト → push → digest自動取得 → --no-trafficで新revision準備 → 100%切り替え → 読み取りsmoke。
- `rollback`: 戻し先が同じサービスのReadyなrevisionであることを確認し、100%切り替えてsmokeする。SoTの書き込みは巻き戻さない。
- `--config <path>` で別の配置設定を指定できる。Secret versionに `latest` は指定できない。
- `--writes-paused` は「クライアントの書き込みを止め、直前の応答を受け取り、同じVaultに書くローカルMCP／HTTPを停止した」ことの申告。サービス側のメンテナンスモードではない。
- 追跡ファイルの変更と未追跡ファイルがあれば配置を止める。個人用設定・Credential・.deployは.gitignoreで除外する。スクリプトは自動pullやブランチ切り替えをしない。
- デプロイとロールバックの同時実行をローカルロックで拒否する。別PC・別の手動操作は防げない。切り替え直前にもtrafficを再確認するが、分散排他や原子的な比較更新ではない。
- 失敗した段階で停止する。新revisionの準備に失敗したらtrafficを切り替えない。切り替え後のsmoke失敗では非0終了し、復旧コマンドを表示する。無条件の自動ロールバック・SoT書き込み・自動再送はしない。
- `.deploy/*.json` に段階・新旧revision・digest・Secret version・結果を記録する。Secret値は保存しない。`.public.md` はProject ID・URLを含まない共有用要約。個人用ファイルと.deployはGit対象外。公開要約のdigestはsha256値だけに正規化し、レジストリURIのProject IDを含めない。別の--configを使った実行では復旧案内にも指定を残す。シェル構文・空白・Windows区切りを含むパスは直接展開せず、private journalのconfigPathを各シェルに合わせて引用する案内にする。
- 中断時はjournalと実際のtrafficを確認してから、新しい実行または明示的なrollbackを行う。自動再開はない。ロックが残った場合も実行中のプロセスがないことを確認してから手動で外す。

### 実行者の追加権限とWindows

smokeでは戻し先／配置先revisionが参照するAPIキーのSecret versionを、gcloudでメモリにだけ取得する。したがって配置実行者にもAPIキーSecretへの `roles/secretmanager.secretAccessor` が必要。Secret管理権限だけでは読み取りできない場合がある。APIキーがローテーションされた旧revisionでも、対象のキーで検証する。Secretの無効化・破棄済み、または取得権限なしの場合はtraffic切り替え前に止まる。同一ProjectのSecret aliasはProject ID／番号を照合し、実Secret名へ解決する。revisionのnamespaceに番号がない場合は、Projectメタデータの取得権限も必要。跨ProjectのSecret aliasは対象外。

Windowsではgcloud.cmdをシェルで実行せず、PATHでCloud SDKの場所を調べてSDKのPythonエントリーポイントを呼ぶ。既定ではSDK同梱Pythonを利用する。独自Python構成は `CLOUDSDK_PYTHON` をpython.exeの絶対パスで指定する。npmもNodeでnpm-cli.jsを直接実行する。Docker DesktopはLinuxコンテナを起動しておく。

既存の全ルートBearer認証、min 0／max 1、1vCPU／512MiBは維持する。最大1は厳密な単一writer保証ではない。read-only smokeは認証と全SoTの一覧取得だけを行い、本番Vaultへテスト記事を作らない。外部コマンドの生の出力・provider本文・認証情報は表示しない。失敗時の詳細調査は表示された段階に対応する手動コマンドで行う。

### 構成・配置記録

構成・実際の検証結果・料金確認は[構成と運用記録](cloud-run-overview.md)、実装範囲・ACは[自動化Plan](../plans/cloud-run-automation-implementation-plan.md)を参照する。

---

REST APIをGoogle Cloud Runへ手動で配置・更新・ロールバックする手順。構成と制約は [クラウド配置 Design](../specs/cloud-run.md) を参照。

- `<PROJECT_ID>` 等の `<…>` は自分の環境の値に置き換える。これらの値・公開URL・Credentialは、このRepository（公開）・Issue・PRに書かない。
- コマンドはGit Bash／POSIX shで書いている。リージョンは `asia-northeast1`。
- Credentialの値はコマンドライン引数に書かない。ファイルから読み、pipeで渡す。

## 1. 準備（初回のみ）

### 1.1 ローカル

- Docker（`linux/amd64` のイメージをビルドできること）
- [Google Cloud CLI](https://cloud.google.com/sdk/docs/install)

```sh
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud config set run/region asia-northeast1
```

### 1.2 Google Cloud Project

既存のGoogle OAuthクライアント（Calendar・Drive）と同じProjectを使う。

1. 課金アカウントが紐付いていることを確認し、「お支払い → 予算とアラート」で予算アラートを設定する（通知のみで、費用の上限にはならない）。
2. OAuth同意画面の公開ステータスが「本番環境」であることを確認する。「テスト中」だとRefresh Tokenが7日で失効し、クラウドのCalendar・Driveが502 `provider_auth_failed` になる。
3. APIを有効化する。

   ```sh
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
   ```

### 1.3 必要な権限（デプロイ実行者）

ProjectのOwnerであれば足りる。権限を絞る場合:

| 作業 | Role |
|---|---|
| Artifact Registryの作成・cleanup policy | `roles/artifactregistry.admin` |
| イメージのpush | `roles/artifactregistry.writer` |
| Secretの作成・version追加・破棄、Secretへの付与 | `roles/secretmanager.admin` |
| Service Accountの作成 | `roles/iam.serviceAccountAdmin` |
| Cloud Runへの配置・公開設定 | `roles/run.admin`、実行用Service Accountへの `roles/iam.serviceAccountUser` |

### 1.4 Artifact Registry

```sh
gcloud artifacts repositories create ai-foundation --repository-format=docker --location=asia-northeast1
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
```

古いイメージの整理（最新3世代を残し、それ以外で30日を過ぎたものを削除）。ポリシーはRepository外の一時ファイルに書く。

```sh
POLICY=$(mktemp)
cat > "$POLICY" <<'EOF'
[
  { "name": "keep-recent", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 3 } },
  { "name": "delete-old", "action": { "type": "Delete" }, "condition": { "tagState": "any", "olderThan": "30d" } }
]
EOF
gcloud artifacts repositories set-cleanup-policies ai-foundation --location=asia-northeast1 --policy="$POLICY" --dry-run
# 対象を確認してから --no-dry-run で有効化する
gcloud artifacts repositories set-cleanup-policies ai-foundation --location=asia-northeast1 --policy="$POLICY" --no-dry-run
rm "$POLICY"
```

### 1.5 実行用Service Account

```sh
gcloud iam service-accounts create ai-foundation-run --display-name="AI Foundation (Cloud Run)"
SA=ai-foundation-run@<PROJECT_ID>.iam.gserviceaccount.com
```

Project単位のRoleは付与しない（Secretへのアクセスだけを §1.6 で付与する）。Google APIへは既存のOAuth Refresh Tokenでアクセスする。

### 1.6 Secret

| Secret | 注入先 |
|---|---|
| `ai-foundation-config` | ファイル `/etc/ai-foundation/config.yaml` |
| `ai-foundation-api-key` | `AI_FOUNDATION_API_KEY` |
| `ai-foundation-todoist-api-token` | `TODOIST_API_TOKEN` |
| `ai-foundation-google-oauth-client-id` | `GOOGLE_OAUTH_CLIENT_ID` |
| `ai-foundation-google-oauth-client-secret` | `GOOGLE_OAUTH_CLIENT_SECRET` |
| `ai-foundation-google-oauth-refresh-token` | `GOOGLE_OAUTH_REFRESH_TOKEN` |
| `ai-foundation-notion-api-token` | `NOTION_API_TOKEN` |
| `ai-foundation-github-token` | `GITHUB_TOKEN` |

ローカルに2つのファイルを用意する（どちらも `.gitignore` 済み）。

- `config.cloud.yaml`: `config.local.yaml` を元に、Knowledgeを `storage: google_drive`・`vault_folder_id` にしたもの（README「Google Drive APIで読み書きする」）。`vault_path` は書かない。
- `.env.cloud`: クラウド用の `AI_FOUNDATION_API_KEY`（ローカルとは別に生成する）と、Provider Credential 6つ（`.env` と同じ値でよい）。

  ```sh
  command node -e "console.log('AI_FOUNDATION_API_KEY=' + crypto.randomBytes(32).toString('base64url'))" >> .env.cloud
  ```

`.env.cloud` の値は次の関数で読む（以降の手順で使う。シェルを開き直したら定義し直す）。ファイルだけを解析し、シェルに同じ名前の環境変数があっても使わない（`node --env-file` は既存の環境変数を優先するため使わない）。値が空・未設定なら何も出力せずに失敗する。

対話シェルに貼り付けて使うため、次の2点を守る。

- `!` を書かない。bash／zshの対話シェルは `"..."` 内の `!` を履歴展開し、定義自体が失敗する。
- `node` ではなく `command node` で呼ぶ。Git Bashは `node` を `winpty node.exe` のエイリアスにしており、winptyは出力をパイプ・リダイレクトへ渡せない（`stdout is not a tty`）。

```sh
env_cloud() {  # <name>: the value of <name> in .env.cloud
  command node -e "const v = require('node:util').parseEnv(require('node:fs').readFileSync('.env.cloud', 'utf8'))[process.argv[1]];
if (v === undefined || v === '') { console.error(process.argv[1] + ' is not set in .env.cloud'); process.exit(1); }
process.stdout.write(v);" "$1"
}
```

Secretを作り、実行用Service Accountに読み取りを許可する。

```sh
for NAME in config api-key todoist-api-token google-oauth-client-id google-oauth-client-secret \
            google-oauth-refresh-token notion-api-token github-token; do
  gcloud secrets create "ai-foundation-$NAME" --replication-policy=user-managed --locations=asia-northeast1
  gcloud secrets add-iam-policy-binding "ai-foundation-$NAME" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done
```

値を登録する（§4.1）。

## 2. 配置（初回・更新共通）

### 2.1 確認とイメージ

対象commitで:

```sh
npm ci && npm run typecheck && npm run build && npm test
```

配置候補のイメージを1回だけビルドし、そのイメージをコンテナテストしてから、同じイメージIDにタグを付けてpushする（テスト後に再ビルドしない）。`--pull` でベースイメージ（`node:24-bookworm-slim`）の最新を取得し、Nodeのセキュリティ修正を取り込む。

```sh
IMAGE=asia-northeast1-docker.pkg.dev/<PROJECT_ID>/ai-foundation/ai-foundation
docker build --pull --platform linux/amd64 -t ai-foundation:candidate .
IMAGE_ID=$(docker image inspect -f '{{.Id}}' ai-foundation:candidate)
AI_FOUNDATION_CONTAINER_IMAGE="$IMAGE_ID" npm run test:container
TAG=$(git rev-parse --short HEAD)
docker tag "$IMAGE_ID" "$IMAGE:$TAG"
docker push "$IMAGE:$TAG"     # 出力の "digest: sha256:…" を控える
```

- テストが失敗したらpushしない。
- イメージIDは `--iidfile` ではなく `docker image inspect` で取得する（containerdのイメージストアでは、`--iidfile` の値で保存されたイメージを参照できない場合がある）。
- コンテナテストは、テスト内でビルドしたイメージの後片付けで配置候補（`AI_FOUNDATION_CONTAINER_IMAGE`）を削除しない。

### 2.2 書き込みの停止（更新時）

1. スマホ・WebのAIクライアント、curlからの書き込み操作をやめる。
2. 直前の書き込みの応答を受け取ったことを確認する。
3. 同じVaultを使うローカルのMCP Server／HTTP Serverを起動していないことを確認する。

最大インスタンス1でも、更新時は旧revisionの処理中のインスタンスと新revisionが一時的に並ぶ。その間に同じ名前を作成すると重複し得る（作成の直列化は1 Process内だけ）。

### 2.3 配置

Secretのversionは番号で指定する（`latest` を使わない）。`gcloud secrets versions list ai-foundation-<name>` で確認できる。

```sh
SA=ai-foundation-run@<PROJECT_ID>.iam.gserviceaccount.com
gcloud run deploy ai-foundation \
  --image "$IMAGE@sha256:<digest>" \
  --service-account "$SA" \
  --cpu-throttling --cpu 1 --memory 512Mi --cpu-boost \
  --min-instances 0 --max-instances 1 --concurrency 80 --timeout 300 \
  --allow-unauthenticated --ingress all \
  --set-env-vars AI_FOUNDATION_CONFIG=/etc/ai-foundation/config.yaml \
  --set-secrets "/etc/ai-foundation/config.yaml=ai-foundation-config:<v>,\
AI_FOUNDATION_API_KEY=ai-foundation-api-key:<v>,\
TODOIST_API_TOKEN=ai-foundation-todoist-api-token:<v>,\
GOOGLE_OAUTH_CLIENT_ID=ai-foundation-google-oauth-client-id:<v>,\
GOOGLE_OAUTH_CLIENT_SECRET=ai-foundation-google-oauth-client-secret:<v>,\
GOOGLE_OAUTH_REFRESH_TOKEN=ai-foundation-google-oauth-refresh-token:<v>,\
NOTION_API_TOKEN=ai-foundation-notion-api-token:<v>,\
GITHUB_TOKEN=ai-foundation-github-token:<v>"
```

- `--cpu-throttling` はrequest-based課金（CPUはリクエスト処理中だけ割り当て）。
- `--set-env-vars` / `--set-secrets` は既存の値を置き換えるので、毎回すべて指定する。
- `AI_FOUNDATION_HTTP_PORT`・`AI_FOUNDATION_HTTP_HOST` は設定しない（`PORT` はCloud Runが設定し、Hostはイメージで `0.0.0.0` に固定）。
- 組織ポリシーで `allUsers` を付与できず `--allow-unauthenticated` が失敗する場合は、代わりに `--no-invoker-iam-check` を使う。
- 以前に §3 のロールバックでrevisionを指定していた場合、新revisionへトラフィックが移らないことがある。`gcloud run services update-traffic ai-foundation --to-latest` で最新へ移す。

### 2.4 確認

```sh
URL=$(gcloud run services describe ai-foundation --format='value(status.url)')
KEY_HEADER="Authorization: Bearer $(env_cloud AI_FOUNDATION_API_KEY)"
curl -s -o /dev/null -w '%{http_code}\n' "$URL/openapi.json"                                    # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer wrong-key' "$URL/openapi.json" # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "$KEY_HEADER" "$URL/openapi.json"                     # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "$KEY_HEADER" "$URL/v1/projects"                      # 200
```

設定の確認:

```sh
gcloud run services describe ai-foundation --format=yaml \
  | grep -E 'maxScale|minScale|cpu-throttling|containerConcurrency|timeoutSeconds|serviceAccountName|image:'
gcloud run revisions list --service ai-foundation
```

確認後に書き込みを再開する。配置ごとに、日付・commit・イメージdigest・revision名・各Secretのversion番号を控える（Repositoryに記録する場合もURL・Project IDは書かない）。revisionごとのdigest・Secret versionは `gcloud run revisions describe <revision>` でも確認できる。

## 3. ロールバック

```sh
gcloud run revisions list --service ai-foundation
gcloud run services update-traffic ai-foundation --to-revisions <前のrevision>=100
```

- revisionはイメージdigestとSecret versionを固定しているので、切り替えるだけで前の組に戻る。トラフィックは分割せず、1つのrevisionへ100%にする。
- SoTへの書き込み（Todoist・Calendar・Notion・Driveへの作成・追記）は戻らない。
- 切り替えの前後も §2.2 のとおり書き込みを止める。
- 次の配置の後は `--to-latest` で最新へ戻す（§2.3）。

## 4. Secretの更新

### 4.1 値の登録

値はpipeで渡し、コマンドラインには変数名だけが現れるようにする。`env_cloud` は §1.6 の関数。

```sh
gcloud secrets versions add ai-foundation-config --data-file=config.cloud.yaml

add_env_secret() {  # <secret name> <variable name in .env.cloud>
  env_cloud "$2" > /dev/null || return 1   # empty or missing: register nothing
  env_cloud "$2" | gcloud secrets versions add "$1" --data-file=-
}
add_env_secret ai-foundation-api-key AI_FOUNDATION_API_KEY
add_env_secret ai-foundation-todoist-api-token TODOIST_API_TOKEN
add_env_secret ai-foundation-google-oauth-client-id GOOGLE_OAUTH_CLIENT_ID
add_env_secret ai-foundation-google-oauth-client-secret GOOGLE_OAUTH_CLIENT_SECRET
add_env_secret ai-foundation-google-oauth-refresh-token GOOGLE_OAUTH_REFRESH_TOKEN
add_env_secret ai-foundation-notion-api-token NOTION_API_TOKEN
add_env_secret ai-foundation-github-token GITHUB_TOKEN
```

更新するSecretだけを実行すればよい。出力のversion番号を控える。

### 4.2 反映

新しいversion番号を指定して §2.3 を実行する（イメージが同じなら同じdigest）。新revisionが作られ、ロールバックは §3 と同じ。

### 4.3 Google OAuthの再認可

`invalid_grant`（502 `provider_auth_failed`）が出たら、ローカルで `npm run auth:google -- --drive` を実行し、表示されたRefresh Tokenで `.env.cloud` の `GOOGLE_OAUTH_REFRESH_TOKEN` を置き換えて §4.1・§4.2 を行う。

### 4.4 古いversionの破棄

現在のrevisionと直前のrevision（ロールバック先）が参照するversionは残し、それより古いversionを破棄する。

```sh
gcloud secrets versions list ai-foundation-<name>
gcloud secrets versions destroy <version> --secret=ai-foundation-<name>
```

## 5. 費用

個人・低頻度の利用での見積りの前提。無料枠・単価は料金表で確認し、確認日をこの節に追記する。0円や月額上限は保証しない。

| 項目 | 前提 |
|---|---|
| リクエスト | 最大 3,000回／月、平均2秒（cold startを含む） |
| インスタンス時間 | 6,000 vCPU秒・3,000 GiB秒／月（1 vCPU・512 MiB、request-based） |
| イメージ | 最大3世代（cleanup policy） |
| Secret | 8 Secret × 最大2 version、起動ごとに8回アクセス |

| サービス | 料金表で確認する項目 | 料金表 |
|---|---|---|
| Cloud Run | request-basedのvCPU秒・GiB秒・リクエスト数の無料枠と単価（Tier 1） | https://cloud.google.com/run/pricing |
| Artifact Registry | 保存容量の無料枠と単価、同一リージョンのpull | https://cloud.google.com/artifact-registry/pricing |
| Secret Manager | active versionの単価と無料枠、アクセス操作の単価と無料枠 | https://cloud.google.com/secret-manager/pricing |
| Cloud Logging | 取り込み量の無料枠 | https://cloud.google.com/stackdriver/pricing |
| ネットワーク | Cloud Runからインターネットへの送信 | https://cloud.google.com/run/pricing |
| Cloud Build | 使わない（ローカルでビルド） | — |

- 配置後1週間・1か月で、「お支払い → レポート」をサービス別に確認する。
- 不要なイメージはcleanup policyで、不要なSecret versionは §4.4 で削除する。トラフィックのない古いrevisionは課金されない。
- Cloud Runのリクエストログにはpathとqueryが記録される（検索語を含む）。Authorization headerは記録されない。

