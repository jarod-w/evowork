import { readFileSync } from 'node:fs';

/** Read a model-generated local JSON file; schema assertions belong to the caller. */
export function readJsonFile(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
