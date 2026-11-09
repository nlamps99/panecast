use crate::security::{bearer, service_url};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        http::HeaderValue,
        protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
        Message,
    },
};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;

const MAX_MESSAGE: usize = 32 * 1024 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub struct Transport(Arc<Inner>);
struct Inner {
    client: reqwest::Client,
    requests: Mutex<HashMap<String, CancellationToken>>,
    sockets: Mutex<HashMap<String, SocketHandle>>,
}
struct SocketHandle {
    cancel: CancellationToken,
    sender: mpsc::Sender<String>,
}

#[derive(Default, Deserialize)]
pub struct RequestOptions {
    pub method: Option<String>,
    pub authorization: Option<String>,
    pub body: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SocketEvent {
    Open {
        id: String,
    },
    Message {
        id: String,
        data: String,
    },
    Error {
        id: String,
    },
    Close {
        id: String,
        code: u16,
        reason: String,
    },
}
pub type SocketSink = Arc<dyn Fn(SocketEvent) -> bool + Send + Sync>;

impl Transport {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "无法初始化网络连接")?;
        Ok(Self(Arc::new(Inner {
            client,
            requests: Mutex::default(),
            sockets: Mutex::default(),
        })))
    }

    pub async fn request(
        &self,
        id: String,
        raw: String,
        options: RequestOptions,
        on_started: Option<tauri::ipc::Channel<()>>,
    ) -> Result<Response, String> {
        let url = service_url(&raw, false)?;
        let method = options.method.as_deref().unwrap_or("GET");
        if !matches!(method, "GET" | "POST" | "PATCH" | "DELETE")
            || id.is_empty()
            || id.len() > 128
            || options.body.as_ref().is_some_and(|s| s.len() > 64 * 1024)
            || options.authorization.as_ref().is_some_and(|s| !bearer(s))
        {
            return Err("无效的请求".into());
        }
        let cancel = CancellationToken::new();
        {
            let mut requests = self.0.requests.lock().unwrap();
            if requests.len() >= 32 || requests.contains_key(&id) {
                return Err("请求过多".into());
            }
            requests.insert(id.clone(), cancel.clone());
        }
        if let Some(started) = on_started {
            if started.send(()).is_err() {
                cancel.cancel();
            }
        }
        let operation = async {
            let mut request = self
                .0
                .client
                .request(method.parse().unwrap(), url)
                .header("Content-Type", "application/json");
            if let Some(token) = options.authorization {
                request = request.header("Authorization", token);
            }
            if let Some(body) = options.body {
                request = request.body(body);
            }
            let response = request
                .send()
                .await
                .map_err(|_| "无法连接服务器，请检查地址和网络。")?;
            // Never follow redirects with account or pairing credentials.
            if response.status().is_redirection() {
                return Err("服务器返回了重定向，请检查地址。".into());
            }
            let status = response.status().as_u16();
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| "无法读取服务器响应")?;
                if bytes.len() + chunk.len() > MAX_RESPONSE {
                    return Err("服务器响应过大".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(Response {
                status,
                body: String::from_utf8_lossy(&bytes).into_owned(),
            })
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("请求已取消".into()),
            result = operation => result,
        };
        self.0.requests.lock().unwrap().remove(&id);
        result
    }

    pub fn abort_request(&self, id: &str) {
        if let Some(cancel) = self.0.requests.lock().unwrap().get(id) {
            cancel.cancel();
        }
    }

    pub fn connect(
        &self,
        id: String,
        raw: String,
        protocols: Vec<String>,
        authorization: String,
        sink: SocketSink,
    ) -> Result<(), String> {
        let url = service_url(&raw, true)?;
        if id.is_empty()
            || id.len() > 128
            || protocols != ["cmuxremote.v1"]
            || !bearer(&authorization)
        {
            return Err("无效的连接".into());
        }
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| "无效的连接地址")?;
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&authorization).map_err(|_| "无效的凭据")?,
        );
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static("cmuxremote.v1"),
        );
        let cancel = CancellationToken::new();
        let (sender, mut receiver) = mpsc::channel::<String>(64);
        {
            let mut sockets = self.0.sockets.lock().unwrap();
            if sockets.len() >= 8 || sockets.contains_key(&id) {
                return Err("连接过多".into());
            }
            sockets.insert(
                id.clone(),
                SocketHandle {
                    cancel: cancel.clone(),
                    sender,
                },
            );
        }
        let transport = self.clone();
        tauri::async_runtime::spawn(async move {
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_MESSAGE))
                .max_frame_size(Some(MAX_MESSAGE));
            let connection = tokio::select! {
                biased;
                _ = cancel.cancelled() => None,
                result = tokio::time::timeout(Duration::from_secs(15), connect_async_with_config(request, Some(config), true)) => Some(result),
            };
            let (code, reason) = match connection {
                None => (1000, "client stopped".into()),
                Some(Ok(Ok((mut socket, response)))) => {
                    if response
                        .headers()
                        .get("Sec-WebSocket-Protocol")
                        .and_then(|h| h.to_str().ok())
                        != Some("cmuxremote.v1")
                    {
                        (1002, "服务器未接受终端协议".into())
                    } else if !sink(SocketEvent::Open { id: id.clone() }) {
                        (1000, "window closed".into())
                    } else {
                        loop {
                            tokio::select! {
                                biased;
                                _ = cancel.cancelled() => {
                                    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(Some(CloseFrame { code: CloseCode::Normal, reason: "client stopped".into() }))).await;
                                    break (1000, "client stopped".into());
                                }
                                outgoing = receiver.recv() => {
                                    match outgoing {
                                        Some(data) => {
                                            let sent = tokio::select! {
                                                _ = cancel.cancelled() => false,
                                                result = tokio::time::timeout(Duration::from_secs(15), socket.send(Message::Text(data.into()))) => matches!(result, Ok(Ok(()))),
                                            };
                                            if !sent { break (1006, "连接已断开".into()); }
                                        }
                                        None => break (1000, "client stopped".into()),
                                    }
                                }
                                message = socket.next() => {
                                    match message {
                                        Some(Ok(Message::Text(data))) => {
                                            if !sink(SocketEvent::Message { id: id.clone(), data: data.to_string() }) { break (1000, "window closed".into()); }
                                        }
                                        Some(Ok(Message::Close(frame))) => break frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1000, String::new())),
                                        Some(Ok(Message::Ping(_))) => {
                                            // tungstenite queues the matching pong when reading a ping.
                                            if !matches!(tokio::time::timeout(Duration::from_secs(5), socket.flush()).await, Ok(Ok(()))) { break (1006, "连接已断开".into()); }
                                        }
                                        Some(Ok(_)) => {},
                                        Some(Err(_)) | None => break (1006, "连接已断开".into()),
                                    }
                                }
                            }
                        }
                    }
                }
                Some(Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response)))) => {
                    (1006, format!("HTTP {}", response.status().as_u16()))
                }
                _ => (1006, "无法连接服务器，请检查地址和网络。".into()),
            };
            transport.0.sockets.lock().unwrap().remove(&id);
            if code != 1000 {
                sink(SocketEvent::Error { id: id.clone() });
            }
            sink(SocketEvent::Close { id, code, reason });
        });
        Ok(())
    }

    pub fn send(&self, id: &str, data: String) -> Result<(), String> {
        if data.len() > MAX_MESSAGE {
            return Err("发送内容过大".into());
        }
        let sockets = self.0.sockets.lock().unwrap();
        let socket = sockets.get(id).ok_or("连接已断开")?;
        socket
            .sender
            .try_send(data)
            .map_err(|_| "发送队列已满或连接已断开".into())
    }

    pub fn close(&self, id: &str) {
        if let Some(socket) = self.0.sockets.lock().unwrap().get(id) {
            socket.cancel.cancel();
        }
    }

    pub fn disconnect(&self) {
        for socket in self.0.sockets.lock().unwrap().values() {
            socket.cancel.cancel();
        }
        for request in self.0.requests.lock().unwrap().values() {
            request.cancel();
        }
    }
}
