# YouTube 学习记录扩展

这是一个不接入 LLM 的 Chrome/Edge 工具。它在侧边栏显示当前视频字幕，并通过 `Alt + N` 保存时间戳和观看记录。

## 内容边界

工具只负责采集：

- 视频来源和频道信息；
- 完整字幕；
- 观看时主动保存的时间戳和记录。

它不会自动总结、复盘、回答问题或写文章。视频笔记作为 `source-note` 进入 [[Wiki/index|Wiki]]，需要创作时再交给输出流程。

## 保存位置

一个视频只产生一篇可见笔记：

```text
Wiki/人工智能/AI编程与工程/YYYY-MM-DD 视频标题.md
```

侧边栏需要的 JSON 缓存保存在 `.claudian/cache/youtube-study`，不参与知识库索引，可以重新生成。当前工具默认用于 AI 学习；观看其他领域的视频后，应按内容移动到相应 Wiki 领域。

## 安装或迁移

1. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`。
2. 开启开发者模式，加载 `.claudian/tools/youtube-study/extension`。
3. 记下浏览器显示的扩展 ID。
4. PowerShell 运行：

```powershell
& ".claudian/tools/youtube-study/host/install.ps1" -ExtensionId "扩展ID"
```

5. 刷新扩展和 YouTube 页面。

## 使用

1. 打开带字幕的 YouTube 视频和扩展侧边栏。
2. 点击“获取字幕”，工具只读取字幕并保存在隐藏缓存中，不会写入可见知识库。
3. 播放时按 `Alt + N`，视频暂停并定位当前字幕。
4. 输入记录后按 `Enter` 保存并继续；`Shift + Enter` 换行；`Esc` 取消。
5. 确认视频值得长期保留后，点击“保存到知识库”，才创建对应的单篇 Markdown 笔记。

如果快捷键冲突，可在 `chrome://extensions/shortcuts` 中修改。

## 当前边界

- 只读取视频已有字幕，不执行语音转写。
- 没有字幕的视频不会创建完整字幕。
- 获取字幕、临时记录和保存到知识库彼此独立；仅点击“保存到知识库”才创建可见 Markdown。
- 浏览器本地存储保留一份观看记录状态；Markdown 是知识库中的唯一可见内容。
