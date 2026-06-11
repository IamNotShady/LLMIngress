# LLMIngress Product Design

> LLMIngress 是一个面向 AI Agent 的 AI Gateway。AI Agent 只需要接入 LLMIngress 一个统一 endpoint；LLMIngress 在后端连接多个 Provider 和模型，并根据请求参数、上下文和使用场景自动匹配合适的模型。

## 1. 产品定位

LLMIngress 是用户部署的 AI Agent 模型入口层。用户把 Codex、CloudCode、Cursor、OpenCloud、Hermes 等不同 AI Agent 的模型请求接入 LLMIngress，再由 LLMIngress 统一完成 Provider 接入、模型选择、Fallback、成本记录和用量控制。

核心目标：

- 让 AI Agent 只接入一个统一 Gateway。
- 让不同 AI Agent 复用同一套模型 Provider、API Key、订阅额度和本地模型。
- 根据 AI Agent 请求的参数、上下文和使用场景自动匹配合适模型。
- 降低 AI Agent 的模型使用成本。
- 在一个控制台里看清每个 Agent 的模型、请求、Tokens、成本和失败情况。

## 2. 产品范围

### 2.1 核心范围

- 多个 AI Agent 接入。
- 可部署在个人电脑、本地服务器或云端服务器的 Gateway。
- Dashboard / Control Panel。
- Provider Key、订阅 Token、本地模型服务管理。
- Agent 维度的路由、Fallback、预算、日志和统计。
- 基于请求参数、任务类型、上下文长度、工具调用和模型能力的自动路由。
- Provider 失败、限流或超时后的自动 Fallback。

## 3. 目标用户

### 3.1 Primary User

个人开发者、AI power user、独立开发者、重度 AI Agent 用户。

典型特征：

- 同时使用多个 AI coding agent 或 desktop agent。
- 有多个模型账号或订阅，例如 OpenAI、Claude、Gemini、Copilot、本地模型。
- 经常切换模型或 Provider。
- 想知道每个 Agent 花了多少钱、用了多少 Token、失败率如何。
- 希望简单请求走便宜模型，复杂任务走强模型。

### 3.2 典型 Agent

优先面向这些 AI Agent：

- Codex。
- CloudCode。
- Cursor。
- OpenCloud。
- Hermes。
- 其他可配置 OpenAI-compatible endpoint 的 AI Agent。

## 4. 核心用户故事

### 4.1 接入多个 Agent

作为个人用户，我希望把 Codex、CloudCode、Cursor、OpenCloud、Hermes 接到同一个 Gateway，这样我不需要分别在每个 Agent 里维护复杂的模型和 Key 配置。

### 4.2 统一管理 Provider

作为个人用户，我希望在一个地方配置 OpenAI、Anthropic、Google、OpenRouter、GitHub Copilot、本地 Ollama 等 Provider，这样所有 Agent 都可以复用这些模型能力。

### 4.3 自动选择合适模型

作为个人用户，我希望简单任务自动走便宜模型，复杂任务自动走更强模型，这样可以降低成本，同时不牺牲关键任务质量。

### 4.4 Provider 失败自动切换

作为个人用户，我希望某个模型失败、限流或不可用时，Agent 请求能自动切换到备用模型，避免当前工作流中断。

### 4.5 看清 Agent 消费

作为个人用户，我希望按 Agent 查看 Tokens、成本、模型使用分布和请求历史，这样我能知道哪个 Agent 花费最高、哪些模型最常用。

### 4.6 控制预算

作为个人用户，我希望给单个 Agent 设置成本或 Token 上限，避免某个 Agent 因循环调用或错误配置造成过量消耗。

## 5. 产品信息架构

控制台包含以下一级模块：

- Agents：管理接入的个人 AI Agent。
- Providers：管理模型 Provider、API Key、订阅 Token、本地模型。
- Routing：配置模型路由、复杂度分层、任务类型路由和 Fallback。
- Activity：查看请求日志、消息详情、失败原因和响应元数据。
- Usage：查看 Tokens、成本、模型分布和节省情况。
- Limits：配置 Agent 级预算和用量限制。
- Playground：在 LLMIngress 内测试路由和模型响应。
- Settings：本机服务、端口、数据目录、安全和导出设置。

## 6. Agent 接入能力

### 6.1 Agent 管理

- 创建 Agent。
- 设置 Agent 名称。
- 设置 Agent 类型。
- 设置 Agent 接入平台。
- 查看 Agent 列表。
- 查看 Agent 状态。
- 重命名 Agent。
- 删除 Agent。
- 复制 Agent 配置。
- 为 Agent 生成专属 API Key。
- 轮换 Agent API Key。
- 开启或关闭 Agent 请求记录。

