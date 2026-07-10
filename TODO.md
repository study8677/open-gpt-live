# OpenGPT Live TODO — v0.3 Voice Quality

> 当前方向：先把语音对话做得更自然，再考虑增加更多 Agent 能力。
>
> 本阶段不做工具调用和长期记忆。

更新日期：2026-07-10

版本目标：`v0.3 Voice Quality`

## 当前基线

`v0.2 Stabilization` 已完成代码实现和本地自动化验证，项目已经具备：

- 文字、按住说话和连续语音三种输入方式。
- 24 kHz PCM、400 ms pre-roll、流式 STT 和批式 WAV fallback。
- 流式 LLM、分段 TTS、插话中断和请求生命周期管理。
- 自动化测试、生产构建、Docker、健康检查、结构化日志和 GitHub Actions。

当前最大的产品差距不再是“功能够不够多”，而是：

- 用户要等多久才看到转写、听到回答？
- 停顿、噪音和外放是否会造成误判？
- 本地模型能否在不使用云端 Key 的情况下完成完整语音闭环？

## 阶段目标

把下一阶段定义为：

> 降低等待、减少误打断、让语音轮次更自然。

本轮交付三项产品能力，并贯穿一条仓库增长工作流：

1. 语音链路延迟指标。
2. 动态 VAD 与更稳健的轮次判断。
3. Ollama + 开源 STT/TTS 的本地端到端配置。
4. GitHub 可检索性、可信度和贡献转化优化。

执行原则：先测量，再优化；先保证轮次正确，再追求极限低延迟；每完成一项能力，同时补齐可验证的演示、数据和仓库入口。

## 优先级

| 优先级 | 当前问题 | 本阶段处理 |
| --- | --- | --- |
| P0 | 不清楚慢在哪里 | 增加端到端延迟指标和可视化 |
| P0 | 固定 RMS 阈值容易受噪音、停顿和设备差异影响 | 动态噪声基线和更稳健的轮次判断 |
| 横向 P0 | 仓库有基础描述和标签，但缺少可传播证据与贡献入口 | 同步优化 metadata、README、演示和社区治理 |
| P1 | 真实本地链路验收不足 | 建立 Ollama + 开源 STT/TTS 配置 |
| P1 | TTS 需要等一段完整音频后才能播放 | 后续实现 PCM/Opus 真流式播放 |
| P2 | 必须等最终转写后才请求 LLM | 后续探索基于稳定临时转写的提前生成 |
| P2 | 外放可能被识别成用户说话 | 后续加强回声消除和全双工控制 |

## P0.1：语音链路延迟指标

### 指标定义

每个语音请求至少记录以下四项：

| 指标 | 起点 | 终点 | 建议字段 |
| --- | --- | --- | --- |
| STT 首字延迟 | 用户开始说话 | 第一个临时转写到达 | `stt_first_partial_ms` |
| 最终转写延迟 | 用户停止说话 | 最终转写到达 | `stt_final_ms` |
| LLM 首字延迟 | 最终转写到达 | 第一个 LLM delta 到达 | `llm_ttft_ms` |
| TTS 首音延迟 | 第一个 LLM delta 到达 | 第一段音频开始播放 | `tts_first_audio_ms` |

补充记录：

- `speech_end → first_audio_playback` 的用户感知总等待时间。
- 请求模式：`text`、`ptt` 或 `live`。
- STT 路径：`realtime`、`batch` 或 `batch_fallback`。
- 请求最终状态：`stop`、`interrupted` 或 `error`。

### 实现 TODO

- [x] 定义统一的语音请求时间点和指标结构。
- [x] 浏览器使用单调时钟记录采集、事件到达和播放时间。
- [x] Gateway 使用服务端单调时钟记录 STT、LLM 和 TTS 阶段时间。
- [x] 不直接用客户端和服务端的绝对时间相减，避免时钟偏差。
- [x] 为每条指标关联 `sessionId`、`requestId`、`turnMode` 和 `sttPath`。
- [x] 在 Gateway 结构化日志中输出阶段耗时，不记录原始音频和完整转写。
- [x] 在页面增加轻量调试面板，显示当前请求的五项核心延迟。
- [x] 中断或失败时保留已经产生的指标，并标记未完成阶段。
- [x] 为指标计算、缺失事件和重复事件增加单元测试。
- [x] 为文字、PTT、Live 和 Realtime fallback 增加集成测试。
- [x] 更新协议、部署日志口径和 Live Mode 验收说明。

### 验收标准

- [ ] 完成一次 Live 对话后，页面能显示四项核心延迟。
- [x] 同一个请求在页面和日志中可以通过 `requestId` 对齐。
- [x] 中断、断线和 Provider 失败不会产生负数或明显错误的耗时。
- [x] Mock 测试可以使用可控时钟，结果稳定且不依赖真实 API。
- [ ] 先形成基线数据，本阶段不凭感觉设定强制性能目标。

