# How dsh-plugin-price-watcher works

Vigilante de precios para DeepSeek Harness: guarda productos, extrae precio de JSON-LD/OpenGraph, mantiene historial y alerta cuando baja del objetivo, con confirmacion y auditoria.

## Architecture

```
DSH ──MCP stdio──► server.mjs (single-file bundle)
                    └─ local plugin logic
```

## Safety

- Read by default; actions require `confirm:true`.
- `read-only` mode via environment variable.
- Allowlists where applicable.
- Audit at `<DSH_HOME>\cache\price-watcher\audit.jsonl`.
- Action rate limit.

## Validation

End-to-end tests with the official MCP client (`@modelcontextprotocol/client@2.2.0`)
and the packaged artifact (`npm pack` → `postinstall` → deployed server).
