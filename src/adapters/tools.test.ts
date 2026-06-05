import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOL_DEFINITIONS, executeTool, ToolCall } from './tools.js';

// Check if rg binary is available (not just a shell function wrapper)
let hasRg = false;
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' });
  hasRg = true;
} catch { /* rg not installed as a binary */ }

// Shared temp directory for all tests
const TMP_DIR = '/tmp/openswarm-tools-test-' + process.pid;

/** Helper to build a ToolCall object */
function makeCall(name: string, args: Record<string, unknown>, id = 'tc-1'): ToolCall {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

// ──────────────────────────────────────────────
// Setup / Teardown
// ──────────────────────────────────────────────

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// 1. TOOL_DEFINITIONS
// ──────────────────────────────────────────────

describe('TOOL_DEFINITIONS', () => {
  const expectedNames = ['read_file', 'write_file', 'edit_file', 'search_files', 'bash'];

  it('exports exactly 5 tool definitions', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(5);
  });

  it.each(expectedNames)('includes "%s" tool', (name) => {
    const found = TOOL_DEFINITIONS.find(t => t.function.name === name);
    expect(found).toBeDefined();
    expect(found!.type).toBe('function');
    expect(found!.function.description).toBeTruthy();
    expect(found!.function.parameters).toBeDefined();
  });
});

// ──────────────────────────────────────────────
// 2. executeTool — per-tool tests
// ──────────────────────────────────────────────

