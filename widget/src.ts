import L, { type LatLngExpression, type Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
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
const diagnosticsButton = requiredButton("diagnostics");
const diagnosticsPanel = requiredElement("diagnostics-panel");
const diagnosticsCloseButton = requiredButton("diagnostics-close");
const diagnosticsFullscreenButton = requiredButton("diagnostics-fullscreen");
const diagnosticsSendButton = requiredButton("diagnostics-send");
const diagnosticsStatusElement = requiredElement("diagnostics-status");
const diagnosticsLogElement = requiredElement("diagnostics-log");
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
  recordDiagnostic("leaflet-create");
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
  recordDiagnostic("render-start", { placeCount: data.places.length, routeCount: data.routes.length });
  currentData = data;
  selectedDay = "all";
  titleElement.textContent = data.title;
  renderDayTabs(data);
  renderMapView(data);
  loadingElement.hidden = true;
  hasRendered = true;
  recordDiagnostic("render-complete", runtimeGeometry());
}

function showError(message: string): void {
  recordDiagnostic("ui-error", { message });
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
  recordDiagnostic("host-request", { method, id });
  post({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
}

function renderCandidate(value: unknown, source = "unknown"): boolean {
  const data = parseMapData(value);
  recordDiagnostic("render-candidate", {
    source,
    present: value !== undefined && value !== null,
    valid: Boolean(data),
  });
  if (!data) return false;
  render(data);
  return true;
}

function receiveToolResult(params: unknown): void {
  recordDiagnostic("tool-result-notification", {
    paramsPresent: params !== undefined && params !== null,
    paramsKeys: isRecord(params) ? Object.keys(params).slice(0, 12) : [],
  });
  if (!isRecord(params)) return;
  if (!renderCandidate(params.structuredContent, "ui/notifications/tool-result")) {
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
    recordDiagnostic("host-message", {
      method: message.method ?? null,
      id: message.id ?? null,
      hasError: message.error !== undefined,
    });

    if (message.id !== undefined && pendingRequests.has(message.id)) {
      const pending = pendingRequests.get(message.id)!;
      pendingRequests.delete(message.id);
      if (message.error !== undefined) pending.reject(message.error);
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "ui/notifications/tool-result") {
      receiveToolResult(message.params);
    }
  },
  { passive: true },
);

type DisplayMode = "inline" | "fullscreen" | "pip";

type DisplayModeResult = { mode?: DisplayMode } | undefined;

type OpenAIGlobals = {
  toolOutput?: unknown;
  toolInput?: unknown;
  displayMode?: DisplayMode;
  maxHeight?: number;
  safeArea?: unknown;
  theme?: string;
  view?: unknown;
  widgetState?: unknown;
  toolResponseMetadata?: unknown;
};

type OpenAICompatibility = Window & {
  openai?: OpenAIGlobals & {
    requestDisplayMode?: (options: { mode: DisplayMode }) => Promise<DisplayModeResult>;
    openExternal?: (options: { href: string; redirectUrl?: boolean }) => Promise<unknown>;
    setWidgetState?: (state: unknown) => void;
    sendFollowUpMessage?: (options: {
      prompt: string;
      scrollToBottom?: boolean;
    }) => Promise<unknown>;
  };
};

type DiagnosticDetail = Record<string, unknown>;

type DiagnosticEntry = {
  at: string;
  instance: string;
  event: string;
  detail?: DiagnosticDetail;
};

type StoredDiagnostics = {
  armed: boolean;
  instance: string;
  entries: DiagnosticEntry[];
};

const DIAGNOSTIC_STORAGE_KEY = "map-canvas-runtime-diagnostics-v1";
const diagnosticInstance =
  globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
const restoredDiagnostics = readStoredDiagnostics();
let diagnosticEntries = restoredDiagnostics?.entries ?? [];
let diagnosticsArmed = restoredDiagnostics?.armed ?? false;
let diagnosticsSending = false;
let restoredHostDiagnostics = false;

function readStoredDiagnostics(): StoredDiagnostics | undefined {
  try {
    const value = sessionStorage.getItem(DIAGNOSTIC_STORAGE_KEY);
    if (!value) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return undefined;
    return {
      armed: parsed.armed === true,
      instance: typeof parsed.instance === "string" ? parsed.instance : "unknown",
      entries: parsed.entries.filter((entry): entry is DiagnosticEntry => isRecord(entry)).slice(-80),
    };
  } catch {
    return undefined;
  }
}

function rectFor(element: Element | null): DiagnosticDetail | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function findWidgetSessionId(value: unknown, depth = 0): string | undefined {
  if (!isRecord(value) || depth > 4) return undefined;
  const direct = value["openai/widgetSessionId"];
  if (typeof direct === "string") return direct;
  for (const nested of Object.values(value).slice(0, 20)) {
    const found = findWidgetSessionId(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function runtimeGeometry(): DiagnosticDetail {
  const openai = (window as OpenAICompatibility).openai;
  const mapElement = document.getElementById("map");
  const shell = document.querySelector(".shell");
  const shellStyle = shell ? getComputedStyle(shell) : undefined;
  return {
    displayMode: openai?.displayMode ?? currentDisplayMode,
    maxHeight: openai?.maxHeight ?? null,
    safeArea: openai?.safeArea ?? null,
    view: openai?.view ?? null,
    theme: openai?.theme ?? null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualViewport: window.visualViewport
      ? {
          width: Math.round(window.visualViewport.width),
          height: Math.round(window.visualViewport.height),
          offsetTop: Math.round(window.visualViewport.offsetTop),
        }
      : null,
    documentElement: rectFor(document.documentElement),
    body: rectFor(document.body),
    shell: rectFor(shell),
    shellStyle: shellStyle
      ? {
          display: shellStyle.display,
          visibility: shellStyle.visibility,
          opacity: shellStyle.opacity,
          overflow: shellStyle.overflow,
        }
      : null,
    content: rectFor(document.querySelector(".content")),
    mapElement: rectFor(mapElement),
    mapClientSize: mapElement
      ? { width: mapElement.clientWidth, height: mapElement.clientHeight }
      : null,
    leafletSize: map ? { x: map.getSize().x, y: map.getSize().y } : null,
    mapCreated: Boolean(map),
    hasRendered,
    loadingHidden: loadingElement.hidden,
    toolOutputPresent: openai?.toolOutput !== undefined && openai?.toolOutput !== null,
    toolOutputValid: Boolean(parseMapData(openai?.toolOutput)),
    toolInputPresent: openai?.toolInput !== undefined && openai?.toolInput !== null,
    toolInputValid: Boolean(parseMapData(openai?.toolInput)),
    widgetStatePresent: openai?.widgetState !== undefined && openai?.widgetState !== null,
    widgetSessionId: findWidgetSessionId(openai?.toolResponseMetadata) ?? null,
    globalsKeys: openai ? Object.keys(openai).sort().slice(0, 40) : [],
  };
}

function diagnosticsState(): StoredDiagnostics {
  return {
    armed: diagnosticsArmed,
    instance: diagnosticInstance,
    entries: diagnosticEntries.slice(-80),
  };
}

function persistDiagnostics(): void {
  const state = diagnosticsState();
  try {
    sessionStorage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The widget-state path below remains available on hosts that block storage.
  }
  const openai = (window as OpenAICompatibility).openai;
  if (!openai?.setWidgetState) return;
  const previous = isRecord(openai.widgetState) ? openai.widgetState : {};
  const previousPrivate = isRecord(previous.privateContent) ? previous.privateContent : {};
  openai.setWidgetState({
    ...previous,
    privateContent: {
      ...previousPrivate,
      mapCanvasDiagnostics: state,
    },
  });
}

function recordDiagnostic(event: string, detail?: DiagnosticDetail): void {
  diagnosticEntries.push({
    at: new Date().toISOString(),
    instance: diagnosticInstance,
    event,
    ...(detail ? { detail } : {}),
  });
  diagnosticEntries = diagnosticEntries.slice(-80);
  if (diagnosticsArmed) persistDiagnostics();
  refreshDiagnosticsPanel();
}

function refreshDiagnosticsPanel(): void {
  diagnosticsStatusElement.textContent = diagnosticsArmed
    ? `記録中 · ${diagnosticEntries.length}件`
    : `${diagnosticEntries.length}件`;
  const recent = diagnosticEntries.slice(-18).map((entry) => ({
    at: entry.at.slice(11, 23),
    instance: entry.instance,
    event: entry.event,
    ...(entry.detail ? { detail: entry.detail } : {}),
  }));
  diagnosticsLogElement.textContent = recent.length
    ? JSON.stringify(recent, null, 2)
    : "診断イベントはまだありません。";
}

function restoreDiagnosticsFromHost(): void {
  if (restoredHostDiagnostics) return;
  const openai = (window as OpenAICompatibility).openai;
  const widgetState = openai?.widgetState;
  if (!isRecord(widgetState) || !isRecord(widgetState.privateContent)) return;
  const candidate = widgetState.privateContent.mapCanvasDiagnostics;
  if (!isRecord(candidate) || !Array.isArray(candidate.entries)) return;
  restoredHostDiagnostics = true;
  const hostEntries = candidate.entries.filter((entry): entry is DiagnosticEntry => isRecord(entry));
  if (hostEntries.length > diagnosticEntries.length) diagnosticEntries = hostEntries.slice(-80);
  diagnosticsArmed ||= candidate.armed === true;
  const previousInstance = typeof candidate.instance === "string" ? candidate.instance : "unknown";
  if (previousInstance !== diagnosticInstance) {
    recordDiagnostic("widget-remounted", { previousInstance, restoredVia: "widgetState" });
  }
}

function diagnosticReport(reason: string): DiagnosticDetail {
  return {
    diagnosticVersion: 1,
    widgetVersion: "0.5.0",
    resourceUri: "ui://map-canvas/map-v6.html",
    reason,
    instance: diagnosticInstance,
    snapshot: runtimeGeometry(),
    events: diagnosticEntries.slice(-80),
  };
}

async function sendDiagnostics(reason: string): Promise<void> {
  if (diagnosticsSending) return;
  const openai = (window as OpenAICompatibility).openai;
  recordDiagnostic("diagnostic-send-attempt", {
    reason,
    sendFollowUpAvailable: Boolean(openai?.sendFollowUpMessage),
  });
  if (!openai?.sendFollowUpMessage) {
    diagnosticsPanel.hidden = false;
    diagnosticsButton.setAttribute("aria-expanded", "true");
    diagnosticsStatusElement.textContent = "チャット送信APIなし";
    return;
  }
  diagnosticsSending = true;
  try {
    const report = JSON.stringify(diagnosticReport(reason), null, 2).slice(0, 14_000);
    await openai.sendFollowUpMessage({
      prompt:
        "Map Canvasの最大化診断結果です。UIが消える原因を、この実行時情報から分析してください。\n\n```json\n" +
        report +
        "\n```",
      scrollToBottom: true,
    });
    diagnosticsArmed = false;
    try {
      sessionStorage.removeItem(DIAGNOSTIC_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
    persistDiagnostics();
  } catch (error) {
    recordDiagnostic("diagnostic-send-error", { error: String(error) });
    diagnosticsPanel.hidden = false;
    diagnosticsButton.setAttribute("aria-expanded", "true");
  } finally {
    diagnosticsSending = false;
    refreshDiagnosticsPanel();
  }
}

function scheduleAutomaticDiagnostics(reason: string): void {
  if (!diagnosticsArmed) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        recordDiagnostic("automatic-snapshot", { reason, ...runtimeGeometry() });
        void sendDiagnostics(reason);
      }, 700);
    });
  });
}

function refreshMapLayout(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      map?.invalidateSize();
      fitCurrentView();
      if (diagnosticsArmed) recordDiagnostic("layout-refreshed", runtimeGeometry());
    });
  });
}

