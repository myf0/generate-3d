import { ModelViewer } from "./viewer.js";

/* ---------------------------------------------------------- */
/* Elements                                                    */
/* ---------------------------------------------------------- */

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const dropzoneEmpty = document.getElementById("dropzoneEmpty");
const dropzonePreview = document.getElementById("dropzonePreview");
const previewImg = document.getElementById("previewImg");
const removeImageBtn = document.getElementById("removeImageBtn");

const uploadProgressWrap = document.getElementById("uploadProgressWrap");
const uploadProgressBar = document.getElementById("uploadProgressBar");
const uploadProgressLabel = document.getElementById("uploadProgressLabel");

const formatGrid = document.getElementById("formatGrid");
const qualityRange = document.getElementById("qualityRange");
const qualityValue = document.getElementById("qualityValue");

const generateBtn = document.getElementById("generateBtn");
const genStatus = document.getElementById("genStatus");
const genProgressBar = document.getElementById("genProgressBar");
const genProgressLabel = document.getElementById("genProgressLabel");
const genMessage = document.getElementById("genMessage");
const genEta = document.getElementById("genEta");
const genError = document.getElementById("genError");

const downloadPanel = document.getElementById("downloadPanel");
const downloadButtons = document.getElementById("downloadButtons");
const resetBtn = document.getElementById("resetBtn");

const historyList = document.getElementById("historyList");

const viewerEmptyState = document.getElementById("viewerEmptyState");
const viewerLoading = document.getElementById("viewerLoading");
const viewerLoadingText = document.getElementById("viewerLoadingText");

const autoRotateBtn = document.getElementById("autoRotateBtn");
const resetCameraBtn = document.getElementById("resetCameraBtn");
const wireframeBtn = document.getElementById("wireframeBtn");
const screenshotBtn = document.getElementById("screenshotBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");

const themeToggle = document.getElementById("themeToggle");
const toastRoot = document.getElementById("toastRoot");

/* ---------------------------------------------------------- */
/* State                                                        */
/* ---------------------------------------------------------- */

let selectedFile = null;
let currentJobId = null;
let genStartTime = null;
const HISTORY_KEY = "ai23d_history";

const viewer = new ModelViewer(document.getElementById("viewerCanvas"));

/* ---------------------------------------------------------- */
/* Toast helper                                                */
/* ---------------------------------------------------------- */

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ---------------------------------------------------------- */
/* Theme toggle                                                */
/* ---------------------------------------------------------- */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ai23d_theme", theme);
}
applyTheme(localStorage.getItem("ai23d_theme") || "dark");

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
});

/* ---------------------------------------------------------- */
/* File selection / drag & drop                                */
/* ---------------------------------------------------------- */

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const MAX_SIZE = 20 * 1024 * 1024;

dropzone.addEventListener("click", (e) => {
  if (e.target.closest("#removeImageBtn")) return;
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);

["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);

dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

removeImageBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  resetUploadOnly();
});

function handleFile(file) {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    toast("Format tidak didukung. Gunakan JPG, PNG, atau WEBP.", "error");
    return;
  }
  if (file.size > MAX_SIZE) {
    toast("Ukuran file melebihi 20MB.", "error");
    return;
  }

  selectedFile = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;

  dropzoneEmpty.classList.add("hidden");
  dropzonePreview.classList.remove("hidden");
  generateBtn.disabled = false;
  genError.classList.add("hidden");
}

function resetUploadOnly() {
  selectedFile = null;
  fileInput.value = "";
  dropzoneEmpty.classList.remove("hidden");
  dropzonePreview.classList.add("hidden");
  generateBtn.disabled = true;
}

/* ---------------------------------------------------------- */
/* Options                                                      */
/* ---------------------------------------------------------- */

qualityRange.addEventListener("input", () => {
  qualityValue.textContent = qualityRange.value;
});

function getSelectedFormats() {
  return Array.from(formatGrid.querySelectorAll("input:checked")).map((i) => i.value);
}

