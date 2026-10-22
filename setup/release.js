'use strict';

// 把 CHANGELOG.md 里的某个版本发成 GitHub Release。
//
//   node setup/release.js            # 取 CHANGELOG 最上面那个版本
//   node setup/release.js 1.0.4      # 指定版本
//   node setup/release.js --dry-run  # 只打印将要发的正文，不调 API
//
// 为什么需要这一步：**git tag 只是仓库里的一个指针，不会出现在 GitHub 的
// Releases 页面**。用户打开仓库看到的是 Releases，不是 tags。只打 tag 的结果
// 就是「提交推上去了、版本号写了，但同事/用户点进去什么都没有」。
//
// 凭据来源（按顺序取第一个可用的）：
//   1. 环境变量 GITHUB_TOKEN / GH_TOKEN
//   2. ~/.git-credentials 里 github.com 那一行的密码位
// 两处都没有就明确报错，不猜、不静默跳过。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const PKG = path.join(ROOT, 'package.json');
const DRY = process.argv.includes('--dry-run');
const VERSION_ARG = process.argv.slice(2).find((a) => !a.startsWith('--'));

function readChangelog() {
  if (!fs.existsSync(CHANGELOG)) die('找不到 CHANGELOG.md');
  return fs.readFileSync(CHANGELOG, 'utf8');
}

// 取某个版本的条目正文（不含标题行本身）。
// 版本之间的边界是下一个 `## `，所以从 start 往后找第一个 `## ` 就是 end。
function sectionOf(md, version) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function latestVersion(md) {
  const m = md.match(/^## (\S+)/m);
  return m ? m[1] : null;
}

function token() {
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    if (process.env[k]) return process.env[k];
  }
  try {
    const line = fs.readFileSync(path.join(os.homedir(), '.git-credentials'), 'utf8')
      .split('\n').find((l) => l.includes('github.com'));
    if (line) {
      const m = line.match(/^https?:\/\/[^:]*:([^@]+)@/);
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}

// 从 remote 里取 owner/repo。用 remote 而不是写死：仓库改名或 fork 后仍然对。
function repoSlug() {
  const cfg = path.join(ROOT, '.git', 'config');
  try {
    const txt = fs.readFileSync(cfg, 'utf8');
    const m = txt.match(/url\s*=\s*\S*github\.com[:/]([^/\s]+)\/([^\s.]+?)(?:\.git)?\s*$/m);
    if (m) return `${m[1]}/${m[2]}`;
  } catch (_) {}
  return null;
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const HEADERS = (tk) => ({
  Authorization: `Bearer ${tk}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
});

// 查已存在的 Release。404 是正常情况（还没发过），其余错误码必须报出来：
// 把「令牌没权限」误当成「还没有 Release」，下一步就会去创建，然后凭空失败。
async function apiGet(url, tk) {
  const res = await fetch(url, { headers: HEADERS(tk) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    die(`查询 Release 失败（HTTP ${res.status}）：${t.slice(0, 300)}`);
  }
  return res.json();
}

async function apiSend(method, url, tk, payload) {
  const res = await fetch(url, { method, headers: HEADERS(tk), body: JSON.stringify(payload) });
  const text = await res.text().catch(() => '');
  let j = {};
  try { j = JSON.parse(text); } catch (_) {}
  if (!res.ok) die(`GitHub 返回 ${res.status}：${(j.message || text).slice(0, 300)}`);
  return j;
}

async function main() {
  const md = readChangelog();
  const version = VERSION_ARG || latestVersion(md);
  if (!version) die('CHANGELOG.md 里没有任何 `## <版本>` 标题');

  const body = sectionOf(md, version);
  if (!body) die(`CHANGELOG.md 里找不到 ## ${version}（标题必须完全一致）`);

  // package.json 的 version 没有任何代码在读，但它是别人 `npm view` / 装包时看到的
  // 版本号，长期停在 1.0.0 会让人以为这个项目没更新过。发版时顺手对齐。
  let pkgVersion = null;
  try { pkgVersion = JSON.parse(fs.readFileSync(PKG, 'utf8')).version; } catch (_) {}
  const pkgStale = pkgVersion !== version;

  const slug = repoSlug();
  if (!slug) die('读不到 GitHub 仓库地址，检查 .git/config 的 remote url');

  const isTag = (() => {
    try {
      return require('child_process').spawnSync('git', ['tag', '-l', `v${version}`],
        { cwd: ROOT, encoding: 'utf8' }).stdout.trim() === `v${version}`;
    } catch (_) { return false; }
  })();

  console.log(`仓库：${slug}`);
  console.log(`版本：${version}    tag v${version}：${isTag ? '已存在' : '不存在'}`);
  if (pkgStale) console.log(`! package.json 还写着 ${pkgVersion}，与 CHANGELOG 的 ${version} 不一致`);
  console.log('--- 将要发布的正文 ---');
  console.log(body);
  console.log('----------------------');

  if (DRY) { console.log('\n--dry-run：没有调用 GitHub API。'); return; }
  if (!isTag) {
    die(`本地没有 tag v${version}。先 git tag -a v${version} -m "${version}" 并 push，`
      + '否则发出去的 Release 会挂在虚空里。');
  }
  if (pkgStale) {
    // 只改 version 这一行，保持原有格式（package.json 是手写的一行式，重排会让 diff 变噪音）
    const raw = fs.readFileSync(PKG, 'utf8');
    const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
    if (next === raw) die('package.json 里找不到 version 字段，无法对齐版本号');
    fs.writeFileSync(PKG, next, 'utf8');
    console.log(`✓ package.json 版本已对齐到 ${version}（记得一并提交）`);
  }

  const tk = token();
  if (!tk) die('找不到 GitHub 凭据（GITHUB_TOKEN / GH_TOKEN / ~/.git-credentials 都没有）');

  const payload = {
    tag_name: `v${version}`,
    name: `v${version}`,
    // 正文直接就是 CHANGELOG 那几条。不要再套一层 `## 这次改了什么`——
    // Release 页面顶上已经有版本号当标题，再加一级标题只是重复。
    body,
    draft: false,
    prerelease: false,
  };

  // 已经发过同 tag 的 Release：不新建，但把正文更新成本次 CHANGELOG 的内容。
  // 只提示「已存在」是不够的——写错正文时人只能去网页上手工改，脚本却装作没事发生。
  const existing = await apiGet(`https://api.github.com/repos/${slug}/releases/tags/v${version}`, tk);
  if (existing) {
    if (existing.body === body) {
      console.log(`\n= v${version} 的 Release 已存在，正文与 CHANGELOG 一致，无需改动。`);
      console.log(`  ${existing.html_url}`);
      return;
    }
    const patched = await apiSend('PATCH', `https://api.github.com/repos/${slug}/releases/${existing.id}`, tk, { body });
    if (!patched || !patched.html_url) die('更新已存在的 Release 失败');
    console.log(`\n✓ 正文已更新：${patched.html_url}`);
    return;
  }

  const j = await apiSend('POST', `https://api.github.com/repos/${slug}/releases`, tk, payload);
  if (!j || !j.html_url) die('创建 Release 失败');
  console.log(`\n✓ 已发布：${j.html_url}`);
}

main().catch((e) => die(e.message));
