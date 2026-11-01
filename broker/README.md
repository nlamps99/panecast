# cmux Remote 自建中转服务器

这个目录提供可自托管的 VPS Broker。使用它以后，Mac 和 iPhone 都只需
主动连接服务器，不需要在手机安装 Tailscale，也不需要给 Mac 开放入站端口。

```text
iPhone -- HTTPS/WSS --> VPS Broker <-- WSS -- Mac cmux-relay --> cmux Unix socket
```

默认的 Tailscale Direct 模式仍然保留。`relay.json` 的 `transport` 支持：

- `direct`：只启用原 Tailscale HTTP/WebSocket 服务，也是默认值。
- `broker`：只主动连接 VPS，不监听本机 `4399`，也不读取 Tailscale 身份。
- `both`：两种方式同时启用。

## 同一 Wi-Fi 时走局域网直连（AUTO 模式）

VPS 转发要跨两段公网 RTT，在同一 Wi-Fi 下这笔开销完全没必要。给 `relay.json`
加一个 `lan` 配置块，手机就能在家走局域网、出门自动回退到 VPS：

```text
在家：iPhone --- HTTP/WS ---> Mac cmux-relay        (一跳，局域网)
出门：iPhone -- HTTPS/WSS --> VPS Broker <-- WSS -- Mac cmux-relay
```

完整配置见 [`relay.lan-fallback.example.json`](relay.lan-fallback.example.json)。
关键是 `transport` 设为 `both`，并生成一个**独立于** broker pairing code 的
局域网配对码：

```bash
openssl rand -hex 32   # lan.pairing_code，不要复用其他任何密钥
```

改完 `relay.json` 后重启 relay，然后在 Mac 上生成二维码：

```bash
launchctl kickstart -k "gui/$(id -u)/com.genie.cmuxremote"
./relay/.build/release/cmux-relay pair       # 会自动探测本机局域网 IP
```

二维码里会同时带上局域网地址和 VPS 地址。手机扫码后连接模式自动变成
`AUTO`，无需手动填两套配置。如果自动探测到的网卡不对（Mac 上有 Docker 或
VPN 时常见），用 `--lan-host` 指定：

```bash
./relay/.build/release/cmux-relay pair --lan-host 192.168.1.42
```

### AUTO 模式的工作方式

App 每次连接前会先探测局域网地址的 `/v1/health`（1.2 秒超时）：通了就走局域网，
不通就用 VPS。网络路径变化时（切 Wi-Fi、出门转 5G）会重新探测，只有在结论
变化时才重连。

之所以用探测而不是判断 Wi-Fi 名称或网卡类型：手机连着 Wi-Fi 但在访客网络、
不同子网，或者 Mac 睡着了，这几种情况从网卡角度看完全一样，只有探测能区分。

### 局域网直连为什么需要配对码

Direct 模式原本靠 `tailscaled whois` 验证来访者身份，这只对经由 Tailnet
过来的连接有效。手机从 `192.168.x.x` 连过来时 tailscaled 不认识这个地址，
所以必须换一条验证路径：`lan.pairing_code`。

这条路径有三重限制：来访地址必须是 RFC1918 私有段（Tailscale 的
`100.64.0.0/10` 被**排除**在外，那条路继续走 whois）、配对码按来源 IP 限速
每分钟 5 次、比较用常数时间。`lan.pairing_code` 为空时整条路径关闭。

### 安全边界（与 VPS 模式不同）

- **局域网链路是明文 HTTP/WS。** 终端内容和 bearer token 在 Wi-Fi 上不加密。
  同一网络内持有 WPA2 PSK 的设备理论上可以解密抓包。只在自己可信的网络下
  开启；咖啡店、酒店 Wi-Fi 不要用。
- 相比之下 Tailscale Direct 是端到端 WireGuard 加密，VPS 模式到两端都是 TLS。
  如果你需要局域网也加密，用 Tailscale Direct 而不是这条路径。
- 手机为两个端点各自持有一份独立 token（分别来自 Mac 的 `devices.json` 和
  VPS 的库），互不通用。撤销时两边都要处理。

## 安全边界

- Caddy 自动签发公网 TLS 证书，iPhone 和 Mac 到 VPS 的链路都是 TLS。
- 手机 bearer token 在服务器磁盘上只保存 SHA-256，不保存明文。
- Mac 使用独立的 relay token；配对码只用于签发手机 token。
- 配对接口按来源 IP 限速，WebSocket 最大消息为 32 MB。
- **当前不是端到端加密。** VPS Broker 会转发明文终端帧，因此控制 VPS 的人
  理论上可以读取终端内容。只应部署在自己控制的服务器上。E2E 加密需要作为
  独立协议升级实现，不能把 TLS 等同于 E2E。
- Server 模式目前不代发 APNs。App 活跃且 WebSocket 在线时，Inbox 和本地
  通知正常；App 被系统彻底终止后不会由 VPS 补发通知。

## 1. 准备 VPS 与域名

需要一台带公网 IP 的 Linux VPS、Docker Compose，以及一个域名。把域名的
`A`（和可选的 `AAAA`）记录指向 VPS，并在防火墙放行 TCP `80/443` 与 UDP
`443`。Broker 容器本身不映射到公网，只有 Caddy 对外监听。