### 6.2 Agent 类型

Agent 分类围绕 AI Agent 的使用形态：

- Coding Agent。
- Desktop Agent。
- Terminal Agent。
- IDE Agent。
- Other Agent。

### 6.3 首批接入对象

- Codex。
- CloudCode。
- Cursor。
- OpenCloud。
- Hermes。
- OpenAI-compatible custom agent。

### 6.4 Agent 接入方式

- 提供 Gateway Base URL。
- 提供 Agent 专属 API Key。
- 提供模型名，例如 `llmingress/auto` 或 `auto`。
- 为不同 Agent 输出接入说明。
- 支持复制配置片段。
- 支持校验 Agent 是否已经成功发起请求。

### 6.5 Agent 状态

- 未配置。
- 已创建但未连接。
- 已连接。
- 最近有请求。
- 最近请求失败。
- Provider 不可用。
- 超出预算限制。

## 7. Gateway 能力

### 7.1 统一入口

- 提供 OpenAI-compatible endpoint。
- 支持 `POST /v1/chat/completions`。
- 支持 `POST /v1/responses`。
- 支持 `GET /v1/models`。
- 优先保证主流 Agent 能够用 OpenAI-compatible 方式接入。
- Anthropic-compatible endpoint 可作为增强能力。

### 7.2 模型抽象

- 默认模型为 `llmingress/auto`。
- Agent 只需要配置一个虚拟模型名。
- LLMIngress 根据路由结果选择真实 Provider 和真实模型。
- 支持固定指定某个真实模型。
- 支持按 Agent 配置默认模型。

### 7.3 请求能力

- 支持普通文本请求。
- 支持 streaming 响应。
- 支持 tools / function calling 透传。
- 支持常用采样参数透传。
- 支持 max tokens、temperature、top p 等参数。
- 支持 provider-specific 参数。
- 支持请求超时控制。
- 支持客户端主动取消请求。

### 7.4 响应元数据

每次响应应返回可观测信息：

- 实际命中的 Provider。
- 实际命中的模型。
- 路由 tier。
- 路由原因。
- Fallback 命中情况。
- 估算输入 Tokens。
- 估算输出 Tokens。
- 估算成本。
- 请求耗时。

### 7.5 Gateway 鉴权

- 每个 Agent 使用独立 API Key。
- API Key 只用于 LLMIngress Gateway。
- Key 前缀建议使用 `llmi_`。
- Dashboard 显示 key prefix。
- 支持 key 轮换。
- 支持禁用旧 key。

## 8. Provider 能力

### 8.1 Provider 类型

支持 AI Agent 常见 Provider 来源：

- API Key Provider。
- Subscription Provider。
- Local Provider。
- Custom Provider。

### 8.2 API Key Provider

支持个人用户输入自己的模型 API Key：

- OpenAI。
- Anthropic。
- Google Gemini。
- OpenRouter。
- DeepSeek。
- xAI。
- Mistral。
- Qwen。
- Moonshot / Kimi。
- MiniMax。
- Groq。
- Fireworks AI。
- Z.ai。
- 其他兼容 Provider。

### 8.3 Subscription Provider

支持复用个人已有订阅或 Token Plan：

- ChatGPT Plus / Pro / Team。
- Claude Pro / Max。
- GitHub Copilot。
- Gemini / Google sign-in。
- Kimi Coding Plan。
- GLM Coding Plan。
- OpenCode Go。
- 其他可通过 Token、OAuth 或 Device Code 接入的订阅。

### 8.4 Local Provider

支持本地或自托管模型服务：

- Ollama。
- LM Studio。
- llama.cpp。
- 任意 OpenAI-compatible server。

### 8.5 Custom Provider

支持个人用户接入自定义 endpoint：

- 配置 Provider 名称。
- 配置 Base URL。
- 配置 API Key。
- 选择 OpenAI-compatible 类型。
- 探测模型列表。
- 手动维护模型列表。
- 将自定义模型加入路由和 Fallback。

### 8.6 Provider 管理

- 添加 Provider。
- 删除 Provider。
- 启用或禁用 Provider。
- 刷新模型列表。
- 查看 Provider 可用模型。
- 查看 Provider 最近连接状态。
- 为同一 Provider 保存多个 Key。
- 给 Key 设置 label。
- 调整 Key 优先级。
- 查看 Key prefix，不展示完整密钥。

