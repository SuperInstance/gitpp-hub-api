// gitpp — pure-ESM JavaScript port of the git.pp fold
// Doc-only-discipline: written from SuperInstance/git.pp-spec alone,
// not from the existing TypeScript / Python / Elixir sources.

import { webcrypto } from "node:crypto";
const subtle = webcrypto.subtle;

// ---------- §3 leaf-number encoding (one canonical form, all ports) ----------

function leafNumber(v) {
  // Returns a NUMBER (or null/boolean) for canonical JSON encoding.
  // The emitValue function is responsible for formatting per spec §3.
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error("non-finite number in record effects (out of pinned domain)");
    }
    if (Object.is(v, -0)) return 0;
    if (v === 0) return 0;
    if (Number.isInteger(v) && Math.abs(v) < 1e16) return v;
    if (Number.isInteger(v)) {
      // Allow large integers through to numFormat, which will use scientific.
      return v;
    }
    return v;
  }
  return v;
}

// Format a number per spec §3: scientific when |v| < 1e-4 or |v| >= 1e17,
// or when v is an integer with >= 17 digits.
function numFormat(v) {
  if (v === 0) return "0";
  // Integer form requires |v| < 1e16 to fit safely in int64 across all 5
  // ports. Larger integer-valued floats fall back to scientific notation.
  if (Number.isInteger(v) && Math.abs(v) < 1e16) {
    return String(v);
  }
  const abs = Math.abs(v);
  if (abs < 1e-4 || abs >= 1e16) return sciFormat(v);
  return v.toString();
}

function sciFormat(v) {
  let s = v.toExponential();
  // Strip trailing zeros from mantissa
  s = s.replace(/(\.\d*?)0+e/, "$1e").replace(/\.e/, "e");
  const m = s.match(/^([^e]+)e([+-]?\d+)$/i);
  if (m) {
    const exp = parseInt(m[2]);
    const expStr = String(Math.abs(exp)).padStart(2, "0");
    if (exp < 0) return m[1] + "e-" + expStr;
    return m[1] + "e+" + expStr;
  }
  return s;
}

function leafEncodeEffects(effects) {
  if (effects === null || effects === undefined) return {};
  if (typeof effects !== "object" || Array.isArray(effects)) return effects;
  const out = {};
  for (const k of Object.keys(effects).sort()) {
    const v = effects[k];
    if (Array.isArray(v)) {
      out[k] = v.map(leafNumber);
    } else if (v !== null && typeof v === "object") {
      out[k] = leafEncodeEffects(v);
    } else {
      out[k] = leafNumber(v);
    }
  }
  return out;
}

function codePointCompare(a, b) {
  if (a === b) return 0;
  const aIter = a[Symbol.iterator]();
  const bIter = b[Symbol.iterator]();
  while (true) {
    const aNext = aIter.next();
    const bNext = bIter.next();
    if (aNext.done && bNext.done) return 0;
    if (aNext.done) return -1;
    if (bNext.done) return 1;
    if (aNext.value !== bNext.value) return aNext.value < bNext.value ? -1 : 1;
  }
}

function sortByCodePoint(arr) {
  return arr.slice().sort(codePointCompare);
}

async function sha256Hex(bytes) {
  const hash = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// Compact JSON, matches Python's json.dumps(x, sort_keys=True, ensure_ascii=True, separators=(", ", ": "))
function emitValue(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return numFormat(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[" + v.map(emitValue).join(", ") + "]";
  }
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    if (keys.length === 0) return "{}";
    return "{" + keys.map(k => JSON.stringify(k) + ": " + emitValue(v[k])).join(", ") + "}";
  }
  throw new Error("cannot JSON-encode value of type " + typeof v);
}

function jsonCanonical(obj) {
  return emitValue(obj);
}

function recordLeafCanonical(record) {
  const parents = sortByCodePoint((record.parents || []).map(String));
  const effects = leafEncodeEffects(record.effects || {});
  const canon = {
    effects: effects,
    id: String(record.id),
    kind: record.kind ?? null,
    parents: parents,
    reason: record.reason ?? null,
  };
  return jsonCanonical(canon);
}

export async function recordLeaf(record) {
  const canon = recordLeafCanonical(record);
  const bytes = new TextEncoder().encode(canon);
  return sha256Hex(bytes);
}

export async function closureRoot(records, at) {
  const byId = new Map();
  for (const r of records) {
    if (r.id) byId.set(r.id, r);
  }
  if (!byId.has(at)) return null;
  const seen = new Set();
  const stack = [at];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    if (!byId.has(cur)) return null;
    seen.add(cur);
    for (const p of byId.get(cur).parents || []) {
      if (!seen.has(p)) stack.push(p);
    }
  }
  const sorted = sortByCodePoint([...seen]);
  const lines = [];
  for (const id of sorted) {
    const leaf = await recordLeaf(byId.get(id));
    lines.push(id + ":" + leaf);
  }
  return sha256Hex(new TextEncoder().encode(lines.join("\n")));
}

