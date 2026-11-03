//! The one HTTP client the connectors reach the network with, and the guard
//! it goes through.
//!
//! A connector's URL comes from the registry or the user, and the metadata it
//! points to comes from the server, so none of it is trusted: discovery could
//! be steered at the machine's own services (a router page, a dev server, a
//! cloud metadata endpoint) and leak what they answer into an error or a
//! label. So every URL must be HTTPS, and every host must resolve to a public
//! address. The address check sits in the resolver, not only before the
//! request, so a name that resolves to a public address when checked and to
//! a private one when connected (DNS rebinding) is still refused.
//!
//! Redirects are never followed for us: a token, a code or a refresh token
//! must not ride a redirect to another host. Metadata GETs follow a few
//! same-origin ones by hand (`get_json`).
//!
//! Tests and e2e run against a fake server on `http://127.0.0.1`, which the
//! guard refuses; `CREW_CONNECTORS_INSECURE=1`, read once when the daemon
//! starts, lets it through.

use std::error::Error as _;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{ACCEPT, LOCATION};
use reqwest::{Client, Method, RequestBuilder, Response};
use serde_json::Value;
use url::{Host, Url};

/// How long an OAuth or metadata request may take, start to end. MCP calls
/// set their own (`RequestBuilder::timeout` replaces this one).
pub const OAUTH_TIMEOUT: Duration = Duration::from_secs(30);

/// Same-origin redirects a metadata GET follows.
const MAX_REDIRECTS: usize = 3;

/// The most a metadata or OAuth answer may hold; real ones are a few KB.
pub const SMALL_BODY: usize = 1 << 20;

static INSECURE: LazyLock<AtomicBool> =
    LazyLock::new(|| AtomicBool::new(std::env::var("CREW_CONNECTORS_INSECURE").as_deref() == Ok("1")));

static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .user_agent(concat!("Crew/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        // A proxy would resolve the host itself, past the guard.
        .no_proxy()
        .dns_resolver(Arc::new(GuardedResolver))
        .build()
        .expect("the connectors' HTTP client")
});

/// Whether `http://` and local addresses are allowed (tests and e2e only).
pub fn insecure() -> bool {
    INSECURE.load(Ordering::Relaxed)
}

/// Lets the fake server's `http://127.0.0.1` through, for this process.
#[cfg(any(test, feature = "fakes"))]
pub fn allow_insecure_for_tests() {
    INSECURE.store(true, Ordering::Relaxed);
}

/// The shared client. It follows no redirect; send only to a URL that went
/// through `check_url`, which `request` does.
pub fn client() -> &'static Client {
    &CLIENT
}

/// A request to a checked URL, with the OAuth timeout.
pub fn request(method: Method, url: &str) -> Result<RequestBuilder, String> {
    let url = check_url(url)?;
    Ok(CLIENT.request(method, url).timeout(OAUTH_TIMEOUT))
}

/// Refuses a URL the connectors must not fetch: not HTTPS, with credentials
/// in it, or naming a private or local address. Called before anything is
/// fetched; names are checked again when they resolve.
pub fn check_url(url: &str) -> Result<Url, String> {
    check(url, insecure())
}

fn check(url: &str, insecure: bool) -> Result<Url, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| format!("Not a URL: {}", shorten(url, 80)))?;
    match parsed.scheme() {
        "https" => {}
        "http" if insecure => {}
        _ => return Err("Only https:// addresses can be connected".to_string()),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("An address with a user name or password in it is not allowed".to_string());
    }
    let blocked = match parsed.host() {
        None => return Err("The address has no host".to_string()),
        Some(Host::Ipv4(ip)) => is_blocked(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => is_blocked(IpAddr::V6(ip)),
        Some(Host::Domain(_)) => false,
    };
    if blocked && !insecure {
        return Err("The address is a private or local one".to_string());
    }
    Ok(parsed)
}

/// Addresses no connector may reach: this machine, the local network,
/// Tailscale's range (CGNAT), and the special ranges, in any IPv6 form.
pub fn is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => blocked_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = embedded_v4(v6) {
                return blocked_v4(v4);
            }
            let first = v6.segments()[0];
            v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || first & 0xfe00 == 0xfc00 // unique local, fc00::/7
                || first & 0xffc0 == 0xfe80 // link local, fe80::/10
        }
    }
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || a == 0 // "this network"
        || (a == 100 && b & 0xc0 == 64) // CGNAT, 100.64.0.0/10
        || a >= 240 // reserved
}

/// The IPv4 address an IPv6 one carries: mapped (`::ffff:a.b.c.d`),
/// compatible (`::a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`).
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return Some(v4);
    }
    let s = ip.segments();
    let tail = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    let compatible = s[..6].iter().all(|&x| x == 0) && !ip.is_loopback() && !ip.is_unspecified();
    let nat64 = s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|&x| x == 0);
    (compatible || nat64).then_some(tail)
}

