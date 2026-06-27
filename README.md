# Feishu Note

在 VSCode 侧边栏里查看、新建、编辑你的飞书云文档。

文档以 Markdown 形式预览；点「编辑」会在 VSCode 编辑器里打开临时 `.md` 文件，保存时自动同步回飞书（含标题、列表、代码块、表格、引用、加粗 / 斜体 / 删除线 / 行内代码 / 链接等格式）。

## 功能

- 飞书 OAuth 登录（浏览器跳转授权，token 存放在 VSCode `SecretStorage` 中）
- 列出你的飞书文档（按编辑时间倒序）
- 新建 / 删除文档
- Markdown 渲染预览
- 一键在编辑器中打开，保存即同步到飞书
  - 自定义实现的 docx **Blocks ↔ Markdown** 双向转换，保留主要格式

## 安装

### 从 .vsix 安装

```bash
npm install
npm run package    # 生成 feishunote-x.y.z.vsix
```

在 VSCode 里：`Extensions` 面板 → `…` 菜单 → `Install from VSIX...`，选择生成的 vsix。

### 从源码调试

在 VSCode 打开本项目后按 `F5`，会启动一个加载了本扩展的 Extension Development Host 窗口。

## 准备一个飞书自建应用

> 扩展默认内置了一个示例 `appId` / `appSecret`（见 VSCode 设置 `feishunote.appId` / `feishunote.appSecret`），仅供快速试用，**生产请务必替换为你自己应用的凭据**。

1. 打开 [飞书开放平台](https://open.feishu.cn) → 创建「企业自建应用」
2. 在应用后台 **「安全设置」→「重定向 URL」** 添加回调地址，格式为 `http://<host>:<port>/callback`，默认值：
   - `http://127.0.0.1:8080/callback`
   - 端口和主机都可以自定义（见下方「配置项」中的 `feishunote.oauthCallbackPort` / `feishunote.oauthCallbackHost`）。
   - **VSCode 设置和飞书后台「重定向 URL」必须保持一致**，否则授权会被拒绝。
   - 推荐当 8080 被本机其他服务占用时改为 8090、8888 等空闲端口。
3. 在 **「权限管理」** 中开通以下 scope（用户授权）：
   - `docx:document:readonly` — 查看文档
   - `docx:document` — 创建 / 编辑文档
   - `drive:drive` — 文件管理（删除等）
4. 把应用发布给自己（或拉到测试企业），确保账号在可用范围内
5. 把 App ID / App Secret 填到 VSCode 设置：
   - `feishunote.appId`
   - `feishunote.appSecret`

## 使用

1. 在 VSCode 左侧活动栏点击「FS Note」图标
2. 点击「飞书登录」，浏览器会跳转到飞书授权页
3. 授权后回到 VSCode，侧边栏自动加载你的文档列表
4. 操作：
   - 点击文档标题 → Markdown 预览
   - 点击「编辑」 → 在 VSCode 编辑器打开临时文件，保存即同步到飞书
   - 点击「刷新」 → 重新拉取当前文档
   - 点击「返回」 → 回到文档列表
   - 点击「新建文档」 → 在根目录创建一篇新 docx
   - 点击文档行的「删除」 → 移除文档（会弹出确认框）

## 配置项

通过 `Settings → Extensions → Feishu Note` 设置：

| 项 | 默认值 | 说明 |
|---|---|---|
| `feishunote.appId` | 内置示例 | 飞书应用 App ID |
| `feishunote.appSecret` | 内置示例 | 飞书应用 App Secret |
| `feishunote.oauthCallbackPort` | `8080` | OAuth 回调监听端口，**可自定义**。若 8080 被占用可改为其他空闲端口（如 8090、8888），改后需同步更新飞书应用后台的「重定向 URL」 |
| `feishunote.oauthCallbackHost` | `127.0.0.1` | OAuth 回调主机名，**可自定义**（`127.0.0.1` 或 `localhost`），改后同样需同步更新飞书后台 |
| `feishunote.apiBaseUrl` | `https://open.feishu.cn` | 飞书 Open API 域名（国际版可改为 lark） |
| `feishunote.documentLanguage` | `zh` | 文档语言：`zh` / `en` / `ja` |

## 格式映射

Markdown ↔ 飞书块的双向映射，覆盖以下结构（实现位于 `src/api/feishuApi.ts`）：

- 标题 1–9（`#` … `#########`）
- 段落、软换行
- 无序列表 / 有序列表 / 待办事项（`- [ ]` / `- [x]`）
- 代码块（识别 75+ 种语言标识）
- 引用、分割线、高亮块
- 表格
- 行内：加粗、斜体、删除线、下划线、行内代码、链接、文档提及、公式

不支持或暂未实现的元素会以最接近的纯文本回退。

## 开发

```bash
npm install
npm run compile      # 单次编译
npm run watch        # 监听编译
npm run lint
npm test
npm run package      # 生成 .vsix
```

调试：在 VSCode 打开本项目按 `F5`。

> 注：本项目曾遇到本地 `node_modules/.bin/tsc` shim 指向不存在的 `../lib/tsc.js` 的问题，所以 `compile` 脚本采用 `node ./node_modules/typescript/lib/_tsc.js`。如果 `npm rebuild typescript` 修复了 shim，可以改回 `tsc -p ./`。

## 注意事项

- OAuth 回调依赖本地端口（默认 8080），请确保未被占用
- Token 通过 VSCode `SecretStorage` 加密保存，不会落到普通配置里
- 写回飞书目前使用「删除根块下全部子块 → 重新插入」的全量替换策略，长文档会有可见延迟，且**不支持并发协作合并**（VSCode 端的内容会覆盖飞书端的当前内容）

## License

MIT
