import type { CatalogMutationResult } from './ipc.js';

export interface SkillEvidenceView {
  readonly id: string;
  readonly itemId: string;
  readonly turnId: string;
  readonly threadId?: string;
  readonly role: 'user' | 'assistant' | 'execution';
  readonly text: string;
  readonly truncated: boolean;
}
export interface SkillSourceView {
  readonly threadId: string;
  readonly title: string;
  readonly capturedAt: number;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly turns: readonly { readonly id: string; readonly label: string }[];
  readonly evidence: readonly SkillEvidenceView[];
}
export interface PublishedSkillDraft {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly changes: readonly string[];
  readonly sources: readonly { readonly rule: string; readonly evidenceId: string }[];
  readonly files: readonly { readonly path: string; readonly content: string }[];
}
export interface SkillExtractionView {
  readonly id: string;
  readonly threadId: string;
  readonly source: SkillSourceView;
  readonly sourceDeleted: boolean;
  readonly focus: string;
  readonly revision: number;
  readonly scope: 'project' | 'global';
  readonly content: PublishedSkillDraft | null;
  readonly state: 'draft' | 'saved' | 'enable-failed';
  readonly error: string | null;
  readonly installed: {
    readonly revision: number;
    readonly scope: 'project' | 'global';
    readonly path: string;
    readonly slug: string;
  } | null;
}
export interface SkillExtractionSaveResult {
  readonly draft: SkillExtractionView;
  readonly needsConfirm?: boolean;
  readonly audit?: CatalogMutationResult['audit'];
  readonly error?: string;
}
export interface SkillExtractionActions {
  getSkillSource(input: { threadId: string }): Promise<SkillSourceView>;
  startSkillExtraction(input: {
    threadId: string;
    fromTurnId?: string;
    focus?: string;
    modelId?: string;
    newDraft?: boolean;
  }): Promise<SkillExtractionView>;
  getSkillExtraction(input: { threadId: string }): Promise<SkillExtractionView | null>;
  setSkillExtractionScope(input: {
    threadId: string;
    scope: 'project' | 'global';
    revision: number;
  }): Promise<SkillExtractionView>;
  saveSkillExtraction(input: {
    threadId: string;
    revision: number;
    acknowledge?: boolean;
    confirmName?: string;
  }): Promise<SkillExtractionSaveResult>;
  refreshSkillSource(input: { threadId: string }): Promise<SkillExtractionView>;
}
