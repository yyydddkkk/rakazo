# 工作流包（Workflow Package）

状态：设计已确认，第二阶段最小实现已完成；真实模型与真实 omp 的 pstack 体验由用户验收。下文保留设计依据，当前实现边界以本节为准。

## 当前实现

- Space 安装、bot 显式选择和常驻技能已接入；新增 `workflows` API 与设置入口。首次执行固定 run 的包版本 ID/常驻快照，摘要与转换器版本从不可变 revision 解析，升级不改变暂停重试的版本；停用/卸载取消相关活动 run，worker 的工作流取消轮询在下一次检查触发清理，已发生的副作用不能撤回。
- 生产导入先支持公开 GitHub HTTPS 仓库，完整 commit 或明确 tag；其他 Git 主机、私有仓库和其他插件方言暂不支持。本地假 Git 只从测试注入。显式技能根支持一层布局，过深的技能布局拒绝；引用文本和许可保留，脚本与可执行入口省略。规范化投影生成最小 root/OMP/Claude manifests，让固定 omp 的兼容 loader 正确读取显式技能路径；这些文件不复制上游执行字段。
- Pi 的 `skill_read`、包内资源、bot slash 目录与常驻指令已接入；导入 agent 在 Pi 中不可用。omp 用显式 `--plugin-dir` 原生加载技能和 agent，模型固定 bot 选择，导入 agent 禁止再启动子 agent，要求 yield 的定义启用 structured。
- **显式来源缺口采用 OS 挂载解决，未修改上游 omp。** 有包的 omp 进程要求 Linux、bubblewrap 和可用 user namespaces。根目录只读，只有 bot 工作目录和本 run 临时目录可写；投影、可信配置、空配置目录的所有路径别名只读。工作目录和临时 HOME 的 OMP/Claude/Codex/Gemini 等配置根、XDG 插件注册表被空目录覆盖，祖先 agent 搜索在本工作目录命中空 agents 目录即停止；原生 task 的独立 worktree 模式关闭，防止换到未覆盖的 cwd。原配置不删除、不覆盖写入，缺少隔离能力时明确失败。无包的原有 omp 路径不启用此包装。
- 原生模块仍是可信已安装 omp；没有加载包 extensions/hooks/tools/MCP，也没有执行其安装或验证脚本。挂载保护并不禁止模型使用已授权 bash 编写等价内联代码，也不把可读宿主文件变成跨 Space 的完整 OS 保密隔离。
- 应用镜像包含 bubblewrap；原生宿主安装需要自行提供该系统工具。容器策略也须允许所需 user namespaces，本实现不自动放宽 seccomp 或增加宿主特权；镜像构建未在本次验证。下载大小监控超过软上限会取消 Git 请求，轮询与进程退出期间仍可能短暂超限，不等于磁盘配额。
- 新增三张带 Space RLS 的表及 `Run.workflowSnapshot` 可空列，migration 只增不删。卸载回收没有 run 引用的版本目录；历史 run 引用的不可变版本保留。安装失败和重复升级的临时版本清理，不引入自动升级或后台 GC。
- 固定社区样本已通过一次性离线导入核对：49 个技能、两个 agents、118 个投影文本文件，摘要重读一致；未把第三方内容提交进仓库。脚本步骤、长期 owner、独立审查模型及被省略的字段不属于已验证能力。

## 1. 决策与调研基线

工作流包是**固定来源版本的可复用工作流内容**，不是拥有宿主权限的插件进程。Rakazo 管安装、Space 授权、bot 选择、版本和常驻设置；执行器负责使用内容。第一版只交付文本技能、引用资料和受控转换后的 agent 定义，不安装依赖或运行第三方代码。

建议：**Space 安装，bot 显式启用；先支持 omp/Pi package manifest 的文本子集，以 oh-my-pstack 为验收样本；Pi 只使用其中的技能，不自动创建 fleet bot。** Cursor 与 Claude Code 是后续来源适配器，不在最小实现中同时开发三个完整插件系统。

调研日期：2026-10-23。Rakazo 基线 `e684aca4436155fc60d05aaae5128700cc056eaa`，与本地 main 和 origin/main 一致；本地起点无未提交改动。阅读了 [AGENTS.md](../AGENTS.md)、[VISION.md](../VISION.md) 和 [omp runner 设计](omp-runner-design.md)。上游均按下面的完整 SHA 阅读，文中的版本号只是展示信息，SHA 才是内容身份。

| 样本 | 固定版本与观察 |
| --- | --- |
| [Cursor pstack manifest][P1] | `cursor/plugins@8b3326d99fd4b993cb33a24dad8af03175c642c5`，子目录 `pstack`，版本 `0.15.30`；57 个 skills、23 个 poteto-mode playbooks、2 个 agents。MIT。 |
| [官方 Claude Code 适配版][P2] | 同一提交的 `harness/pstack/claude-code`；由共享内容生成，加入宿主映射说明，不复制 Cursor automations。它不是另一个独立上游。 |
| [oh-my-pstack manifest][S1] | `shrimpwtf/oh-my-pstack@fc0eabd25f21b194a336b640e75e29c252382866`，版本 `0.14.3-pi.1`；49 个 skills、23 个 playbooks、2 个 agents。`pi.skills` 声明 `./skills`，没有 extension 入口。MIT，另有第三方 notices。 |
| [社区移植版上游锁][S2] | 锁定 Cursor `bdf7aa355337897f167153e05069aca505dae17c`，不是上述最新官方内容。不得将两者拼接后称为同一版本。 |
| [omp][O1] | `can1357/oh-my-pi@0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0`，coding-agent `18.12.6`，沿用现有 runner 基线。这里只读文档和源码，没有执行第三方脚本、真实 omp 或模型。 |

