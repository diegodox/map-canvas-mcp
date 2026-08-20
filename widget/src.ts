import L, { type LatLngExpression, type Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import { findHostData } from "./host-data";
import "./style.css";

type Coordinate = { lat: number; lng: number };
type Category = "stay" | "sight" | "food" | "transit" | "activity" | "shopping" | "other";
type Status = "confirmed" | "planned" | "tentative";
type Mode = "walk" | "car" | "taxi" | "bus" | "rail" | "ferry" | "flight" | "transfer";
type Geometry = "schematic" | "actual";

type Place = Coordinate & {
  id: string;
  label: string;
  description?: string;
  day?: string;
  time?: string;
  category: Category;
  status: Status;
  mapUrl?: string;
};

type Route = {
  id?: string;
  fromPlaceId: string;
  toPlaceId: string;
  mode: Mode;
  label?: string;
  geometry: Geometry;
  coordinates?: Coordinate[];
};

type MapData = {
  title: string;
  places: Place[];
  connectPlaces: boolean;
  routes: Route[];
  center?: Coordinate;
  zoom?: number;
};

type PlaceEntry = { place: Place; index: number };

type WidgetAsset = {
  version?: string;
  url?: string;
  fallbackUrl?: string;
};

type MapCanvasBootstrap = {
  asset?: WidgetAsset;
  fallback?: boolean;
  initialToolResult?: unknown;
};

type WindowWithBootstrap = Window & {
  __MAP_CANVAS_BOOTSTRAP__?: MapCanvasBootstrap;
};

const CATEGORY_LABEL: Record<Category, string> = {
  stay: "宿泊",
  sight: "観光",
  food: "食事",
  transit: "交通",
  activity: "体験",
  shopping: "買物",
  other: "地点",
};

const CATEGORY_COLOR: Record<Category, string> = {
  stay: "#7c3aed",
  sight: "#2563eb",
  food: "#ea580c",
  transit: "#475569",
  activity: "#059669",
  shopping: "#db2777",
  other: "#2563eb",
};

const STATUS_LABEL: Record<Status, string> = {
  confirmed: "確定",
  planned: "予定",
  tentative: "検討中",
};

const MODE_LABEL: Record<Mode, string> = {
  walk: "徒歩",
  car: "車",
  taxi: "タクシー",
  bus: "バス",
  rail: "鉄道",
  ferry: "船",
  flight: "飛行機",
  transfer: "移動",
};

const MODE_COLOR: Record<Mode, string> = {
  walk: "#059669",
  car: "#475569",
  taxi: "#7c3aed",
  bus: "#2563eb",
  rail: "#dc2626",
  ferry: "#0891b2",
  flight: "#4f46e5",
  transfer: "#64748b",
};

const titleElement = requiredElement("title");
const countElement = requiredElement("count");
const listElement = requiredElement("places");
const loadingElement = requiredElement("loading");
const daysElement = requiredElement("days");
const resetButton = requiredButton("reset-view");
const displayModeButton = requiredButton("display-mode");
const routeNoteElement = requiredElement("route-note");

let map: LeafletMap | undefined;
let renderedLayers: L.LayerGroup | undefined;
let currentData: MapData | undefined;
let selectedDay = "all";
let currentEntries: PlaceEntry[] = [];
let hasRendered = false;
let currentDisplayMode: DisplayMode = "inline";
let carouselTimer: number | undefined;

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button #${id}`);
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCoordinate(value: unknown): value is Coordinate {
  return (
    isRecord(value) &&
    typeof value.lat === "number" &&
    Number.isFinite(value.lat) &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    typeof value.lng === "number" &&
    Number.isFinite(value.lng) &&
    value.lng >= -180 &&
    value.lng <= 180
  );
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}

function parsePlace(value: unknown): Place | undefined {
  if (!isRecord(value) || !isCoordinate(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.label !== "string") return undefined;
  return {
    id: value.id,
    label: value.label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.day === "string" ? { day: value.day } : {}),
    ...(typeof value.time === "string" ? { time: value.time } : {}),
    ...(typeof value.mapUrl === "string" ? { mapUrl: value.mapUrl } : {}),
    category: isOneOf(value.category, Object.keys(CATEGORY_LABEL) as Category[])
      ? value.category
      : "other",
    status: isOneOf(value.status, Object.keys(STATUS_LABEL) as Status[])
      ? value.status
      : "planned",
    lat: value.lat,
    lng: value.lng,
  };
}

function parseRoute(value: unknown): Route | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.fromPlaceId !== "string" || typeof value.toPlaceId !== "string") {
    return undefined;
  }
  const coordinates = Array.isArray(value.coordinates)
    ? value.coordinates.filter(isCoordinate)
    : undefined;
  const geometry = isOneOf(value.geometry, ["schematic", "actual"] as const)
    ? value.geometry
    : "schematic";
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    fromPlaceId: value.fromPlaceId,
    toPlaceId: value.toPlaceId,
    mode: isOneOf(value.mode, Object.keys(MODE_LABEL) as Mode[]) ? value.mode : "transfer",
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    geometry,
    ...(coordinates && coordinates.length >= 2 ? { coordinates } : {}),
  };
}

