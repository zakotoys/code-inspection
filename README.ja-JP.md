# Code Inspection

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語**

エディター、ターミナル、AI エージェントで共有するローカル JavaScript / TypeScript 検査サービスです。プロジェクト自身の ESLint と TypeScript、明示的に設定したビルドを実行し、CLI、Model Context Protocol（MCP）、Language Server Protocol（LSP）の診断から共通の結果を利用できます。

## 機能

| 機能 | 動作 |
| --- | --- |
| ESLint | プロジェクトの ESLint と設定を読み込み、パターンまたは指定ファイルを検査します。ルール ID、重大度、位置を返します。 |
| TypeScript | 設定したプロジェクトのコンパイラー診断を収集し、ファイルは出力しません。プロジェクト参照を API に渡しますが、`tsc --build` のビルド制御は行いません。 |
| ビルド | 実行ファイルと引数の配列を実行します。作業ディレクトリ、環境変数、タイムアウト、上限付き stdout/stderr に対応し、非ゼロ終了はワークスペース単位のエラー診断になります。 |
| 共有サービス | 正規化したワークスペースルートごとに CLI、LSP、MCP が同じサービスへ接続します。認証付きローカル IPC として Windows 名前付きパイプまたは Unix socket を使用します。 |
| 保存時検査 | LSP 保存通知で有効な検査器を起動します。保存のデバウンス、待機中のファイル範囲の統合、古い実行による新しい結果の上書き防止に対応します。 |
| 結果の鮮度 | 診断にソース、コード、重大度、任意のファイル/範囲、実行 ID、世代を保持します。編集や観測したファイル変更で結果を古い状態にし、成功した検査が対象範囲の結果を置き換えます。 |
| CLI | 設定作成、信頼の付与/取り消し、検査、結果/状態の取得、キャンセル。テキスト/JSON 出力と用途別の終了コードを提供します。 |
| MCP | 検査開始、実行状態、ページ分割した診断取得の 3 ツール。構造化結果と JSON/Markdown テキストを返し、stdout はプロトコル専用です。 |
| VS Code | 同梱ランタイム、診断、複数フォルダー、手動実行/キャンセル、出力チャンネル、Workspace Trust、MCP 定義。 |
| Zed | インストール済み LSP を起動する Rust/WASM 拡張。JavaScript、TypeScript、TSX に対応し、ネイティブ MCP は別途設定します。 |
| 配布 | Core/runtime npm tarball、自己完結型 VSIX、Zed WASM、ビルド/テスト/プロトコル/パッケージ検証。 |

## 必要環境

- Core/runtime の宣言は Node.js `>=18.20` です。開発と CI は Node.js 24 を使用します。プロジェクトのツールがより新しい Node を要求する場合があります。
- `ESLint` API を公開するプロジェクトローカルの ESLint、またはコンパイラー API を公開する TypeScript。fixture は ESLint 10 と TypeScript 6 を使用します。
- VS Code 拡張には `1.103.0` 以降が必要です。
- Rust と `wasm32-wasip2` target は Zed 拡張をビルドする場合のみ必要です。

プロジェクト依存関係を自動インストールしたり、同梱の lint/コンパイラーで置き換えたりすることはありません。

## リポジトリからのクイックスタート

リポジトリのルートで実行します。

```sh
npm ci
npm run build
npm run package:core
npm run package:runtime
npm install --global ./artifacts/zakotoys-code-inspection-core-0.1.0.tgz ./artifacts/zakotoys-code-inspection-runtime-0.1.0.tgz
```

ESLint の依存関係と設定を用意した検査対象プロジェクトへ移動します。

```sh
cd /path/to/your-project
code-inspection init
code-inspection trust .
code-inspection inspect --inspector eslint
code-inspection findings
```

`init` は `.code-inspection.json` を作成し、ESLint を有効、TypeScript/ビルドを無効にします。既存ファイルは上書きしません。他の検査器は有効化してから指定してください。

この手順はローカル成果物を使用するため、公開 registry への配布は不要です。npm/エディターストアへの公開は別のリリース操作です。現在の CI はエディター成果物をビルドしてアップロードしますが、公開ワークフローはありません。

## CLI リファレンス

