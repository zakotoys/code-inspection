# Code Inspection Runtime

This package provides the `code-inspection` CLI, the local workspace service used by editor adapters, the `code-inspection-mcp` stdio server, and the `code-inspection-lsp` stdio language server.

The MCP server never writes logs to stdout. Use stderr or the CLI output for diagnostics.
