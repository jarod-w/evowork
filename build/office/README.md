# build/office —— 构建输入与完整办公运行时

`NotoSansSC.ttf` 是构建输入（固定 Google Fonts 版本与 sha256，见 manifest.ts）。
`node scripts/build-office-runtime.mjs` 在构建机器安装 Python、全部办公依赖并切静态字体，
产出 `<os>-<arch>/runtime/`；搬迁后实际核验模块/版本/字体，不提交成品二进制。

打包前必须准备目标架构成品。electron-builder 将完整目录放进
`.app/Contents/Resources/office/runtime/`；用户只做本地复制和验收，零网络、零 pip。
缺文件/清单不符/错误架构会阻止打包；详见 [编译与部署](../../docs/build-and-deploy.md#33-完整办公运行时随应用分发08-4)。
