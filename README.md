# YouTube Study

一个面向个人学习的 Chrome/Edge 扩展：在 YouTube 侧边栏读取带时间戳的字幕、记录观看时的想法，并由用户明确决定是否保存到 Obsidian。

## 工程结构

```text
youtube-study/
├── extension/   # 浏览器端：侧边栏、字幕交互、快捷键和消息编排
└── host/        # 本机端：Native Messaging、字幕缓存和 Markdown 写入
```

浏览器扩展不能直接写入任意本地文件，因此两个目录通过 Chrome Native Messaging 协作：

```text
YouTube 页面
  -> extension/content.js
  -> extension/background.js
  -> chrome.runtime.sendNativeMessage
  -> host/native_host.py
  -> host/learning_service.py
  -> Obsidian Vault
```

`extension` 和 `host` 是同一个产品的两个模块。它们之间的消息名称及数据结构属于共同接口，修改一端时必须验证另一端，因此放在同一个 Git 仓库中一起版本化和回滚。

## 当前工作流

1. 打开 YouTube 视频不会自动写入知识库。
2. 点击“获取字幕”只下载视频已有字幕并写入 `.claudian/cache/youtube-study` 隐藏缓存。优先英文，其次中文，再回退到其他已有语言；不会执行语音转写。再次回到同一视频时，侧边栏会自动恢复已有缓存，不会重新下载。
3. 使用 `Alt+N` 记录当前时间点的想法；未入库前记录保存在 Chrome 本地存储。
4. 一条记录可以选择、拖入或粘贴多张截图；截图先进入隐藏缓存。
5. 已保存的记录可以再次编辑文字、追加或移除截图；点击时间按钮可以让原视频跳回对应位置。
6. 点击“保存到知识库”后，才创建包含字幕、个人记录和截图附件的 Markdown。
7. 已入库的视频继续自动同步新增、修改或删除的观看记录。

详细安装和使用说明见 [`extension/README.md`](extension/README.md)。

## 本地验证

在 `host` 目录运行：

```powershell
$PythonExe = "完整 Python 可执行文件路径"
& $PythonExe -m unittest test_learning_service.py test_native_host.py
& $PythonExe -m py_compile learning_service.py native_host.py test_learning_service.py test_native_host.py
```

在 `extension` 目录运行：

```powershell
node --check background.js
node --check content.js
node --check sidepanel.js
node --test ..\\tests\\sidepanel-ui.test.js ..\\tests\\sidepanel-behavior.test.js ..\\tests\\background-shortcut.test.js ..\\tests\\content-transcript-cache.test.js
```

在仓库根目录验证安装脚本（只使用临时目录，不修改注册表）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\\tests\\install.test.ps1
```

修改扩展后还需要在 `chrome://extensions` 中点击“重新加载”，刷新 YouTube 页面并进行一次真实视频验证。

界面开发时可以在仓库根目录启动静态服务器，再打开
`extension/sidepanel.html?preview=1` 查看带示例字幕和笔记的安全预览；该参数不会改变扩展正常启动流程。

## 本机配置

`host/native-host-manifest.json` 由 `host/install.ps1` 生成，包含当前机器的绝对路径和 Chrome 扩展 ID，因此不会提交到 Git。新机器安装时运行：

```powershell
& ".\host\install.ps1" `
  -ExtensionId "浏览器中显示的扩展 ID" `
  -PythonExe "完整 Python 可执行文件路径" `
  -VaultPath "Obsidian 知识库根目录"   # 可选
```

安装脚本把 Python 绝对路径写入被 Git 忽略的 `host/python-path.txt`。仓库只保存读取该配置的通用启动脚本，不保存个人机器路径。
安装时会先验证该 Python 能导入 Native Host 所需的标准库；如果自动检测到的运行时不完整，请通过 `-PythonExe` 指定一套完整的 Python 3。

`-VaultPath` 同样是可选的：默认假定本仓库位于 `<知识库>/.claudian/tools/youtube-study`；如果放在其他位置，脚本会把绝对路径写入被 Git 忽略的 `host/vault-path.txt`，本机连接器优先读取它。

重新运行安装脚本时省略 `-VaultPath` 会删除旧的路径覆盖并恢复默认布局。

## 缓存生命周期

- 已入库视频的缓存用于恢复侧栏和同步记录，不自动删除。
- 从未入库的缓存最多保留 30 天，并最多保留最近 50 个视频；本地连接器使用时会自动清理超期或超量项目。
- 侧栏“清理过期缓存”会先显示数量和预计空间，确认后只删除符合上述条件的未入库缓存。
- 取消草稿、移除截图或删除记录时，会清理不再被记录引用的受管截图；正式 Markdown 不会被缓存清理删除。

安装后可以用浏览器扩展详情页显示的 ID 检查 Native Messaging 授权：

```powershell
& ".\host\check_registration.ps1" -ExtensionId "浏览器中显示的扩展 ID"
```

## Git 工作方式

- `main` 始终保持可以运行。
- 一个功能或修复对应一个小提交。
- 提交前运行与改动相关的自动检查，并在 Chrome 中验证真实工作流。
- 提交信息说明用户可观察到的变化，例如 `feat: add lazy bilingual transcript translation`。
- 试验性工作使用短生命周期分支，验证后再合并到 `main`。
