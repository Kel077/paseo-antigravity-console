# Antigravity 控制台

为 Paseo 内置的 Antigravity provider 提供多个 Google 账号和出错自动切换，把额度和用量集中显示，能查看 Antigravity 自己启动的子代理，还能设置 Orchestrator 的 planner 和 executor。

## 功能

- **账号**：在 Antigravity CLI 存在钥匙串里的登录之外，再添加其他 Google 账号。可以指定新 agent 默认用哪个账号，也可以用输入框上方的账号胶囊或 `/account` 把 agent 换到另一个账号，对话会在新账号上接着进行。
- **自动切换**：一轮请求失败时，如果像是临时错误，先在当前账号上重试，仍然失败就换到下一个可用账号，并发送 "Continue." 继续。额度用完或登录失效时直接切换。每次重试和切换都会记在 agent 的时间线里。可以关闭，也可以设置重试次数。
- **额度**：每个账号的 5 小时额度和每周额度。侧边栏底部显示默认账号的两个额度条。
- **用量**：24 小时、7 天或 30 天内的请求次数、输出速度、缓存命中率和首字延迟，可按模型查看。
- **子代理**：Antigravity 启动的子代理会以实时卡片显示在 agent 的时间线里，并有一个子代理面板，列出每个子代理的任务、状态、每一步操作、token 用量和它交回的报告。
- **Orchestrator**：在控制台里，或在 Orchestrator agent 的输入框胶囊里，选择 Orchestrator 的 planner 和 executor 模型及推理强度。设置保存在 CLI 自己的 `/model` 保存的位置。
- **上下文**：输入框上方的胶囊显示 agent 的上下文窗口用量。

## 准备

需要在 daemon 所在的机器上安装 Antigravity CLI（`agy` 1.5.13 或更高；设置 planner 和 executor 需要 1.5.14），并使用 Paseo 0.16.2 或更高版本。已在 macOS 上测试，Linux 未测试，不支持 Windows。

添加账号：从 Command Center 或侧边栏底部打开 Antigravity 控制台，选择添加账号，打开 Google 登录链接，把 Google 显示的授权码粘贴回来。

## 数据和权限

- 每个添加的账号都在 Paseo 插件数据目录里有自己的 HOME，agy 用这个 HOME 运行。这个 HOME 链接回你真实的主目录，所以 agent 照样能看到你的文件和设置；agy 只在这里单独保存这个账号的登录信息，存成文件而不是钥匙串条目。所有账号共用同一份对话记录。如果某次登录信息被存到了 profile 之外，插件会停用这个账号。
- 每次在添加的账号上启动前，插件会把 agy 的 `settings.json` 复制到该账号的 profile 里，让所有账号使用相同的设置。
- 选择 planner 或 executor 时，插件会写入 `~/.gemini/antigravity-cli/settings.json` 里的 `orchestrator` 项。
- 查询额度、读取模型列表和登录都会在 daemon 所在机器上运行 agy CLI。用量、上下文和子代理视图读取 `~/.gemini/antigravity-cli` 下 agy 自己的对话记录和日志。
- 插件本身不发起任何网络请求，也不向任何地方发送数据；agy 照常与 Google 通信。插件从不读取钥匙串。账号列表和状态缓存保存在 Paseo 的插件数据目录里。

## 限制

- 模型选择器列出的是系统登录账号的模型，各账号可用的模型可能不同。把 agent 换到没有该模型的账号时会启动失败，agent 留在原账号上。
- 某个账号不支持所选的 planner 或 executor 时，该账号会使用 agy 的默认值。
- agent 在添加的账号上运行时，直接创建在主目录下的文件会落在该账号的 profile 里。
- 子代理视图只读，停止子代理或给它发消息仍由父 agent 负责。
