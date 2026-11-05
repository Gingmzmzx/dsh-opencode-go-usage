# dsh-opencode-go-usage

在 DSH Web 界面的**左下角**（侧边栏底部、设置按钮上方）以进度条展示
[OpenCode Go](https://opencode.ai) 订阅的三档用量：

| 窗口 | 说明 |
| --- | --- |
| 5 小时 | rolling（滚动 5 小时窗口） |
| 本周 | weekly |
| 本月 | monthly |

每行显示用量百分比和进度条；悬停可查看各窗口的重置时间。
用量 ≥ 80% 时进度条变为警告色，≥ 95% 变为错误色。侧边栏收起为 56px 图标栏时自动隐藏（该宽度放不下进度条，避免裁切）。

## 工作原理

OpenCode Go 的用量接口需要 Bearer Token，浏览器不能持有该密钥，因此插件分为两半：

- **Host 半**（`lib/index.js`）
  - 通过宿主 `credentials` 服务解析 `OPENCODE_GO_API_KEY`
    （与 profile 中 `llm-pi-ai` 的 `apiKeyEnv` 使用同一个引用，无需额外配置；
    也支持宿主进程环境变量）。
  - 请求 `https://opencode.ai/zen/go/v1/usage`
    （`Authorization: Bearer …`），成功结果缓存 30 秒，并发请求合并为一次上游调用。
  - 在 `GET /opencode-go-usage/usage` 提供同源 JSON 快照；路由受宿主的
    `connection.requestRejection` 信任栅栏保护。
- **Client 半**（`lib/client.js`）
  - 注册到 `sidebar.footer.action` 槽位，每分钟轮询一次快照，
    页面重新可见或点击刷新按钮时立即刷新。
  - 文案走 client `locale` 服务（中文/英文），颜色只使用 `--dsw-alias-*` 主题变量。

## 安装

在 Web 界面安装（推荐）：**设置 → 插件 → 添加插件**，填入
`github:Gingmzmzx/dsh-opencode-go-usage`（或本地目录的绝对路径）。
安装器会执行 `pnpm add`、把包加入 profile 的 `dsh.profile.bundles`、
启用并重载。

命令行安装分两步（`dsh plugin ... add` 只转发给 pnpm，不会启用 bundle）：

```bash
dsh plugin --profile web add github:Gingmzmzx/dsh-opencode-go-usage
# 再把 "dsh-opencode-go-usage" 加进 ~/.dsh/profiles/web/package.json
# 的 dsh.profile.bundles，然后重启/重载 DSH
```

本地开发安装（`link:` 到本目录，改动即时生效）：

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-opencode-go-usage
```

同样需要把包名加入 `dsh.profile.bundles`。`link:` 必须指向固定不变的绝对路径，
安装后不要移动或删除该目录。

安装后刷新页面即可看到侧边栏底部的进度条。若用量区域显示
“未配置 OPENCODE_GO_API_KEY”，请在 profile 的凭据中写入该 key
（与 `llm-pi-ai` 的 `opencode-go` provider 使用的相同）。

### 分发到其他机器

不需要 GitHub 或 npm；插件目录本身就是完整的 bundle：

1. 复制目录（或 `npm pack` 生成的 `dsh-opencode-go-usage-0.1.0.tgz`）到目标机器上
   一个**固定不变**的位置，例如 `~/.dsh/plugins/dsh-opencode-go-usage`。
   `link:` 安装是指向该目录的软链接，安装后不要移动或删除它。
2. 在目标机器的 DSH Web 里打开“设置 → 插件 → 添加插件”，填入该目录的绝对路径
   （或 `.tgz` 的绝对路径）。安装器会执行 `pnpm add`、把包加入
   `dsh.profile.bundles` 并自动启用、重载。
3. 目标机器需要能访问 `https://opencode.ai`，并且有 `OPENCODE_GO_API_KEY`：
   profile 凭据里已有就直接可用；否则在启动 DSH 前导出该环境变量
   （Host 半会先查 credentials 服务，再回退到进程环境变量）。

只想要命令行时，注意 `dsh plugin --profile web add <包>` 只做 pnpm 安装，
还必须把包名加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，
否则不会挂载。GUI 安装会自动完成这两步。

上面的 `github:` 形式要求仓库已经推送；也可以 `npm publish` 后直接从 npm 安装。
发布 npm 前递增版本号即可（本包已不是 `private`）。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/opencode-go-usage/usage` | 返回 `{ ok, fetchedAt, windows: [{ key, percent, resetsAt }] }` |

上游不可用时返回 `502 { ok:false, error }`；未配置密钥时返回
`200 { ok:false, error:{ code:"no-credentials" } }`（不会缓存失败结果）。

## 开发与测试

```bash
node test/host.test.mjs     # Host 半：路由、信任栅栏、方法处理、解析、无凭据分支
node test/client.test.mjs   # Client 半：用假 React 运行时离线渲染三种状态
# 或一次跑完
npm test
```

带真实 key 探测上游：

```bash
OPENCODE_GO_API_KEY=... node test/host.test.mjs
```

## License

[MIT](LICENSE)
