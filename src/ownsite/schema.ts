/** Isolated metadata constructor: no dependency on private workspace schemas. */
export const ownsiteMigrationSql = `
CREATE SCHEMA IF NOT EXISTS ownsite;
CREATE TABLE IF NOT EXISTS ownsite.entity_types (
  id text PRIMARY KEY, title text NOT NULL
);
CREATE TABLE IF NOT EXISTS ownsite.entities (
  id text PRIMARY KEY, entity_type text NOT NULL REFERENCES ownsite.entity_types(id),
  slug text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,entity_type), UNIQUE(entity_type,slug)
);
CREATE TABLE IF NOT EXISTS ownsite.entity_parameters (
  entity_type text NOT NULL REFERENCES ownsite.entity_types(id),
  key text NOT NULL, data_type text NOT NULL CHECK(data_type IN ('text','boolean','integer','json')),
  title text NOT NULL, nullable boolean NOT NULL DEFAULT false,
  PRIMARY KEY(entity_type,key), UNIQUE(entity_type,key,data_type,nullable)
);
CREATE TABLE IF NOT EXISTS ownsite.entity_parameter_values (
  entity_id text NOT NULL, entity_type text NOT NULL, parameter_key text NOT NULL,
  data_type text NOT NULL, parameter_nullable boolean NOT NULL DEFAULT false,
  is_null boolean NOT NULL DEFAULT false,
  text_value text, boolean_value boolean, integer_value integer, json_value jsonb,
  PRIMARY KEY(entity_id,parameter_key),
  FOREIGN KEY(entity_id,entity_type) REFERENCES ownsite.entities(id,entity_type),
  FOREIGN KEY(entity_type,parameter_key,data_type,parameter_nullable)
    REFERENCES ownsite.entity_parameters(entity_type,key,data_type,nullable),
  CHECK (NOT is_null OR parameter_nullable),
  CHECK (
    (is_null AND num_nonnulls(text_value,boolean_value,integer_value,json_value)=0) OR
    (NOT is_null AND num_nonnulls(text_value,boolean_value,integer_value,json_value)=1 AND
      ((data_type='text' AND text_value IS NOT NULL) OR
       (data_type='boolean' AND boolean_value IS NOT NULL) OR
       (data_type='integer' AND integer_value IS NOT NULL) OR
       (data_type='json' AND json_value IS NOT NULL)))
  ),
  CHECK (parameter_key NOT IN ('links','reveal','tools') OR is_null OR jsonb_typeof(json_value)='array')
);
CREATE INDEX IF NOT EXISTS ownsite_public_flags ON ownsite.entity_parameter_values(parameter_key,boolean_value,entity_id);
CREATE TABLE IF NOT EXISTS ownsite.site_settings (key text PRIMARY KEY, value text NOT NULL);
`;
