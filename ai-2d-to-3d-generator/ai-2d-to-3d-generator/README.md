# AI 2D to 3D Generator

Ubah gambar 2D menjadi model 3D (GLB/OBJ/STL/PLY) yang bisa diputar 360° di
browser, menggunakan TripoSR (AI image-to-3D dari Stability AI / VAST).

```
project/
├── backend/
│   ├── server.py          <- FastAPI + integrasi TripoSR (nyata, bukan dummy)
│   ├── requirements.txt
│   ├── uploads/            (dibuat otomatis)
│   ├── outputs/             (dibuat otomatis)
│   └── models/                (dibuat otomatis)
├── frontend/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── api.js
│   ├── viewer.js
│   ├── manifest.json
│   └── sw.js
└── README.md   <- file ini
```

## ⚠️ Penting — baca dulu

Backend ini benar-benar memanggil model AI TripoSR untuk melakukan inferensi
3D — tidak ada shortcut atau data dummy. Konsekuensinya:

- Anda perlu **mengunduh bobot model** (~1.5 GB) dari Hugging Face saat
  pertama kali dijalankan (butuh koneksi internet).
- Generate 1 gambar butuh waktu **~10–30 detik dengan GPU (CUDA)**, atau
  **beberapa menit dengan CPU saja**.
- TripoSR bukan paket pip biasa — repo resminya harus di-clone terpisah
  (langkah di bawah).

## 1. Setup Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

# 1a. Install PyTorch SESUAI hardware Anda dulu (lihat pytorch.org):
#     CUDA 12.1:
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
#     atau CPU-only:
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

# 1b. Install dependensi lainnya
pip install -r requirements.txt

# 1c. Clone & install TripoSR (wajib — inti mesin AI-nya)
git clone https://github.com/VAST-AI-Research/TripoSR.git
pip install -e TripoSR

# 1d. Jalankan server
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Bobot model TripoSR (`stabilityai/TripoSR` di Hugging Face) akan otomatis
terunduh pada request `/generate` pertama.

Cek server hidup: buka `http://localhost:8000/health` — harus mengembalikan
`{"status": "ok", ...}`.

## 2. Setup Frontend

Frontend adalah HTML/CSS/JS statis murni — tidak perlu build step.

```bash
cd frontend
python3 -m http.server 5500
```

Buka `http://localhost:5500` di browser.

Jika backend dijalankan di alamat/port lain, set sebelum `api.js` dimuat:

```html
<script>window.__API_BASE__ = "http://alamat-backend-anda:8000";</script>
<script src="api.js"></script>
```

## 3. Cara Pakai

1. Seret & lepas (atau klik untuk memilih) gambar JPG/PNG/WEBP di sidebar kiri.
2. Pilih format output (GLB/OBJ/STL/PLY) dan resolusi mesh yang diinginkan.
3. Klik **Generate Model 3D** — progress bar & estimasi waktu akan tampil.
4. Model akan otomatis dimuat ke viewer 3D di sebelah kanan (orbit, zoom, pan,
   auto-rotate, wireframe, screenshot, fullscreen tersedia di toolbar).
5. Unduh model dalam format yang dipilih, atau klik **Reset** untuk mulai lagi.
6. Riwayat model yang pernah dibuat tersimpan di panel **Riwayat Terbaru**
   (disimpan di localStorage browser).

## Catatan Produksi

- `CORSMiddleware` di `server.py` diset `allow_origins=["*"]` untuk
  kemudahan pengembangan — batasi ke domain frontend Anda sebelum deploy.
- Endpoint `/download` dan `/preview` mem-filter nama file (`sanitize_filename`)
  untuk mencegah path traversal.
- File upload dibatasi 20 MB dan divalidasi tipe kontennya di server (bukan
  hanya di frontend).
- Untuk beban produksi nyata, ganti job-tracking in-memory (`dict` Python) di
  `server.py` dengan antrian task yang persisten (mis. Redis + RQ/Celery),
  agar job tidak hilang saat server restart dan bisa di-scale ke banyak worker.
