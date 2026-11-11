# Cómo funciona dsh-plugin-price-watcher

Vigilante de precios para DeepSeek Harness: guarda productos, extrae precio de JSON-LD/OpenGraph, mantiene historial y alerta cuando baja del objetivo, con confirmacion y auditoria.

## Arquitectura

```
DSH ──MCP stdio──► server.mjs (bundle single-file)
                    └─ lógica local del plugin
```

## Herramientas reales

- `status`: Estado
- `add_watch`: Vigilar producto
- `watches`: Listar productos
- `remove_watch`: Quitar producto
- `check`: Comprobar precios
- `history`: Historial

## Seguridad

- Lectura por defecto; acciones con `confirm:true`.
- Modo `read-only` por variable de entorno.
- Listas blancas cuando aplique.
- Auditoría en `<DSH_HOME>\cache\price-watcher\audit.jsonl`.
- Rate limit de acciones.

## Verificación

Tests end-to-end con el cliente MCP oficial (`@modelcontextprotocol/client@2.2.0`)
y artefacto empaquetado (`npm pack` → `postinstall` → servidor desplegado).