## 9. 模型发现与模型库

### 9.1 模型发现

- 连接 Provider 后自动拉取模型列表。
- 支持手动刷新模型。
- 支持本地模型同步。
- 支持自定义模型手动添加。
- 支持模型不可用提示。

### 9.2 模型元数据

每个模型应尽量展示：

- Provider。
- Model ID。
- Display name。
- Context window。
- 输入价格。
- 输出价格。
- 是否支持 streaming。
- 是否支持 tools。
- 是否适合 coding。
- 是否适合 reasoning。
- 是否支持多模态输入。

### 9.3 模型价格

- 展示模型价格。
- 标记免费模型。
- 标记本地模型成本为 0。
- 用价格估算 Agent 消费。
- 用价格参与路由建议。

## 10. Routing 能力

### 10.1 Default Routing

- 每个 Agent 有一个默认 route。
- 默认 route 可以是 `auto`。
- 默认 route 也可以固定到某个 Provider / Model。
- 当其他规则都不命中时使用默认 route。

### 10.2 Complexity Routing

支持按请求复杂度分层：

- Simple。
- Standard。
- Complex。
- Reasoning。

能力包括：

- 判断请求复杂度。
- 简单任务走低成本模型。
- 常规任务走平衡模型。
- 复杂任务走高质量模型。
- 推理任务走 reasoning 模型。
- 每个 tier 可配置 primary model。
- 每个 tier 可配置 fallback chain。
- 支持关闭 complexity routing。

### 10.3 Coding-oriented Routing

因为 LLMIngress 面向 AI Agent，尤其是 coding agent，需要重点支持 coding 场景：

- 识别代码生成。
- 识别代码解释。
- 识别代码修复。
- 识别测试生成。
- 识别 repo / file 相关请求。
- 识别 terminal / shell 相关请求。
- 识别长上下文任务。
- 将 coding 请求路由到更适合代码的模型。

### 10.4 Task-specific Routing

支持 AI Agent 常见任务类型：

- Coding。
- Reasoning。
- Web browsing。
- Data analysis。
- Writing。
- Terminal / shell。
- Long context。

### 10.5 Header Routing

部分 Agent 允许自定义 header 时，可以通过 header 强制路由：

- `x-llmingress-tier`。
- `x-llmingress-task`。
- `x-llmingress-model`。

对无法设置自定义 header 的 Agent，使用默认 route 或 Agent 级配置。

## 11. Fallback 能力

### 11.1 Fallback Chain

- 每个 tier 可配置 fallback models。
- 每个 Agent 可配置全局 fallback。
- 每个 Provider 可配置备用 Provider。
- Fallback 按顺序尝试。
- 每条链最多建议 5 个备用模型。
- 可混合 API Key、Subscription、本地模型和 Custom Provider。

### 11.2 触发条件

- Provider 5xx。
- Provider 429。
- Provider timeout。
- Provider 认证失败。
- 模型不可用。
- 请求被 Provider 拒绝。
- Streaming 首包前失败。

### 11.3 用户可见结果

- 展示原始失败模型。
- 展示最终成功模型。
- 展示 fallback 次数。
- 展示每次失败原因。
- 在 Activity 中记录 fallback 事件。

## 12. 用量与预算

### 12.1 Agent 级用量统计

- 按 Agent 统计请求数。
- 按 Agent 统计输入 Tokens。
- 按 Agent 统计输出 Tokens。
- 按 Agent 统计成本。
- 按 Agent 统计失败率。
- 按 Agent 统计平均延迟。

### 12.2 Provider / Model 统计

- 按 Provider 查看成本。
- 按 Model 查看成本。
- 查看最常用模型。
- 查看最贵模型。
- 查看失败最多的模型。

### 12.3 预算限制

- 给单个 Agent 设置 Token 上限。
- 给单个 Agent 设置成本上限。
- 支持小时、天、周、月周期。
- 支持达到阈值后提醒。
- 支持达到阈值后阻断请求。
- 支持手动重置或修改限制。

### 12.4 成本节省

- 估算 auto routing 相比固定强模型节省的成本。
- 展示节省金额。
- 展示节省百分比。
- 展示低成本模型命中比例。

## 13. Activity / Logs

### 13.1 请求日志

- 查看所有 Agent 请求。
- 按 Agent 筛选。
- 按 Provider 筛选。
- 按 Model 筛选。
- 按状态筛选。
- 按时间范围筛选。
- 按成本范围筛选。
- 按 routing tier 筛选。

### 13.2 请求详情

详情页展示：

