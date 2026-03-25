// 7 realistic test scenarios as Anthropic Messages API payloads
// Each has max_tokens:10 + system "Respond with OK." to minimize output cost
// All tool_results have proper tool_use -> tool_result pairing

const MODEL = 'anthropic/claude-sonnet-4.6'

function makeBody(messages) {
  return { model: MODEL, max_tokens: 10, system: 'Respond with OK.', messages }
}

function toolResult(tool_use_id, content, opts = {}) {
  return { type: 'tool_result', tool_use_id, content, ...opts }
}

function toolUse(id, name = 'Read', input = { path: '/tmp/file' }) {
  return { type: 'tool_use', id, name, input }
}

// Helper: wraps content in a proper user -> assistant(tool_use) -> user(tool_result) flow
function toolFlow(id, content, opts = {}) {
  return [
    { role: 'user', content: 'Read the file' },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, toolUse(id)] },
    { role: 'user', content: [toolResult(id, content, opts)] },
  ]
}

// 1. Small JSON — a package.json tool_result (~500 chars)
const smallJson = {
  id: 'small-json',
  name: 'Small JSON (package.json)',
  description: 'Pretty-printed package.json returned by Read tool',
  contentType: 'json',
  expectedCompression: '15-25%',
  body: makeBody(toolFlow('tu_pkg', JSON.stringify({
    name: '@example/my-app',
    version: '2.4.1',
    description: 'A full-stack web application with real-time features',
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      dev: 'vite dev',
      build: 'vite build',
      test: 'vitest run',
      lint: 'eslint src/',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^18.2.0',
      'react-dom': '^18.2.0',
      'react-router-dom': '^6.20.0',
    },
    devDependencies: {
      vite: '^5.0.0',
      vitest: '^1.0.0',
      eslint: '^8.55.0',
    },
  }, null, 2))),
}

// 2. Large JSON — deep nested dependency tree (~10KB)
function makeDeps(count) {
  const deps = []
  const names = ['express', 'lodash', 'axios', 'moment', 'chalk', 'commander', 'inquirer', 'ora',
    'glob', 'rimraf', 'mkdirp', 'semver', 'uuid', 'dotenv', 'cors', 'helmet', 'morgan',
    'winston', 'debug', 'yargs', 'minimist', 'fast-glob', 'chokidar', 'ws', 'socket.io']
  for (let i = 0; i < count; i++) {
    deps.push({
      name: names[i % names.length] + (i >= names.length ? `-v${Math.floor(i / names.length)}` : ''),
      version: `${Math.floor(Math.random() * 5) + 1}.${Math.floor(Math.random() * 20)}.${Math.floor(Math.random() * 10)}`,
      resolved: `https://registry.npmjs.org/${names[i % names.length]}/-/${names[i % names.length]}-${i}.0.0.tgz`,
      integrity: `sha512-${Buffer.from(String(i * 7919)).toString('base64')}==`,
      requires: i > 2 ? { [names[(i - 1) % names.length]]: `^${Math.floor(Math.random() * 3) + 1}.0.0` } : {},
      dev: i % 3 === 0,
    })
  }
  return deps
}

const largeJson = {
  id: 'large-json',
  name: 'Large JSON (dependency tree)',
  description: 'Deep nested npm dependency tree with resolved URLs and integrity hashes',
  contentType: 'json',
  expectedCompression: '20-35%',
  body: makeBody(toolFlow('tu_deps', JSON.stringify({
    name: 'my-project',
    version: '1.0.0',
    lockfileVersion: 3,
    dependencies: Object.fromEntries(makeDeps(60).map(d => [d.name, d])),
  }, null, 2))),
}

