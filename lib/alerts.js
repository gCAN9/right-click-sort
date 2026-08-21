// Operator + user notification for upstream limits.
//
// noteLimit(source, detail): records the event (surfaced to page users via
// recentLimits() in API responses) and pushes an operator alert to the
// channels configured via env, debounced per source:
//   ALERT_WEBHOOK_URL — any JSON webhook (Discord/Slack compatible payload)
//   ALERT_NTFY_TOPIC  — an ntfy.sh topic name (subscribe in the ntfy app)

const WEBHOOK = process.env.ALERT_WEBHOOK_URL || '';
const NTFY = process.env.ALERT_NTFY_TOPIC || '';
const DEBOUNCE_MS = 10 * 60 * 1000; // one operator alert per source per 10 min
const RECENT_MS = 3 * 60 * 1000; // how long an event stays visible to users

const lastSent = new Map();
const lastSeen = new Map();

function noteLimit(source, detail = '') {
  const now = Date.now();
  lastSeen.set(source, now);
  if (now - (lastSent.get(source) || 0) < DEBOUNCE_MS) return;
  lastSent.set(source, now);

  const msg = `[right-click-sort] limit hit: ${source}${detail ? ` — ${detail}` : ''}`;
  // Fire-and-forget: alerting must never slow down or fail a user request.
  if (WEBHOOK) {
    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg, text: msg }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
  if (NTFY) {
    fetch(`https://ntfy.sh/${encodeURIComponent(NTFY)}`, {
      method: 'POST',
      headers: { Title: 'right-click-sort limit', Priority: 'high' },
      body: msg,
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
}

function recentLimits() {
  const now = Date.now();
  return [...lastSeen].filter(([, t]) => now - t < RECENT_MS).map(([s]) => s);
}

module.exports = { noteLimit, recentLimits };
