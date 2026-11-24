import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { patchSkillInvocation } from '@evowork/catalog';

import type { CatalogPorts } from './catalog-host.js';

export const SKILL_PROVENANCE = '.evowork-install.json';

export function preserveSkillInvocation(
  ports: CatalogPorts,
  previous: string,
  next: string,
): boolean | undefined {
  const raw = ports.io.readText(join(previous, SKILL_PROVENANCE));
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  const preference =
    value && typeof value === 'object' && 'allowImplicitInvocation' in value
      ? value.allowImplicitInvocation
      : undefined;
  if (typeof preference !== 'boolean') return undefined;
  const path = join(next, 'agents', 'openai.yaml');
  const yaml = patchSkillInvocation(ports.io.readText(path), preference);
  ports.mkdirp(dirname(path));
  ports.writeText(path, yaml);
  return preference;
}

export function skillContentHash(root: string): string {
  const hash = createHash('sha256');
  let files = 0;
  let bytesRead = 0;
  const walk = (directory: string, depth = 0) => {
    if (depth > 32) throw new Error('技能目录层级不能超过 32。');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (entry.name === '.git' || entry.name === SKILL_PROVENANCE) continue;
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        hash.update(JSON.stringify([name, 'directory']));
        walk(path, depth + 1);
      } else {
        if (entry.isSymbolicLink()) throw new Error('技能资源不能包含符号链接。');
        const metadata = lstatSync(path);
        files += 1;
        bytesRead += metadata.size;
        if (files > 4096 || bytesRead > 64 * 1024 * 1024)
          throw new Error('技能包不能超过 4096 个文件或 64 MB。');
        hash.update(JSON.stringify([name, metadata.size, metadata.mode & 0o111]));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

export function skillDestinations(ports: CatalogPorts, id: string): readonly string[] {
  return [join(ports.userRoot, 'skills', id), join(ports.kernelHome, 'skills', id)];
}

export function replaceSkillDirectories(
  ports: CatalogPorts,
  destinations: readonly string[],
  prepare: (next: string) => void,
  extra: readonly { dest: string; prepare: (next: string) => void }[] = [],
): void {
  const stages = [...destinations, ...extra.map((stage) => stage.dest)].map((dest) => {
    const temporary = join(dirname(dest), `.skill-install-${randomUUID()}`);
    return {
      dest,
      temporary,
      next: join(temporary, 'next'),
      backup: join(temporary, 'previous'),
      backedUp: false,
      promoted: false,
      retain: false,
    };
  });
  try {
    for (const stage of stages) ports.mkdirp(stage.temporary);
    prepare(stages[0]!.next);
    for (const stage of stages.slice(1, destinations.length))
      ports.linkDir(stages[0]!.dest, stage.next);
    for (const [index, stage] of extra.entries())
      stage.prepare(stages[destinations.length + index]!.next);
    for (const stage of stages) {
      if (ports.exists(stage.dest)) {
        ports.renamePath(stage.dest, stage.backup);
        stage.backedUp = true;
      }
      ports.renamePath(stage.next, stage.dest);
      stage.promoted = true;
    }
  } catch (error) {
    const failures: string[] = [];
    for (const stage of [...stages].reverse()) {
      try {
        if (stage.promoted) ports.removePath(stage.dest);
        if (stage.backedUp) ports.renamePath(stage.backup, stage.dest);
      } catch {
        stage.retain = true;
        failures.push(stage.backup);
      }
    }
    if (failures.length) throw new Error(`替换失败，旧版本备份保留在 ${failures.join('；')}`);
    throw error;
  } finally {
    for (const stage of stages) {
      if (stage.retain) continue;
      try {
        ports.removePath(stage.temporary);
      } catch {
        /* Retain unscanned staging. */
      }
    }
  }
}

export function removeSkillDirectories(ports: CatalogPorts, destinations: readonly string[]): void {
  const moved: { dest: string; temporary: string }[] = [];
  try {
    for (const dest of [...destinations].reverse()) {
      if (!ports.exists(dest)) continue;
      const temporary = join(dirname(dest), `.skill-uninstall-${randomUUID()}`);
      ports.renamePath(dest, temporary);
      moved.push({ dest, temporary });
    }
  } catch (error) {
    const failures: string[] = [];
    for (const stage of moved.reverse()) {
      try {
        ports.renamePath(stage.temporary, stage.dest);
      } catch {
        failures.push(stage.temporary);
      }
    }
    if (failures.length) throw new Error(`卸载失败，旧版本备份保留在 ${failures.join('；')}`);
    throw error;
  }
  for (const stage of moved) {
    try {
      ports.removePath(stage.temporary);
    } catch {
      /* Already outside scan roots. */
    }
  }
}

export function migrateSkillMirrors(ports: CatalogPorts): readonly string[] {
  const conflicts: string[] = [];
  if (!ports.exists(join(ports.userRoot, 'skills'))) return conflicts;
  let entries;
  try {
    entries = ports.io.readDir(join(ports.userRoot, 'skills'));
  } catch {
    return ['用户技能目录'];
  }
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name.startsWith('.')) continue;
    const [source, mirror] = skillDestinations(ports, entry.name) as [string, string];
    if (!ports.exists(join(source, 'SKILL.md'))) continue;
    const marker = ports.io.readText(join(source, '.evowork-source'))?.trim();
    if (marker === 'hub-revoked') continue;
    try {
      if (!ports.exists(mirror)) {
        if (marker === 'local' || marker === 'git' || marker === 'hub')
          replaceSkillDirectories(ports, [mirror], (next) => ports.linkDir(source, next));
        continue;
      }
      if (lstatSync(mirror).isSymbolicLink()) {
        if (realpathSync(mirror) !== realpathSync(source)) conflicts.push(entry.name);
        continue;
      }
      if (skillContentHash(source) !== skillContentHash(mirror)) {
        conflicts.push(entry.name);
        continue;
      }
      replaceSkillDirectories(ports, [mirror], (next) => ports.linkDir(source, next));
    } catch {
      conflicts.push(entry.name);
    }
  }
  return conflicts;
}
