# youtube-study 项目长期约定

## 产品定位
个人学习用的 Chrome/Edge 扩展：YouTube 侧边栏读带时间戳的字幕、记录想法，由用户明确决定是否落盘到 Obsidian。
扩展不能直接写本地文件，走 Chrome Native Messaging：`content.js → background.js → native_host.py → learning_service.py → Vault`。

## 用户确认的设计原则
- **笔记以 video_id 为唯一主键**。同一视频只允许存在一份笔记，不得因日期/缓存重建产生多份。
- **同步是单向的**：界面（侧边栏）→ Vault。Vault → 界面的反向同步不做；用户一旦在 Obsidian 里改，就进入人工加工阶段。
- **截图必须挂在笔记上**，孤立截图没有价值，需要能被清理。

## 关键约束（踩过的坑）
- **不要脚本重命名 `Wiki/人工智能/AI编程与工程/` 下的笔记**。该目录的笔记被
  `index.md`、`Wiki/索引/按主题.md`、`按知识角色.md`、`按领域.md` 用全路径 wikilink 硬链接，
  脚本改名会断链（Obsidian 只在自己执行重命名时才自动修链接）。
  需要改定位策略时，优先用「扫描 frontmatter 的 video_id 反查」而不是改文件名。
- Vault 路径由 `native_host.py` 的 `parents[4]` 推导（仓库位于 `.claudian/tools/youtube-study/host`），移动仓库会写错位置。

## 存储分层（四层，各层生命周期不同）
1. `chrome.storage.session` 的 `draft:{tabId}` — Alt+N 草稿，关浏览器即丢
2. `chrome.storage.local` 的 `records:{videoId}` — 记录的读写源
3. `.claudian/cache/youtube-study/{videoId}/` — transcript.json / metadata.json（含 **notePath**，不可重建）/ screenshots/
4. Vault：`Wiki/人工智能/AI编程与工程/*.md` + `原始材料/_附件/youtube-study/{videoId}/`

## 验证方式
```powershell
# host（在 host 目录）
& $PythonExe -m unittest test_learning_service.py
# extension（在 extension 目录）
node --check background.js; node --check content.js; node --check sidepanel.js
node --test ..\tests\sidepanel-ui.test.js
```
改扩展后必须在 `chrome://extensions` 点「重新加载」并用真实视频验证。
