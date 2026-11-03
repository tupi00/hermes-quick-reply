/**
 * 纯函数单测：从 plugin.js 的 >>>PURE-HELPERS 段抠出来跑，不启动浏览器。
 * 用法：node test/helpers.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'plugin.js'), 'utf8')

const start = source.indexOf('// >>>PURE-HELPERS')
const end = source.indexOf('// <<<PURE-HELPERS')

if (start < 0 || end < 0) {
  throw new Error('PURE-HELPERS 标记没找到')
}

const code = source.slice(source.indexOf('\n', start) + 1, end)
const factory = new Function(
  `${code}\nreturn { clipQuote, quoteBody, matchKey, quoteKey, QUOTE_MAX_LINES, QUOTE_MAX_CHARS, ELLIPSIS }`
)
const { clipQuote, quoteBody, matchKey, quoteKey, ELLIPSIS } = factory()

let failed = 0
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)

  if (a === e) {
    console.log(`ok   ${label}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}\n  got: ${a}\n  want: ${e}`)
  }
}

// 单行短文本：原样引用 + 出处
eq('single line', quoteBody('你好，世界', 3), '> 你好，世界  （引用自第3轮回答）')

// 没有轮次：只写正文
eq('no turn', quoteBody('侧栏里选中的标题', null), '> 侧栏里选中的标题')

// 超过两行：只留前两行，标…（略），出处跟在最后一行
eq(
  'three lines',
  quoteBody('第一行\n第二行\n第三行', 7),
  '> 第一行\n> 第二行' + ELLIPSIS + '  （引用自第7轮回答）'
)

// 空行被丢掉，不算行数
eq('blank lines dropped', quoteBody('甲\n\n\n乙', 1), '> 甲\n> 乙  （引用自第1轮回答）')

// 超过 120 字：截断并标记
const long = '字'.repeat(200)
const clipped = quoteBody(long, null)
eq('long text truncated', clipped.length, 2 + 120 + ELLIPSIS.length)
eq('long text marks ellipsis', clipped.endsWith(ELLIPSIS), true)

// 制表符/连续空格压成一个空格
eq('whitespace collapsed', quoteBody('a\t\tb   c', 2), '> a b c  （引用自第2轮回答）')

// 空文本 → 空串（调用方据此跳过）
eq('empty', quoteBody('   \n  ', 4), '')

// matchKey 只留字：标点/空白/> 都不算
eq('matchKey', matchKey('> 你好，世界！ 123 abc'), '你好世界123abc')
eq('quoteKey ignores ellipsis', quoteKey('甲乙丙\n丁戊己\n庚'), matchKey('甲乙丙丁戊己'))

// clipQuote 结构
eq('clip quote shape', clipQuote('一\n二\n三'), { lines: ['一', '二'], truncated: true })

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}

console.log('\nall passed')
