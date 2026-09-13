# Code Inspection for Zed

The extension attaches the Code Inspection LSP to JavaScript, TypeScript, Python, Java, Go, Rust, C, and C++ buffers. It uses the editor's `textDocument/didSave` notification, so it can run beside each native language server.

Install the runtime from the local core/runtime tarballs using the [repository quick start](../../README.md#quick-start-from-this-repository), then trust the workspace before enabling the extension:

```text
code-inspection trust /path/to/workspace
```

The runtime executable must be available as `code-inspection-lsp` on Zed's PATH. Configure Zed MCP separately through native context-server settings. Pass an absolute `workspace` in MCP tool calls if the server's working directory is not the inspected project:

```json
{
  "context_servers": {
    "code-inspection": {
      "command": {
        "path": "code-inspection-mcp",
        "args": []
      }
    }
  },
  "languages": {
    "JavaScript": { "language_servers": ["code-inspection", "..."] },
    "TypeScript": { "language_servers": ["code-inspection", "..."] },
    "Python": { "language_servers": ["code-inspection", "..."] },
    "Java": { "language_servers": ["code-inspection", "..."] },
    "Go": { "language_servers": ["code-inspection", "..."] },
    "Rust": { "language_servers": ["code-inspection", "..."] },
    "C": { "language_servers": ["code-inspection", "..."] },
    "C++": { "language_servers": ["code-inspection", "..."] }
  }
}
```
