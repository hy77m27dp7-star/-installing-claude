// One list of sections for every page header. Rebuilds the nav from it and marks the
// current page; "/", "/index.html", "/state" and "/state.html" all resolve.

const LINKS = [
  ["/", "Chat"],
  ["/state", "State"],
  ["/model", "Model"],
  ["/images", "Images"],
  ["/timeline", "Timeline"],
];

function normalize(p) {
  const s = String(p || "").replace(/\/+$/, "").replace(/\.html$/, "").replace(/\/index$/, "");
  return s || "/";
}

const here = normalize(location.pathname);
for (const nav of document.querySelectorAll(".nav")) {
  nav.replaceChildren();
  for (const [href, label] of LINKS) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    const active = normalize(href) === here;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
}
