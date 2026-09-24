/** 固定工具面；不接受任意代码，也不允许模型传入宿主授权上下文。 */
export const PROTOCOL_VERSION = 1;
export type ResultCode =
  | 'PERMISSION_REQUIRED'
  | 'APP_DENIED'
  | 'APP_NOT_FOUND'
  | 'WINDOW_NOT_FOUND'
  | 'STALE_STATE'
  | 'ELEMENT_NOT_FOUND'
  | 'USER_STOPPED'
  | 'SCREEN_LOCKED'
  | 'MODEL_IMAGE_UNSUPPORTED'
  | 'POLICY_DENIED'
  | 'TIMEOUT'
  | 'INTERNAL';

export class ComputerUseError extends Error {
  constructor(readonly code: ResultCode) {
    super(code);
  }
}

type Field = {
  type: 'string' | 'number' | 'integer' | 'boolean';
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: readonly (string | number)[];
};
const text: Field = { type: 'string', maxLength: 65536 };
const id: Field = { type: 'string', minLength: 1, maxLength: 256 };
const number: Field = { type: 'number', minimum: 0, maximum: 32768 };
const element: Field = { type: 'integer', minimum: 0, maximum: 2147483647 };
const target = { element_index: element, x: number, y: number };
const choice = (...values: string[]): Field => ({ type: 'string', enum: values });
function tool(
  name: string,
  properties: Record<string, Field>,
  required: string[],
  write = true,
  targeted = false,
) {
  return {
    name,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required,
      ...(targeted
        ? {
            oneOf: [
              {
                required: ['element_index'],
                not: { anyOf: [{ required: ['x'] }, { required: ['y'] }] },
              },
              { required: ['x', 'y'], not: { required: ['element_index'] } },
            ],
          }
        : {}),
    },
    annotations: {
      readOnlyHint: !write,
      destructiveHint: write,
      openWorldHint: true,
      idempotentHint: false,
    },
  };
}
const base = { app: id, state_id: id };
export const TOOLS = [
  tool('list_apps', {}, [], false),
  tool(
    'get_app_state',
    { app: id, disable_diff: { type: 'boolean' }, include_screenshot: { type: 'boolean' } },
    ['app'],
    false,
  ),
  tool(
    'click',
    {
      ...base,
      ...target,
      button: choice('left', 'right', 'middle'),
      click_count: { type: 'integer', minimum: 1, maximum: 3 },
    },
    ['app', 'state_id'],
    true,
    true,
  ),
  tool(
    'drag',
    {
      ...base,
      from_x: number,
      from_y: number,
      to_x: number,
      to_y: number,
      duration_ms: { type: 'integer', minimum: 100, maximum: 2000 },
    },
    ['app', 'state_id', 'from_x', 'from_y', 'to_x', 'to_y'],
  ),
  tool('paste', { ...base, text, format: choice('plain') }, ['app', 'state_id', 'text', 'format']),
  tool(
    'perform_secondary_action',
    {
      ...base,
      element_index: element,
      action: choice('ShowMenu', 'Confirm', 'Cancel', 'Increment', 'Decrement'),
    },
    ['app', 'state_id', 'element_index', 'action'],
  ),
  tool(
    'press_key',
    {
      ...base,
      key: choice(
        'Enter',
        'Tab',
        'Shift+Tab',
        'Escape',
        'Backspace',
        'Delete',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Meta+A',
        'Meta+C',
        'Meta+V',
        'Meta+X',
        'Meta+Z',
        'Meta+Shift+Z',
        'Meta+S',
      ),
    },
    ['app', 'state_id', 'key'],
  ),
  tool(
    'scroll',
    {
      ...base,
      ...target,
      direction: choice('up', 'down', 'left', 'right'),
      pages: { type: 'integer', minimum: 1, maximum: 5 },
    },
    ['app', 'state_id', 'direction', 'pages'],
    true,
    true,
  ),
  tool(
    'select_text',
    {
      ...base,
      element_index: element,
      text,
      prefix: text,
      suffix: text,
      mode: choice('replace', 'extend'),
    },
    ['app', 'state_id', 'element_index', 'text', 'mode'],
  ),
  tool('set_value', { ...base, element_index: element, value: text }, [
    'app',
    'state_id',
    'element_index',
    'value',
  ]),
  tool('type_text', { ...base, text }, ['app', 'state_id', 'text']),
] as const;

/** 与上述 schema 同源校验；错误不回显可能含隐私的参数。 */
export function validateToolCall(name: string, input: unknown): Record<string, unknown> {
  const schema = TOOLS.find((entry) => entry.name === name)?.inputSchema;
  const invalid = (): never => {
    throw new ComputerUseError('POLICY_DENIED');
  };
  if (!schema || !input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const args = input as Record<string, unknown>;
  if (schema.required.some((key) => !Object.hasOwn(args, key))) return invalid();
  for (const [key, value] of Object.entries(args)) {
    const field = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (!field) return invalid();
    if (field.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== field.type)
      return invalid();
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) ||
        value < (field.minimum ?? -Infinity) ||
        value > (field.maximum ?? Infinity))
    )
      return invalid();
    if (
      typeof value === 'string' &&
      (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? Infinity))
    )
      return invalid();
    if (field.enum && !field.enum.some((candidate) => candidate === value)) return invalid();
  }
  if (schema.oneOf) {
    const e = Object.hasOwn(args, 'element_index');
    const x = Object.hasOwn(args, 'x');
    const y = Object.hasOwn(args, 'y');
    if (!(e ? !x && !y : x && y)) return invalid();
  }
  return { ...args };
}
