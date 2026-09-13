# Code Inspection

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語**

エディター、ターミナル、AI エージェントで共有できるローカル多言語コード検査サービスです。プロジェクトローカルの解析ツールで JavaScript/TypeScript、Python、Java、Go、Rust、C、C++ を検査し、CLI、Model Context Protocol（MCP）、Language Server Protocol（LSP）から同じ正規化済み検出結果を参照できます。

## 機能

| 機能 | 動作 |
| --- | --- |
| JavaScript/TypeScript | ESLint と TypeScript Compiler API の診断を使用します。ファイルを生成せず、プロジェクトローカルのパッケージと `tsconfig.json` を使用します。 |
| Python | Ruff の JSON 診断と、任意で Pyright の JSON 診断を使用します。 |
| Java | Maven または Gradle Wrapper 経由の Checkstyle/PMD に加え、明示的な Java ビルドコマンドを使用できます。 |
| Go | `go vet` の JSON 診断と、任意で `golangci-lint` を使用します。 |
| Rust | `cargo check` と、任意で `cargo clippy` の Cargo JSON 診断を使用します。 |
| C/C++ | Clang/clang-tidy の診断を使用します。clang-tidy には `compile_commands.json` データベースが必要です。 |
| ビルド | 設定済みの実行ファイル/引数配列を、作業ディレクトリ、環境変数、タイムアウト、出力上限、プロセスグループのキャンセルとともに実行できます。 |
| 共有サービス | CLI、LSP、MCP は、正規化されたワークスペースルートごとに 1 つのサービスへ、認証済みローカル IPC（Windows 名前付きパイプまたは Unix ソケット）で接続します。 |
| 保存時の検査 | LSP の保存イベントでは、ファイルの言語/プロジェクトに一致する有効な検査だけをキューに入れます。保存イベントをデバウンスし、同一プロジェクトの要求を統合します。新しい実行に置き換えられた実行が新しい結果を上書きすることはありません。 |
| 検出結果と鮮度 | 検出結果には、ソース、コード、重大度、任意のファイル/範囲、実行 ID、generation が含まれます。編集や監視対象のファイルシステム変更で結果は無効になり、成功した検査はそのスコープ内の検出結果を置き換えます。 |
| CLI | 設定の初期化、信頼の付与/取り消し、検査、検出結果/状態の照会、実行のキャンセルを行えます。検査出力は人間向け形式と JSON に対応し、意味のある終了コードを返します。 |
| MCP | 動的な機能検出に加え、検査のキュー投入、実行状態の読み取り、検出結果のページ単位照会を行うツールを提供します。構造化 JSON または Markdown に対応し、stdout にはプロトコルデータだけを出力します。 |
| VS Code | バンドル済みランタイム、診断、複数ワークスペースフォルダー、手動実行/キャンセル、出力チャンネル、ワークスペース信頼、MCP 定義を提供します。 |
| Zed | インストール済み LSP 実行ファイル用の Rust/WASM ランチャーを、対応するすべての言語に接続します。ネイティブ MCP 設定は別途必要です。 |
| 配布 | Core/runtime の npm tarball、自己完結型 VSIX、Zed WASM、および自動化されたビルド、テスト、プロトコル、パッケージ検査を提供します。 |

## 動作要件

- Core/runtime の manifest は Node.js `>=18.20` を宣言しています。開発と CI では Node.js 24 を使用します。プロジェクトにインストールされたツールが、ランタイムの最低要件より新しい Node バージョンを要求する場合があります。
- 有効にする検査ごとに、使用する解析ツールを自身でインストールしてください。対象は ESLint/TypeScript、Ruff/Pyright、JDK（必要に応じて Maven/Gradle）、Go、Rust/Cargo、Clang です。ランタイムがツールをダウンロードすることはありません。
- VS Code 拡張には VS Code `1.103.0` 以降が必要です。
- Rust と `wasm32-wasip2` target は、Zed 拡張をビルドする場合にのみ必要です。

検査がプロジェクト依存関係を自動インストールしたり、バンドル済みの lint/compiler ツールでプロジェクトのツールを置き換えたりすることはありません。

## クイックスタート

npm からランタイムをインストールします。CLI、MCP、LSP の各実行ファイルが提供され、core も依存関係としてインストールされます。

```sh
npm install --global @zakotoys/code-inspection-runtime
```

ESLint 依存関係と設定がインストール済みの検査対象プロジェクトへ移動します。

```sh
cd /path/to/your-project
code-inspection init
code-inspection trust .
code-inspection inspect --check eslint
code-inspection findings
```