## P0.2：动态 VAD 与轮次判断

### 第一层：快速音量判断

- [x] 在开启 Live Mode 后采集短时间环境噪声，计算初始噪声基线。
- [x] 使用滑动窗口持续更新噪声基线，并在用户说话和停顿期间暂停更新。
- [x] 根据噪声基线计算动态 speech/silence threshold。
- [x] 保留最小值、最大值和固定阈值回退，防止阈值无限漂移。
- [x] 保留开始/结束双阈值，避免状态在临界值附近反复切换。
- [x] 在调试面板显示当前 RMS、噪声基线和动态阈值。

### 第二层：轮次确认

- [x] 增加最短有效语音时长，过滤点击声、键盘声和瞬时噪音。
- [x] 区分句中短暂停顿和真正结束，避免用户停顿一下就被抢话。
- [x] 支持可配置的最短说话时长、停顿宽限和最大轮次时长。
- [x] TTS 播放期间继续提高触发门槛，并保留播放结束抑制窗口。
- [x] 为后续轻量语音分类模型预留可替换的 `SpeechDetector` 接口。
- [x] 第一版不强制引入重量级 VAD 模型，先用采集数据验证是否需要第二模型。

### 测试 TODO

- [x] 为动态阈值、噪声基线和状态迁移编写纯逻辑测试。
- [x] 覆盖持续背景噪音、突然噪音、短暂停顿和长停顿。
- [x] 覆盖播放中阈值提升、用户插话和播放结束抑制。
- [x] 覆盖设备音量突然变化后的阈值恢复。
- [ ] 使用安静房间、键盘噪音和外放环境完成真实麦克风验收。

### 验收标准

- [ ] 安静和普通背景噪音下不需要手动修改固定阈值即可开始对话。
- [x] 纯逻辑测试证明单次短促噪音不会创建有效语音轮次。
- [x] 纯逻辑测试证明正常句中停顿不会立即结束轮次。
- [ ] 使用真实麦克风确认用户插话仍能及时终止当前 TTS。
- [x] 关闭动态模式后仍可回退到现有固定阈值行为。

## P1：本地 AI 端到端配置

目标：不使用 OpenAI Key，也能在本机完成：

```text
说话 → 本地转写 → 本地模型回答 → 本地语音播放
```

### 技术路线

- LLM：优先复用当前 OpenAI-compatible Adapter 连接 Ollama。
- STT：评估 LocalAI、faster-whisper 或其他提供 HTTP 接口的本地服务。
- TTS：选择能够稳定输出浏览器可播放格式的开源服务。
- 编排：提供 `docker compose --profile local-ai up`。

### 实现 TODO

- [ ] 验证 Ollama OpenAI-compatible 接口与当前 LLM Adapter 的兼容性。
- [ ] 记录首个推荐 LLM 模型、内存需求和下载方式。
- [ ] 在候选 STT 中选择一个默认方案，并验证中文和英文短句。
- [ ] 在候选 TTS 中选择一个默认方案，并验证首音延迟和浏览器格式。
- [ ] 为本地 Provider 增加健康检查和明确的启动失败信息。
- [ ] 新增 Compose `local-ai` profile，不影响默认云端配置。
- [ ] 提供不包含密钥的 `.env.local-ai.example`。
- [ ] 文档说明模型体积、首次下载时间、CPU/GPU 差异和数据边界。
- [ ] 增加一条本地端到端冒烟流程。
- [ ] 自动化测试继续使用 Mock，不要求 CI 下载大模型。

### 验收标准

- [ ] 新用户按照文档可以在不配置云端 Key 的情况下启动完整链路。
- [ ] 文字、PTT 和 Live Mode 至少各完成一次本地模型对话。
- [ ] 停止、插话、断线和 Provider 重启仍保持现有生命周期语义。
- [ ] 默认 Docker/云端运行方式不因 local-ai profile 发生回归。

## 横向 P0：GitHub 可检索性与高星仓库准备度

目标不是堆关键词或购买虚假 Star，而是让真正搜索语音 AI、本地 AI 和实时音频工程的人：

1. 能找到仓库。
2. 能在 30 秒内理解差异化价值。
3. 能在 5 分钟内开始运行。
4. 能看到真实数据和演示后愿意 Star、反馈或贡献。

Star 数量无法被工程任务直接保证；本阶段优化的是被发现、被信任和被采用的概率。

### 当前线上基线

