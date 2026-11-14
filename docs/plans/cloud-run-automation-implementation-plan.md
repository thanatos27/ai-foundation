# Cloud Runデプロイ自動化 — Implementation Plan

## 範囲

既存サービスの通常更新を1つのnpmコマンドに集約する。Node.js 24の標準機能を用い、PowerShell／Git Bashで共通に利用する。API本体・Domain・Connectorは変更しない。初回インフラ作成、Secret登録の自動化、GitHub Actions、Terraform、サービス側メンテナンスモードは今回の対象外。

## インターフェース・構成

- `scripts/cloud-run.mjs`: status／deploy／rollbackのCLIと、テスト可能な処理関数。
- `deploy.cloud.example.json`: 個人値なしのサンプル。
- `deploy.cloud.local.json`: 明示的なProject・Region・Service・Registry・固定Secret version。Git対象外。
- `.deploy/`: ロックと実行ごとのjournal、公開用の要約。Git対象外。Secret値を保存しない。
- `tests/deploy/*.node.mjs`: Node標準テスト。既存Vitestの.testファイルとは分け、`npm run test:cloud`で実行する。
- `package.json`・`.gitignore`・`docs/deploy/cloud-run.md`・構成記録を更新する。依存パッケージの追加はない。

## 動作

deployは、既存サービスの100%traffic先を記録し、Git clean→通常テスト→自動化テスト→候補ビルド→コンテナテスト→push→digest取得→no-traffic配置→Ready確認→APIキーの取得→traffic再確認→切り替え→認証・SoT読み取りsmokeを実施する。候補タグは実行ごとに一意、テスト済みイメージIDを再ビルドせず配置する。ビルド後も作業ツリーとHEADを再確認する。

rollbackは、対象が同じサービスのReadyなrevisionであることを検証し、対象のAPIキーを取得してから100%切り替える。Config・Credentialのversion記録は戻し先のrevisionから取得する。存在しないサービス、権限不足、traffic分割、未知のConfig項目は停止とする。

APIキーはtarget revisionのnumericなSecret参照からcapture-onlyで取得する。実行者にAPIキーSecretのsecretAccessorが必要。現在の.env.cloudを古いrevisionにも一律に使うことはしない。跨Project aliasは対象外。statusはSecret値を取得しない。

実行時のProject指定、引数配列によるshell-free起動、URL検証、redirect拒否、APIごとのタイムアウト、機密情報を含めないエラーを実装する。WindowsのgcloudはSDK内のgcloud.pyを同梱Python等から呼び、npmはNodeからnpm-cli.jsを呼ぶ。

失敗したら非0終了・後続処理停止。失敗段階と復旧先をjournalに残す。自動再試行・自動ロールバックはしない。中断時の自動再開も実装せず、journalと実際のtrafficを確認してから明示的に再実行する。

`--writes-paused`で書き込み停止済みを申告する。プロセス内／ローカルのロックとtraffic再確認は、別PCからの同時操作を原子的に排除するものではない。

## AC・検証

| ID | 観測結果 | 検証 |
|---|---|---|
| AUTO-01 | deployがテストから配置後の読み取りsmokeまで実行し、digest転記が不要 | 代替CLIの一連のテスト。実クラウドは別途 |
| AUTO-02 | 途中失敗時に非0終了し、後続のpush／traffic切り替えをしない | 各段階の失敗注入 |
| AUTO-03 | テストしたイメージIDをtag・pushし、固定digest・numeric Secret versionを配置 | 呼び出し引数の検査 |
| AUTO-04 | 全gcloud操作にProject指定、Secretが引数・出力・journalに出ない | ダミーSecret・設定・エラー検査 |
| AUTO-05 | 新revisionをno-trafficで準備してから100%切り替える。split trafficや外部変更は拒否 | 代替CLIのtraffic状態遷移 |
| AUTO-06 | rollbackは対象サービス・Ready・対象APIキーを確認し、実際の旧versionを記録 | 代替revision／key rotationのテスト |
| AUTO-07 | 同時操作をローカルで拒否し、失敗時ロック解除。既存イメージ・個人ファイルは削除しない | ロック・コマンド列の検査 |
| AUTO-08 | Windows／Git Bashから同じnpm入口で呼べる。shell連結しない | Windows Nodeによるテスト・実引数検査。実gcloudは別途 |
| AUTO-09 | statusとsmokeはSoTへ書き込まない | HTTP method／CLI列の検査 |

独立した実装レビューと、実Cloud Runでの自動化経由のデプロイ／rollback往復は別途確認する。通常テストの過去の成功を、この自動化の実機検証の代わりにしない。
