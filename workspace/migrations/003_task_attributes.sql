-- Additive typed constructor. Legacy work_items and all existing pointers remain intact.
CREATE TABLE entities (
 owner_id uuid NOT NULL REFERENCES workspaces(owner_id) DEFERRABLE INITIALLY DEFERRED, entity_type text NOT NULL CHECK(entity_type='task'),
 id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,entity_type,id),
 FOREIGN KEY(owner_id,id) REFERENCES work_items(owner_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE entity_parameters (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES workspaces(owner_id) DEFERRABLE INITIALLY DEFERRED, entity_type text NOT NULL CHECK(entity_type='task'),
 code text NOT NULL CHECK(code ~ '^[a-z][a-z0-9_]{0,79}$'), label text NOT NULL CHECK(length(label)>0),
 data_type text NOT NULL CHECK(data_type IN ('string','number','boolean','datetime','reference')),
 multiple boolean NOT NULL DEFAULT false,
 required_stage text NOT NULL DEFAULT 'none' CHECK(required_stage IN ('none','activation','blocked','completion')),
 type_profile text, required_when_code text, required_when_value text,
 protected boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,entity_type,code), UNIQUE(owner_id,entity_type,id), UNIQUE(owner_id,entity_type,id,data_type,multiple),
 CHECK((required_when_code IS NULL)=(required_when_value IS NULL))
);
CREATE TABLE entity_parameter_options (
 owner_id uuid NOT NULL, entity_type text NOT NULL, parameter_id uuid NOT NULL, value text NOT NULL CHECK(length(value)>0),
 ordinal integer NOT NULL CHECK(ordinal>=0),
 PRIMARY KEY(owner_id,entity_type,parameter_id,value), UNIQUE(owner_id,entity_type,parameter_id,ordinal),
 FOREIGN KEY(owner_id,entity_type,parameter_id) REFERENCES entity_parameters(owner_id,entity_type,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE entity_parameter_values (
 owner_id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, parameter_id uuid NOT NULL,
 data_type text NOT NULL, multiple boolean NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0),
 value_text text, value_number numeric, value_boolean boolean, value_datetime timestamptz, value_ref uuid,
 PRIMARY KEY(owner_id,entity_type,entity_id,parameter_id,ordinal),
 FOREIGN KEY(owner_id,entity_type,entity_id) REFERENCES entities(owner_id,entity_type,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,entity_type,parameter_id,data_type,multiple) REFERENCES entity_parameters(owner_id,entity_type,id,data_type,multiple) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,entity_type,value_ref) REFERENCES entities(owner_id,entity_type,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(multiple OR ordinal=0),
 CHECK(num_nonnulls(value_text,value_number,value_boolean,value_datetime,value_ref)=1),
 CHECK((data_type='string' AND value_text IS NOT NULL) OR (data_type='number' AND value_number IS NOT NULL) OR
       (data_type='boolean' AND value_boolean IS NOT NULL) OR (data_type='datetime' AND value_datetime IS NOT NULL) OR
       (data_type='reference' AND value_ref IS NOT NULL)),
 CHECK(value_ref IS NULL OR value_ref<>entity_id)
);
CREATE INDEX entity_parameter_reference ON entity_parameter_values(owner_id,entity_type,value_ref) WHERE value_ref IS NOT NULL;
CREATE FUNCTION validate_parameter_option() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM entity_parameter_options WHERE owner_id=NEW.owner_id AND entity_type=NEW.entity_type AND parameter_id=NEW.parameter_id)
    AND NOT EXISTS(SELECT 1 FROM entity_parameter_options WHERE owner_id=NEW.owner_id AND entity_type=NEW.entity_type AND parameter_id=NEW.parameter_id AND value=NEW.value_text) THEN
  RAISE EXCEPTION 'invalid parameter option' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER parameter_option_valid BEFORE INSERT OR UPDATE ON entity_parameter_values FOR EACH ROW EXECUTE FUNCTION validate_parameter_option();
-- Empty constructor identities do not imply any invented task facts.
INSERT INTO entities(owner_id,entity_type,id) SELECT owner_id,'task',id FROM work_items;
CREATE TABLE entity_attribute_imports (
 owner_id uuid NOT NULL, entity_type text NOT NULL CHECK(entity_type='task'), entity_id uuid NOT NULL,
 source_artifact_id uuid NOT NULL, source_version_id uuid NOT NULL, imported_codes text[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,entity_type,entity_id),
 FOREIGN KEY(owner_id,entity_type,entity_id) REFERENCES entities(owner_id,entity_type,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,source_artifact_id,source_version_id) REFERENCES artifact_versions(owner_id,artifact_id,id) DEFERRABLE INITIALLY DEFERRED
);
