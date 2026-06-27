# greenwich-cove-weather-site

Public website for [greenwichweather.victoransart.com](https://greenwichweather.victoransart.com).

AI-powered local-effect weather analysis for Greenwich Cove — the regional forecast,
refined by what actually happens at the shoreline (sea breezes, the cool-Sound
marine layer that often weakens incoming storms, sunset thermal collapse, etc.).

## Why this exists

Standard regional forecasts (NWS zone forecasts, generic weather apps) miss the
local effects that drive what actually happens at the cove. A thunderstorm warning
for Fairfield County doesn't tell you whether the cool Sound will choke the storm
before it reaches Riverside. A 15 kt SW gradient forecast doesn't tell you whether
the sea breeze will hold for the Tuesday-night race or die at sunset. This site
narrows the lens to one place and tries to answer those specific questions.

## How it works

There are two pieces:

1. **The analysis** — a Claude Code skill that is run on a schedule. Every afternoon it:
   - Pulls live data from NWS, HRRR, Long Island Sound buoys, a hyperlocal Davis
     weather station at Riverside YC, and ~17 citizen-science (APRS/CWOP) stations
     around western Long Island Sound.
   - Applies a set of analytical frameworks tuned to Greenwich Cove — wind-regime
     classification (thermal vs. gradient vs. hybrid), sea-breeze convergence,
     coastal marine-layer effects, sunset collapse timing, and racing-tactical
     pressure prediction across the cove.
   - Emits a structured JSON file with a storm-risk call and an hour-by-hour wind
     forecast for the 5–10 PM evening window.

2. **This repo** — the rendered output. A small Python script turns the JSON into a
   single static HTML page and commits it here. Cloudflare Pages watches the repo
   and re-deploys within seconds, so the live site reflects whatever was last pushed.

The git history doubles as an archive — every commit is a snapshot of one forecast,
so you can scrub back and see what was predicted on any past day.

## Status

**This information is experimental and should not be used for safety or navigation decisions.** Treat it as one signal among many, not as a replacement for
NWS forecasts, radar, or your own judgment. Don't use it for safety, navigation, or
any decision where being wrong has consequences.

Feedback welcome — there's a "Send feedback" button on the page.
