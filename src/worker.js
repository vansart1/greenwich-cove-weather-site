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

async function handleRefresh(request, env) {
  const topic = env.NTFY_TOPIC;
  if (!topic) {
    return json({ error: "NTFY_TOPIC not configured" }, 500);
  }

  // Best-effort context about the requester. ntfy doesn't authenticate the
  // request, so this is just informational — useful when you see the buzz
  // and want to know if it's likely a real visitor vs. someone scanning.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
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
        return json({ ok: true, attempt });
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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
