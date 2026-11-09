//! Opt-in release check using temporary accounts and read-only workspace RPC.
//! Credentials are supplied through the environment and never printed.
use crate::transport::{RequestOptions, SocketEvent, Transport};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;

static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
async fn api(
    transport: &Transport,
    base: &str,
    route: &str,
    method: &str,
    body: Option<Value>,
    token: Option<&str>,
    expected: u16,
) -> Result<Value, String> {
    let response = transport
        .request(
            format!("smoke-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
            format!("{base}/v1/account/{route}"),
            RequestOptions {
                method: Some(method.into()),
                authorization: token.map(|token| format!("Bearer {token}")),
                body: body.map(|body| body.to_string()),
            },
            None,
        )
        .await?;
    if response.status != expected {
        return Err(format!("{method} {route}: HTTP {}", response.status));
    }
    if expected == 204 {
        Ok(Value::Null)
    } else {
        serde_json::from_str(&response.body).map_err(|_| "Invalid account response".into())
    }
}

#[tokio::test]
#[ignore = "uses an explicitly configured production broker and deletes its temporary account"]
async fn production_account_and_terminal_smoke() {
    let base = std::env::var("PANECAST_SMOKE_BASE").expect("PANECAST_SMOKE_BASE is required");
    let relay = std::env::var("PANECAST_SMOKE_RELAY").expect("PANECAST_SMOKE_RELAY is required");
    let code = std::env::var("PANECAST_SMOKE_CODE").expect("PANECAST_SMOKE_CODE is required");
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).unwrap();
    let password = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let username = format!("tauri-check-{}", &password[..16]);
    let transport = Transport::new().unwrap();
    let account = api(
        &transport,
        &base,
        "register",
        "POST",
        Some(
            json!({"username":username,"password":password,"device_name":"Tauri release check A"}),
        ),
        None,
        201,
    )
    .await
    .expect("Temporary account registration failed");
    let token = account["token"].as_str().expect("Missing account token");
    let outcome: Result<(), String> = async {
        api(&transport, &base, "computers", "POST", Some(json!({"relay_id":relay,"pairing_code":code,"name":"Tauri release check"})), Some(token), 204).await?;
        let second = api(&transport, &base, "login", "POST", Some(json!({"username":username,"password":password,"device_name":"Tauri release check B"})), None, 200).await?;
        let second_token = second["token"].as_str().ok_or("Missing second token")?;
        let computers = api(&transport, &base, "computers", "GET", None, Some(second_token), 200).await?;
        let computer = computers["computers"].as_array().and_then(|items| items.iter().find(|item| item["relay_id"] == relay)).ok_or("Computer discovery failed")?;
        if computer["online"] != true { return Err("Target computer is offline".into()); }
        let mut url = url::Url::parse(&format!("{base}/v1/ws")).map_err(|_| "Invalid URL")?;
        url.set_scheme(if base.starts_with("https:") { "wss" } else { "ws" }).map_err(|_| "Invalid scheme")?;
        url.query_pairs_mut().append_pair("relay_id", &relay);
        let (send, mut events) = mpsc::unbounded_channel();
        transport.connect("live".into(), url.into(), vec!["cmuxremote.v1".into()], format!("Bearer {second_token}"), Arc::new(move |event| send.send(event).is_ok()))?;
        tokio::time::timeout(Duration::from_secs(20), async {
            let mut attempt = 0;
            while let Some(event) = events.recv().await {
                match event {
                    SocketEvent::Open { .. } => {
                        transport.send("live", json!({"deviceId":computer["device_id"],"appVersion":"0.2.0","protocolVersion":1}).to_string())?;
                        transport.send("live", json!({"id":"workspace-check","method":"workspace.list","params":{}}).to_string())?;
                    }
                    SocketEvent::Message { data, .. } => {
                        let frame: Value = serde_json::from_str(&data).map_err(|_| "Invalid terminal frame")?;
                        if frame["id"] != "workspace-check" { continue; }
                        if frame["ok"] == true { return Ok::<_, String>(()); }
                        if frame["error"]["code"] == "session_not_attached" && attempt < 10 {
                            attempt += 1;
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            transport.send("live", json!({"id":"workspace-check","method":"workspace.list","params":{}}).to_string())?;
                        } else { return Err("Workspace RPC failed".into()); }
                    }
                    SocketEvent::Close { code, .. } => return Err(format!("Terminal closed: {code}")),
                    _ => {},
                }
            }
            Err("Terminal stream ended".into())
        }).await.map_err(|_| "Workspace read timed out")??;
        api(&transport, &base, "logout", "POST", None, Some(second_token), 204).await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = events.recv().await {
                if let SocketEvent::Close { code, .. } = event { return if code == 4003 { Ok(()) } else { Err("Unexpected revocation code") }; }
            }
            Err("No session revocation")
        }).await.map_err(|_| "Session revocation timed out")??;
        api(&transport, &base, "me", "GET", None, Some(token), 200).await?;
        Ok(())
    }.await;
    transport.disconnect();
    let cleanup = api(
        &transport,
        &base,
        "me",
        "DELETE",
        Some(json!({"password":password})),
        Some(token),
        204,
    )
    .await;
    assert!(cleanup.is_ok(), "Failed to delete temporary account");
    assert!(outcome.is_ok(), "{}", outcome.unwrap_err());
}
