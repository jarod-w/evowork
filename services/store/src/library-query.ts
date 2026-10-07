/** O0 query contract. Dedicated read-only process makes native SQLite cancellation enforceable. */
import { spawn } from 'node:child_process';

export interface LibraryQueryInput {
  readonly query: string;
  /** Host-resolved visible/current document identities, never an SQL fragment or renderer path. */
  readonly documentIds: readonly string[];
  readonly offset?: number;
  readonly signal?: AbortSignal;
  readonly details?: boolean;
}
export interface LibraryQueryHit {
  readonly documentId: string;
  readonly title: string;
  readonly snippets?: readonly {
    readonly text: string;
    readonly location: string;
    readonly page?: number;
    readonly source: string;
    readonly needsReview: boolean;
    readonly highlights: readonly { readonly start: number; readonly end: number }[];
  }[];
}

export function normalizeLibraryText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}
export function libraryTerms(query: string): readonly string[] {
  if (Array.from(query).length > 200) throw new Error('LIBRARY_QUERY_TOO_LONG');
  return [...new Set(normalizeLibraryText(query).split(' ').filter(Boolean))];
}

// This is fixed application code. User values cross stdin JSON and bound SQL parameters only.
const READER = String.raw`
const { DatabaseSync } = require('node:sqlite');
let data = '', bytes = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 1024 * 1024) process.exit(2);
  data += chunk;
});
process.stdin.on('end', () => {
  let db;
  try {
    const input = JSON.parse(data);
    db = new DatabaseSync(input.path, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN');
    const visible = input.ids;
    if (!visible.length) { process.stdout.write('[]'); db.close(); return; }
    // One bound JSON value avoids compiling 10,000 VALUES rows for every search.
    const allowed = 'WITH allowed(node_id) AS (SELECT value FROM json_each(?)) ';
    const boundVisible = [JSON.stringify(visible)];
    const scope = 'node_id IN (SELECT node_id FROM allowed)';
    const projected = db.prepare(allowed + 'SELECT count(*) AS count FROM library_document WHERE id IN (SELECT node_id FROM allowed)').get(...boundVisible).count === visible.length;
    const long = input.terms.filter(t=>Array.from(t).length >= 3);
    // Keep FTS as the outer scan; the covering rowid lookup avoids loading its body/meta just for node_id.
    const matchFrom = projected ? 'library_index CROSS JOIN library_chunk c INDEXED BY ix_library_chunk_fts ON c.fts_rowid=library_index.rowid' : 'library_index';
    const matchId = projected ? 'c.document_id' : 'node_id';
    // Unary + preserves these TEXT ids while preventing SQLite from probing all visible ids per rowid.
    const matchScope = '+' + matchId + ' IN (SELECT node_id FROM allowed)';
    const clauses = [], whereValues = [];
    for (const term of input.terms) {
      if (Array.from(term).length >= 3) {
        // With one long term, the scored INNER JOIN already proves the match.
        if (long.length === 1) continue;
        clauses.push('node_id IN (SELECT ' + matchId + ' FROM ' + matchFrom + ' WHERE ' + matchScope + ' AND library_index MATCH ?)');
        whereValues.push('"' + term.replace(/"/g, '""') + '"');
      } else {
        // Search every source chunk of this document, including chunks without the long term.
        // EXISTS stops at the first match instead of collecting duplicate hits across the whole FTS table.
        clauses.push(projected
          ? 'EXISTS (SELECT 1 FROM library_chunk c JOIN library_index i ON i.rowid=c.fts_rowid WHERE c.document_id=documents.node_id AND (instr(i.title,?) > 0 OR instr(i.body,?) > 0))'
          : 'node_id IN (SELECT node_id FROM library_index WHERE ' + scope + ' AND (instr(title, ?) > 0 OR instr(body, ?) > 0))');
        whereValues.push(term, term);
      }
    }
    const where = [scope, ...clauses].join(' AND ');
    const rankQuery = long.map(t=>'"' + t.replace(/"/g,'""') + '"').join(' OR ');
    const scored = long.length ? ', score_rows AS MATERIALIZED (SELECT ' + matchId + ' AS node_id, rank AS score FROM ' + matchFrom + ' WHERE ' + matchScope + ' AND library_index MATCH ?), scored AS (SELECT node_id,min(score) AS score FROM score_rows GROUP BY node_id) ' : '';
    const titleMatch = input.terms.length ? input.terms.map(()=> 'instr(' + (projected ? 'documents.title' : 'library_index.title') + ',?) > 0').join(' OR ') : '0';
    const prefix = allowed.trimEnd() + (projected ? ', documents AS (SELECT id AS node_id,title,updated_at FROM library_document)' : '') + scored;
    const query = prefix + ' SELECT node_id AS documentId,min(' + (projected ? 'documents.title' : 'library_index.title') + ') AS title,max(' + titleMatch + ') AS titleHit FROM ' + (projected ? 'documents ' : 'library_index ') + (long.length ? 'JOIN scored USING(node_id) ' : '') + (projected ? '' : 'LEFT JOIN library_document d ON d.id=node_id ') + 'WHERE ' + where + ' GROUP BY node_id ORDER BY titleHit DESC,' + (long.length ? ' min(scored.score) ASC,' : '') + ' max(' + (projected ? 'documents.updated_at' : 'd.updated_at') + ') DESC,node_id LIMIT 20 OFFSET ?';
    const values = [...boundVisible,...(long.length ? [rankQuery] : []),...input.terms,...whereValues,input.offset];
    const hits = db.prepare(query).all(...values);
    if (input.details) for (const hit of hits) {
      hit.snippets = [];
      // Only bounded text snippets leave this process; raw full body never reaches renderer.
      let chunks = db.prepare('SELECT meta FROM library_chunk WHERE document_id=? ORDER BY sequence').all(hit.documentId);
      if (!chunks.length) chunks = db.prepare('SELECT meta FROM library_index WHERE node_id=? ORDER BY rowid').iterate(hit.documentId);
      const locations = new Set();
      for (const chunk of chunks) {
        let meta; try { meta = JSON.parse(chunk.meta); } catch { continue; }
        if (typeof meta.text !== 'string' || typeof meta.location !== 'string') continue;
        const chars = Array.from(meta.text), normalized = [], starts = [], ends = [];
        let position = 0;
        for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(meta.text)) {
          const width = Array.from(segment.segment).length;
          for (let char of Array.from(segment.segment.normalize('NFKC').toLowerCase())) {
            if (/\s/u.test(char)) char = ' ';
            if (char === ' ' && normalized[normalized.length - 1] === ' ') { ends[ends.length - 1] = position + width; continue; }
            normalized.push(char); starts.push(position); ends.push(position + width);
          }
          position += width;
        }
        const norm = normalized.join('');
        const ranges = [];
        for (const term of input.terms) {
          let cursor = 0;
          for (let count = 0; count < 10; count++) {
            const index = norm.indexOf(term, cursor); if (index < 0) break;
            const start = Array.from(norm.slice(0,index)).length, length = Array.from(term).length;
            ranges.push({ start: starts[start], end: ends[start+length-1] }); cursor = index + term.length;
          }
        }
        if (!ranges.length || locations.has(meta.location)) continue;
        ranges.sort((a,b) => a.start - b.start);
        const left = Math.max(0,ranges[0].start-60), right = Math.min(chars.length,left+240);
        hit.snippets.push({ text: chars.slice(left,right).join(''), location: meta.location,
          ...(Number.isInteger(meta.page) ? { page: meta.page } : {}), source: meta.source,
          needsReview: meta.needsReview === true,
          highlights: ranges.filter(r=>r.start < right && r.end > left).map(r=>({start: Math.max(left,r.start)-left,end: Math.min(right,r.end)-left})) });
        locations.add(meta.location);
        if (hit.snippets.length === 3) break;
      }
    }
    process.stdout.write(JSON.stringify(hits));
    db.exec('ROLLBACK');
    db.close();
  } catch { if (db) { try { db.close(); } catch {} } process.exit(2); }
});
`;