// 3. Tabular data — array of 50 file entries (~5KB)
function makeFileEntries(count) {
  const types = ['file', 'directory', 'symlink']
  const exts = ['.js', '.ts', '.json', '.md', '.css', '.html', '.yaml', '.toml']
  const entries = []
  for (let i = 0; i < count; i++) {
    entries.push({
      name: `item-${String(i).padStart(3, '0')}${exts[i % exts.length]}`,
      type: types[i % 3],
      size: Math.floor(Math.random() * 50000) + 100,
      modified: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T10:30:00Z`,
      permissions: i % 3 === 0 ? 'rwxr-xr-x' : 'rw-r--r--',
    })
  }
  return entries
}

const tabularData = {
  id: 'tabular-data',
  name: 'Tabular Data (file listing)',
  description: 'Array of 50 file entries — homogeneous objects ideal for TOON encoding',
  contentType: 'json-array',
  expectedCompression: '40-60%',
  body: makeBody(toolFlow('tu_files', JSON.stringify(makeFileEntries(50), null, 2))),
}

// 4. Source code — TypeScript file as plain text (~3KB)
const sourceCode = {
  id: 'source-code',
  name: 'Source Code (TypeScript)',
  description: 'Plain TypeScript source — text content, may benefit from whitespace normalization or LLMLingua',
  contentType: 'text',
  expectedCompression: '0-50%',
  body: makeBody(toolFlow('tu_src', `import { useState, useEffect, useCallback } from 'react';
import type { User, ApiResponse, PaginationParams } from '../types';

interface UseUsersOptions {
  pageSize?: number;
  sortBy?: keyof User;
  sortOrder?: 'asc' | 'desc';
}

export function useUsers(options: UseUsersOptions = {}) {
  const { pageSize = 20, sortBy = 'createdAt', sortOrder = 'desc' } = options;
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchUsers = useCallback(async (params: PaginationParams) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        page: String(params.page),
        limit: String(params.limit),
        sort: \`\${sortBy}:\${sortOrder}\`,
      });
      const response = await fetch(\`/api/users?\${query}\`);
      if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
      const data: ApiResponse<User[]> = await response.json();
      setUsers(prev => params.page === 1 ? data.data : [...prev, ...data.data]);
      setHasMore(data.data.length === params.limit);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [sortBy, sortOrder]);

  useEffect(() => {
    fetchUsers({ page, limit: pageSize });
  }, [page, pageSize, fetchUsers]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) setPage(p => p + 1);
  }, [loading, hasMore]);

  const refresh = useCallback(() => {
    setPage(1);
    setUsers([]);
    fetchUsers({ page: 1, limit: pageSize });
  }, [pageSize, fetchUsers]);

  const deleteUser = useCallback(async (id: string) => {
    const response = await fetch(\`/api/users/\${id}\`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Delete failed');
    setUsers(prev => prev.filter(u => u.id !== id));
  }, []);

  const updateUser = useCallback(async (id: string, updates: Partial<User>) => {
    const response = await fetch(\`/api/users/\${id}\`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error('Update failed');
    const data: ApiResponse<User> = await response.json();
    setUsers(prev => prev.map(u => u.id === id ? data.data : u));
    return data.data;
  }, []);

  return { users, loading, error, hasMore, loadMore, refresh, deleteUser, updateUser };
}

export function formatUserName(user: User): string {
  return user.displayName || \`\${user.firstName} \${user.lastName}\`.trim() || user.email;
}

export function getUserInitials(user: User): string {
  const name = formatUserName(user);
  return name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2);
}

export function isUserActive(user: User): boolean {
  if (!user.lastActiveAt) return false;
  const threshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return new Date(user.lastActiveAt).getTime() > threshold;
}
`)),
}

// 5. Multi-turn — 5-turn conversation with tool_results (~8KB)
const multiTurn = {
  id: 'multi-turn',
  name: 'Multi-turn Conversation',
  description: '5-turn conversation mixing text and tool_results — all messages compressed',
  contentType: 'mixed',
  expectedCompression: 'mixed',
  body: makeBody([
    { role: 'user', content: 'Read the config file' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Reading the config file.' },
      toolUse('tu_m1'),
    ]},
    { role: 'user', content: [
      toolResult('tu_m1', JSON.stringify({
        database: { host: 'localhost', port: 5432, name: 'myapp_dev', pool: { min: 2, max: 10 } },
        redis: { host: 'localhost', port: 6379, db: 0 },
        server: { port: 3000, cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] } },
      }, null, 2)),
    ]},
    { role: 'assistant', content: [
      { type: 'text', text: 'I see the config. Let me also check the environment file.' },
      toolUse('tu_m2'),
    ]},
    { role: 'user', content: [
      toolResult('tu_m2', JSON.stringify({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/myapp_dev',
        REDIS_URL: 'redis://localhost:6379/0',
        JWT_SECRET: 'dev-secret-key-change-in-production',
        API_KEY: 'sk-dev-1234567890',
        SMTP_HOST: 'smtp.mailtrap.io',
        SMTP_PORT: '2525',
      }, null, 2)),
    ]},
    { role: 'assistant', content: [
      { type: 'text', text: 'Now let me check the routes file.' },
      toolUse('tu_m3'),
    ]},
    { role: 'user', content: [
      toolResult('tu_m3', JSON.stringify({
        routes: [
          { method: 'GET', path: '/api/users', handler: 'UserController.list', middleware: ['auth'] },
          { method: 'POST', path: '/api/users', handler: 'UserController.create', middleware: ['auth', 'admin'] },
          { method: 'GET', path: '/api/users/:id', handler: 'UserController.show', middleware: ['auth'] },
          { method: 'PUT', path: '/api/users/:id', handler: 'UserController.update', middleware: ['auth'] },
          { method: 'DELETE', path: '/api/users/:id', handler: 'UserController.delete', middleware: ['auth', 'admin'] },
          { method: 'POST', path: '/api/auth/login', handler: 'AuthController.login', middleware: [] },
          { method: 'POST', path: '/api/auth/register', handler: 'AuthController.register', middleware: [] },
          { method: 'POST', path: '/api/auth/refresh', handler: 'AuthController.refresh', middleware: ['auth'] },
          { method: 'GET', path: '/api/health', handler: 'HealthController.check', middleware: [] },
          { method: 'GET', path: '/api/metrics', handler: 'MetricsController.summary', middleware: ['auth', 'admin'] },
        ],
      }, null, 2)),
    ]},
  ]),
}