function syncDisplayMode(mode: DisplayMode): void {
  const previousMode = currentDisplayMode;
  currentDisplayMode = mode;
  const isFullscreen = mode === "fullscreen";
  document.querySelector(".shell")?.setAttribute("data-display-mode", mode);
  displayModeButton.setAttribute("aria-pressed", String(isFullscreen));
  displayModeButton.setAttribute("aria-label", isFullscreen ? "地図を元の大きさに戻す" : "地図を最大化");
  displayModeButton.title = isFullscreen ? "元の大きさに戻す" : "地図を最大化";
  displayModeButton.querySelector(".display-mode-icon")!.textContent = isFullscreen ? "⤡" : "⤢";
  displayModeButton.querySelector(".display-mode-label")!.textContent = isFullscreen ? "戻す" : "最大化";
  recordDiagnostic("display-mode-sync", { previousMode, mode, ...runtimeGeometry() });
  refreshMapLayout();
  if (isFullscreen) scheduleAutomaticDiagnostics("fullscreen-synchronized");
}

function refreshHostActions(): void {
  const openai = (window as OpenAICompatibility).openai;
  displayModeButton.hidden = !openai?.requestDisplayMode;
  syncDisplayMode(openai?.displayMode ?? currentDisplayMode);
}

function tryCompatibilityData(): void {
  restoreDiagnosticsFromHost();
  refreshHostActions();
  if (hasRendered) return;
  const openai = (window as OpenAICompatibility).openai;
  renderCandidate(openai?.toolOutput, "window.openai.toolOutput") ||
    renderCandidate(openai?.toolInput, "window.openai.toolInput");
}