/// The resolved addresses a connection may use.
fn allowed(addrs: impl IntoIterator<Item = SocketAddr>, insecure: bool) -> Vec<SocketAddr> {
    addrs.into_iter().filter(|a| insecure || !is_blocked(a.ip())).collect()
}

struct GuardedResolver;

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let host = name.as_str().to_string();
            let found = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let kept = allowed(found, insecure());
            if kept.is_empty() {
                return Err(format!("{host} resolves to a private or local address").into());
            }
            Ok(Box::new(kept.into_iter()) as Addrs)
        })
    }
}

/// A JSON object at `url`, following up to three same-origin redirects.
/// `None` when there is none there (any status but 2xx, or not a JSON
/// object), so discovery moves on to its next guess; `Err` when the network
/// failed.
pub async fn get_json(url: &str) -> Result<Option<Value>, String> {
    let mut url = check_url(url)?;
    for _ in 0..=MAX_REDIRECTS {
        let res = CLIENT
            .get(url.clone())
            .header(ACCEPT, "application/json")
            .timeout(OAUTH_TIMEOUT)
            .send()
            .await
            .map_err(describe)?;
        if res.status().is_redirection() {
            let next = res.headers().get(LOCATION).and_then(|v| v.to_str().ok()).and_then(|l| url.join(l).ok());
            match next {
                Some(next) if next.origin() == url.origin() => {
                    url = check_url(next.as_str())?;
                    continue;
                }
                _ => return Ok(None),
            }
        }
        if !res.status().is_success() {
            return Ok(None);
        }
        let Ok(body) = read_body(res, SMALL_BODY).await else { return Ok(None) };
        return Ok(serde_json::from_slice::<Value>(&body).ok().filter(Value::is_object));
    }
    Ok(None)
}

/// A response's body, refused past `cap` bytes.
pub async fn read_body(mut res: Response, cap: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(describe)? {
        if body.len() + chunk.len() > cap {
            return Err("The answer is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// A request error as one line, without its URL (a server URL can carry a
/// key in its query) and with the causes reqwest keeps underneath.
pub fn describe(err: reqwest::Error) -> String {
    if err.is_timeout() {
        return "The server took too long to answer".to_string();
    }
    let err = err.without_url();
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let line = cause.to_string();
        if !text.contains(&line) {
            text.push_str(": ");
            text.push_str(&line);
        }
        source = cause.source();
    }
    text
}

/// At most `max` characters of `text`, for messages that quote a server.
pub fn shorten(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(url: &str) -> bool {
        check(url, false).is_err()
    }

    #[test]
    fn only_https_is_fetched_unless_insecure() {
        assert!(check("https://mcp.notion.com/mcp", false).is_ok());
        assert!(refused("http://mcp.notion.com/mcp"));
        assert!(refused("ftp://mcp.notion.com/"));
        assert!(refused("file:///etc/passwd"));
        assert!(check("http://127.0.0.1:4000/mcp", true).is_ok());
        assert!(check("ftp://127.0.0.1/", true).is_err(), "insecure allows http, not any scheme");
    }

    #[test]
    fn private_and_local_address_literals_are_refused() {
        for url in [
            "https://127.0.0.1/",
            "https://10.1.2.3/",
            "https://172.16.0.1/",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest/meta-data",
            "https://100.100.1.1/",
            "https://0.0.0.0/",
            "https://[::1]/",
            "https://[::]/",
            "https://[fd00::1]/",
            "https://[fe80::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[::ffff:10.0.0.1]/",
            "https://[64:ff9b::a9fe:a9fe]/",
            "https://[ff02::1]/",
        ] {
            assert!(refused(url), "{url} should be refused");
        }
        assert!(!refused("https://1.1.1.1/"));
        assert!(!refused("https://[2606:4700:4700::1111]/"));
        assert!(!refused("https://100.128.0.1/"), "just past CGNAT is public");
    }

    #[test]
    fn a_url_with_credentials_is_refused() {
        assert!(refused("https://user:pass@mcp.notion.com/"));
    }

    #[test]
    fn the_resolver_drops_private_answers_so_rebinding_finds_nothing() {
        let public: SocketAddr = "93.184.216.34:0".parse().unwrap();
        let local: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let mapped: SocketAddr = "[::ffff:192.168.0.1]:0".parse().unwrap();
        assert_eq!(allowed([public, local, mapped], false), [public]);
        assert!(allowed([local, mapped], false).is_empty());
        assert_eq!(allowed([local], true), [local]);
    }

    #[test]
    fn a_long_server_message_is_shortened() {
        assert_eq!(shorten("  abcdef ", 3), "abc…");
        assert_eq!(shorten("abc", 3), "abc");
    }
}