function parseMapData(value: unknown): MapData | undefined {
  if (!isRecord(value) || !Array.isArray(value.places)) return undefined;
  const places = value.places.map(parsePlace).filter((place) => place !== undefined);
  if (places.length === 0) return undefined;
  const placeIds = new Set(places.map((place) => place.id));
  const routes = Array.isArray(value.routes)
    ? value.routes
        .map(parseRoute)
        .filter(
          (route) =>
            route !== undefined &&
            placeIds.has(route.fromPlaceId) &&
            placeIds.has(route.toPlaceId) &&
            (route.geometry !== "actual" || route.coordinates !== undefined),
        )
    : [];
  return {
    title: typeof value.title === "string" ? value.title : "Map",
    places,
    connectPlaces: value.connectPlaces === true,
    routes,
    ...(isCoordinate(value.center) ? { center: value.center } : {}),
    ...(typeof value.zoom === "number" ? { zoom: value.zoom } : {}),
  };
}

function ensureMap(): LeafletMap {
  if (map) return map;
  map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  return map;
}

function markerIcon(entries: PlaceEntry[]): L.DivIcon {
  const numbers = entries.map(({ index }) => index + 1).join("·");
  const category = entries[0]?.place.category ?? "other";
  const wide = numbers.length > 2;
  return L.divIcon({
    className: "numbered-marker-wrap",
    html: `<span class="numbered-marker${wide ? " wide" : ""}" style="--marker-color:${CATEGORY_COLOR[category]}"><b>${numbers}</b></span>`,
    iconSize: [wide ? 44 : 36, 44],
    iconAnchor: [wide ? 22 : 18, 44],
    popupAnchor: [0, -42],
  });
}

function mapsUrl(place: Place): string {
  return (
    place.mapUrl ??
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.lat},${place.lng}`)}`
  );
}

