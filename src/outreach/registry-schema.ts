import { z } from 'zod';

const text = z.string().trim().min(1).max(4000);
const id = z.uuid();
const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const version = z.number().int().positive();
const date = z.iso.datetime({ offset: true });
function hasNoUrlCredentials(value?: string|null): boolean {
  if (!value) return true;
  try { const parsed = new URL(value); return !(parsed.username || parsed.password); }
  catch { return false; }
}
export const sourceSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2048).optional(),
  material_id: z.string().trim().min(1).max(256).optional(),
  retrieved_at: date,
  claim: text,
  verification: text,
}).refine(value => Boolean(value.url) !== Boolean(value.material_id), 'Provide exactly one of url or material_id')
  .refine(value => hasNoUrlCredentials(value.url), 'URL credentials are not accepted');
export const sourcesSchema = z.array(sourceSchema).min(1).max(30);
export const opportunityStatuses = ['candidate', 'preparing', 'awaiting_approval', 'awaiting_reply', 'reply_received', 'negotiating', 'agreed', 'declined', 'deferred'] as const;
export const searchCompaniesSchema = z.strictObject({
  q: z.string().trim().max(300).optional(),
  status: z.enum(['needs_review', 'confirmed', ...opportunityStatuses]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: id.optional(),
});
export const getCompanySchema = z.strictObject({ id });
export const upsertCompanyCandidateSchema = z.strictObject({
  company_id: id.optional(), expected_version: version.optional(),
  name: z.string().trim().min(1).max(300),
  website: z.url({ protocol: /^https?$/ }).max(2048).nullable().optional(),
  inn: z.string().regex(/^(?:\d{10}|\d{12})$/).nullable().optional(),
  sector: z.string().trim().max(300).nullable().optional(),
  city: z.string().trim().max(300).nullable().optional(),
  sources: sourcesSchema, rationale: text, request_id: requestId,
}).refine(value => Boolean(value.company_id) === Boolean(value.expected_version), 'Updating a company requires company_id and expected_version together')
  .refine(value => hasNoUrlCredentials(value.website), 'URL credentials are not accepted');
export const saveContactSchema = z.strictObject({
  company_id: id, contact_id: id.optional(), expected_version: version.optional(),
  email: z.email().max(320), name: z.string().trim().max(300).nullable().optional(),
  position: z.string().trim().max(300).nullable().optional(),
  source: sourceSchema, verified_at: date, invalid: z.boolean().default(false), request_id: requestId,
}).refine(value => Boolean(value.contact_id) === Boolean(value.expected_version), 'Updating a contact requires contact_id and expected_version together');
export const createOpportunitySchema = z.strictObject({
  company_id: id, subject: z.string().trim().min(1).max(1000),
  sources: sourcesSchema, rationale: text, request_id: requestId,
});
export const getOperationSchema = z.strictObject({ request_id: requestId.optional(), operation_id: id.optional() })
  .refine(value => Boolean(value.request_id) !== Boolean(value.operation_id), 'Provide exactly one operation identifier');
export const resolveCandidateSchema = z.strictObject({
  candidate_id: id, expected_version: version, request_id: requestId, company_id: id.optional(),
});
export const setOpportunityStatusSchema = z.strictObject({
  opportunity_id: id, expected_version: version, request_id: requestId,
  status: z.enum(opportunityStatuses), next_step: text.nullable().optional(),
  next_step_at: date.nullable().optional(), deferred_reason: text.nullable().optional(),
  reason: text.optional(), agreement: text.optional(),
}).refine(value => value.status !== 'deferred' || Boolean(value.deferred_reason && value.next_step_at), 'Deferring requires a reason and return date')
  .refine(value => value.status !== 'agreed' || Boolean(value.agreement), 'Agreement content is required')
  .refine(value => value.status !== 'declined' || Boolean(value.reason), 'Declining requires a reason');

export const registrySchemas = {
  search_companies: searchCompaniesSchema, get_company: getCompanySchema,
  upsert_company_candidate: upsertCompanyCandidateSchema, save_contact: saveContactSchema,
  create_opportunity: createOpportunitySchema, get_operation: getOperationSchema,
};

export type SourceInput = z.infer<typeof sourceSchema>;
export type StoredSource = SourceInput & { id: string; actor_id: string };
