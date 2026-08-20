import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = await mkdtemp(path.join(tmpdir(), "map-canvas-mcp-"));
const outputFile = path.join(outputDirectory, "worker.mjs");
const protocolVersion = "2025-06-18";
const widgetUris = Array.from(
  { length: 7 },
  (_, index) => `ui://map-canvas/map-v${index + 1}.html`,
);

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

async function callMcp(worker, message) {
  const response = await worker.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "localhost",
        "mcp-protocol-version": protocolVersion,
      },
      body: JSON.stringify(message),
    }),
    {},
    { waitUntil() {}, passThroughOnException() {} },
  );
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return parseMcpResponse(response, body);
}

try {
  const hostDataOutput = path.join(outputDirectory, "host-data.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["widget/host-data.ts"],
    outfile: hostDataOutput,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { findHostData } = await import(pathToFileURL(hostDataOutput));
  const mapData = { title: "Recovered map", places: [{ id: "tokyo" }] };
  const parseMapData = (candidate) => candidate === mapData ? candidate : undefined;
  assert.equal(findHostData(mapData, parseMapData), mapData);
  assert.equal(
    findHostData(
      { toolResponseMetadata: { mcp_tool_result: { structuredContent: mapData } } },
      parseMapData,
    ),
    mapData,
  );
  assert.equal(
    findHostData(
      { _meta: { call_tool_result: { result: { structured_content: mapData } } } },
      parseMapData,
    ),
    mapData,
  );
  assert.equal(findHostData({ params: { arguments: mapData } }, parseMapData), mapData);
  const cyclicEnvelope = {};
  cyclicEnvelope.result = cyclicEnvelope;
  assert.equal(findHostData(cyclicEnvelope, parseMapData), undefined);

  await build({
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    outfile: outputFile,
    bundle: true,
    format: "esm",
    platform: "node",
    conditions: ["workerd", "worker", "browser", "node"],
    loader: { ".html": "text" },
    logLevel: "silent",
  });

  const bundle = await readFile(outputFile, "utf8");
  assert.ok(bundle.includes("tile.openstreetmap.org"));
  const { default: worker } = await import(pathToFileURL(outputFile));

  const health = await worker.fetch(new Request("http://localhost/"), {}, {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const initialized = await callMcp(worker, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "map-canvas-smoke-test", version: "0.1.0" },
    },
  });
  assert.equal(initialized.result.protocolVersion, protocolVersion);

  const listed = await callMcp(worker, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const showMap = listed.result.tools.find((tool) => tool.name === "show_map");
  assert.ok(showMap, "show_map was not listed");
  assert.equal(showMap._meta.ui.resourceUri, "ui://map-canvas/map-v7.html");
  assert.ok(showMap.inputSchema.properties.routes);
  assert.ok(showMap.inputSchema.properties.places.items.properties.day);

  const called = await callMcp(worker, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "show_map",
      arguments: {
        title: "Tokyo test",
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
            id: "tokyo-asakusa",
            fromPlaceId: "tokyo",
            toPlaceId: "asakusa",
            mode: "rail",
            label: "約20分",
            geometry: "schematic",
          },
        ],
      },
    },
  });
  assert.equal(called.result.structuredContent.places.length, 2);
  assert.equal(called.result.structuredContent.routes.length, 1);
  assert.equal(called.result.structuredContent.routes[0].mode, "rail");
  const widgetAsset = called.result._meta?.["mapCanvas/widgetAsset"];
  assert.ok(widgetAsset, "show_map did not return widget asset metadata");
  assert.match(widgetAsset.version, /^[a-f0-9]{16}$/);
  assert.equal(new URL(widgetAsset.url).origin, "https://map-canvas.android-mxdiego9.workers.dev");
  assert.equal(
    new URL(widgetAsset.url).pathname,
    `/assets/v/${widgetAsset.version}/map-widget.js`,
  );
  assert.equal(
    widgetAsset.fallbackUrl,
    "https://map-canvas.android-mxdiego9.workers.dev/assets/current/map-widget.js",
  );

  const widgetAssetFile = path.join(root, "dist/public", new URL(widgetAsset.url).pathname);
  const widgetRuntime = await readFile(widgetAssetFile, "utf8");
  const runtimeDigest = createHash("sha256").update(widgetRuntime).digest("hex").slice(0, 16);
  assert.equal(runtimeDigest, widgetAsset.version);
  assert.ok(widgetRuntime.includes("OpenStreetMap"));
  assert.ok(widgetRuntime.includes("日別表示"));
  assert.ok(widgetRuntime.includes("popup-link"));
  assert.ok(widgetRuntime.includes("display-mode"));
  assert.ok(widgetRuntime.includes("scroll-snap-type:x mandatory"));
  assert.ok(widgetRuntime.includes('requestDisplayMode({mode:'));
  assert.ok(widgetRuntime.includes('?"inline":"fullscreen"'));
  assert.ok(widgetRuntime.includes("toolOutput"));
  assert.ok(widgetRuntime.includes("toolResponseMetadata"));
  assert.ok(widgetRuntime.includes("mcp_tool_result"));
  assert.ok(widgetRuntime.includes("ui/notifications/tool-input"));
  assert.ok(widgetRuntime.includes("openai:set_globals"));
  assert.ok(widgetRuntime.includes("requestAnimationFrame(()=>{requestAnimationFrame"));
  assert.ok(widgetRuntime.includes("safe-area-inset-right) + 104px"));
  assert.ok(!widgetRuntime.includes("sendFollowUpMessage"));
  assert.ok(!widgetRuntime.includes("map-canvas-runtime-diagnostics"));
  assert.ok(!widgetRuntime.includes("最大化を診断"));
  assert.ok(widgetRuntime.length < 250_000, "Widget bundle is too large for mobile hosts");
  assert.ok(!widgetRuntime.includes("ResizeObserver"));

  const fallbackRuntime = await readFile(
    path.join(root, "dist/public/assets/current/map-widget.js"),
    "utf8",
  );
  assert.equal(fallbackRuntime, widgetRuntime);
  const staticHeaders = await readFile(path.join(root, "dist/public/_headers"), "utf8");
  assert.ok(staticHeaders.includes("max-age=31536000, immutable"));
  assert.ok(staticHeaders.includes("no-cache, must-revalidate"));

  const backwardCompatible = await callMcp(worker, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "show_map",
      arguments: {
        title: "Legacy map",
        places: [
          { id: "a", label: "A", lat: 35.68, lng: 139.76 },
          { id: "b", label: "B", lat: 35.69, lng: 139.77 },
        ],
        connectPlaces: true,
      },
    },
  });
  assert.equal(backwardCompatible.result.structuredContent.connectPlaces, true);
  assert.deepEqual(backwardCompatible.result.structuredContent.routes, []);

  let widget;
  for (const [index, uri] of widgetUris.entries()) {
    const resource = await callMcp(worker, {
      jsonrpc: "2.0",
      id: 5 + index,
      method: "resources/read",
      params: { uri },
    });
    const resourceWidget = resource.result.contents[0];
    assert.equal(resourceWidget.uri, uri);
    assert.equal(resourceWidget.mimeType, "text/html;profile=mcp-app");
    assert.equal(resourceWidget.text, widget?.text ?? resourceWidget.text);
    widget = resourceWidget;
  }
  assert.ok(widget, "Current widget resource was not returned");
  assert.equal(widget.mimeType, "text/html;profile=mcp-app");
  assert.ok(widget.text.includes("mapCanvas/widgetAsset"));
  assert.ok(widget.text.includes("ui/notifications/tool-result"));
  assert.ok(widget.text.includes("structuredContent: globals.toolOutput"));
  assert.ok(widget.text.includes("_meta: globals.toolResponseMetadata"));
  assert.ok(widget.text.includes("import(primaryUrl)"));
  assert.ok(widget.text.includes("assets/current/map-widget.js"));
  assert.ok(widget.text.length < 10_000, "Stable widget loader should remain small");
  assert.ok(!widget.text.includes("OpenStreetMap"));
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
  assert.deepEqual(widget._meta["openai/widgetCSP"].redirect_domains, [
    "https://www.google.com",
    "https://maps.app.goo.gl",
    "https://maps.apple.com",
    "https://www.openstreetmap.org",
  ]);

  console.log("Smoke test passed: health, initialize, tools/list, tools/call, resources/read");
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
