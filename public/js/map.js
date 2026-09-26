// The drawn map (SPEC_V4 section 1): one inline SVG of her city from a fixed outline and
// the places' stored coordinates. No tile server, nothing fetched, nothing new in the
// content security policy. Every colour, stroke and font size comes from the stylesheet
// (.map, .map-water, .map-land, .map-dot, .map-dot.here, .map-label); this file never
// writes a style attribute (the CSP has no unsafe-inline) and SVG presentation
// attributes cannot carry var(), so it sets none.
//
// Pure DOM building: no top-level DOM, location or fetch, so the unit suite can import it
// under Node and compare project/unproject with src/places.ts.

const SVG_NS = "http://www.w3.org/2000/svg";

export const PORTLAND_BOUNDS = { latMin: 43.636, latMax: 43.686, lonMin: -70.294, lonMax: -70.232 };
export const MAP_VIEW = { w: 360, h: 240 };
export const DOT_R = 6;
const LABEL_DY = 16;
const LABEL_MAX = 24;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Equirectangular, the same arithmetic as src/places.ts: x grows east, y grows south; a
// point outside the bounds is clamped to the edge and says so.
export function project(lat, lon, bounds = PORTLAND_BOUNDS, view = MAP_VIEW) {
  const la = Number(lat);
  const lo = Number(lon);
  const spanLat = bounds.latMax - bounds.latMin || 1;
  const spanLon = bounds.lonMax - bounds.lonMin || 1;
  const fx = Number.isFinite(lo) ? (lo - bounds.lonMin) / spanLon : 0.5;
  const fy = Number.isFinite(la) ? (bounds.latMax - la) / spanLat : 0.5;
  const cx = clamp01(fx);
  const cy = clamp01(fy);
  const out = { x: cx * view.w, y: cy * view.h };
  if (cx !== fx || cy !== fy) out.clamped = true;
  return out;
}

export function unproject(x, y, bounds = PORTLAND_BOUNDS, view = MAP_VIEW) {
  const fx = view.w ? Number(x) / view.w : 0;
  const fy = view.h ? Number(y) / view.h : 0;
  return {
    lon: bounds.lonMin + clamp01(fx) * (bounds.lonMax - bounds.lonMin),
    lat: bounds.latMax - clamp01(fy) * (bounds.latMax - bounds.latMin),
  };
}

function num(v, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 10 ** digits) / 10 ** digits) : "0";
}

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

// The outline as a closed path from projected points ({ x, y }) or lat/lon pairs.
export function outlinePath(points, bounds = PORTLAND_BOUNDS, view = MAP_VIEW) {
  const parts = [];
  for (const p of Array.isArray(points) ? points : []) {
    let x;
    let y;
    if (Array.isArray(p)) {
      const q = project(p[0], p[1], bounds, view);
      x = q.x;
      y = q.y;
    } else if (p && typeof p === "object") {
      x = p.x;
      y = p.y;
    } else {
      continue;
    }
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) continue;
    parts.push((parts.length ? "L" : "M") + num(x) + " " + num(y));
  }
  return parts.length ? parts.join(" ") + " Z" : "";
}

function mapOf(state) {
  const m = state && state.map && typeof state.map === "object" ? state.map : {};
  const bounds = m.bounds && typeof m.bounds === "object" ? m.bounds : PORTLAND_BOUNDS;
  const view = m.view && typeof m.view === "object" ? m.view : MAP_VIEW;
  const outline = Array.isArray(m.outline) ? m.outline : [];
  return { bounds, view, outline };
}

function labelOf(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX - 3).trimEnd() + "..." : t;
}

// Pointer position in view units from a pointer event on the svg.
function viewPoint(svg, event, view) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((event.clientX - rect.left) / rect.width) * view.w;
  const y = ((event.clientY - rect.top) / rect.height) * view.h;
  return { x, y };
}

// drawMap(container, state, { onTap?, onPlace? }): replaces the container's content with
// one <svg class="map">: the water, the land outline, a dot per pinned place (the `here`
// place carries the class here), each in a focusable button group with its label under
// it. With onTap armed, a tap anywhere on the map converts the pointer position through
// unproject and calls onTap(lat, lon). onPlace(id) fires on a dot's tap or Enter.
export function drawMap(container, state, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const { bounds, view, outline } = mapOf(state);
  const svg = el("svg", {
    class: "map" + (typeof options.onTap === "function" ? " armed" : ""),
    viewBox: "0 0 " + view.w + " " + view.h,
    // A group, not an img: an img role would make the place buttons inside it presentational.
    role: "group",
    "aria-label": "Map",
    preserveAspectRatio: "xMidYMid meet",
  });
  svg.append(el("rect", { class: "map-water", x: 0, y: 0, width: view.w, height: view.h }));
  const d = outlinePath(outline, bounds, view);
  if (d) svg.append(el("path", { class: "map-land", d }));

  const dots = el("g", { class: "map-dots" });
  const places = Array.isArray(state && state.places) ? state.places : [];
  for (const p of places) {
    if (!p || typeof p !== "object") continue;
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const q = project(lat, lon, bounds, view);
    const title = String(p.title || "");
    const g = el("g", { class: "map-place" + (p.here ? " here" : "") + (p.active === false ? " gone" : ""), tabindex: "0", role: "button", "aria-label": title, "data-id": String(p.id || "") });
    g.append(el("circle", { class: "map-dot" + (p.here ? " here" : ""), cx: num(q.x), cy: num(q.y), r: DOT_R }));
    const label = el("text", { class: "map-label", x: num(q.x), y: num(q.y + LABEL_DY), "text-anchor": "middle" });
    label.textContent = labelOf(title);
    g.append(label);
    if (typeof options.onPlace === "function") {
      const fire = (ev) => {
        ev.stopPropagation();
        options.onPlace(String(p.id || ""), p);
      };
      g.addEventListener("click", fire);
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          fire(ev);
        }
      });
    }
    dots.append(g);
  }
  svg.append(dots);

  if (typeof options.onTap === "function") {
    svg.addEventListener("click", (ev) => {
      const pt = viewPoint(svg, ev, view);
      if (!pt) return;
      const { lat, lon } = unproject(pt.x, pt.y, bounds, view);
      options.onTap(lat, lon, pt);
    });
  }

  if (container) {
    container.replaceChildren(svg);
  }
  return svg;
}
