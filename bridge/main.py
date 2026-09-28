import asyncio
import base64
import json
import os
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Annotated

import msgpack
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException


FISH_AUDIO_URL = "wss://api.fish.audio/v1/tts/live/with-timestamp"
FISH_MODEL = "s2.1-pro-free"
DEFAULT_VOICE_ID = "b347db033a6549378b48d00acb0d06cd"
TEXT_FRAGMENT_LENGTH = 100
SAMPLE_RATE = 44_100


class TTSRequest(BaseModel):
    text: Annotated[str, Field(min_length=1)]
    reference_id: str = DEFAULT_VOICE_ID


def text_fragments(text: str, max_length: int = TEXT_FRAGMENT_LENGTH) -> Iterator[str]:
    start = 0

    while start < len(text):
        end = min(start + max_length, len(text))

        if end < len(text):
            boundary = end
            while boundary > start and not text[boundary - 1].isspace():
                boundary -= 1
            if boundary > start:
                end = boundary

        yield text[start:end]
        start = end


def pack_message(message: dict[str, object]) -> bytes:
    return msgpack.packb(message, use_bin_type=True)


async def send_text(socket: ClientConnection, text: str) -> None:
    for fragment in text_fragments(text):
        await socket.send(pack_message({"event": "text", "text": fragment}))

    await socket.send(pack_message({"event": "stop"}))


async def fish_events(socket: ClientConnection, text: str) -> AsyncIterator[bytes]:
    sender = asyncio.create_task(send_text(socket, text))

    try:
        async for frame in socket:
            if isinstance(frame, str):
                continue

            message = msgpack.unpackb(frame, raw=False)
            event = message.get("event")

            if event == "audio":
                payload = {
                    "event": "audio",
                    "audio_base64": base64.b64encode(message["audio"]).decode("ascii"),
                    "alignment": message.get("alignment"),
                    "chunk_seq": message.get("chunk_seq"),
                    "chunk_audio_offset_sec": message.get("chunk_audio_offset_sec"),
                    "content": message.get("content"),
                }
                yield encode_sse(payload)
            elif event == "error" or (event == "finish" and message.get("reason") == "error"):
                detail = message.get("message") or message.get("error")
                yield encode_sse({"event": "error", "message": detail or "Fish Audio could not generate speech."})
                return
            elif event == "finish":
                yield encode_sse({"event": "finish"})
                return
        yield encode_sse({"event": "error", "message": "Fish Audio ended before finishing speech."})
    except (WebSocketException, ValueError, KeyError, TypeError):
        yield encode_sse({"event": "error", "message": "The connection to Fish Audio ended unexpectedly."})
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)
        await socket.close()


def encode_sse(payload: dict[str, object]) -> bytes:
    data = json.dumps(payload, separators=(",", ":"))
    return f"data: {data}\n\n".encode()


def create_app(api_key: str | None = None) -> FastAPI:
    app = FastAPI(title="Readflow local TTS bridge")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/tts/stream/with-timestamp")
    async def stream_tts(payload: TTSRequest) -> StreamingResponse:
        if not api_key:
            raise HTTPException(
                status_code=503,
                detail="Set FISH_API_KEY in the project .env file, then restart the bridge.",
            )

        socket: ClientConnection | None = None
        try:
            socket = await connect(
                FISH_AUDIO_URL,
                additional_headers={
                    "Authorization": f"Bearer {api_key}",
                    "model": FISH_MODEL,
                },
                max_size=None,
                open_timeout=10,
                close_timeout=5,
            )
            await socket.send(
                pack_message(
                    {
                        "event": "start",
                        "request": {
                            "text": "",
                            "reference_id": payload.reference_id,
                            "format": "pcm",
                            "sample_rate": SAMPLE_RATE,
                            "latency": "balanced",
                            "chunk_length": TEXT_FRAGMENT_LENGTH,
                        },
                    }
                )
            )
        except (OSError, WebSocketException) as error:
            if socket is not None:
                await socket.close()
            raise HTTPException(
                status_code=502,
                detail="Could not start a streaming session with Fish Audio.",
            ) from error

        return StreamingResponse(
            fish_events(socket, payload.text),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


load_dotenv(Path(__file__).resolve().parents[1] / ".env")
app = create_app(os.getenv("FISH_API_KEY"))
