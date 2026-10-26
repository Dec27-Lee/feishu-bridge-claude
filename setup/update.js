'use strict';

// 更新器。项目改了之后，用它把本机同步到新版本。
//
//   node setup/update.js                 完整流程：拉取 → 校验 → 迁移配置 → 提示重启
//   node setup/update.js --check         只看有没有新版本，不动任何东西
//   node setup/update.js --yes           非交互（给 AI 用）
//
// 为什么不让人手动 git pull：
//   1. 拉完还要按新 schema 迁移 config.json，否则新加的配置项用户永远拿不到
//   2. 钩子里的命令是绝对路径，项目换目录后必须重装 hooks
//   3. 插件 manifest 变了要重新校验，别等到运行时才发现
//
// 安全：全程不碰 git 历史（不 reset、不 clean），只做 fast-forward；
// 配置迁移前先备份，迁移后逐项报告改了什么。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGS = new Set(process.argv.slice(2));
const YES = ARGS.has('--yes');
const CHECK_ONLY = ARGS.has('--check');
const DRY = ARGS.has('--dry-run');

function say(m) { console.log(m); }
function step(m) { console.log(`\n=== ${m} ===`); }

function git(args, opts) {
  const r = spawnSync('git', args, {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, ...opts,
  });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim(), status: r.status };
}

function isGitRepo() {
  const r = git(['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.out.includes('true');
}

// ---- 1. 拉取 ----

function fetchAndCompare() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok) return { ok: false, why: '读不到当前分支' };

  const f = git(['fetch', '--quiet', 'origin', branch.out]);
  if (!f.ok) return { ok: false, why: `拉取远端失败：${f.out.slice(0, 300)}` };

  const local = git(['rev-parse', 'HEAD']);
  const remote = git(['rev-parse', `origin/${branch.out}`]);
  if (!local.ok || !remote.ok) return { ok: false, why: '读不到提交号' };

  // 本地是否有未提交改动：有的话不自动合并，避免踩掉用户的东西
  const dirty = git(['status', '--porcelain']);
  const changed = local.out !== remote.out;

  // 有多少个提交落在后面
  let behind = 0;
  if (changed) {
    const cnt = git(['rev-list', '--count', `HEAD..origin/${branch.out}`]);
    behind = cnt.ok ? parseInt(cnt.out, 10) || 0 : 0;
  }

  return {
    ok: true,
    branch: branch.out,
    local: local.out.slice(0, 8),
    remote: remote.out.slice(0, 8),
    behind,
    dirty: dirty.ok && dirty.out.length > 0,
    dirtyFiles: dirty.ok ? dirty.out.split('\n').filter(Boolean).slice(0, 10) : [],
    upToDate: !changed,
  };
}

// ---- 2. 配置迁移 ----

