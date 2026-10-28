//! Sealing what a vault move carries, end to end (plan
//! `2026-10-23-integrations.md`, "Moving the vault").
//!
//! The new vault makes a key pair for one move and hands the window its
//! public half; the old vault seals the grants to it and the new one opens
//! them. Whoever carries the box between them (the window, the network) sees
//! only ciphertext: X25519 between an ephemeral key of the sender and the
//! receiver's, HKDF-SHA256 over the shared secret and both public keys, and
//! ChaCha20-Poly1305 with that key. Each key pair seals once, so the nonce
//! can be fixed.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const INFO: &[u8] = b"crew vault move v1";

/// The receiving vault's key pair for one move. Its secret never leaves the
/// daemon that made it.
pub struct Opener {
    secret: StaticSecret,
}

impl Opener {
    pub fn new() -> Self {
        Opener { secret: StaticSecret::from(rand::random::<[u8; 32]>()) }
    }

    /// The public half, base64url, for the window to carry to the old vault.
    pub fn public(&self) -> String {
        URL_SAFE_NO_PAD.encode(PublicKey::from(&self.secret).as_bytes())
    }

    /// Opens what was sealed to this key.
    pub fn open(&self, sealed: &str) -> Result<Vec<u8>, String> {
        let bytes = URL_SAFE_NO_PAD.decode(sealed).map_err(|_| "The sealed grants are not base64".to_string())?;
        if bytes.len() < 32 + 16 {
            return Err("The sealed grants are cut short".into());
        }
        let (theirs, ciphertext) = bytes.split_at(32);
        let theirs = PublicKey::from(<[u8; 32]>::try_from(theirs).map_err(|_| "A bad key".to_string())?);
        let ours = PublicKey::from(&self.secret);
        let cipher = cipher(&self.secret.diffie_hellman(&theirs).to_bytes(), &theirs, &ours);
        cipher.decrypt(Nonce::from_slice(&[0; 12]), ciphertext).map_err(|_| "The sealed grants don't open with this key".into())
    }
}

impl Default for Opener {
    fn default() -> Self {
        Self::new()
    }
}

/// Seals `plain` to the receiver's public key (base64url): an ephemeral key
/// of its own, then the ciphertext.
pub fn seal(to: &str, plain: &[u8]) -> Result<String, String> {
    let theirs = URL_SAFE_NO_PAD.decode(to).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()).ok_or("A bad public key")?;
    let theirs = PublicKey::from(theirs);
    let mine = StaticSecret::from(rand::random::<[u8; 32]>());
    let ours = PublicKey::from(&mine);
    let cipher = cipher(&mine.diffie_hellman(&theirs).to_bytes(), &ours, &theirs);
    let sealed = cipher.encrypt(Nonce::from_slice(&[0; 12]), plain).map_err(|_| "Couldn't seal the grants".to_string())?;
    let mut out = ours.as_bytes().to_vec();
    out.extend(sealed);
    Ok(URL_SAFE_NO_PAD.encode(out))
}

/// The key both sides derive: the shared secret, bound to who sent and who received.
fn cipher(shared: &[u8; 32], sender: &PublicKey, receiver: &PublicKey) -> ChaCha20Poly1305 {
    let mut salt = sender.as_bytes().to_vec();
    salt.extend(receiver.as_bytes());
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared).expand(INFO, &mut key).expect("32 bytes is a valid length");
    ChaCha20Poly1305::new(Key::from_slice(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_key_it_was_sealed_to_opens_it() {
        let opener = Opener::new();
        let sealed = seal(&opener.public(), b"refresh tokens").unwrap();
        assert!(!sealed.contains("refresh"));
        assert_eq!(opener.open(&sealed).unwrap(), b"refresh tokens");
        assert!(Opener::new().open(&sealed).is_err(), "another key can't open it");
        let mut tampered = URL_SAFE_NO_PAD.decode(&sealed).unwrap();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(opener.open(&URL_SAFE_NO_PAD.encode(tampered)).is_err(), "a changed box doesn't open");
        assert!(seal("not a key", b"x").is_err());
    }
}
