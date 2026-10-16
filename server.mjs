#!/usr/bin/env node
// gitpp-hub-api — portable HTTP API for the git.pp hub
// Single file, no deps beyond the gitpp-js port. Runs on Node 18+.
//
// Endpoints:
//   GET  /                          → HTML status page
//   GET  /health                    → { ok: true }
//   GET  /version                   → { name, version, sha }
//   GET  /projects                  → list projects
//   POST /projects                  → create project
//   GET  /projects/:p               → project info
//   GET  /projects/:p/records       → list records (paginated)
//   POST /projects/:p/records       → add a record (validates + computes digest)
//   GET  /projects/:p/records/:id   → get a record
//   POST /projects/:p/fold          → fold the current set
//   POST /projects/:p/verify        → verify a checkpoint
//   POST /projects/:p/root          → compute closure root at a record
//
// Storage: in-memory by default. Override with QUILT_DATA_DIR for file
// persistence (JSON per project).

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recordLeaf, derive, verifyCheckpoint, closureRoot } from "./src/gitpp.js";

// ---------------------------------------------------------------- gating
// A nudge is not just a record. It is a DECISION (which the gate routes)
// followed by an ACTION, and the action's parent IS the decision record --
// so the action's closure root cannot exist without it. If you delete the
// receipt, the action becomes an orphan and its root becomes null. See
// gitpp-decision-parent, where that shape was measured rather than assumed
// (the receipt-after-action shape does NOT work, and this comment exists so
// nobody re-derives it the wrong way round).
const GATE = {
  threshold: parseFloat(process.env.GITPP_GATE_THRESHOLD || "0.80"),
  // Fail closed. No signal is never consent.
  onMissing: "block",
};

/** The parent check is decidable, so it is decided in code, not by a model. */
function parentIsCorrect(folded, key, proposedParent) {
  const expected = folded?.setters?.[key] ?? null;
  return { ok: proposedParent === expected, expected, actual: proposedParent ?? null };
}

/**
 * Route a proposed nudge. The parent check is exact and offline. The intent
 * check is a calibrated structured decision (TypeSafe Jev) and is OPTIONAL:
 * with no key configured, the gate runs parent-only and that is honest, not
 * fail-open, because the parent check is the one that can be wrong in a way
 * that silently discards the nudge.
 */
function route({ folded, key, record, intent }) {
  const chk = parentIsCorrect(folded, key, record.parents?.[0]);
  if (!chk.ok) {
    return { action: "block", reason: `parent ${chk.actual} is not the setter ${chk.expected}`, parent: chk, intent: null };
  }
  if (intent === undefined || intent === null) {
    return {
      action: GATE.onMissing === "block" ? "block" : "review",
      reason: "no intent signal (no gate key configured)",
      parent: chk, intent: null,
    };
  }
  if (intent < GATE.threshold) {
    return { action: "review", reason: `should_apply=${intent} below ${GATE.threshold}`, parent: chk, intent };
  }
  return { action: "act", reason: "all gates clear", parent: chk, intent };
}

const NAME = "gitpp-hub-api";
const VERSION = "0.1.0";
const SHA = "fc1fbb9";
const DATA_DIR = process.env.QUILT_DATA_DIR || null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projects = new Map();

function projectKey(name) { return `projects/${name}.json`; }

function loadProject(name) {
  if (!DATA_DIR) return null;
  const path = join(DATA_DIR, projectKey(name));
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { records: new Map(Object.entries(data.records || {})) };
  } catch { return null; }
}

function saveProject(name, project) {
  if (!DATA_DIR) return;
  const path = join(DATA_DIR, projectKey(name));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ records: Object.fromEntries(project.records) }, null, 2));
}

function getProject(name) {
  if (!projects.has(name)) {
    projects.set(name, loadProject(name) || { records: new Map() });
  }
  return projects.get(name);
}

function listProjects() {
  if (DATA_DIR && existsSync(join(DATA_DIR, "projects"))) {
    return readdirSync(join(DATA_DIR, "projects")).map(f => f.replace(/\.json$/, ""));
  }
  return Array.from(projects.keys());
}