function applyHostGlobals(globals: OpenAIGlobals | undefined): void {
  restoreDiagnosticsFromHost();
  recordDiagnostic("openai-set-globals", {
    globalsPresent: Boolean(globals),
    globalsKeys: globals ? Object.keys(globals).sort().slice(0, 40) : [],
    toolOutputPresent: globals?.toolOutput !== undefined && globals?.toolOutput !== null,
    toolInputPresent: globals?.toolInput !== undefined && globals?.toolInput !== null,
    displayMode: globals?.displayMode ?? null,
    maxHeight: globals?.maxHeight ?? null,
  });
  if (globals?.displayMode) syncDisplayMode(globals.displayMode);
  if (!hasRendered) {
    renderCandidate(globals?.toolOutput, "openai:set_globals.toolOutput") ||
      renderCandidate(globals?.toolInput, "openai:set_globals.toolInput");
  }
  if (hasRendered) refreshMapLayout();
}

async function requestDisplayMode(targetMode: DisplayMode, reason: string): Promise<void> {
  const openai = (window as OpenAICompatibility).openai;
  if (!openai?.requestDisplayMode) {
    recordDiagnostic("display-mode-unavailable", { targetMode, reason });
    return;
  }
  displayModeButton.disabled = true;
  diagnosticsFullscreenButton.disabled = true;
  recordDiagnostic("display-mode-request", { targetMode, reason, ...runtimeGeometry() });
  try {
    const result = await openai.requestDisplayMode({ mode: targetMode });
    recordDiagnostic("display-mode-result", {
      targetMode,
      reason,
      resultMode: result?.mode ?? null,
      hostMode: openai.displayMode ?? null,
      ...runtimeGeometry(),
    });
    syncDisplayMode(result?.mode ?? openai.displayMode ?? targetMode);
  } catch (error) {
    recordDiagnostic("display-mode-error", { targetMode, reason, error: String(error) });
    if (diagnosticsArmed) await sendDiagnostics("requestDisplayMode-error");
  } finally {
    displayModeButton.disabled = false;
    diagnosticsFullscreenButton.disabled = false;
  }
}

