# Contributing

欢迎 PR、Issue 与功能建议。

## 开发环境

- Node.js ≥ 18
- VSCode ≥ 1.80

```bash
npm install
npm run watch        # 监听编译
# 在 VSCode 中按 F5 启动 Extension Development Host 调试
```

## 提交规范

- 一个 PR 聚焦一件事，描述清楚动机与影响范围
- 涉及飞书 API 行为变更时，请在 PR 描述里贴出请求 / 响应样例，或引用 `docs/` 下的相关章节
- 修改 `src/api/feishuApi.ts` 的 Markdown ↔ Blocks 转换逻辑时，请同步在 `CHANGELOG.md` 的 Unreleased 区记录

## 提交前

```bash
npm run lint
npm run compile
npm test
```

## Issue 报告建议

- 复现步骤、期望行为、实际行为
- 如涉及飞书文档的格式问题，附上：
  - 原始 Markdown 或文档截图
  - VSCode `Output → Feishu Note` / 开发者工具的 console 日志（含 `[getDocumentContent]` / `[replaceDocumentContent]` 等前缀）
  - 文档类型（docx / 旧版 doc / wiki）

## 安全

请勿在 issue / PR 中粘贴真实的 `appSecret` 或 `user_access_token`。如发现安全问题，请通过私下渠道联系仓库维护者。
