// Fetches transactions from the pymtz.co REST API and formats a daily digest
// for the chat broadcast. Mirrors the shape of workerStatus.js.
//
// API ref (https://pymtz.co/api-docs.html):
//   Base:   https://pymtz.co/api/v1
//   Auth:   Authorization: Bearer <PYMTZ_API_KEY>
//   List:   GET /payments?limit=1-100&starting_after=<cursor>&status=<status>
//   Status: pending | completed | failed | expired
//   Fields: id, amount, currency, status, description, created_at, paid_at

const DEFAULT_BASE_URL = process.env.PYMTZ_BASE_URL || "https://pymtz.co/api/v1"
// Origin for the dashboard's own (session-authed) API — /api/auth/login and
// /api/transactions — which, unlike the public /api/v1, exposes real statuses.
const DASHBOARD_ORIGIN = process.env.PYMTZ_ORIGIN || "https://pymtz.co"
// Rolling window length (hours) for the digest. Default 24h — counts all recent
// activity regardless of timezone boundaries, which avoids the "it's still
// yesterday in ET" confusion. Override with PYMTZ_WINDOW_HOURS.
const WINDOW_HOURS = Number(process.env.PYMTZ_WINDOW_HOURS) || 24
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000
// Timezone used only to display the "as of" timestamp in the header. Defaults to
// America/Toronto (Canadian/Eastern). Override with PYMTZ_TZ.
const TZ = process.env.PYMTZ_TZ || "America/Toronto"

// Amount formatter — "1840" → "1,840.00"
const nf = new Intl.NumberFormat("en-CA", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// "as of" timestamp formatter in the display TZ — e.g. "Jun 5, 1:22 a.m."
const asOfFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

// Short timezone token for the header (e.g. "EDT").
const TZ_ABBREV = (() => {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value || TZ
    )
  } catch {
    return TZ
  }
})()

// Start (ms) of the rolling window: now minus WINDOW_MS.
function windowStartMs() {
  return Date.now() - WINDOW_MS
}

// ── Fetch ────────────────────────────────────────────────────────────────────
// Page through /payments newest-first and collect everything created on/after
// `startMs`. Stops as soon as a page contains an older record (list is assumed
// newest-first, which is the documented default order). Hard page cap guards
// against runaway pagination; if hit we flag `capped` so the digest can say so.
async function fetchRecentPayments(apiKey, baseUrl, startMs) {
  const MAX_PAGES = 50 // 50 × 100 = 5000 records
  const payments = []
  let cursor = null
  let pages = 0
  let capped = false

  while (pages < MAX_PAGES) {
    const url = new URL(`${baseUrl}/payments`)
    url.searchParams.set("limit", "100")
    if (cursor) url.searchParams.set("starting_after", cursor)

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 160)}` : ""}`)
    }

    const json = await resp.json()
    const batch = Array.isArray(json) ? json : json.data || json.payments || []
    pages++
    if (!batch.length) break

    let reachedOlder = false
    for (const p of batch) {
      const created = Date.parse(p.created_at ?? p.createdAt ?? "")
      if (Number.isFinite(created) && created < startMs) {
        reachedOlder = true
        continue
      }
      payments.push(p)
    }

    if (reachedOlder) break // everything past here is older than today

    const hasMore = json.has_more ?? batch.length === 100
    if (!hasMore) break
    cursor = batch[batch.length - 1]?.id
    if (!cursor) break
  }

  if (pages >= MAX_PAGES) capped = true
  return { payments, capped }
}

// ── Dashboard API (real statuses) ────────────────────────────────────────────
// The public /api/v1/payments only ever reports "pending". The dashboard itself
// uses a session-authed endpoint (/api/transactions) that carries the real
// succeeded/failed status. When an account is configured with email+password we
// log in and use that instead. NOTE: amounts there are in CENTS.

// Map the dashboard's many status strings onto our four buckets.
function normalizeStatus(raw) {
  const s = String(raw || "").toLowerCase()
  if (["succeeded", "completed", "paid", "success"].includes(s)) return "completed"
  if (["failed", "declined", "canceled", "cancelled"].includes(s)) return "failed"
  if (["pending", "processing", "requires_action"].includes(s)) return "pending"
  if (s === "expired") return "expired"
  return "other"
}

