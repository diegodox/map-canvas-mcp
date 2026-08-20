import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import widgetHtml from "../dist/map-widget.html";

// Bump the URI whenever the embedded HTML changes so hosts do not reuse an old
// cached iframe document.
const WIDGET_URI = "ui://map-canvas/map-v2.html";
const TILE_DOMAINS = ["https://tile.openstreetmap.org"] as const;

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees."),
  lng: z.number().min(-180).max(180).describe("Longitude in decimal degrees."),
});

const placeSchema = coordinateSchema.extend({
  id: z.string().min(1).max(80).describe("Stable identifier unique within this map."),
  label: z.string().min(1).max(120).describe("Short place name shown on the map."),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("Optional concise detail shown when the marker is selected."),
});

const mapSchema = z.object({
  title: z.string().min(1).max(120).default("Map"),
  places: z
    .array(placeSchema)
    .min(1)
    .max(50)
    .describe("Places to render, in display and route order."),
  connectPlaces: z
    .boolean()
    .default(false)
    .describe("Draw a line through the places in their supplied order."),
  center: coordinateSchema
    .optional()
    .describe("Optional initial center. Omit to fit all markers."),
  zoom: z
    .number()
    .int()
    .min(1)
    .max(19)
    .optional()
    .describe("Optional initial zoom. Omit to fit all markers."),
});

const widgetMeta = {
  ui: {
    prefersBorder: true,
    csp: {
      connectDomains: [],
      resourceDomains: [...TILE_DOMAINS],
    },
  },
  "openai/widgetDescription":
    "Interactive OpenStreetMap with numbered places and an optional route line.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": {
    connect_domains: [],
    resource_domains: [...TILE_DOMAINS],
  },
} as const;

function createServer(): McpServer {
  const server = new McpServer({
    name: "map-canvas-mcp",
    version: "0.2.0",
  });

  server.registerResource("map-canvas-widget", WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: "text/html;profile=mcp-app",
        text: widgetHtml,
        _meta: widgetMeta,
      },
    ],
  }));

  server.registerTool(
    "show_map",
    {
      title: "Show interactive map",
      description:
        "Render supplied geographic coordinates as an embedded interactive map. Use this after resolving place coordinates. Set connectPlaces when the order represents a route.",
      inputSchema: mapSchema.shape,
      outputSchema: mapSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        securitySchemes: [{ type: "noauth" }],
        "openai/outputTemplate": WIDGET_URI,
        "openai/toolInvocation/invoking": "地図を準備しています…",
        "openai/toolInvocation/invoked": "地図を表示しました",
      },
    },
    async (input) => {
      const map = mapSchema.parse(input);
      return {
        structuredContent: map,
        content: [
          {
            type: "text",
            text: `${map.title}：${map.places.length}地点を地図に表示しました。`,
          },
        ],
      };
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer, {
  route: "/mcp",
  onerror(error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "mcp_handler_error",
        message: error.message,
      }),
    );
  },
});

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({
        name: "Map Canvas MCP",
        status: "ok",
        endpoint: "/mcp",
      });
    }

    return mcpHandler(request, env, ctx);
  },
} satisfies ExportedHandler;
