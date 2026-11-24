import { z } from 'zod';
import { AgentError } from '../protocol/errors';
import { httpRequestSchema } from '../http/client';

const text = z.string();
const id = text.min(1);
const timeoutMs = z.number().int().min(1).max(60000).optional();
const navigation = z
  .strictObject({ waitUntil: z.enum(['domcontentloaded', 'load']).optional(), timeoutMs })
  .optional();
const contracts: Record<string, z.ZodType> = {
  'runtime.sleep': z.tuple([z.number().min(0).max(60000)]),
  'http.request': httpRequestSchema,
  'fs.list': z.tuple([text.optional()]),
  'fs.read': z.tuple([
    id,
    z
      .strictObject({
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(64000).optional(),
      })
      .optional(),
  ]),
  'fs.write': z.tuple([id, text, id.optional()]),
  'fs.edit': z.tuple([id, text.min(1), text, id]),
  'fs.remove': z.tuple([id, id]),
  'fs.rename': z.tuple([id, id, id]),
  'fs.search': z.tuple([text, text.optional()]),
  'browser.connect': z.tuple([]),
  'browser.disconnect': z.tuple([]),
  'browser.evaluate': z.tuple([
    text,
    z.strictObject({ contextId: z.number().int().optional(), sessionId: id.optional() }).optional(),
  ]),
  // Validate only the transport envelope. CDP parameter fields belong to the browser.
  'browser.send': z.tuple([id, z.record(text, z.unknown()).optional(), id.optional()]),
  'browser.contexts': z.tuple([]),
  'browser.events': z.tuple([
    z
      .strictObject({
        after: z.number().int().min(0).optional(),
        methods: z.array(id).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        tail: z.boolean().optional(),
      })
      .optional(),
  ]),
  'browser.waitForEvent': z.tuple([
    id,
    z.strictObject({ timeoutMs, sessionId: id.optional() }).optional(),
  ]),
  'browser.reload': z.tuple([navigation]),
  'browser.navigate': z.tuple([id, navigation]),
  'browser.screenshot': z.tuple([
    z.strictObject({ format: z.enum(['png', 'jpeg']).optional() }).optional(),
  ]),
  'browser.responseBody': z.tuple([id, id.optional()]),
  'browser.verify': z.tuple([id, text.min(1)]),
  'scripts.list': z.tuple([]),
  'scripts.import': z.tuple([id, id]),
  'scripts.apply': z.tuple([id]),
  'scripts.status': z.tuple([id]),
  'scripts.setEnabled': z.tuple([id, z.boolean()]),
};

export function validateHostCall(method: string, args: unknown[]) {
  const contract = Object.hasOwn(contracts, method) ? contracts[method] : undefined;
  if (!contract) throw new AgentError('unknown_host_method', `Unknown host method: ${method}.`);
  const result = contract.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 4)
      .map(
        (issue) =>
          `args${issue.path.map((key) => `[${JSON.stringify(key)}]`).join('')}: ${issue.message}`,
      )
      .join('; ');
    throw new AgentError(
      'invalid_input',
      `${method}: ${issues}. See /docs/agent-guide.md for the API documentation index.`,
    );
  }
}
