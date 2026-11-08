import { platform } from 'node:os';

export function shellQuote(value) {
  return platform() === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function localNodeCommand(args) {
  return `${platform() === 'win32' ? '& ' : ''}${[process.execPath, ...args].map(shellQuote).join(' ')}`;
}

/** Explicit fixture runtime; do not add developer tools to the model's PATH. */
export function writeFileCommand(path, content) {
  return localNodeCommand([
    '-e',
    "require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'hex'))",
    path,
    Buffer.from(content, 'utf8').toString('hex'),
  ]);
}

/** Gate scripts must use the actual office interpreter, including on Windows. */
export function localPythonCommand(args) {
  const windows = platform() === 'win32';
  const quote = windows
    ? (value) => `'${value.replaceAll("'", "''")}'`
    : (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const python = process.env.EVOWORK_OFFICE_PYTHON ?? (windows ? 'python' : 'python3');
  // Windows PowerShell 5.1 drops double quotes while launching python.exe.
  // A -c script that contains them is fed on stdin instead, where the quotes stay.
  const scriptAt = args.indexOf('-c');
  const script = scriptAt >= 0 ? args[scriptAt + 1] : undefined;
  if (
    windows &&
    typeof script === 'string' &&
    script.includes('"') &&
    !script.split('\n').includes("'@")
  ) {
    const rest = args.slice(scriptAt + 2);
    const tail = rest.length ? ` ${rest.map(quote).join(' ')}` : '';
    return `@'\n${script}\n'@ | & ${quote(python)} -${tail}`;
  }
  return `${windows ? '& ' : ''}${[python, ...args].map(quote).join(' ')}`;
}
