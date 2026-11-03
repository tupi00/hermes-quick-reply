/**
 * quick-reply — 选中助手回答里的文字，一键「引用回复」。
 *
 * 移植自 https://github.com/tupi00/dsh-quick-reply （DSH Web 插件）到
 * Hermes 桌面端的插件 SDK。行为对齐：
 *   - 选中助手消息正文 → 选区旁边浮出小卡片 → 点击把引用块填进草稿，不发送；
 *   - 引用自动截断（前 2 行 / 最多 120 字，超出标「…（略）」）；
 *   - 出处写「（引用自第N轮回答）」，读不到确切轮次就只写正文，不编假数字；
 *   - 草稿里已有内容时接在后面，前面空一行；光标落在末尾；
 *   - 原文用 CSS Custom Highlight API 高亮，不动宿主 DOM；引用过的段一直亮着，
 *     草稿里删掉那段就自动撤高亮。
 *
 * 宿主 DOM 依赖（宿主改版时最多是「卡片不出来」，不会弄坏聊天）：
 *   [data-slot="aui_thread-content"]         聊天区（判定轮次的计数范围）
 *   [data-slot="aui_assistant-message-root"] 助手消息根
 *   [data-slot="aui_user-message-root"]      用户消息根
 *   [data-slot="composer-rich-input"]        输入框编辑器
 * 草稿读写走宿主自己的 composer 总线（host.composer），不模拟键盘。
 */

import { host } from '@hermes/plugin-sdk'

const ID = 'quick-reply'

const HL_SELECTION = 'quick-reply-selection'
const HL_QUOTED = 'quick-reply-quoted'
const MAX_PINS = 50

// >>>PURE-HELPERS —— 这一段的函数不许碰 DOM / React（test/helpers.mjs 会抠出来跑）

const QUOTE_MAX_LINES = 2
const QUOTE_MAX_CHARS = 120
const ELLIPSIS = '…（略）'

/** 把一段选中的原文压成引用正文：最多 2 个非空行、最多 120 字，截断处标「…（略）」。
 *  @returns {{ lines: string[], truncated: boolean }} */
function clipQuote(raw) {
  const source = String(raw ?? '').replace(/\r\n?/g, '\n')
  const all = source
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line.length > 0)

  let truncated = false
  let lines = all

  if (lines.length > QUOTE_MAX_LINES) {
    lines = lines.slice(0, QUOTE_MAX_LINES)
    truncated = true
  }

  const joined = lines.join('\n')

  if (joined.length > QUOTE_MAX_CHARS) {
    lines = joined.slice(0, QUOTE_MAX_CHARS).split('\n')
    truncated = true
  }

  return { lines, truncated }
}

/** 组装填进草稿的 Markdown 引用块。`turn` 是非负整数时补出处，否则只写正文。 */
function quoteBody(raw, turn) {
  const { lines, truncated } = clipQuote(raw)
  const body = lines.map(line => `> ${line}`)

  if (!body.length) {
    return ''
  }

  const mark = truncated ? ELLIPSIS : ''
  const source = typeof turn === 'number' && turn > 0 ? `（引用自第${turn}轮回答）` : ''

  if (mark && source) {
    body[body.length - 1] += `${mark}  ${source}`
  } else if (mark) {
    body[body.length - 1] += mark
  } else if (source) {
    body[body.length - 1] += `  ${source}`
  }

  return body.join('\n')
}

/** 只留汉字、字母、数字，用于「草稿里还找得到这段字吗」的比对。
 *  标点、空白、宿主加的 > 前缀都不参与，改格式不会误判成删除。 */
function matchKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]+/g, '')
}

/** 引用正文的比对指纹（不含「…（略）」和出处，避免删出处导致高亮闪掉）。 */
function quoteKey(raw) {
  return matchKey(clipQuote(raw).lines.join(''))
}

// <<<PURE-HELPERS

const CSS_TEXT = `
::highlight(${HL_SELECTION}) {
  background-color: color-mix(in srgb, var(--ui-accent) 18%, transparent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--ui-accent) 55%, transparent);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
::highlight(${HL_QUOTED}) {
  background-color: color-mix(in srgb, var(--ui-accent) 24%, transparent);
}
.hqr-card {
  position: fixed;
  z-index: 2147483000;
  display: none;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--ui-stroke-secondary);
  background: var(--ui-bg-elevated);
  box-shadow: 0 6px 24px color-mix(in srgb, var(--ui-bg-primary) 55%, transparent);
  color: var(--ui-text-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: border-color 120ms ease, color 120ms ease;
}
.hqr-card:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 55%, var(--ui-stroke-secondary));
  color: var(--ui-text-primary);
}
.hqr-card[data-visible='true'] { display: flex; }
.hqr-card .hqr-icon { color: var(--ui-accent); font-size: 11px; line-height: 1; }
.hqr-card .hqr-hint {
  color: var(--ui-text-quaternary);
  font-size: 11px;
  padding-left: 6px;
  border-left: 1px solid var(--ui-stroke-secondary);
}
`

