/**
 * 电脑操控的**假原生 Helper**（12 §4.0「开发测试中的注入驱动」）。
 *
 * 它顶替的只是 `EvoWork Computer Use.app` 这一个进程：宿主准入、认证 socket、内核拉起的
 * `cua_repl` MCP、审批卡、状态条、时间线 —— 这些全是真的。所以用它跑出来的绿
 * **只证明宿主到界面这一段**（CU-R7 / R9 / R10），不证明 AX、截图、TCC 或签名（CU-R1 / R11）。
 *
 * 它演一个 TextEdit 窗口：一个可写的正文框、一个「保存」按钮、一行只有它才有的金丝雀文字。
 * 同时把终端与系统设置列进 `list_apps` —— **真 Helper 也会看见它们**，硬禁止是宿主的职责。
 * 被问到它们的状态时它照样会答（像一个没设防的 Helper 那样），所以宿主一旦漏放，
 * 调用记录里就会留下证据，而不是靠假 Helper 自己替宿主挡住。
 *
 * 跑在 Electron 主进程里（`ui-entry.mjs` 注入宿主），spec 经 `__evoworkE2E.computerUse` 读它。
 */
import { randomBytes } from 'node:crypto';

export const TEXTEDIT = 'com.apple.TextEdit';
export const TERMINAL = 'com.apple.Terminal';
export const SYSTEM_SETTINGS = 'com.apple.systempreferences';

/** 元素编号（AX 扁平文本里的 `[n]`）。模型拿到的只有这几个数 */
export const ELEMENT = Object.freeze({ window: 1, body: 2, save: 3, canary: 4 });

export function createFakeComputerUse() {
  /** 只出现在「被读取的界面」里的一段字：用来判它去了哪（模型请求、任务历史）、没去哪（审计、日志） */
  const canary = `CUA-AX-CANARY-${randomBytes(4).toString('hex')}`;
  const window = {
    app: TEXTEDIT,
    processId: 4242,
    windowId: 'fake-textedit-1',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    scale: 2,
  };
  const apps = [
    { app: TEXTEDIT, name: 'TextEdit', identity: 'fake-signature-textedit', kind: 'ordinary' },
    { app: TERMINAL, name: '终端', identity: 'fake-signature-terminal', kind: 'terminal' },
    {
      app: SYSTEM_SETTINGS,
      name: '系统设置',
      identity: 'fake-signature-settings',
      kind: 'system',
    },
  ];

  let accessibility = true,
    screenRecording = false,
    componentError = false;
  let body = '';
  let saved = false;
  let selectAll = false;
  let stops = 0;
  /** 宿主调过的每一个原生方法（含参数）。harness 自己的记录，不是产品日志 */
  const calls = [];

  function axText() {
    return [
      `[${ELEMENT.window}] window "未命名.rtf" focused`,
      `[${ELEMENT.body}] textArea "正文" value=${JSON.stringify(body)} settable`,
      `[${ELEMENT.save}] button "保存" enabled actions=[Press]`,
      `[${ELEMENT.canary}] staticText "${canary}"`,
    ].join('\n');
  }

  function write(text) {
    body = selectAll ? text : body + text;
    selectAll = false;
  }

  const helper = {
    stop() {
      stops += 1;
    },
    async call(method, params = {}) {
      calls.push({ method, ...params });
      switch (method) {
        case 'health':
          if (componentError) throw new Error('FAKE_COMPONENT_ERROR');
          return { protocolVersion: 1, accessibility, screenRecording };
        case 'list_apps':
          return apps;
        case 'window_identity':
          return { ...window, app: params.app ?? TEXTEDIT };
        case 'inspect_action':
          return {
            window,
            text: axText(),
            target: {
              app: TEXTEDIT,
              role: params.element_index === ELEMENT.save ? 'AXButton' : 'AXTextArea',
              label: params.element_index === ELEMENT.save ? '保存' : '正文',
              editable: params.element_index !== ELEMENT.save,
            },
          };
        case 'get_app_state':
          return {
            window: { ...window, app: params.app ?? TEXTEDIT },
            elements: Object.values(ELEMENT),
            // 漏放时答出来的东西必须看得出是漏了（见文件头）
            text: params.app === TEXTEDIT ? axText() : `[1] window "${params.app}" ${canary}`,
            coordinateFallback: false,
          };
        case 'set_value':
          if (params.element_index === ELEMENT.body) {
            body = String(params.value ?? '');
            selectAll = false;
          }
          return { ok: true };
        case 'type_text':
        case 'paste':
          write(String(params.text ?? ''));
          return { ok: true };
        case 'select_text':
          if (params.element_index === ELEMENT.body && params.mode === 'replace') selectAll = true;
          return { ok: true };
        case 'press_key':
          if (params.key === 'Meta+S') saved = true;
          if (params.key === 'Meta+A') selectAll = true;
          if (params.key === 'Backspace' || params.key === 'Delete') {
            body = selectAll ? '' : body.slice(0, -1);
            selectAll = false;
          }
          return { ok: true };
        case 'click':
          if (params.element_index === ELEMENT.save) saved = true;
          return { ok: true };
        default:
          return { ok: true };
      }
    },
  };

  return {
    helper,
    setHealth: (patch) => {
      if (typeof patch.accessibility === 'boolean') accessibility = patch.accessibility;
      if (typeof patch.screenRecording === 'boolean') screenRecording = patch.screenRecording;
      if (typeof patch.componentError === 'boolean') componentError = patch.componentError;
    },
    canary,
    calls,
    document: () => body,
    saved: () => saved,
    stops: () => stops,
  };
}

/**
 * 假网关剧本里用的两个小工具。剧本在主进程里求值（`scriptWhen` 的谓词与剧本都是），
 * spec 的闭包够不着，所以挂在控制面上给它们用。
 */
export const cuaScript = {
  /**
   * 请求里把 `cua_repl` 的某个工具声明成了什么名字。
   * 内核把 MCP 工具放在命名空间里（`mcp__cua_repl__` 下的 `list_apps`）还是摊平成全名，
   * 随上游演进变过 —— 剧本照请求里**实际声明的样子**调，免得把形状写死在这里。
   */
  declared(body, tool) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
    for (const entry of Array.isArray(parsed?.tools) ? parsed.tools : []) {
      if (entry?.type === 'namespace' && /cua_repl/.test(entry.name ?? '')) {
        if ((entry.tools ?? []).some((inner) => inner?.name === tool)) return tool;
      }
      if (typeof entry?.name === 'string' && entry.name.endsWith(`cua_repl__${tool}`)) {
        return entry.name;
      }
    }
    return undefined;
  },
  /** 请求里有没有声明任何 `cua_repl` 工具 */
  offered(body) {
    return cuaScript.declared(body, 'list_apps') !== undefined;
  },
  /**
   * 历史里最近一次 `get_app_state` 交回的 `state_id`。
   * 每个写动作都必须带它（CU-D4），而它是宿主现发的随机串，剧本只能从请求里取。
   * 工具结果在请求里是字符串里套 JSON，引号被转义的层数不定，所以正则容忍任意个反斜杠。
   */
  latestStateId(body) {
    const all = [...body.matchAll(/state_id\\*"\s*:\s*\\*"([0-9a-f-]{36})/g)];
    return all.at(-1)?.[1];
  },
};
