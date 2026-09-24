// Marks the active nav link. "/", "/index.html", "/state" and "/state.html" all resolve.

function normalize(p) {
  const s = String(p || "").replace(/\/+$/, "").replace(/\.html$/, "").replace(/\/index$/, "");
  return s || "/";
}

const here = normalize(location.pathname);
for (const a of document.querySelectorAll(".nav a")) {
  const active = normalize(a.getAttribute("href")) === here;
  a.classList.toggle("active", active);
  if (active) a.setAttribute("aria-current", "page");
  else a.removeAttribute("aria-current");
}