const CARD_CLASS = 'hqr-card'

function el(node) {
  return node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
}

function inComposer(node) {
  const start = el(node)

  return !!(
    start &&
    start.closest('[data-slot="composer-root"], [contenteditable="true"], [contenteditable=""]')
  )
}

function messageRootOf(node) {
  const start = el(node)

  if (!start) {
    return null
  }

  const byId = start.closest('[data-message-id]')

  if (byId) {
    return byId
  }

  return start.closest('[data-slot="aui_assistant-message-root"], [data-slot="aui_user-message-root"]')
}

/** 聊天区顶部被 DOM 预算截掉时会有「显示更早的消息」按钮 — 那样数不出确切轮次。 */
function threadIsTruncated(thread) {
  try {
    return !!thread.querySelector(':scope > button')
  } catch {
    return true
  }
}

function turnNumberFor(messageRoot) {
  const thread = messageRoot.closest('[data-slot="aui_thread-content"]')

  if (!thread || threadIsTruncated(thread)) {
    return null
  }

  if (messageRoot.dataset.role && messageRoot.dataset.role !== 'assistant') {
    return null
  }

  const users = thread.querySelectorAll('[data-slot="aui_user-message-root"]')
  let turn = 0

  for (const user of users) {
    // messageRoot 在这个用户消息之后 → 它属于更靠后的轮次
    if (user.compareDocumentPosition(messageRoot) & Node.DOCUMENT_POSITION_FOLLOWING) {
      turn += 1
    }
  }

  return turn > 0 ? turn : null
}

/** 选区两端各自落点处的矩形（取焦点＝鼠标松开的那一点）。 */
function focusRect(sel) {
  const { focusNode, focusOffset } = sel

  if (focusNode) {
    try {
      const zero = document.createRange()

      zero.setStart(focusNode, focusOffset)
      zero.setEnd(focusNode, focusOffset)

      const rect = zero.getBoundingClientRect()

      if (rect && (rect.width > 0 || rect.height > 0)) {
        return rect
      }
    } catch {
      // 落点不可度量 —— 退回整段选区的矩形
    }
  }

  try {
    return sel.getRangeAt(0).getBoundingClientRect()
  } catch {
    return null
  }
}

/** 当前选区能不能引？能就返回要做的事。 */
function resolveSelection(sel) {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null
  }

  const text = sel.toString()

  if (!text.trim()) {
    return null
  }

  if (inComposer(sel.anchorNode) || inComposer(sel.focusNode)) {
    return null
  }

  const anchorRoot = messageRootOf(sel.anchorNode)
  const focusRoot = messageRootOf(sel.focusNode)

  if (anchorRoot !== focusRoot) {
    // 一头在里一头在外：跨区选择，不认
    return null
  }

  if (anchorRoot && (anchorRoot.dataset.role ?? '') === 'user') {
    // 只引助手正文，不引自己的提问
    return null
  }

  const rect = focusRect(sel)

  if (!rect) {
    return null
  }

  return {
    text,
    turn: anchorRoot ? turnNumberFor(anchorRoot) : null,
    rect,
    range: (() => {
      try {
        return sel.getRangeAt(0).cloneRange()
      } catch {
        return null
      }
    })()
  }
}

function highlightsSupported() {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof window.Highlight === 'function'
}

