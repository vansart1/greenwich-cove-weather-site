// Worker entry point.
//
// Routing:
//   POST /refresh  →  forward to ntfy.sh to ping Victor's phone
//   anything else  →  serve static asset (HTML, JSON, etc.) from the repo root
//
// Env vars (set in Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   NTFY_TOPIC — secret topic name on ntfy.sh that Victor's phone is subscribed to

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

  try {
    const ntfyRes = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        "Title": "Greenwich Cove Weather — refresh request",
        "Priority": "4",
        "Tags": "wind_face,ocean",
      },
      body: message,
    });

    if (!ntfyRes.ok) {
      return json({ error: `ntfy returned ${ntfyRes.status}` }, 502);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message || "unknown error" }, 500);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
