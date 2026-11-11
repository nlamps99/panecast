#!/usr/bin/env python3
"""Package a verified tagged Release build of cmux DR2 on macOS."""
import argparse
import datetime
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(*command, **kwargs):
    return subprocess.run(list(map(str, command)), check=True, **kwargs)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--revision', default='r1')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.source_commit) or not re.fullmatch(r'r[1-9][0-9]*', args.revision):
        parser.error('Expected a source commit SHA and rN revision')
    repo, output = args.repo.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error('Use a new empty output directory; published artifacts are immutable')
    original = plistlib.loads((args.app / 'Contents/Info.plist').read_bytes())
    bundle_id = original['CFBundleIdentifier']
    if bundle_id != 'com.cmuxterm.app.debug.dr2.selfhost':
        parser.error('Only the independent dr2-selfhost app can be packaged')
    version = original['CFBundleShortVersionString']
    upstream_version = '0.65.2.2'
    profile = original['CMUXSelfHostedConfiguration']
    if profile['origin'] != 'https://ipcraft.drinklake.com':
        parser.error('Unexpected self-hosted service origin')
    # Verified independently with gh attestation verify against the upstream
    # workflow and exact source digest before packaging this stable release.
    helper_manifest = args.app / 'Contents/Resources/bin/cmux-tui-ssh/manifest.json'
    if sha256(helper_manifest) != '5d2d1d3f7d5d9da51e61624a455744eddbc4230ea8379d0a408b3ad8d1c37d45':
        parser.error('The helper manifest differs from the verified upstream attestation')
    stem = f'cmux-dr2-{upstream_version}-{args.revision}'
    base = 'https://ningzx.cn/panecast/cmux'
    readme = f'''cmux DR2 {upstream_version} / {args.revision}

适用于 macOS 14 或更新版本，Apple Silicon（M 系列芯片）。
这是基于 cmux v{upstream_version} 源码制作的独立自建版，应用名称为 cmux DR2。
服务地址已配置为 https://ipcraft.drinklake.com，无需自己改代码。

安装
1. 将 cmux DR2 拖到「应用程序」。
2. 此包使用 ad-hoc 签名，尚未经过 Apple 公证。
   如果提示「已损坏」或「移到废纸篓」，打开「终端」并粘贴：
   curl -fsSL {base}/install.sh | bash
   安装器校验固定 SHA-256、应用标识、版本和签名完整性，
   然后仅移除本应用的下载隔离标记；不会关闭系统 Gatekeeper。
3. 打开 cmux DR2，用个人设备账号的邮箱和密码登录。
   两台 Mac 登录同一个个人账号，打开「设置 → 设备」。
   被控制端开启「让此 Mac 可被发现」，操作端开启「发现其他设备」，
   然后从设备列表连接。管理员账号只用于管理后台。
   下载包中不包含个人密码或管理员密钥。
4. 用 Panecast 在手机上查看这台 Mac 的终端：安装 Panecast 网关
   （https://ningzx.cn/panecast/），网关会自动连接 cmux DR2。
   本版的「套接字控制模式」默认为「自动化模式」，允许以当前用户身份运行的程序
   控制 cmux；可在设置中改回「仅限 cmux 进程」，改回后网关无法连接。

升级
从 {base}/ 下载新版或重新运行安装命令。
独立应用标识：{bundle_id}
此发行版不会通过官方更新渠道替换自身。升级时请先退出 cmux DR2。

更换自建服务器
先退出账号，再退出 cmux DR2。将完整服务配置存为
~/.config/cmux-dr2/server.json，然后重新打开应用。
JSON 必须含 origin、projectID、publishableClientKey、environment 四项。
origin 必须是 HTTPS 根地址；后面三项由你自己的服务部署提供。
删除该文件即可恢复随安装包附带的 dr2 配置。

源码及许可
上游：https://github.com/manaflow-ai/cmux/releases/tag/v{upstream_version}
自建源码提交：{args.source_commit}
对应源代码：{base}/{stem}-source.tar.gz
源码包包含修改、构建说明、固定版本依赖信息及许可证。
原生客户端 GPL-3.0-or-later；其他部分遵循各自许可证。
本包不是 cmux 官方发行版；服务端由你自己的 dr2 部署提供。
'''
    with tempfile.TemporaryDirectory(prefix='cmux-dr2-package-', dir=output.parent) as work:
        stage = Path(work)
        app = stage / 'cmux DR2.app'
        run('/usr/bin/ditto', args.app, app)
        info_path = app / 'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        # Tagged builds contain developer-machine paths and permissive socket
        # settings. The distributable keeps only its independent identity.
        info['LSEnvironment'] = {
            'CMUX_BUNDLE_ID': bundle_id,
            'CMUX_TAG': 'dr2-selfhost',
            'CMUX_AUTH_CALLBACK_SCHEME': 'cmux-dev-dr2-selfhost',
        }
        info.pop('CMUXCloudDogfoodEnabled', None)
        info['SUEnableAutomaticChecks'] = False
        info['SUAllowsAutomaticUpdates'] = False
        info_path.write_bytes(plistlib.dumps(info))
        run(repo / 'scripts/thin-app-bundle.sh', app, 'arm64')
        run(repo / 'scripts/strip-release-bundle.sh', app)
        entitlements = plistlib.loads((repo / 'cmux.entitlements').read_bytes())
        for key in ['keychain-access-groups', 'com.apple.developer.web-browser.public-key-credential']:
            entitlements.pop(key, None)
        entitlement_path = stage / 'dr2.entitlements'
        entitlement_path.write_bytes(plistlib.dumps(entitlements))
        run(repo / 'scripts/sign-cmux-bundle.sh', app, entitlement_path, '-',
            cwd=repo, env={**os.environ, 'CMUX_TIMESTAMP': 'none'})
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', app)
        run(app / 'Contents/Resources/bin/cmux', '--version')
        zip_path = output / f'{stem}-macos-arm64.zip'
        run('/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, zip_path)
        dmg_root = stage / 'disk'
        dmg_root.mkdir()
        run('/usr/bin/ditto', app, dmg_root / app.name)
        (dmg_root / 'Applications').symlink_to('/Applications')
        (dmg_root / '安装说明.txt').write_text(readme)
        shutil.copyfile(repo / 'LICENSE', dmg_root / 'LICENSE.txt')
        dmg_path = output / f'{stem}-macos-arm64.dmg'
        run('/usr/bin/hdiutil', 'create', '-volname', f'cmux DR2 {version}', '-srcfolder', dmg_root,
            '-format', 'UDZO', '-imagekey', 'zlib-level=9', dmg_path)
        run('/usr/bin/hdiutil', 'verify', dmg_path)
    source_path = output / f'{stem}-source.tar.gz'
    shutil.copyfile(args.source, source_path)
    installer = (HERE / 'install.sh.in').read_text()
    values = {'VERSION': version, 'ARCH': 'arm64', 'ARCHIVE': zip_path.name,
              'SHA256': sha256(zip_path), 'BASE_URL': base, 'BUNDLE_ID': bundle_id}
    for key, value in values.items():
        installer = installer.replace(f'@{key}@', value)
    if re.search(r'@[A-Z_]+@', installer):
        raise SystemExit('Unresolved installer placeholder')
    script_path = output / f'install-{stem}-macos-arm64.sh'
    script_path.write_text(installer)
    run('/bin/bash', '-n', script_path)
    shutil.copyfile(script_path, output / 'install.sh')
    (output / 'README.txt').write_text(readme)
    for path in (HERE / 'site').iterdir():
        shutil.copyfile(path, output / path.name)
    artifacts = {}
    for name, path in [('dmg', dmg_path), ('archive', zip_path), ('source', source_path), ('installer', script_path)]:
        artifacts[name] = {'file': path.name, 'size': path.stat().st_size, 'sha256': sha256(path)}
        (output / (path.name + '.sha256')).write_text(artifacts[name]['sha256'] + '  ' + path.name + '\n')
    manifest = {'upstreamVersion': upstream_version, 'appVersion': version, 'revision': args.revision, 'sourceCommit': args.source_commit,
                'upstreamCommit': '12023d89feb5425c766ba05e8d8e4cfc176e3991',
                'publishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'architecture': 'arm64', 'minimumMacOS': '14.0', 'bundleIdentifier': bundle_id,
                'serverOrigin': profile['origin'], 'signing': 'ad-hoc', 'notarized': False, **artifacts}
    manifest['bundledTerminalHelperCommit'] = '786ab29824b470de376a8030d60f1445dde241cc'
    (output / 'release.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(item['sha256'] + '  ' + item['file'] + '\n' for item in artifacts.values()))
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