- 已更新英文 GitHub description，准确覆盖 realtime voice AI、streaming STT、browser VAD、interruptible TTS 和 typed WebSocket gateway。
- 已配置 13 个与当前实现一致的 topics；`ollama` 和 `local-ai` 等能力验收后再加入。
- 已有 MIT License、双语 README、架构说明、截图和 CI。
- 已开启 GitHub Discussions，并在当前分支补齐贡献指南、安全策略、Issue 模板和 PR 模板。
- 暂无项目 homepage/在线 Demo；没有稳定公开地址前不设置失效链接。
- README 暂无真实延迟 benchmark、VAD 优化前后对比和无云端 Key 的本地语音演示。

### GitHub description

在能力尚未交付前使用真实、不过度承诺的描述：

```text
Open-source realtime voice AI with streaming STT, browser VAD, interruptible TTS, and a typed WebSocket gateway for OpenAI-compatible models.
```

- [x] 当前能力 description 已应用到 GitHub About。

等 local-ai 和 v0.3 验收完成后再升级为：

```text
Open-source realtime voice AI with natural turn-taking, streaming speech, Ollama/local AI support, and an inspectable TypeScript WebSocket gateway.
```

### GitHub topics

- [x] 保留当前真实 topics：`voice-ai`、`realtime-ai`、`speech-to-text`、`websocket`、`typescript`、`nextjs`、`openai`、`llm`。
- [x] 补充已实现能力：`text-to-speech`、`voice-activity-detection`、`streaming`、`audio`、`self-hosted`。
- [ ] 只有 local-ai profile 验收后再加入：`ollama`、`local-ai`。
- [x] Topics 控制在 12–16 个高相关词，不使用与实现无关的热门关键词。
- [ ] v0.3 发布前通过 GitHub API 复核线上 description 和 topics。

### README 和演示

- [x] README 首屏在 30 秒内回答：是什么、为什么不同、如何运行。
- [x] 保持英文 README 为默认入口，中文使用独立 `README.zh-CN.md`。
- [ ] 增加 10–20 秒真实语音演示，展示说话、临时转写、回答、播放和插话。
- [ ] 演示同时显示延迟面板，证明结果来自真实链路而不是静态 UI。
- [ ] 增加 v0.2/v0.3 benchmark 表，公开测试设备、模型、网络和测量口径。
- [ ] 增加“为什么选择 OpenGPT Live”对比表，突出开放协议、Provider 可替换、本地部署和可观测轮次。
- [ ] local-ai 完成后，把“无 OpenAI Key 本地运行”放到 Quickstart 附近。
- [x] 增加 Provider 支持矩阵，区分 Stable、Experimental 和 Planned。
- [ ] 所有复制命令在干净环境实际执行，不提供无法复现的营销命令。
- [ ] 添加 FAQ：浏览器支持、隐私边界、回声、模型兼容和与托管方案的区别。
- [x] 生成并视觉验证 1280×640 Social Preview 源文件和 PNG。
- [ ] Chrome 开启文件网址访问权限后，将 PNG 上传到 GitHub Social Preview。
- [ ] 有稳定部署地址后设置 GitHub homepage；没有公开 Demo 前不放失效链接。

### 社区和贡献入口

- [x] 新增 `CONTRIBUTING.md`，包含本地启动、测试、目录边界和提交要求。
- [x] 新增 `SECURITY.md`，说明漏洞报告方式和当前非生产级边界。
- [x] 启用 GitHub Private Vulnerability Reporting，确保安全报告入口可用。
- [x] 新增 `CODE_OF_CONDUCT.md`。
- [x] 新增 Bug、Feature、Provider integration Issue 模板。
- [x] 新增 Pull Request 模板，要求测试证据、截图/录音和兼容性说明。
- [x] 建立标签体系：`area:vad`、`area:stt`、`area:tts`、`area:local-ai`、`provider:*`、`priority:*`。
- [x] 创建 3 个边界清晰的 `good first issue` / `help wanted`，覆盖链接检查、Firefox 兼容和 benchmark 模板。
- [x] 开启 GitHub Discussions，用于模型配置、设备兼容和 Show & Tell。
- [x] 增加 `CHANGELOG.md`；v0.3 完成后再发布对应 GitHub Release。

### 与三个技术迭代绑定

- [ ] 延迟指标完成后：README 加入真实 benchmark 和测量方法。
- [ ] VAD 完成后：发布优化前后相同环境的轮次对比视频和数据。
- [ ] local-ai 完成后：发布无云端 Key Quickstart、Provider 矩阵和资源需求。
- [ ] 每个迭代都同步更新 description/topics，禁止提前宣传尚未验收的能力。

### 增长与质量指标

- [ ] 发布前记录 GitHub Traffic 基线：unique visitors、clones、referring sites。
- [ ] 发布后按周记录 Star、Fork、Issue、Discussion、外部贡献者和 Release 下载变化。
- [ ] 记录 Quickstart 失败问题，并把重复问题转成文档或自动检查。
- [ ] 优先获得真实用户反馈和可复现 Issue，不以单一 Star 数作为质量判断。
- [ ] 不购买 Star、不群发垃圾推广、不伪造 benchmark 或用户评价。

