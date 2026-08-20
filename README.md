# Map Canvas MCP

An embedded interactive map for MCP Apps hosts such as ChatGPT. The Worker
returns map data plus a stable UI loader. Each tool result selects a
content-addressed Leaflet bundle served from Cloudflare Static Assets, so UI
updates do not require refreshing unchanged tool metadata. The user's browser
fetches visible OpenStreetMap tiles directly from the standard tile servers.

## Production endpoint

```text
https://map-canvas.android-mxdiego9.workers.dev/mcp
```

The endpoint is public and does not require authentication.

## Local development

```bash
npm install
npm run check
npm run dev
```

`npm run check` type-checks the Worker and runs MCP smoke tests for
initialization, tool discovery, tool execution, and widget resource loading.

The local MCP endpoint is `http://localhost:8787/mcp`. Test it with the MCP
Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

## Deploy

Deploy from a terminal:

```bash
npm run deploy
```

No API key is required. Do not add secrets to source or `wrangler.jsonc`; use
Cloudflare secrets if authentication is added later.

### Deploy with GitHub Actions

The included workflow deploys on every push to `main`, then runs the production
MCP smoke test against the public endpoint. It can also be run manually from the
Actions tab. Add these repository Actions secrets first:

- `CLOUDFLARE_API_TOKEN`: a token scoped to edit Workers in the target account
- `CLOUDFLARE_ACCOUNT_ID`: the target Cloudflare account ID

The values stay in GitHub Actions secrets and must not be committed to the
repository.

## Tool

`show_map` accepts 1–50 places with decimal latitude/longitude coordinates.
Simple callers can still use `connectPlaces`; travel itineraries can also add:

- day/date and time labels with day filtering
- categories and confirmed/planned/tentative status
- transport legs for walking, car, taxi, bus, rail, ferry, and flights
- schematic straight connections or actual route geometry
- verified place links, with a Google Maps coordinate link as the fallback

The widget uses numbered, category-colored markers, an itinerary panel, a
reset-view action, and optional fullscreen presentation in ChatGPT. Schematic
legs are dashed and explicitly labeled so they are not mistaken for
turn-by-turn navigation.

Map data © OpenStreetMap contributors.