function openExternal(href: string): void {
  const openai = (window as OpenAICompatibility).openai;
  if (openai?.openExternal) {
    void openai
      .openExternal({ href, redirectUrl: false })
      .catch(() => window.open(href, "_blank", "noopener,noreferrer"));
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function popupFor(entries: PlaceEntry[]): HTMLElement {
  const popup = document.createElement("article");
  popup.className = "popup";
  entries.forEach(({ place, index }, entryIndex) => {
    if (entryIndex > 0) popup.append(document.createElement("hr"));
    const meta = document.createElement("span");
    meta.className = "popup-meta";
    meta.textContent = [place.day, place.time, CATEGORY_LABEL[place.category]].filter(Boolean).join(" · ");
    const heading = document.createElement("strong");
    heading.textContent = `${index + 1}. ${place.label}`;
    popup.append(meta, heading);
    if (place.description) {
      const description = document.createElement("p");
      description.textContent = place.description;
      popup.append(description);
    }
    const navigation = document.createElement("button");
    navigation.type = "button";
    navigation.className = "popup-link";
    navigation.textContent = "地図アプリで開く ↗";
    navigation.addEventListener("click", () => openExternal(mapsUrl(place)));
    popup.append(navigation);
  });
  return popup;
}

function routeForDeparture(data: MapData, placeId: string, visibleIds: Set<string>): Route | undefined {
  return data.routes.find(
    (route) => route.fromPlaceId === placeId && visibleIds.has(route.toPlaceId),
  );
}

function renderList(data: MapData, markers: Map<string, L.Marker>, entries: PlaceEntry[]): void {
  listElement.replaceChildren();
  const visibleIds = new Set(entries.map(({ place }) => place.id));
  entries.forEach(({ place, index }) => {
    const item = document.createElement("li");
    item.dataset.placeId = place.id;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-button";
    button.style.setProperty("--marker-color", CATEGORY_COLOR[place.category]);
    button.setAttribute("aria-label", `${index + 1}. ${place.label}を地図で表示`);

    const number = document.createElement("span");
    number.className = "place-number";
    number.style.setProperty("--marker-color", CATEGORY_COLOR[place.category]);
    number.textContent = String(index + 1);

    const copy = document.createElement("span");
    copy.className = "place-copy";
    const topLine = document.createElement("span");
    topLine.className = "place-topline";
    if (place.time) {
      const time = document.createElement("time");
      time.textContent = place.time;
      topLine.append(time);
    }
    const category = document.createElement("span");
    category.className = "category";
    category.textContent = CATEGORY_LABEL[place.category];
    const status = document.createElement("span");
    status.className = `status status-${place.status}`;
    status.textContent = STATUS_LABEL[place.status];
    topLine.append(category, status);

    const label = document.createElement("strong");
    label.textContent = place.label;
    copy.append(topLine, label);
    if (place.description) {
      const description = document.createElement("small");
      description.textContent = place.description;
      copy.append(description);
    }
    const open = document.createElement("span");
    open.className = "open-cue";
    open.textContent = "›";
    button.append(number, copy, open);
    button.addEventListener("click", () => {
      setActivePlace(place.id);
      map?.flyTo([place.lat, place.lng], Math.max(map.getZoom(), 15), { duration: 0.45 });
      markers.get(place.id)?.openPopup();
    });
    item.append(button);

    const route = routeForDeparture(data, place.id, visibleIds);
    if (route) item.append(routeLegElement(route));
    listElement.append(item);
  });

  listElement.onscroll = () => {
    window.clearTimeout(carouselTimer);
    carouselTimer = window.setTimeout(() => {
      if (!window.matchMedia("(max-width: 680px)").matches) return;
      const listRect = listElement.getBoundingClientRect();
      const center = listRect.left + listRect.width / 2;
      const cards = [...listElement.querySelectorAll<HTMLElement>(":scope > li[data-place-id]")];
      const nearest = cards.reduce<HTMLElement | undefined>((best, card) => {
        if (!best) return card;
        const cardCenter = card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2;
        const bestCenter = best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2;
        return Math.abs(cardCenter - center) < Math.abs(bestCenter - center) ? card : best;
      }, undefined);
      const placeId = nearest?.dataset.placeId;
      const entry = entries.find(({ place }) => place.id === placeId);
      if (!entry) return;
      setActivePlace(entry.place.id);
      map?.panTo([entry.place.lat, entry.place.lng], { animate: true, duration: 0.35 });
    }, 110);
  };
}

function setActivePlace(placeId: string, scrollCard = false): void {
  listElement.querySelectorAll(".place-button.active").forEach((element) => {
    element.classList.remove("active");
  });
  const item = listElement.querySelector<HTMLElement>(
    `[data-place-id="${CSS.escape(placeId)}"]`,
  );
  item?.querySelector(".place-button")?.classList.add("active");
  if (scrollCard) item?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
}

function routeLegElement(route: Route): HTMLElement {
  const leg = document.createElement("div");
  leg.className = "route-leg";
  const mode = document.createElement("span");
  mode.className = "route-mode";
  mode.style.setProperty("--route-color", MODE_COLOR[route.mode]);
  mode.textContent = MODE_LABEL[route.mode];
  const label = document.createElement("span");
  label.textContent = route.label ?? (route.geometry === "schematic" ? "概略ルート" : "実経路");
  const geometry = document.createElement("span");
  geometry.className = `geometry geometry-${route.geometry}`;
  geometry.textContent = route.geometry === "schematic" ? "概略" : "実線";
  leg.append(mode, label, geometry);
  return leg;
}

function orderedDays(data: MapData): string[] {
  return [...new Set(data.places.map((place) => place.day).filter((day): day is string => Boolean(day)))];
}

function renderDayTabs(data: MapData): void {
  const days = orderedDays(data);
  if (days.length < 2) {
    daysElement.hidden = true;
    selectedDay = "all";
    return;
  }
  daysElement.hidden = false;
  daysElement.replaceChildren();
  for (const day of ["all", ...days]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day-button";
    button.textContent = day === "all" ? "すべて" : day;
    button.dataset.day = day;
    button.setAttribute("aria-pressed", String(day === selectedDay));
    button.addEventListener("click", () => {
      selectedDay = day;
      daysElement.querySelectorAll(".day-button").forEach((element) => {
        element.setAttribute("aria-pressed", String((element as HTMLElement).dataset.day === day));
      });
      renderMapView(data);
    });
    daysElement.append(button);
  }
}

function entriesForDay(data: MapData): PlaceEntry[] {
  return data.places
    .map((place, index) => ({ place, index }))
    .filter(({ place }) => selectedDay === "all" || place.day === selectedDay);
}

function visibleRoutes(data: MapData, entries: PlaceEntry[]): Route[] {
  const visibleIds = new Set(entries.map(({ place }) => place.id));
  return data.routes.filter(
    (route) => visibleIds.has(route.fromPlaceId) && visibleIds.has(route.toPlaceId),
  );
}

function fallbackRoutes(entries: PlaceEntry[]): Route[] {
  return entries.slice(0, -1).map(({ place }, index) => ({
    id: `auto-${place.id}`,
    fromPlaceId: place.id,
    toPlaceId: entries[index + 1]!.place.id,
    mode: "transfer",
    geometry: "schematic",
  }));
}

function fitCurrentView(): void {
  if (!map || currentEntries.length === 0) return;
  if (selectedDay === "all" && currentData?.center && currentData.zoom !== undefined) {
    map.setView([currentData.center.lat, currentData.center.lng], currentData.zoom);
    return;
  }
  const coordinates: LatLngExpression[] = currentEntries.map(({ place }) => [place.lat, place.lng]);
  if (coordinates.length === 1) {
    map.setView(coordinates[0]!, currentData?.zoom ?? 14);
  } else {
    map.fitBounds(L.latLngBounds(coordinates), {
      padding: [34, 34],
      maxZoom: currentData?.zoom ?? 15,
    });
  }
}

function renderMapView(data: MapData): void {
  const activeMap = ensureMap();
  renderedLayers?.remove();
  renderedLayers = L.layerGroup().addTo(activeMap);
  currentEntries = entriesForDay(data);

  const groupedEntries = new Map<string, PlaceEntry[]>();
  for (const entry of currentEntries) {
    const key = `${entry.place.lat.toFixed(6)}:${entry.place.lng.toFixed(6)}`;
    const group = groupedEntries.get(key) ?? [];
    group.push(entry);
    groupedEntries.set(key, group);
  }

  const markers = new Map<string, L.Marker>();
  for (const entries of groupedEntries.values()) {
    const first = entries[0]!.place;
    const marker = L.marker([first.lat, first.lng], { icon: markerIcon(entries) })
      .bindPopup(popupFor(entries), { closeButton: false, maxWidth: 260 })
      .addTo(renderedLayers);
    marker.on("click", () => {
      setActivePlace(first.id, true);
    });
    for (const { place } of entries) markers.set(place.id, marker);
  }

  const placeById = new Map(data.places.map((place) => [place.id, place]));
  const suppliedRoutes = visibleRoutes(data, currentEntries);
  const routes = suppliedRoutes.length > 0
    ? suppliedRoutes
    : data.connectPlaces
      ? fallbackRoutes(currentEntries)
      : [];

  for (const route of routes) {
    const from = placeById.get(route.fromPlaceId);
    const to = placeById.get(route.toPlaceId);
    if (!from || !to) continue;
    const routeCoordinates: LatLngExpression[] =
      route.geometry === "actual" && route.coordinates
        ? route.coordinates.map((coordinate) => [coordinate.lat, coordinate.lng])
        : [
            [from.lat, from.lng],
            [to.lat, to.lng],
          ];
    L.polyline(routeCoordinates, {
      color: MODE_COLOR[route.mode],
      weight: 4,
      opacity: 0.82,
      dashArray: route.geometry === "schematic" ? "8 8" : undefined,
      lineJoin: "round",
    }).addTo(renderedLayers);
  }

  const listData = suppliedRoutes.length > 0 || !data.connectPlaces
    ? data
    : { ...data, routes };
  renderList(listData, markers, currentEntries);
  fitCurrentView();

  countElement.textContent = routes.length > 0
    ? `${currentEntries.length}地点 · ${routes.length}区間`
    : `${currentEntries.length}地点`;
  const hasSchematic = routes.some((route) => route.geometry === "schematic");
  routeNoteElement.textContent = hasSchematic
    ? "破線は概略。実際の経路は地図アプリで確認"
    : "地点を選ぶと詳細を表示";
  routeNoteElement.classList.toggle("has-schematic", hasSchematic);

  requestAnimationFrame(() => {
    activeMap.invalidateSize();
    fitCurrentView();
    sendSizeOnce();
  });
}

function render(data: MapData): void {
  currentData = data;
  selectedDay = "all";
  titleElement.textContent = data.title;
  renderDayTabs(data);
  renderMapView(data);
  loadingElement.hidden = true;
  hasRendered = true;
}

function showError(message: string): void {
  loadingElement.hidden = false;
  loadingElement.textContent = message;
  loadingElement.classList.add("error");
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

const pendingRequests = new Map<number, PendingRequest>();
let nextRequestId = 1;

function post(message: JsonRpcMessage): void {
  window.parent.postMessage(message, "*");
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++;
  post({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
}

function renderCandidate(value: unknown): boolean {
  const data = findHostData(value, parseMapData);
  if (!data) return false;
  render(data);
  return true;
}

function receiveToolResult(params: unknown): void {
  if (!renderCandidate(params)) {
    showError("表示できる地点データがありません。");
  }
}

function sendSizeOnce(): void {
  post({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: {
      width: Math.ceil(document.documentElement.getBoundingClientRect().width),
      height: Math.min(Math.ceil(document.body.scrollHeight), 640),
    },
  });
}

window.addEventListener(
  "message",
  (event: MessageEvent<JsonRpcMessage>) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;

    if (message.id !== undefined && pendingRequests.has(message.id)) {
      const pending = pendingRequests.get(message.id)!;
      pendingRequests.delete(message.id);
      if (message.error !== undefined) pending.reject(message.error);
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "ui/notifications/tool-result") {
      receiveToolResult(message.params);
      return;
    }

    if (message.method === "ui/notifications/tool-input") {
      renderCandidate(message.params);
    }
  },
  { passive: true },
);

type DisplayMode = "inline" | "fullscreen" | "pip";

type DisplayModeResult = { mode?: DisplayMode } | undefined;

type OpenAIGlobals = {
  toolOutput?: unknown;
  toolInput?: unknown;
  toolResponseMetadata?: unknown;
  displayMode?: DisplayMode;
  view?: unknown;
};

type OpenAICompatibility = Window & {
  openai?: OpenAIGlobals & {
    requestDisplayMode?: (options: { mode: DisplayMode }) => Promise<DisplayModeResult>;
    openExternal?: (options: { href: string; redirectUrl?: boolean }) => Promise<unknown>;
  };
};

function refreshMapLayout(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      map?.invalidateSize();
      fitCurrentView();
    });
  });
}

