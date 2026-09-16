# Changelog

## 0.1.0 (2026-09-08)

### Added
- **B23 头部按钮折叠展开**：默认收起 34px 圆角方（仅机器人图标，面板开启时图标保持高亮），悬停右缘锚定向左展开至完整按钮（label + 状态点），0.34s 丝滑曲线 + label/dot 错峰淡入；**推开式布局**（margin-left:auto 锚定，展开时左邻被匀速推开 114px、右缘与 PlanBoard 纹丝不动，无遮挡）；移除旧 hover 放大/缩小/旋转动效。实测确认按钮为相对定位（与 PlanBoard 同槽位 flex 相邻，邻居变化实时重排）
- **B22 FLAG_SECURE 识别与可见性**：
  - 自动识别：焦点窗口 SECURE 位轮询（dumpsys window windows，2.5s 节流、per-device 在-flight 去重、attach 即检）；
  - 面板横幅 + 「尝试显示」缓解链：adb root（仅 userdebug/eng；user 构建明确跳过并说明原因）、root 框架探测（Magisk/LSPosed → DisableFlagSecure 启用指引，绝不代装）、SECURE 位复查终局判定（每步 ✓/✗/⏭/💡 明示，fail loud）；
  - 判定失败自动进入降级内容通道：uidump 控件树文本视图（点条目=点按该元素中心），SECURE 退出自动切回画面；
  - agent 引导：act/attach 结果附 secureHint；act 工具描述增加黑屏=FLAG_SECURE 引导；
  - config 新增 flagSecureCheck（默认 true）。

### Fixed
- 头部按钮收起/展开圆角弧度不一致：收起态由 10px 圆角方统一为展开态的胶囊弧度（999px），过渡属性同步清理。
- （随 B22 一并修复）README 工具清单 7→10（debug/ui/install_ime 早已上线但文档未更新）。
