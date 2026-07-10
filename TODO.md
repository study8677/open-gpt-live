# OpenGPT Live TODO

> 当前原则：P0、P1、P2 代码实现与本地自动化验证已完成，发布环境验收待完成；P3 暂停，不提前加入工具调用和持久化记忆。

更新日期：2026-07-10
版本目标：Live Voice v0.2 — Stabilization

## 当前结论

OpenGPT Live 已从“核心语音链路 Demo”进入“可测试、可构建、可部署的开源参考实现”阶段。

已经具备：

- 文字对话、按住说话、连续语音、TTS 和插话打断。
- 浏览器端 24 kHz PCM、400 ms pre-roll 和可配置 VAD。
- OpenAI Realtime 流式 STT，以及批式 WAV fallback。
- 协议运行时校验、Mock Provider 和 Gateway 集成测试。
- GitHub Actions、生产 build/start、健康检查和结构化日志。
- WebSocket 自动重连、资源清理和迟到事件过滤。
- Docker 镜像、反向代理说明、配置文档和真实浏览器截图。

当前仍不包含：鉴权、计费、多租户、工具调用、会话持久化和长期记忆。

## P0：可回归的语音基线 — 已完成

- [x] 根目录统一 `pnpm test`。
- [x] 使用 Vitest 运行全部自动化测试。
- [x] Gateway 拆分为可注入的 `createGatewayServer`。
- [x] Mock LLM、STT、Streaming STT 和 TTS 不依赖真实 API Key。
- [x] 对所有不可信 WebSocket 消息做运行时校验。
- [x] 非法 JSON、未知事件和缺失字段返回确定错误。
- [x] 覆盖文本事件顺序和连接内上下文。
- [x] 覆盖 PTT 音频聚合、最终转写和 25 MB 上限。
- [x] 覆盖临时转写、最终转写和 PCM/WAV fallback。
- [x] 覆盖 LLM、STT、TTS 错误和恢复。
- [x] 覆盖中断、迟到事件和 WebSocket 断开清理。
- [x] 覆盖 TTS sequence 和结束事件顺序。
- [x] 每个连接串行处理协议消息，长任务仍可被中断。
- [x] GitHub Actions 执行安装、类型检查、测试和生产构建。

验收命令：

```bash
pnpm typecheck
pnpm test
```

## P1：Live Mode 稳定化 — 已完成

### 句首保护和 PCM 链路

- [x] AudioWorklet 连续生成 24 kHz 单声道 PCM16。
- [x] 按 50 ms 输出 PCM frame。
- [x] 主线程维护默认 400 ms 环形 pre-roll。
- [x] VAD 确认说话后先发送 pre-roll，再发送实时 PCM。
- [x] PTT 继续使用 MediaRecorder，不受 Live Mode 改造影响。
- [x] pre-roll、PCM 转换和配置解析有纯逻辑测试。

### 生命周期和重连

- [x] 为前端请求增加明确生命周期。
- [x] 取消后忽略迟到 transcript、LLM 和 TTS 事件。
- [x] 关闭 Live Mode 时释放 Recorder、AudioContext、Track 和 Object URL。
- [x] WebSocket 使用指数退避自动重连。
- [x] 断线后释放麦克风和活跃播放。
- [x] 重连后明确创建新 Session，不伪装成历史恢复。
- [x] Gateway 断开时取消活跃 Provider 调用。

### VAD 和浏览器边界

- [x] VAD 阈值、debounce、hangover、最大轮次和 pre-roll 可配置。
- [x] TTS 播放期间提高 VAD 阈值并保留结束抑制窗口。
- [x] 保留 AudioWorklet 和 ScriptProcessor fallback。
- [x] 建立 Chromium 浏览器验证基线。
- [x] 文档明确 Edge、Safari 和 Firefox 仍需发布前人工验证。
- [x] 文档明确 RMS-only VAD 的噪声和回声限制。

## P1：真正的 Streaming STT — 已完成

- [x] 定义 Provider 无关的 `StreamingSTTProvider` 和 `StreamingSTTSession`。
- [x] 支持 PCM 增量 append、手动 commit、close 和 AbortSignal。
- [x] 实现 OpenAI Realtime transcription Adapter。
- [x] 使用 `gpt-realtime-whisper`、24 kHz mono PCM16 和官方事件名。
- [x] 将 provider delta 映射为 `transcript.partial`。
- [x] 将 completed 事件映射为 `transcript.final`。
- [x] Adapter 保留 provider item ID 用于诊断，Gateway 按单轮 request ID 映射转写 Session。
- [x] Realtime 失败后自动使用累计 PCM 做批式 STT。
- [x] 批式 fallback 会先封装合法 WAV，不发送裸 PCM。
- [x] PTT 始终保留批式 STT 路径。
- [x] Streaming Adapter 和 Gateway 集成都有 Mock 测试。

