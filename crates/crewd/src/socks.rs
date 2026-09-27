//! A SOCKS5 proxy bound next to `crewd serve`, so a browser on the Mac can open
//! `localhost` on this machine. The password is the daemon token. Anything that
//! is not this machine's loopback is refused: the proxy is for the dev server
//! running here, not an exit onto the rest of the network.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const USERNAME_PASSWORD: u8 = 0x02;
const CONNECT: u8 = 0x01;
const ATYP_V4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_V6: u8 = 0x04;

pub async fn run(listener: TcpListener, token: String) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            break;
        };
        let token = token.clone();
        tokio::spawn(async move {
            let _ = handle(stream, &token).await;
        });
    }
}

async fn handle(mut client: TcpStream, token: &str) -> std::io::Result<()> {
    let mut header = [0u8; 2];
    client.read_exact(&mut header).await?;
    if header[0] != 5 {
        return Ok(());
    }
    let mut methods = vec![0u8; header[1] as usize];
    client.read_exact(&mut methods).await?;
    if !methods.contains(&USERNAME_PASSWORD) {
        client.write_all(&[5, 0xff]).await?;
        return Ok(());
    }
    client.write_all(&[5, USERNAME_PASSWORD]).await?;
    if !authenticate(&mut client, token).await? {
        return Ok(());
    }

    let dest = match read_request(&mut client).await? {
        Some(dest) => dest,
        None => return Ok(()),
    };
    let mut upstream = match TcpStream::connect(dest).await {
        Ok(stream) => stream,
        Err(_) => {
            let _ = reply(&mut client, 0x05).await;
            return Ok(());
        }
    };
    reply(&mut client, 0x00).await?;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

async fn authenticate(client: &mut TcpStream, token: &str) -> std::io::Result<bool> {
    let version = read_u8(client).await?;
    if version != 1 {
        return Ok(false);
    }
    let user = read_lp(client).await?;
    let pass = read_lp(client).await?;
    let user = String::from_utf8_lossy(&user);
    let pass = String::from_utf8_lossy(&pass);
    // The window sends the token as both the user and the password.
    let ok = user == token || pass == token;
    client.write_all(&[1, if ok { 0 } else { 1 }]).await?;
    Ok(ok)
}

async fn read_request(client: &mut TcpStream) -> std::io::Result<Option<SocketAddr>> {
    let mut head = [0u8; 4];
    client.read_exact(&mut head).await?;
    if head[0] != 5 || head[1] != CONNECT {
        reply(client, 0x07).await?;
        return Ok(None);
    }
    let dest = match decode_addr(client, head[3]).await? {
        Some(dest) if loopback(&dest) => dest,
        Some(_) => {
            reply(client, 0x02).await?;
            return Ok(None);
        }
        None => {
            reply(client, 0x08).await?;
            return Ok(None);
        }
    };
    Ok(Some(dest))
}

fn loopback(addr: &SocketAddr) -> bool {
    match addr.ip() {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => ip.is_loopback(),
    }
}

async fn decode_addr(client: &mut TcpStream, atyp: u8) -> std::io::Result<Option<SocketAddr>> {
    let ip = match atyp {
        ATYP_V4 => {
            let mut buf = [0u8; 4];
            client.read_exact(&mut buf).await?;
            IpAddr::V4(Ipv4Addr::from(buf))
        }
        ATYP_V6 => {
            let mut buf = [0u8; 16];
            client.read_exact(&mut buf).await?;
            IpAddr::V6(buf.into())
        }
        ATYP_DOMAIN => {
            let name = String::from_utf8_lossy(&read_lp(client).await?).into_owned();
            let port = read_port(client).await?;
            if name != "localhost" {
                return Ok(None);
            }
            return Ok(Some(SocketAddr::from((Ipv4Addr::LOCALHOST, port))));
        }
        _ => return Ok(None),
    };
    let port = read_port(client).await?;
    Ok(Some(SocketAddr::from((ip, port))))
}

async fn read_port(client: &mut TcpStream) -> std::io::Result<u16> {
    let mut buf = [0u8; 2];
    client.read_exact(&mut buf).await?;
    Ok(u16::from_be_bytes(buf))
}

async fn read_lp(client: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let len = read_u8(client).await? as usize;
    let mut buf = vec![0u8; len];
    client.read_exact(&mut buf).await?;
    Ok(buf)
}

async fn read_u8(client: &mut TcpStream) -> std::io::Result<u8> {
    let mut buf = [0u8; 1];
    client.read_exact(&mut buf).await?;
    Ok(buf[0])
}

async fn reply(client: &mut TcpStream, status: u8) -> std::io::Result<()> {
    client.write_all(&[5, status, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn socks() -> (SocketAddr, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(run(listener, "secret".into()));
        (addr, "secret".into())
    }

    async fn greet(stream: &mut TcpStream, user: &str, pass: &str) {
        stream.write_all(&[5, 1, USERNAME_PASSWORD]).await.unwrap();
        let mut chosen = [0u8; 2];
        stream.read_exact(&mut chosen).await.unwrap();
        assert_eq!(chosen, [5, USERNAME_PASSWORD]);
        let user = user.as_bytes();
        let pass = pass.as_bytes();
        let mut auth = vec![1, user.len() as u8];
        auth.extend_from_slice(user);
        auth.push(pass.len() as u8);
        auth.extend_from_slice(pass);
        stream.write_all(&auth).await.unwrap();
        let mut status = [0u8; 2];
        stream.read_exact(&mut status).await.unwrap();
        assert_eq!(status[1], 0, "auth refused");
    }

    #[tokio::test]
    async fn localhost_is_proxied_and_the_token_is_required() {
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = echo.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = echo.accept().await.unwrap();
            let mut buf = [0u8; 4];
            stream.read_exact(&mut buf).await.unwrap();
            stream.write_all(b"pong").await.unwrap();
        });

        let (addr, _) = socks().await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        greet(&mut client, "secret", "secret").await;
        let port = echo_addr.port().to_be_bytes();
        client
            .write_all(&[5, CONNECT, 0, ATYP_V4, 127, 0, 0, 1, port[0], port[1]])
            .await
            .unwrap();
        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 0, "connect refused");
        client.write_all(b"ping").await.unwrap();
        let mut body = [0u8; 4];
        client.read_exact(&mut body).await.unwrap();
        assert_eq!(&body, b"pong");

        let mut rejected = TcpStream::connect(addr).await.unwrap();
        rejected.write_all(&[5, 1, USERNAME_PASSWORD]).await.unwrap();
        let mut chosen = [0u8; 2];
        rejected.read_exact(&mut chosen).await.unwrap();
        rejected.write_all(&[1, 3, b'n', b'o', b'p', 1, b'e']).await.unwrap();
        let mut status = [0u8; 2];
        rejected.read_exact(&mut status).await.unwrap();
        assert_eq!(status[1], 1);
    }

    #[tokio::test]
    async fn a_connect_off_loopback_is_refused() {
        let (addr, _) = socks().await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        greet(&mut client, "secret", "secret").await;
        client.write_all(&[5, CONNECT, 0, ATYP_V4, 1, 2, 3, 4, 0, 80]).await.unwrap();
        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 0x02);
    }
}
