use url::{Host, Url};

pub fn service_url(raw: &str, socket: bool) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "无效的服务器地址")?;
    let private = match url.host() {
        Some(Host::Domain(host)) => host == "localhost" || host.ends_with(".local"),
        Some(Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    let (secure, plain) = if socket {
        ("wss", "ws")
    } else {
        ("https", "http")
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == secure || (url.scheme() == plain && private))
    {
        return Err("无效的服务器地址".into());
    }
    let endpoints: &[&str] = if socket {
        &["/v1/ws"]
    } else {
        &[
            "/v1/health",
            "/v1/devices/me",
            "/v1/devices/me/register",
            "/v1/devices/me/apns",
            "/v1/devices/me/apns/test",
            "/v1/account/register",
            "/v1/account/login",
            "/v1/account/me",
            "/v1/account/logout",
            "/v1/account/password",
            "/v1/account/computers",
        ]
    };
    if !endpoints
        .iter()
        .any(|endpoint| url.path().ends_with(endpoint))
    {
        return Err("无效的服务接口".into());
    }
    Ok(url)
}

pub fn bearer(value: &str) -> bool {
    value.strip_prefix("Bearer ").is_some_and(|token| {
        !token.is_empty()
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b))
    })
}

pub fn storage_key(key: &str) -> Result<(), String> {
    match key {
        "panecast.computers.v2"
        | "panecast.pairing.v1"
        | "panecast.clientId"
        | "panecast.account.v1" => Ok(()),
        _ => Err("无效的存储项".into()),
    }
}

pub fn app_url(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_scope_preserves_broker_prefixes_and_lan() {
        assert!(service_url("https://example.com/cmux-remote/v1/account/login", false).is_ok());
        assert!(service_url("ws://192.168.1.2:4399/v1/ws?relay_id=mac", true).is_ok());
        for raw in [
            "file:///etc/passwd",
            "https://user:password@example.com/v1/health",
            "http://example.com/v1/account/login",
            "https://example.com/arbitrary",
            "https://example.com/v1/relay/ws",
        ] {
            assert!(service_url(raw, false).is_err(), "{raw}");
        }
        assert!(!bearer("Bearer secret\r\nX-Injected: yes"));
        assert!(bearer("Bearer a.b_c~-d"));
        assert!(storage_key("../../config").is_err());
        assert!(!app_url(&Url::parse("https://localhost/").unwrap()));
    }
}