| コマンド | 用途 |
| --- | --- |
| `init` | 設定を作成します。 |
| `trust` / `revoke` | ローカル実行の信頼記録を付与/削除します。 |
| `inspect` | 指定した検査器を実行して完了を待ちます。既定は `eslint`。 |
| `findings` | 最大 500 件を取得します。古い結果は `--include-stale` で含めます。 |
| `status` | 信頼状態、実行中/最新の実行、診断件数を JSON 出力します。 |
| `cancel --run-id <id>` | 待機中または活動中の実行をキャンセルします。 |
| `help` / `--version` | ヘルプ/バージョンを表示します。 |

既定の対象は現在のディレクトリです。`--workspace`（`-w`）または位置引数で別のルートを指定できます。空白を含むパスは引用符で囲んでください。

```sh
code-inspection inspect -w /path/to/project -i eslint,typescript --json
code-inspection inspect -i eslint -f src/index.ts -f src/app.ts
code-inspection findings --json --include-stale
code-inspection status
code-inspection cancel --run-id <run-id>
code-inspection revoke /path/to/project
```

`--inspector`（`-i`）はカンマ区切りまたは繰り返し指定に対応します。`--file`（`-f`）も繰り返し可能で、1 リクエスト最大 100 ファイルです。TypeScript/ビルドは引き続きプロジェクト全体を検査します。`inspect --trust` は信頼を永続保存します。CLI は無効な検査器を警告付きでスキップします。

| `inspect` 終了コード | 意味 |
| --- | --- |
| `0` | 実施した検査に診断がない場合。すべてスキップされた場合も含みます。 |
| `1` | 警告やビルドの非ゼロ終了を含む診断が存在します。 |
| `2` | ツール不足や未信頼などの実行/リクエスト失敗。 |
| `3` | キャンセル、または新しい実行による置き換え。 |

## 設定

`.code-inspection.json` は省略可能で、その場合 ESLint のみ有効です。次の例では TypeScript も有効にしています。

```json
{
  "version": 1,
  "debounceMs": 300,
  "maxFindings": 2000,
  "inspectors": {
    "eslint": {
      "enabled": true,
      "cwd": ".",
      "patterns": ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"]
    },
    "typescript": {
      "enabled": true,
      "cwd": ".",
      "project": "tsconfig.json"
    },
    "build": {
      "enabled": false,
      "cwd": ".",
      "command": ["npm", "run", "build"],
      "timeoutMs": 120000,
      "env": {}
    }
  }
}
```

| 設定 | 既定値と動作 |
| --- | --- |
| `version` | `1`。未知のキーは拒否します。 |
| `debounceMs` | `300`。保存時のスケジュール遅延で、`0`–`10000` ミリ秒。 |
| `maxFindings` | `2000`。検査ごとの出力上限で、`1`–`10000`。集計は保持した診断を数えます。 |
| `inspectors.*.enabled` | セクション省略時は ESLint が有効、TypeScript/ビルドは無効。セクション追加時は明示してください。ビルドを有効にすると保存時にも実行します。 |
| `inspectors.*.cwd` | `.`。ワークスペース相対の実行/ツール解決ディレクトリ。各ルートに検査器ごと 1 設定です。 |
| `eslint.patterns` | 上記のソース glob。ファイルを明示したリクエストでは置き換えます。 |
| `typescript.project` | `tsconfig.json`。検査器の `cwd` からの相対パス。 |
| `build.command` | `["npm", "run", "build"]`。実行ファイルと引数であり、shell 式ではありません。 |
| `build.timeoutMs` | `120000`。`1000`–`600000` ミリ秒。 |
| `build.env` | `{}`。継承した環境変数へマージします。 |
| `inspectors.*.exclude` | Schema は受け付けますが、現在エンジンには適用されません。ESLint ignore と TypeScript 設定で範囲を制御してください。 |

ビルドログはストリームごとに最大 200,000 文字です。架空のソース位置は付けません。CLI JSON または MCP からログと終了状態を確認してください。

## 信頼、ライフサイクル、結果の鮮度

