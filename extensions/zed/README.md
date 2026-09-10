# Code Inspection for Zed

The extension attaches the Code Inspection LSP to JavaScript, TypeScript, and TSX buffers. It uses the editor's `textDocument/didSave` notification, so it can run beside the existing JavaScript/TypeScript language server.

Install the runtime before enabling the extension:

```text
npm install --global @zakotoys/code-inspection-runtime
code-inspection trust /path/to/workspace
```

The runtime executable must be available as `code-inspection-lsp` on Zed's PATH. Zed MCP is configured separately through native context-server settings because MCP-only extension wrappers are deprecated:

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
    "TSX": { "language_servers": ["code-inspection", "..."] }
  }
}
```