const CLASS_RANK = { override: 3, task: 2, witness: 1 };

function detectOrphans(records) {
  const byId = new Map();
  for (const r of records) {
    if (r.id) byId.set(r.id, r);
  }
  const orphans = new Set();
  for (const r of records) {
    if (!r.id) continue;
    for (const p of r.parents || []) {
      if (!byId.has(p)) {
        orphans.add(r.id);
        break;
      }
    }
  }
  return orphans;
}

function detectCycles(records) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const r of records) if (r.id) color.set(r.id, WHITE);
  const cycle = new Set();
  const path = [];

  function dfs(rid) {
    const c = color.get(rid);
    if (c === GRAY) {
      const idx = path.indexOf(rid);
      for (let i = idx; i < path.length; i++) cycle.add(path[i]);
      return;
    }
    if (c === BLACK) return;
    color.set(rid, GRAY);
    path.push(rid);
    const r = records.find(r => r.id === rid);
    if (r) {
      for (const p of r.parents || []) {
        if (color.has(p)) dfs(p);
      }
    }
    path.pop();
    color.set(rid, BLACK);
  }

  for (const r of records) {
    if (r.id && color.get(r.id) === WHITE) dfs(r.id);
  }
  return cycle;
}

function ancestorsOf(rid, applied) {
  const seen = new Set();
  const stack = [rid];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const r = applied.get(cur);
    if (r) {
      for (const p of r.parents || []) {
        if (applied.has(p) && !seen.has(p)) stack.push(p);
      }
    }
  }
  return seen;
}

function topoOrder(records) {
  const byId = new Map();
  for (const r of records) if (r.id) byId.set(r.id, r);
  const inDeg = new Map();
  const children = new Map();
  for (const [rid, r] of byId) {
    inDeg.set(rid, 0);
    children.set(rid, []);
  }
  for (const [rid, r] of byId) {
    for (const p of r.parents || []) {
      if (byId.has(p)) {
        inDeg.set(rid, inDeg.get(rid) + 1);
        children.get(p).push(rid);
      }
    }
  }
  const ready = sortByCodePoint([...inDeg.entries()].filter(([_, d]) => d === 0).map(([rid, _]) => rid));
  const order = [];
  while (ready.length > 0) {
    const cur = ready.shift();
    order.push(cur);
    for (const c of children.get(cur)) {
      inDeg.set(c, inDeg.get(c) - 1);
      if (inDeg.get(c) === 0) ready.push(c);
    }
    ready.sort(codePointCompare);
  }
  return order;
}

