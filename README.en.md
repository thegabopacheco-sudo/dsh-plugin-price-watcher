# dsh-plugin-price-watcher — Price Watcher

Vigilante de precios para DeepSeek Harness: guarda productos, extrae precio de JSON-LD/OpenGraph, mantiene historial y alerta cuando baja del objetivo, con confirmacion y auditoria.

## Tools

| Tool | Qué hace |
|---|---|
| `status` | Estado |
| `add_watch` | Vigilar producto |
| `watches` | Listar productos |
| `remove_watch` | Quitar producto |
| `check` | Comprobar precios |
| `history` | Historial |

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-price-watcher` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-price-watcher
```

## Seguridad

- Lectura por defecto; escritura solo con `confirm:true` y pedido explícito.
- `DSH_PRICE_WATCHER_MODE=read-only` desactiva acciones.
- Listas blancas y auditoría en `<DSH_HOME>\cache\price-watcher\audit.jsonl`.

## Licencia

MIT © thegabopacheco-sudo