// 新版本可能加了配置项。schema 里带默认值，所以只要把用户已有的值原样保留、
// 缺的键补上默认值即可。多出来的键（插件被删了）保留不动，只提示。
function migrateConfig() {
  const cfgFile = path.join(ROOT, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    return { changed: false, note: '还没有 config.json，跳过迁移（先跑 setup/install.js）' };
  }

  let user;
  try {
    user = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch (e) {
    return { error: `config.json 解析失败：${e.message}` };
  }

  const plugin = require('../kernel/plugin');
  const config = require('../kernel/config');
  const byId = Object.fromEntries(plugin.discover().map((m) => [m.id, m]));

  const next = { ...user };
  const added = [];

  // 顶层：缺的键补默认
  const topDefaults = config.defaults(config.TOP_SCHEMA);
  for (const [k, v] of Object.entries(topDefaults)) {
    if (next[k] === undefined && k !== 'plugins') {
      next[k] = v;
      added.push(k);
    }
  }

  // 插件：只补该插件 schema 里声明过的键
  next.plugins = { ...(next.plugins || {}) };
  for (const [id, m] of Object.entries(byId)) {
    const cur = next.plugins[id] || {};
    const d = config.defaults(m.config || {});
    const merged = { ...d, ...cur };
    for (const k of Object.keys(d)) {
      if (cur[k] === undefined) added.push(`plugins.${id}.${k}`);
    }
    next.plugins[id] = merged;
  }

  // 校验：迁移后必须合法，否则不写
  const r = config.resolveAll(byId, next);
  if (r.errors.length) {
    return { error: `迁移后校验不通过：${r.errors.join('；')}` };
  }

  if (!added.length) return { changed: false, warnings: r.warnings };

  if (!DRY) {
    const bak = `${cfgFile}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    fs.copyFileSync(cfgFile, bak);
    const tmp = `${cfgFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, cfgFile);
  }
  return { changed: true, added, warnings: r.warnings };
}

// ---- 3. hooks 是否需要重装 ----

// 项目可能被移动了目录，hook 里的绝对路径就失效了。这里比对一下。
function hooksStale() {
  const hooksCfg = require('./hooks-config');
  const home = process.env.FEISHU_INSTALL_HOME || require('os').homedir();
  const file = path.join(home, '.claude', 'settings.json');
  if (!fs.existsSync(file)) return { installed: false, stale: false };

  let settings;
  try {
    // 剥 BOM：有些工具会写，JSON.parse 不认
    const raw = fs.readFileSync(file, 'utf8');
    settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (_) {
    return { installed: false, stale: false, error: 'settings.json 解析失败' };
  }
  if (!hooksCfg.installed(settings)) return { installed: false, stale: false };

  // 装是装了，但指向的路径还在不在
  const cmds = [];
  for (const entries of Object.values(settings.hooks || {})) {
    for (const e of entries) for (const h of (e.hooks || [])) {
      if (hooksCfg.isOwnCommand(h && h.command)) cmds.push(h.command);
    }
  }
  // 解析交给 hooks-config：command 里 node 的绝对路径本身含 "node"，
  // 用 /node\s+(.+\.js)/ 会匹配不上，这项检查就静默失效了。
  const missing = cmds.filter((c) => {
    const script = hooksCfg.scriptPathFromCommand(c);
    return script && !fs.existsSync(script);
  });
  return { installed: true, stale: missing.length > 0, missing };
}

// ---- 主流程 ----

function main() {
  say(`更新检查：${ROOT}`);

  if (!isGitRepo()) {
    say('这里不是 git 仓库（可能是下载的 zip）。');
    say('这种情况重新下载最新版覆盖即可，然后跑 node setup/update.js --yes 做配置迁移。');
  } else {
    step('1. 检查远端');
    const c = fetchAndCompare();
    if (!c.ok) {
      say(`  ✗ ${c.why}`);
      process.exit(1);
    }
    say(`  分支 ${c.branch}：本地 ${c.local}，远端 ${c.remote}`);
    if (c.upToDate) {
      say('  已是最新。');
    } else {
      say(`  落后 ${c.behind} 个提交。`);
      if (c.dirty) {
        step('本地有未提交的改动，已停止');
        c.dirtyFiles.forEach((f) => say(`  M ${f}`));
        say('\n  请先提交或暂存这些改动，避免更新把它们冲掉：');
        say('    git stash        # 暂存');
        say('    git pull --ff-only');
        say('    git stash pop');
        process.exit(1);
      }
      if (CHECK_ONLY) {
        say('\n  --check 模式，不执行拉取。');
        process.exit(0);
      }
      if (!YES && process.stdin.isTTY !== true) {
        say('\n  非交互环境下需要 --yes 才会执行拉取。');
        process.exit(0);
      }

      step('2. 拉取');
      if (DRY) {
        say('  （--dry-run：将执行 git pull --ff-only）');
      } else {
        // 只用 fast-forward：有分叉就停下让人处理，绝不自动 merge/rebase
        const p = git(['pull', '--ff-only']);
        say(p.ok ? `  ✓ ${p.out.split('\n').slice(-1)[0] || '已更新'}` : `  ✗ ${p.out.slice(0, 500)}`);
        if (!p.ok) process.exit(1);
      }
    }
  }

  step('3. 配置迁移');
  const m = migrateConfig();
  if (m.error) {
    say(`  ✗ ${m.error}`);
    process.exit(1);
  }
  if (m.changed) {
    say(`  补齐了 ${m.added.length} 项默认值：`);
    m.added.slice(0, 20).forEach((k) => say(`    + ${k}`));
    if (m.added.length > 20) say(`    …还有 ${m.added.length - 20} 项`);
    if (!DRY) say('  原配置已备份为 config.json.bak-<时间戳>');
  } else {
    say(`  ${m.note || '无需迁移'}`);
  }
  (m.warnings || []).forEach((w) => say(`  ! ${w}`));

  step('4. hooks 一致性');
  const h = hooksStale();
  if (h.error) {
    say(`  ! ${h.error}`);
  } else if (!h.installed) {
    say('  还没装 hooks。跑 node setup/install.js --hooks');
  } else if (h.stale) {
    say('  hooks 里有失效路径（项目可能被移动过）：');
    h.missing.slice(0, 5).forEach((c) => say(`    ✗ ${c}`));
    say('  重新装一遍：node setup/install.js --hooks');
  } else {
    say('  ✓ 已安装且路径有效');
  }

  step('5. 完整性检查');
  const check = spawnSync(process.execPath, [path.join(__dirname, 'check.js')], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });
  const lines = (check.stdout || '').split('\n').filter((l) => l.startsWith('✗') || l.startsWith('!'));
  if (check.status === 0 && !lines.length) {
    say('  ✓ 全部通过');
  } else {
    lines.forEach((l) => say(`  ${l}`));
    say('  详见 node setup/check.js');
  }

  step('完成');
  say('重启 bridge 让新代码生效：');
  say('  Windows:  Stop-Process -Id (Get-Content data/bridge.pid) -Force');
  say('  macOS:    kill $(cat data/bridge.pid)');
  say('  自启会把它拉回来；没装自启就手动 node kernel/index.js');
  if (DRY) say('\n这是 --dry-run，什么都没改。');
}

main();
