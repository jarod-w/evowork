import type { SqliteLike } from './migrate.js';
import { normalizeLibraryText } from './library-query.js';

export interface LibraryBlock {
  readonly text: string;
  readonly location: string;
  readonly page?: number;
  readonly source: 'text' | 'textLayer' | 'ocr';
  readonly needsReview?: boolean;
}

/** This is disposable. Import/stop/exclusion decisions live in source manifests. */
export function createLibraryProjection(db: SqliteLike) {
  return {
    remove(id: string): void {
      db.prepare(
        'DELETE FROM library_index WHERE rowid IN (SELECT fts_rowid FROM library_chunk WHERE document_id=?)',
      ).run(id);
      db.prepare('DELETE FROM library_chunk WHERE document_id=?').run(id);
      db.prepare('DELETE FROM library_document WHERE id=?').run(id);
    },
    publish(input: {
      readonly id: string;
      readonly title: string;
      readonly hash: string;
      readonly state: string;
      readonly blocks: readonly LibraryBlock[];
    }): void {
      db.exec('SAVEPOINT library_publish');
      try {
        this.remove(input.id);
        db.prepare(
          'INSERT INTO library_document(id,source_hash,state,updated_at,title) VALUES(?,?,?,?,?)',
        ).run(input.id, input.hash, input.state, Date.now(), normalizeLibraryText(input.title));
        const chunks = input.blocks.length
          ? input.blocks
          : [{ text: '', location: '文件', source: 'text' as const }];
        let sequence = 0;
        for (const block of chunks) {
          // Overlap stays inside one source block/page. Never synthesize a cross-page phrase.
          const characters = Array.from(block.text);
          for (let offset = 0; offset < Math.max(1, characters.length); offset += 1800) {
            const text = characters.slice(offset, offset + 2000).join('');
            const meta = JSON.stringify({ ...block, text, offset, hash: input.hash });
            const chunk = db
              .prepare('INSERT INTO library_chunk(document_id,sequence,meta) VALUES(?,?,?)')
              .run(input.id, sequence++, meta) as { lastInsertRowid: number | bigint };
            const fts = db
              .prepare('INSERT INTO library_index(node_id,title,body,meta) VALUES(?,?,?,?)')
              .run(
                input.id,
                normalizeLibraryText(input.title),
                normalizeLibraryText(text),
                meta,
              ) as { lastInsertRowid: number | bigint };
            db.prepare('UPDATE library_chunk SET fts_rowid=? WHERE id=?').run(
              fts.lastInsertRowid,
              chunk.lastInsertRowid,
            );
          }
        }
        db.exec('RELEASE library_publish');
      } catch (error) {
        db.exec('ROLLBACK TO library_publish; RELEASE library_publish');
        throw error;
      }
    },
  };
}
