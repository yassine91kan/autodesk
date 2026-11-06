// routes/health.js
// ---------------------------------------------------------------------------
// GET /healthz - "is the app alive, and is it set up right?"
//
// Render calls it every few seconds (Settings > Health Check Path = /healthz): when it
// stops answering, Render restarts the app, and a new deploy only goes live once it
// answers. It is mounted BEFORE sign-in (server.js), since Render has no login cookie,
// so it only shows counts and sizes: never model names, users or questions.
//
// It answers fast and never loads a model (a first download can take a minute, and
// Render would give up waiting). 200 = healthy; 503 = the app runs but something is
// wrong, e.g. DATA_DIR is set but the disk can't be written: then indexes, budgets
// and follow-ups would be lost on the next restart, which a deploy should not hide.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const express = require('express');
const { loadedModels, maxLoadedModels } = require('../augmented/store');

const router = express.Router();
const megabytes = bytes => Math.round(bytes / 1048576);

// The persistent disk: is it there and writable, how full is it, and how much do the
// saved model indexes take? null = no DATA_DIR (local development: memory only).
function diskReport() {
    const dir = process.env.DATA_DIR;
    if (!dir) return null;
    const report = { writable: false };
    try {
        if (!fs.statSync(dir).isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
        fs.accessSync(dir, fs.constants.W_OK);
        report.writable = true;
        const disk = fs.statfsSync(dir);
        report.sizeMB = megabytes(disk.blocks * disk.bsize);
        report.freeMB = megabytes(disk.bavail * disk.bsize);
        report.usedPercent = Math.round(100 * (1 - disk.bavail / disk.blocks));
        const indexes = path.join(dir, 'indexes');
        const files = fs.existsSync(indexes) ? fs.readdirSync(indexes).filter(name => name.endsWith('.sqlite')) : [];
        report.savedModels = files.length;
        report.savedModelsMB = megabytes(files.reduce((sum, name) => sum + fs.statSync(path.join(indexes, name)).size, 0));
    } catch (error) {
        report.error = error.code || 'unreadable';   // the code only ("EACCES"): no paths
    }
    return report;
}

router.get('/healthz', (req, res) => {
    const disk = diskReport();
    const memory = process.memoryUsage();
    const healthy = !disk || disk.writable;
    res.status(healthy ? 200 : 503).json({
        ok: healthy,
        uptimeMinutes: Math.round(process.uptime() / 60),
        modelsInMemory: loadedModels.size,
        maxModelsInMemory: maxLoadedModels(),
        memoryMB: megabytes(memory.rss),
        disk: disk || 'not configured (memory only)'
    });
});

module.exports = router;
