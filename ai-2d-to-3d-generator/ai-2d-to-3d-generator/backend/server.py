"""
AI 2D to 3D Generator - Backend
================================
FastAPI server that turns a single 2D image into a downloadable 3D mesh
(GLB / OBJ / STL / PLY) using TripoSR.

Endpoints
---------
POST /generate            multipart image upload -> starts a generation job
GET  /status/{job_id}     poll job progress / result
GET  /preview/{filename}  serve the uploaded source image
GET  /download/{filename} download a generated model file
GET  /health              simple liveness check

Run
---
    uvicorn server:app --host 0.0.0.0 --port 8000 --reload

See README.md for how to install TripoSR itself (it is not a pip package).
"""

import io
import os
import re
import time
import uuid
import shutil
import logging
import threading
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from PIL import Image
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ----------------------------------------------------------------------------
# Paths & config
# ----------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
MODELS_DIR = BASE_DIR / "models"

for d in (UPLOAD_DIR, OUTPUT_DIR, MODELS_DIR):
    d.mkdir(parents=True, exist_ok=True)

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB
ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("ai-2d-to-3d")

# ----------------------------------------------------------------------------
# Device selection: CUDA if available, otherwise CPU
# ----------------------------------------------------------------------------

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
log.info(f"Using device: {DEVICE}")

# ----------------------------------------------------------------------------
# TripoSR model (lazy-loaded once, on first request)
# ----------------------------------------------------------------------------
# TripoSR's own repo (https://github.com/VAST-AI-Research/TripoSR) must be
# cloned next to this file, or its `tsr` package must be importable, e.g.:
#
#   git clone https://github.com/VAST-AI-Research/TripoSR.git
#   pip install -e TripoSR
#
# The import is done lazily so the API server can still start (and answer
# /health) even before TripoSR is installed.

_model = None
_model_lock = threading.Lock()


def get_model():
    """Load TripoSR once and cache it."""
    global _model
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model
        try:
            from tsr.system import TSR
        except ImportError as exc:
            raise RuntimeError(
                "TripoSR is not installed. Clone "
                "https://github.com/VAST-AI-Research/TripoSR next to server.py "
                "and `pip install -e TripoSR` (see README.md)."
            ) from exc

        log.info("Loading TripoSR weights from Hugging Face (stabilityai/TripoSR)...")
        model = TSR.from_pretrained(
            "stabilityai/TripoSR",
            config_name="config.yaml",
            weight_name="model.ckpt",
        )
        model.renderer.set_chunk_size(8192)
        model.to(DEVICE)
        _model = model
        log.info("TripoSR ready.")
        return _model


# ----------------------------------------------------------------------------
# In-memory job tracking
# ----------------------------------------------------------------------------

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


def set_job(job_id: str, **fields):
    with JOBS_LOCK:
        JOBS.setdefault(job_id, {}).update(fields)


def get_job(job_id: str) -> Optional[dict]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return dict(job) if job else None


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def sanitize_filename(name: str) -> str:
    """Strip path components and unsafe characters from a filename."""
    name = os.path.basename(name)
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name[-120:] if len(name) > 120 else name


