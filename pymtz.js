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
  const payments = raw
    .filter((t) => String(t.status || "").toLowerCase() !== "test") // drop test-mode noise
    .map((t) => ({
      id: t.id,
      amount: (Number(t.amount) || 0) / 100, // dashboard amounts are in cents
      currency: String(t.currency || "USD").toUpperCase(),
      status: normalizeStatus(t.status),
      description: t.description || t.name || "—",
      created_at: t.created_at ?? t.createdAt ?? t.date,
    }))
  // The account may have more transactions than the 200-row cap; flag so the
  // all-time totals can be marked partial. Compare against the raw row count
  // (before the test-transaction filter), not the filtered length.
  const capped = Number.isFinite(data.total) && data.total > raw.length
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

// Format a currency map as money: "$369.00" for USD, "CAD 12.00" otherwise.
// Returns "" when the map has no non-zero amounts.
function fmtMoney(map) {
  const entries = Object.entries(map || {}).filter(([, v]) => v)
  if (!entries.length) return ""
  return entries
    .map(([cur, v]) => (cur === "USD" ? `$${nf.format(v)}` : `${cur} ${nf.format(v)}`))
    .join(" · ")
}

// The three headline statuses, in display order.
const STATUS_META = [
  ["completed", "✅", "Succeeded"],
  ["pending", "⏳", "Pending"],
  ["failed", "❌", "Failed"],
]

// Status breakdown lines.
//   withWord=true  → "  ✅ 3 Succeeded · $369.00"  (the 24h section)
//   withWord=false → "  ✅ 3 · $369.00"            (the all-time section)
function statusLines(counts, sums, withWord) {
  const out = []
  for (const [key, icon, word] of STATUS_META) {
    const n = counts[key] || 0
    const money = fmtMoney(sums[key])
    const tail = n > 0 && money ? ` · ${money}` : ""
    out.push(withWord ? `  ${icon} ${n} ${word}${tail}` : `  ${icon} ${n}${tail}`)
  }
  if (counts.expired) {
    const tail = fmtMoney(sums.expired)
    out.push(`  ⌛ ${counts.expired}${withWord ? " Expired" : ""}${tail ? ` · ${tail}` : ""}`)
  }
  return out
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
// Builds one self-contained digest message PER configured pymtz account (so
// each account, e.g. Montreal vs Florida, is broadcast as its own message).
// Each message shows the account's all-time and last-window status breakdowns
// plus the recent itemized list. Returns { ok, configured, hasFailures, messages }
// where messages is [{ label, ok, hasFailures, message }].
export async function getPymtzSummary({ baseUrl = DEFAULT_BASE_URL } = {}) {
  const accounts = parseAccounts()
  if (!accounts.length) return { ok: false, configured: false, messages: [] }

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

  const TOP = "╭───────────────────────╮"
  const BOT = "╰───────────────────────╯"
  const SEP = "───────────────────────"
  const messages = []
  let anyOk = false
  let anyFailures = false

  for (const r of results) {
    if (!r.ok) {
      messages.push({
        label: r.label,
        ok: false,
        message: `╭───────────────────────╮\n  💳 *${r.label.toUpperCase()}*\n╰───────────────────────╯\n⚠️ Unavailable: ${r.error}`,
      })
      continue
    }
    anyOk = true

    const all = aggregate(r.payments)
    const recent = r.payments.filter((p) => {
      const c = Date.parse(p.created_at ?? p.createdAt ?? "")
      return !Number.isFinite(c) || c >= startMs
    })
    const rec = aggregate(recent)

    const lines = [
      TOP,
      `  💳 *${r.label.toUpperCase()}*`,
      `  ${asOf}`,
      BOT,
      // Last-window section first (the part you act on).
      `🕒 *LAST ${WINDOW_HOURS}H* · ${rec.total} txn${rec.total === 1 ? "" : "s"}`,
      ...statusLines(rec.counts, rec.sums, true),
      SEP,
      // All-time running totals.
      `📊 *ALL TIME* · ${all.total} txn${all.total === 1 ? "" : "s"}${r.capped ? " (recent)" : ""}`,
      ...statusLines(all.counts, all.sums, false),
    ]
    if (r.capped) {
      lines.push(`⚠️ All-time shows most-recent records only (exceeds fetch cap)`)
    }

    const hasFailures = rec.counts.failed > 0
    if (hasFailures) anyFailures = true
    messages.push({ label: r.label, ok: true, hasFailures, message: lines.join("\n") })
  }

  return { ok: anyOk, configured: true, hasFailures: anyFailures, messages }
}
