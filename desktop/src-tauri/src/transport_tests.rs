use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::handshake::server::{Request, Response as HandshakeResponse},
};

async fn headers(stream: &mut tokio::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0];
        stream.read_exact(&mut byte).await.unwrap();
        bytes.push(byte[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            return String::from_utf8(bytes).unwrap();
        }
    }
}

#[tokio::test]
async fn http_retains_authorization_rejects_redirects_and_cancels() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/account/me", listener.local_addr().unwrap());
    let (received, mut seen) = mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let request = headers(&mut first).await;
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer test-account"));
        first
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
            )
            .await
            .unwrap();
        let (mut redirect, _) = listener.accept().await.unwrap();
        headers(&mut redirect).await;
        redirect.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.com/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        let (mut hanging, _) = listener.accept().await.unwrap();
        headers(&mut hanging).await;
        received.send(()).unwrap();
        let mut byte = [0];
        let _ = hanging.read(&mut byte).await;
    });
    let transport = Transport::new().unwrap();
    let result = transport
        .request(
            "one".into(),
            url.clone(),
            RequestOptions {
                authorization: Some("Bearer test-account".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.status, 200);
    assert_eq!(result.body, "{\"ok\":true}");
    assert!(transport
        .request("two".into(), url.clone(), RequestOptions::default(), None)
        .await
        .unwrap_err()
        .contains("重定向"));
    let other = transport.clone();
    let pending = tokio::spawn(async move {
        other
            .request("three".into(), url, RequestOptions::default(), None)
            .await
    });
    seen.recv().await.unwrap();
    transport.abort_request("three");
    assert!(tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err()
        .contains("取消"));
    assert!(transport.0.requests.lock().unwrap().is_empty());
    server.await.unwrap();
}

#[tokio::test]
#[allow(clippy::result_large_err)] // tungstenite's handshake callback fixes this error type.
async fn websocket_authentication_hello_large_output_and_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "ws://{}/v1/ws?relay_id=test",
        listener.local_addr().unwrap()
    );
    let output = "终端\n".repeat(50_000);
    let expected = output.clone();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(
            stream,
            |request: &Request, mut response: HandshakeResponse| {
                assert_eq!(request.headers()["Authorization"], "Bearer test-device");
                assert_eq!(request.headers()["Sec-WebSocket-Protocol"], "cmuxremote.v1");
                response.headers_mut().insert(
                    "Sec-WebSocket-Protocol",
                    HeaderValue::from_static("cmuxremote.v1"),
                );
                Ok(response)
            },
        )
        .await
        .unwrap();
        let hello = tokio::time::timeout(Duration::from_millis(100), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(hello.into_text().unwrap(), "{\"protocolVersion\":1}");
        socket.send(Message::Text(output.into())).await.unwrap();
        socket
            .send(Message::Ping(b"ping".to_vec().into()))
            .await
            .unwrap();
        assert!(matches!(
            socket.next().await.unwrap().unwrap(),
            Message::Pong(_)
        ));
        socket
            .close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: "session revoked".into(),
            }))
            .await
            .unwrap();
    });
    let transport = Transport::new().unwrap();
    let (send, mut receive) = mpsc::unbounded_channel();
    transport
        .connect(
            "socket".into(),
            url,
            vec!["cmuxremote.v1".into()],
            "Bearer test-device".into(),
            Arc::new(move |event| send.send(event).is_ok()),
        )
        .unwrap();
    assert!(matches!(
        receive.recv().await.unwrap(),
        SocketEvent::Open { .. }
    ));
    transport
        .send("socket", "{\"protocolVersion\":1}".into())
        .unwrap();
    match receive.recv().await.unwrap() {
        SocketEvent::Message { data, .. } => assert_eq!(data, expected),
        event => panic!("unexpected {event:?}"),
    }
    assert!(matches!(
        receive.recv().await.unwrap(),
        SocketEvent::Error { .. }
    ));
    match receive.recv().await.unwrap() {
        SocketEvent::Close { code, reason, .. } => {
            assert_eq!(code, 1008);
            assert_eq!(reason, "session revoked");
        }
        event => panic!("unexpected {event:?}"),
    }
    assert!(transport.0.sockets.lock().unwrap().is_empty());
    server.await.unwrap();
}

#[tokio::test]
async fn closing_during_handshake_cancels_native_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/v1/ws", listener.local_addr().unwrap());
    let transport = Transport::new().unwrap();
    let (send, mut receive) = mpsc::unbounded_channel();
    transport
        .connect(
            "pending".into(),
            url,
            vec!["cmuxremote.v1".into()],
            "Bearer test-device".into(),
            Arc::new(move |event| send.send(event).is_ok()),
        )
        .unwrap();
    let (mut peer, _) = listener.accept().await.unwrap();
    headers(&mut peer).await;
    transport.close("pending");
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), receive.recv())
            .await
            .unwrap()
            .unwrap(),
        SocketEvent::Close { code: 1000, .. }
    ));
    assert!(transport.0.sockets.lock().unwrap().is_empty());
}