启用方式：

```dotenv
STT_REALTIME_ENABLED=true
STT_REALTIME_MODEL=gpt-realtime-whisper
STT_REALTIME_DELAY=low
```

## P1：README 和展示证据 — 已完成

- [x] 重写英文 `README.md`。
- [x] 重写中文 `README.zh-CN.md`，不做逐句硬翻译。
- [x] 首屏说明“开口、转写、回答、播放、插话打断”。
- [x] 用 Stable / Experimental 区分成熟度。
- [x] 加入真实运行界面截图。
- [x] 环境变量下沉到 `docs/configuration.md`。
- [x] 生产运行下沉到 `docs/deployment.md`。
- [x] 浏览器限制写入 `docs/browser-support.md`。
- [x] 修正旧 Roadmap、Text-only、TTS 和 Session 恢复描述。
- [x] README 明确当前不是生产级托管服务。

## P2：生产运行入口 — 已完成

- [x] Gateway 使用 esbuild 生成 Node.js 单文件生产 bundle。
- [x] Web 使用 Next.js standalone 生产构建。
- [x] 根目录提供 `pnpm build`、`pnpm start` 和 `pnpm check`。
- [x] `NODE_ENV=production` 时缺少 LLM Key 会快速失败。
- [x] 校验端口、布尔配置、日志等级和 Realtime delay。
- [x] `TTS_ENABLED=false` 可以真正关闭 TTS，同时保留文字 LLM。
- [x] `ALLOWED_ORIGINS` 可以限制 WebSocket 浏览器来源。
- [x] Gateway 提供不调用模型的 `/healthz`。
- [x] Gateway 输出结构化 JSON 日志。
- [x] 日志包含 Session、Request 和阶段信息，不记录原始音频和完整转写。
- [x] 支持 SIGINT/SIGTERM 优雅关闭。
- [x] 提供 Gateway 和 Web 两个 Dockerfile。
- [x] 提供 `docker-compose.yml`。
- [x] 文档覆盖 HTTPS、WSS、反向代理和回滚。
- [x] Docker Gateway 与 Web 镜像均完成本机构建和容器冒烟验证。

验收命令：

```bash
pnpm check
docker build -f Dockerfile.gateway -t open-gpt-live-gateway .
docker build -f Dockerfile.web -t open-gpt-live-web .
```

## 已完成验证

- [x] 全 workspace 类型检查通过。
- [x] 8 个测试文件、41 个自动化测试通过。
- [x] Gateway 与 Web 生产构建通过。
- [x] 生产 `pnpm start` 启动通过。
- [x] `/healthz` 返回 200 和结构化状态。
- [x] 生产 Web 返回 HTTP 200。
- [x] 生产 WebSocket 可以建立 Session。
- [x] Chromium 完成文字流式对话验证。
- [x] Chromium 完成断线、Reconnecting 和自动恢复验证。
- [x] Gateway Docker 镜像启动及健康检查通过。
- [x] Web Docker 镜像启动及 HTTP 检查通过。

## 发布后人工验证

这些检查需要真实麦克风、扬声器、模型 Key 或不同浏览器，不能由无凭证的 CI 代替：

- [ ] 使用真实 OpenAI Key 完成一次 Realtime STT 端到端对话。
- [ ] 使用真实麦克风确认短句第一个字没有被截断或重复。
- [ ] 使用扬声器验证 TTS 回声与 barge-in。
- [ ] 在 Edge、Safari 和 Firefox 各执行一次浏览器冒烟测试。
- [ ] 分支推送后确认 GitHub Actions 通过。

这些是环境验收，不是缺失的 P0–P2 实现。

## P3：暂停，不执行

除非重新确认优先级，否则不开始以下内容：

### 工具调用

- [ ] 工具注册表。
- [ ] Function calling。
- [ ] 工具权限、超时和结果协议事件。

### 持久化记忆

- [ ] Memory Adapter。
- [ ] 会话数据库和真实 Session 恢复。
- [ ] 长期记忆、删除、过期和隐私边界。

### 其他暂不做事项

- [ ] 计费系统。
- [ ] 多租户管理后台。
- [ ] 复杂 Agent Workflow。
- [ ] 大规模插件市场。
- [ ] 默认引入向量数据库。
- [ ] Kubernetes 和多区域高可用。

P3 不会混入本次 Live Voice v0.2 提交。
