import argparse
import asyncio
from pathlib import Path
import sys

import uvicorn


async def serve(project: Path, port: int) -> None:
    sys.path.insert(0, str(project))
    server = uvicorn.Server(uvicorn.Config(
        "bridge.main:app", host="127.0.0.1", port=port,
        timeout_graceful_shutdown=3,
    ))
    loop = asyncio.get_running_loop()
    descriptor = sys.stdin.fileno()

    def parent_closed() -> None:
        sys.stdin.buffer.read(1)
        loop.remove_reader(descriptor)
        server.should_exit = True

    loop.add_reader(descriptor, parent_closed)
    try:
        await server.serve()
    finally:
        loop.remove_reader(descriptor)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the bridge while its Readflow app is open.")
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--port", type=int, default=4179)
    args = parser.parse_args()
    asyncio.run(serve(args.project.resolve(), args.port))


if __name__ == "__main__":
    main()