function syncDisplayMode(mode: DisplayMode): void {
  currentDisplayMode = mode;
  const isFullscreen = mode === "fullscreen";
  document.querySelector(".shell")?.setAttribute("data-display-mode", mode);
  displayModeButton.setAttribute("aria-pressed", String(isFullscreen));
  displayModeButton.setAttribute("aria-label", isFullscreen ? "地図を元の大きさに戻す" : "地図を最大化");
  displayModeButton.title = isFullscreen ? "元の大きさに戻す" : "地図を最大化";
  displayModeButton.querySelector(".display-mode-icon")!.textContent = isFullscreen ? "⤡" : "⤢";
  displayModeButton.querySelector(".display-mode-label")!.textContent = isFullscreen ? "戻す" : "最大化";
  refreshMapLayout();
}

function refreshHostActions(): void {
  const openai = (window as OpenAICompatibility).openai;
  displayModeButton.hidden = !openai?.requestDisplayMode;
  syncDisplayMode(openai?.displayMode ?? currentDisplayMode);
}

function tryCompatibilityData(): void {
  refreshHostActions();
  if (hasRendered) return;
  const openai = (window as OpenAICompatibility).openai;
  renderCandidate(openai?.toolOutput) ||
    renderCandidate(openai?.toolInput) ||
    renderCandidate(openai?.toolResponseMetadata) ||
    renderCandidate(openai?.view);
}

