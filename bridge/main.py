import os
from pathlib import Path
from typing import Annotated

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


FISH_AUDIO_URL = "https://api.fish.audio/v1/tts/stream/with-timestamp"
FISH_MODEL = "s2.1-pro-free"
DEFAULT_VOICE_ID = "b347db033a6549378b48d00acb0d06cd"
SAMPLE_RATE = 44_100


class TTSRequest(BaseModel):
    text: Annotated[str, Field(min_length=1)]
    reference_id: str = DEFAULT_VOICE_ID


def create_app(
    api_key: str | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
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

        client = httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(connect=10, read=60, write=10, pool=10),
        )
        request = client.build_request(
            "POST",
            FISH_AUDIO_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "model": FISH_MODEL,
            },
            json={
                "text": payload.text,
                "reference_id": payload.reference_id,
                "format": "pcm",
                "sample_rate": SAMPLE_RATE,
                "latency": "balanced",
            },
        )

        try:
            upstream = await client.send(request, stream=True)
        except httpx.HTTPError as error:
            await client.aclose()
            raise HTTPException(
                status_code=502,
                detail="Could not connect to Fish Audio.",
            ) from error

        if upstream.is_error:
            await upstream.aclose()
            await client.aclose()
            raise HTTPException(
                status_code=502,
                detail="Fish Audio rejected the streaming request.",
            )

        async def relay_events():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(
            relay_events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


load_dotenv(Path(__file__).resolve().parents[1] / ".env")
app = create_app(os.getenv("FISH_API_KEY"))