export function createLibraryQueryRunner(options: {
  readonly databasePath: string;
  readonly timeoutMs?: number;
}) {
  return {
    search(input: LibraryQueryInput): Promise<readonly LibraryQueryHit[]> {
      const terms = libraryTerms(input.query);
      const offset = input.offset ?? 0;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        input.documentIds.length > 10_000 ||
        input.documentIds.some((id) => typeof id !== 'string' || id.length > 200)
      )
        throw new Error('LIBRARY_QUERY_SCOPE');
      if (input.signal?.aborted) return Promise.reject(new Error('LIBRARY_QUERY_CANCELLED'));
      const payload = JSON.stringify({
        path: options.databasePath,
        terms,
        details: input.details === true,
        ids: [...new Set(input.documentIds)],
        offset,
      });
      if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('LIBRARY_QUERY_SCOPE');
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=commonjs', '--eval', READER], {
          // Electron's bundled Node mode, same execution convention as the local gateway.
          env: { ELECTRON_RUN_AS_NODE: '1', LANG: 'en_US.UTF-8' },
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        const output: Buffer[] = [];
        let bytes = 0;
        let failure: string | undefined;
        const stop = (reason: string): void => {
          failure ??= reason;
          child.kill('SIGKILL');
        };
        const timer = setTimeout(() => stop('LIBRARY_QUERY_TIMEOUT'), options.timeoutMs ?? 2000);
        const abort = (): void => stop('LIBRARY_QUERY_CANCELLED');
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
        const cleanup = (): void => {
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', abort);
        };
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 256 * 1024) stop('LIBRARY_QUERY_OUTPUT_LIMIT');
          else output.push(chunk);
        });
        child.stdin.on('error', () => {
          /* exit/error determines the result */
        });
        child.on('error', () => {
          cleanup();
          reject(new Error(failure ?? 'LIBRARY_QUERY_FAILED'));
        });
        child.on('close', (code) => {
          cleanup();
          if (failure || code !== 0) {
            reject(new Error(failure ?? 'LIBRARY_QUERY_FAILED'));
            return;
          }
          try {
            const hits: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
            if (
              !Array.isArray(hits) ||
              hits.length > 20 ||
              hits.some(
                (hit: LibraryQueryHit) =>
                  typeof hit.documentId !== 'string' ||
                  !input.documentIds.includes(hit.documentId) ||
                  typeof hit.title !== 'string',
              )
            )
              throw new Error();
            resolve(hits as LibraryQueryHit[]);
          } catch {
            reject(new Error('LIBRARY_QUERY_FAILED'));
          }
        });
        child.stdin.end(payload);
      });
    },
  };
}