// 6. Line-numbered — Read tool output with line number prefixes (~2KB)
const lineNumbered = {
  id: 'line-numbered',
  name: 'Line-Numbered Output',
  description: 'Read tool output with line number prefixes — strip + minify',
  contentType: 'json-lined',
  expectedCompression: '15-30%',
  body: makeBody(toolFlow('tu_ln', [
    '  1\t{\n',
    '  2\t  "compilerOptions": {\n',
    '  3\t    "target": "ES2022",\n',
    '  4\t    "module": "ESNext",\n',
    '  5\t    "moduleResolution": "bundler",\n',
    '  6\t    "strict": true,\n',
    '  7\t    "esModuleInterop": true,\n',
    '  8\t    "skipLibCheck": true,\n',
    '  9\t    "forceConsistentCasingInFileNames": true,\n',
    ' 10\t    "resolveJsonModule": true,\n',
    ' 11\t    "declaration": true,\n',
    ' 12\t    "declarationMap": true,\n',
    ' 13\t    "sourceMap": true,\n',
    ' 14\t    "outDir": "./dist",\n',
    ' 15\t    "rootDir": "./src",\n',
    ' 16\t    "baseUrl": ".",\n',
    ' 17\t    "paths": {\n',
    ' 18\t      "@/*": ["./src/*"],\n',
    ' 19\t      "@components/*": ["./src/components/*"],\n',
    ' 20\t      "@utils/*": ["./src/utils/*"],\n',
    ' 21\t      "@types/*": ["./src/types/*"]\n',
    ' 22\t    },\n',
    ' 23\t    "lib": ["ES2022", "DOM", "DOM.Iterable"],\n',
    ' 24\t    "jsx": "react-jsx",\n',
    ' 25\t    "incremental": true,\n',
    ' 26\t    "tsBuildInfoFile": "./dist/.tsbuildinfo"\n',
    ' 27\t  },\n',
    ' 28\t  "include": ["src/**/*.ts", "src/**/*.tsx"],\n',
    ' 29\t  "exclude": ["node_modules", "dist", "**/*.test.ts"]\n',
    ' 30\t}\n',
  ].join(''))),
}

// 7. Error result — is_error: true tool_result (~300 chars)
const errorResult = {
  id: 'error-result',
  name: 'Error Result',
  description: 'is_error: true tool_result — should be skipped entirely',
  contentType: 'error',
  expectedCompression: '0%',
  body: makeBody(toolFlow('tu_err', JSON.stringify({
    error: 'ENOENT: no such file or directory',
    code: 'ENOENT',
    syscall: 'open',
    path: '/app/src/missing-module.ts',
    message: 'Could not read file: no such file or directory, open \'/app/src/missing-module.ts\'',
  }, null, 2), { is_error: true })),
}

