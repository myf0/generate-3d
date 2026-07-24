/**
 * api.js — thin wrapper around the FastAPI backend.
 * Loaded as a plain (non-module) script so it attaches to `window`.
 */

const API_BASE = window.__API_BASE__ || "http://localhost:8000";

const Api = {
  /**
   * Upload an image and start a generation job.
   * @param {File} file
   * @param {{formats: string[], mcResolution: number}} opts
   * @param {(pct:number)=>void} onUploadProgress
   * @returns {Promise<{job_id:string,status:string}>}
   */
  generate(file, opts, onUploadProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("file", file);
      form.append("formats", opts.formats.join(","));
      form.append("mc_resolution", String(opts.mcResolution));

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}/generate`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onUploadProgress) {
          onUploadProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data);
          } else {
            reject(new Error(data.detail || `Server error (${xhr.status})`));
          }
        } catch (err) {
          reject(new Error("Respons server tidak valid."));
        }
      };

      xhr.onerror = () => reject(new Error("Tidak dapat terhubung ke server. Periksa koneksi backend."));
      xhr.send(form);
    });
  },

  async status(jobId) {
    const res = await fetch(`${API_BASE}/status/${jobId}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || `Gagal memeriksa status (${res.status})`);
    }
    return res.json();
  },

  downloadUrl(jobId, filename) {
    return `${API_BASE}/download/${jobId}/${filename}`;
  },

  previewUrl(filename) {
    return `${API_BASE}/preview/${filename}`;
  },

  async health() {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) throw new Error("Backend tidak merespons.");
    return res.json();
  },

  /**
   * Poll /status until the job is done or failed.
   * @param {string} jobId
   * @param {(job:object)=>void} onUpdate
   * @returns {Promise<object>} final job object
   */
  pollUntilDone(jobId, onUpdate) {
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const job = await this.status(jobId);
          onUpdate(job);
          if (job.status === "done") {
            clearInterval(interval);
            resolve(job);
          } else if (job.status === "failed") {
            clearInterval(interval);
            reject(new Error(job.message || "Generate gagal."));
          }
        } catch (err) {
          clearInterval(interval);
          reject(err);
        }
      }, 1200);
    });
  },
};

window.Api = Api;