- Agent。
- Provider。
- Model。
- Routing tier。
- Routing reason。
- Fallback 信息。
- Tokens。
- Cost。
- Latency。
- Status。
- Error message。
- Request metadata。
- Response metadata。

### 13.3 内容记录

- 默认可只记录 metadata。
- 用户可选择是否记录 prompt / response 内容。
- 可按 Agent 开关内容记录。
- 可删除单条记录。
- 可一键清空某个 Agent 的记录。

## 14. Desktop Dashboard

### 14.1 首页

- 显示 Gateway 状态。
- 显示最近请求。
- 显示今日成本。
- 显示今日 Tokens。
- 显示活跃 Agent。
- 显示 Provider 健康状态。

### 14.2 Agents 页面

- Agent 列表。
- 创建 Agent。
- Agent 连接状态。
- Agent API Key。
- Agent 接入说明。
- Agent 用量摘要。
- Agent 设置入口。

### 14.3 Providers 页面

- Provider 列表。
- 添加 Provider。
- Provider Key 管理。
- 本地模型状态。
- 模型列表刷新。
- Provider 连接测试。

### 14.4 Routing 页面

- Default route。
- Complexity tier route。
- Coding task route。
- Fallback chain。
- Model picker。
- Provider picker。
- 参数配置。

### 14.5 Usage 页面

- Token chart。
- Cost chart。
- Agent cost breakdown。
- Model cost breakdown。
- Provider cost breakdown。
- Savings summary。

### 14.6 Activity 页面

- 请求列表。
- 请求详情。
- Fallback 事件。
- Error 事件。
- Recording 管理。

### 14.7 Limits 页面

- Agent limit rules。
- 成本限制。
- Token 限制。
- 通知配置。
- 阻断策略。

### 14.8 Playground 页面

- 在 LLMIngress 内测试 prompt。
- 选择 Agent。
- 选择 route。
- 查看模型响应。
- 查看 routing metadata。
- 对比不同 route 的输出。

## 15. 部署与数据

### 15.1 Gateway 部署

- LLMIngress 可以运行在个人电脑、本地服务器或云端服务器上。
- 个人电脑部署时默认监听 localhost；服务器部署时可按需绑定内网或公网地址。
- 默认不暴露到公网。
- 支持自定义端口。
- 支持开机自启。
- 支持菜单栏或托盘状态显示。

### 15.2 数据存储

- 保存 Agent 配置。
- 保存 Provider 配置。
- 保存模型缓存。
- 保存请求 metadata。
- 保存可选请求内容。
- 保存统计数据。

### 15.3 数据导出与清理

- 导出请求记录。
- 导出成本报表。
- 清空日志。
- 删除 Agent 数据。
- 删除 Provider 凭据。

## 16. 安全与隐私

### 16.1 凭据保护

- Provider API Key 加密存储。
- Subscription Token 加密存储。
- Agent API Key hash 存储。
- Dashboard 不默认展示完整 Provider Key。
- 支持轮换 Agent Key。

### 16.2 用户自主管理

- 配置和日志保存在用户选择的部署环境中。
- 本地模型请求不离开用户配置的本地或自托管模型服务。
- 用户可选择是否记录 prompt / response。
- 默认不上传请求内容。

### 16.3 网络安全

- 个人电脑部署默认只监听 `127.0.0.1`；服务器部署可显式配置监听地址。
- 用户显式配置后才允许 LAN 或公网访问。
- Custom Provider URL 需要校验。
- Cloud Provider 请求只发送到用户配置的 Provider。

## 17. 关键指标

### 17.1 激活指标

- 用户创建第一个 Agent。
- 用户成功连接第一个 Provider。
- 用户完成第一次 Agent 请求。

### 17.2 留存指标

- 每日活跃 Agent 数。
- 每日 Gateway 请求数。
- 每周查看 Usage 页次数。
- 每周至少一次路由配置调整。

### 17.3 成本价值指标

- Auto routing 命中低成本模型比例。
- Fallback 成功次数。
- 估算节省金额。
- 超预算阻断次数。

## 18. 产品边界

LLMIngress 是 AI Agent Gateway。

产品焦点：

- 让 AI Agent 通过一个统一 endpoint 接入模型能力。
- 在 Gateway 后方统一管理多个 Provider 和模型。
- 根据请求参数、上下文、任务类型、工具调用和模型能力自动匹配合适模型。
- 为 AI Agent 提供 Fallback、用量统计、成本控制和请求可观测性。
- 保持用户自主管理的数据与凭据方式。