async function pymtzLogin(email, password, origin) {
  const res = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.token) {
    throw new Error(`login failed (HTTP ${res.status})${data.error ? `: ${data.error}` : ""}`)
  }
  return data.token
}

async function fetchDashboardTransactions(account, origin, startMs) {
  const token = await pymtzLogin(account.email, account.password, origin)
  const res = await fetch(`${origin}/api/transactions?limit=200`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`/api/transactions HTTP ${res.status}${t ? `: ${t.slice(0, 120)}` : ""}`)
  }
  const data = await res.json()
  const raw = Array.isArray(data) ? data : data.transactions || data.data || []
  const payments = []
  for (const t of raw) {
    const created = Date.parse(t.created_at ?? t.createdAt ?? t.date ?? "")
    if (Number.isFinite(created) && created < startMs) continue
    payments.push({
      id: t.id,
      amount: (Number(t.amount) || 0) / 100, // dashboard amounts are in cents
      currency: String(t.currency || "USD").toUpperCase(),
      status: normalizeStatus(t.status),
      description: t.description || t.name || "—",
      created_at: t.created_at ?? t.createdAt ?? t.date,
    })
  }
  // /api/transactions caps at 200; flag if we likely truncated the window.
  const capped = raw.length >= 200 && payments.length === raw.length
  return { payments, capped }
}

// ── Aggregate ────────────────────────────────────────────────────────────────
function aggregate(payments) {
  const known = ["completed", "pending", "failed", "expired"]
  const counts = { completed: 0, pending: 0, failed: 0, expired: 0, other: 0 }
  const sums = { completed: {}, pending: {}, failed: {}, expired: {}, other: {} }

  for (const p of payments) {
    const status = String(p.status || "").toLowerCase()
    const key = known.includes(status) ? status : "other"
    counts[key]++
    const cur = String(p.currency || "—").toUpperCase()
    sums[key][cur] = (sums[key][cur] || 0) + (Number(p.amount) || 0)
  }
  return { counts, sums, total: payments.length }
}

// "CAD 1,840.00 · USD 120.00" (only non-zero currencies)
function fmtSums(map) {
  return Object.entries(map)
    .filter(([, v]) => v)
    .map(([cur, v]) => `${cur} ${nf.format(v)}`)
    .join(" · ")
}

// Max transactions to itemise per account in the alert (newest first).
const LIST_LIMIT = Number(process.env.PYMTZ_LIST_LIMIT) || 12

// Status → emoji for the per-transaction line.
const STATUS_ICON = { completed: "✅", pending: "⏳", failed: "❌", expired: "⌛" }

// One itemised line per transaction.
function txnLine(p) {
  const when = asOfFmt.format(new Date(p.created_at ?? p.createdAt ?? Date.now()))
  const cur = String(p.currency || "").toUpperCase()
  const amt = nf.format(Number(p.amount) || 0)
  const desc = String(p.description || "—").trim().slice(0, 30)
  const icon = STATUS_ICON[String(p.status || "").toLowerCase()] || "•"
  return `  ${icon} ${when} · ${cur} ${amt} · ${desc}`
}

// Total amount by currency across a list of payments.
function totalsByCurrency(payments) {
  const m = {}
  for (const p of payments) {
    const c = String(p.currency || "—").toUpperCase()
    m[c] = (m[c] || 0) + (Number(p.amount) || 0)
  }
  return m
}

// Compact status breakdown line, e.g. "✅ 2 · ⏳ 9 · ❌ 1 · ⌛ 0".
function statusSummary(counts) {
  const parts = [
    `✅ ${counts.completed}`,
    `⏳ ${counts.pending}`,
    `❌ ${counts.failed}`,
    `⌛ ${counts.expired}`,
  ]
  if (counts.other) parts.push(`• ${counts.other}`)
  return parts.join(" · ")
}