export function derive(records) {
  const byId = new Map();
  for (const r of records) {
    if (r.id) byId.set(r.id, r);
  }
  const orphans = detectOrphans(records);
  const cycles = detectCycles(records);

  const applied = new Map();
  for (const [rid, r] of byId) {
    if (!orphans.has(rid) && !cycles.has(rid)) {
      applied.set(rid, r);
    }
  }
  for (const r of records) {
    if (r.id && orphans.has(r.id)) applied.delete(r.id);
  }

  const order = topoOrder([...applied.values()]);

  const state = {};
  const conflicts = [];
  const keys = new Set();
  const stateKeys = keys;
  for (const r of applied.values()) {
    for (const k of Object.keys(r.effects || {})) keys.add(k);
  }
  for (const K of keys) {
    const candidates = [...applied.values()].filter(r => K in (r.effects || {}));
    if (candidates.length === 0) continue;
    const topClass = Math.max(...candidates.map(r => CLASS_RANK[r.kind] || 0));
    const top = candidates.filter(r => (CLASS_RANK[r.kind] || 0) === topClass);
    const anc = new Map();
    for (const r of top) anc.set(r.id, ancestorsOf(r.id, applied));
    // Per spec §5.2: a candidate is dominated if it is a (transitive)
    // ancestor of any other candidate. Survivors are the most-derived.
    const survivors = top.filter(r => {
      for (const other of top) {
        if (other.id !== r.id && anc.get(other.id).has(r.id)) return false;
      }
      return true;
    });
    if (survivors.length > 1) {
      survivors.sort((a, b) => {
        const aIntent = [...anc.get(a.id)].filter(x => {
          const r = applied.get(x);
          return r && (r.kind === "task" || r.kind === "override");
        }).length;
        const bIntent = [...anc.get(b.id)].filter(x => {
          const r = applied.get(x);
          return r && (r.kind === "task" || r.kind === "override");
        }).length;
        if (aIntent !== bIntent) return bIntent - aIntent;
        const aWitness = [...anc.get(a.id)].filter(x => applied.get(x)?.kind === "witness").length;
        const bWitness = [...anc.get(b.id)].filter(x => applied.get(x)?.kind === "witness").length;
        if (aWitness !== bWitness) return aWitness - bWitness;
        return codePointCompare(a.id, b.id);
      });
    }
    const winner = survivors[0];
    const winnerValue = winner.effects[K];
    state[K] = winnerValue;
    const distinctValues = new Set(candidates.map(r => JSON.stringify(r.effects[K])));
    if (distinctValues.size > 1) {
      const losers = sortByCodePoint(
        candidates
          .filter(r => r.id !== winner.id && JSON.stringify(r.effects[K]) !== JSON.stringify(winnerValue))
          .map(r => r.id)
      );
      if (losers.length > 0) {
        conflicts.push({ key: K, winner: winner.id, losers });
      }
    }
  }

  // Spec §5.6: setter for every key in state, not only contested ones.
  // The fold computes the winner above and was discarding it, which left a
  // same-class nudge parented on the wrong record landing or vanishing
  // depending only on whether its own id sorted before the winner's.
  const setters = {};
  for (const r of applied.values()) {
    for (const k of Object.keys(r.effects || {})) setters[k] = k in state ? setters[k] : undefined;
  }
  // Walk state in the same order the resolution assigned, recording the winner.
  {
    const winnerOf = new Map();
    for (const K of stateKeys) {
      const cands = [...applied.values()].filter((r) => K in (r.effects || {}));
      if (!cands.length) continue;
      const top = Math.max(...cands.map((r) => CLASS_RANK[r.kind] || 0));
      const same = cands.filter((r) => (CLASS_RANK[r.kind] || 0) === top);
      const anc = new Map();
      for (const r of same) anc.set(r.id, ancestorsOf(r.id, applied));
      const surv = same.filter((r) => !same.some((o) => o.id !== r.id && anc.get(o.id).has(r.id)));
      let w = surv[0];
      if (surv.length > 1) {
        const aIntent = (x) => [...anc.get(x)].filter((y) => applied.get(y) && (CLASS_RANK[applied.get(y).kind] || 0) >= 2).length;
        const aWitness = (x) => [...anc.get(x)].filter((y) => applied.get(y) && CLASS_RANK[applied.get(y).kind] === 1).length;
        w = [...surv].sort((a, b) => {
          const d = aIntent(b.id) - aIntent(a.id); if (d) return d;
          const e = aWitness(a.id) - aWitness(b.id); if (e) return e;
          return sortByCodePoint([a.id, b.id])[0] === a.id ? -1 : 1;
        })[0];
      }
      winnerOf.set(K, w.id);
    }
    for (const [k, v] of winnerOf) setters[k] = v;
  }

  return {
    state,
    setters,
    order,
    conflicts,
    // Cycle-affected records are excluded from the fold (above) AND must be
    // preserved in the output per spec §5.5. Previously `cycles` was computed
    // and used to exclude records from `applied`, but never surfaced here, so
    // a 2-cycle silently vanished from the result. (gitpp-js v0.1.4)
    orphans: sortByCodePoint(
      [...new Set([...orphans, ...cycles])].filter(x => typeof x === "string")
    ),
  };
}

export async function verifyCheckpoint(records, checkpoint) {
  const { at, state: expectedState, closureRoot: expectedRoot } = checkpoint;
  const liveRoot = await closureRoot(records, at);
  const liveState = derive(records).state;
  // Check state FIRST. If state differs, it\'s MISMATCH regardless of root.
  // The root can be a stale pinned value that happens to match a different state.
  const stateMatches = JSON.stringify(liveState) === JSON.stringify(expectedState || {});
  const rootMatches = !expectedRoot || liveRoot === expectedRoot;
  if (stateMatches && rootMatches) {
    return { verdict: "VERIFIED", closureRoot: liveRoot, state: liveState };
  }
  if (stateMatches && !rootMatches) {
    return { verdict: "STATE-ONLY", closureRoot: liveRoot, expectedRoot, state: liveState };
  }
  // State differs: MISMATCH with diff
  const onlyInLive = {};
  const onlyInExpected = {};
  for (const k of new Set([...Object.keys(liveState), ...Object.keys(expectedState || {})])) {
    if (JSON.stringify(liveState[k]) !== JSON.stringify((expectedState || {})[k])) {
      if (k in liveState) onlyInLive[k] = liveState[k];
      if (k in (expectedState || {})) onlyInExpected[k] = expectedState[k];
    }
  }
  return {
    verdict: "MISMATCH",
    closureRoot: liveRoot,
    expectedRoot,
    state: liveState,
    stateDiff: { onlyInLive, onlyInExpected },
  };
}
