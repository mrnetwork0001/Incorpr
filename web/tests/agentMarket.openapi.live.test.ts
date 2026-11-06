// Live: fetches https://market.near.ai/openapi.json (public, read-only) and checks every zod schema
// in src/lib/agentMarket.ts against it: each property the document requires is required here, and
// every property read here exists in the document. Also checks that the paths the client calls exist.

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AgentPublicSummary,
  fetchPublicAgent,
  AssignmentStatus,
  AttachmentBrief,
  JobAssignment,
  LatestMessageBrief,
  ListMessagesResponse,
  MyAssignmentItem,
  MyAssignmentsResponse,
  StartAssignmentResponse,
  ThreadMessage,
  WorkerJobBrief,
  WorkerProgressReport,
} from '@/lib/agentMarket';

interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, unknown>;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  enum?: string[];
}

interface OpenApi {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, SchemaObject> };
}

const doc: OpenApi = await fetch('https://market.near.ai/openapi.json', { signal: AbortSignal.timeout(30_000) }).then((r) => r.json());

function resolve(schema: SchemaObject): SchemaObject {
  if (schema.$ref) return resolve(doc.components.schemas[schema.$ref.split('/').pop()!]!);
  if (schema.allOf) {
    const parts = schema.allOf.map(resolve);
    return {
      required: parts.flatMap((p) => p.required ?? []),
      properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})),
    };
  }
  return schema;
}

function compare(name: string, zod: z.ZodObject) {
  const spec = resolve({ $ref: `#/components/schemas/${name}` });
  const shape = zod.shape as Record<string, z.ZodType>;
  const optional = (key: string) => shape[key]!.safeParse(undefined).success;
  for (const key of spec.required ?? []) {
    expect(shape, `${name}.${key} is required by openapi.json`).toHaveProperty(key);
    expect(optional(key), `${name}.${key} must not be optional`).toBe(false);
  }
  for (const key of Object.keys(shape)) {
    expect(Object.keys(spec.properties ?? {}), `${name}.${key} is not in openapi.json`).toContain(key);
    if (!(spec.required ?? []).includes(key)) expect(optional(key), `${name}.${key} is optional in openapi.json`).toBe(true);
  }
}

describe('Agent Market openapi.json, live', () => {
  it('schemas match', () => {
    compare('MyAssignmentsResponse', MyAssignmentsResponse);
    compare('MyAssignmentItem', MyAssignmentItem);
    compare('JobAssignment', JobAssignment);
    compare('WorkerJobBrief', WorkerJobBrief);
    compare('LatestMessageBrief', LatestMessageBrief);
    compare('AttachmentBrief', AttachmentBrief);
    compare('StartAssignmentResponse', StartAssignmentResponse);
    compare('WorkerProgressReport', WorkerProgressReport);
    compare('ListMessagesResponse', ListMessagesResponse);
    compare('ThreadMessage', ThreadMessage);
  });

  it('the public agent view has the fields the status route reads', () => {
    const spec = resolve({ $ref: '#/components/schemas/AgentPublic' });
    for (const key of Object.keys(AgentPublicSummary.shape)) expect(Object.keys(spec.properties ?? {})).toContain(key);
  });

  it('parses a real public listing with the status route\'s reader', async () => {
    const list = (await fetch('https://market.near.ai/v1/agents?limit=1', { signal: AbortSignal.timeout(30_000) }).then((r) => r.json())) as {
      agents: { handle: string }[];
    };
    const handle = list.agents[0]!.handle;
    const agent = await fetchPublicAgent(handle);
    expect(agent?.handle).toBe(handle);
    expect(typeof agent?.delivered_jobs).toBe('number');
    expect(await fetchPublicAgent('no-such-agent-incorpr-test')).toBeNull();
  });

  it('assignment statuses are the documented enum', () => {
    expect([...AssignmentStatus.options].sort()).toEqual([...(doc.components.schemas.AssignmentStatus!.enum ?? [])].sort());
  });

  it('every endpoint the client calls exists with its method', () => {
    const calls: [string, string][] = [
      ['get', '/v1/agents/me/assignments'],
      ['post', '/v1/assignments/{id}/start'],
      ['post', '/v1/assignments/{id}/progress'],
      ['get', '/v1/assignments/{id}/messages'],
      ['post', '/v1/assignments/{id}/messages'],
      ['post', '/v1/assignments/{id}/submit'],
      ['get', '/v1/assignments/{id}/deliverable/raw'],
      ['get', '/v1/jobs/{job_id}/attachments/{attachment_id}/raw'],
      ['get', '/v1/agents/{id_or_handle}'],
    ];
    for (const [method, path] of calls) expect(doc.paths[path], path).toHaveProperty(method);
    const submit = resolve({ $ref: '#/components/schemas/SubmitRequest' });
    expect(submit.required).toEqual(['deliverableMarkdown']);
    expect(Object.keys(submit.properties ?? {}).sort()).toEqual(['deliverableMarkdown', 'files']);
    const progress = resolve({ $ref: '#/components/schemas/ReportProgressRequest' });
    expect(progress.required).toEqual(['message']);
  });
});
