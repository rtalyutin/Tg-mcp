# Следующий ход — web interface

Approved three-orbit Figma source: https://www.figma.com/design/arqKULt37de3TKUl3XiBN3?node-id=43-815

The existing outreach HTTP process serves `/dashboard/`. `/dashboard` redirects
there. The registry remains at `/`, and `/mcp` plus the optional `/dashboard/mcp`
keep their existing access controls. No new process, package dependency,
environment variable or Dashboard MCP activation is needed for the public demo.

The checked-in UI lives in `dashboard/web/` and uses semantic HTML, vanilla ES
modules, local CSS tokens, original exported Figma SVGs and locally served Roboto
variable fonts (Fontsource 5.2.10, license in `web/assets/license.txt`).
`SearchBar` in the Figma response refers to the Material 3 design kit, without a
project import. There is no corresponding installed code library in this repo;
its semantic implementation is a labelled HTML search input.

## Data boundary

The signed-out view is an explicitly labelled demonstration. `demo-data.js`
stores each task once with multiple project IDs, and each project once with
multiple group IDs. Unknown progress is null and appears as “Без оценки”. The
sample stages are only for the task dialog, not a backend state vocabulary.

The public files contain no source conversations, database data or credentials.
The UI now attempts a same-origin owner-session request to
`/dashboard/api/snapshot`. When a reviewed partial snapshot is installed in the
personal database and the dedicated read role is configured, an authenticated
owner sees it; other visitors see only the clearly labelled demo fixture. This
first slice is separate from the still-unconnected canonical graph endpoint and
full ChatGPT/Codex import. Setup and limits: `docs/curated-snapshot.md`.

The center renders three concentric levels: groups, projects and tasks. Clicking
a group reveals its projects; clicking a project reveals its tasks. Multiple
branches may remain expanded. Shared projects/tasks appear as one node with
links to each visible parent. `group_ids` is an optional many-to-many input;
the current private curated snapshot still assigns one `display_group_id` per
project, so additional memberships require reviewed source data. Search reveals
matching branches. Task cards show a marker, title and progress status; the
detail dialog shows project membership and evidence. Navigation focuses the
relevant area; Archive honestly reports that the demo has no archive.
The orbit layout now reserves a contiguous sector for each group, places
projects in its sector and tasks in their project's subsector. For an object
with several parents, one visible parent determines placement and the other
links remain secondary. The three levels are still concentric. Links display
equal-weight task progress: task-to-project is that task's value,
project-to-group is the mean of the project's tasks, and center-to-group uses
the unique tasks of all projects in the group. Unknown task values produce
lower/upper bounds rather than an invented percentage. A task shared by two
projects counts once in the group's aggregate.

The owner-only `/dashboard/api/history` lists committed daily results and
`/dashboard/api/compare?a_from=...&a_to=...&b_from=...&b_to=...` returns
the last committed state within each non-overlapping interval and the recorded
events inside each interval. Both routes use the same owner-session gate as
`/dashboard/api/snapshot`; the browser does not receive database access.
Prepared days are excluded. The comparison UI uses the second endpoint as its
visible graph, overlays the first endpoint's progress on links, and displays
recorded events in a timeline. Dates, coverage and the actual endpoint dates
are visible. If either interval lacks a saved day, comparison is unavailable
without manufacturing history. The public demo has no fabricated comparison.
Migration 008 exposes only committed fields through
`dashboard.published_daily_history`; the underlying `daily_result` and
`dialog_scan` remain private. Apply the updated `grant-runtime.sql` (or
`grant-snapshot-reader.sql` for the separate reader role) after migration.
At startup, history is enabled only when the service login can read the view;
the current snapshot remains available if this grant has not yet been applied.
The second view, **План · Гант**, places each task immediately under its project
and each project under its group. A shared task appears in each relevant branch,
but has one planned date range and contributes only once to a group average.
The left column is a collapsible hierarchy with task date fields and progress;
the right side shows 28 calendar days, schedule bars and known/unknown progress
fill. The calendar can step two weeks, return to today or jump to a date.
Group/project ranges are derived from their scheduled descendants, never edited
separately. An unscheduled task remains visible with empty date fields. The
signed-out demo has no invented dates and cannot save.

In the Gantt project row, the owner can hide that project across the entire
Dashboard. A hidden project disappears from both views and search. Any task
linked to it disappears everywhere, including under its other visible projects;
an empty group disappears too. The Gantt toolbar lists hidden projects and
restores them individually. The current visibility preference also applies to
historical comparison, progress, and identifiable timeline events; hiding does
not alter the stored daily states or the curated snapshot. The list is loaded
before the owner snapshot is shown, so a failed visibility read leaves the
page in its labelled demo state instead of exposing an unfiltered owner view.
The list and edits require the owner session. A second-tab edit returns 409 and
reloads the current preference. The signed-out demo has no hide action.

Migration 009 stores task dates and an edit version in `dashboard.task_plan`,
separately from the daily curated snapshot. `/dashboard/api/plan` reads the
current plan under the owner session and supplies the session's CSRF token;
`POST /dashboard/api/plan/task` requires the same owner session, exact Origin
and CSRF header. It validates the current task ID, both calendar dates and
their order, then updates with an expected version. A stale edit returns 409
and prompts a reload. Clearing dates is supported. Changes to a curated
snapshot do not erase the plan; removed tasks do not appear in the current
view. During historical comparison the calendar uses the current plan and
current hierarchy, while progress and events come from the selected saved
states; the plan has no historical revisions. Apply migration 009 before
activating the planning API. The inbox action adds a temporary example only in
the current tab, and says so before submission. No localStorage or background
jobs are used.

Migration 010 stores curated project visibility separately from the canonical
UUID keyed visibility table and from the daily snapshot. `GET
/dashboard/api/visibility` reads current project preferences and supplies the
session CSRF token; `POST /dashboard/api/visibility/project` validates a current
project ID, boolean hidden state, expected version, owner session, Origin and
CSRF. Apply migration 010 before enabling these endpoints. The separate read
role needs the updated `grant-snapshot-reader.sql`; the shared HTTP login must
have INSERT and UPDATE on the preference table to offer editing.

## Layout and assets

At desktop widths >=1500px, the center occupies 50vw. The design uses scalable
half-size units, so 1920×1080 matches the standard viewport. Below 1500px,
panels reflow into two columns; below 700px, one column. Ring radius grows with
the number of visible nodes, and the center board scrolls in both directions
when branches exceed the viewport. All relation paths are generated from the
visible data; there is no fixed connection SVG. Fonts and icons are served
locally, with no expiring Figma URLs.

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

Final runtime verification must visit the target `/dashboard/` after the new
revision is deployed. Source and test results are tracked in the corresponding
pull request.

Rollback: revert the dashboard web commit and deploy the resulting main revision.
No data rollback is required because this change has no schema/data mutations.