原版 poteto-mode 会继续读取 playbooks、principle-* 等叶技能；只复制主 SKILL.md 会破坏工作流。[原版 agent][P3] 还有 Cursor 安装路径假设。官方 [Claude 适配说明][P4] 将工具、模型、路径和 Cursor 独有步骤分开映射；社区版则由 [pstack-pi][S3] 承担宿主适配。这两种做法支持“共享文本内容 + 明确的执行器适配”，不支持“加载 manifest 即完整兼容”的推论。

## 2. 抽象与来源格式

包的规范化清单由 Rakazo 解析生成，不要求发布者采用新的 Rakazo 格式：

| 内容 | 第一版语义 |
| --- | --- |
| 身份与出处 | Git URL、包子目录、格式、manifest 名称/版本、请求的 tag 或 commit、解析后的完整 commit、内容摘要、转换器版本、许可证与 notices 路径。来源信息保存在私有产品数据中；公共提交只放公开证据和虚构夹具。 |
| Skills | `SKILL.md` 的名称、描述、正文及包内相对路径；关联 playbooks/references/docs 的文本资源。principle-* 仍是技能，不另建“原则引擎”。 |
| Agents | 名称、描述、系统指令，以及经过宿主允许列表转换的 tools、spawns、thinking、structured 等字段。原文和转换结果分开保存。agent 定义不是持久 Bot。 |
| 规则/常驻内容 | 包可声明推荐内容；是否常驻由用户在 bot 上选择，包不能自行写 bot 指令、全局规则或每轮自动激活自己。 |
| 模型偏好 | 仅为来源元数据。第一版全部使用 bot 已选模型，不接受包提供的 endpoint、凭据、模型通配符或隐式 fallback。 |
| 依赖/不兼容项 | 展示缺失宿主能力、外部插件及被省略的脚本资源。记录不等于安装；没有 npm/pip 解析或自动依赖下载。 |

来源适配顺序：

1. **第二阶段：omp/Pi package**，识别 `package.json#omp`，不存在时接受 `#pi`；只解析显式技能目录及约定 `agents/*.md`。oh-my-pstack 的 manifest 没有显式 agents 字段，必须补上这个受限约定，不能从技能加载成功推断 agent 已注册。仓库若有多种 manifest，按这一选定格式解析，记录选择，不把所有入口叠加加载。
2. **后续：Claude Code plugin**，识别 `.claude-plugin/plugin.json`，支持 skills、agents 和纯文本 commands 的显式转换。Claude 模型别名、tools 名称、宿主映射不能原样传给 omp。官方 pstack 的目标路径是 `harness/pstack/claude-code`。
3. **后续：Cursor plugin**，识别 `.cursor-plugin/plugin.json`；`pstack` 子目录必须能在安装时选择。解析清单不等于支持 Cursor 的运行语义；需要下文的映射和兼容报告。

omp 也识别 [root plugin.json 标准与兼容插件][O2]。这是另一种输入方言，不能把任意 `plugin.json` 当成 Cursor manifest。第一版只识别上述 package 格式，其他格式明确拒绝；不通过执行 manifest 中的脚本探测格式。先用已有 omp 适配内容，能减少 Cursor 工具翻译，同时保留以后导入原版的路径。

## 3. 安装、版本和生命周期

### 范围与状态

“工作区”在这里固定指 **Space**，不是 Git checkout、电脑目录或 Organization 全局。包安装归 `(spaceId, userId)`，同 Space 的 bot 可复用；每个 bot 通过关联记录选择包。默认新安装不对任何 bot 开启，不自动继承给 fleet 子 bot，也不隐式跨 Space 共享。

建议新增三个小表：`WorkflowPackage`（Space 安装身份、唯一 alias、可空 activeRevisionId、enabled）、`WorkflowPackageRevision`（不可变来源与规范化索引）、`BotWorkflowPackage`（bot 启用关系、常驻技能的稳定键）。run 增加可空 JSON 快照，列出有效 revision、摘要、转换器版本、常驻键和运行时映射；没有包时是空集合。关联表不承担第二份技能正文存储。

Space 开关是总闸，bot 开关是选择；有效集合是二者交集。所有 API、读资源、run 解析都以 Space 和用户范围查询，并验证 bot 归属。第一版没有“安装到某台电脑”和 bot 私有副本两套安装体系。

### 固定导入