分别生成两个不同的随机值：

```bash
openssl rand -hex 32   # CMUX_RELAY_TOKEN
openssl rand -hex 32   # CMUX_PAIRING_CODE
```

不要让 relay token 与 pairing code 相同。

## 2. 启动 Broker

把仓库放到 VPS 后执行：

```bash
cd panecast/broker
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```dotenv
CMUX_BROKER_DOMAIN=relay.example.com
CMUX_RELAY_ID=home-mac
CMUX_RELAY_TOKEN=<第一个随机值>
CMUX_PAIRING_CODE=<第二个随机值>
```

启动并检查：

```bash
docker compose up -d --build
docker compose logs -f --tail=100
curl https://relay.example.com/v1/health
```

正常响应示例：

```json
{"ok":true,"relay_online":false,"version":"0.1.0"}
```

此时 `relay_online:false` 是正常的，表示 Mac 还没有连接。

## 3. 配置 Mac Relay

先从 **cmux 内的终端** 安装 relay：

```bash
cd panecast
./relay/scripts/install-launchd.sh
```

cmux 默认的 owner-only socket 模式会给内部终端注入一枚 capability。安装脚本
会把它保存到 `~/.cmuxremote/socket-control-capability`（权限 `600`），launchd
只保存该文件路径，不保存凭据本身。若日志出现 `only processes started inside
cmux can connect`，回到 cmux 终端重新运行安装脚本即可刷新 capability。

然后把 `~/.cmuxremote/relay.json` 改为下面的结构，也可参考
[`relay.example.json`](relay.example.json)：

```json
{
  "transport": "broker",
  "broker": {
    "url": "https://relay.example.com",
    "relay_id": "home-mac",
    "relay_token": "<与 VPS 的 CMUX_RELAY_TOKEN 完全相同>"
  },
  "default_fps": 15,
  "idle_fps": 5
}
```

保存后限制配置文件权限：

```bash
chmod 600 ~/.cmuxremote/relay.json
```

重启并查看日志：

```bash
launchctl kickstart -k "gui/$(id -u)/com.genie.cmuxremote"
tail -f ~/.cmuxremote/log/stderr.log
```

应看到 `broker transport enabled` 和 `connecting to broker`。再次访问健康接口时，
`relay_online` 应变为 `true`。

## 4. 配对 iPhone

在 App 的 Settings 中：

1. Connection Mode 选择 `SERVER`。
2. Server URL 填 `https://relay.example.com`。
3. Relay ID 填 `home-mac`。
4. Pairing Code 填 VPS 的 `CMUX_PAIRING_CODE`。
5. 点击 `SAVE & RECONNECT`。

第一次配对成功后，App 会把独立设备 token 存入 iOS Keychain，并清除本机
`UserDefaults` 中的 Pairing Code。修改 Server URL 或 Relay ID 时，旧 token 会
自动失效并要求重新配对。

## 设备管理

列出设备：

```bash
docker compose exec broker npm run devices -- list
```

撤销某台手机：

```bash
docker compose exec broker npm run devices -- revoke <device-id>
```

撤销后，已建立的连接最迟会在下次重连时失效。若怀疑 Mac relay token 泄露，
同时修改 VPS `.env` 和 Mac `relay.json` 中的值并重启两端。若只想禁止新手机
配对，修改 `CMUX_PAIRING_CODE` 并重启 Broker；已配对设备不受影响。

## 排查

| 现象 | 检查 |
|---|---|
| HTTPS 无法访问 | DNS 是否已生效，VPS 的 80/443 是否放行，查看 Caddy 日志 |
| `relay_online:false` | Mac 上 cmux 是否运行，`relay.json` 的 URL/ID/token 是否与 VPS 一致 |
| 手机 WebSocket 返回 503 | Mac relay 当前离线；先修复 Mac 到 Broker 的连接 |
| 配对返回 403 | Relay ID 或 Pairing Code 不一致 |
| App 显示 HTTPS 错误 | 公网 Server URL 必须使用受信任证书的 `https://` 地址 |
| 工作区为空或 RPC 报错 | 检查 Mac 的 cmux socket 与 `~/.cmuxremote/log/stderr.log` |
| AUTO 模式一直走 VPS | 在手机浏览器打开 `http://<Mac 局域网 IP>:4399/v1/health`；不通说明手机和 Mac 不在同一子网，或路由器开了 AP 隔离 |
| 局域网配对返回 403 | `transport` 是否为 `both`、`lan.pairing_code` 是否非空且与 App 中一致；来访地址必须是 RFC1918 私有段 |
| 局域网配对返回 429 | 同一 IP 一分钟内尝试超过 5 次，等一分钟再试 |
| `cmux-relay pair` 报无法探测局域网地址 | 用 `--lan-host <ip>` 手动指定 |

升级代码后，在 VPS 运行 `docker compose up -d --build`；在 Mac 重新运行
`./relay/scripts/install-launchd.sh`，以确保服务使用新构建的二进制。
