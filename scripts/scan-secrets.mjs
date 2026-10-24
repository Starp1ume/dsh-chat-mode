#!/usr/bin/env node
/**
 * 发布前 secret 扫描（本地 + GitHub Actions 共用）。
 *
 * 目的：在提交 / 打 tag / 发布之前，拦住"把凭证写进仓库"这一类事故。
 * 只做静态检查：扫描文本里的高危模式与高危文件名，不读取、不构造真实凭证。
 *
 * 用法（在仓库根目录运行；也可从上层目录用 `node chat-mode/scripts/...` 调用）：
 *   node scripts/scan-secrets.mjs              # 扫描 git 跟踪文件的“工作区内容”（默认）
 *   node scripts/scan-secrets.mjs --staged     # 只扫描暂存区（git index）内容，最接近下一次提交
 *   node scripts/scan-secrets.mjs --all        # 连同未跟踪文件一起扫描
 *   node scripts/scan-secrets.mjs --history    # 扫描全部 git 历史：新增行 + 涉及过的危险文件名
 *   node scripts/scan-secrets.mjs --dir <目录> # 扫描任意目录（不依赖 git，便于自测）
 *
 * 输出约定：只打印命中片段的前 6 个字符与长度，绝不回显完整值。
 *
 * 保护范围说明：本脚本不能阻止 `git push`（服务端规则才能），它保证的是——
 * 1) PR 合入受保护分支前，CI 上这次扫描必须通过；
 * 2) 打 tag 后创建 GitHub Release 的流程依赖扫描通过；
 * 3) 本地提交前可用 --staged 自查暂存区。
 *
 * 注：本文件与 .github/workflows/ 下的工作流同样会被扫描；如果出现误报，
 *     只对确定的模式定义 / 测试样例做最小行级豁免，不按整个文件路径跳过。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 需要跳过的目录 / 文件（相对仓库根，posix 分隔符）。 */
const SKIP_PATHS = [
  /^\.git\//,
  /^node_modules\//,
  /^dist\//,
  /\.log$/i,
]

/**
 * 高危文本模式。label 用于报告。
 * 原则：宁可在文档里少写"字面量示例"，也不放过真实凭证。
 */