function applyHostGlobals(globals: OpenAIGlobals | undefined): void {
  if (globals?.displayMode) syncDisplayMode(globals.displayMode);
  if (!hasRendered) {
    renderCandidate(globals?.toolOutput) ||
      renderCandidate(globals?.toolInput) ||
      renderCandidate(globals?.toolResponseMetadata) ||
      renderCandidate(globals?.view);
  }
  if (hasRendered) refreshMapLayout();
}

async function requestDisplayMode(targetMode: DisplayMode): Promise<void> {
  const openai = (window as OpenAICompatibility).openai;
  if (!openai?.requestDisplayMode) return;
  displayModeButton.disabled = true;
  try {
    const result = await openai.requestDisplayMode({ mode: targetMode });
    syncDisplayMode(result?.mode ?? openai.displayMode ?? targetMode);
  } catch {
    syncDisplayMode(openai.displayMode ?? currentDisplayMode);
  } finally {
    displayModeButton.disabled = false;
  }
}

resetButton.addEventListener("click", fitCurrentView);
displayModeButton.addEventListener("click", async () => {
  const targetMode: DisplayMode = currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
  await requestDisplayMode(targetMode);
});

window.addEventListener(
  "openai:set_globals",
  (event) => {
    const globals = (event as CustomEvent<{ globals?: OpenAIGlobals }>).detail?.globals;
    applyHostGlobals(globals ?? (window as OpenAICompatibility).openai);
  },
  { passive: true },
);

const bootstrapToolResult = (window as WindowWithBootstrap).__MAP_CANVAS_BOOTSTRAP__
  ?.initialToolResult;
if (bootstrapToolResult !== undefined) {
  receiveToolResult(bootstrapToolResult);
}

void request("ui/initialize", {
  appCapabilities: {},
  appInfo: { name: "Map Canvas", version: "0.6.5" },
  protocolVersion: "2026-01-26",
})
  .then(() => {
    post({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
    });
    tryCompatibilityData();
  })
  .catch(() => {
    tryCompatibilityData();
    if (!hasRendered) showError("ホストへ接続できませんでした。");
  });