function json(data, status = 200, extra = {}) {
  return { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra }, body: JSON.stringify(data, null, 2) };
}
// json() RETNS a response description; it does not write to the socket.
// Every handler must end with `respond(res, json(...), )` or res.end() is
// never called and the request hangs until the client times out. The nudge
// handler shipped doing `return json(...)` for exactly this reason, which
// looked like an infinite loop in the fold and was nothing of the kind.
function respond(res, r) {
  res.statusCode = r.status;
  Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
  return res.end(r.body);
}

function err(message, status = 400) { return json({ error: message }, status); }
function html(s) { return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: s }; }

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>gitpp-hub-api</title>
<style>
body { font-family: ui-monospace, monospace; max-width: 800px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.6; }
h1 { margin-bottom: 0.5rem; }
.tagline { color: #888; margin-bottom: 2rem; }
h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee; }
th { color: #888; font-weight: 500; }
code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; }
.pill { display: inline-block; padding: 0.1rem 0.5rem; background: #e0f0e0; color: #080; border-radius: 3px; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>gitpp-hub-api</h1>
<p class="tagline">Portable HTTP API for the git.pp hub. v${VERSION}.</p>
<p><span class="pill">healthy</span> <code>${NAME}@${SHA}</code></p>
<h2>What this is</h2>
<p>A <a href="https://github.com/SuperInstance/git.pp-spec">git.pp-spec</a> v0.3.6 hub. Adds records, validates them (computes digest), stores them, and exposes the fold via HTTP. The <a href="https://github.com/SuperInstance/gitpp-js">gitpp-js</a> port is the only dependency. No DB, no framework, no auth (add a reverse proxy for production).</p>
<h2>Endpoints</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Notes</th></tr>
<tr><td>GET</td><td><code>/health</code></td><td><code>{ok: true}</code></td></tr>
<tr><td>GET</td><td><code>/version</code></td><td><code>{name, version, sha}</code></td></tr>
<tr><td>GET</td><td><code>/projects</code></td><td>List projects</td></tr>
<tr><td>POST</td><td><code>/projects</code></td><td>Create a project</td></tr>
<tr><td>GET</td><td><code>/projects/:p</code></td><td>Project info + record count</td></tr>
<tr><td>GET</td><td><code>/projects/:p/records</code></td><td>List records (supports <code>?after=&lt;id&gt;</code>)</td></tr>
<tr><td>POST</td><td><code>/projects/:p/records</code></td><td>Add a record. Returns <code>{id, leaf}</code></td></tr>
<tr><td>GET</td><td><code>/projects/:p/records/:id</code></td><td>Get a specific record (with digest)</td></tr>
<tr><td>POST</td><td><code>/projects/:p/fold</code></td><td>Fold the current set</td></tr>
<tr><td>POST</td><td><code>/projects/:p/verify</code></td><td>Verify a checkpoint</td></tr>
<tr><td>POST</td><td><code>/projects/:p/root</code></td><td>Compute closure root. Body: <code>{at}</code></td></tr>
</table>
<h2>Try it</h2>
<pre>PORT=8788 node server.mjs
curl -X POST http://localhost:8788/projects -d '{"name":"demo"}'
curl -X POST http://localhost:8788/projects/demo/records \\
  -H "content-type: application/json" \\
  -d '{"id":"a","kind":"task","parents":[],"effects":{"x":1},"reason":null}'
curl -X POST http://localhost:8788/projects/demo/fold</pre>
<h2>Persistence</h2>
<p>By default, in-memory. Set <code>QUILT_DATA_DIR=/path/to/dir</code> for JSON-per-project file persistence.</p>
<h2>See also</h2>
<ul>
<li><a href="https://github.com/SuperInstance/git.pp-spec">git.pp-spec</a> v0.3.6</li>
<li><a href="https://github.com/SuperInstance/gitpp-js">gitpp-js</a> v0.1.3 (the only dep)</li>
<li><a href="https://github.com/SuperInstance/gitpp-fold-edge">gitpp-fold-edge</a> — read-only worker</li>
<li><a href="https://github.com/SuperInstance/gitpp-cross-port">gitpp-cross-port</a> — 1000/1000 byte-equivalence</li>
</ul>
</body>
</html>`;

function validateRecord(r) {
  if (!r || typeof r !== "object") return "not an object";
  if (typeof r.id !== "string" || !r.id) return "missing or empty 'id'";
  if (!["task", "witness", "override"].includes(r.kind)) return `invalid kind: ${r.kind}`;
  if (!Array.isArray(r.parents)) return "'parents' must be an array";
  if (!r.effects || typeof r.effects !== "object") return "missing or invalid 'effects'";
  if (!("reason" in r)) return "missing 'reason' field (use null)";
  return null;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(new Error("invalid JSON: " + e.message)); }
    });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    Object.entries(json({}, 204).headers).forEach(([k, v]) => res.setHeader(k, v));
    res.statusCode = 204;
    return res.end();
  }

  try {
    if (method === "GET" && (path === "/" || path === "/health")) {
      const r = path === "/" ? html(INDEX_HTML) : json({ ok: true });
      res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.end(r.body);
    }
    if (method === "GET" && path === "/version") {
      const r = json({ name: NAME, version: VERSION, sha: SHA });
      res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.end(r.body);
    }
    if (method === "GET" && path === "/projects") {
      const r = json({ projects: listProjects() });
      res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.end(r.body);
    }
    if (method === "POST" && path === "/projects") {
      const body = await parseBody(req);
      if (!body.name) return sendErr(res, "missing 'name' field");
      const project = getProject(body.name);
      saveProject(body.name, project);
      const r = json({ name: body.name, records: project.records.size }, 201);
      res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.end(r.body);
    }

    const projectMatch = path.match(/^\/projects\/([^\/]+)(?:\/(records|fold|verify|root|nudge))?(?:\/(.*))?$/);
    if (projectMatch) {
      const projectName = projectMatch[1];
      const sub = projectMatch[2];
      const rest = projectMatch[3] || "";
      const project = getProject(projectName);

      if (!sub) {
        if (method === "GET") {
          const r = json({ name: projectName, records: project.records.size });
          res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
          return res.end(r.body);
        }
        return sendErr(res, `method not allowed: ${method} ${path}`, 405);
      }

      if (sub === "records" && method === "GET" && !rest) {
        const after = url.searchParams.get("after");
        const limit = parseInt(url.searchParams.get("limit") || "1000", 10);
        const records = Array.from(project.records.values());
        records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const startIdx = after ? records.findIndex(r => r.id === after) + 1 : 0;
        const slice = records.slice(startIdx, startIdx + limit);
        const r = json({ records: slice, total: records.length });
        res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
        return res.end(r.body);
      }

      if (sub === "records" && method === "POST" && !rest) {
        const body = await parseBody(req);
        const record = body.record || body;
        const errMsg = validateRecord(record);
        if (errMsg) return sendErr(res, `invalid record: ${errMsg}`, 422);
        if (project.records.has(record.id)) {
          return sendErr(res, `record already exists: ${record.id}`, 409);
        }
        const leaf = await recordLeaf(record);
        const stored = { ...record, digest: leaf };
        project.records.set(record.id, stored);
        saveProject(projectName, project);
        const r = json({ id: record.id, leaf }, 201);
        res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
        return res.end(r.body);
      }

      if (sub === "records" && method === "GET" && rest) {
        const id = decodeURIComponent(rest);
        const record = project.records.get(id);
        if (!record) return sendErr(res, `record not found: ${id}`, 404);
        const leaf = await recordLeaf(record);
        const r = json({ record, leaf });
        res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
        return res.end(r.body);
      }

      if (sub === "nudge" && method === "POST") {
        // POST /projects/:p/nudge
        //   { key, value, reason, kind?, intent?, dryRun? }
        //
        // A nudge is a decision plus an action, and the action's parent IS
        // the decision record. Written as two records, parented. If the gate
        // blocks, ONLY the receipt is written: the state does not move, but
        // the attempt is on the record permanently and tamper-evidently.
        const body = await parseBody(req);
        if (!body.key) return sendErr(res, "missing 'key'");
        if (!("value" in body)) return sendErr(res, "missing 'value'");

        const current = Array.from(project.records.values());
        const folded = derive(current);
        const seq = current.length + 1;
        const receiptId = `receipt-${String(seq).padStart(4, "0")}`;
        const actionId = `nudge-${String(seq).padStart(4, "0")}`;

        // The receipt is parented on the CURRENT setter of the key, and the
        // action is parented on the RECEIPT. effects:{} so it is state-inert
        // (SS5.2 iterates the keys a record SETS). kind:witness, the lowest
        // class, so it can never outrank anything even if the enum widens.
        const receipt = {
          id: receiptId,
          kind: "witness",
          parents: folded.setters?.[body.key] ? [folded.setters[body.key]] : [],
          effects: {},
          reason: "gate:pending",
        };
        const action = {
          id: actionId,
          kind: body.kind || folded.setters?.[body.key]
            ? (current.find((r) => r.id === folded.setters[body.key])?.kind || "task")
            : "task",
          parents: [receiptId],
          effects: { [body.key]: body.value },
          reason: body.reason || `nudge ${body.key}`,
        };

        // Gate the RECEIPT. Its parent is the current setter of the key --
        // that is the relationship worth checking. The ACTION's parent is the
        // receipt, which is structural by construction and can never match
        // setters[key]; checking it would block every nudge forever.
        const decision = route({
          folded, key: body.key, record: receipt,
          intent: body.intent ?? null,
        });
        receipt.reason = `gate:${decision.action} ${decision.reason}`;

        if (decision.action === "block") {
          // Write the RECEIPT ONLY. State does not move; the attempt is
          // recorded and the closure root of the RECEIPT commits to it.
          receipt.digest = await recordLeaf(receipt);
          project.records.set(receipt.id, receipt);
          saveProject(projectName, project);
          return respond(res, json({ routed: decision.action, reason: decision.reason,
                        receipt, action: null, stateUnchanged: true }, 202));
        }

        receipt.digest = await recordLeaf(receipt);
        action.digest = await recordLeaf(action);
        project.records.set(receipt.id, receipt);
        project.records.set(action.id, action);
        saveProject(projectName, project);

        // Verify AFTER the fact, by setter identity -- not by "the value
        // matches", which two different records can both satisfy.
        const after = derive(Array.from(project.records.values()));
        const landed = after.setters?.[body.key] === actionId;

        if (body.dryRun) {
          project.records.delete(receipt.id);
          project.records.delete(action.id);
          saveProject(projectName, project);
        }
        return respond(res, json({
          routed: decision.action, reason: decision.reason,
          receipt, action, landed, setterNow: after.setters?.[body.key] ?? null,
          state: after.state, dryRun: Boolean(body.dryRun),
        }, 201));
      }

      if (sub === "fold" && method === "POST") {
        const records = Array.from(project.records.values());
        const result = derive(records);
        const r = json(result);
        res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
        return res.end(r.body);
      }

      if (sub === "verify" && method === "POST") {
        const body = await parseBody(req);
        if (!body.checkpoint) return sendErr(res, "missing 'checkpoint' field");
        const records = Array.from(project.records.values());
        const result = await verifyCheckpoint(records, body.checkpoint);
        const r = json(result);
        res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
        return res.end(r.body);
      }

      if (sub === "root" && method === "POST") {
        const body = await parseBody(req);
        if (!body.at) return sendErr(res, "missing 'at' field");
        const records = Array.from(project.records.values());
        const root = await closureRoot(records, body.at);
        const r = json({ root });
        res.statusCode = r.status; Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
        return res.end(r.body);
      }
    }

    return sendErr(res, `not found: ${method} ${path}`, 404);
  } catch (e) {
    return sendErr(res, e.message, 500);
  }
}

function sendErr(res, message, status = 400) {
  const r = err(message, status);
  res.statusCode = r.status;
  Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
  return res.end(r.body);
}

const PORT = parseInt(process.env.PORT || "8788", 10);
const server = createServer(handle);
server.listen(PORT, () => {
  console.log(`${NAME} v${VERSION}@${SHA} listening on :${PORT}`);
  if (DATA_DIR) console.log(`  data dir: ${DATA_DIR}`);
  else console.log(`  (in-memory only; set QUILT_DATA_DIR for persistence)`);
});
