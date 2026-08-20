import assert from "node:assert/strict";

const baseUrl = process.env.MCP_BASE_URL;
assert.ok(baseUrl, "MCP_BASE_URL is required");

const endpoint = new URL("/mcp", baseUrl);
const protocolVersion = "2025-06-18";

function parseMcpResponse(response, body) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    assert.ok(data, `Expected an SSE data event, received: ${body}`);
    return JSON.parse(data);
  }
  return JSON.parse(body);
}

async function fetchWithRetry(url, init, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

async function callMcp(message) {
  const response = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify(message),
  });
  const body = await response.text();
  return parseMcpResponse(response, body);
}

async function eventually(check, attempts = 15) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
  throw lastError;
}

const healthResponse = await fetchWithRetry(new URL("/", baseUrl));
const health = await healthResponse.json();
assert.equal(health.status, "ok");
assert.equal(health.endpoint, "/mcp");

const initialized = await callMcp({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "map-canvas-production-smoke", version: "0.2.0" },
  },
});
assert.equal(initialized.result.protocolVersion, protocolVersion);

const listed = await eventually(async () => {
  const result = await callMcp({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const showMap = result.result.tools.find((tool) => tool.name === "show_map");
  assert.ok(showMap, "show_map was not listed");
  assert.equal(showMap._meta.ui.resourceUri, "ui://map-canvas/map-v6.html");
  assert.ok(showMap.inputSchema.properties.routes);
  return result;
});

const called = await callMcp({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "show_map",
    arguments: {
      title: "Production smoke test",
      places: [
        {
          id: "tokyo",
          label: "Tokyo Station",
          lat: 35.6812,
          lng: 139.7671,
          day: "Day 1",
          time: "09:00",
          category: "transit",
          status: "confirmed",
        },
        {
          id: "asakusa",
          label: "Asakusa",
          lat: 35.7148,
          lng: 139.7967,
          day: "Day 1",
          category: "sight",
          status: "planned",
        },
      ],
      routes: [
        {
          fromPlaceId: "tokyo",
          toPlaceId: "asakusa",
          mode: "rail",
          label: "about 20 min",
          geometry: "schematic",
        },
      ],
    },
  },
});
assert.equal(called.result.structuredContent.places.length, 2);
assert.equal(called.result.structuredContent.routes.length, 1);
const widgetAsset = called.result._meta?.["mapCanvas/widgetAsset"];
assert.ok(widgetAsset, "show_map did not return widget asset metadata");
assert.match(widgetAsset.version, /^[a-f0-9]{16}$/);
assert.equal(new URL(widgetAsset.url).origin, new URL(baseUrl).origin);
assert.equal(
  new URL(widgetAsset.url).pathname,
  `/assets/v/${widgetAsset.version}/map-widget.js`,
);

const assetResponse = await fetchWithRetry(widgetAsset.url);
assert.equal(assetResponse.headers.get("access-control-allow-origin"), "*");
assert.match(assetResponse.headers.get("cache-control") ?? "", /max-age=31536000/);
assert.match(assetResponse.headers.get("cache-control") ?? "", /immutable/);
const widgetRuntime = await assetResponse.text();
assert.ok(widgetRuntime.includes("OpenStreetMap"));
assert.ok(widgetRuntime.includes("日別表示"));
assert.ok(widgetRuntime.includes("popup-link"));
assert.ok(widgetRuntime.includes("sendFollowUpMessage"));
assert.ok(widgetRuntime.includes("setWidgetState"));
assert.ok(widgetRuntime.includes("最大化を診断"));
assert.ok(widgetRuntime.length < 250_000, "Widget bundle is too large for mobile hosts");

const fallbackResponse = await fetchWithRetry(widgetAsset.fallbackUrl);
assert.equal(fallbackResponse.headers.get("access-control-allow-origin"), "*");
assert.match(fallbackResponse.headers.get("cache-control") ?? "", /no-cache/);

await eventually(async () => {
  const resource = await callMcp({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: "ui://map-canvas/map-v6.html" },
  });
  const widget = resource.result.contents[0];
  assert.equal(widget.mimeType, "text/html;profile=mcp-app");
  assert.ok(widget.text.includes("mapCanvas/widgetAsset"));
  assert.ok(widget.text.includes("ui/notifications/tool-result"));
  assert.ok(widget.text.includes("import(primaryUrl)"));
  assert.ok(widget.text.length < 10_000, "Stable widget loader should remain small");
  assert.equal(
    widget._meta.ui.domain,
    "https://map-canvas.android-mxdiego9.workers.dev",
  );
  assert.equal(
    widget._meta["openai/widgetDomain"],
    "https://map-canvas.android-mxdiego9.workers.dev",
  );
  assert.deepEqual(widget._meta.ui.csp.resourceDomains, [
    "https://tile.openstreetmap.org",
    "https://map-canvas.android-mxdiego9.workers.dev",
  ]);
});

console.log("Production smoke test passed: health, initialize, tools/list, tools/call, resources/read");