プロジェクトのプラグイン、設定、ビルドコマンドはローカルコードを実行します。内容を確認して信頼を付与してください。MCP ツールは信頼を付与できません。記録はリポジトリ外に保存され、`.code-inspection.json` の正確な内容に紐付きます。作成/変更後は `code-inspection trust .` を再実行してください。このハッシュはすべての依存関係やツール設定を追跡するものではありません。

サービスは必要時に起動し、クライアントと活動中の実行がない状態が通常 30 秒続くと終了します。診断と実行履歴はメモリ内のみで、再起動すると失われます。ファイルシステムイベントは結果を古い状態にします。自動実行にはエディターの保存通知が必要です。

| 環境変数 | 用途 |
| --- | --- |
| `CODE_INSPECTION_DATA_DIR` | 信頼/サービス検出記録の保存先を変更します。既定は Windows のローカルアプリデータ、macOS の Application Support、Linux の XDG state です。 |
| `CODE_INSPECTION_IDLE_TIMEOUT_MS` | 既定 `30000` ミリ秒のアイドルタイムアウトを変更します。 |

## MCP 連携

インストール済み実行ファイルをローカル stdio サーバーとして設定します。

```json
{
  "command": "code-inspection-mcp",
  "args": []
}
```

クライアントの形式に従ってサーバー設定へ配置してください。対応していればプロセスの作業ディレクトリをワークスペースに設定し、そうでなければ各ツール呼び出しで絶対パスの `workspace` を渡します。既定はサーバープロセスの作業ディレクトリです。1 つの MCP プロセスから複数の信頼済みルートへ接続できます。ログは stderr に出力します。

| ツール | 入力と結果 |
| --- | --- |
| `run_inspection` | 必須 `inspector`：`eslint`、`typescript`、`build`。任意の `files` は最大 100。`runId` を持つ実行記録を即座に返します。 |
| `get_run` | 必須 `run_id`。状態、集計/エラー、診断、鮮度情報を返します。 |
| `get_findings` | 任意の `inspector`、`file`、`offset`（既定 `0`）、`limit`（既定 `50`、最大 `500`）、`include_stale`（既定 `false`）。ページと最新の実行を返し、`hasMore` が true なら `nextOffset` で続けます。 |

すべてのツールは `workspace` と `response_format`（既定 `json`、または `markdown`）を受け付け、どちらでも構造化内容を返します。

1. `run_inspection` に `{"workspace":"/path/to/project","inspector":"eslint"}` を渡します。
2. 同じワークスペースで、返された `runId` を `run_id` として `get_run` に渡します。
3. `completed`、`failed`、`cancelled`、`superseded` までポーリングします。`queued` と `running` は未完了です。
4. `get_findings` と鮮度を確認します。完了した実行にもエラーは含まれます。失敗時は以前の診断が古い状態で保持され、既定では表示されません。

キャンセル/信頼の MCP ツールはありません。CLI を使用してください。診断範囲はゼロ始まりの UTF-16 位置、CLI/Markdown の表示位置は 1 始まりです。

## エディター

### VS Code

`npm ci` と `npm run build` の後に実行します。

```sh
npm run package:vscode
code --install-extension artifacts/code-inspection-vscode-0.1.0.vsix
```

ローカルワークスペースを開き、Workspace Trust を付与します。拡張は同梱 LSP を起動し、対応するローカル信頼記録を作成し、フォルダーごとに同梱 MCP 定義を提供します。対応する JS/TS ファイルを保存すると検査し、修正後に再保存すると解決済み診断が消えます。未信頼セッションでは LSP 検査を実行せず、MCP 定義も公開しません。

| コマンド/設定 | 用途 |
| --- | --- |
| `Code Inspection: Run` | アクティブなワークスペースで既定の検査器を実行します。 |
| `Code Inspection: Cancel Last Run` | 最後に手動開始した実行のキャンセルを要求します。 |
| `codeInspection.defaultInspector` | 既定 `eslint`。`typescript`、`build` も指定可能。 |
| `codeInspection.runtimePath` | 任意の外部 LSP 実行ファイル。空なら同梱版を使用します。同梱 MCP は置き換えません。 |

**Code Inspection** 出力チャンネルに起動/手動コマンドのメッセージを表示します。他の拡張が重複した診断を出す場合があります。

