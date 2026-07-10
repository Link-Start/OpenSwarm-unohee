import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const VERIFY_MANIFEST_PATH = join('.openswarm', 'verify.yaml');

export const VerifyCommandSchema = z.object({
  name: z.string().min(1, 'Command name is required'),
  run: z.string().min(1, 'Command is required').regex(/^[^\r\n]+$/, 'Command must be a single line'),
  kind: z.enum(['typecheck', 'test', 'lint', 'build']),
  timeoutMs: z.number().int().positive().max(900_000).default(300_000),
  cwd: z.string().min(1).refine(
    (value) => !/^(?:[A-Za-z]:)?[\\/]/.test(value) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value),
    'cwd must stay within the repository',
  ).optional(),
}).strict();

export const VerifyManifestSchema = z.object({
  version: z.literal(1),
  commands: z.array(VerifyCommandSchema).min(1, 'At least one verify command is required'),
}).strict();

export type VerifyCommand = z.infer<typeof VerifyCommandSchema>;
export type VerifyManifest = z.infer<typeof VerifyManifestSchema>;

export interface VerifyManifestLoadResult {
  manifest: VerifyManifest | null;
  error?: string;
}

export async function loadVerifyManifest(projectPath: string): Promise<VerifyManifestLoadResult> {
  const manifestPath = join(projectPath, VERIFY_MANIFEST_PATH);
  let source: string;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { manifest: null };
    return { manifest: null, error: `Failed to read ${VERIFY_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    return { manifest: null, error: `Failed to parse ${VERIFY_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}` };
  }

  const result = VerifyManifestSchema.safeParse(parsed);
  if (!result.success) {
    const reason = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { manifest: null, error: `Invalid ${VERIFY_MANIFEST_PATH}: ${reason}` };
  }
  return { manifest: result.data };
}
