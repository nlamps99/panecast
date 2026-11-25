import * as Clipboard from '../platform/clipboard';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Sheet, useSheet } from './Sheet';
import { colors, fonts } from './theme';

export const DOWNLOAD_PAGE = 'https://ningzx.cn/panecast/';

/** The same three steps as the download page: install, `panecast setup` + `start`, then sign in or scan. */
export function ConnectionGuide() {
  const sheet = useSheet();
  const [message, setMessage] = useState('');
  const copy = async (text: string, what: string) => {
    try { setMessage(await Clipboard.setStringAsync(text) ? `${what}已复制` : '复制失败，可以长按文字复制'); }
    catch { setMessage('复制失败，可以长按文字复制'); }
  };
  return <>
    <Pressable onPress={sheet.open} accessibilityRole="button" style={s.open} hitSlop={{ top: 4, bottom: 4 }}><Text style={s.link}>第一次用？看看怎么连接电脑</Text></Pressable>
    <Sheet visible={sheet.visible} title="连接你的电脑" onClose={() => sheet.close()} onClosed={sheet.onClosed}>
      <View style={s.body}>
        <Text style={s.title}>1. 在电脑上安装 Panecast</Text>
        <Text style={s.text}>在电脑浏览器打开下载页，按页面上的命令安装：</Text>
        <Text selectable style={s.code}>{DOWNLOAD_PAGE}</Text>
        <Copy label="复制网址" onPress={() => void copy(DOWNLOAD_PAGE, '网址')} />
        <Text style={s.title}>2. 登录并启动</Text>
        <Text style={s.text}>在电脑的终端里依次运行，按提示登录或注册账号：</Text>
        <Text selectable style={s.code}>panecast setup{'\n'}panecast start</Text>
        <Copy label="复制命令" onPress={() => void copy('panecast setup && panecast start', '命令')} />
        <Text style={s.title}>3. 手机连上电脑</Text>
        <Text style={s.text}>在手机上登录同一个账号（配对页的「账号登录与电脑管理」或「设置 → 账号」），电脑会自动出现。不想登录账号的话，在电脑上运行下面的命令，再在配对页扫它显示的二维码：</Text>
        <Text selectable style={s.code}>panecast pair</Text>
        <Copy label="复制命令" onPress={() => void copy('panecast pair', '命令')} />
        <Text style={s.text}>电脑关机或休眠时，手机连不上它。连不上时，可以在「设置 → 连接诊断」里检查。</Text>
        {message ? <Text style={s.link} accessibilityLiveRegion="polite">{message}</Text> : null}
      </View>
    </Sheet>
  </>;
}

function Copy({ label, onPress }: { label: string; onPress(): void }) {
  return <Pressable onPress={onPress} accessibilityRole="button" style={s.copy} hitSlop={{ top: 6, bottom: 6 }}><Text style={s.link}>{label}</Text></Pressable>;
}

const s = StyleSheet.create({
  open: { paddingVertical: 10, alignSelf: 'flex-start' },
  body: { padding: 18, gap: 12 },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  text: { color: colors.inkDim, fontSize: 14, lineHeight: 21 },
  code: { color: colors.green, fontFamily: fonts.mono, fontSize: 13, lineHeight: 20 },
  copy: { alignSelf: 'flex-start', paddingVertical: 8 },
  link: { color: colors.blue, fontSize: 14 },
});