`init` は、すべての組み込み検査を列挙したバージョン 2 の `.code-inspection.json` を作成します。既定では ESLint が有効で、その他の検査は無効です。既存ファイルの上書きは拒否します。ツールをインストールしてコマンドを確認してから、その検査を有効にしてください。

ランタイム実行ファイルではなく、プロトコルに依存しない検査エンジンを組み込む場合は、`@zakotoys/code-inspection-core` をプロジェクト依存関係としてインストールしてください。

## CLI リファレンス

| コマンド | 用途 |
| --- | --- |
| `init` | 設定を作成します。 |
| `trust` / `revoke` | ローカル実行の信頼記録を付与/削除します。 |
| `inspect` | 選択した動的チェック ID を実行し、完了を待ちます。既定では有効な検査をすべて実行します。プロジェクトスコープの検査は、実行前にネストしたプロジェクトを列挙します。 |
| `findings` | 最大 500 件の検出結果を読み取ります。`--include-stale` を指定すると古い結果も含まれます。 |
| `capabilities` | 設定済みの検査、対応言語、スコープ、プロジェクトマーカーを一覧表示します。 |
| `projects` | 検査または言語に対して検出されたネストしたプロジェクトを一覧表示します。 |
| `status` | 信頼、実行中/最新の実行、検出結果数を含む JSON を出力します。 |
| `cancel --run-id <id>` | キュー内または実行中の処理をキャンセルします。 |
| `help` / `--version` | 使用方法/バージョンを表示します。 |

コマンドは既定で現在のディレクトリを使用します。別のルートは `--workspace`（`-w`）または位置引数で選択します。空白を含むパスは引用符で囲んでください。

```sh
code-inspection capabilities -w /path/to/project
code-inspection inspect -w /path/to/project --check eslint,ruff,cargo-check --json
code-inspection inspect --check ruff -f src/app.py
code-inspection projects --check cargo-check --json
code-inspection findings --json --include-stale
code-inspection status
code-inspection cancel --run-id <run-id>
code-inspection revoke /path/to/project
```

`--check`（`-i`）にはカンマ区切りの動的 ID を指定でき、オプション自体を繰り返すこともできます。`--file`（`-f`）も繰り返し指定でき、1 回の要求につき最大 100 ファイルです。ファイルを指定した場合でも、プロジェクトスコープの検査は検出された所属プロジェクトを検査します。`inspect --trust` は信頼の付与を永続化します。無効な検査は警告とともにスキップされます。

| `inspect` 終了コード | 意味 |
| --- | --- |
| `0` | 実行された処理に検出結果がありません。選択したすべての検査がスキップされた場合も返されます。 |
| `1` | 警告やビルドのゼロ以外の終了を含む検出結果があります。 |
| `2` | ツール不足や信頼不足など、実行/要求が失敗しました。 |
| `3` | キャンセルされたか、新しい実行に置き換えられました。 |

## 設定

`.code-inspection.json` は任意です。このファイルがない場合、既定では ESLint が有効で、TypeScript/build の検査は無効です。各検査は、アダプター、言語セット、スコープ、任意のツールコマンドに対応付けられたレジストリ ID です。

```json
{
  "version": 2,
  "debounceMs": 300,
  "maxFindings": 2000,
  "checks": {
    "eslint": {
      "adapter": "eslint",
      "enabled": true,
      "languages": ["javascript", "typescript"],
      "scope": "file",
      "cwd": ".",
      "patterns": ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"]
    },
    "typescript": {
      "adapter": "typescript",
      "enabled": true,
      "languages": ["javascript", "typescript"],
      "scope": "project",
      "cwd": ".",
      "project": "tsconfig.json"
    },
    "ruff": {
      "adapter": "ruff",
      "enabled": true,
      "languages": ["python"],
      "scope": "file",
      "cwd": ".",
      "command": ["ruff", "check", "--output-format", "json"]
    }
  }
}
```

