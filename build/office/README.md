# build/office —— 随基础包分发的中文字体

`NotoSansSC.ttf` 是 Noto Sans SC 可变字体（OFL 1.1），钉死
`google/fonts@2894aab3`，哈希在
`services/runtime-installer/src/manifest.ts`。

## 为什么在基础包里，而不是按需下载

R10 / 08 §4 的「按需下载」管的是 Python 解释器与办公库（+100MB 级）。
这份字体约 18MB。客户机器上经常打不开 GitHub raw，按需拉会让引导页
「现在安装」卡在字体这一步，失败看起来像网络故障。

Python 发行版仍从 GitHub 按需下。企业离线包
（`EVOWORK_OFFICE_BUNDLE`）继续覆盖整条安装。

## 不要手改这个文件

换版本用清单里的 URL 重新下载，核对 sha256 后再替换。
`pnpm run package` 会在打包前校验哈希。