// ── Account configuration ────────────────────────────────────────────────────
// Accounts are configured via numbered env vars (index 1 has no suffix, 2..20
// use _N). Each account uses one of two modes:
//   • dashboard (real statuses): PYMTZ_EMAIL[_N] + PYMTZ_PASSWORD[_N]
//   • api (pending only):        PYMTZ_API_KEY[_N]
// Dashboard mode wins when both are present. PYMTZ_LABEL[_N] names the account.
function parseAccounts() {
  const accounts = []
  const suffix = (n) => (n === 1 ? "" : `_${n}`)
  for (let n = 1; n <= 20; n++) {
    const s = suffix(n)
    const email = (process.env[`PYMTZ_EMAIL${s}`] || "").trim()
    const password = process.env[`PYMTZ_PASSWORD${s}`] || ""
    const apiKey = (process.env[`PYMTZ_API_KEY${s}`] || "").trim()
    const label = (process.env[`PYMTZ_LABEL${s}`] || "").trim()
    if (email && password) {
      accounts.push({ idx: n, mode: "dashboard", email, password, label })
    } else if (apiKey) {
      accounts.push({ idx: n, mode: "api", apiKey, label })
    }
  }
  for (const a of accounts) {
    a.explicit = !!a.label // did the user name it?
    if (!a.label) a.label = `Account ${a.idx}`
  }
  return accounts
}

// ── Public API ───────────────────────────────────────────────────────────────
// Builds one combined digest covering every configured pymtz account. Each
// account gets its own section (when more than one is configured) plus a
// grand-total line. A single account renders flat, with no section header.
export async function getPymtzSummary({ baseUrl = DEFAULT_BASE_URL } = {}) {
  const accounts = parseAccounts()
  if (!accounts.length) return { ok: false, configured: false, message: null }

  const startMs = windowStartMs()
  const asOf = `${asOfFmt.format(new Date())} ${TZ_ABBREV}`

  const results = await Promise.all(
    accounts.map(async (a) => {
      try {
        const { payments, capped } =
          a.mode === "dashboard"
            ? await fetchDashboardTransactions(a, DASHBOARD_ORIGIN, startMs)
            : await fetchRecentPayments(a.apiKey, baseUrl, startMs)
        return { label: a.label, ok: true, mode: a.mode, ...aggregate(payments), capped, payments }
      } catch (e) {
        return { label: a.label, ok: false, error: e.message }
      }
    })
  )

  const multi = accounts.length > 1
  const lines = [`💳 *PYMTZ TRANSACTIONS* — last ${WINDOW_HOURS}h (as of ${asOf})`]
  let grandTotal = 0
  const grandCounts = { completed: 0, pending: 0, failed: 0, expired: 0, other: 0 }
  const grandSums = {}
  let anyOk = false
  let anyFailures = false
  let anyCapped = false

  for (const r of results) {
    lines.push("")
    if (!r.ok) {
      lines.push(`▸ *${r.label}* — ⚠️ Unavailable: ${r.error}`)
      continue
    }
    anyOk = true
    // Header: account name + count + total amount across currencies.
    const curTotals = totalsByCurrency(r.payments)
    const sumStr = fmtSums(curTotals)
    lines.push(`▸ *${r.label}* — ${r.total} txn${r.total === 1 ? "" : "s"}${sumStr ? ` · ${sumStr}` : ""}`)
    // Per-account status summary.
    lines.push(`  ${statusSummary(r.counts)}`)
    // Itemised transactions (newest first), capped.
    for (const p of r.payments.slice(0, LIST_LIMIT)) lines.push(txnLine(p))
    if (r.total > LIST_LIMIT) lines.push(`  …and ${r.total - LIST_LIMIT} more`)
    // Accumulate grand totals.
    grandTotal += r.total
    for (const k of Object.keys(grandCounts)) grandCounts[k] += r.counts[k] || 0
    for (const [cur, v] of Object.entries(curTotals)) grandSums[cur] = (grandSums[cur] || 0) + v
    if (r.counts.failed > 0) anyFailures = true
    if (r.capped) anyCapped = true
  }

  lines.push("")
  const grandSumStr = fmtSums(grandSums)
  lines.push(
    `Σ ${grandTotal} transaction${grandTotal === 1 ? "" : "s"}${grandSumStr ? ` · ${grandSumStr}` : ""} in last ${WINDOW_HOURS}h${multi ? " (all accounts)" : ""}`
  )
  if (multi) lines.push(`   ${statusSummary(grandCounts)}`)
  if (anyCapped) {
    lines.push(`⚠️ Page cap reached for an account — totals may be partial`)
    console.warn("Pymtz digest: pagination cap hit — totals may be partial")
  }

  return {
    ok: anyOk,
    configured: true,
    hasFailures: anyFailures,
    message: lines.join("\n"),
    data: { windowHours: WINDOW_HOURS, asOf, grandTotal, accounts: results },
  }
}
