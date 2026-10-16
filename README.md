# gitpp-hub-api

> Portable HTTP API for the git.pp hub. Records, validation, digest, fold, verify, root. Single file, no deps.

## What this is

A complete HTTP API for the git.pp hub. The "write" counterpart to
[`gitpp-fold-edge`](https://github.com/SuperInstance/gitpp-fold-edge)
(which is read-only). Adds records, validates them, computes the
digest, stores them, and exposes the fold.

The only dependency is the
[`gitpp-js`](https://github.com/SuperInstance/gitpp-js) port (inlined
as ESM). No DB, no framework, no auth (add a reverse proxy for
production).

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| GET    | `/`                          | HTML status page |
| GET    | `/health`                    | `{ok: true}` |
| GET    | `/version`                   | `{name, version, sha}` |
| GET    | `/projects`                  | List projects |
| POST   | `/projects`                  | Create a project |
| GET    | `/projects/:p`               | Project info |
| GET    | `/projects/:p/records`       | List records (supports `?after=<id>`) |
| POST   | `/projects/:p/records`       | Add a record (validates, computes digest) |
| GET    | `/projects/:p/records/:id`   | Get a record |
| POST   | `/projects/:p/fold`          | Fold the current set |
| POST   | `/projects/:p/verify`        | Verify a checkpoint |
| POST   | `/projects/:p/root`          | Compute closure root. Body: `{at}` |

## Run

```bash
# In-memory (data lost on restart)
PORT=8788 node server.mjs

# Persistent (JSON per project, one file per project)
QUILT_DATA_DIR=/var/lib/gitpp node server.mjs
```

## Try it

```bash
# Create a project
curl -X POST http://localhost:8788/projects -d '{"name":"demo"}'

# Add a record
curl -X POST http://localhost:8788/projects/demo/records \
  -H "content-type: application/json" \
  -d '{"id":"a","kind":"task","parents":[],"effects":{"x":1},"reason":null}'

# Fold it
curl -X POST http://localhost:8788/projects/demo/fold

# Verify a checkpoint
curl -X POST http://localhost:8788/projects/demo/verify \
  -H "content-type: application/json" \
  -d '{"checkpoint":{"at":"a","state":{"x":1},"closureRoot":"..."}}'
```

## Persistence

By default, projects live in memory (data lost on restart). Set
`QUILT_DATA_DIR=/path/to/dir` for JSON-per-project file persistence.
Each project becomes a single JSON file at
`$QUILT_DATA_DIR/projects/<name>.json`.

Suitable for small-to-medium sets (<10k records). For larger sets,
point the storage layer at a real DB.

## Authentication

None. The API trusts all callers. For production, add a reverse
proxy (nginx, Caddy) with TLS and an auth layer (API key, JWT).

## See also

- [`git.pp-spec`](https://github.com/SuperInstance/git.pp-spec) v0.3.6
- [`gitpp-js`](https://github.com/SuperInstance/gitpp-js) v0.1.3 (the only dep)
- [`gitpp-fold-edge`](https://github.com/SuperInstance/gitpp-fold-edge) — read-only worker
- [`gitpp-cross-port`](https://github.com/SuperInstance/gitpp-cross-port) — 1000/1000 byte-equivalence
