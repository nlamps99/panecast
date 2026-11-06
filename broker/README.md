# Panecast 自建中转服务器

这个目录提供可自托管的 VPS Broker。使用它以后，Mac 和 iPhone 都只需
主动连接服务器，不需要在手机安装 Tailscale，也不需要给 Mac 开放入站端口。
同一个 broker 和域名可以连接多台 Mac、Linux 电脑，每台电脑分别配对和鉴权。

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
- 新版 broker 会通过已认证的隧道把 APNs 登记转给电脑，收到电脑确认后才报告成功。
  Apple 签名密钥和原始推送令牌保存在电脑；VPS 只保存令牌哈希。需要同时升级
  broker 和 relay，并在电脑配置 APNs。手机「设置 → 通知」可以发送测试推送。
  电脑离线或旧 relay 不支持转发时会明确报错，不会显示虚假的登记成功。

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

### 一个域名连接多台电脑

原有 `CMUX_RELAY_ID`、`CMUX_RELAY_TOKEN`、`CMUX_PAIRING_CODE` 配置继续有效。
要加入第二台电脑，使用独立的 JSON 配置：

```bash
cp relays.example.json relays.json
chmod 600 relays.json
```

为每台电脑分别生成 relay token 和 pairing code，四个值都应不同，然后填写：

```json
{
  "relays": [
    {
      "relay_id": "home-mac",
      "relay_token": "<Mac 的 relay token>",
      "pairing_code": "<Mac 的配对码>"
    },
    {
      "relay_id": "linux-box",
      "relay_token": "<Linux 的 relay token>",
      "pairing_code": "<Linux 的配对码>"
    }
  ]
}
```

`relays.json` 已加入 gitignore，不要提交该文件。原有电脑保留同一个 relay ID 和凭据，
已有手机配对就可以继续使用；不要更换 broker 数据卷。每台电脑的 relay token 和配对码
必须独立；配置中的重复 ID、重复密钥和空字段会在 broker 启动时被拒绝。

Docker 使用只读配置文件覆盖层：

```bash
# Linux 上，容器里的 node 用户为 UID/GID 1000，需要能读取配置。
sudo chgrp 1000 relays.json
chmod 640 relays.json
docker compose -f docker-compose.yml -f docker-compose.multi.yml up -d --build
```

如使用已有 nginx 网络，把第一个文件替换为 `docker-compose.note.yml`。现有 Caddyfile
无需修改：所有电脑仍使用同一个 HTTPS 域名，由 `relay_id` 选择电脑。覆盖层不会把 broker
端口直接开放到公网。宿主机仅应让管理者和容器的 GID 1000 读取配置。

不使用 Docker 时，运行 broker 的用户应拥有配置文件并保持权限 `600`：

```bash
CMUX_RELAYS_FILE=/absolute/path/relays.json npm start
```

也可以由进程管理器通过 `CMUX_RELAYS_JSON` 注入相同 JSON 对象。两个配置源不能同时设置。
选择任一多电脑配置源后，三个旧的单电脑变量被忽略，不会隐式合并。配置在启动时读取，
增加、删除电脑或更新凭据后需重启 broker。

Mac 的 `relay.json` 中设 `broker.relay_id` 为 `home-mac`，Linux tmux relay 的配置设为
`linux-box`，分别使用对应的 `relay_token`；两者的 `broker.url` 都是
`https://relay.example.com`。各电脑生成配对二维码时输入它自己的配对码，手机分别扫码，
就会出现两台电脑。tmux 的配置和配对命令见 [`../relay-tmux/README.md`](../relay-tmux/README.md)。

多电脑模式的 `GET /v1/health` 只返回 broker 服务状态，不显示电脑清单、数量或在线状态。
手机的连接诊断使用 `GET /v1/health?relay_id=home-mac`，携带这台电脑对应的手机 bearer
token，才能得到该电脑的 `relay_online`。其他电脑的令牌和未认证请求统一返回 401。
单电脑部署不带查询参数的健康检查仍保留原来的 `relay_online` 字段。

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

应看到 `broker transport enabled` 和 `connecting to broker`。单电脑部署再次访问健康接口时，
`relay_online` 应变为 `true`；多电脑部署可在手机中运行对应电脑的连接诊断。

## 4. 配对 iPhone

在 Mac 运行 `cmux-relay pair`，输入服务器的配对码。手机打开「添加电脑」扫描二维码，
也可以粘贴配对链接。完成后可在设置中选择自动、仅服务器或仅局域网，并运行连接自检。

第一次配对成功后，App 会把独立设备 token 存入 iOS Keychain，并清除本机
`UserDefaults` 中的 Pairing Code。修改 Server URL 或 Relay ID 时，旧 token 会
自动失效并要求重新配对。

## 设备管理

列出设备：

```bash
docker compose exec broker npm run devices -- list
```

多电脑部署可按 relay ID 筛选；使用同一组 Compose 文件运行命令，例如：

```bash
docker compose -f docker-compose.yml -f docker-compose.multi.yml exec broker npm run devices -- list --relay home-mac
```

撤销某台手机：

```bash
docker compose exec broker npm run devices -- revoke <device-id>
```

也可加 `--relay home-mac`，仅当设备属于这台电脑时才撤销。同一手机配对不同电脑会获得
独立设备 ID 和令牌；撤销其中一台电脑的配对，不会影响另一台电脑。

撤销会使新的 HTTP/WebSocket 鉴权立即失效，已有连接最迟在下一次设备同步时关闭
（默认 15 秒）。手机主动解除配对时同步立即执行。若怀疑 Mac relay token 泄露，
同时修改 VPS `.env` 和 Mac `relay.json` 中的值并重启两端。若只想禁止新手机
配对，修改 `CMUX_PAIRING_CODE` 并重启 Broker；已配对设备不受影响。
多电脑配置则修改 `relays.json` 中对应项。某台电脑的 relay 隧道被新连接替换时，只会让
该电脑的手机连接重新握手；其他电脑保持连接。启动时移除某个 relay 配置后，它原有的
手机令牌不能再访问该 relay；磁盘上的设备记录可通过管理命令清理。

后台推送使用设备授权列表：broker 每 15 秒同步一次，relay 的授权最长有效 45 秒。
撤销或隧道断开后，过期的设备记录不会继续作为推送授权。新的
`POST /v1/devices/me/apns/test` 使用手机自身的 bearer token，只向这台手机发送测试。
多电脑模式的 APNs 登记、测试与 `DELETE /v1/devices/me` 都需要 `?relay_id=…`。
通知偏好随登记请求转发到对应 relay；broker 保留 relay 回复的 `preferences_applied` 等
确认字段。每台电脑独立限制待处理推送请求，某台电脑超时不会占满另一台电脑的额度。

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
