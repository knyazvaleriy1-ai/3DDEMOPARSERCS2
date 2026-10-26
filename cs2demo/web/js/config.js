// Build-time switch. `scripts/build_site.py` sets STATIC = true for the
// server-less web version (GitHub Pages): demos are parsed in the browser and
// kept in IndexedDB, map assets are static files next to the page.
export const STATIC = false;
