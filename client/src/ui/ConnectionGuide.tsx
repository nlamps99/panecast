import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Sheet, useSheet } from './Sheet';
import { colors, fonts } from './theme';

export function ConnectionGuide() {
  const sheet = useSheet();
  const [message, setMessage] = useState('');
  const copy = async (command: string) => {
    try { setMessage(await Clipboard.setStringAsync(command) ? '命令已复制' : '复制失败，可以长按命令复制'); }
    catch { setMessage('复制失败，可以长按命令复制'); }
  };
  return <>
    <Pressable onPress={sheet.open} accessibilityRole="button" style={s.open}><Text style={s.link}>首次使用：安装与连接指南</Text></Pressable>
    <Sheet visible={sheet.visible} title="连接你的电脑" onClose={() => sheet.close()} onClosed={sheet.onClosed}>
      <View style={s.body}>
        <Text style={s.title}>1. 在电脑上安装</Text>
        <Text style={s.text}>Mac 使用 cmux 时，在 cmux 的终端中进入 Panecast 项目目录，再执行：</Text>
        <Text selectable style={s.code}>./relay/scripts/install-launchd.sh</Text>
        <Pressable onPress={() => void copy('./relay/scripts/install-launchd.sh')}><Text style={s.link}>复制安装命令</Text></Pressable>
        <Text style={s.text}>需要 macOS、cmux 和 Swift 5.10 以上。使用 tmux 的 Mac 或 Linux 电脑，请按项目里的 tmux relay 指南安装。</Text>
        <Text style={s.title}>2. 配置远程连接</Text>
        <Text style={s.text}>按项目 broker/README.md 部署中转服务器，并把服务器地址、电脑标识和 relay 凭据填入电脑的配置。电脑与手机都能访问服务器后，就可以在外面连接。</Text>
        <Text style={s.text}>同一 Wi-Fi 下希望自动直连时，在电脑配置中增加局域网配对，再在同一网络下扫码。服务器和局域网的配对码分别配置。</Text>
        <Text style={s.title}>3. 扫码配对</Text>
        <Text selectable style={s.code}>cmux-relay pair</Text>
        <Pressable onPress={() => void copy('cmux-relay pair')}><Text style={s.link}>复制配对命令</Text></Pressable>
        <Text style={s.text}>电脑会提示输入服务器的配对码。扫描生成的二维码，也可以把配对链接粘贴到配对页。</Text>
        <Text style={s.title}>连接后检查</Text>
        <Text style={s.text}>在「设置 → 连接诊断」运行自检，并在「通知」中发送测试通知。电脑休眠时，远程终端可能无法使用。</Text>
        {message ? <Text style={s.link}>{message}</Text> : null}
      </View>
    </Sheet>
  </>;
}
const s = StyleSheet.create({ open: { paddingVertical: 8 }, body: { padding: 18, gap: 12 }, title: { color: colors.ink, fontSize: 16, fontWeight: '600' }, text: { color: colors.inkDim, fontSize: 14, lineHeight: 21 }, code: { color: colors.green, fontFamily: fonts.mono, fontSize: 13 }, link: { color: colors.blue, fontSize: 13 } });
