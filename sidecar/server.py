from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

compressor = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global compressor
    from llmlingua import PromptCompressor

    compressor = PromptCompressor(
        model_name="microsoft/llmlingua-2-xlm-roberta-large-meetingbank",
        use_llmlingua2=True,
        device_map="cpu",
    )
    yield


app = FastAPI(lifespan=lifespan)


class CompressRequest(BaseModel):
    text: str
    rate: float = 0.5


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": compressor is not None}


@app.post("/compress")
def compress(payload: CompressRequest):
    if compressor is None:
        raise HTTPException(status_code=503, detail="Model is still loading")
    result = compressor.compress_prompt(
        payload.text,
        rate=payload.rate,
        force_tokens=["\n", "?", "!", ".", ",", "'", '"'],
    )
    return {
        "text": result["compressed_prompt"],
        "original_tokens": result["origin_tokens"],
        "compressed_tokens": result["compressed_tokens"],
    }