// 8. Line-numbered source code (non-JSON text) — tests strip-lines on text content
const lineNumberedSource = {
  id: 'line-numbered-source',
  name: 'Line-Numbered Source Code',
  description: 'Read tool output with line number prefixes containing TypeScript (not JSON) — tests strip-lines stage on text',
  contentType: 'text',
  expectedCompression: '10-20%',
  body: makeBody(toolFlow('tu_lns', [
    '  1→import express from \'express\';\n',
    '  2→import cors from \'cors\';\n',
    '  3→import helmet from \'helmet\';\n',
    '  4→\n',
    '  5→const app = express();\n',
    '  6→\n',
    '  7→// Middleware\n',
    '  8→app.use(cors({ origin: \'*\' }));\n',
    '  9→app.use(helmet());\n',
    ' 10→app.use(express.json());\n',
    ' 11→\n',
    ' 12→// Routes\n',
    ' 13→app.get(\'/api/health\', (req, res) => {\n',
    ' 14→  res.json({ status: \'ok\', uptime: process.uptime() });\n',
    ' 15→});\n',
    ' 16→\n',
    ' 17→app.get(\'/api/users\', async (req, res) => {\n',
    ' 18→  const { page = 1, limit = 20 } = req.query;\n',
    ' 19→  const users = await db.users.findMany({\n',
    ' 20→    skip: (page - 1) * limit,\n',
    ' 21→    take: Number(limit),\n',
    ' 22→    orderBy: { createdAt: \'desc\' },\n',
    ' 23→  });\n',
    ' 24→  res.json({ data: users, page: Number(page) });\n',
    ' 25→});\n',
    ' 26→\n',
    ' 27→app.post(\'/api/users\', async (req, res) => {\n',
    ' 28→  const { name, email, role } = req.body;\n',
    ' 29→  const user = await db.users.create({ data: { name, email, role } });\n',
    ' 30→  res.status(201).json({ data: user });\n',
    ' 31→});\n',
    ' 32→\n',
    ' 33→app.listen(3000, () => {\n',
    ' 34→  console.log(\'Server running on port 3000\');\n',
    ' 35→});\n',
  ].join(''))),
}

// 9. Whitespace-heavy CLI output — tests whitespace normalization
const whitespaceHeavy = {
  id: 'whitespace-heavy',
  name: 'Whitespace-Heavy CLI Output',
  description: 'Command output with excessive blank lines and trailing spaces — tests whitespace normalization stage',
  contentType: 'text',
  expectedCompression: '10-15%',
  body: makeBody(toolFlow('tu_ws', [
    'Running tests...   \n',
    '\n',
    '\n',
    '\n',
    '  PASS  src/utils/format.test.ts    \n',
    '    ✓ formats currency correctly (3ms)   \n',
    '    ✓ handles negative values    \n',
    '    ✓ respects locale settings   \n',
    '\n',
    '\n',
    '\n',
    '  PASS  src/utils/validate.test.ts    \n',
    '    ✓ validates email format (1ms)    \n',
    '    ✓ rejects invalid emails    \n',
    '    ✓ validates phone numbers    \n',
    '    ✓ handles edge cases    \n',
    '\n',
    '\n',
    '\n',
    '  PASS  src/components/UserList.test.tsx    \n',
    '    ✓ renders user list (12ms)   \n',
    '    ✓ handles empty state    \n',
    '    ✓ pagination works    \n',
    '    ✓ search filters correctly (5ms)    \n',
    '    ✓ sort toggles direction    \n',
    '\n',
    '\n',
    '\n',
    'Test Suites: 3 passed, 3 total    \n',
    'Tests:       12 passed, 12 total    \n',
    'Snapshots:   0 total    \n',
    'Time:        2.847s    \n',
    '\n',
    '\n',
    '\n',
  ].join(''))),
}

// 10. All-message multi-turn — tests compression of historical messages
const allMessageMultiTurn = {
  id: 'all-message-multi-turn',
  name: 'All-Message Multi-turn (10 turns)',
  description: '10-turn conversation with tool_results in every turn — tests all-message compression benefit',
  contentType: 'mixed',
  expectedCompression: '25-40%',
  body: (() => {
    const messages = []
    for (let i = 0; i < 10; i++) {
      const id = `tu_am${i}`
      messages.push({ role: 'user', content: `Read file ${i}` })
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `Reading file ${i}.` }, toolUse(id)] })
      messages.push({ role: 'user', content: [toolResult(id, JSON.stringify({
        filename: `src/module-${i}.ts`,
        lines: 50 + i * 10,
        imports: [`../utils/helper-${i}`, `../types/model-${i}`, `../config/settings`],
        exports: [`function process${i}()`, `interface Config${i}`, `const DEFAULT_${i}`],
        dependencies: { lodash: '^4.17.21', zod: '^3.22.0', prisma: '^5.7.0' },
      }, null, 2))] })
    }
    return makeBody(messages)
  })(),
}

export const scenarios = [smallJson, largeJson, tabularData, sourceCode, multiTurn, lineNumbered, errorResult, lineNumberedSource, whitespaceHeavy, allMessageMultiTurn]