| 設定 | 既定値と動作 |
| --- | --- |
| `version` | `2`。v1 の `inspectors` 設定は拒否されます。不明なキーも拒否されます。 |
| `debounceMs` | `300`。保存のスケジューリング遅延で、範囲は `0`～`10000` ミリ秒です。 |
| `maxFindings` | `2000`。検査ごとの出力上限で、範囲は `1`～`10000` です。サマリーは保持された検出結果を数えます。 |
| `checks.<id>.adapter` | 必須の組み込みアダプター：`eslint`、`typescript`、`ruff`、`pyright`、`go-vet`、`golangci-lint`、`cargo-check`、`cargo-clippy`、`checkstyle`、`pmd`、`java-build`、`clang-tidy`、`clang-build`、`command`。 |
| `checks.<id>.languages` | 言語 ID：`javascript`、`typescript`、`python`、`java`、`go`、`rust`、`c`、`cpp`。省略時はアダプターの既定値を使用します。空のリストはワークスペースコマンドで有効です。`.h` は C と C++ の両方に分類されます。 |
| `checks.<id>.scope` | `file`、`project`、`workspace`。既定値はアダプターのスコープです。プロジェクトルートは言語マーカーから検出されます。 |
| `checks.<id>.cwd` | `.`。ワークスペース相対の実行/ツール解決ディレクトリです。パスがワークスペース外へ出ることはできません。 |
| `checks.<id>.command` | 実行ファイルと引数の配列であり、shell 式ではありません。`command` と明示的なビルドアダプターでは必須です。 |
| `checks.<id>.parser` | `text`、`build`、`ruff-json`、`pyright-json`、`go-json`、`golangci-json`、`rust-json`、`checkstyle-xml`、`pmd-json`、`sarif-json`、`clang-json`。 |
| `checks.<id>.timeoutMs` / `env` | 外部ツールのタイムアウトは `1000`～`600000` ミリ秒で、環境変数を上書きできます。stdout/stderr はストリームごとに 200,000 文字に制限されます。 |
| `checks.<id>.exclude` / `patterns` | 呼び出し前と解析後の各検出結果に適用する、ワークスペース相対の minimatch glob です。不正な glob は拒否されます。 |
| `checks.<id>.options.reportFile` | 検出されたプロジェクトルートからの相対パスで指定する、任意の Java Checkstyle/PMD レポートです。コマンドログより先にレポートを解析します。 |

ビルドログは stdout/stderr の各ストリームで 200,000 文字に制限されます。ビルドの検出結果に架空のファイル位置は設定しません。ログと終了状態は CLI JSON または MCP で確認してください。

## 信頼、ライフサイクル、鮮度

プロジェクトのプラグイン、設定、ビルドコマンドはローカルコードを実行する場合があります。ワークスペースを確認してから信頼を付与してください。MCP から信頼を付与することはできません。信頼はリポジトリ外に保存され、`.code-inspection.json` の内容と完全に結び付けられます。このファイルを作成または編集した後は、`code-inspection trust .` を再度実行してください。このハッシュは、すべての依存関係やツール設定を対象にするものではありません。

サービスはオンデマンドで起動し、クライアントも実行中の処理もない状態が 30 秒続くと通常は終了します。検出結果/実行履歴はメモリ上にあり、サービスの再起動で消えます。グローバルスケジューラーで同時に実行できる処理は最大 2 件です。ビルド/リソースグループではさらに低い上限を設定できます。パッケージ版の各実行は隔離された worker で動作し、ハードタイムアウトと子孫プロセスのクリーンアップが適用されます。タイムアウトは検出結果ではなく、エラーコード `timeout` を持つ失敗した実行です。ファイルシステムイベントで結果は無効になります。自動実行にはエディターの保存通知が必要です。

| 環境変数 | 用途 |
| --- | --- |
| `CODE_INSPECTION_DATA_DIR` | 信頼/サービス検出データの保存先を上書きします。既定値は Windows のローカルアプリデータ、macOS の Application Support、Linux の XDG state です。 |
| `CODE_INSPECTION_IDLE_TIMEOUT_MS` | 既定の `30000` ミリ秒アイドルタイムアウトを上書きします。 |
| `CODE_INSPECTION_WORKER_PATH` | 埋め込みとリリーステスト向けに、パッケージ済み worker bundle のパスを上書きします。 |

## MCP 連携

インストール済みの実行ファイルをローカル stdio サーバーとして使用します。

```json
{
  "command": "code-inspection-mcp",
  "args": []
}
```

クライアントの形式に従って、このオブジェクトをサーバー設定に配置してください。対応している場合はプロセスの作業ディレクトリをワークスペースに設定し、それ以外の場合はすべてのツール呼び出しで絶対パスの `workspace` を渡します。既定値はサーバープロセスの作業ディレクトリです。1 つの MCP プロセスから複数の信頼済みルートへ接続できます。ログは stderr に出力されます。