const PATTERNS = [
  { label: 'OpenAI/DeepSeek 风格 API key（sk-）', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'GitHub token（ghp_/github_pat_/gho_）', re: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{30,}|gho_[A-Za-z0-9]{36})\b/g },
  { label: 'AWS Access Key ID（AKIA…）', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Authorization 头的字面量值', re: /Authorization[\s"']*[:=][\s"']*(?!\$\{)[A-Za-z0-9._~+/=-]{12,}/gi },
  { label: 'Bearer 后的字面量 token', re: /\bBearer\s+(?!<|\$\{|\*{3})[A-Za-z0-9._~+/=-]{16,}/g },
  { label: 'userToken 的字面量赋值（代码 / JSON）', re: /["']?userToken["']?\s*[:=]\s*["'][^"'\s]{16,}["']/gi },
  { label: 'localStorage.setItem 写入字面量 userToken', re: /localStorage\.setItem\(\s*["']userToken["']\s*,\s*["'][^"']{16,}["']/g },
  // 插件实际保存的登录副本结构是 { v, token, savedAt }；被误存成 config.json 时没有 userToken 字段。
  // (?<![A-Za-z0-9_$]) 用来排除 userToken（已由上面的规则覆盖），避免重复报告。
  { label: '独立 token 字段的字面量（登录副本结构）', re: /(?<![A-Za-z0-9_$])["']?token["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}["']/gi },
  { label: '通用凭证字段的字面量赋值（apiKey/secret/token）', re: /\b(?:api[_-]?key|apikey|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{20,}["']/gi },
  { label: 'DSH 账号 cookie（ds_session_id=…）', re: /\bds_session_id\s*=\s*[A-Za-z0-9%._-]{16,}/g },
  { label: '私钥文件内容头（BEGIN … PRIVATE KEY）', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
]

/** 高危文件名：出现在仓库里通常就不是有意为之。 */
const SECRET_FILE = [
  { label: '环境变量文件', re: /(^|\/)\.env(?:\.(?!example$|sample$|template$)[^/]+)?$/i },
  { label: '私钥 / 证书文件', re: /\.(?:pem|key|p12|pfx|jks|keystore)$/i },
  { label: 'SSH 私钥', re: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i },
  { label: '凭证文件', re: /(^|\/)(?:credentials|creds)\.(?:ya?ml|json)$/i },
  { label: '登录态 / cookie 快照', re: /(^|\/)(?:cookies?|session|login[-_]?state)\.(?:json|txt|ya?ml)$/i },
]

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const dirIndex = args.indexOf('--dir')
const targetDir = dirIndex !== -1 ? args[dirIndex + 1] : undefined

/** 把命中的值遮蔽成"前 6 个字符 + 长度"，报告里绝不出现完整凭证。 */
function redact(value) {
  const head = value.slice(0, 6)
  return `${head}…(长度 ${value.length})`
}

/** 扫描一行文本，返回命中列表。 */
function scanLine(line) {
  const hits = []
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    const match = pattern.re.exec(line)
    if (match) hits.push({ label: pattern.label, sample: redact(match[0].trim()) })
  }
  return hits
}

/** 文件名规则命中列表。 */
function scanFileName(posixPath) {
  const hits = []
  for (const rule of SECRET_FILE) {
    if (rule.re.test(posixPath)) hits.push({ label: rule.label, sample: '（危险文件名）' })
  }
  return hits
}

/** 该路径是否被本工具排除。 */
function skipped(posixPath) {
  return SKIP_PATHS.some((re) => re.test(posixPath))
}

/** 递归遍历普通目录（--dir 模式）。 */
function walk(dir, sink = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name === '.git' || name === 'node_modules') continue
      walk(full, sink)
    } else {
      sink.push(full)
    }
  }
  return sink
}

/** 读取文本文件；二进制或超大文件返回 null。 */
function readTextFile(file) {
  try {
    const stat = statSync(file)
    if (stat.size > 2 * 1024 * 1024) return null
    return decodeText(readFileSync(file))
  } catch {
    return null
  }
}

/** Buffer → 文本；含 NUL 视为二进制返回 null。 */
function decodeText(buffer) {
  const text = buffer.toString('utf8')
  return text.includes('\u0000') ? null : text
}

function report(findings) {
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line}  [${finding.label}]  ${finding.sample}`)
  }
}

function finish(findings, summary) {
  if (findings.length === 0) {
    console.log(`secret-scan: OK（${summary}，未发现高危模式）`)
    process.exit(0)
  }
  console.error(`secret-scan: FAILED（${summary}，发现 ${findings.length} 处疑似凭证）`)
  process.exit(1)
}

/** 扫描一组工作区文件（路径相对给定根目录）。 */
function scanFiles(files, root, mode) {
  const findings = []
  let scanned = 0
  for (const relPath of files) {
    const posix = relPath.split('\\').join('/')
    if (skipped(posix)) continue
    for (const hit of scanFileName(posix)) {
      findings.push({ file: posix, line: 0, label: hit.label, sample: hit.sample })
    }
    const text = readTextFile(resolve(root, ...posix.split('/')))
    if (text === null) continue
    scanned += 1
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      for (const hit of scanLine(lines[index])) {
        findings.push({ file: posix, line: index + 1, label: hit.label, sample: hit.sample })
      }
    }
  }
  return { findings, scanned, mode }
}

function git(root, gitArgs, options = {}) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options })
}

function gitBuffer(root, gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, maxBuffer: 256 * 1024 * 1024 })
}

function findRepoRoot() {
  // 先按当前目录找；找不到再按脚本所在目录找（允许从上层目录调用 `node chat-mode/scripts/...`）。
  const candidates = [process.cwd(), resolve(dirname(fileURLToPath(import.meta.url)), '..')]
  for (const candidate of candidates) {
    try {
      // 探测时静默 git 的 stderr，避免“不是仓库”的正常失败污染输出。
      return execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: candidate,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      // 继续尝试下一个
    }
  }
  console.error('secret-scan: 当前目录不是 git 仓库（可用 --dir <目录> 扫描普通目录）')
  process.exit(2)
}

/**
 * 扫描暂存区（git index）里“下一次提交会包含的内容”。
 *
 * 不能读工作区文件：文件可以先加进 index、再把工作区改干净，这时提交仍会带上 index 里的内容。
 * 所以这里按 index 记录读取 blob 内容；危险文件名同样按 index 路径判断。
 */
function scanIndex(root) {
  const raw = git(root, ['ls-files', '-z', '--stage'])
  const findings = []
  let scanned = 0
  const seen = new Set()
  for (const entry of raw.split('\u0000')) {
    if (entry === '') continue
    const tabIndex = entry.indexOf('\t')
    if (tabIndex === -1) continue
    const [mode, sha] = entry.slice(0, tabIndex).split(' ')
    const posix = entry.slice(tabIndex + 1)
    if (skipped(posix)) continue
    if (seen.has(posix)) continue
    seen.add(posix)
    for (const hit of scanFileName(posix)) {
      findings.push({ file: posix, line: 0, label: hit.label, sample: hit.sample })
    }
    // 子模块（160000）没有可读的文本内容
    if (mode === '160000') continue
    let text = null
    try {
      text = decodeText(gitBuffer(root, ['cat-file', 'blob', sha]))
    } catch {
      text = null
    }
    if (text === null) continue
    scanned += 1
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      for (const hit of scanLine(lines[index])) {
        findings.push({ file: posix, line: index + 1, label: hit.label, sample: hit.sample })
      }
    }
  }
  return { findings, scanned, mode: '暂存区（git index）' }
}

/**
 * 历史文件名：用 NUL 分隔的 `git log --raw -z` 输出取真实路径。
 *
 * 不再解析 `diff --git` 标题——Git 默认会给中文 / 空格 / 特殊字符路径加双引号并转义，
 * 正则解析容易漏。NUL 分隔输出不对路径做引用，名字原样返回。
 * 覆盖新增、删除、修改、重命名、复制（-M -C 让 Git 报告改名与复制）。
 */
function historyPaths(root, findings) {
  const raw = git(root, ['log', '--all', '--raw', '--no-abbrev', '-z', '--format=COMMIT:%H', '-M', '-C'])
  const tokens = raw.split('\u0000')
  const seen = new Set()
  let commit = ''
  let paths = 0

  const record = (path) => {
    if (typeof path !== 'string' || path === '' || path === '/dev/null') return
    const posix = path.split('\\').join('/')
    if (skipped(posix)) return
    const key = `${commit}:${posix}`
    if (seen.has(key)) return
    seen.add(key)
    paths += 1
    for (const hit of scanFileName(posix)) {
      findings.push({ file: `commit ${commit} 中的 ${posix}`, line: 0, label: hit.label, sample: hit.sample })
    }
  }

  // 状态 token 形如 "\n:100644 100644 <sha> <sha> R100"：以 ':' 开头、字段结构固定。
  // 只有被认定为状态 token 后，才按 1 个（或改名/复制时 2 个）token 读取路径，
  // 因此中文、空格、特殊字符的路径不会被误判。
  const STATUS = /^:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ ([A-Z]\d*)?$/
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '') continue
    const commitToken = /^COMMIT:([0-9a-f]{40})$/.exec(token)
    if (commitToken !== null) {
      commit = commitToken[1].slice(0, 8)
      continue
    }
    const statusToken = token.startsWith('\n') ? token.slice(1) : token
    const match = STATUS.exec(statusToken)
    if (match === null) continue
    const status = match[1] || ''
    if (status.startsWith('R') || status.startsWith('C')) {
      record(tokens[index + 1])
      record(tokens[index + 2])
      index += 2
    } else {
      record(tokens[index + 1])
      index += 1
    }
  }
  return paths
}

/**
 * 扫描全部 git 历史里“新增过的行”与“出现过的危险文件名”。
 *
 * 文件名检查与新增行检查分开：历史提交过 `.env` 后删除，新增行扫描不会命中，
 * 但那个文件的内容已经进了历史。文件名检查用 historyPaths()（NUL 分隔、无引用）。
 */
function scanHistory(root) {
  const findings = []
  const paths = historyPaths(root, findings)
  const log = git(root, ['log', '--all', '-p', '--unified=0', '--no-color', '--format=commit %H'])
  let scanned = 0
  let commit = ''
  let currentPath = ''
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('commit ')) {
      commit = line.slice(7, 15)
      continue
    }
    // 仅用于“新增行”报告的路径标签；文件名检查不依赖这里（见 historyPaths）。
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      currentPath = match === null ? '' : match[2]
      continue
    }
    // 新增行：跳过 +++ 文件头与二进制说明。
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    if (line.startsWith('Binary files')) continue
    scanned += 1
    const fileLabel = currentPath || '(未知文件)'
    for (const hit of scanLine(line.slice(1))) {
      findings.push({ file: `commit ${commit} 中的 ${fileLabel}`, line: 0, label: hit.label, sample: hit.sample })
    }
  }
  return { findings, scanned, paths, mode: 'git history' }
}

// ---- 主流程 ----
if (targetDir !== undefined) {
  const root = resolve(targetDir)
  if (!existsSync(root)) {
    console.error(`secret-scan: 目录不存在：${root}`)
    process.exit(2)
  }
  const files = walk(root).map((full) => relative(root, full))
  const result = scanFiles(files, root, '--dir 模式')
  report(result.findings)
  finish(result.findings, `${result.mode}，${result.scanned} 个文件`)
}

const root = findRepoRoot()

if (flags.has('--history')) {
  const result = scanHistory(root)
  report(result.findings)
  finish(result.findings, `${result.mode}，新增行 ${result.scanned}、涉及路径 ${result.paths}`)
}

if (flags.has('--staged')) {
  const result = scanIndex(root)
  report(result.findings)
  finish(result.findings, `${result.mode}，${result.scanned} 个文件`)
}

const tracked = git(root, ['ls-files', '-z']).split('\u0000').filter(Boolean)
const untracked = flags.has('--all')
  ? git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\u0000').filter(Boolean)
  : []
const result = scanFiles([...tracked, ...untracked], root, flags.has('--all') ? '工作区（含未跟踪）' : 'git 跟踪文件（工作区内容）')
report(result.findings)
finish(result.findings, `${result.mode}，${result.scanned} 个文件`)
