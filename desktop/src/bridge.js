// Runs before the shared Expo bundle. Native operations stay behind the same
// narrow interface used by the mobile client's desktop adapter.
(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const listeners = new Set();
  const sockets = new Map();
  const requests = new Map();
  const emit = event => { for (const listener of listeners) listener(event); };
  const close = id => invoke('socket_close', { id });
  window.panecastDesktop = Object.freeze({
    version: 1,
    getSecret: key => invoke('secret_get', { key }),
    setSecret: (key, value) => invoke('secret_set', { key, value }),
    deleteSecret: key => invoke('secret_delete', { key }),
    request: (id, url, options) => {
      const state = { started: false, cancelled: false };
      const onStarted = new Channel();
      requests.set(id, state);
      onStarted.onmessage = () => {
        state.started = true;
        if (state.cancelled) void invoke('abort_request', { id }).catch(() => {});
      };
      return invoke('request', { id, url, options, onStarted }).finally(() => requests.delete(id));
    },
    abortRequest: id => {
      const state = requests.get(id);
      if (!state) return;
      state.cancelled = true;
      if (state.started) void invoke('abort_request', { id }).catch(() => {});
    },
    connectSocket: (id, url, protocols, headers) => {
      const onEvent = new Channel();
      const socket = { onEvent, pending: Promise.resolve() };
      sockets.set(id, socket);
      onEvent.onmessage = event => {
        if (event.type === 'close') sockets.delete(id);
        emit(event);
      };
      return invoke('socket_connect', { id, url, protocols, headers, onEvent }).catch(error => {
        sockets.delete(id); throw new Error(String(error));
      });
    },
    sendSocket: (id, data) => {
      const socket = sockets.get(id);
      if (!socket) throw new Error('连接已断开');
      // Preserve send order across asynchronous IPC, including hello and RPCs.
      socket.pending = socket.pending.then(() => {
        if (sockets.get(id) === socket) return invoke('socket_send', { id, data });
      }).catch(() => {
        if (sockets.get(id) !== socket) return;
        sockets.delete(id);
        emit({ id, type: 'error' });
        emit({ id, type: 'close', code: 1006, reason: '发送失败，连接已断开' });
        void close(id).catch(() => {});
      });
    },
    closeSocket: id => { void close(id).catch(() => {}); },
    onSocket: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    dialog: options => invoke('dialog', { options }),
    writeClipboard: text => invoke('clipboard_write', { text }),
    notify: options => invoke('desktop_notify', { options }),
    openNotificationSettings: () => invoke('notification_settings'),
    localGateway: () => invoke('local_gateway'),
    // Held while computers are paired, so App Nap cannot stall a hidden window.
    keepAwake: active => invoke('keep_awake', { active: active === true }),
    updateStatus: () => invoke('update_status'),
    checkForUpdate: () => invoke('update_check'),
    restartToUpdate: () => invoke('update_restart'),
    onUpdate: listener => {
      let disposed = false, unsubscribe;
      void window.__TAURI__.event.listen('panecast-update', event => {
        if (!disposed) listener(event.payload);
      }).then(stop => { if (disposed) stop(); else unsubscribe = stop; }).catch(() => {});
      return () => { disposed = true; unsubscribe?.(); };
    },
    openSharedFile: (url, name) => invoke('open_shared_file', { url, name }),
    onNotification: listener => {
      let disposed = false, unsubscribe;
      void window.__TAURI__.event.listen('panecast-notification', event => {
        if (!disposed) listener(event.payload);
      }).then(stop => { if (disposed) stop(); else unsubscribe = stop; }).catch(() => {});
      return () => { disposed = true; unsubscribe?.(); };
    },
    // The Mac menu bar's own items arrive by id; the page runs them as its shortcuts.
    onMenu: listener => {
      let disposed = false, unsubscribe;
      void window.__TAURI__.event.listen('panecast-menu', event => {
        if (!disposed && typeof event.payload === 'string') listener(event.payload);
      }).then(stop => { if (disposed) stop(); else unsubscribe = stop; }).catch(() => {});
      return () => { disposed = true; unsubscribe?.(); };
    },
    closeWindow: () => { void window.__TAURI__.event.emit('panecast-close-window').catch(() => {}); },
  });
})();
