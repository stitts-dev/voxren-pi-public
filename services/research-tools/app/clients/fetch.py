"""Fetch one page from the open web without letting a caller aim the service at its own network.

A search result or a caller's URL is untrusted input, and this service runs next to things a stranger must not reach:
cloud metadata, a database, another local service. So each hop of a fetch is checked before any connection is made:
scheme, credentials, port, and every address the host resolves to. The service then connects to the address it checked,
not to the name, so a DNS answer that changes between the check and the connection cannot redirect it.

The client identifies itself honestly. A site that refuses it is not pressed: the caller decides about the archive.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import zlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from app.config import Settings
from app.errors import ToolError

MAX_BYTES = 2_000_000  # decoded bytes, so a compression bomb is capped as well as a large page
MAX_REDIRECTS = 4
DEADLINE_SECONDS = 15.0  # wall clock for the whole fetch; httpx timeouts apply to one operation each
ALLOWED_TYPES = frozenset({"text/html", "application/xhtml+xml", "text/plain"})
ALLOWED_PORTS = frozenset({80, 443})
_COMPRESSIONS = frozenset({"gzip", "deflate"})  # what read_text_body inflates within a bound; requests ask for gzip only
# Sites that refuse a script on purpose. These mean "do not press this site", not "the site is broken".
REFUSED_STATUSES = frozenset({401, 403, 429, 451, 503})
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
# is_global is True for these on current Python, but they reach private hosts through a translator or a tunnel.
_NEVER_PUBLIC = [ipaddress.ip_network(net) for net in ("64:ff9b::/96", "64:ff9b:1::/48", "fec0::/10", "::/96", "2002::/16")]

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Resolver = Callable[[str, int], Awaitable[list[IPAddress]]]


@dataclass(frozen=True)
class FetchedPage:
    final_url: str
    html: str
    truncated: bool = False
    status: int = 200


def check_url(url: str) -> httpx.URL:
    """Parse `url` and refuse what a fetch must never follow: another scheme, credentials, a port other than 80 and 443."""
    try:
        parsed = httpx.URL(url)
    except httpx.InvalidURL:
        raise ToolError("url_blocked", 422, "That is not a valid URL.") from None
    if parsed.scheme not in ("http", "https") or not parsed.raw_host:
        raise ToolError("url_blocked", 422, "Only http and https URLs are fetched.")
    if parsed.userinfo:
        raise ToolError("url_blocked", 422, "URLs with a user name or password are not fetched.")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port not in ALLOWED_PORTS:
        raise ToolError("url_blocked", 422, f"Port {port} is not fetched; only 80 and 443 are.")
    return parsed


def is_public(address: IPAddress) -> bool:
    """True only for an address on the public internet. An IPv4 address inside an IPv6 one is judged as the IPv4 address."""
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global and not address.is_multicast and not any(address in net for net in _NEVER_PUBLIC if net.version == address.version)


def _literal_address(host: str) -> IPAddress | None:
    """The address a host written as a number stands for, including the short forms (127.1, 0x7f.1, 2130706433)."""
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    try:
        return ipaddress.IPv4Address(socket.inet_aton(host))
    except OSError:
        return None


async def resolve(host: str, port: int) -> list[IPAddress]:
    """Every address `host` points at. A number is not looked up, so judging it needs no network and no platform quirk."""
    literal = _literal_address(host)
    if literal is not None:
        return [literal]
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except UnicodeError:  # a label that is empty or over 63 characters cannot be encoded; a ToolError, so no caller treats it as "does not resolve"
        raise ToolError("url_blocked", 422, f"{host} is not a valid host name.") from None
    return [ipaddress.ip_address(info[4][0].split("%")[0]) for info in infos]


async def public_address(target: httpx.URL, resolver: Resolver) -> IPAddress:
    """Resolve the target's host once. Every address must be public: one private answer among public ones is enough to refuse.

    The archive calls it too, so a host that points at a private network is refused on every path, not only the one that connects.
    """
    host = target.raw_host.decode("ascii")
    addresses = await resolver(host, target.port or (443 if target.scheme == "https" else 80))
    if not addresses or not all(is_public(address) for address in addresses):
        raise ToolError("url_blocked", 422, f"{host} does not point at a public address.")
    return addresses[0]


def _encoding_layers(response: httpx.Response) -> list[str]:
    """The compression layers the site applied, in the order it listed them. `identity` is no layer."""
    names = (name.strip().lower() for name in response.headers.get("content-encoding", "").split(","))
    return [name for name in names if name not in ("", "identity")]


async def read_text_body(response: httpx.Response) -> tuple[str, bool]:
    """The body as text if it is HTML or plain text, cut at MAX_BYTES. The flag is True when it was cut.

    The body is read raw and decoded here, not by httpx: httpx chains every Content-Encoding layer with no limit on what
    one chunk may expand to, so a page that wraps gzip in gzip can allocate gigabytes (and block the event loop) before
    any cap is checked. Here one layer of gzip or deflate is inflated with a limit on every call; any other
    encoding is refused.
    """
    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_TYPES:
        raise ToolError("unsupported_content", 415, f"Only HTML and plain text are read; this is {content_type or 'untyped'}.")
    layers = _encoding_layers(response)
    if len(layers) > 1 or (layers and layers[0] not in _COMPRESSIONS):
        raise ToolError("unsupported_content", 415, "Only a page with no compression or one layer of gzip or deflate is read.")
    inflater = zlib.decompressobj(wbits=47) if layers else None  # 47 takes a gzip or a zlib header, whichever the site wrote
    body = bytearray()
    received = False
    try:
        async for chunk in response.aiter_raw():
            received = received or bool(chunk)
            if inflater is None:
                body += chunk
            else:
                # max_length is what one call may produce; input it did not get to comes back in unconsumed_tail.
                while chunk and len(body) <= MAX_BYTES:
                    body += inflater.decompress(chunk, MAX_BYTES + 1 - len(body))
                    chunk = inflater.unconsumed_tail
            if len(body) > MAX_BYTES:
                break
    except zlib.error:
        raise ToolError("fetch_failed", 502, "The page's compressed body is corrupt.") from None
    truncated = len(body) > MAX_BYTES
    if truncated:
        del body[MAX_BYTES:]
    elif inflater is not None and received and not inflater.eof:
        raise ToolError("fetch_failed", 502, "The page's compressed body ended early.")
    try:
        return body.decode(response.encoding or "utf-8", "replace"), truncated
    except (LookupError, UnicodeError):  # a charset Python does not know, or a codec that is not for text (idna, undefined)
        return body.decode("utf-8", "replace"), truncated


def _raise_for_status(response: httpx.Response) -> None:
    if response.is_success:
        return
    if response.status_code in REFUSED_STATUSES:
        raise ToolError("fetch_refused", 502, f"The site refused the request (HTTP {response.status_code}).")
    raise ToolError("fetch_failed", 502, f"The site answered HTTP {response.status_code}.")


async def _follow(client: httpx.AsyncClient, url: str, resolver: Resolver) -> FetchedPage:
    for _ in range(MAX_REDIRECTS + 1):
        target = check_url(url)
        host = target.raw_host.decode("ascii")
        address = await public_address(target, resolver)
        # Connect to the address that was checked; keep the real name for Host and for the TLS name check.
        request = client.build_request("GET", target.copy_with(host=str(address)), headers={"Host": target.netloc.decode("ascii")}, extensions={"sni_hostname": host})
        response = await client.send(request, stream=True)
        try:
            location = response.headers.get("location")
            if response.status_code in _REDIRECT_STATUSES and location:
                try:
                    url = str(target.join(location))
                except httpx.InvalidURL:
                    raise ToolError("fetch_failed", 502, "The page redirected to an invalid URL.") from None
                continue  # the next hop is checked from the top like the first
            _raise_for_status(response)
            html, truncated = await read_text_body(response)
            return FetchedPage(final_url=str(target), html=html, truncated=truncated, status=response.status_code)
        finally:
            await response.aclose()
    raise ToolError("fetch_failed", 502, f"The page redirected more than {MAX_REDIRECTS} times.")


async def fetch_page(url: str, *, settings: Settings, transport: httpx.AsyncBaseTransport | None = None, resolver: Resolver | None = None) -> FetchedPage:
    """GET `url` and return its text. Tests pass a MockTransport and a resolver that answers without DNS."""
    # The client is built here and closed here. Keepalive is off because a pooled connection is keyed by the address we
    # pinned, not by the name: it could be reused for another host on the same address with no new certificate check.
    # trust_env is off because a proxy from the environment would connect to the name and skip the address check.
    async with httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(8.0, connect=4.0),
        follow_redirects=False,
        trust_env=False,
        headers={"User-Agent": settings.user_agent, "Accept-Encoding": "gzip"},  # the one compression read_text_body decodes
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    ) as client:
        try:
            async with asyncio.timeout(DEADLINE_SECONDS):
                return await _follow(client, url, resolver or resolve)
        except (TimeoutError, httpx.TimeoutException):
            raise ToolError("fetch_failed", 502, f"The page did not load within {DEADLINE_SECONDS:g} seconds.") from None
        except OSError:  # raised by the resolver when the name has no address
            raise ToolError("fetch_failed", 502, "The host could not be found.") from None
        except httpx.HTTPError as error:
            raise ToolError("fetch_failed", 502, f"The page could not be fetched ({type(error).__name__}).") from None