| ツール | 入力と結果 |
| --- | --- |
| `list_inspectors` | 設定済みの検査と対応するすべての言語 ID を返す、読み取り専用の動的リストです。 |
| `list_projects` | 読み取り専用のネストしたプロジェクト検出です。検査または言語で絞り込めます。 |
| `run_inspection` | 動的な `check_id` は必須で、`language`、`project`、`files`（最大 100 件）は任意です。`runId` を含む実行レコードを直ちに返します。 |
| `get_run` | `run_id` は必須です。実行状態、サマリー/エラー、検出結果、鮮度メタデータを返します。 |
| `get_findings` | `check_id`、`language`、`project`、`file`、`offset`（既定値 `0`）、`limit`（既定値 `50`、最大 `500`）、`include_stale`（既定値 `false`）は任意です。1 ページ分の結果と最新の実行を返します。`hasMore` が true の間は `nextOffset` を使って続きを取得します。 |

すべてのツールは `workspace` と `response_format`（既定値は `json`、または `markdown`）を受け取り、選択した形式の構造化コンテンツを返します。

1. `list_inspectors` を呼び出し、有効な検査を選択します。
2. `{"workspace":"/path/to/project","check_id":"eslint"}` を指定して `run_inspection` を呼び出します。
3. 返された `runId` を `run_id` として、同じワークスペースの `get_run` に渡します。
4. `completed`、`failed`、`cancelled`、`superseded` のいずれかになるまでポーリングします。`queued` と `running` は終了状態ではありません。
5. `get_findings` を読み取り、鮮度を確認します。完了した実行にもエラーが含まれる場合があります。失敗した実行では以前の検出結果が古い状態で保持され、既定では非表示になります。

MCP にキャンセル/信頼ツールはありません。CLI を使用してください。検出結果の範囲はゼロ起点の UTF-16 位置です。CLI/Markdown で表示する位置は 1 起点です。

## エディター

### VS Code

`npm ci` と `npm run build` の実行後に次を実行します。

```sh
npm run package:vscode
code --install-extension artifacts/code-inspection-vscode-0.2.0.vsix
```

ローカルワークスペースを開き、Workspace Trust を付与します。拡張はバンドル済み LSP を起動し、対応するローカル信頼記録を付与して、ワークスペースフォルダーごとにバンドル済み MCP 定義を提供します。対応する JavaScript、TypeScript、Python、Java、Go、Rust、C、C++ ファイルを保存すると検査され、修正して保存すると解決済みの診断が消えます。信頼されていないエディターセッションでは LSP 検査を実行せず、MCP 定義も公開しません。

| コマンド/設定 | 用途 |
| --- | --- |
| `Code Inspection: Run` | アクティブなワークスペースで、設定済みの既定検査を要求します。 |
| `Code Inspection: Cancel Last Run` | 最後に手動で開始した実行のキャンセルを要求します。 |
| `codeInspection.defaultCheck` | 動的に設定されたチェック ID で、既定値は `eslint` です。 |
| `codeInspection.runtimePath` | 任意の外部 LSP 実行ファイルです。空の場合はバンドル版を使用します。バンドル済み MCP 実行ファイルを置き換えるものではありません。 |

**Code Inspection** 出力チャンネルには、ランチャー/手動コマンドのメッセージが表示されます。他の拡張が重複する診断を公開する場合があります。

### Zed

前述の runtime tarball をインストールし、Zed の PATH に `code-inspection-lsp` を配置して、CLI からワークスペースを信頼します。`extensions/zed` を開発拡張としてインストールしてください。[Zed ガイド](extensions/zed/README.md)に、言語サーバー/ネイティブ MCP の設定があります。ホストの作業ディレクトリが異なる場合は、MCP 呼び出しに `workspace` を渡してください。

この拡張はインストール済みランタイムを起動し、自身ではダウンロードしません。サーバーのスモークテストでは Zed UI の完全なワークフローを検証できないため、インストール済みエディターでの確認は手動リリース手順として残ります。

## モノレポ構成と開発

```text
CLI ----------------------+
MCP stdio ----------------+--> ワークスペースサービス --> 言語アダプター/ツール
VS Code / Zed --> LSP -----+    共有スケジューリングとメモリ内の検出結果
```

| パス | 担当 |
| --- | --- |
| [packages/core](packages/core) | `@zakotoys/code-inspection-core`：言語カタログ、プロジェクト検出、設定/信頼、レジストリ、ツールランナー、parser、アダプター。エディター/MCP には依存しません。 |
| [packages/runtime](packages/runtime) | `@zakotoys/code-inspection-runtime`：CLI、IPC、サービス、MCP、LSP。 |
| [extensions/vscode](extensions/vscode) | VS Code クライアント、コマンド、信頼、MCP provider。 |
| [extensions/zed](extensions/zed) | Rust/WASM ランチャーと manifest。 |
| [tests/fixtures](tests/fixtures) | 対応する各言語の正常/エラー fixture とツール出力。 |
| [scripts](scripts) | パッケージ処理とプロセスレベルのスモーク検査。 |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | Windows/macOS/Linux での Node 24 検査、バージョン固定済み Ubuntu 言語ツールマトリクス、エディターのパッケージ処理。 |
| [.github/workflows/release.yml](.github/workflows/release.yml) | tag を契機とする npm 公開と GitHub Release 作成。 |