### Zed

上記 runtime tarball をインストールし、Zed の PATH から `code-inspection-lsp` を実行できるようにして、CLI でワークスペースを信頼します。`extensions/zed` を開発拡張としてインストールしてください。[Zed ガイド](extensions/zed/README.md) に言語サーバーとネイティブ MCP 設定があります。ホストの作業ディレクトリが異なる場合は MCP に `workspace` を渡してください。

拡張はインストール済みランタイムを起動し、ダウンロードはしません。サーバーの smoke テストは Zed UI 全体を検証しないため、実際のエディター検証は手動リリース手順として残ります。

## Monorepo と開発

```text
CLI ----------------------+
MCP stdio ----------------+--> Workspace service --> ESLint / TypeScript / build
VS Code / Zed --> LSP -----+    shared scheduling and in-memory findings
```

| パス | 責務 |
| --- | --- |
| [packages/core](packages/core) | `@zakotoys/code-inspection-core`：設定、信頼、データ契約、検査器。エディター/MCP 依存なし。 |
| [packages/runtime](packages/runtime) | `@zakotoys/code-inspection-runtime`：CLI、IPC、サービス、MCP、LSP。 |
| [extensions/vscode](extensions/vscode) | VS Code クライアント、コマンド、信頼、MCP provider。 |
| [extensions/zed](extensions/zed) | Rust/WASM 起動器と manifest。 |
| [tests/fixtures](tests/fixtures) | 正常/エラーありの lint/type プロジェクトと失敗するビルド。 |
| [scripts](scripts) | パッケージ作成とプロセス単位の smoke 検証。 |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | Windows/macOS/Linux の Node 24 検証と Linux の拡張パッケージ作成。 |

```sh
npm ci
npm run check
npm run smoke:lsp
npm run smoke:mcp
npm run package:core
npm run package:runtime
npm run smoke:package
```

`check` は npm workspaces をビルドしてテストします。プロトコル smoke は実際の子プロセスを使用します。パッケージ smoke は一時プロジェクトにローカル tarball をインストールし、信頼、共有結果、空白付きパス、アイドル終了を確認します。

全成果物を作成する場合：

```sh
rustup target add wasm32-wasip2
npm run package
```

`artifacts/` に `zakotoys-code-inspection-core-0.1.0.tgz`、`zakotoys-code-inspection-runtime-0.1.0.tgz`、`code-inspection-vscode-0.1.0.vsix`、`code-inspection-zed-0.1.0.wasm` を出力します。個別の core/runtime/VS Code パッケージコマンドには事前ビルドが必要です。`package:zed` は Cargo を実行します。

## トラブルシューティングと対象範囲

| 症状 | 確認事項 |
| --- | --- |
| 設定編集後に未信頼になる | 内容を確認して信頼を再付与します。 |
| `missing-tool` / `unsupported-tool` | `cwd` での依存解決、公開 API、Node 要件。 |
| `missing-configuration` | ESLint 設定または TypeScript プロジェクトパス。 |
| 結果が空 | `status`、検査器の有効状態、古い結果の除外、サービス再起動。空というだけでは検査成功を意味しません。 |
| ビルド失敗のソース診断がない | ワークスペース単位の結果なので、実行 JSON/MCP 出力を確認します。 |
| サービスの handshake 拒否 | CLI/エディターのランタイムを揃え、更新後は古いクライアント/サービスを再起動します。 |

対象はローカルファイルシステムのワークスペース、JS/TS lint/type 診断、設定済みビルドです。自動修正、永続履歴、リモート/ブラウザーワークスペース、任意言語向け検査器フレームワーク、エージェントの自発的起動はありません。ESLint/TypeScript は隔離 worker ではなくプロセス内で動作し、キャンセルは協調的です。ビルドのキャンセル/タイムアウトは終了を要求しますが、すべての子孫プロセスの終了を全環境で保証するものではありません。

[アーキテクチャと実装計画](docs/plan/code-inspection-architecture-and-delivery.md) は当初の調査と予定した受け入れ基準です。この README は、計画上の全機能を実装済みとみなさず、実際の動作を説明します。

## ライセンス

[Apache-2.0](LICENSE)
