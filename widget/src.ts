import { App } from "@modelcontextprotocol/ext-apps";
import L, { type LatLngExpression, type Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

type Coordinate = { lat: number; lng: number };
type Place = Coordinate & {
  id: string;
  label: string;
  description?: string;
};
type MapData = {
  title: string;
  places: Place[];
  connectPlaces: boolean;
  center?: Coordinate;
  zoom?: number;
};

const titleElement = requiredElement("title");
const countElement = requiredElement("count");
const listElement = requiredElement("places");
const loadingElement = requiredElement("loading");

let map: LeafletMap | undefined;
let renderedLayers: L.LayerGroup | undefined;

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
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

function parsePlace(value: unknown): Place | undefined {
  if (!isRecord(value) || !isCoordinate(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.label !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    label: value.label,
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    lat: value.lat,
    lng: value.lng,
  };
}

function parseMapData(value: unknown): MapData | undefined {
  if (!isRecord(value) || !Array.isArray(value.places)) return undefined;
  const places = value.places.map(parsePlace).filter((place) => place !== undefined);
  if (places.length === 0) return undefined;
  return {
    title: typeof value.title === "string" ? value.title : "Map",
    places,
    connectPlaces: value.connectPlaces === true,
    ...(isCoordinate(value.center) ? { center: value.center } : {}),
    ...(typeof value.zoom === "number" ? { zoom: value.zoom } : {}),
  };
}

function ensureMap(): LeafletMap {
  if (map) return map;
  map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    subdomains: "abc",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  return map;
}

function markerIcon(index: number): L.DivIcon {
  return L.divIcon({
    className: "numbered-marker-wrap",
    html: `<span class="numbered-marker"><b>${index + 1}</b></span>`,
    iconSize: [34, 42],
    iconAnchor: [17, 42],
    popupAnchor: [0, -40],
  });
}

function popupFor(place: Place, index: number): HTMLElement {
  const popup = document.createElement("article");
  popup.className = "popup";
  const heading = document.createElement("strong");
  heading.textContent = `${index + 1}. ${place.label}`;
  popup.append(heading);
  if (place.description) {
    const description = document.createElement("p");
    description.textContent = place.description;
    popup.append(description);
  }
  return popup;
}

function renderList(data: MapData, markers: L.Marker[]): void {
  listElement.replaceChildren();
  data.places.forEach((place, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-button";

    const number = document.createElement("span");
    number.className = "place-number";
    number.textContent = String(index + 1);
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = place.label;
    copy.append(label);
    if (place.description) {
      const description = document.createElement("small");
      description.textContent = place.description;
      copy.append(description);
    }
    button.append(number, copy);
    button.addEventListener("click", () => {
      map?.flyTo([place.lat, place.lng], Math.max(map.getZoom(), 15), {
        duration: 0.5,
      });
      markers[index]?.openPopup();
    });
    item.append(button);
    listElement.append(item);
  });
}

function render(data: MapData): void {
  const activeMap = ensureMap();
  renderedLayers?.remove();
  renderedLayers = L.layerGroup().addTo(activeMap);

  const coordinates: LatLngExpression[] = data.places.map((place) => [
    place.lat,
    place.lng,
  ]);
  const markers = data.places.map((place, index) =>
    L.marker([place.lat, place.lng], { icon: markerIcon(index) })
      .bindPopup(popupFor(place, index), { closeButton: false })
      .addTo(renderedLayers!),
  );

  if (data.connectPlaces && coordinates.length > 1) {
    L.polyline(coordinates, {
      color: "#2563eb",
      weight: 4,
      opacity: 0.8,
      lineJoin: "round",
    }).addTo(renderedLayers);
  }

  if (data.center && data.zoom !== undefined) {
    activeMap.setView([data.center.lat, data.center.lng], data.zoom);
  } else if (coordinates.length === 1) {
    activeMap.setView(coordinates[0]!, data.zoom ?? 14);
  } else {
    activeMap.fitBounds(L.latLngBounds(coordinates), {
      padding: [40, 40],
      maxZoom: data.zoom ?? 15,
    });
  }

  titleElement.textContent = data.title;
  countElement.textContent = `${data.places.length}地点`;
  loadingElement.hidden = true;
  renderList(data, markers);
  requestAnimationFrame(() => activeMap.invalidateSize());
}

function showError(message: string): void {
  loadingElement.textContent = message;
  loadingElement.classList.add("error");
}

const app = new App({ name: "Map Canvas", version: "0.1.0" });

app.ontoolresult = (result) => {
  const data = parseMapData(result.structuredContent);
  if (!data) {
    showError("表示できる地点データがありません。");
    return;
  }
  render(data);
};

app.onerror = (error) => {
  showError(`地図を初期化できませんでした：${error.message}`);
};

void app.connect().catch((error: unknown) => {
  showError(
    `ホストへ接続できませんでした：${error instanceof Error ? error.message : "unknown error"}`,
  );
});
