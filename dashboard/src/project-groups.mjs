import {createHash} from 'node:crypto';
const fail = (code,details) => {
  const error=new Error(code);
  if (details) error.details=details;
  throw error;
};
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...values].sort(compare);

/** Merge stored memberships with explicit full replacements for selected projects. */
export async function resolveProjectGroups(tx, projects, incoming, {requireAllIncoming=false}={}) {
  if (incoming!==undefined && (!Array.isArray(incoming) || incoming.length>2000))
    fail('DASHBOARD_PROJECT_GROUPS_INVALID');
  const projectIds=new Set(projects.map(project=>project.id));
  const memberships=new Map([...projectIds].map(id=>[id,new Set()]));
  const {rows:stored}=await tx.query('SELECT project_id,group_code FROM dashboard.projects_groups ORDER BY project_id,group_code');
  for (const row of stored) {
    if (!memberships.has(row.project_id)) {
      memberships.set(row.project_id,new Set([row.group_code]));
      continue;
    }
    memberships.get(row.project_id).add(row.group_code);
  }
  const byIncoming=new Map(), seenPairs=new Set();
  for (const assignment of incoming??[]) {
    if (!assignment || typeof assignment!=='object' || Array.isArray(assignment) ||
        Object.keys(assignment).some(key=>!['project_id','group_code'].includes(key)) ||
        typeof assignment.project_id!=='string' || !assignment.project_id.trim() || assignment.project_id.length>512 ||
        typeof assignment.group_code!=='string' || !assignment.group_code.trim() || assignment.group_code.length>256 ||
        !projectIds.has(assignment.project_id))
      fail('DASHBOARD_PROJECT_GROUPS_INVALID');
    const groupCode=assignment.group_code.trim();
    const pair=JSON.stringify([assignment.project_id,groupCode]);
    if (seenPairs.has(pair)) fail('DASHBOARD_PROJECT_GROUPS_INVALID');
    seenPairs.add(pair);
    if (!byIncoming.has(assignment.project_id)) byIncoming.set(assignment.project_id,new Set());
    byIncoming.get(assignment.project_id).add(groupCode);
  }
  if (requireAllIncoming && (byIncoming.size!==projectIds.size || [...projectIds].some(id=>!byIncoming.has(id))))
    fail('DASHBOARD_PROJECT_GROUPS_REQUIRED');
  for (const [projectId,codes] of byIncoming) memberships.set(projectId,codes);
  const missing=[...projectIds].filter(id=>!memberships.get(id)?.size);
  const stale=[...memberships.keys()].filter(id=>!projectIds.has(id));
  if (missing.length) fail('DASHBOARD_PROJECT_GROUPS_REQUIRED',{project_ids:missing});
  if (stale.length) fail('DASHBOARD_PROJECT_GROUPS_STALE');
  return [...memberships].flatMap(([project_id,codes])=>sorted(codes).map(group_code=>({project_id,group_code})))
    .sort((a,b)=>compare(a.project_id,b.project_id)||compare(a.group_code,b.group_code));
}

/** Replace memberships only for projects named by the explicit incoming set. */
export async function writeProjectGroups(tx, assignments, replaceProjectIds=[]) {
  if (replaceProjectIds.length)
    await tx.query('DELETE FROM dashboard.projects_groups WHERE project_id = ANY($1::text[])',[replaceProjectIds]);
  const replacing=new Set(replaceProjectIds);
  for (const {project_id,group_code} of assignments) {
    if (replacing.size && !replacing.has(project_id)) continue;
    await tx.query(`INSERT INTO dashboard.projects_groups(project_id,group_code) VALUES($1,$2)
      ON CONFLICT(project_id,group_code) DO UPDATE SET updated_at=now()`,[project_id,group_code]);
  }
}

export function projectGroupsDigest(assignments) {
  const canonical=[...assignments].sort((a,b)=>compare(a.project_id,b.project_id)||compare(a.group_code,b.group_code));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function groupedProject(project, assignments) {
  const group_codes=sorted(assignments.filter(row=>row.project_id===project.id).map(row=>row.group_code));
  return {...project,group_codes,...(group_codes.length===1?{group_code:group_codes[0]}:{})};
}

export async function readGroupedSnapshot(db, snapshot) {
  const {rows}=await db.query('SELECT project_id,group_code FROM dashboard.projects_groups ORDER BY project_id,group_code');
  const ids=new Set(snapshot.projects.map(project=>project.id));
  const assigned=new Set(rows.map(row=>row.project_id));
  if (assigned.size!==ids.size || [...ids].some(id=>!assigned.has(id)) || [...assigned].some(id=>!ids.has(id)))
    fail('DASHBOARD_PROJECT_GROUPS_INCOMPLETE');
  return {...snapshot,projects:snapshot.projects.map(project=>groupedProject(project,rows))};
}
