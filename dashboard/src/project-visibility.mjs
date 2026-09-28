export function createProjectVisibility(db) {
  return {
    async read() {
      const {rows}=await db.query(`SELECT project_id,hidden,version
        FROM dashboard.curated_project_visibility ORDER BY project_id`);
      return rows.map(row=>({
        project_id:row.project_id,hidden:row.hidden,version:row.version
      }));
    },
    async write(input) {
      if (!input || typeof input!=='object' || Array.isArray(input) ||
          Object.keys(input).sort().join(',')!=='hidden,project_id,version' ||
          typeof input.project_id!=='string' || !input.project_id || input.project_id.length>512 ||
          typeof input.hidden!=='boolean' ||
          !Number.isSafeInteger(input.version) || input.version<0)
        throw new Error('INVALID_PROJECT_VISIBILITY');
      return db.transaction(async tx=>{
        const {rows:[current]}=await tx.query(
          'SELECT payload FROM dashboard.curated_snapshot WHERE singleton=1 FOR SHARE');
        if (!current?.payload?.projects?.some(project=>project.id===input.project_id))
          throw new Error('PROJECT_NOT_FOUND');
        const {rows}=await tx.query(`INSERT INTO dashboard.curated_project_visibility(project_id,hidden,version)
          VALUES ($1,$2,1) ON CONFLICT(project_id) DO UPDATE
          SET hidden=EXCLUDED.hidden,version=dashboard.curated_project_visibility.version+1,updated_at=now()
          WHERE dashboard.curated_project_visibility.version=$3
          RETURNING project_id,hidden,version`,[input.project_id,input.hidden,input.version]);
        // A first insert is legal only with expected version zero.
        if (rows[0]?.version!==input.version+1) throw new Error('PROJECT_VISIBILITY_CONFLICT');
        return {project_id:rows[0].project_id,hidden:rows[0].hidden,version:rows[0].version};
      });
    }
  };
}
