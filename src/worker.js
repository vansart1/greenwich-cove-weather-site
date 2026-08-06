// Worker entry point.
//
// Routing:
//   POST /refresh  →  forward to ntfy.sh to ping Victor's phone
//   anything else  →  serve static asset (HTML, JSON, etc.) from the repo root
//
// Env vars (set in Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   NTFY_TOPIC — secret topic name on ntfy.sh that Victor's phone is subscribed to
//   NTFY_TOKEN — optional ntfy.sh access token (tk_...). Strongly recommended:
//     without it ntfy rate-limits by source IP, and Workers egress from a pool of
//     IPs shared with every other Cloudflare tenant, so this endpoint gets 429'd
//     on traffic we never sent. A token moves the limit to the account.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/refresh" && request.method === "POST") {
      return handleRefresh(request, env);
    }

    // Fall through to static asset binding.
    return env.ASSETS.fetch(request);
  },
};

const DAILY_LIMIT_PER_IP = 25;

async function handleRefresh(request, env) {
  const topic = env.NTFY_TOPIC;
  if (!topic) {
    return json({ error: "NTFY_TOPIC not configured" }, 500);
  }

  // Best-effort context about the requester. ntfy doesn't authenticate the
  // request, so this is just informational — useful when you see the buzz
  // and want to know if it's likely a real visitor vs. someone scanning.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";

  // Burst limit first: it's a no-cost check, so a hammering client never
  // reaches the KV read below.
  // NOTE: this binding is best-effort — Cloudflare enforces it per location
  // rather than as a global counter, and in testing it let back-to-back calls
  // through. It's free and can only help, but it is NOT the real control; the
  // daily KV cap below is. Don't rely on this alone.
  if (env.REFRESH_LIMIT) {
    const { success } = await env.REFRESH_LIMIT.limit({ key: rateKey(ip) });
    if (!success) {
      // Logged (verdict only, never the key — it derives from the visitor IP)
      // so genuine abuse is visible in `wrangler tail`.
      console.log("burst limit tripped");
      return json(
        { error: "rate limited", scope: "burst", retryAfterSec: 60 },
        429,
        { "Retry-After": "60" },
      );
    }
  }

  // Daily cap per visitor. KV is eventually consistent across colos, so a
  // client spraying from several regions at once can land a little over the
  // cap — the burst limit above is what keeps that gap small.
  const counterKey = await dailyKey(ip);
  let count = 0;
  if (env.REFRESH_COUNTS) {
    count = Number(await env.REFRESH_COUNTS.get(counterKey)) || 0;
    if (count >= DAILY_LIMIT_PER_IP) {
      return json(
        { error: "rate limited", scope: "daily", limit: DAILY_LIMIT_PER_IP },
        429,
        { "Retry-After": "3600" },
      );
    }
  }

  const country = request.cf?.country || "??";
  const ua = (request.headers.get("user-agent") || "").slice(0, 60);

  const message = `Visitor at greenwichweather.victoransart.com asked for a fresh forecast.\nFrom: ${country} (${ip})\nUA: ${ua}`;

  const headers = {
    "Title": "Greenwich Cove Weather — refresh request",
    "Priority": "4",
    "Tags": "wind_face,ocean",
  };
  if (env.NTFY_TOKEN) {
    headers["Authorization"] = `Bearer ${env.NTFY_TOKEN}`;
  }

  // ntfy's free-tier bucket refills on the order of one request every few
  // seconds, so the old zero-delay retry almost always landed inside the same
  // empty bucket and burned a request for nothing. Back off between tries, and
  // prefer ntfy's own Retry-After when it sends one.
  const backoffMs = [1000, 3000];
  let lastErr = null;
  let rateLimited = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(lastErr?.retryAfterMs ?? backoffMs[attempt - 1]);
    }

    try {
      const ntfyRes = await fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers,
        body: message,
      });

      if (ntfyRes.ok) {
        // Only count sends that actually reached the phone — a visitor
        // shouldn't spend their daily allowance on our failed attempts.
        if (env.REFRESH_COUNTS) {
          await env.REFRESH_COUNTS.put(counterKey, String(count + 1), {
            expirationTtl: 60 * 60 * 36,
          });
        }
        return json({ ok: true, attempt, remaining: DAILY_LIMIT_PER_IP - count - 1 });
      }

      // Keep ntfy's own error text — losing it is what made this endpoint
      // failing in production look like a generic 502 with no cause attached.
      const detail = (await ntfyRes.text().catch(() => "")).slice(0, 200);
      rateLimited = ntfyRes.status === 429;
      lastErr = {
        message: `ntfy returned ${ntfyRes.status}`,
        detail,
        retryAfterMs: retryAfterMs(ntfyRes),
      };
    } catch (e) {
      rateLimited = false;
      lastErr = { message: e.message || "fetch threw", detail: "" };
    }
  }

  return json(
    {
      error: lastErr.message,
      detail: lastErr.detail,
      rateLimited,
      // Surfaced so the cause is visible from the response instead of only
      // from the Worker tail — this is the shared-egress-IP case.
      hint: rateLimited && !env.NTFY_TOKEN
        ? "ntfy is rate-limiting Cloudflare's shared egress IP. Set the NTFY_TOKEN secret to get per-account limits."
        : undefined,
    },
    rateLimited ? 429 : 502,
  );
}

function retryAfterMs(res) {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  // Don't let ntfy park a visitor's click behind a long wait — past this the
  // honest move is to fail fast and let them retry.
  return Math.min(secs, 5) * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single IPv6 user is handed a whole /64, so limiting on the full address
// lets one person cycle through effectively unlimited keys. Bucket v6 by /64;
// v4 addresses are used whole.
function rateKey(ip) {
  if (!ip.includes(":")) return ip;
  return ip.split(":").slice(0, 4).join(":") + "::/64";
}

// Visitor IPs are personal data and there's no reason to keep them at rest —
// the counter only needs a stable opaque key, so store a hash instead.
async function dailyKey(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${day}|${rateKey(ip)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `rl:${day}:${hex.slice(0, 32)}`;
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
