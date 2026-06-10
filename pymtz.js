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
// Page through ALL of /payments (newest-first). The renderer derives both the
// all-time totals and the rolling window from the full set. Hard page cap guards
// against runaway pagination; if hit we flag `capped` so the digest can say so.
async function fetchAllPayments(apiKey, baseUrl) {
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

    for (const p of batch) payments.push(p)

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

async function fetchDashboardTransactions(account, origin) {
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
  const payments = raw.map((t) => ({
    id: t.id,
    amount: (Number(t.amount) || 0) / 100, // dashboard amounts are in cents
    currency: String(t.currency || "USD").toUpperCase(),
    status: normalizeStatus(t.status),
    description: t.description || t.name || "—",
    created_at: t.created_at ?? t.createdAt ?? t.date,
  }))
  // The account may have more transactions than the 200-row cap; flag so the
  // all-time totals can be marked partial.
  const capped = Number.isFinite(data.total) && data.total > payments.length
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

// Status breakdown with count AND amount, one line each:
//   "     ✅ Completed: 3 · USD 688.00"
function statusSummaryLines(counts, sums, indent = "  ") {
  const amt = (m) => {
    const s = fmtSums(m)
    return s ? ` · ${s}` : ""
  }
  const lines = [
    `${indent}✅ Completed: ${counts.completed}${amt(sums.completed)}`,
    `${indent}⏳ Pending: ${counts.pending}${amt(sums.pending)}`,
    `${indent}❌ Failed: ${counts.failed}${amt(sums.failed)}`,
  ]
  if (counts.expired) lines.push(`${indent}⌛ Expired: ${counts.expired}${amt(sums.expired)}`)
  if (counts.other) lines.push(`${indent}• Other: ${counts.other}${amt(sums.other)}`)
  return lines
}

// Merge an aggregate() result into a grand accumulator {counts, sums}.
function accInto(grand, agg) {
  for (const k of Object.keys(grand.counts)) {
    grand.counts[k] += agg.counts[k] || 0
    for (const [cur, v] of Object.entries(agg.sums[k] || {})) {
      grand.sums[k][cur] = (grand.sums[k][cur] || 0) + v
    }
  }
}
function newGrand() {
  return {
    counts: { completed: 0, pending: 0, failed: 0, expired: 0, other: 0 },
    sums: { completed: {}, pending: {}, failed: {}, expired: {}, other: {} },
    total: 0,
  }
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
            ? await fetchDashboardTransactions(a, DASHBOARD_ORIGIN)
            : await fetchAllPayments(a.apiKey, baseUrl)
        return { label: a.label, ok: true, mode: a.mode, capped, payments }
      } catch (e) {
        return { label: a.label, ok: false, error: e.message }
      }
    })
  )

  const multi = accounts.length > 1
  const lines = [`💳 *PYMTZ TRANSACTIONS* (as of ${asOf})`]
  const grandAll = newGrand()
  const grand24 = newGrand()
  let anyOk = false
  let anyFailures = false
  let anyCapped = false

  const IND = "     " // indent for the breakdown lines under a sub-heading

  for (const r of results) {
    lines.push("")
    if (!r.ok) {
      lines.push(`▸ *${r.label}* — ⚠️ Unavailable: ${r.error}`)
      continue
    }
    anyOk = true

    const all = aggregate(r.payments)
    const recent = r.payments.filter((p) => {
      const c = Date.parse(p.created_at ?? p.createdAt ?? "")
      return !Number.isFinite(c) || c >= startMs
    })
    const rec = aggregate(recent)

    lines.push(`▸ *${r.label}*`)
    // All-time section.
    lines.push(`  📊 *All time* — ${all.total} txn${all.total === 1 ? "" : "s"}${r.capped ? " (most recent)" : ""}`)
    lines.push(...statusSummaryLines(all.counts, all.sums, IND))
    // Last-window section + itemised list.
    lines.push(`  🕒 *Last ${WINDOW_HOURS}h* — ${rec.total} txn${rec.total === 1 ? "" : "s"}`)
    lines.push(...statusSummaryLines(rec.counts, rec.sums, IND))
    for (const p of recent.slice(0, LIST_LIMIT)) lines.push(txnLine(p))
    if (rec.total > LIST_LIMIT) lines.push(`  …and ${rec.total - LIST_LIMIT} more`)

    accInto(grandAll, all)
    grandAll.total += all.total
    accInto(grand24, rec)
    grand24.total += rec.total
    if (rec.counts.failed > 0) anyFailures = true
    if (r.capped) anyCapped = true
  }

  if (multi) {
    lines.push("")
    lines.push(`Σ *All time* — ${grandAll.total} txn${grandAll.total === 1 ? "" : "s"} (all accounts)`)
    lines.push(...statusSummaryLines(grandAll.counts, grandAll.sums, IND))
    lines.push(`Σ *Last ${WINDOW_HOURS}h* — ${grand24.total} txn${grand24.total === 1 ? "" : "s"} (all accounts)`)
    lines.push(...statusSummaryLines(grand24.counts, grand24.sums, IND))
  }
  if (anyCapped) {
    lines.push(`⚠️ All-time totals show most-recent records only (account exceeds the fetch cap)`)
    console.warn("Pymtz digest: pagination cap hit — totals may be partial")
  }

  return {
    ok: anyOk,
    configured: true,
    hasFailures: anyFailures,
    message: lines.join("\n"),
    data: {
      windowHours: WINDOW_HOURS,
      asOf,
      allTimeTotal: grandAll.total,
      last24hTotal: grand24.total,
      allTimeCounts: grandAll.counts,
      last24hCounts: grand24.counts,
    },
  }
}