```sh
npm ci
npm run check
npm run smoke:lsp
npm run smoke:mcp
npm run smoke:languages
npm run package:core
npm run package:runtime
npm run smoke:package
```

`check` は npm workspace をビルドしてテストを実行します。`smoke:languages` は対応するすべての言語で正常/エラーの CLI 検査を実行し、外部ツールマトリクスを検証します。CI で `STRICT_LANGUAGE_SMOKE=1` と `LANGUAGE_SMOKE_PROTOCOLS=1` を設定すると、すべてのツールと MCP/LSP フローが必須になります。プロトコルのスモーク検査では実際の子プロセスを使用します。パッケージのスモーク検査では、ローカル tarball を一時 consumer にインストールし、信頼、共有検出結果、空白を含むパス、アイドルシャットダウンを検証します。

すべての配布成果物をビルドするには、次を実行します。

```sh
rustup target add wasm32-wasip2
npm run package
```

`artifacts/` の出力：`zakotoys-code-inspection-core-0.2.0.tgz`、`zakotoys-code-inspection-runtime-0.2.0.tgz`、`code-inspection-vscode-0.2.0.vsix`、`code-inspection-zed-0.2.0.wasm`。core/runtime/VS Code の各パッケージコマンドを個別に実行する場合は、事前にビルドが必要です。`package:zed` は自身で Cargo を実行します。

メンテナーは、対象の `main` コミットの CI が成功してから `vX.Y.Z` tag を push します。**Publish release** ワークフローは、tag と npm workspace、runtime 依存関係、Cargo、Zed、ランタイムの各バージョンが一致することを検証し、テストとプロトコルのスモーク検査を再実行して 4 つの成果物をビルドします。その後、npm provenance 付きで core、runtime の順に公開し、`softprops/action-gh-release` で GitHub Release を作成します。安定版には npm の `latest` tag、プレリリースには `next` を使用します。Release には 2 つの npm tarball、VSIX、Zed WASM、`SHA256SUMS` が含まれます。npm 公開には GitHub OIDC Trusted Publishing を使用し、まだ存在しないパッケージを初回作成するときだけリポジトリの `NPM_TOKEN` が必要です。

## トラブルシューティングと対象範囲

| 症状 | 確認事項 |
| --- | --- |
| 設定編集後に信頼されていない状態になる | ファイルを確認し、信頼を再度付与してください。 |
| `missing-tool` / `unsupported-tool` | `cwd` でのプロジェクト依存関係の解決、公開 API、Node の要件を確認してください。 |
| `missing-configuration` | `tsconfig.json`、`pyproject.toml`、Java Wrapper、C/C++ コンパイルデータベースなど、解析ツールのプロジェクト設定を確認してください。 |
| 検出結果が空 | `status`、検査が有効か、古い結果のフィルタリング、サービスの再起動を確認してください。空の結果だけでは検査の成功を証明できません。 |
| ビルド失敗にソース診断がない | ビルドの検出結果はワークスペースレベルです。実行の JSON/MCP 出力を確認してください。 |
| サービスのハンドシェイクが拒否される | CLI/エディターのランタイムバージョンが一致していることを確認し、更新後は古いクライアント/サービスを再起動してください。 |

対象範囲：ローカルファイルシステムのワークスペースと、JavaScript/TypeScript、Python、Java、Go、Rust、C、C++ の正規化済み診断。自動修正、履歴の永続化、リモート/ブラウザワークスペース、任意の言語プラグイン読み込みは対象外です。外部ツールは `shell: false` で実行し、出力上限、タイムアウト、キャンセル、およびプラットフォームで可能な場合のプロセスツリーのクリーンアップを適用します。

[アーキテクチャとデリバリー計画](docs/plan/code-inspection-architecture-and-delivery.md)には、当初の調査と受け入れ基準が記録されています。[多言語拡張計画](docs/plan/multilingual-inspection-expansion.zh-CN.md)には、v0.2.0 の言語/ツールアーキテクチャが記録されています。

## ライセンス

[Apache-2.0](LICENSE)
