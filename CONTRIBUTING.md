# 贡献指南

感谢你愿意改进 DSH Study Daily。当前支持范围锁定为 DeepSeek Harness `0.2.0-rc.2`；涉及宿主 API 的改动需先核对该版本的实际契约，不要仅凭较新版本文档推断。

## 开发环境

- Node.js `^22.19.0` 或 `>=24.0.0`
- 无第三方运行时依赖；测试使用 Node.js 内置测试运行器

## 本地检查

```sh
npm run check
npm test
```

如果改动涉及 bundle 清单、配置或 DSH 工具定义，请补充测试并确认 `package.json` peer dependency 与 `cordis.patch.yml` 一致。

## Pull Request

- 一个 PR 聚焦一个明确问题，并说明用户可见变化。
- 不要提交 Vault 内容、个人配置、token、真实用户路径或生成的 `node_modules/`。
- 涉及解析语义变化时，添加 Markdown fixture，并说明与现有任务语法的差异。
- 涉及 DSH API 时，注明核对的 DSH 版本；未能实机验证时需明确标记。
