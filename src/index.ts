import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import widgetHtml from "../dist/map-widget.html";

// MCP Apps resource mime type (https://github.com/modelcontextprotocol/ext-apps).
// Hardcoded rather than imported from `@modelcontextprotocol/ext-apps` because that
// package's server helpers type against the classic `@modelcontextprotocol/sdk`
// `McpServer`, while this Worker uses the newer `@modelcontextprotocol/server` one.
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const WIDGET_URI = "ui://map-canvas/view.html";
const TILE_DOMAINS = ["https://tile.openstreetmap.org"] as const;

// Claude gives each MCP App a stable sandbox origin ("_meta.ui.domain") by
// hashing the exact connector URL configured in Settings > Connectors:
// https://claude.com/docs/connectors/building/mcp-apps/troubleshooting
// The hash covers the full URL string (scheme, host, path, trailing slash),
// so this must match README's documented production endpoint exactly.
const MCP_SERVER_URL = "https://map-canvas.android-mxdiego9.workers.dev/mcp";

async function computeClaudeWidgetDomain(mcpServerUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(mcpServerUrl));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 32)}.claudemcpcontent.com`;
}

const WIDGET_DOMAIN = await computeClaudeWidgetDomain(MCP_SERVER_URL);

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
  day: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("Optional trip day or date label, such as '8/22' or 'Day 2'."),
  time: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("Optional local time or short time range, such as '09:00' or '11:00–12:30'."),
  category: z
    .enum(["stay", "sight", "food", "transit", "activity", "shopping", "other"])
    .default("other")
    .describe("Travel category used for marker color and labels."),
  status: z
    .enum(["confirmed", "planned", "tentative"])
    .default("planned")
    .describe("Whether the stop is confirmed, planned, or tentative."),
  mapUrl: z
    .string()
    .url()
    .max(2_000)
    .optional()
    .describe("Optional verified map or navigation URL for this place."),
});

const routeSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Optional identifier unique within this map."),
  fromPlaceId: z.string().min(1).max(80).describe("ID of the departure place."),
  toPlaceId: z.string().min(1).max(80).describe("ID of the arrival place."),
  mode: z
    .enum(["walk", "car", "taxi", "bus", "rail", "ferry", "flight", "transfer"])
    .default("transfer")
    .describe("Transport mode for this travel leg."),
  label: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional concise route label, duration, train name, or departure note."),
  geometry: z
    .enum(["schematic", "actual"])
    .default("schematic")
    .describe("Use actual only when coordinates came from a reliable route source."),
  coordinates: z
    .array(coordinateSchema)
    .min(2)
    .max(500)
    .optional()
    .describe("Optional route geometry. Required to draw an actual route."),
});

const mapSchemaShape = {
  title: z.string().min(1).max(120).default("Map"),
  places: z
    .array(placeSchema)
    .min(1)
    .max(50)
    .describe("Places to render, in display and route order."),
  connectPlaces: z
    .boolean()
    .default(false)
    .describe(
      "Shortcut: draw schematic connections through all places in order. Prefer routes for travel itineraries.",
    ),
  routes: z
    .array(routeSchema)
    .max(60)
    .default([])
    .describe("Optional travel legs between places. Keep schematic and actual geometry distinct."),
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
};

const mapSchema = z.object(mapSchemaShape).superRefine((map, context) => {
  const placeIds = new Set<string>();
  for (const place of map.places) {
    if (placeIds.has(place.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate place id: ${place.id}`,
        path: ["places"],
      });
    }
    placeIds.add(place.id);
  }

  for (const [index, route] of map.routes.entries()) {
    if (!placeIds.has(route.fromPlaceId) || !placeIds.has(route.toPlaceId)) {
      context.addIssue({
        code: "custom",
        message: "Route references an unknown place id.",
        path: ["routes", index],
      });
    }
    if (route.geometry === "actual" && !route.coordinates) {
      context.addIssue({
        code: "custom",
        message: "Actual route geometry requires coordinates.",
        path: ["routes", index, "coordinates"],
      });
    }
  }
});

function createServer(): McpServer {
  const server = new McpServer({
    name: "map-canvas-mcp",
    version: "1.0.0",
  });

  server.registerResource(
    "map-canvas-widget",
    WIDGET_URI,
    {
      description: "Interactive travel map with itinerary, day filters, and transport legs.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              domain: WIDGET_DOMAIN,
              csp: { resourceDomains: [...TILE_DOMAINS] },
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    "show_map",
    {
      title: "Show interactive map",
      description:
        "Render supplied coordinates as an embedded map. For travel, include day, time, category, status, and distinct routes with transport modes. Mark straight illustrative legs as schematic; use actual only with reliable route coordinates. Use connectPlaces only for simple ordered maps.",
      inputSchema: mapSchemaShape,
      outputSchema: mapSchemaShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
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
