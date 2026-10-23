# Oh My Pi 可选执行器设计（第一阶段）

状态：待设计确认；本阶段只新增本文，不实现 runtime、不修改 AGENTS.md 或 VISION.md。

## 结论与版本基线

可行。把 omp 当作拥有自身工具、agent 循环和任务调度的执行器，通过 RPC 适配到现有 `AgentRuntime`，而不是把它降为 Rakazo 的另一个模型 SDK。Rakazo 继续拥有 bot、Space、连接、产品工具、run 租约、消息和用量持久化。omp 原生工具直接执行，不接入 Rakazo 审批或污点判断；所有进入 Rakazo 的日志、事件和可持久化诊断仍须脱敏。

建议第二阶段采用：**每 run 一个本机子进程、每 bot 独立工作目录、Rakazo 每轮重放文本历史、等待整个会话 settled 后结束 run**。保留 Pi 默认值，增加 bot 可选覆盖；容器传输、跨崩溃继续执行和插件管理 UI 后置。后台子 agent 在同一个 run 内运行并显示，首轮回答完成时不提前回收进程。

调研日期：2026-10-22。上游 main 的取样提交为 [`0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0`](https://github.com/can1357/oh-my-pi/tree/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0)，该提交 coding-agent 包版本为 `18.12.6`。后续实现须锁定已验证版本并维护协议夹具，不能假设任意版本的 `omp` 兼容。此报告为静态源码调研，尚未安装或运行真实 omp、模型、插件或容器。

Rakazo 基线：`fbd707c5a29b4f4473f8ead64767bae3dba10f91`。关键本地证据：

| 位置 | 已确认行为及设计影响 |
| --- | --- |
| [adapter-kit/interfaces.ts](../packages/adapter-kit/src/interfaces.ts)、[types.ts](../packages/adapter-kit/src/types.ts) | runtime 返回异步事件流；没有 error、cancelled 或 detached-run 事件；`CommandRequest` 没有可持续写入的 stdin。 |
| [executor.ts](../packages/adapters/src/executor.ts) 的 runtime 调用和事件消费部分 | 非 scripted 模式中 `tool` 事件只用于展示/审计，实际调用经 `executeTool`；迭代结束后完成 run；`ask`、`takeover` 会进入持久暂停路径；`checkpoint` 当前没有对应消费分支。 |
| [pi-runtime.ts](../packages/adapters/src/pi-runtime.ts)、[runtime-context.ts](../packages/adapters/src/runtime-context.ts) | Pi 特别处理 ask、takeover、secret pause、子 agent；历史本就不是完整的原生工具 transcript；已有多种上下文策略。 |
| [tool-selection.ts](../packages/adapters/src/executor/tool-selection.ts)、[run-instructions.ts](../packages/adapters/src/executor/run-instructions.ts) | 工具和提示词必须一起按 runtime 选择；只过滤 request.tools 会留下 shell、路径、电脑等旧指令。 |
| [pi-usage.ts](../packages/adapters/src/pi-usage.ts)、[tool-completion.ts](../packages/adapters/src/executor/tool-completion.ts) | 已有 producer-side 用量回调和仅记录元数据的工具审计，应该复用。 |
| [worker/index.ts](../apps/worker/src/index.ts)、[api/app.ts](../apps/api/src/app.ts)、[api/env.ts](../apps/api/src/env.ts) | worker 和 API 两处 composition root 都选 runtime，不能只改 worker。 |
| [docker-sandbox.ts](../packages/adapters/src/docker-sandbox.ts)、[supervisor/index.ts](../infra/sandboxes/supervisor/src/index.ts)、[computer/Dockerfile](../infra/sandboxes/computer/Dockerfile) | `/exec` 是单向输出流；内部 Docker helper 已有有限 stdin 用法，但没有对外双向常驻进程通道。 |

下文的“已支持”来自固定提交的源码/文档；“建议”是 Rakazo 的设计选择；“待验证”不作为已实现能力。

## 1. RPC、事件映射与完成语义

### 启动与状态机

`omp --mode rpc` 使用自定义 JSONL，不是 JSON-RPC 2.0。先读 `ready`，校验协议和帧上限，协商 v2，再配置模型、宿主工具、事件过滤和子 agent 订阅（`level:"events"`，兼顾展示和逐调用用量），最后发送带唯一 `id` 的 `prompt`。不要把命令 response 当成模型完成。原型使用 `--no-ui`，不开放交互登录。[O1][O2]

v2 会把大 stdout 消息编码为 `rpc_chunk`：必须校验连续编号、chunkId、数量、总字节数、base64 和 UTF-8，限制重组内存；stdin 始终是单条未分片 JSONL，不能把 v2 stdout 分片格式用于输入。`messageUpdates: "delta"` 可减少重复快照，但不取消 `message_end` 的完整内容及大块消息。输出和错误流必须持续消费，有界排队并处理背压；不能让展示端阻塞宿主工具回复。[O1][O3]

建议状态：`starting → configuring → prompting → active ↔ yielded-with-work → draining → completed`，另有 `pausing / aborting / failed`。一个进程只接收一个 Rakazo run；同 run 的用户 steering 用 `steer`，不会启动第二个独立 prompt。先复用现有 bot/run 租约约束，并保证同一 bot 工作目录不出现两个写入者。生成显式且版本固定的运行配置，确认 async.enabled、task.batch、并发上限及超时；不能仅依赖 RPC 的 protocolDefault 或本机交互配置来决定后台 task 是否启用。

### 事件对照

不是所有 omp 帧都能无损一一对应；下表明确每类的输出、合并和有意忽略。所有进入日志、事件和可持久化诊断的文本与结构化字符串走同一脱敏边界。宿主工具的原始参数只在受信、受 scope 约束的内存 dispatch 中保留，以维持校验、幂等身份和实际执行语义；不能先脱敏再调用 executeTool。

| omp 帧/事件 | Rakazo 映射和处理 |
| --- | --- |
| `ready`、`response`、`rpc_chunk` | 仅协议控制/重组；按 `id` 匹配 pending 命令，不产生聊天事件。拒绝配置失败、缺失必要能力和无效帧；超时不等于成功。 |
| `agent_start`、`turn_start` | 内部活动状态；不要都映射 `turn`，否则重复分隔。 |
| assistant `message_start` | 产生一次 `turn`；按进程实例与 messageId 去重。user、toolResult 消息不产生 assistant turn。 |
| `message_update.assistantMessageEvent.text_delta` | `text { text: delta }`；按 messageId/contentIndex 累积。不能把累计快照和 delta 同时追加。 |
| `thinking_*` | 只更新内部活动状态，必要时用已有 `progress { activity: true }` 表示正在工作；原型不把原始思考内容当回答展示或存储。 |
| `toolcall_start/delta/end` | 暂存完整工具参数/预览；不执行工具，也不重复产生 `tool`。 |
| `tool_execution_start` | `tool { name, args, executionId }`，覆盖原生和宿主工具；executionId 由 run/agent/toolCallId 稳定派生，命名不携带凭据。事件只观察，绝不再次执行 omp 原生工具。 |
| `tool_execution_update`、`tool_stream_update` | 提取有界、脱敏的活动摘要为 `progress { activity: true }`。现有契约没有逐工具 stdout、diff 或结果事件；原型不增加伪造文本回答。 |
| `tool_execution_end` | 去重后调用 `onToolCompleted`，记录名称、耗时和成功/错误元数据，不保存 raw result；宿主桥和此事件只能有一个审计完成责任方。原生工具失败通常让模型自行处理，不立即终止整个 run。 |
| assistant `message_end` | 对账最终文本并记录一次 `usage`；若仅有终态而没有任何 delta，可补发文本；已发送内容不再整体重放。若终态和已发内容矛盾，记有界诊断并失败，不能静默重复/拼接。 |
| `turn_end`、`agent_end` | 内部状态和终态校验；不产生 `done`，不再次计费。`isTerminal:false` / `yielded` / `awaitingAsyncWork` 用于理解继续执行与等待后台的区别。 |
| `prompt_result` | 用 prompt id 关联结果；completed 是此次 prompt 已让出控制权，error 通过异步迭代器抛脱敏错误，aborted 走取消路径。`sessionSettled:false` 保持事件流。 |
| `session_settled` | 与本 run 已接受 prompt 的成功结果共同构成完成候选；结清宿主调用、用量回调和子 agent 终态后，产生一次 `done` 并关闭流。 |
| `subagent_lifecycle` | started→`subagent.running`，completed→completed，failed/aborted→failed；现契约无 cancelled，aborted 在 progress 中说明取消。agentId 加 run 命名空间。 |
| `subagent_progress` | 按 index/id 注册表关联已有 lifecycle，输出 `subagent` 最新 progress；缺失 task 时由 snapshot 补齐，不能把 index 单独当跨 run 身份。 |
| `subagent_event` | 子 assistant `message_end` 用于独立 usage，文本摘要进入该 subagent 的 progress/result；绝不混进根回答。子工具事件关联子身份；现有根级 tool 事件无法表达完整父子树，先保留关联元数据及子卡片。 |
| `auto_retry_start/end`、`auto_compaction_start/end` | 有界 `progress`；内部重试/压缩尚未 settled，不能提前完成。原型关闭自动压缩，详见用量限制。 |
| `cache_warming_start/end`、advisor、fallback 事件 | 原型关闭缓存预热、advisor 和自动模型回退；若意外发生，不应静默漏记费用或切模型。正式支持须提供相应 usage 来源与 `onModelChange`。 |
| `notice`、`extension_error`、`rpc_frame_error` | 脱敏后的内部诊断；持久化失败、传输溢出和导致契约不完整的错误使 run 失败。普通通知可合并到 activity；不把任意插件通知自动变为面向用户消息。 |
| `queue_update`、todo、goal、model/thinking/config changes、commands 更新 | 原型只维护必要内部状态/一致性检查；不映射新 UI。未经允许的模型切换应失败。goal/live/btw 不启用。 |
| `command_output`、`session_info_update`、`config_update`、IRC/规则提醒等 | 原型不开放对应命令；理解的内部状态才消费，其余有界诊断。未知非关键事件可以忽略，未知控制请求必须明确失败/取消，不能永久等待。 |
| `extension_ui_request` | 原型 `--no-ui`，保持原生 ask dialog 关闭；意外收到可回复请求则取消并诊断。需要用户输入统一走 Rakazo `ask_user` 桥。不能直接把任意 RPC dialog 映射为 `ask`，因为现契约没有返回答案给存活进程的通道。 |
| `host_uri_request/cancel` | 原型不注册宿主 URI；无权限/未知 scheme 返回错误，后续可用于资源读取。 |

源事件定义及 subagent 载荷见 [O2][O4][O5]。`checkpoint` 不直接映射任何 omp 事件：omp session 文件引用不等于 Rakazo 可恢复 checkpoint，而且 executor 当前不消费该事件。不能声称发出它就实现了恢复。`ask` 和 `takeover` 仅来自明确的产品暂停语义，见工具桥。

### 三个完成层级

1. **模型/agent 一次执行结束**：`agent_end`；可能仍在重试、压缩、等待任务或继续执行，不足以完成 Rakazo run。
2. **本 prompt 完成**：成功 response 通常只是接收确认；其后 `prompt_result` 才表示此次 prompt 的 outcome。同步本地命令若 response 带 `data.agentInvoked:false`，没有后续 prompt_result。原型将普通用户文本包装后发出，避免用户输入以 `/` 开头时意外执行会话命令；不开放任意 slash command。
3. **所有可能唤醒会话的工作清空**：`prompt_result.sessionSettled:true`，或在 `sessionSettled:false` 后收到 `session_settled`。此时才允许 `done`。成功还要求没有未完成宿主调用/未结算 usage、没有活跃子 agent，且未观察到失败。若插件制造不能 settle 的工作，由显式 run 总时限或用户取消结束，不伪报完成。[O1][O6]

后台子 agent 活动期间，Rakazo run 保持 running，Web 复用 `thread.subagent` 的卡片显示 running/completed/failed，根文本可以继续流出。根回答完成但子 agent 仍在工作，不另外宣称一个已完成的 run。真正“父 run 完成、子 agent 跨 run 存活”需要独立持久化任务及独立事件所有者，放到后续阶段；当前事件迭代器关闭后不能继续发布该 run 的事件。

### abort 与暂停

`abort(runId)` 和 context.signal 共用幂等取消逻辑。先禁止新宿主调用，发送有 id 的 `abort`，取消已知子 agent（`cancel_subagent`）及原生 shell/retry 工作（必要时 `abort_bash` / `abort_retry`），让 stdout 继续排空并收集已产生的 usage。`abort` 的成功 response 只说明命令处理成功，不等于所有后代已退出。短宽限期后关闭 stdin，再按进程组 TERM/KILL 升级；传输必须确保后代也被回收。取消期间不发成功 `done`；向 executor 保留已有取消/失败语义。迭代器提前 return、租约丢失和 worker 关闭也必须执行 finally 清理。

`host_tool_cancel.targetId` 指向宿主请求 id，标记该调用已取消并丢弃晚结果。当前 `executeTool` 没有逐调用 AbortSignal，只能依赖整个 run 的 context.signal；无法保证一个正在执行的独立外部副作用被撤回。若单次取消需要硬取消，应以可选 signal 参数扩充共享 callback，由受支持工具实现；原型不作撤销承诺。

ask、secret 或审批暂停是 `pausing`，不能被进程退出覆盖为普通错误：先中止 omp 后续工具/模型工作，保留产品暂停结果和审计，然后关闭进程，让 executor 现有暂停/续跑路径接管。后续新 run 用 Rakazo 新历史重放，不等待旧 omp 的 UI 回答。

## 2. 工具所有权与宿主桥

### 桥接规则

先通过 Rakazo 现有 selector 完成 Space、bot、连接、触发类型和禁用工具过滤，再按 omp 工具所有权过滤，最后调用 `set_host_tools`。`ConnectorTool.inputSchema → parameters`，保留 description；route、connection 和内部授权元数据只在 worker 的注册表内，不能塞给模型。原型将需要的宿主工具设为 `loadMode:"essential"`，避免注册成功但只在动态目录中出现而无法验收；后续再优化大型连接工具目录。[O1][O7]

默认保留未冲突的宿主名称，冲突时只对宿主 wire name 加 `rakazo_` 前缀并保存可逆映射；注册前检测两个目录的重复与别名碰撞。提示词工具表必须使用实际 wire name，不能直接搜索替换 bot 原文指令。适配后的产品工具说明明确实际名字，结构化生成的提示段不再引用已去掉的工具。原型关闭 omp 的重复产品能力（记忆存储、自动学习、技能写入、图像生成等），保留 Rakazo 的产品版本；不能让同名工具注册失败后静默少一个工具。

收到 `host_tool_call { id, toolCallId, toolName, arguments }` 时：校验注册表和参数；建立去重 pending 表；调用 `request.executeTool(originalName, arguments, executionId, route)`；把结果转为 `AgentToolResult {content, details}`；用同一个宿主请求 `id` 发 `host_tool_result`。对象默认编码为 text JSON；已有 `agent_tool_result` 转为 omp 支持的文本/图片内容，图片遵守模型能力和帧限额。异常转为 `isError:true` 的脱敏文本，不能序列化原 Error、headers、env 或任意 details。`toolCallId` 用于工具身份，`id` 用于回复，两者不能混用。[O7]

读取循环不能 await 宿主工具完成：每个调用进入任务表，串行发送器负责 stdout 对端的 stdin 写入，允许继续读到 abort、cancel 和其他结果。对同一副作用的重复 frame 返回已有结果/状态，不能重复 dispatch。`host_tool_update` 可发 `partialResult`，但当前 `AgentToolExecutionObserver` 只支持 shell 后台完成通知，并不提供通用产品工具进度；原型不假称有通用 update 来源。

`ask_user` 和 `request_takeover` 的 Pi 特例必须明确移植：目前不是简单 `executeTool` 就能工作。建议共享一个很小的产品暂停适配 helper，ask→`ask`，takeover→`takeover`；普通宿主工具全部经 `executeTool`。识别已有 `isToolPauseResult`（包括凭据和审批暂停），不得把 paused 对象作为普通成功结果交给 omp 继续执行。omp 自带工具无需调用 Rakazo 审批；宿主工具复用现有 dispatch/审计，不另造批准流程。

### omp 模式下的 Rakazo 工具清单

以下覆盖当前 [builtin-tools 目录](../packages/contracts/src/builtin-tools.ts)。删除指**不向 omp 注册**，不删除工具实现或影响 Pi 模式。

| 处理 | Rakazo 名称 | 理由/前提 |
| --- | --- | --- |
| 去掉：文件与命令 | `list_files`, `read_file`, `write_file`, `shell` | omp 的 read/write/edit/find/glob/grep/bash/LSP 等直接执行。 |
| 去掉：子 agent | `run_subagent` | 使用 omp task/agent/hub 生命周期；Rakazo 的 bot/fleet 是不同概念。 |
| 去掉：浏览器与电脑 | `browser_navigate`, `browser_snapshot`, `browser_act`, `computer_observe`, `computer_act`, `open_path`, `launch_app` | 使用 omp Eval browser/computer 能力，避免操作两套机器。第一版本机只承诺代码工作，不承诺与 Web 电脑画面一致。 |
| 去掉：检索重叠 | `web_search`, `web_fetch` | omp web_search、read URL 和 browser 负责；原型不同时暴露两套搜索/抓取。原生搜索的 provider 依赖必须单独声明，不能假设 keyless 可用。 |
| 保留：用户、账户与凭据 | `message_user`, `ask_user`, `request_takeover`, `connect_app`, `request_secret`, `list_secrets`, `secret_request`, `forget_secret`, `add_mcp_server` | 产品消息、暂停、凭据和安装状态归 Rakazo；凭据结果仍按原有权限及脱敏契约。 |
| 保留：持久记忆/历史/任务上下文 | `remember`, `save_shared_memory`, `search_history`, `read_history`, `task_catalog`, `scratchpad_list`, `scratchpad_add`, `scratchpad_update`, `scratchpad_complete`, `scratchpad_remove` | 复用 bot/Space 授权及现有存储；omp 独立记忆/自动学习先关闭。 |
| 保留：工单与定时任务 | `board_tickets`, `ticket_get`, `ticket_create`, `ticket_update`, `ticket_comment`, `schedule_create`, `schedule_list`, `schedule_cancel` | Rakazo 持久工作流和调度。 |
| 保留：Skills 与身份维护 | `skill_read`, `skill_create`, `skill_update`, `skill_delete`, `propose_instructions_update` | 产品技能源和 bot 身份继续归 Rakazo。 |
| 保留：fleet/跨 bot | `spawn_bot`, `update_bot`, `list_fleet`, `create_group`, `update_group`, `organize_bot`, `set_child_instructions`, `set_child_bot_model`, `create_child_routine`, `archive_bot`, `message_bot`, `handoff_to_bot` | 创建/编排持久 bot，不和 omp 短生命周期子 agent 合并。 |
| 保留：条件工具 | `connect_agent`, `respond_agent_connection`, `message_agent`, `cloud_agent_launch`, `cloud_agent_status`, `cloud_agent_reply`, `cloud_agent_cancel` | 外部 agent 连接/远程执行器是已有产品能力，仍按现有配置出现。 |
| 保留：交付与媒体 | `attach_file`, `render_plot`, `generate_image`, `generate_video` | 给 Web 对话交付附件/媒体，不只是写磁盘；关闭 omp 重复生成能力。 |
| 保留：应用连接 | 本 run 已授权的 ConnectorTool 及 lazy catalog | 转 `executeTool`，不要把整个连接目录或全空间工具暴露给 omp。 |

保留不代表无条件注入：现有 schedule/group/fleet/图像/消息渠道/disabledBuiltinTools 等过滤继续生效。若用户禁用了 Rakazo shell，却选择完整 omp 执行器，需要把这类开关语义明确为“Rakazo 宿主工具”，或在 runtime capability 配置中同步关闭对应原生工具；不能误称旧开关控制 omp 的全部文件和命令能力。

文件、附件、Skills 的位置必须同时调整：本机 omp 的 cwd 不是 `SandboxProvider` 的电脑文件系统。原型以 `AgentHomeStore` 的 bot 工作目录为本机工作源，附件输入按现有 ArtifactStore 授权下载到该 cwd，`attach_file`/`render_plot` 通过一个内部的 run workspace 访问适配读取实际本机文件再上传。该适配只覆盖保留工具所需的文件访问，不扩充成第二套全功能 SandboxProvider。若不实现此小桥，必须暂时不注册这些依赖电脑路径的工具并在验收写明；不能把不存在于容器的本机路径交给现有 handler。原型建议实现附件桥，主验收先使用文本和记忆。

## 3. 提示词、历史与会话所有权

### 原型：Rakazo 每轮重放

采用新进程/新会话；通过受限临时文件 `--append-system-prompt <file>` 传本轮 `request.instructions`，保留 omp 默认工具使用指导。不要直接以 CLI 文本参数传整段身份/记忆，也不要以 `--system-prompt` 覆盖默认工具策略。源码确认普通 system-prompt override 并非 SDK 的完全替换，它仍拼接生成区块；append 与 override 的语义不同。[O8]

executor 先按实际 runtime 生成 instructions：保留身份、记忆、共享上下文、群组、产品规则；替换 `persistentComputerInstruction`、Docker 路径和 shell/browser/subagent 用法为真实 omp cwd/能力；bot/Space 边界和保密要求保留。不要在 adapter 里对最终 instructions 做脆弱的全文替换。

RPC 没有 `set_history` 或 `set_system_prompt` 命令。[O2] 原型将 `request.history` 编码成带明确 role、id 的 JSON/分隔历史数据块，与当前 prompt 分开，合成**一次** user prompt；它不是若干 prompt 连续发送，不能触发历史重跑。遵循已有 Pi 去重当前用户消息的规则；summary/system 历史块保留为历史数据，不提升为新系统指令。当前图片转为 RPC `images` 的 base64 ImageContent；历史图片和多模态重放单列为后续支持，不能默默丢失后宣称完全兼容。

取舍：这一做法和当前 Rakazo 已压缩、文本化的历史契约接近，重启简单，历史/记忆仍有一个产品事实源；缺点是 role 只是文本标记，丢失原生 assistant/tool 配对、签名思考、插件状态和缓存连续性。必须在测试覆盖多轮记忆、summary、重复 prompt、role 分隔和 slash 前缀；不把此方案宣传为原生 session 等价。若历史超过单条 stdin 帧限额，使用既有 Rakazo 摘要/上下文预算；不无界截断或自己发 rpc_chunk。不能满足预算则明确失败。

### 后续：omp 原生持久会话

按 `(spaceId, botId, threadId)` 绑定 sessionId/sessionFile，不能一个 bot 所有 thread 共用一个会话。每次恢复只发送上次确认游标之后的新用户输入，不再重放全历史；保存已经同步的消息 ID、配置/身份版本和用量去重信息。身份或记忆变化必须通过会话重建/显式扩展同步，RPC 原生无动态 instructions setter。一次进程可 resume 持久 session，并不要求 bot 常驻。

优点：保留原生工具 transcript、压缩、插件/agent artifacts 与缓存；缺点：Rakazo 和 omp 两份历史必须对账，线程删除/编辑/压缩、空间迁移、身份变更、暂停恢复及灾难恢复更复杂。不能同时默认加载原生全历史、再把 Rakazo 全历史塞进去。

此外，task 子 agent 不继承 append-system-prompt，也会过滤部分 AGENTS.md 上下文。[O8] 因而不能假设 bot 身份/记忆和所有产品规则自动到达子 agent：原型让根 agent 调用产品记忆/凭据工具，子任务 brief 必须自包含；之后通过受控 agent 定义/扩展注入子级身份与权限，并验证 `task(...tools)` 桥的继承行为。不把根进程凭据与产品全部工具自动下放给任意插件/子 agent。

## 4. 模型与凭据

omp 的 `set_model` 只接受 provider/modelId，不接收 apiKey/baseUrl。[O2] 建议启动前在每 run 的隔离 agent 配置目录生成 `models.yml`，用 `PI_CODING_AGENT_DIR` 指向它，显式 argv 数组选择 provider/model，必要时再用 `set_model`/`get_state` 确认实际选择。隔离配置目录不能加载运行 worker 的个人 omp 配置；仅覆盖 agentDir 不足以隔离所有 HOME/外国 provider 发现，需设置专用 HOME/XDG 配置根及显式能力来源，工作产物仍放 bot cwd。[O9]

apiKey 在配置中只写一个运行时环境变量名，例如 `RAKAZO_OMP_MODEL_KEY`，由 worker 从 `request.model.apiKey` 填入该子进程环境；它是内部通用交接，不是新的 provider/model 部署环境变量。omp 的 resolver 优先查环境变量再按字面量回退，所以启动前必须检查变量存在，不能把变量名当 key 发出去。不要用 `--api-key`（argv 可见）、明文写 models.yml/auth 文件、shell 拼命令或打印 spawn env。[O9][O10]

| Rakazo 连接 | omp 配置与范围 |
| --- | --- |
| `openai-compatible` | 显式 custom provider/model，`api: openai-completions`，按已有规范化后的 baseUrl（包括 `/v1`）传入；映射 contextWindow/maxTokens/reasoning/acceptsImages/maxImagesPerPrompt 及标准 reasoning effort 能力。不要从模型名字猜协议。 |
| OpenRouter | 优先 `openrouter` provider 的 catalog/model，并覆盖该连接的 key/baseUrl；非 catalog id 可配置显式模型。保留原始模型 id，不能错误拆掉厂商前缀。 |
| 已支持的直连 API-key provider | 在 adapter 中将 Rakazo provider 映到 omp canonical provider/API；Anthropic、OpenAI 等不能一律当 chat completions。目录缺失时需明确模型定义。 |
| 本地无 key 兼容接口 | `auth:none`，连接设置给出 URL/模型/能力；不得暗中使用宿主个人 key。 |
| 网关、自定义 header 或特殊路由 | omp 配置支持 baseUrl、headers、compat 和模型覆盖；但能否由当前 AgentRunModel 完整表达要逐类核对。已有 Cloudflare account/gateway 等须在 adapter 翻译，第一版未支持的组合显式拒绝。 |
| OAuth | omp 有自身 AuthStorage/刷新体系，但 RPC 没有把 Rakazo OAuth persist/retire 回调跨进程连接的通用命令。第一版只接受 API-key/无 key 连接；不能悄悄复制 refresh token 到另一份 auth 存储或承诺完整 OAuth 等价。后续用宿主 credential broker 或 Bun launcher 做刷新回写。 |

模型选择事实源仍是 Rakazo。原型显式限制 enabled providers/models、辅助角色使用同一被选模型，并关闭自动模型 fallback、advisor、预测、预热及隐藏辅助调用；不引入第二套必须由用户配置的 provider 凭据。`fallbackModels` / `onModelChange`、OAuth、某些扩展的角色模型暂不支持，必须在运行前检测并说明，不能中途未经记录换模型。[O9][O11]

对 baseUrl 的已有共享校验继续执行，`allowPrivateEndpoint` 的语义需保留。但 omp 自身网络栈不等于 Pi 中现有 DNS/重定向 guard；原型将连接范围限制到已验证配置，不宣称完全相同的网络隔离。用户已允许原生工具绕开审批，此差异不阻止原型。

凭据保密边界：只允许最小环境集合，剔除 worker 数据库、签名、应用连接等无关秘密。API key 在 child env 对同进程树可见，这是本机完整执行器的固有能力；不当成安全隔离。所有 stdout/stderr、异常、工具参数/结果、插件错误、子 agent 事件和字段（包括 name/id）进入日志/事件前脱敏，复用 `runSecrets` 与 SecretStore；流式用现有跨 chunk redactor，不能逐段替换而漏掉拆分 key。不要记录 raw JSONL、完整环境或 provider request dump；私有临时文件也不能被上传为调试附件。测试用虚构秘密覆盖拆分、回显、失败和取消路径。

## 5. 用量、费用与归属

从 assistant `message_end.message.usage` 取最终数据，不从 text 增量估算、不累计 message_update 快照。根及子 agent 分开；错误/取消若仍有终态用量也记录。[O4][O12]

| omp Usage | AgentUsage |
| --- | --- |
| `input` | inputTokens（已排除缓存，不再减 cacheRead） |
| `output` | outputTokens（包含 reasoning） |
| `cacheRead`, `cacheWrite` | cacheReadTokens、cacheWriteTokens |
| `cttl.ephemeral1h` | cacheWrite1hTokens，未提供则 unknown |
| `reasoningTokens` | reasoningTokens；不再加到 output/total |
| `totalTokens` | totalTokens；若有 orchestration 额外量，保留 provider 总量，不强求等于四桶之和 |
| `cost.total` | 有可信定价或 provider 来源时为 costUsd；否则 null |

omp Usage 还可能有 server tools、credits、premium requests 和 orchestration 等 Rakazo 契约不能完整表示的量，后续按真实连接扩充结构化字段；不能折成虚构美元。omp 为自定义模型产生的零价格通常只是未知定价，不能据此报告免费。标明 usageSource、costSource、pricingVersion；catalog 价格为估算，账单价格和订阅计量不是一回事。[O12]

先 await `request.onUsage(event)`，成功后 yield `accounted:true`；没有回调时普通 yield，由 executor 记账。回调失败不能吞掉：保留同一 callId 的未记账事件进入消费者补偿路径，再传播失败；记录方以 callId 幂等，避免回调已落库但返回失败时双计。若流已取消，则需要 producer 的有界持久重试/失败记录，不能声称发进无人消费的队列就完成记账。继续复用 `recordUsage`：spaceId/userId/botId/runId/parentRunId 来自可信 run/context，绝不信任 omp 参数里的空间或 bot ID。根 operationKind 默认使用请求分类，setup/compaction 等非 answer 分类优先保留；仅默认 answer 时，OMP 必须根据完整 assistant 工具调用及随后的结果建立显式分类状态：包含 search_history/read_history 的模型调用及消费其结果的紧随调用标为 retrieval，之后恢复默认；独立工具执行本身不新增模型费用。现有 pi-usage.ts 的分类器依赖 Pi Context 且为私有实现，不能直接套用；可抽取纯结构化工具名判定供两者复用，并用 RPC 夹具验证与 Pi 相同的边界。子 agent 始终用 subagent 和 agentId，优先于 retrieval。

去重键至少是 `(runId, processInstance, agentId, messageId)`；原型进程内计一次，重启恢复则需要 session entry/response 身份和持久唯一约束。不得同时把 message_end、agent_end.messages、get_session_stats 和 task 聚合 usage 各算一次。订阅 `events` 获取子 assistant 逐次用量；子事件未提供根级 RPC messageId 时使用子 transcript entry/response 身份，原型至少以每子事件序号及单路收集去重，禁止另加 task 汇总。

**RPC 没有承诺全部内部模型调用都有逐次 usage 帧。** 自动压缩、advisor、图像描述、学习、插件独立发起的 LLM 调用可能不走根/子 message_end。原型关闭自动压缩、预热、advisor、自动记忆/学习、预测和图像描述等隐藏调用，默认只验收文本；固定版本下核对任务路径。以后若启用这些能力，需要扩展/launcher 提供完整 provider 调用观察器；无法观测的费用标为未覆盖。`get_session_stats` 只用于对账，不能用累计差值冒充逐调用归属。进程在终态帧前死亡时仍可能已产生 provider 费用，记录为用量未知，不能报告零。

## 6. 进程模型、可替换传输和容器

### 本机：每 run 进程优先

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| 每 run 启动 `omp --mode rpc` | 生命周期对齐现有迭代器、租约和取消；凭据/工具/身份每轮更新；无常驻跨 thread 状态串扰；崩溃影响单 run。 | Bun/native/插件/LSP 冷启动；重放历史损耗缓存；必须等后台任务 settled；需限并发。 |
| 每 bot 常驻 | 热插件/LSP/浏览器、低延迟，支持后台 agent 长期活动。 | bot 有多个 thread，必须额外按会话串行切换或每 thread 多进程；凭据轮换、暂停、租约转移、内存配额、空闲回收与事件归属都更复杂。一个 bot 一个进程并不能自然支持并行 thread。 |

建议目录：`$DATA_DIR/omp/workspaces/<spaceId>/<botId>/` 为 bot 工作目录；每 run 独立的受限配置/临时 HOME 在工作产物之外。权限目录 0700、临时配置 0600；检查路径/符号链接不能跨 bot/Space；运行同一 bot 的代码任务串行。目录分开不等于 OS 隔离。`AgentHomeStore` 的 checkout/commit 生命周期需要接在实际本机目录，不能继续只 checkpoint 原先的电脑容器。长远并行写入通过 omp worktree/task isolation，多个持久 bot 的协调归 Rakazo。

首版可使用 `--no-session` 并保留 bot 工作文件：避免把可能含原始工具结果的 omp transcript 当作已脱敏事件库。此模式仍可能产生配置、缓存或 artifacts，必须核对和清理；如为调试显式开启持久 session，限制存储和权限、不提交/上传原始 transcript。每 run 完成/取消都删除临时配置与 HOME；工作产物按既有 home 生命周期保留。

### 传输接口草案

接口放 adapter 的协议边界，RPC runtime 只读写字节，不知道本机 child_process 或 supervisor。以下只是设计伪代码，不是本阶段代码变更：

```ts
interface RunnerProcess {
  processId: string;
  events: AsyncIterable<
    | { type: "stdout" | "stderr"; data: Uint8Array }
    | { type: "exit"; code: number | null; signal?: string }
  >;
  writeStdin(data: Uint8Array): Promise<void>; // 完成表示背压已接收
  closeStdin(): Promise<void>;                // 半关闭，仍可读 stdout
  terminate(signal: "TERM" | "KILL"): Promise<void>; // 含后代
  dispose(): Promise<void>;                   // 幂等清理
}
interface OmpTransport {
  start(spec: RunnerLaunchSpec, context: AdapterContext): Promise<RunnerProcess>;
}
```

`RunnerLaunchSpec` 是受信 composition root 生成的 executable/argv/cwd/env/limits；不要由模型选择可执行文件。Node 本机实现用 `spawn`、`shell:false`、pipe stdio、受控 cwd/env、进程组清理。runtime 管 JSONL、相关 id、状态机、工具桥和语义超时，transport 管进程/字节/背压。默认协议不依赖完整 omp SDK 包，以免把 Bun/native 带进 Node worker；维护有界 decoder 和所需帧 schema，锁定 wire fixtures。若复用上游 RpcFrameDecoder，先验证其 Node 导入不拉起 Bun-only 依赖。

### 后续容器通道

为 `SandboxProvider` 新增**可选** `openProcess(computer, request, context): Promise<RunnerProcess>` 能力；保持原 `execute`，没有此能力的 provider 显式报 unsupported，不退回不支持 stdin 的伪实现。request 包含 argv/cwd/env/unsetEnv 和 idle/max-lifetime/帧与队列限额，`pty:false`。OmpTransport 的 sandbox 实现仅把请求映到该接口，runtime 无改动。

建议 supervisor 使用受内部认证保护的 WebSocket：

1. `POST /computers/:id/processes` 创建 run/bot/Space 绑定进程和短期 attach 凭证；响应 opaque processId，不能把秘密放 URL。控制连接用既有 service auth + scope/fence；此接口只给 worker，不能给浏览器任意进程执行入口。
2. `WS /computers/:id/processes/:processId/stdio`，通过受保护 header 认证/附着。客户端发 `{type:"stdin", data:<base64>}`、`stdin_end`、`signal`；服务端发 stdout/stderr 字节帧、exit、协议 error。write ack/序号和窗口控制提供背压，限制缓冲和总帧长，保留 UTF-8 跨帧边界给上层 decoder。stdout/stderr 必须分流，非 PTY，Docker multiplex header 由 supervisor 消除。
3. supervisor 用 Docker exec `AttachStdin/Stdout/Stderr:true` 和 hijack 双工流，不累计无限 stdout。EOF 是半关闭，不等同 kill；退出后 drain 再关 WS，exit 只发一次。断连默认取消 run 进程树，不能遗留后台 shell；lease/fence 防止旧 worker 操作新进程。
4. 常驻连接不等于支持断线恢复。若以后支持 reconnect，必须有单 writer、seq/cursor、有限 replay buffer、终态保存和租约移交；不能自动重放 stdin/宿主副作用。原型后续的第一版容器通道仍可定义断连即取消。

computer 镜像安装：沿现有多架构、版本/校验和固定的构建方式，增加 Bun `>=1.3.14` 的确定版本，以及锁定的 `@oh-my-pi/pi-coding-agent@18.12.6`（或第二阶段确认的版本），在 build stage 安装并复制运行所需依赖/native addon。使用固定锁文件与完整性校验，验证 amd64/arm64 对应 native 库，不能在容器启动时 curl 最新安装脚本。将 bun/omp 放只读工具目录、配置可写目录给非 root bot 用户；不在镜像里放 key、登录状态或个人 profile。构建 smoke 检查 `bun --version`、`omp --version`、无模型的 ready/EOF 退出即可。[O13]

镜像已有 Chromium，但 omp browser/computer 是 Eval prelude，不是同名独立 AgentTool；browser 要启用 Eval，computer 默认关闭且依赖平台能力。容器中是否能接已有 Chromium/CDP/Xvfb、是否与 Web 可见 display 相同，必须另作 smoke 验证，不能仅凭安装成功承诺桌面能力。第一版本机不启用原生 computer，避免操作 worker 宿主桌面；这不影响代码执行目标。[O14][O15]

## 7. 插件、pstack 和 Agent Skills 共存

omp 支持原生/兼容 plugin manifest、TS/JS extension、Skills、提示词和 agent 定义。Skills 使用 `<skills-root>/<name>/SKILL.md` 一层布局，按需 `skill://` 读取；agent 有 tools、model、spawns、thinking 等 frontmatter；扩展能注册工具/事件并运行 Bun 代码。兼容元数据不等于任意 Pi SDK 扩展二进制/API 兼容，特别是 `@earendil-works` 与 `@oh-my-pi` 的包族不能混装后假定通用。[O16][O17][O18]

“pstack”并非唯一发布物。本次用已明确声明支持 OMP 的 [oh-my-pstack](https://github.com/shrimpwtf/oh-my-pstack/tree/fc0eabd25f21b194a336b640e75e29c252382866)（取样提交 `fc0eabd25f21b194a336b640e75e29c252382866`）作兼容性样本，而非替用户选定唯一供应源。该包有 `pi.skills` manifest、agents 目录和 `pstack-pi` 角色/生命周期适配技能；实际工具契约仍要和所锁 omp 版本对齐。[P1][P2]

建议先只加载 pinned workflow 内容，不默认安装其带执行权限的任意扩展：

- 把 skills/agents/引用脚本与 license 固定到每 bot 的只读 workflow mount；通过显式 plugin-dir/skills.customDirectories/agent 来源加载，不污染 worker 的个人全局插件目录。
- 核对 canonical role→omp agent 名称、模型 role alias、task 单个/批量 schema、隔离 worktree、hub wait/send/cancel 和结果 `agent://` / `history://` 语义；缺少的能力明确返回不支持。由 Rakazo 连接提供的 tracker/应用工具不等于 workflow 写死的某个宿主工具。
- pstack 里的 setup、子 agent 权限、ask、宿主 shell 假设以及长驻 session 协议需要适配。原型进程在 settled 后关闭，不能承诺下一轮还能找到上一轮在内存中的 parked agent；后台任务在本 run 内可用，跨 run session 协作后置。
- 插件需要 UI 的 confirm/editor 等在 `--no-ui` 下会默认取消/省略，不能声称完整插件 UI 可用。扩展错误要显式可观测，但不把内部路径或凭据写进公共诊断。

Rakazo Agent Skills 保持原有事实源和 `skill_*` 产品工具。原型继续由 Rakazo 注入已选技能目录/元数据、通过 `skill_read` 读取；显式 workflow mount 才由 omp 原生发现。同名技能先通过来源命名空间和 include/ignore 规则消歧，不重复把同一 SKILL.md 展开两次。后续需要统一发现时，再将已授权 Rakazo skill 发布成只读目录并由版本/hash 同步；更新/删除经 Rakazo API，下一 run 刷新，不双向同步两个可写副本。技能脚本在真正的 omp cwd 执行，引用资源要一起提供，不能只复制 SKILL.md。omp 的自动记忆/学习/managed skill 写入暂关闭。[O16]

## 8. 恢复能力与限制

**能恢复 transcript；不能仅靠 CLI RPC 保证继续正在执行的工作或 exactly-once 副作用。** 原型采用无会话重放，重启后沿现有 run 租约恢复/失败路径，保留 bot 文件和 Rakazo 历史；不自动重跑未知结果的原生命令。

后续持久模式可用 `--session <path>` / `--resume <path>` 启动，或 RPC `switch_session` / `open_session` 切换。必须保存精确 session 身份及路径、run/thread 绑定、上次确认的 session entry/消息游标、用量去重、活动子 agent 和配置版本，并重新注册宿主工具和子订阅。禁止 `--continue` 随便挑“最近会话”，否则不同 thread 或 bot 会串上下文。重载必须验证路径归属和模型覆盖。[O19]

当前 `--restore` 的自动恢复中断 turn/子 agent 逻辑只在交互模式提供，不能直接加到 `omp --mode rpc` 使用。普通 resume 可以修补中断 transcript，但不是重新接上已死的 OS 进程；未完成工具结果可能 unknown。要在 RPC 下自动恢复，需要小型 Bun launcher/受控扩展调用恢复 API，或上游增加 RPC restore 命令，并补齐副作用恢复策略。[O19]

恢复协议至少区分：prompt 已发送但未确认、已确认但未得到 prompt_result、主 prompt 让出但后台未 settled、全部完成但数据库未落终态。无法确定的原生写入/命令不得自动重放；宿主工具沿现有 executionId/idempotency/外部效果机制对账。网络断开也不能推导模型从未执行。跨 worker 继续事件流还需要 session owner/fence 和持久读游标，不能靠 checkpoint 字符串解决。

## 9. 风险、第二阶段范围与验证

### 已知风险及待验证点

| 风险/未知项 | 原型选择与验证 |
| --- | --- |
| 完成、取消、异步唤醒乱序 | 明确 prompt outcome + session settled 状态机；覆盖先 yield 后子完成、再次 agent_start、后台取消不再唤醒、失败与 abort 竞态。 |
| JSONL 输出过大/损坏、stdout 污染 | v2 decoder、字节/队列限额、stderr 独立；损坏/截断/chunk 乱序失败，不能直接跳过关键帧。 |
| 宿主暂停与 omp 并行调用竞态 | 暂停为全 run 终止边界；禁止新 dispatch、丢弃晚结果，等待清理；unknown 副作用需对账。 |
| 失去消费者/租约后进程继续运行 | finally + 总时限 + 进程树取消；fake 进程断连/忽略 abort 测试。 |
| 用量覆盖不全、零价误判、子 agent 重复计费 | 先限制到可观测调用；主/子逐次 usage、producer 回调及去重；隐藏调用后置；unknown 不当零。 |
| 本机与电脑容器文件/画面不同 | 按 runtime 生成路径指令和附件访问桥；不承诺首版本机图形工具；容器迁移是下一步。 |
| 凭据经 echo/插件错误/原始 session 泄露 | 最小 env、双边界脱敏、跨 chunk 测试、不记录 raw RPC/原始结果；无会话默认，不上传临时 profile。 |
| pstack 版本/角色/schema、子工具继承 | 固定 workflow 版本；实测 task/hub/子事件；根负责产品工具，跨 run parked agent 不承诺。 |
| 所有连接与旧 Pi 行为不等价 | 第一版 API-key/无 key OpenAI-compatible、OpenRouter；OAuth/特殊 gateway/fallback 预检拒绝；验收报告标明连接种类。 |
| 自动恢复导致重复外部效果 | 原型不自动恢复原生未知效果；后续单独设计 durable process/session owner。 |

### 第二阶段建议改动范围（须确认后才开始）

1. 在 `packages/adapters` 实现 `OmpRpcRuntime`、JSONL 协议状态机、本机 OmpTransport 和宿主桥；继续依赖共享 AgentRuntime，默认 Pi 行为不变。必要代码才拆文件，不引入通用插件平台。
2. 工具选择和 instructions 按 runtime 能力生成；保留产品工具，复用脱敏、暂停、审计和用量。工作目录/附件/home checkpoint 对齐实际执行位置。
3. `AGENT_RUNTIME=pi` 保持默认，增加 omp 并拒绝未知配置。为满足“一个 bot 切换”增加可空 `Bot.runtime`（pi/omp，null 继承部署默认）及可空 `Run.runtime` 快照；只加列，旧 release 可读写。run 创建时固定有效 runtime，恢复/重试不能因部署默认或 bot 修改而换执行器。API/worker 都用同一个 selector；既有 runtimeOverride 测试注入仍优先。scripted 保留测试用途，不开放为普通 bot 选项。
4. 最小 bot 设置选项随现有设置表单呈现，避免额外说明区；共享 schema/API 校验和序列化覆盖新增字段。若有 UI 文案，未来 PR 描述按 AGENTS.md 引用并解释其必要性；增加打开该设置/对话屏幕的 Web 测试并链接 CI E2E 截图。本阶段不新增界面或 PR。
5. 只实现本机每 run 进程，不新增 supervisor 通道、镜像依赖、完整持久 session、OAuth broker、跨 run 后台任务、插件市场/UI 或复杂父子 agent 树。提供受控 pinned workflow mount 的手动验证办法即可，不把 pstack 全流程列为首版通过条件。

### 离线确定性测试

假的 omp RPC 进程使用仓库 Node 脚本读取 stdin、按输入状态回放 JSONL；不依赖 Bun、真实 omp、网络、模型或计时碰巧排序。至少覆盖：

- ready/协商/配置失败；文本分段与终态去重、多个 assistant message、thinking 不混入回答；UTF-8 跨字节、v2 chunk 合法/非法/限额。
- 原生工具只观察不回调 executeTool；宿主 schema/route/name 正确往返；并行调用读循环不阻塞；duplicate/cancel/update/error、未知工具和晚结果；审计只完成一次且没有原始结果。
- prompt ack 不完成、agent_end 不完成、prompt_result 非 settled 后继续接收子事件和根后续输出、settled 才 done；本地命令无需 prompt_result；错误/中断/EOF 非成功；有挂起调用不提前关闭。
- ask/secret/审批 pause 和 takeover 清理；abort 幂等、先于启动完成的取消、忽略 abort 后 TERM/KILL、迭代器 return、context signal 和租约丢失。
- 主/子 usage、缓存/思考桶、未知价格、错误/取消已发生用量、onUsage accounted 去重及回调失败；bot/Space/run 归属不能来自 RPC 参数。
- 虚构 key 在 text/stderr/name/args/result/error/子事件中出现及跨 chunk 拆分，事件和日志都不包含明文；API key 不在 argv/配置文件中。
- 默认 Pi、bot 覆盖、run 快照、旧 null 行、新增列兼容、未知 runtime；同 bot 写入串行、不同 bot cwd 隔离、实际附件读取位置。

不以关键词评分自然语言是否“像成功”。fixture 只断言结构、顺序、文件/回调等可观察效果；需要语义判断时按仓库规则另用 opt-in provider-neutral judge。每次提交前运行 `pnpm check`、`pnpm lint`、`pnpm test`；host 依赖测试单独 `pnpm test:host`，不混入默认测试。只在改变或失败影响所及处扩大检查。

### 手动验收协议（第二阶段执行）

文档或脚本从已配置的 Rakazo 连接/交互环境读取 key，不打印或写入 key，不在命令行参数传 key。使用相同连接/模型、相同工作区起始文件、相同 bot 指令/上下文，在 Pi 和 omp 各执行一次：“在工作目录写一个输出 hello 的小脚本并运行；用 Rakazo 记忆工具记录完成；启动一个简单后台子 agent 并汇报结果。”两种 runtime 各自有干净起点；不要拿已有记忆命中当首次调用成功。

记录表（尚未执行，不填写推测结果）：

| 项目 | Pi | omp |
| --- | --- | --- |
| 文件写入、运行输出及最终结果 | 待验证 | 待验证 |
| input/output/cache/total token 与未知项 | 待验证 | 待验证 |
| 费用来源/估算或 unknown | 待验证 | 待验证 |
| 首个可见输出与 run settled 总耗时 | 待验证 | 待验证 |
| 流式连续性、重复/停顿、工具先后顺序观感 | 待验证 | 待验证 |
| 实际 Rakazo 记忆写入及下轮读取 | 待验证 | 待验证 |
| 后台子 agent 在 Web 的 running/终态/结果 | 待验证 | 待验证 |
| abort 后后台是否停止、日志是否脱敏 | 待验证 | 待验证 |

没有可用真实 key/本机 omp 时，离线测试仍可通过，但真实对比必须标记未执行，不能用 fake 结果代替。验收记录只含技术测量和虚构任务产物，不含密钥、个人/机器标识或私有 endpoint。第一阶段在本文单独提交后停止，等待设计确认。

## 第一阶段验证记录

本次仅新增本文。`pnpm check`、`pnpm lint`、`pnpm test` 最终均通过；lint 有既存信息提示，无错误。首次全量测试与 Prisma 重新生成并行而发生生成文件读取竞态，待生成完成后，定向和全量复跑均通过。未运行 host 测试、真实模型、omp 进程或 UI 验收；没有据此宣称第二阶段已完成。已检查本地引用、证据引用、空白差异及只包含本文的提交范围。

## 上游证据索引（固定提交）

- [O1：RPC 文档](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/rpc.md)
- [O2：RPC wire 类型与命令集合](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- [O3：RPC 编解码/分片实现](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/rpc-frame.ts)
- [O4：核心 agent 事件](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/types.ts)
- [O5：子 agent observer 载荷](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/tui/src/overlays/session-observer-registry.ts)
- [O6：prompt outcome 实现](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/rpc-prompt-results.ts) 与 [session settled 实现](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/rpc-session-settle.ts)
- [O7：宿主工具桥源码](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/host-tools.ts)
- [O8：系统提示构造与子 agent 继承](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/system-prompt-customization.md)
- [O9：模型配置](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/models.md)
- [O10：配置凭据解析源码](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/config/resolve-config-value.ts)
- [O11：CLI 参数及 restore 限制](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/cli-reference.md)
- [O12：Usage 字段定义](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/catalog/src/types.ts#L209)
- [O13：安装与 Bun 要求](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/README.md)
- [O14：browser Eval 能力](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/tools/browser.md)
- [O15：computer Eval 能力与默认值](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/tools/computer.md)
- [O16：Skills 发现与冲突规则](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/skills.md)
- [O17：agent 定义与发现](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/task-agent-discovery.md)
- [O18：扩展加载与兼容入口](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/extension-loading.md)
- [O19：会话恢复/restore 行为](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/session-operations-export-share-fork-resume.md)
- [P1：pstack 样本 package manifest](https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/package.json)
- [P2：pstack OMP host 适配契约](https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/skills/pstack-pi/SKILL.md)

[O1]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/rpc.md
[O2]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/rpc-types.ts
[O3]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/rpc-frame.ts
[O4]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/types.ts
[O5]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/tui/src/overlays/session-observer-registry.ts
[O6]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/rpc-prompt-results.ts
[O7]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/modes/rpc/host-tools.ts
[O8]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/system-prompt-customization.md
[O9]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/models.md
[O10]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/config/resolve-config-value.ts
[O11]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/cli-reference.md
[O12]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/catalog/src/types.ts#L209
[O13]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/README.md
[O14]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/tools/browser.md
[O15]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/tools/computer.md
[O16]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/skills.md
[O17]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/task-agent-discovery.md
[O18]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/extension-loading.md
[O19]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/session-operations-export-share-fork-resume.md
[P1]: https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/package.json
[P2]: https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/skills/pstack-pi/SKILL.md
