# Internal canonical graph read

`readUnfilteredCanonicalGraph(db)` reads projects, tasks, their many-to-many
membership, task relations, folders, folder membership, and the two owner
visibility tables from one repeatable-read transaction. It never reads raw
conversation events. Unknown task progress remains `null`.

The result is **unfiltered owner data** and must not be returned from an HTTP
route, MCP tool, or shared client. `readOwnerVisibleGraph(db)` applies the
owner's 24 September visibility decisions: a hidden folder hides every linked
project, and a task linked to any hidden project disappears everywhere, even
from its visible projects. It removes hidden nodes and dangling links from the
project-scoped graph. Tasks with no project membership are omitted from this
project-scoped result; their separate presentation has not been specified.

The filtered reader remains internal. There is no owner-authenticated read
endpoint or canonical database role yet; the import runtime role intentionally
has no SELECT rights for these tables. Do not wire this reader to the import
MCP connection.

The reader sorts each table by its keys and rejects more than 10,000 rows in
any one table; it does not silently truncate the graph. Pagination or a
bounded view will be needed before using it with larger stores. It does not
extract claims from conversation history or accept/reject change proposals.