def remove_background(image: Image.Image) -> Image.Image:
    """Remove background and pad to a square RGBA image, as TripoSR expects."""
    import rembg

    session = getattr(remove_background, "_session", None)
    if session is None:
        session = rembg.new_session()
        remove_background._session = session

    image = image.convert("RGBA")
    image = rembg.remove(image, session=session)

    # Pad to square on transparent canvas, matching TripoSR's expected input
    w, h = image.size
    size = max(w, h)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(image, ((size - w) // 2, (size - h) // 2))

    # Composite onto mid-gray for the foreground, alpha kept for masking
    fg = np.array(canvas).astype(np.float32) / 255.0
    alpha = fg[:, :, 3:4]
    rgb = fg[:, :, :3] * alpha + 0.5 * (1 - alpha)
    out = (rgb * 255.0).astype(np.uint8)
    return Image.fromarray(out).convert("RGB")


def export_formats(mesh, job_dir: Path, base_name: str, formats: list[str]) -> dict:
    """Export a trimesh Mesh/Scene to the requested formats."""
    paths = {}
    for fmt in formats:
        fmt = fmt.lower()
        out_path = job_dir / f"{base_name}.{fmt}"
        mesh.export(str(out_path))
        paths[fmt] = out_path.name
    return paths


def run_generation(job_id: str, image_path: Path, formats: list[str], mc_resolution: int):
    """Background worker: runs the actual TripoSR inference for one job."""
    try:
        set_job(job_id, status="processing", progress=5, message="Memuat model AI...")
        model = get_model()

        set_job(job_id, progress=20, message="Menghapus latar belakang...")
        image = Image.open(image_path)
        processed = remove_background(image)

        set_job(job_id, progress=40, message="Menjalankan inferensi 3D (TripoSR)...")
        with torch.no_grad():
            scene_codes = model([processed], device=DEVICE)

        set_job(job_id, progress=70, message="Mengekstrak mesh (marching cubes)...")
        meshes = model.extract_mesh(scene_codes, resolution=mc_resolution)
        mesh = meshes[0]

        set_job(job_id, progress=85, message="Mengekspor model...")
        job_dir = OUTPUT_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        exported = export_formats(mesh, job_dir, "model", formats)

        set_job(
            job_id,
            status="done",
            progress=100,
            message="Selesai.",
            files=exported,
        )
        log.info(f"Job {job_id} complete -> {exported}")

    except Exception as exc:  # noqa: BLE001
        log.exception(f"Job {job_id} failed")
        set_job(job_id, status="failed", progress=0, message=str(exc))


# ----------------------------------------------------------------------------
# FastAPI app
# ----------------------------------------------------------------------------

app = FastAPI(title="AI 2D to 3D Generator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this to your actual frontend origin in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "device": DEVICE, "cuda_available": torch.cuda.is_available()}


@app.post("/generate")
async def generate(
    file: UploadFile = File(...),
    formats: str = Form("glb"),          # comma separated: glb,obj,stl,ply
    mc_resolution: int = Form(256),       # marching cubes resolution (quality vs speed)
):
    # --- validate content type & extension ---
    ext = Path(file.filename or "").suffix.lower()
    if file.content_type not in ALLOWED_CONTENT_TYPES or ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Format file tidak didukung. Gunakan JPG, PNG, atau WEBP.")

    # --- validate size (stream-checked to respect MAX_FILE_SIZE) ---
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="Ukuran file melebihi batas 20 MB.")
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="File kosong atau rusak.")

    # --- validate it's actually a readable image ---
    try:
        img = Image.open(io.BytesIO(contents))
        img.verify()
    except Exception:
        raise HTTPException(status_code=400, detail="File bukan gambar yang valid.")

    fmt_list = [f.strip().lower() for f in formats.split(",") if f.strip()]
    allowed_fmts = {"glb", "obj", "stl", "ply"}
    if not fmt_list or any(f not in allowed_fmts for f in fmt_list):
        raise HTTPException(status_code=400, detail="Format output tidak valid. Pilih dari: glb, obj, stl, ply.")

    job_id = uuid.uuid4().hex
    safe_name = sanitize_filename(file.filename or "upload.png")
    saved_path = UPLOAD_DIR / f"{job_id}_{safe_name}"
    with open(saved_path, "wb") as f:
        f.write(contents)

    set_job(
        job_id,
        status="queued",
        progress=0,
        message="Menunggu antrian...",
        source_image=saved_path.name,
        created_at=time.time(),
    )

    thread = threading.Thread(
        target=run_generation,
        args=(job_id, saved_path, fmt_list, mc_resolution),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "status": "queued"}


@app.get("/status/{job_id}")
def status(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job tidak ditemukan.")
    return job


@app.get("/preview/{filename}")
def preview(filename: str):
    safe = sanitize_filename(filename)
    path = UPLOAD_DIR / safe
    if not path.exists():
        # filenames are stored as "{job_id}_{original}", allow direct lookup too
        matches = list(UPLOAD_DIR.glob(f"*{safe}"))
        if matches:
            path = matches[0]
        else:
            raise HTTPException(status_code=404, detail="Gambar tidak ditemukan.")
    return FileResponse(path)


@app.get("/download/{job_id}/{filename}")
def download(job_id: str, filename: str):
    safe = sanitize_filename(filename)
    path = OUTPUT_DIR / sanitize_filename(job_id) / safe
    if not path.exists():
        raise HTTPException(status_code=404, detail="File model tidak ditemukan.")
    return FileResponse(path, filename=safe, media_type="application/octet-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
