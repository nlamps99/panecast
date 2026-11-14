document.getElementById('confirm').addEventListener('click', async () => {
  const choice = await window.__TAURI__.core.invoke('dialog', { options: {
    title: '关闭测试终端？', message: 'Only a test marker is changed.', buttons: ['取消', '关闭'], cancelId: 0,
  } });
  document.getElementById('result').textContent = choice === 1 ? 'confirmed' : 'cancelled';
});