输入 Git URL、**完整 commit 或明确 tag**，以及可选包路径；禁止 branch、空版本、`HEAD`、浮动 semver、自动追踪 main。tag 只在导入时解引用一次，保存 tag 和完整 commit；以后移动同名 tag 不改变已有 revision，重试按保存的 commit 取内容。Git commit 同时固定整个仓库和选择的子目录；同 SHA 的重新导入须校验摘要，不覆盖既存内容。

获取放在受限后端安装流程，不在浏览器或 agent shell 中执行。仅允许经校验的 HTTPS Git 来源：拒绝带凭据 URL、git/ssh 外部命令协议、`ext::`、任意本地路径和选项注入；使用 argv，不拼 shell。复用仓库网络边界规范限制私网/loopback、重定向和 DNS 变化；不能只校验字符串后让 Git 自行访问任意地址。第二阶段优先固定受支持的公开 HTTPS Git 来源，不新增私有仓库凭据系统；本地假 Git 来源只从测试注入，不开放为生产 API 能力。

禁用系统/用户 Git 配置、credential helper、模板 hooks、交互提示、递归 submodule 和 LFS/filter；通过无 checkout 的对象读取拿到指定 commit 的普通文件，避免 checkout smudge 或 repo 脚本。设置下载、文件数、单文件/总字节和时间上限；超限失败，不留半个可启用版本。不能调用 `omp install`、包管理器或仓库自带生成器。许可证缺失记录为“未声明”，在安装详情显示；已声明 MIT 也不能省略 LICENSE/NOTICE 的保存。

### 存储与只读投影

产品数据存放在 `DATA_DIR/workflow-packages/<spaceId>/<packageId>/<revisionId>/`，不在本仓库、bot Git checkout 或 AgentHomeStore checkpoint 中。保留 `source/`（固定版本原始文本与许可）、`manifest.json`（可信解析结果）、`projection/<transformVersion>/`（允许运行时看到的文本）。目录段使用服务端 ID，不能取 URL、tag 或包内任意字符串。API/worker 执行节点共享这份持久数据，备份同时覆盖数据库和该目录。

投影只包含核准的 SKILL.md、agent Markdown、必要文本引用和许可证。拒绝 symlink、submodule、设备文件、越界路径、重复规范化路径和大小写碰撞；文件名扩展为文本不等于获得执行权限。脚本、二进制、hooks、extensions、MCP/LSP/DAP 配置、package.json 的 scripts 等入口不进入投影。原始 manifest 不传给执行器，改用 Rakazo 生成的最小 manifest。缺失引用列入兼容报告；必需脚本被省略时，该工作流步骤不可用，不能自动下载替代或把未完成的验证算成功。