formatGrid.addEventListener("change", () => {
  const checked = formatGrid.querySelectorAll("input:checked");
  if (checked.length === 0) {
    // at least one format must remain selected
    formatGrid.querySelector('input[value="glb"]').checked = true;
  }
});

/* ---------------------------------------------------------- */
/* Generate flow                                                */
/* ---------------------------------------------------------- */

generateBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  const formats = getSelectedFormats();
  if (formats.length === 0) {
    toast("Pilih minimal satu format output.", "error");
    return;
  }

  rippleButton(generateBtn);
  beginGenerateUI();

  try {
    uploadProgressWrap.classList.remove("hidden");

    const { job_id } = await Api.generate(
      selectedFile,
      { formats, mcResolution: Number(qualityRange.value) },
      (pct) => {
        uploadProgressBar.style.width = `${pct}%`;
        uploadProgressLabel.textContent = `${pct}%`;
      }
    );

    currentJobId = job_id;
    uploadProgressWrap.classList.add("hidden");
    genStartTime = Date.now();

    const finalJob = await Api.pollUntilDone(job_id, updateGenProgress);
    await onGenerationDone(finalJob);
  } catch (err) {
    showGenerationError(err.message || "Terjadi kesalahan yang tidak diketahui.");
  }
});

function rippleButton(btn) {
  btn.classList.remove("rippling");
  void btn.offsetWidth; // restart animation
  btn.classList.add("rippling");
}

function beginGenerateUI() {
  generateBtn.disabled = true;
  genStatus.classList.remove("hidden");
  genError.classList.add("hidden");
  downloadPanel.hidden = true;
  genProgressBar.style.width = "0%";
  genProgressLabel.textContent = "0%";
  genMessage.textContent = "Mengunggah gambar...";
  genEta.textContent = "";

  viewerEmptyState.classList.add("hidden");
  viewerLoading.classList.remove("hidden");
  viewerLoadingText.textContent = "Menyiapkan model AI...";
}

function updateGenProgress(job) {
  const pct = job.progress ?? 0;
  genProgressBar.style.width = `${pct}%`;
  genProgressLabel.textContent = `${pct}%`;
  genMessage.textContent = job.message || statusLabel(job.status);
  viewerLoadingText.textContent = job.message || "Memproses...";

  if (genStartTime && pct > 0 && pct < 100) {
    const elapsed = (Date.now() - genStartTime) / 1000;
    const estTotal = elapsed / (pct / 100);
    const remaining = Math.max(0, Math.round(estTotal - elapsed));
    genEta.textContent = `Estimasi sisa waktu: ~${remaining}s`;
  }
}

function statusLabel(status) {
  return (
    {
      queued: "Menunggu antrian...",
      processing: "Memproses...",
      done: "Selesai.",
      failed: "Gagal.",
    }[status] || status
  );
}

async function onGenerationDone(job) {
  genMessage.textContent = "Berhasil dibuat!";
  genEta.textContent = "";
  toast("Model 3D berhasil dibuat.", "success");

  const glbName = job.files?.glb;
  if (glbName) {
    viewerLoadingText.textContent = "Memuat model ke viewer...";
    try {
      await viewer.loadModel(Api.downloadUrl(currentJobId, glbName));
    } catch (err) {
      console.error(err);
      toast("Model dibuat, tetapi gagal dimuat di viewer.", "error");
    }
  }

  viewerLoading.classList.add("hidden");
  viewerEmptyState.classList.add("hidden");

  renderDownloadButtons(job.files || {});
  addToHistory(job);

  generateBtn.disabled = false;
}

function showGenerationError(message) {
  genStatus.classList.add("hidden");
  genError.textContent = `Generate gagal: ${message}`;
  genError.classList.remove("hidden");
  viewerLoading.classList.add("hidden");
  viewerEmptyState.classList.remove("hidden");
  generateBtn.disabled = false;
  toast("Generate gagal. Lihat detail di panel kiri.", "error");
}

