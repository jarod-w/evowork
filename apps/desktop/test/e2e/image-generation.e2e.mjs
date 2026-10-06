/** 真 Electron + 真内核 + 图片 MCP + 本机产物；模型和服务商为确定性夹具，不产生费用。 */
import { realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, nativeImage } from 'electron';
import { bootApp, createE2EHome, writeKernelConfig } from './harness/boot.mjs';
import { createFakeGateway } from './harness/fake-gateway.mjs';
import { waitFor, removeE2EHome, createRunner } from './harness/runner.mjs';
const { stage, report } = createRunner({
  stagePrefix: '__EVOWORK_IMAGE_E2E_STAGE__',
  resultPrefix: '__EVOWORK_IMAGE_E2E__',
});
stage('loaded');
const repoRoot = process.env.EVOWORK_E2E_REPO_ROOT,
  appServerPath = process.env.EVOWORK_APP_SERVER;
const created = createE2EHome('evowork-images-e2e-');
const home = realpathSync(created.home),
  workspace = realpathSync(created.workspace),
  kernelHome = realpathSync(created.kernelHome);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
let paidCalls = 0,
  editCalls = 0;
const gateway = createFakeGateway({
  turnMarker: 'unused first hold marker',
  imageOperation: async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    paidCalls++;
    if (body.image) editCalls++;
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ model: body.model, b64: png.toString('base64'), generatedImages: 1 }));
  },
});
let booted;
async function runAll() {
  try {
    const baseUrl = await gateway.listen();
    writeKernelConfig(
      kernelHome,
      `model_provider = "evowork"
default_permissions = "evowork-workspace"
approval_policy = "never"
[model_providers.evowork]
name = "E2E Gateway"
base_url = "${baseUrl}"
wire_api = "responses"
env_key = "EVOWORK_GATEWAY_TOKEN"
[permissions.evowork-workspace]
extends = ":workspace"
`,
    );
    const source = join(workspace, 'selected-original.jpg');
    const original = nativeImage.createFromBuffer(png).toJPEG(90);
    writeFileSync(source, original);
    stage('booting');
    booted = await bootApp({
      repoRoot,
      appServerPath,
      home,
      hostEnv: { EVOWORK_GATEWAY_TOKEN: 'e2e-only-token', ARK_API_KEY: 'e2e-only-key' },
      show: true,
      captureKernelProcess: true,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
    });
    const { evaluate, host } = booted;
    stage('booted');
    await evaluate(
      `window.__imageApprovals=[];window.__imageEvents=[];window.evowork.onPendingApprovals(a=>window.__imageApprovals=a);window.evowork.onUiEvent(e=>window.__imageEvents.push(e));true;`,
    );
    await evaluate(
      `window.evowork.saveImageSettings({enabled:true,model:'doubao-seedream-5-0-flash-260915',baseUrl:'https://ark.cn-beijing.volces.com/api/v3/'})`,
    );
    const project = await evaluate(
      `window.evowork.createProject({name:'Images E2E',path:${JSON.stringify(workspace)}})`,
    );
    if (!project.ok) throw new Error('PROJECT_NOT_CREATED');
    const workspaceId = project.projectId ?? project.projects[0]?.id;
    async function run(marker, tool, args, accept, references) {
      stage(marker);
      const beforeCalls = paidCalls;
      gateway.scriptWhen(marker, (v) => v.text.includes(marker), {
        tool: (body) => {
          const parsed = JSON.parse(body);
          const names = (list) => list.flatMap((e) => (e.tools ? names(e.tools) : [e.name]));
          const name = names(parsed.tools ?? []).find((n) => n?.endsWith(tool));
          if (!name) throw new Error('IMAGE_TOOL_NOT_DISCOVERED');
          return name;
        },
        args,
      });
      const result = await evaluate(
        `window.evowork.send(${JSON.stringify({ text: marker, modelId: 'e2e-model', workspaceId, modeId: 'full-access', ...(args.imageRef || references ? { threadId: globalThis.imageThread } : {}), ...(references ? { references } : {}) })})`,
      );
      if (!globalThis.imageThread) globalThis.imageThread = result.threadId;
      const card = await waitFor(
        () =>
          evaluate(
            `window.__imageApprovals.find(a=>a.threadId===${JSON.stringify(result.threadId)} && a.kind==='mcp' && a.options?.some(o=>o.id==='确认本次上传与费用'))`,
          ),
        '图片费用确认没有出现',
        30000,
      );
      if (paidCalls !== beforeCalls) throw new Error('PAID_BEFORE_APPROVAL');
      await evaluate(
        `window.evowork.decideApproval(${JSON.stringify({ id: card.id, decision: accept ? 'accept' : 'decline', ...(accept ? { optionId: '确认本次上传与费用' } : {}) })})`,
      );
      await waitFor(
        () =>
          evaluate(
            `window.__imageEvents.some(e=>e.type==='turn-completed'&&e.taskId===${JSON.stringify(result.threadId)})`,
          ),
        '图片回合未结束',
        30000,
      );
      return await evaluate(
        `window.evowork.getImageOperations({threadId:${JSON.stringify(result.threadId)}})`,
      );
    }
    stage('generating');
    let rows = await run('IMAGE_GEN', 'image_generate', { prompt: 'a red ball' }, true);
    const first = rows.find((o) => o.status === 'completed');
    if (!first || paidCalls !== 1) throw new Error('GENERATION_NOT_DELIVERED');
    const results = await evaluate(
      `window.evowork.getTaskResults({threadId:${JSON.stringify(globalThis.imageThread)}})`,
    );
    if (!results.artifacts.some((a) => a.id === first.artifactId))
      throw new Error('ARTIFACT_NOT_INDEXED');
    const preview = await evaluate(
      `window.evowork.readResultPreview({artifactId:${JSON.stringify(first.artifactId)}})`,
    );
    if (preview.kind !== 'image' || !preview.content?.startsWith('data:image/png;base64,'))
      throw new Error('IMAGE_PREVIEW_MISSING');
    // Clear completion events so the second turn must actually end.
    await evaluate('window.__imageEvents=[]');
    rows = await run(
      'IMAGE_EDIT',
      'image_edit',
      { prompt: 'make it blue', imageRef: first.artifactId },
      true,
    );
    if (
      !rows.some((o) => o.parentId === first.id && o.status === 'completed') ||
      paidCalls !== 2 ||
      editCalls !== 1
    )
      throw new Error('EDIT_LINEAGE_MISSING');
    await evaluate('window.__imageEvents=[]');
    const selected = await evaluate(
      `window.evowork.pickAttachments({threadId:${JSON.stringify(globalThis.imageThread)},purpose:'imageEdit'})`,
    );
    const references = selected.flatMap((a) => a.references);
    if (references.length !== 1 || references[0].purpose !== 'imageEdit')
      throw new Error('INPUT_NORMALIZATION_MISSING');
    rows = await run(
      'IMAGE_SELECTED',
      'image_edit',
      (body) => ({
        prompt: 'make this selected picture blue',
        imageRef: body.match(/imageRef: (img_[a-f0-9-]+)/)?.[1],
      }),
      true,
      references,
    );
    if (paidCalls !== 3 || editCalls !== 2 || !readFileSync(source).equals(original))
      throw new Error('SELECTED_EDIT_ORIGINAL_CHANGED');
    const selectedEdit = rows.find(
      (o) => o.status === 'completed' && o.parentId === null && o.id !== first.id,
    );
    if (!selectedEdit) throw new Error('SELECTED_EDIT_NOT_DELIVERED');
    await evaluate('window.__imageEvents=[]');
    await run('IMAGE_DECLINE', 'image_generate', { prompt: 'a green ball' }, false);
    if (paidCalls !== 3) throw new Error('DECLINE_SUBMITTED');
    // The test's source fixture is deliberately never sent as a localImage to the non-vision model.
    if (gateway.requestBodies.some((body) => body.includes(png.toString('base64'))))
      throw new Error('IMAGE_LEAKED_TO_CHAT_MODEL');
    stage('reload-and-restart');
    booted.window.webContents.reload();
    await waitFor(() => evaluate('Boolean(window.evowork)'), 'preload reload failed');
    const reopened = await evaluate(
      `window.evowork.openTask({threadId:${JSON.stringify(globalThis.imageThread)}})`,
    );
    if (!JSON.stringify(reopened).includes('image_generation'))
      throw new Error('IMAGE_HISTORY_LOST');
    await evaluate(
      'window.__imageNotices=[];window.evowork.onNotice(n=>window.__imageNotices.push(n));true',
    );
    booted.killKernel();
    await waitFor(
      () => evaluate("window.__imageNotices.some(n=>n.kind==='kernel-restarted')"),
      'kernel recovery failed',
      30000,
    );
    const restored = await evaluate(
      `window.evowork.getImageOperations({threadId:${JSON.stringify(globalThis.imageThread)}})`,
    );
    const restoredPreview = await evaluate(
      `window.evowork.readResultPreview({artifactId:${JSON.stringify(selectedEdit.artifactId)}})`,
    );
    if (
      restored.filter((o) => o.status === 'completed').length !== 3 ||
      restoredPreview.kind !== 'image' ||
      paidCalls !== 3
    )
      throw new Error('RESTART_REPLAY_OR_IMAGE_LOST');
    report({
      ok: true,
      paidCalls,
      editCalls,
      nativeBinding: true,
      preview: true,
      declineZeroCalls: true,
      selectedJpegEdit: true,
      rendererReload: true,
      kernelRestartZeroReplay: true,
    });
    await host.stop();
    gateway.close();
    removeE2EHome(home);
    app.exit(0);
  } catch (e) {
    console.error('Image E2E failed:', e.message, 'home:', home);
    if (booted)
      console.error(
        'Approval snapshot',
        await booted.evaluate('JSON.stringify(window.__imageApprovals)').catch(() => ''),
      );
    await booted?.host.stop();
    gateway.close();
    app.exit(1);
  }
}
void runAll();
