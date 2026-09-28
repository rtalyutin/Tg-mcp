# Dashboard on phones

At viewports up to 700 CSS pixels, the project board opens as a file explorer:
groups are folders, a folder contains project rows, and each project expands its
task rows in place. The same project may appear in several groups and the same
task under several projects; each occurrence opens the original object. Search
starts from the folder list and finds group, project, and task titles. The
breadcrumb returns to the folders, while task details close back to the same
expanded project. Browser Back also returns from a folder to the prior view.

The bottom navigation opens folders, the existing Gantt table, the existing
incoming/priority panels, changes/automations, and the existing archive dialog.
Comparison controls are collapsed on phones until requested. The Gantt table
scrolls internally with its name column fixed; task dates use a dialog on phones.
Desktop orbits and their interactions are unchanged.

Project hiding uses the existing owner visibility API and persisted database
state. The `Скрыть` action in project rows and the Gantt excludes a project
from the board, plan, search, and comparison. A task touching any hidden
project disappears everywhere, including under another visible parent.
`Сроки` → `Скрытые проекты` restores projects. In demo mode the hide action
is unavailable. Hiding never edits the source snapshot, dates, or group
memberships. The existing data-mode and coverage labels remain in place.

Verify at 320, 390, and 430 CSS pixels: no document-level horizontal scroll;
all 41 projects and 60 tasks in a representative dataset remain reachable;
search opens the matching context; a shared task and multi-group project keep
one identity; hide/restore propagates across folders and plan; Back and dialog
close keep the expected state. Test the final build on the owner's Android Chrome
before claiming device-level visual acceptance.
