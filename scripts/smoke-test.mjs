import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = await mkdtemp(path.join(tmpdir(), "map-canvas-mcp-"));
const outputFile = path.join(outputDirectory, "worker.mjs");
const protocolVersion = "2025-06-18";
const widgetUri = "ui://map-canvas/view.html";

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
  assert.equal(showMap._meta.ui.resourceUri, widgetUri);
  assert.ok(!("openai/outputTemplate" in showMap._meta), "legacy openai/* meta should be gone");
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

  const connectPlacesShortcut = await callMcp(worker, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "show_map",
      arguments: {
        title: "Simple ordered map",
        places: [
          { id: "a", label: "A", lat: 35.68, lng: 139.76 },
          { id: "b", label: "B", lat: 35.69, lng: 139.77 },
        ],
        connectPlaces: true,
      },
    },
  });
  assert.equal(connectPlacesShortcut.result.structuredContent.connectPlaces, true);
  assert.deepEqual(connectPlacesShortcut.result.structuredContent.routes, []);

  const resource = await callMcp(worker, {
    jsonrpc: "2.0",
    id: 5,
    method: "resources/read",
    params: { uri: widgetUri },
  });
  const widget = resource.result.contents[0];
  assert.equal(widget.uri, widgetUri);
  assert.equal(widget.mimeType, "text/html;profile=mcp-app");
  assert.ok(widget.text.includes("OpenStreetMap"));
  assert.ok(widget.text.includes("日別表示"));
  assert.ok(widget.text.includes("popup-link"));
  assert.ok(widget.text.includes("display-mode"));
  assert.ok(widget.text.includes("scroll-snap-type:x mandatory"));
  assert.ok(widget.text.includes("ui/notifications/tool-result"));
  assert.ok(widget.text.includes("ui/initialize"));
  assert.ok(!widget.text.includes("openai"), "legacy window.openai compatibility should be gone");
  assert.ok(!widget.text.includes("mapCanvas/widgetAsset"));
  assert.ok(!widget.text.includes("sendFollowUpMessage"));
  // The official @modelcontextprotocol/ext-apps client (used for spec-compliant
  // Claude/ChatGPT compatibility) pulls in the MCP SDK's JSON-RPC schemas and zod,
  // so this is noticeably larger than a hand-rolled postMessage implementation.
  assert.ok(widget.text.length < 900_000, "Widget bundle grew unexpectedly large");
  assert.equal(widget._meta.ui.prefersBorder, true);
  assert.deepEqual(widget._meta.ui.csp.resourceDomains, ["https://tile.openstreetmap.org"]);
  assert.ok(!("openai/widgetCSP" in widget._meta), "legacy openai/* meta should be gone");

  console.log("Smoke test passed: health, initialize, tools/list, tools/call, resources/read");
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
