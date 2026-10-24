"""Launch with NSET_TOKEN in the environment, never in argv or logs."""
import argparse
import os
from urllib.parse import urlsplit

from .context import CompatContext, MAX_BODY_BYTES
from .gateway import make_server


def main():
    parser = argparse.ArgumentParser(description="Native experiment compatibility gateway")
    parser.add_argument("--native-url", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--listen", default="127.0.0.1:3001")
    parser.add_argument("--public-url")
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--max-body-bytes", type=int, default=MAX_BODY_BYTES)
    args = parser.parse_args()
    token = os.environ.get("NSET_TOKEN", "")
    if not token:
        parser.error("NSET_TOKEN environment variable is required")
    try:
        address = urlsplit("http://" + args.listen)
        if not address.hostname or address.port is None or address.path or address.username or address.password or address.query or address.fragment:
            raise ValueError("listen must be HOST:PORT (IPv6: [HOST]:PORT)")
        if not 1 <= args.workers <= 256 or not 1 <= args.max_body_bytes <= 1024**3:
            raise ValueError("workers must be 1..256; max-body-bytes must be 1..1073741824")
        ctx = CompatContext(args.native_url, token, args.data_dir, args.public_url or "http://" + args.listen)
    except ValueError as exc:
        parser.error(str(exc))
    server = None
    try:
        server = make_server(ctx, address.hostname, address.port, args.workers, args.max_body_bytes)
        host, port = server.server_address[:2]
        listening_url = "http://" + ("[" + host + "]" if ":" in host else host) + ":" + str(port)
        if not args.public_url:
            ctx.public_url = listening_url
        print("Compatibility gateway listening on " + listening_url, flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server is not None:
            server.server_close()
        ctx.close()


if __name__ == "__main__":
    main()
