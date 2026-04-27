import fs from "fs"

const STATE_FILE = "/tmp/monitor-state.json"

// How often to send an OK heartbeat for a healthy store.
// Default 2h — override with OK_ALERT_INTERVAL_MS env var.
const OK_ALERT_INTERVAL_MS =
  Number(process.env.OK_ALERT_INTERVAL_MS) || 2 * 60 * 60 * 1000

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  } catch {}
  return {}
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {}
}

/**
 * Decide whether to fire an alert for this store's current status.
 *
 *   - { force: true } → always send (used by manual /trigger URL)
 *   - PROBLEM (isOk === false) → always send (every cycle until fixed)
 *   - Recovery (was broken, now OK) → always send, regardless of throttle
 *   - OK heartbeat (was OK, still OK) → only every OK_ALERT_INTERVAL_MS (2h default)
 *
 * Returns { send, reason } and persists updated state.
 */
export function shouldSendAlert(storeId, isOk, opts = {}) {
  const state = loadState()
  const prev = state[storeId] || {}
  const now = Date.now()

  let send = false
  let reason = ""

  if (opts.force) {
    send = true
    reason = "forced"
  } else if (!isOk) {
    send = true
    reason = "problem"
  } else if (prev.isOk === false) {
    send = true
    reason = "recovery"
  } else {
    const sinceLast = prev.lastAlertAt ? now - prev.lastAlertAt : Infinity
    if (sinceLast >= OK_ALERT_INTERVAL_MS) {
      send = true
      reason = prev.lastAlertAt ? "heartbeat" : "first-ok"
    } else {
      send = false
      reason = "throttled"
    }
  }

  state[storeId] = {
    isOk,
    lastChecked: now,
    lastAlertAt: send ? now : prev.lastAlertAt || null,
  }
  saveState(state)

  return { send, reason }
}

// Utility — exposed in case you want a /clear-state admin endpoint later.
export function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE)
  } catch {}
}

// ─── Router status throttle ──────────────────────────────────────────────────
// The router status digest is informational, not urgent — throttle broadcasts
// to every ROUTER_STATUS_INTERVAL_MS (default 4h).
const ROUTER_STATUS_INTERVAL_MS =
  Number(process.env.ROUTER_STATUS_INTERVAL_MS) || 4 * 60 * 60 * 1000

export function shouldSendRouterStatus(opts = {}) {
  const state = loadState()
  const now = Date.now()
  const last = state._routerStatusAt || 0

  if (opts.force || now - last >= ROUTER_STATUS_INTERVAL_MS) {
    state._routerStatusAt = now
    saveState(state)
    return { send: true, reason: opts.force ? "forced" : last ? "interval" : "first-run" }
  }
  return { send: false, reason: "throttled" }
}

// ─── Health check throttle ───────────────────────────────────────────────────
// The /health-check digest is throttled to HEALTH_CHECK_INTERVAL_MS (default 4h).
// Issues bypass the throttle so problems land within the next cycle.
const HEALTH_CHECK_INTERVAL_MS =
  Number(process.env.HEALTH_CHECK_INTERVAL_MS) || 4 * 60 * 60 * 1000

export function shouldSendHealthCheck(opts = {}) {
  const state = loadState()
  const now = Date.now()
  const last = state._healthCheckAt || 0

  if (opts.force || opts.hasIssues || now - last >= HEALTH_CHECK_INTERVAL_MS) {
    state._healthCheckAt = now
    saveState(state)
    return {
      send: true,
      reason: opts.force ? "forced" : opts.hasIssues ? "issues" : last ? "interval" : "first-run",
    }
  }
  return { send: false, reason: "throttled" }
}
