# Следующий ход — web interface

Approved Figma source: https://www.figma.com/design/arqKULt37de3TKUl3XiBN3?node-id=4-2

The existing outreach HTTP process serves `/dashboard/`. `/dashboard` redirects
there. The registry remains at `/`, and `/mcp` plus the optional `/dashboard/mcp`
keep their existing access controls. No new process, package dependency,
environment variable, database migration or Dashboard MCP activation is needed.

The checked-in UI lives in `dashboard/web/` and uses semantic HTML, vanilla ES
modules, local CSS tokens, original exported Figma SVGs and locally served Roboto
variable fonts (Fontsource 5.2.10, license in `web/assets/license.txt`).
`SearchBar` in the Figma response refers to the Material 3 design kit, without a
project import. There is no corresponding installed code library in this repo;
its semantic implementation is a labelled HTML search input.

## Data boundary

This is an explicitly labelled demonstration using the approved design's sample
content. `demo-data.js` stores each task once with multiple project IDs. Unknown
progress is null and renders as an em dash. The four sample stages are a display
fixture, not a decision about the backend's still-open state vocabulary.

The public files contain no source conversations, database data or credentials.
The UI now attempts a same-origin owner-session request to
`/dashboard/api/snapshot`. When a reviewed partial snapshot is installed in the
personal database and the dedicated read role is configured, an authenticated
owner sees it; other visitors see only the clearly labelled demo fixture. This
first slice is separate from the still-unconnected canonical graph endpoint and
full ChatGPT/Codex import. Setup and limits: `docs/curated-snapshot.md`.

Search filters projects and tasks; selecting a project displays only its
connections. Task cards show progress and membership in a dialog. Navigation
focuses the relevant area; Archive honestly reports that the demo has no archive.
The inbox action adds a temporary example only in the current tab, and says so
before submission. No localStorage, remote writes or background jobs are used.

## Layout and assets

At desktop widths >=1500px, the center occupies exactly 50vw. The approved
3840×2160 design is rendered in scalable half-size design units, so 1920×1080 is
the matching standard viewport. Below 1500px, panels reflow into two columns;
below 700px, one column, with deliberate horizontal scrolling inside the board.
Fonts, icons and structural SVGs are served locally. No expiring Figma URLs are
used. Original SVG root dimensions remain intact; wrappers scale the exports.
The selected tournament's original connection asset is used in the default
wide-screen view; other selections use data-driven SVG geometry.

## Build and verify

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run build
node --test test/dashboard-web.test.ts test/dashboard-composition.test.ts
```

The existing Timeweb build and start commands remain unchanged. Build checks
all allowlisted dashboard files. Static paths are exact and query-free, only
GET/HEAD can bypass database admission, and Host/Origin/HTTPS checks remain.
The dashboard CSP allows only self-hosted scripts, CSS, images, fonts and
same-origin fetch for the private snapshot route. Existing routes retain their
prior CSP.

Target environment: `https://rtalyutin-tg-mcp-8179.twc1.net/dashboard/` (the
current origin in `.github/workflows/telegram-worker.yml`; the older Timeweb
document's `fb9b` origin is historical).

24 September 2026, local Node 24.19.0: TypeScript and build PASS; HTTP and
composition tests 4/4 PASS; root suite 162 PASS, 6 expected PostgreSQL-only skips,
0 FAIL. A separate request round against the compiled dist gateway returned
HTML/CSS/JS/demo/SVG/fonts with correct MIME and nonzero bodies. These checks do
not establish deployment or visual/browser acceptance. Final runtime verification
must visit the target `/dashboard/` after the approved main revision is deployed.

Rollback: revert the dashboard web commit and deploy the resulting main revision.
No data rollback is required because this change has no schema/data mutations.
