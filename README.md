# 引用回复 · Hermes 桌面插件

从 [dsh-quick-reply](https://github.com/tupi00/dsh-quick-reply) 移植到 Hermes 桌面端。
选中助手回答里的文字，鼠标旁边冒出一张小卡片，点一下就把那段话变成 Markdown 引用块填进输入框 —— 只填草稿，不发送。

## 装在哪

```
~/.hermes/desktop-plugins/quick-reply/
├── plugin.js        # 全部逻辑（运行时加载，纯 ESM，不编译）
├── README.md
└── test/helpers.mjs # 纯函数单测（不启动浏览器）
```

从 GitHub 装：

```bash
git clone https://github.com/tupi00/hermes-quick-reply.git ~/.hermes/desktop-plugins/quick-reply
```

（目录名必须是 `quick-reply`，等于插件的 `id`。）

Hermes 桌面端会监视这个目录，文件落地几秒内自动加载；改完保存即热重载。
没反应时按 `Ctrl+K` → **Reload desktop plugins**。

## 怎么用

1. 在一条**助手回答**里选中一段文字（正反拖都行）。
2. 选区下方出现「❝ 引用回复　第 N 轮」。
3. 点它。输入框里出现：

```
> 你选中的前两行文字…（略）  （引用自第7轮回答）
```

光标已经落在引用块下面那一行，直接写问题即可。

## 行为细节

- **只引助手正文**：选中自己的提问、输入框里的草稿，不出现卡片。跨消息拖选（一头在提问一头在回答）也不认。
- **聊天区以外也能引**：左侧会话列表、右侧面板里选中的文字同样能引，只是没有「第几轮」，只写 `> 原文`。
- **自动截断**：默认只留前 2 行 / 最多 120 字，超出标「…（略）」。整段回答塞进输入框会撑爆，也不方便接着写。
- **出处带轮次**：`（引用自第N轮回答）`，N 是这段回答之前有几条你的提问。读不到确切数字时（会话顶部还有没渲染的更早消息）**不写轮次**，不编假数字。
- **保留已有草稿**：输入框里原本写了东西，引用接在后面，前面空一行。光标落在最末尾。
- **原文高亮**：用 CSS Custom Highlight API 标出引过的段落，不改宿主 DOM。引用过的段一直亮着；在草稿里把那段删掉，高亮自动消失。最多同时钉 50 段，页面刷新清空。
- **不发送**：发不发、发什么，按回车由你决定。

## 已知限制

| 限制 | 说明 |
|---|---|
| 只引助手正文 | 选中工具调用卡片、思考过程不会出现卡片（其中文字与正文同属一条消息时例外）。 |
| 右侧对话列表没有「引号按钮」 | DSH 版有「悬停会话行 → 引用该会话最后一条回答」，这一版没做：Hermes 的会话列表是虚拟化组件，插按钮会跟它的行布局打架。要引就打开那个会话手动选。 |
| 轮次号依赖宿主 DOM | 读 `[data-slot="aui_thread-content"]` / `[data-message-id]` / `[data-slot="aui_user-message-root"]`。宿主改版后最多是卡片不出来，不会弄坏聊天。 |
| 顶部截断时不写轮次 | 宿主为省内存会卸载很早的消息，此时数不出绝对轮次，插件选择不写，而不是写错。 |
| 仅桌面端 | 插件 API 只存在于 Hermes 桌面（Electron）应用，CLI / Web dashboard 没有。 |

## 改参数

`plugin.js` 顶部：

```js
const QUOTE_MAX_LINES = 2    // 引用最多几行
const QUOTE_MAX_CHARS = 120  // 引用最多几个字
```

改完保存，自动热重载。

## 测试

```bash
node test/helpers.mjs   # 截断 / 出处 / 比对指纹的纯函数单测
node --check plugin.js  # 语法（ESM 需先复制成 .mjs）
```

## 卸载

删掉 `~/.hermes/desktop-plugins/quick-reply/` 整个目录，`Ctrl+K` → Reload desktop plugins。

## 实现要点

- **填草稿走宿主 API**：`host.composer.insertText(null, text, { mode: 'block' })` —— 宿主自己的草稿总线，不是模拟键盘；`block` 模式自动在末尾另起一段，并且把焦点和光标送到末尾。
- **选区要缓存**：点卡片的 `mousedown` 会让页面选区清空，所以卡片上的 `mousedown` 一律 `preventDefault()`，真正干活用 `selectionchange` 里缓存的那份选区。
- **位置取鼠标松开的那一点**：用 `selection.focusNode / focusOffset` 收一个零宽 Range 再量矩形，正拖反拖都对；卡片右缘对齐字尾，下方放不下就翻到上方，贴边时夹进窗口。
- **高亮与草稿对账**：引用时记下正文的「只留汉字字母数字」指纹，草稿变动（MutationObserver + 1.2s 兜底定时）后比对，找不到就撤掉那段高亮 —— 切会话会整体替换输入框节点，所以定时器比 observer 更可靠。

原作：tupi00，MIT。