describe('executeTool', () => {
  // ── read_file ──
  describe('read_file', () => {
    const filePath = path.join(TMP_DIR, 'read-target.txt');

    beforeAll(async () => {
      await fs.writeFile(filePath, 'alpha\nbeta\ngamma\ndelta\n', 'utf-8');
    });

    it('reads a file and returns numbered lines', async () => {
      const result = await executeTool(makeCall('read_file', { path: filePath }), TMP_DIR);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('1\talpha');
      expect(result.content).toContain('2\tbeta');
      expect(result.content).toContain('3\tgamma');
    });

    it('respects offset and limit', async () => {
      const result = await executeTool(
        makeCall('read_file', { path: filePath, offset: 1, limit: 2 }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      // offset=1 means start from line index 1 → "beta" is line 2
      expect(result.content).toContain('2\tbeta');
      expect(result.content).toContain('3\tgamma');
      expect(result.content).not.toContain('1\talpha');
    });
  });

  // ── write_file ──
  describe('write_file', () => {
    it('creates a file with given content', async () => {
      const filePath = path.join(TMP_DIR, 'write-target.txt');
      const result = await executeTool(
        makeCall('write_file', { path: filePath, content: 'hello world' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('Written');

      const written = await fs.readFile(filePath, 'utf-8');
      expect(written).toBe('hello world');
    });

    it('creates intermediate directories', async () => {
      const filePath = path.join(TMP_DIR, 'sub', 'deep', 'nested.txt');
      const result = await executeTool(
        makeCall('write_file', { path: filePath, content: 'nested' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);

      const written = await fs.readFile(filePath, 'utf-8');
      expect(written).toBe('nested');
    });
  });

  // ── edit_file ──
  describe('edit_file', () => {
    it('replaces a unique string in a file', async () => {
      const filePath = path.join(TMP_DIR, 'edit-target.txt');
      await fs.writeFile(filePath, 'foo bar baz', 'utf-8');

      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: 'bar', new_string: 'REPLACED' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('Edited');

      const updated = await fs.readFile(filePath, 'utf-8');
      expect(updated).toBe('foo REPLACED baz');
    });

    it('returns error when old_string is not found', async () => {
      const filePath = path.join(TMP_DIR, 'edit-notfound.txt');
      await fs.writeFile(filePath, 'hello world', 'utf-8');

      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: 'MISSING', new_string: 'x' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('returns error when old_string is not unique', async () => {
      const filePath = path.join(TMP_DIR, 'edit-duplicate.txt');
      await fs.writeFile(filePath, 'aaa bbb aaa', 'utf-8');

      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: 'aaa', new_string: 'x' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('2 times');
      expect(result.content).toContain('unique');
    });
  });

  // ── search_files ──
  // Requires `rg` (ripgrep) binary — skip if not installed
  describe.skipIf(!hasRg)('search_files', () => {
    beforeAll(async () => {
      const searchDir = path.join(TMP_DIR, 'search');
      await fs.mkdir(searchDir, { recursive: true });
      await fs.writeFile(path.join(searchDir, 'a.txt'), 'findme_marker line one\nline two\n');
      await fs.writeFile(path.join(searchDir, 'b.txt'), 'nothing here\n');
      await fs.writeFile(path.join(searchDir, 'c.ts'), 'findme_marker in ts\n');
    });

    it('finds matching lines across files', async () => {
      const searchDir = path.join(TMP_DIR, 'search');
      const result = await executeTool(
        makeCall('search_files', { pattern: 'findme_marker', path: searchDir }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('findme_marker');
      // Should match in both a.txt and c.ts
      expect(result.content).toContain('a.txt');
      expect(result.content).toContain('c.ts');
    });

    it('filters by glob pattern', async () => {
      const searchDir = path.join(TMP_DIR, 'search');
      const result = await executeTool(
        makeCall('search_files', { pattern: 'findme_marker', path: searchDir, glob: '*.ts' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('c.ts');
      expect(result.content).not.toContain('a.txt');
    });

    it('returns "(no matches)" when pattern not found', async () => {
      const searchDir = path.join(TMP_DIR, 'search');
      const result = await executeTool(
        makeCall('search_files', { pattern: 'NONEXISTENT_xyz_999', path: searchDir }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toBe('(no matches)');
    });
  });

  // ── bash ──
  describe('bash', () => {
    it('executes a simple command and returns stdout', async () => {
      const result = await executeTool(
        makeCall('bash', { command: 'echo hello' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content.trim()).toBe('hello');
    });

    it('blocks rm -rf', async () => {
      const result = await executeTool(
        makeCall('bash', { command: 'rm -rf /' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('BLOCKED');
    });
  });
});

// ──────────────────────────────────────────────
// 3. Safety guards — blocked commands via bash tool
// ──────────────────────────────────────────────

describe('Safety guards (isCommandBlocked via bash)', () => {
  const blockedCommands = [
    'rm -rf /foo',
    'git reset --hard',
    'chmod 777 somefile',
  ];

  it.each(blockedCommands)('blocks dangerous command: %s', async (cmd) => {
    const result = await executeTool(makeCall('bash', { command: cmd }), TMP_DIR);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('BLOCKED');
  });

  const allowedCommands = [
    'ls -la',
    'npm test',
  ];

  it.each(allowedCommands)('allows safe command: %s', async (cmd) => {
    const result = await executeTool(makeCall('bash', { command: cmd }), TMP_DIR);
    // Should not be blocked (may still fail for other reasons, but not BLOCKED)
    expect(result.content).not.toContain('BLOCKED');
  });
});

// ──────────────────────────────────────────────
// 4. Path validation
// ──────────────────────────────────────────────

describe('Path validation', () => {
  it('rejects paths outside cwd and /tmp', async () => {
    const result = await executeTool(
      makeCall('read_file', { path: '/etc/passwd' }),
      TMP_DIR,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Path outside project');
  });

  it('allows paths under /tmp', async () => {
    const filePath = path.join(TMP_DIR, 'allowed.txt');
    await fs.writeFile(filePath, 'ok', 'utf-8');

    const result = await executeTool(
      makeCall('read_file', { path: filePath }),
      // Use a different cwd to prove /tmp is allowed regardless
      '/Users/unohee/dev/OpenSwarm',
    );
    expect(result.is_error).toBe(false);
    expect(result.content).toContain('ok');
  });
});
