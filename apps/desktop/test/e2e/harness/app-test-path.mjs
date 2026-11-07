import { delimiter } from 'node:path';

/** Keep test apps independent of transient tools injected by the coding agent. */
export function appTestPath(value, separator = delimiter) {
  return (value ?? '')
    .split(separator)
    .filter(
      (entry) =>
        !/(?:^|[\\/])(?:\.codex[\\/]tmp|\.cache[\\/]codex-runtimes|OpenAI[\\/]Codex[\\/]bin)(?:[\\/]|$)/i.test(
          entry,
        ),
    )
    .join(separator);
}

export function appTestEnvironment(env) {
  const isolated = { ...env };
  for (const name of Object.keys(isolated)) {
    // A test app must not inherit another running agent's host/session overrides.
    if (name === 'ELECTRON_RUN_AS_NODE' || /^CODEX_/i.test(name)) delete isolated[name];
    else if (name.toLowerCase() === 'path') isolated[name] = appTestPath(isolated[name]);
  }
  return isolated;
}

/** The provider key belongs to the gateway, not to model-executed shell tools. */
export function kernelTestEnvironment(env, home, providerKey, platform = process.platform) {
  const isolated = { ...env, HOME: home, ...(platform === 'win32' ? { USERPROFILE: home } : {}) };
  if (providerKey) {
    for (const [name, value] of Object.entries(isolated)) {
      if (value === providerKey) delete isolated[name];
    }
  }
  return isolated;
}
