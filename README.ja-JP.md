# Code Inspection

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語**

Code Inspection は、エディター、CLI、MCP エージェントが同じローカルワークスペースサービスの診断結果を共有する多言語コード検査基盤です。

## 対応言語と検査器

JavaScript/TypeScript（ESLint、TypeScript Compiler API）、Python（Ruff、Pyright）、Java（Checkstyle、PMD、Maven/Gradle または明示的なビルド）、Go（`go vet`、任意の `golangci-lint`）、Rust（`cargo check`、任意の `cargo clippy`）、C/C++（Clang、`clang-tidy`）に対応します。`clang-tidy` には `compile_commands.json` が必要です。ツールや依存関係は自動インストールしません。

## クイックスタート

```sh
npm ci
npm run build
npm run package:core
npm run package:runtime
npm install --global ./artifacts/zakotoys-code-inspection-core-0.2.0.tgz ./artifacts/zakotoys-code-inspection-runtime-0.2.0.tgz
cd /path/to/project
code-inspection init
code-inspection trust .
code-inspection capabilities
code-inspection inspect --check eslint
```

`init` は v2 の `.code-inspection.json` を作成し、全ての組み込み検査器を一覧化します。既定で有効なのは ESLint だけです。既存ファイルは上書きしません。

## 設定

トップレベルは `version: 2` と `checks` です。旧 v1 の `inspectors` 構造は拒否されます。

```json
{
  "version": 2,
  "checks": {
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

使用できる language ID は `javascript`、`typescript`、`python`、`java`、`go`、`rust`、`c`、`cpp` です。`scope` は `file`、`project`、`workspace`、コマンドは shell 式ではなく引数配列です。プロジェクト境界は `package.json`、Python 設定、Maven/Gradle、`go.mod`、`Cargo.toml`、CMake/コンパイルデータベースから検出します。

## CLI と MCP

`code-inspection capabilities` は動的なチェック ID と言語を表示します。`code-inspection projects` はネストしたプロジェクトを列挙します。`inspect --check <id>`、`findings --check <id>` で任意の有効なチェックを指定できます。MCP には `list_inspectors`、`list_projects`、`run_inspection`、`get_run`、`get_findings` があります。MCP は trust を付与できません。

## エディター

VS Code と Zed の LSP セレクターは JavaScript、TypeScript、Python、Java、Go、Rust、C、C++ を登録します。ネイティブ言語サーバーと共存し、本製品は自身の診断だけを公開します。

```sh
npm run package:vscode
code --install-extension artifacts/code-inspection-vscode-0.2.0.vsix
```

## アーキテクチャ

```text
CLI / VS Code / Zed / MCP → 認証済み IPC → Workspace Service
  Language Catalog → Project Locator → Inspector Registry
  → Tool Runner → JSON/XML/SARIF/Text parser → normalized Finding
```

サービスは信頼確認、保存時の debounce、同一プロジェクトの要求統合、キャンセル、timeout、stale/generation と結果置換を一元管理します。全体で最大 2 実行、ビルド資源グループは既定で直列化され、パッケージ版は各検査を worker に隔離します。timeout は `timeout` エラーを持つ failed run です。外部コマンドは `shell: false`、出力上限、プロセスグループ終了を使用します。

## 検証

```sh
npm run check
node scripts/smoke-lsp.mjs
node scripts/smoke-mcp.mjs
npm run smoke:languages
npm run package:core
npm run package:runtime
npm run smoke:package
```

詳細な設計と受け入れ条件は[多言語コード検査拡張計画](docs/plan/multilingual-inspection-expansion.zh-CN.md)を参照してください。

## License

[Apache-2.0](LICENSE)
