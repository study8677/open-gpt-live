# 本地 AI 配置

实验性的 `local-ai` profile 可以在没有 OpenAI Key 的情况下运行完整 HTTP Provider 链路：

```text
浏览器 -> Gateway -> Speaches/faster-whisper -> Ollama -> Speaches/Kokoro -> 浏览器
```

当前已完成配置校验和接口契约测试，但还没有在本仓库中完成真实本地模型、麦克风和外放验收。因此，跑完下方清单前，不应把它描述成“真实端到端已经验证”。

## 固定的第一版组合

| 层 | 运行时与模型 | 约需下载 | 选择原因 |
| --- | --- | ---: | --- |
| LLM | Ollama `0.30.8`、`qwen2.5:1.5b` | 986 MB | 小型多语言模型，提供 OpenAI-compatible 流式 Chat Completions。 |
| 批式 STT | Speaches `0.8.3-cpu`、`Systran/faster-whisper-small` | 486 MB | 多语言 faster-whisper，通过 `/v1/audio/transcriptions` 提供服务。 |
| TTS | Speaches `0.8.3-cpu`、`speaches-ai/Kokoro-82M-v1.0-ONNX` | 354 MB | 多语言语音，通过 `/v1/audio/speech` 输出浏览器可播放的 MP3。 |

模型约需下载 1.8 GB；容器镜像、缓存、镜像层和运行空间还会占用更多磁盘。实际内存和延迟与 CPU 架构关系很大，建议至少 8 GB 内存并预留数 GB 额外磁盘。仓库默认使用兼容性更好的 CPU 镜像，不提前承诺 GPU 性能。

这些模型有各自的许可证，不继承本仓库的 MIT License。重新分发或商用前，请查看对应模型页面。

## 一条命令启动 profile

需要较新的 Docker Desktop，或安装了 Compose v2 的 Docker Engine。

```bash
cp .env.local-ai.example .env
docker compose --profile local-ai up --build
```

第一次启动会拉取固定版本的 Provider 镜像，并由两个一次性初始化容器下载模型。启用 `local-ai` 时，正常成功路径上的 Gateway 会等待这两个任务；依赖被标为可选，只是为了让默认云端 profile 在没有本地服务时仍能启动。保持终端运行，看到任何初始化警告都应视为配置失败。后续启动会复用 `ollama-data` 和 `speaches-cache` 两个卷。

本地 Provider 本身不需要 API Key。明确指向非 OpenAI HTTP 地址时，OpenGPT Live 会省略 `Authorization`；指向 `api.openai.com` 时仍必须提供真实 Key。

### 数据边界

对话期间，浏览器音频会先到本机 Gateway，再进入本机 Speaches 容器；转写和提示词会进入本机 Ollama 容器。这个 profile 没有配置云端推理地址。首次安装仍会访问 Docker Hub、GitHub Container Registry、Ollama 模型仓库和 Hugging Face 下载镜像与模型文件。处理敏感数据前，仍应单独检查 Docker 与宿主机网络，尤其不要把共享电脑直接视为可信执行环境。

## 打开麦克风前先验证 Provider

新开一个终端：

```bash
docker compose --profile local-ai ps
pnpm local-ai:check
```

冒烟脚本需要本仓库要求的 Node.js 22.13+ 和 pnpm。它会检查服务健康和模型是否安装，读取一次流式 Chat Completions，生成一段中文 MP3，再把生成的音频提交给转写接口。它只验证 Provider 契约，不代表浏览器、麦克风、音质或延迟已经验收。

也可以单独检查各服务：

```bash
curl http://localhost:11434/api/tags
curl http://localhost:8000/health
curl http://localhost:8000/v1/models
curl http://localhost:8787/healthz
```

如果初始化容器失败，或缓存中的模型被删除，可以单独重新执行：

```bash
docker compose --profile local-ai run --rm ollama-model
docker compose --profile local-ai run --rm speaches-models
```

## 浏览器验收清单

打开 [http://localhost:3000](http://localhost:3000)，按顺序验证：

1. 发送文字，确认本地模型流式返回。
2. 按住说话，讲一句简短英文，确认转写与 MP3 播放。
3. 再讲一句简短中文。
4. 开启 Live Mode，等待 VAD 校准后完成一轮对话。
5. TTS 播放时再次说话，确认当前回答被打断。
6. 重启 `ollama` 或 `speaches`，确认请求会明确失败，并在服务恢复后重新成功。

`STT_REALTIME_ENABLED=false` 是有意设置。本地 profile 中，按住说话和 Live Mode 的最终 WAV fallback 使用批式 STT；当前不声称兼容 OpenAI Realtime WebSocket，也不会产生本地临时转写。

## 常用调整

- 英文 TTS 可改为 `TTS_VOICE=af_heart`；默认 `zf_xiaobei` 是中文女声。
- 如果需要更小的 LLM，同时修改 `OPENAI_MODEL` 和 `OLLAMA_MODEL`，两者必须指向同一个已安装 Ollama 模型。
- Ollama 首次加载模型后的第一轮可能明显慢于暖机轮次。profile 默认设置 `OLLAMA_KEEP_ALIVE=15m`；应根据可用内存调节，不要把冷启动结果当成稳态延迟。
- 如果本机 Ollama 或其他服务已经占用端口，可以修改 `LOCAL_AI_OLLAMA_PORT` 或 `LOCAL_AI_SPEACHES_PORT`，并同步修改冒烟脚本使用的 `LOCAL_AI_*_URL`。容器之间的 Provider URL 不需要变化。
- 如果 Gateway 不在 Compose 中，而是直接运行在宿主机，把 Provider 主机名从 `ollama`、`speaches` 改为 `localhost`。
- 本地 Provider 没有鉴权，profile 只把端口绑定到 `127.0.0.1`。不要在没有网络控制与鉴权时公开暴露。

停止服务但保留模型：

```bash
docker compose --profile local-ai down
```

只有确认要重新下载模型时才删除卷：

```bash
docker compose --profile local-ai down --volumes
```

## 官方资料

- [Ollama Docker](https://docs.ollama.com/docker)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama Qwen2.5 模型库](https://ollama.com/library/qwen2.5)
- [Speaches 仓库](https://github.com/speaches-ai/speaches)
- [Speaches 安装文档](https://speaches.ai/installation/)
- [Speaches STT 文档](https://speaches.ai/usage/speech-to-text/)
- [Speaches TTS 文档](https://speaches.ai/usage/text-to-speech/)
- [SYSTRAN faster-whisper small](https://huggingface.co/Systran/faster-whisper-small)
- [Speaches Kokoro ONNX](https://huggingface.co/speaches-ai/Kokoro-82M-v1.0-ONNX)