### 验收标准

- [ ] GitHub About 区域具有准确 description、topics、license 和有效 homepage（如果已有 Demo）。
- [ ] 新用户只看 README 可以选择云端或本地运行方式并完成启动。
- [ ] 仓库存在真实语音 Demo、延迟 benchmark 和测试口径。
- [ ] Community Profile 的主要文件和 Issue/PR 入口齐全。
- [ ] 至少准备 3 个边界清晰、可以被外部贡献者完成的 Issue。
- [ ] 本地 Markdown 链接、图片、示例命令和 GitHub Actions 全部通过验证。

## 后续队列：本轮不实现

### P1：真正的流式 TTS 播放

- [ ] 评估 PCM、Opus 和 WebCodecs/AudioWorklet 播放路径。
- [ ] Provider 音频块到达后立即进入浏览器播放缓冲区。
- [ ] 处理背压、下溢、格式边界、中断和迟到音频块。
- [ ] 用 `tts_first_audio_ms` 对比现有整段 MP3 方案。

### P2：基于稳定临时转写提前启动 LLM

- [ ] 定义“稳定临时转写”的判断标准。
- [ ] 临时转写稳定后允许创建 speculative LLM 请求。
- [ ] 最终转写一致时继续，不一致时取消并重新生成。
- [ ] speculative 阶段默认不播放 TTS，避免说出错误内容。
- [ ] 统计重复请求成本、命中率和实际延迟收益。

### P2：回声消除与全双工控制

- [ ] 评估浏览器 `echoCancellation`、`noiseSuppression` 和 `autoGainControl`。
- [ ] 将播放状态、动态阈值和用户插话状态统一到全双工控制器。
- [ ] 使用外放环境测试 AI 自触发和真实 barge-in。
- [ ] 后续再评估服务端 AEC 或专用声学模型。

## 推荐执行顺序

### 第一个迭代：只做延迟指标

- [x] 完成指标结构、日志、页面面板和 Mock 测试。
- [ ] 用现有云端链路采集第一版基线。
- [ ] 根据数据确认最慢的阶段，不同时改动 STT、LLM 和 TTS。
- [ ] 同步产出第一版公开 benchmark、测量方法和 Social Preview 设计稿。

### 第二个迭代：只做 VAD 和轮次

- [x] 实现动态噪声基线和动态阈值。
- [x] 完成停顿、瞬时噪音和 TTS 插话纯逻辑测试。
- [ ] 对比优化前后的误触发率和错误结束次数。
- [ ] 同步录制 VAD 优化前后对比演示，更新 README 差异化说明。

### 第三个迭代：本地 AI profile

- [ ] 先锁定一个可复现的 LLM、STT 和 TTS 组合。
- [ ] 再完成 Compose、文档和本地端到端验收。
- [ ] 同步更新 description/topics、本地 Quickstart、Provider 矩阵和 Release 内容。

### 贯穿三个迭代：仓库增长基础设施

- [ ] 第一迭代补齐 metadata、贡献文件、Issue/PR 模板和标签体系。
- [ ] 第二迭代用真实 VAD 证据替换静态能力描述。
- [ ] 第三迭代完成公开发布材料、GitHub Release 和社区启动清单。

## v0.3 完成定义

- [ ] `pnpm check` 全部通过。
- [ ] 延迟指标覆盖文字、PTT、Live、fallback、中断和错误。
- [ ] VAD 纯逻辑测试和真实麦克风验收通过。
- [ ] local-ai profile 能完成一次无云端 Key 的完整语音对话。
- [ ] README、配置、部署和浏览器限制文档同步更新。
- [ ] 对比记录 v0.2 与 v0.3 的延迟和轮次质量变化。
- [ ] GitHub description、topics、Social Preview 和 homepage 与真实能力一致。
- [ ] 真实 Demo、benchmark、Provider 矩阵和本地 Quickstart 已公开。
- [ ] 贡献指南、安全策略、Issue/PR 模板、标签和 Discussions 准备完成。
- [ ] 不引入工具调用、持久化记忆、计费和多租户能力。

## 明确暂停

除非重新调整优先级，否则继续不做：

- 工具注册表、Function calling 和工具权限系统。
- Memory Adapter、会话数据库和长期记忆。
- 计费、多租户管理后台和复杂 Agent Workflow。
- 插件市场、默认向量数据库、Kubernetes 和多区域高可用。

本阶段的产品判断标准：语音对话是否比 v0.2 更快、更稳、更自然。

本阶段的仓库判断标准：真正需要开放语音 AI 的开发者能否找到它、理解它、跑起来并愿意参与。