export default {
  id: ID,
  name: '引用回复',

  register(ctx) {
    // ---- 样式 -------------------------------------------------------------
    const style = document.createElement('style')

    style.dataset.plugin = ID
    style.textContent = CSS_TEXT
    document.head.appendChild(style)

    // ---- 卡片 -------------------------------------------------------------
    const card = document.createElement('div')

    card.className = CARD_CLASS
    card.setAttribute('role', 'button')
    card.setAttribute('tabindex', '-1')
    card.innerHTML =
      '<span class="hqr-icon">❝</span><span class="hqr-label">引用回复</span><span class="hqr-hint"></span>'

    const cardLabel = card.querySelector('.hqr-label')
    const cardHint = card.querySelector('.hqr-hint')

    document.body.appendChild(card)

    // ---- 状态 -------------------------------------------------------------
    let cached = null // 最后一次可引用的选区
    let rafId = 0
    let hideTimer = 0
    const pins = [] // { range, key }

    const hl = highlightsSupported()
      ? {
          selection: new window.Highlight(),
          quoted: new window.Highlight()
        }
      : null

    if (hl) {
      CSS.highlights.set(HL_SELECTION, hl.selection)
      CSS.highlights.set(HL_QUOTED, hl.quoted)
    }

    // ---- 卡片显隐与定位 ----------------------------------------------------
    const hideCard = () => {
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => {
        card.dataset.visible = 'false'
        card.style.visibility = ''
      }, 90)
    }

    const showCard = item => {
      if (!item.rect || item.rect.bottom < 0 || item.rect.top > window.innerHeight) {
        // 选中的那段已经滚出视口：不贴边硬放，免得卡片飘在无关的位置
        hideCard()

        return
      }

      window.clearTimeout(hideTimer)
      cardLabel.textContent = '引用回复'
      cardHint.textContent = item.turn ? `第 ${item.turn} 轮` : '选中文字'
      card.dataset.visible = 'true'
      card.style.visibility = 'hidden'
      positionCard(item.rect)
      card.style.visibility = 'visible'
    }

    const positionCard = rect => {
      if (!rect) {
        return
      }

      const gap = 8
      const width = card.offsetWidth
      const height = card.offsetHeight

      let left = rect.right - width
      let top = rect.bottom + gap

      if (top + height > window.innerHeight - 8) {
        top = rect.top - height - gap
      }

      left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8))
      top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8))

      card.style.left = `${Math.round(left)}px`
      card.style.top = `${Math.round(top)}px`
    }

    // ---- 选区高亮 ---------------------------------------------------------
    const paintSelection = range => {
      if (!hl) {
        return
      }

      hl.selection.clear()

      if (range && range.startContainer.isConnected && range.endContainer.isConnected) {
        hl.selection.add(range)
      }
    }

    const paintPins = () => {
      if (!hl) {
        return
      }

      hl.quoted.clear()

      for (const pin of pins) {
        if (pin.range.startContainer.isConnected && pin.range.endContainer.isConnected) {
          hl.quoted.add(pin.range)
        }
      }
    }

    // ---- 引用 -------------------------------------------------------------
    // 光标要停在引用块「下面那一行」，不是引用文本末尾 —— 所以不用 insertText
    // （它会在调用前 trim 掉尾部换行），改成：读草稿 → 拼好带尾换行的全文 →
    // setDraft。宿主画完草稿会把光标送到末尾，末尾正好是那个空行。
    const placeCaretAtDraftEnd = () => {
      const editor = document.querySelector('[data-slot="composer-rich-input"]')

      if (!editor || !editor.isConnected) {
        return
      }

      try {
        const range = document.createRange()

        range.selectNodeContents(editor)
        range.collapse(false)

        const sel = window.getSelection()

        sel.removeAllRanges()
        sel.addRange(range)
      } catch {
        // 编辑器结构不认识时就算了 —— 宿主的 placeCaretEnd 已经摆过一次
      }
    }

    const applyQuote = async item => {
      const body = quoteBody(item.text, item.turn)

      if (!body) {
        return
      }

      const draft = await host.composer.getDraft(null)
      const base = typeof draft === 'string' ? draft.replace(/\s+$/, '') : ''
      // 结尾要两个换行：宿主把草稿画成「文本 + <br> 占位」，最后一个 <br> 只是
      // 占位符，光标落在它后面打字仍会接回上一行；两个换行才真的空出一行。
      const next = `${base ? `${base}\n\n` : ''}${body}\n\n`

      const ok = await host.composer.setDraft(null, next)

      if (!ok) {
        // 没有可写的输入框：退回「追加」这条路，至少别把引用丢了
        const appended = await host.composer.insertText(null, body, { mode: 'block' })

        if (!appended) {
          host.notify({ kind: 'error', message: '没有可写入的输入框' })

          return
        }
      } else {
        // 宿主画完草稿才摆光标；等它一帧，再把光标钉到末尾那个空行上
        window.requestAnimationFrame(() => window.requestAnimationFrame(placeCaretAtDraftEnd))
      }

      if (hl && item.range) {
        pins.push({ range: item.range, key: quoteKey(item.text) })

        while (pins.length > MAX_PINS) {
          pins.shift()
        }

        paintPins()
      }

      cached = null
      paintSelection(null)
      card.dataset.visible = 'false'
    }

    // ---- 草稿变了就撤掉对不上的高亮 ----------------------------------------
    let pruneTimer = 0
    let pruning = false

    const prunePins = async () => {
      if (!hl || !pins.length || pruning) {
        return
      }

      pruning = true

      try {
        const draft = await host.composer.getDraft(null)

        if (typeof draft !== 'string') {
          return
        }

        const key = matchKey(draft)
        let changed = false

        for (let i = pins.length - 1; i >= 0; i -= 1) {
          const pin = pins[i]

          if (!pin.range.startContainer.isConnected || !key.includes(pin.key)) {
            pins.splice(i, 1)
            changed = true
          }
        }

        if (changed) {
          paintPins()
        }
      } finally {
        pruning = false
      }
    }

    const schedulePrune = () => {
      window.clearTimeout(pruneTimer)
      pruneTimer = window.setTimeout(prunePins, 220)
    }

    // ---- 选区监听（requestAnimationFrame 合帧） ----------------------------
    const update = () => {
      const sel = window.getSelection()

      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const item = resolveSelection(sel)

        if (item) {
          cached = item
          showCard(item)
          paintSelection(item.range)

          return
        }
      }

      cached = null
      paintSelection(null)
      hideCard()
    }

    const schedule = () => {
      if (rafId) {
        return
      }

      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        update()
      })
    }

    ctx.addEventListener(document, 'selectionchange', schedule)
    ctx.addEventListener(document, 'mouseup', schedule, true)
    ctx.addEventListener(document, 'keyup', schedule, true)

    // 滚动/缩放：卡片跟着文字走
    ctx.addEventListener(
      window,
      'scroll',
      () => {
        if (cached && cached.rect) {
          const sel = window.getSelection()

          if (sel && !sel.isCollapsed) {
            const item = resolveSelection(sel)

            if (item) {
              cached = item
              positionCard(item.rect)
            }
          }
        }
      },
      true
    )

    ctx.addEventListener(window, 'resize', () => {
      if (cached) {
        positionCard(cached.rect)
      }
    })

    // 草稿变化：撤掉被删掉的高亮。MutationObserver 只负责「快」——
    // 切会话时宿主会整体替换输入框节点，observer 会跟着失效，所以下面还有
    // 一条定时兜底：每隔一会儿重新挂 observer 并按当前草稿清一遍 pins。
    let observedComposer = null
    let observedObserver = null

    const watchComposer = () => {
      const composer = document.querySelector('[data-slot="composer-rich-input"]')

      if (!composer) {
        return false
      }

      if (composer === observedComposer) {
        return true
      }

      observedObserver?.disconnect()

      observedComposer = composer
      observedObserver = new MutationObserver(() => schedulePrune())
      observedObserver.observe(composer, { characterData: true, childList: true, subtree: true })

      return true
    }

    ctx.setInterval(() => {
      const attached = watchComposer()

      if (attached && pins.length) {
        void prunePins()
      }
    }, 1200)

    ctx.onDispose(() => {
      observedObserver?.disconnect()
      observedObserver = null
      observedComposer = null
    })

    // ---- 卡片交互 ---------------------------------------------------------
    // mousedown 一定 preventDefault：否则按下的一瞬间宿主把选区清空，卡片自己消失。
    card.addEventListener('mousedown', event => {
      event.preventDefault()
      event.stopPropagation()
    })

    card.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()

      const item = cached

      if (item) {
        void applyQuote(item)
      }
    })

    ctx.addEventListener(
      document,
      'mousedown',
      event => {
        if (cached && !card.contains(event.target)) {
          card.dataset.visible = 'false'
        }
      },
      true
    )

    ctx.addEventListener(
      document,
      'keydown',
      event => {
        if (event.key === 'Escape' && card.dataset.visible === 'true') {
          card.dataset.visible = 'false'
        }
      },
      true
    )

    // ---- 卸载 -------------------------------------------------------------
    ctx.onDispose(() => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(pruneTimer)
      window.cancelAnimationFrame(rafId)
      style.remove()
      card.remove()

      if (hl) {
        CSS.highlights.delete(HL_SELECTION)
        CSS.highlights.delete(HL_QUOTED)
      }
    })
  }
}
