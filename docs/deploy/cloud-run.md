# Cloud Run配置手順

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
  node -e "console.log('AI_FOUNDATION_API_KEY=' + crypto.randomBytes(32).toString('base64url'))" >> .env.cloud
  ```

`.env.cloud` の値は次の関数で読む（以降の手順で使う。シェルを開き直したら定義し直す）。ファイルだけを解析し、シェルに同じ名前の環境変数があっても使わない（`node --env-file` は既存の環境変数を優先するため使わない）。値が空・未設定なら何も出力せずに失敗する。

```sh
env_cloud() {  # <name>: the value of <name> in .env.cloud
  node -e "const v = require('node:util').parseEnv(require('node:fs').readFileSync('.env.cloud', 'utf8'))[process.argv[1]];
if (!v) { console.error(process.argv[1] + ' is not set in .env.cloud'); process.exit(1); }
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
