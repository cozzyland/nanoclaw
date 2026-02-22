"""
Prompt Injection Detection Service

Loads ProtectAI's deberta-v3-base-prompt-injection-v2 and serves
text classifications via HTTP. Detects prompt injection attempts.

Usage:
  uvicorn server:app --host 127.0.0.1 --port 3003

First run downloads the model (~350MB).
"""

from fastapi import FastAPI
from pydantic import BaseModel
from transformers import pipeline

app = FastAPI()

classifier = pipeline(
    "text-classification",
    model="protectai/deberta-v3-base-prompt-injection-v2",
    device="mps",  # Apple Silicon GPU; falls back to CPU if unavailable
)


class ClassifyRequest(BaseModel):
    text: str


@app.post("/classify")
async def classify(request: ClassifyRequest):
    result = classifier(request.text, truncation=True, max_length=512)[0]
    # Model outputs SAFE/INJECTION — normalize to match our interface
    label = "BENIGN" if result["label"] == "SAFE" else "INJECTION"
    return {"label": label, "score": round(result["score"], 4)}


@app.get("/health")
async def health():
    return {"status": "ok"}
