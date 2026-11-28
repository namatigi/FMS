"""Passwords (scrypt), JWT (HS256), TOTP and the @fms/shared security helpers.

Formats are identical to the node services, so tokens, password hashes, API
keys and webhook signatures issued by either implementation verify in the other.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
from typing import Any
from urllib.parse import quote

# ---------------------------------------------------------------- base64url


def b64u(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ---------------------------------------------------------------- @fms/shared security


def sha256_hex(s: str | bytes) -> str:
    return hashlib.sha256(s.encode() if isinstance(s, str) else s).hexdigest()


def hmac_sha256_hex(secret: str, body: str | bytes) -> str:
    return hmac.new(secret.encode(), body.encode() if isinstance(body, str) else body, hashlib.sha256).hexdigest()


def safe_equal_hex(a: str, b: str) -> bool:
    return hmac.compare_digest(a.lower().encode(), b.lower().encode())


def verify_pts_signature(secret: str | None, raw_body: bytes | str, signature: str | None) -> bool:
    """HMAC-SHA256 of the raw body with the controller "Secret key". No secret -> accept (TLS + basic auth)."""
    if not secret:
        return True
    if not signature:
        return False
    return safe_equal_hex(hmac_sha256_hex(secret, raw_body), signature)


def generate_api_key(prefix_len: int = 8) -> dict[str, str]:
    """API keys are '<prefix>.<secret>': prefix stored in clear for lookup, the full key as sha256."""
    prefix = b64u(secrets.token_bytes(prefix_len))[:prefix_len]
    key = f"{prefix}.{b64u(secrets.token_bytes(32))}"
    return {"key": key, "prefix": prefix, "hash": sha256_hex(key)}


def sign_webhook(secret: str, body: str, now: int | None = None) -> str:
    """Webhook signature header: t=<unix>,v1=<hmac(secret, f"{t}.{body}")>."""
    t = int(time.time()) if now is None else now
    return f"t={t},v1={hmac_sha256_hex(secret, f'{t}.{body}')}"


def random_token(nbytes: int = 32) -> str:
    return b64u(secrets.token_bytes(nbytes))


# ---------------------------------------------------------------- passwords
# Format: scrypt$N$r$p$<salt base64>$<64-byte key base64>

DEFAULT_N, DEFAULT_R, DEFAULT_P = 16384, 8, 1
DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + base64.b64encode(bytes(64)).decode()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=DEFAULT_N, r=DEFAULT_R, p=DEFAULT_P, maxmem=64 * 1024 * 1024, dklen=64)
    return f"scrypt${DEFAULT_N}${DEFAULT_R}${DEFAULT_P}${base64.b64encode(salt).decode()}${base64.b64encode(key).decode()}"


def verify_password(password: str, encoded: str | None) -> bool:
    """Constant-ish time: unknown users are checked against a dummy hash so timing does not reveal them."""
    parts = (encoded or DUMMY_HASH).split("$")
    usable = len(parts) == 6 and parts[0] == "scrypt"
    _, n, r, p, salt_b64, key_b64 = parts if usable else DUMMY_HASH.split("$")
    try:
        n_i, r_i, p_i = int(n), int(r), int(p)
    except ValueError:
        return False
    if n_i < 2 or n_i > 1 << 20:
        return False
    expected = base64.b64decode(key_b64)
    got = hashlib.scrypt(
        password.encode(), salt=base64.b64decode(salt_b64), n=n_i, r=r_i, p=p_i, maxmem=256 * 1024 * 1024, dklen=len(expected) or 64
    )
    return usable and encoded is not None and len(expected) == len(got) and hmac.compare_digest(expected, got)


# ---------------------------------------------------------------- JWT (HS256)


def sign_jwt(claims: dict[str, Any], secret: str, ttl_sec: int, now: int | None = None) -> str:
    now = int(time.time()) if now is None else now
    header = b64u(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")))
    payload = b64u(json.dumps({**claims, "iat": now, "exp": now + ttl_sec}, separators=(",", ":")))
    sig = b64u(hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def verify_jwt(token: str, secret: str, now: int | None = None) -> dict[str, Any] | None:
    now = int(time.time()) if now is None else now
    parts = token.split(".")
    if len(parts) != 3:
        return None
    h, p, s = parts
    try:
        header = json.loads(b64u_decode(h))
    except ValueError:  # bad base64, UTF-8 or JSON
        return None
    if not isinstance(header, dict) or header.get("alg") != "HS256":
        return None
    expected = hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    try:
        got = b64u_decode(s)
    except ValueError:  # bad base64, UTF-8 or JSON
        return None
    if not hmac.compare_digest(got, expected):
        return None
    try:
        claims = json.loads(b64u_decode(p))
    except ValueError:  # bad base64, UTF-8 or JSON
        return None
    if not isinstance(claims, dict):
        return None
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool) or exp <= now:
        return None
    if not isinstance(claims.get("sub"), str) or not isinstance(claims.get("role"), str):
        return None
    return claims


# ---------------------------------------------------------------- TOTP (RFC 6238, SHA1, 30 s, 6 digits)


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _b32decode(s: str) -> bytes:
    clean = "".join(s.upper().split()).rstrip("=")
    return base64.b32decode(clean + "=" * (-len(clean) % 8))


def totp_at(secret_b32: str, time_sec: int, step: int = 30, digits: int = 6) -> str:
    counter = time_sec // step
    mac = hmac.new(_b32decode(secret_b32), struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    code = struct.unpack(">I", mac[off : off + 4])[0] & 0x7FFFFFFF
    return str(code % 10**digits).zfill(digits)


def verify_totp(secret_b32: str, code: str, now: int | None = None) -> bool:
    """±1 step window, constant-time compare."""
    now = int(time.time()) if now is None else now
    if not (isinstance(code, str) and len(code) == 6 and code.isdigit()):
        return False
    ok = False
    for d in (-1, 0, 1):
        if hmac.compare_digest(totp_at(secret_b32, now + d * 30).encode(), code.encode()):
            ok = True
    return ok


def otpauth_url(issuer: str, account: str, secret: str) -> str:
    label = quote(f"{issuer}:{account}", safe="")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer, safe='')}&algorithm=SHA1&digits=6&period=30"