function renderDownloadButtons(files) {
  downloadButtons.innerHTML = "";
  const labels = { glb: "Download GLB", obj: "Download OBJ", stl: "Download STL", ply: "Download PLY" };

  Object.entries(files).forEach(([fmt, filename]) => {
    const a = document.createElement("a");
    a.className = "download-item";
    a.href = Api.downloadUrl(currentJobId, filename);
    a.download = filename;
    a.innerHTML = `<span>${labels[fmt] || `Download ${fmt.toUpperCase()}`}</span><span class="fmt-tag">${fmt.toUpperCase()}</span>`;
    downloadButtons.appendChild(a);
  });

  downloadPanel.hidden = false;
}

/* ---------------------------------------------------------- */
/* Reset                                                        */
/* ---------------------------------------------------------- */

resetBtn.addEventListener("click", () => {
  resetUploadOnly();
  currentJobId = null;
  genStatus.classList.add("hidden");
  genError.classList.add("hidden");
  downloadPanel.hidden = true;
  viewer.clearModel();
  viewerEmptyState.classList.remove("hidden");
  viewerLoading.classList.add("hidden");
  toast("Direset. Silakan unggah gambar baru.");
});

/* ---------------------------------------------------------- */
/* Viewer toolbar                                               */
/* ---------------------------------------------------------- */

autoRotateBtn.addEventListener("click", () => {
  const active = viewer.toggleAutoRotate();
  autoRotateBtn.classList.toggle("active", active);
});

resetCameraBtn.addEventListener("click", () => viewer.resetCamera());

wireframeBtn.addEventListener("click", () => {
  const active = viewer.toggleWireframe();
  wireframeBtn.classList.toggle("active", active);
});

screenshotBtn.addEventListener("click", () => {
  if (!viewer.currentModel) {
    toast("Belum ada model untuk di-screenshot.", "error");
    return;
  }
  const dataUrl = viewer.screenshot();
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `model-screenshot-${Date.now()}.png`;
  a.click();
  toast("Screenshot disimpan.", "success");
});

fullscreenBtn.addEventListener("click", () => viewer.requestFullscreen());

/* ---------------------------------------------------------- */
/* History (local, auto-save)                                   */
/* ---------------------------------------------------------- */

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 8)));
}

function addToHistory(job) {
  const items = loadHistory();
  items.unshift({
    jobId: currentJobId,
    files: job.files || {},
    thumb: previewImg.src && previewImg.src.startsWith("blob:") ? null : previewImg.src,
    time: Date.now(),
  });
  saveHistory(items);
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  if (items.length === 0) {
    historyList.innerHTML = `<p class="history-empty">Belum ada model yang dibuat.</p>`;
    return;
  }
  historyList.innerHTML = "";
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "history-item";
    const date = new Date(item.time).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
    el.innerHTML = `<span>Model &middot; ${date}</span>`;
    el.addEventListener("click", async () => {
      const glbName = item.files?.glb;
      if (!glbName) {
        toast("Format GLB tidak tersedia untuk item ini.", "error");
        return;
      }
      viewerEmptyState.classList.add("hidden");
      viewerLoading.classList.remove("hidden");
      viewerLoadingText.textContent = "Memuat dari riwayat...";
      try {
        currentJobId = item.jobId;
        await viewer.loadModel(Api.downloadUrl(item.jobId, glbName));
        renderDownloadButtons(item.files);
      } catch {
        toast("Gagal memuat model dari riwayat (mungkin sudah dihapus di server).", "error");
      } finally {
        viewerLoading.classList.add("hidden");
      }
    });
    historyList.appendChild(el);
  });
}
renderHistory();

/* ---------------------------------------------------------- */
/* Backend health check (non-blocking)                          */
/* ---------------------------------------------------------- */

Api.health().catch(() => {
  toast("Backend tidak terdeteksi di http://localhost:8000. Jalankan server.py terlebih dahulu.", "error");
});

/* ---------------------------------------------------------- */
/* PWA service worker registration                              */
/* ---------------------------------------------------------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* offline cache is a bonus feature; ignore failures silently */
    });
  });
}
