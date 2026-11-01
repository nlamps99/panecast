# 手机远程写代码，不只有 Agent：cmux + cmux Remote 的另一种答案

最近，“离开电脑也能继续盯着 Coding Agent”几乎成了标配。

Happy Coder 可以把 Claude Code、Codex 等 Agent 的会话带到手机；OpenAI 也把 Codex Remote 放进了 ChatGPT mobile。它们都在解决同一个真实问题：任务跑到一半卡在确认、提问或报错时，人不该必须回到电脑前才能继续推进。

但如果你的工作不只有一个 Agent 会话，而是同时有终端、分屏、脚本、日志、训练任务、服务进程和多个代码助手，那么还有另一条路线：**从终端本身出发。**

这就是 [cmux](https://github.com/manaflow-ai/cmux) 和 [cmux Remote](https://github.com/NewTurn2017/cmux-remote) 的组合。

## cmux：先把桌面的工作现场整理好

cmux 是一款原生 macOS 终端。它不是把终端重新包装成聊天产品，而是围绕开发者已经熟悉的工作方式增加了工作区、分屏、通知和可脚本化控制。

一个工作区可以是一项功能、一个仓库或一次实验；不同 surface 可以同时跑开发服务器、测试、日志、部署命令和 Claude Code / Codex。终端还是终端，但“哪个任务在等我”“哪个窗口需要看一眼”不再埋在一堆窗口和 tab 里。

这点很朴素，却很重要：Agent 是工作流的一部分，不是工作流的全部。

## cmux Remote：把终端工作台带到 iPhone 和 iPad

cmux Remote 是连接到自己 Mac 上 cmux 的原生移动客户端。它同步的是工作区、surface、终端画面、通知和输入能力；不是把整个桌面以远程控制的方式缩小到手机里。

因此它更适合下面这些高频、短时的动作：

- 看一个后台任务是不是完成、卡住或报错；
- 快速浏览真实终端输出和较早的历史日志；
- 发一条命令、贴一段文本，或用 `Ctrl-C` 中断失控任务；
- 在多个工作区之间切换，判断该回到哪台电脑处理；
- 在 Agent 等待时确认，但也能看到 Agent 之外的所有终端上下文。

这也是它与“把 Agent 对话搬上手机”的根本区别：**cmux Remote 远程的是你的开发现场，而不只是某个 Agent 的聊天记录。**

## 这次我们重点打磨了什么

移动端终端好不好用，往往不是由“能不能连上”决定，而是由细节决定。

cmux Remote 最近补齐了一批真正影响日常使用的体验：

- 中文界面与中英文切换，设置、状态与错误信息不再混杂。
- iPad 横屏适配：工作区和终端能利用完整宽度，而不是放大的 iPhone 页面。
- 分类后的设置页：终端字号、主题、显示密度、连接和通知各自归位。
- 快捷键按 cmux 的协议发送，`Ctrl-C` 能实际中断命令。
- 历史终端采用游标分页：向上查看大量 scrollback 时按需拉取，不一次性吞掉全部内存。
- 实时输出原地更新，不因每个终端帧重建视图，避免底部日志持续闪动。

它的目标不是在手机上“完整写一天代码”，而是让你离开桌面时仍然能看懂情况、做对动作，然后从容回到电脑完成需要大屏幕的工作。

## 和 Happy Coder、Codex 官方 Remote 怎么选？

这不是谁取代谁，而是三个产品对“远程开发”的切入点不同。

| 产品 | 核心对象 | 更适合什么场景 | 需要注意什么 |
| --- | --- | --- | --- |
| **cmux + cmux Remote** | cmux 工作区与真实终端 | 同时管理脚本、日志、服务、Agent 与普通 shell；需要 iPad 横屏和终端历史 | 当前以 iPhone/iPad 为主，需要在自己的 Mac 上运行 relay |
| **Happy Coder** | Claude Code、Codex 等 Agent 会话 | 从手机继续 Agent 对话、批准操作、审阅 Agent 工作；需要 iOS/Android/Web 跨端 | 重点是 Agent 会话，而不是一个通用终端工作台 |
| **Codex 官方 Remote** | Codex 的受支持远程会话 | 已深度使用 ChatGPT/Codex，希望最少配置地查看、推进和批准 Codex 任务 | 只服务 Codex 工作流，不负责其他终端或其他 Agent 的统一视图 |

Happy 的优势很明确：它是为 Agent session 设计的，支持从移动端继续对话，并覆盖 iOS、Android 和 Web；它把会话延续、审批和端到端加密放在中心位置。[Happy 官方介绍](https://happy.engineering/) [Happy 文档](https://www.mintlify.com/slopus/happy/introduction)

Codex 官方 Remote 的优势同样明确：如果你已经在 ChatGPT / Codex 生态里，手机端可以直接跟进已连接机器上的 Codex 任务、审批、插件和项目上下文，路径最短。[OpenAI 官方说明](https://openai.com/index/work-with-codex-from-anywhere/) [使用说明](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)

而 cmux Remote 的优势在于，它不要求你把开发现场收敛成某一家 Agent 的会话模型。Claude Code、Codex、普通 shell、长日志、开发服务和临时命令，都只是 cmux 里的一个 surface。你看到的是完整的终端工作台。

## 我会怎么搭配

如果一天的大多数操作都是“和 Agent 继续对话、批准下一步”，Happy 或 Codex 官方 Remote 会更顺手。

如果你更常遇到的是“先看看哪个服务挂了”“把这个任务停掉”“查一下刚才那 500 行日志”“Agent 在哪一个工作区等我”，cmux Remote 会更贴近真实的终端工作流。

最实用的方式甚至不是二选一：把 Happy 或 Codex Remote 当作某个 Agent 的移动入口，把 cmux Remote 当作整台开发机的终端观察和控制面板。

## 结语

移动端并不需要复制桌面上的一切。它应该在你离开工位时保留最关键的三件事：看见状态、理解上下文、完成一个正确的动作。

cmux 负责把终端现场组织起来；cmux Remote 负责把这个现场延伸到手机和 iPad。对于不想把工作流完全交给某一个 Agent 的开发者来说，这是一种更自由、也更贴近终端本身的远程开发方式。

---

项目链接：

- [cmux](https://github.com/manaflow-ai/cmux)
- [cmux Remote](https://github.com/NewTurn2017/cmux-remote)