resetButton.addEventListener("click", fitCurrentView);
displayModeButton.addEventListener("click", async () => {
  const targetMode: DisplayMode = currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
  await requestDisplayMode(targetMode, "toolbar");
});

diagnosticsButton.addEventListener("click", () => {
  diagnosticsPanel.hidden = !diagnosticsPanel.hidden;
  diagnosticsButton.setAttribute("aria-expanded", String(!diagnosticsPanel.hidden));
  recordDiagnostic("diagnostics-panel", { open: !diagnosticsPanel.hidden, ...runtimeGeometry() });
});

diagnosticsCloseButton.addEventListener("click", () => {
  diagnosticsPanel.hidden = true;
  diagnosticsButton.setAttribute("aria-expanded", "false");
});

diagnosticsSendButton.addEventListener("click", () => {
  void sendDiagnostics("manual");
});

diagnosticsFullscreenButton.addEventListener("click", async () => {
  diagnosticEntries = [];
  diagnosticsArmed = true;
  recordDiagnostic("diagnostic-armed", { restoredFromStorage: Boolean(restoredDiagnostics) });
  persistDiagnostics();
  diagnosticsPanel.hidden = true;
  diagnosticsButton.setAttribute("aria-expanded", "false");
  await requestDisplayMode("fullscreen", "diagnostic");
});

window.addEventListener("error", (event) => {
  recordDiagnostic("window-error", {
    message: event.message,
    filename: event.filename?.split("/").pop() ?? null,
    line: event.lineno,
    column: event.colno,
  });
  if (diagnosticsArmed) scheduleAutomaticDiagnostics("window-error");
});

window.addEventListener("unhandledrejection", (event) => {
  recordDiagnostic("unhandled-rejection", { reason: String(event.reason) });
  if (diagnosticsArmed) scheduleAutomaticDiagnostics("unhandled-rejection");
});

window.addEventListener(
  "openai:set_globals",
  (event) => {
    const globals = (event as CustomEvent<{ globals?: OpenAIGlobals }>).detail?.globals;
    applyHostGlobals(globals ?? (window as OpenAICompatibility).openai);
  },
  { passive: true },
);

recordDiagnostic("script-ready", {
  restoredFromStorage: Boolean(restoredDiagnostics),
  previousInstance: restoredDiagnostics?.instance ?? null,
  ...runtimeGeometry(),
});

const bootstrapToolResult = (window as WindowWithBootstrap).__MAP_CANVAS_BOOTSTRAP__
  ?.initialToolResult;
if (bootstrapToolResult !== undefined) {
  receiveToolResult(bootstrapToolResult);
}

void request("ui/initialize", {
  appCapabilities: {},
  appInfo: { name: "Map Canvas", version: "0.6.0" },
  protocolVersion: "2026-01-26",
})
  .then(() => {
    recordDiagnostic("ui-initialize-resolved");
    post({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
    });
    tryCompatibilityData();
  })
  .catch((error) => {
    recordDiagnostic("ui-initialize-error", { error: String(error) });
    tryCompatibilityData();
    if (!hasRendered) showError("ホストへ接続できませんでした。");
  });