“只读”分两层：产品 API 和 `skill_*` 工具禁止编辑第三方内容；OS 只读挂载则要求执行器进程无法写入投影。Pi 首版直接由宿主 `skill_read` 返回正文与引用，不必复制包进电脑；未来需要本地资源时，须另外提供 sandbox 只读挂载能力，不能把普通文件上传当作挂载。omp 当前是本机子进程，**没有 mount 能力**：`0444/0555`、摘要复核与每 run 临时副本只是完整性措施，同一 UID 的 bash 可改权限，不能称为安全只读挂载。[现有部署边界](omp-runner-design.md#部署注意)仍然成立。

第二阶段可以先采用本机文本副本和摘要校验，但必须保留这一显式限制；若要求对恶意包也强制只读，需先提供以另一权限身份运行的进程或容器 `ro` 挂载，不能在本阶段凭文档假定已有。共享缓存不暴露为工作目录；每 run 使用独立投影副本，防止正常工作流意外修改影响其他 bot。

### 升级、停用、卸载

升级仍要求用户输入固定版本，生成新 revision、重新解析和展示兼容差异；成功后事务切换 activeRevision。失败保留原版本；不自动扩大 bot 启用范围、增加常驻技能或安装依赖。常驻键在新版不存在时阻止切换并让用户移除对应选择。旧 revision 暂保留，可通过同一版本切换流程回退。

run 在首次执行前固定有效集合；审批暂停后的重试复用同一快照，不因升级改变工作流。解析与创建快照须和卸载互斥/校验 revision 状态，不能先删文件再发现 run 正在引用。升级对新 run 生效，活动 run 继续使用旧 revision。

停用是安全撤回：新 run 不加载；已暂停/待重试 run 若快照含被停用包，明确阻止执行，不能默默换空配置继续。正在运行的进程仍持有文本，停用操作应取消受影响 run，并等待现有清理流程完成；不能宣称切一个数据库开关就撤回已发生的副作用。

卸载先走停用，再移除 bot 关联和常驻选择，标记不可用；无活动/可恢复 run 引用后才能回收文件。保留审计所需的 SHA、摘要、许可证元数据。安装中断的临时目录可幂等清理；正在引用的 revision 不以文件时间做垃圾回收。

## 4. 两种执行器的使用方式

### 共享解析与命名

包内稳定键为 `(packageId, originalName)`，版本另存，不把版本写进用户技能名。安装 alias 在 Space 内唯一且不随升级改变，如 `pstack`；公开给 Rakazo 的名字为 `pstack:poteto-mode`，名称长度仍遵守现有 80 字符限制。资源寻址使用服务端稳定 ID 和包内相对路径，不从显示名拼文件路径。

第一版 omp 内部保留 `poteto-mode` 和 `poteto-agent` 原名，使包内 `skill://poteto-mode/...`、sibling 引用和命名 agent 调用有效。Rakazo 维护 qualified-name → native-name 映射，`/poteto-mode` 仅在本 bot 的有效目录中唯一时提供短名；`/pstack:poteto-mode` 始终能定位包。**第一版拒绝启用会产生原生同名技能/agent 的包组合**，包含与 omp bundled agent 的碰撞，不依赖安装顺序覆盖；Pi 同样不静默遮蔽用户/builtin skill 的短名。

已有 Rakazo 用户/builtin 技能占用短名时，不生成包的同名短别名，包的 qualified 名仍然可用；例如 Rakazo 的 `Interrogate` 保持原义，pstack 的同名技能用 `pstack:interrogate`。`skill_read` 同样优先解析已有短名，包内引用使用 qualified 来源或稳定 ID。

这是有意的最小限制：Pi 可以按 qualified 名区分多个来源，omp 的 [技能冲突机制][O3] 与 [agent first-wins 机制][O4]并不统一，而且原始技能名禁止 `/`。要让冲突包同时运行，后续必须生成合法的原生名字并改写结构化 URI、spawns 和受控模板引用；不能对任意 Markdown 做全文替换后宣称所有自然语言引用都可靠。冲突时返回具体包和名称，让用户只选一个，不自动重命名原包。

### omp：显式文本目录，继续用原生 skills/task

每 run 根据固定快照生成最小 `.omp-plugin/plugin.json` 和 `skills/`、`agents/` 文本目录，通过重复的 **`--plugin-dir <absolute-projection-root>`** 显式传入。argv 路径只能来自受信快照，只包括已安装且有效启用的包；不传源仓库根、不使用 `-e/--extension`、`--hook` 或任何第三方 entrypoint。此路径使原生 discovery 同时看到 skills 和 agents，`read skill://...` 与原生 `task` 仍由 omp 执行。[CLI 参数表][O5]确认存在 `--plugin-dir`；`--skills` 是名称过滤参数，**不是目录参数**；该基线也没有 `--agent-dir` 这样的独立 CLI 参数。

| 现有参数/配置 | 调整 |
| --- | --- |
| `--no-skills` | 有原生包时移除；无包时保留。显式启用 skills 并设置精确 include 列表。 |
| `--no-extensions` | 始终保留；禁止同时加入显式 extension/hook 参数。它本身仍允许显式模块加载，不是安全沙箱。[O6] |
| `--no-rules` | 保留。不让包的 `.mdc`、AGENTS.md 或模型规则进入全局自动发现；常驻内容由 Rakazo 注入。 |
| `--no-session`、临时 HOME/agentDir、模型限制 | 保持现有策略，补齐隔离的 XDG data/cache/state 根；不继承宿主 profile、插件注册表或包提供的环境变量。 |
| discovery providers | 用固定版本的 provider 集合禁掉环境中的 native/foreign/managed skills、hooks、tools、MCP、commands 等来源；只保留投影需要的 plugin provider。`enabledProviders` 不是总允许列表，不能仅设置它就声称关闭其他来源。[O7] |

**现有 CLI 的能力缺口必须在第二阶段显式解决。** `--plugin-dir` 不是“只从这些目录加载”的开关。隔离 HOME 能避开真实用户全局目录，但 plugin registry 还有 project 来源；更关键的是，`task/discovery.ts` 无条件先找最近祖先的 `.omp/agents`，不经过 native provider 的禁用判断，且会在任务执行时重新发现。[O8] 因此“临时 HOME + disabledProviders + 启动时检查”仍不能严格保证 agent 来源闭包；扫描完再按名字过滤也挡不住同名覆盖。

推荐补足一个小的 **omp 原生显式来源模式**：skills 与 task discovery 都只接受给定投影根和 bundled agents，根/子 task 的创建与再次发现共用同一来源集合，跳过用户/project registries 和祖先 agent 目录。这需要锁定带此能力的上游版本或最小上游补丁；不是加载第三方扩展。现基线的 SDK/CLI 没有一个已验证开关能替代它，不在设计里虚构参数，也不靠猴子补丁改模块全局。先以离线解析/发现用例验证该边界，再接现有 RPC transport；若必须保持原样 `18.12.6`，严格来源限制就仍是未完成项，不能只靠 fake argv 测试宣告满足需求。

agent 转换只允许已知字段，tools 与实际开放的原生工具取交集，不把 `skill_*`、凭据或 fleet host tools 当成子 agent 自动继承。第一版导入的子 agent 显式 `spawns: false`，模型固定当前 bot 模型；[移植版 poteto-agent][S4]和 comment-sicko 都声明 `yield`，而 omp 默认非 structured task 没有 yield，[O4]所以转换器对 tools 含 `yield` 的定义显式开启 `structured: true`，并用两个定义的夹具验证结果契约，不对验收目标单独硬编码。忽略的来源字段和工具列入兼容报告，不能让上游宽容 parser 静默决定权限。

社区版参考 roster 中的 `designer`、`librarian` 不在此 omp 基线的五个 bundled agents 中。受控 pstack 适配段将这些角色映射到带角色 brief 的 `task`，其余按实际 roster 解析；直接命名的 `poteto-agent` 使用导入定义。角色近似映射不等于具备独立模型审查能力。[S3][O4]

### Pi：复用 Agent Skills，agent 定义暂不执行

现有 [AgentSkill](../packages/db/prisma/schema.prisma) 按 Space/user 保存、名字有唯一约束；[skill-tools.ts](../packages/adapters/src/skill-tools.ts) 和 [API service](../apps/api/src/agent-skills.ts) 已把 `source: plugin` 视为只读；[core agent-skill](../packages/core/src/agent-skill.ts) 已有解析、目录和 slash 展开。这些是复用入口，但当前 `skill_read` 没有 bot 启用过滤，不能直接把包技能插进 Space 全局表便结束。

建议将包技能作为现有 `SkillRecord`/Agent Skills 的**只读投影**合入统一 resolver，而非复制成可编辑 AgentSkill 行。resolver 输入 Space/user、可选 bot 和 run 快照；返回 qualified 名、`source: plugin`、只读正文及来源键。API 安装详情可以查看 Space 已安装文本；给模型、composer 和 `skill_read` 的集合必须是当前 bot/run 的有效集合。显式 ID、短名、qualified 名和引用资源都走同一校验，不能用 ID 绕过停用或跨 Space 读取。

`skill_read` 增加可选的包内资源路径，只读返回允许的文本（缺省仍是 SKILL.md），复用现有大小限制；Pi 的 `read_file` 不能拿 omp 主机路径读取。返回正文附带 qualified 技能 ID、revision 和资源基址，后续资源请求携带该 ID；`skill://poteto-mode/...`、`../pstack-pi/...` 与 sibling 技能引用都在该来源包的同一 revision 中解析。允许跨技能引用，但路径归一化后只能留在包根；找不到或有歧义就拒绝，不回退全局短名。不要用进程中可被并发读取覆盖的“当前技能”变量推断来源。

taught skills 继续走原路径，不混为包内容。目录生成继续用 `formatSkillsCatalogInstruction`，移除其静默 50 项截断，改由已有上下文预算检查整个有效目录，超预算明确失败；不能因排序把 poteto-mode 隐藏。只注入元数据，按需读取正文。

Pi 第一版**不支持导入 agent 的直接调用**，也不把它悄悄降级或转换成 fleet 子 bot。Pi 仍可使用现有 `run_subagent` 做一般子任务，但必须明确这没有实现 `poteto-agent` 的 tools/model/spawns 契约。需要命名 agent 的 playbook 步骤返回能力缺失；根 agent 自行完成其他可执行部分，不伪称该步骤通过。fleet 是持久身份、审批和通信边界，自动建 bot 会增加无关产品状态，不是一次 task 的等价替换。

### Slash 调用与常驻技能

Web `/poteto-mode` 经统一 resolver 选中技能，在 Rakazo 任务封装中形成明确的技能调用；omp 适配段要求用 `read skill://poteto-mode` 读取原生正文和相对资源。**不把用户原文作为任意 RPC slash command 直接发送**；现有 runner 会封装 prompt，也不应为技能打开 `/bash` 等会话命令。Pi 复用现有正文展开/skill_read，并传递包来源和资源读取方式。每种模式一份调用正文，不同时从两套目录重复展开。

常驻是 bot 上显式保存的技能键列表，不从“上轮模型说进入模式”推断。每 run 从快照注入常驻技能正文/宿主约束，子 agent 用自包含 brief 加所需技能；不假定继承 append-system-prompt。若超出已有上下文预算，明确失败并要求减少选择，不静默截断。第二阶段可只提供此列表，不做自然语言识别的自动持久开关；单次 `/poteto-mode` 默认只影响该次任务，用户要跨轮生效就在设置里选为常驻。bot 设置变更对新 run 生效，暂停重试保留旧快照，安全停用除外。

## 5. Cursor 语义逐项映射

| Cursor 能力 | Rakazo 对策与边界 |
| --- | --- |
| 选中技能后常驻 | **支持显式设置的近似语义**：bot 常驻技能在每 run 注入；不是恢复 Cursor Custom Mode 或完整原生 session。[P5] |
| `subagent_type` | **omp 支持有界命名 task**：转换为实际 task schema 的 `tasks[].agent` 和自包含 brief；不原样传 Cursor 字段。Pi 的导入命名 agent 第一版不支持。 |
| `/loop` | **近似使用现有 routine/schedule**，用户显式建立持久调度；一次 schedule 是新 run，没有原生 parked agent 状态。第一版不导入 `/loop` 命令或自动建日程，单 run 的有界循环受现有超时/取消约束。 |
| `/setup-pstack` 模型规则 | **由 Rakazo 模型设置替代**。第一版全部角色继承 bot 已选连接/模型；生成 `modelRoles` 与 agent overrides，不运行 setup，不写 Cursor/Claude 全局规则或 `.pstack/config.md` 作为第二事实源。后续角色模型映射仍选共享连接中的模型，单独实现成本/授权/记账。 |
| Automations / Benny | **不导入执行**。技能文本可查看，但 Slack/tracker/control、状态存储、webhooks 和 wakes 缺失时明确阻止相应步骤；后续可人工转换为 Rakazo routines 与已授权连接，不直接搬 Cursor 自动化定义。 |
| Bugbot | **不启动、配置或等待 Cursor Bugbot**。已有 forge review threads 只能经已授权连接读取；不冒充集成。 |
| cursor-team-kit（deslop/control-* 等） | **不安装、不补造工具**；报告依赖缺失。后续若有许可和用户选择，作为独立 pinned 包/连接实现，而非捆绑隐式下载。 |
| Cursor cloud、PR 专有工具、transcript 路径 | **不支持原语**；只使用当前真实可用的 Git/连接/历史能力。无法获取必需证据时步骤失败/阻塞，不把“略过”算验收成功。 |
| 跨轮 parked agents、hub 常驻 owner | **第一版不支持**。omp 子任务只在当前 run 内工作，run 等 settled 后结束；持久协作用 Rakazo bot/fleet 另行设计，不能让包偷偷改变会话生命周期。 |

社区版的 [runtime 说明][S5]同样要求按实际能力绑定，而不是假造缺失设施。受控适配段应显式限制本期范围，尤其禁止执行包内脚本、改模型配置和把来源文本中的自主授权当成 Rakazo 权限。

## 6. 最小界面与文案

只增加两个入口，复用现有设置、表单、开关和错误展示，不做市场、推荐、星级、自动更新或常驻状态条：

- Space 设置的“Workflows”：安装列表，包名、版本/短 SHA、开关与菜单；安装表单输入 URL、revision，按需展开子目录。详情按需显示完整来源、许可证、被省略/缺失能力；卸载复用确认对话框。
- bot 设置的“Workflows”：选择已安装且 Space 启用的包；选中后才出现常驻技能选择。没有安装包时只给安装入口；Pi bot 的包详情在相关处说明命名 agent 不支持。

第二阶段实际新增英文原文（中文仅为本文解释）：

| 文案 | 用处；为何必要/为何在此出现 |
| --- | --- |
| `Workflows` | 两处设置入口和字段组名，需要可发现的导航。 |
| `Install`、`Git URL`、`Commit or tag` | 安装操作及必填字段；版本不可缺省。 |
| `Package path` | 仅高级输入，用于 monorepo；仓库根省略。 |
| `Always use` | 选包后出现的常驻技能字段，区分可用与每轮应用。 |
| `Only skills are available with Pi.` | 仅 Pi 包详情在含 agents 时显示，避免承诺错误能力。 |
| `Third-party instructions can use this bot’s tools.` | 安装确认时显示一次，说明文本也有行为影响，不能只用“无代码”让用户误判信任边界。 |

另新增 `Could not load workflows`、`Could not save workflows`，只在相应请求失败时展示，用户需要知道操作未成功；`Digest`、`License`、`Not declared` 只在 Details 展开后展示，支持核对版本与许可；`Update` 是详情内的固定版本升级操作，`Uninstall {0}?` 仅在卸载确认时展示包名，防止删错。它们连同上表共 15 项，均提供英文和中文翻译。

复用现有开关、Details、Uninstall、Cancel 和确认组件；没有常驻说明区。服务端兼容/校验错误只在安装、启用或执行失败时展示具体原因，不新增持续提示。

涉及 UI 的提交/PR 描述须引用实际新增原文，解释不可删除或为何仅在相关处显示。本轮已有打开这两个设置屏幕的 Web 测试与本地截图；以后创建 PR 时链接该测试的 CI E2E 附件，本轮不创建或推送 PR。

## 7. 安全保证与明确非保证

信任包意味着允许模型阅读第三方指令，不意味着授予更多 Space、凭据或宿主工具权限。包不能设置 endpoint、任意 argv/env、连接、系统级规则、审批策略或持久 bot 身份；宿主规则优先级高于包文本。宿主调用继续通过现有授权和审批；子 task 不自动获得根的 Rakazo host tools。原生 bash 仍使用已有 omp 权限，不能宣传所有工作流都受 Rakazo 工具审批控制。

第一版可以确定保证的范围：安装器不运行第三方安装/生成脚本；投影不包含可执行资源或可执行入口；launcher 不传第三方 extension/hook 参数、不注册包 MCP/工具；未知 manifest 执行字段只能作为“不支持”元数据；包内容不会变成 shell 拼接、动态 import 或可执行配置。安全验证检查数据流和允许列表，不用对 Markdown 关键词扫描来判断是否可信。

**不能保证“任何第三方文本都绝不会导致模型运行等价代码”。** 具备 bash/write 的 agent 能根据 Markdown 指令重建脚本或执行内联代码；`noexec` 挂载也挡不住 `bash file`。因此这里的“不执行脚本”是产品不安装、不提供、不自动运行包代码，并在工作流适配里禁止调用被省略的脚本；不是恶意提示词隔离承诺。若用户要求强制禁止一切包诱导执行，必须限制执行器工具/OS 权限或先提供真正沙箱，不能靠扩展名、提示词或 fake 测试证明。pstack 中依赖这些脚本的步骤应报告不可用，不能绕过验证门槛继续声称完整成功。

安装失败、兼容诊断、Git 错误和 runtime 事件只记录脱敏元数据，不输出凭据、原始 stderr、私有来源 URL 或源文件正文；沿用现有跨 chunk 脱敏。服务端生成的路径和 manifest 不能由模型编辑后再次信任，投影 hash 不符立即失败。任何跨 Space 读取、停用绕过和包资源越界都属于权限错误，不回退到文件系统搜索。

## 8. 第二阶段最小范围、验收和未决项

### 建议实施顺序

1. 安装器与三个表、可空 run 快照及 Space/bot API；所有 migration 只新增表/列/索引，旧 API 在新库上仍可读写。旧代码未知的包记录不改变它现有运行路径。包目录持久化、版本切换与停用清理一起完成。
2. 统一只读技能 resolver，连接现有目录、slash、routine、API 详情与 `skill_read`，补上 bot/run 范围和引用资源读取；不改 taught skills。
3. omp 文本投影、显式 plugin-dir、agent 转换与宿主适配；**先解决原生 discovery 的显式来源缺口**，不拿 fake 进程掩盖上游限制。本机副本是否满足本期“只读”要求须在设计确认时明确；强制挂载需要额外进程隔离工作。
4. 两处最小设置 UI、离线测试与截图用例。只使用 oh-my-pstack 固定版本；不引入扩展市场、自动升级、多模型角色 UI、fleet 模板转换、原生持久 session 或真实模型评测。

预计触达：`packages/contracts` 的 API/schema、`packages/core` 的技能解析/调用映射、`packages/db` 的增量模型与迁移、`packages/adapters` 的安装存储/投影/resolver/executor/omp、API 与 worker composition roots、`apps/api` 的受权路由，以及 Web settings/composer 和相应测试。复用 `AgentRuntime`，只新增运行所需的包目录/映射输入，不另建 WorkflowRuntime；provider 和 manifest 方言翻译留在 adapters。安装配置归后端，不让前端编排 Git 或版本切换。

### 验收定义

目标是：**一个 omp bot 上安装 pinned pstack 包，`/poteto-mode` 能进入支持的有界工作流，原生 `task` 能按导入定义调起 `poteto-agent`**；Pi 同一包的技能可以通过 `skill_read` 使用。这里的 pstack 指已记录版本的社区 omp 移植版；不等于官方最新所有 playbooks、脚本和宿主集成均兼容。

离线自动验收只证明结构和可观察效果，真实体验由用户完成：

- 本地假 Git 仓库有两个 commit 和可移动 tag：导入固定 SHA、tag 解引用、tag 移动不漂移、指定子目录、重试、失败不替换旧版、手动升级/回退、停用/卸载与活动 run 引用。测试不访问网络；来源连接由测试边界注入。
- 两个 Space、多个 bot：未选包不可见、启停生效、跨 Space/ID 读取拒绝、常驻跨 run 注入、暂停重试固定版本、安全停用阻止重试、冲突名称拒绝；包技能写/删工具必须拒绝。
- 恶意夹具：manifest 越界、symlink、submodule、重复路径、大小限制、第三方 scripts/extensions/hooks/MCP 与启动 marker。断言它们不进入投影/argv、安装无 marker 副作用；不以这个结果冒充对模型任意 bash 的隔离证明。
- 扩展 `packages/adapters/src/test-support/omp-rpc-process.mjs`：检查 argv 只含有效 package roots，`--no-extensions`、`--no-rules` 保留，`--no-skills` 按集合调整；读取生成 manifest、skills/agents、当前模型约束及 structured/spawns 设置，校验完整资源路径和 hash。模拟命名 task 的子事件、宿主往返、settled、取消，复用现有生命周期回归。
- 对固定 omp 版本的显式来源模式增加离线 conformance：种入真实 HOME/project/祖先 `.omp/agents`、同名替代 agent 和未启用包，确认根及子 task 的 discovery 均不读取它们，只返回 bundled + 显式文本包。此测试不需要模型；若未提供可测试的原生来源控制，不将该项记为通过。
- Pi 目录和 `skill_read` 返回 qualified skill/资源且只读；兼容现有用户技能/builtin/taught skills，停用之后无法从历史 ID 再读。slash 不成为任意 RPC 本地命令，routine 触发使用 bot 有效集合。
- Web scripted 用例覆盖安装、bot 选择、常驻、停用和卸载的产品路径，生成 CI 截图。离线 fixture 不断言自由文本“像 poteto”；如以后需自动评价语义，使用显式 opt-in、版本化且经校准的 provider-neutral rubric，单报费用，judge 错误不算通过。

每次提交前按顺序完成 `pnpm check`、`pnpm lint`、`pnpm test`；不启动真实模型或真实 omp，不绕过 hooks。真实用户验收时检查原生 skill 读取、实际 `task` 中的命名 agent、子事件和结果，不把模型自述或 fake 事件当作已运行的证明。

### 第一阶段提出的边界（实际处理见文首）

- 先导入社区 omp 文本格式，官方 Cursor/Claude 来源延后；Pi 不运行导入 agent，omp 同名冲突组合先拒绝。
- 原生 `18.12.6` 没有已验证的完整显式来源开关；要严格满足来源限制，第二阶段需一个小的上游能力补足并重新锁版本。否则这一条就是未完成，不降低验收口径。
- 本机 runner 的文件权限不是强制只读挂载。接受文本副本的现有宿主信任边界，或将 OS 只读进程隔离列为第二阶段前置，两者不能混称。
- 文本模式不能保证完整 pstack：脚本、独立审查模型和长期 owner 等门槛缺失时，只报告未完成。受支持有界路径的真实模型表现尚无证据，由用户体验，不提前宣称通过。

## 第一阶段验证记录（历史）

仅新增本文；无产品代码、界面、第三方仓库内容或 migration。初次检查因工作树缺少开发依赖未能启动，按锁文件安装依赖后，`pnpm check`、`pnpm lint`、`pnpm test` 全部通过；lint 只有既存信息提示，全量默认测试通过，环境相关用例按仓库配置跳过。本地文档链接、固定 SHA 引用和空白差异检查通过；来源样本的技能/agent/playbook 数量与许可文件已交叉核对。

未运行 host 测试、Web E2E、真实 omp、模型或第三方脚本；本文没有 UI 改动，不以现有测试通过宣称工作流功能已实现。到此停止，等待确认设计后再进入第二阶段。

## 第二阶段验证记录

- 提交前 `pnpm check`、`pnpm lint`、`pnpm test` 最终全部通过；lint 仅有既存信息提示，默认全量测试通过，环境依赖用例按既有配置跳过。初次全量回归暴露的子进程 HOME 扫描误报和旧 UI 测试 mock 缺项已修复，不修改部署环境允许列表或绕过测试；另补齐 pstack 与 builtin Interrogate 的短名兼容，以及保留已停用选择时编辑其他包的回归。
- 离线假 Git 覆盖固定 SHA/tag、tag 移动、升级、显式子目录/技能目录、路径/符号链接/脚本拒绝、完整性与卸载；API 覆盖 Space/bot 归属、启停、常驻选择、取消与历史版本保留；共享 Pi `skill_read` 路径实际返回包正文和同包引用，停用后旧 ID 不可读。
- 假 RPC 进程核对已选包目录、最小 manifests、模型/structured/spawns 配置与扩展禁用参数；真实 Linux bubblewrap + 本地 Node host 测试验证只读挂载、隐藏原配置、XDG 插件注册表、只读目录原路径别名、不可 chmod、普通工作目录可写，不启动 omp 或模型。
- 定向 Web E2E 通过安装、bot 选择/常驻、qualified slash 目录、停用和卸载；生成 `space-workflows`、`bot-workflows`、`workflows-uninstalled` 截图，已目视检查。E2E 的工作流 RPC 使用离线假服务；不将其等同真实 Git 导入或模型工作流验收。以后创建 PR 时应链接该测试的 CI 附件，本轮没有创建或推送 PR。
- 未调用真实模型、真实 omp、第三方脚本或在线 Git 安装；未运行全量 host 测试。真实 pstack 任务路由和命名子 agent 的模型表现仍由用户体验。

## 固定上游证据

[P1]: https://github.com/cursor/plugins/blob/8b3326d99fd4b993cb33a24dad8af03175c642c5/pstack/.cursor-plugin/plugin.json
[P2]: https://github.com/cursor/plugins/blob/8b3326d99fd4b993cb33a24dad8af03175c642c5/scripts/generate-pstack-harness-trees.mjs
[P3]: https://github.com/cursor/plugins/blob/8b3326d99fd4b993cb33a24dad8af03175c642c5/pstack/agents/poteto-agent.md
[P4]: https://github.com/cursor/plugins/blob/8b3326d99fd4b993cb33a24dad8af03175c642c5/pstack/docs/harness/claude-code.md
[P5]: https://github.com/cursor/plugins/blob/8b3326d99fd4b993cb33a24dad8af03175c642c5/pstack/docs/guide/02-poteto-mode.md
[S1]: https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/package.json
[S2]: https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/upstream.lock.json
[S3]: https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/skills/pstack-pi/SKILL.md
[S4]: https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/agents/poteto-agent.md
[S5]: https://github.com/shrimpwtf/oh-my-pstack/blob/fc0eabd25f21b194a336b640e75e29c252382866/skills/pstack-pi/references/runtime.md
[O1]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/package.json
[O2]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/marketplace.md
[O3]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/skills.md
[O4]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/task-agent-discovery.md
[O5]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/cli/flag-tables.ts
[O6]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/docs/extension-loading.md
[O7]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/capability/index.ts
[O8]: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/task/discovery.ts
