const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const https = require('https');
const http = require('http');
const { networkInterfaces } = require('os');

const app = express();
const PORT = 3000;

// Flag yt-dlp tối ưu: giả lập player_client=android và bỏ qua tải webpage để tránh bị YouTube chặn 429 trên Cloud/Datacenter IP
const YT_FLAGS = `--extractor-args "youtube:player_client=android;player_skip=webpage,configs" --no-playlist`;

// Cache RAM
const urlCache = new Map();  // videoId -> { url, expireTime }
const feedCache = new Map(); // category -> { data, expireTime }

app.use(express.static(path.join(__dirname, '../public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  next();
});

// ─── API: Video đề xuất trang chủ (Trending / Categories) ─────────────────────
app.get('/api/feed', (req, res) => {
  const cat = (req.query.category || 'trending').toLowerCase();
  const cached = feedCache.get(cat);
  if (cached && cached.expireTime > Date.now()) {
    return res.json(cached.data);
  }

  const queryMap = {
    trending: 'thịnh hành việt nam',
    music: 'nhạc trẻ thịnh hành',
    gaming: 'gaming việt nam',
    chill: 'nhạc chill lofi',
    news: 'tin tức việt nam',
    podcast: 'podcast viet nam'
  };

  const q = queryMap[cat] || cat;
  const count = 16;
  const cmd = `yt-dlp "ytsearch${count}:${q.replace(/"/g, '')}" --dump-json ${YT_FLAGS} --flat-playlist`;

  exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
    if (err && !stdout) {
      console.error('[feed error]', (stderr || '').slice(0, 200));
      return res.status(500).json({ error: 'Không lấy được video đề xuất' });
    }

    try {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const results = lines.map(line => {
        const v = JSON.parse(line);
        return {
          videoId: v.id,
          title: v.title || '(no title)',
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
          duration: v.duration || 0,
          author: v.uploader || v.channel || '',
          views: v.view_count || 0,
        };
      });
      // Cache 10 phút
      feedCache.set(cat, { data: results, expireTime: Date.now() + 10 * 60 * 1000 });
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: 'Parse JSON thất bại: ' + e.message });
    }
  });
});

// ─── API: Tìm kiếm qua yt-dlp ────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);

  const count = 14;
  const cmd = `yt-dlp "ytsearch${count}:${q.replace(/"/g, '')}" --dump-json ${YT_FLAGS} --flat-playlist`;

  exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
    if (err && !stdout) {
      console.error('[search error]', (stderr || '').slice(0, 200));
      return res.status(500).json({ error: 'Tìm kiếm thất bại' });
    }

    try {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const results = lines.map(line => {
        const v = JSON.parse(line);
        return {
          videoId: v.id,
          title: v.title || '(no title)',
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
          duration: v.duration || 0,
          author: v.uploader || v.channel || '',
          views: v.view_count || 0,
        };
      });
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: 'Parse JSON thất bại: ' + e.message });
    }
  });
});

// ─── API: Thông tin video ─────────────────────────────────────────────────────
app.get('/api/video/:videoId', (req, res) => {
  const { videoId } = req.params;
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  exec(`yt-dlp --dump-json ${YT_FLAGS} "${ytUrl}"`, { timeout: 30000 }, (err, stdout) => {
    if (err && !stdout) return res.status(500).json({ error: 'Không lấy được thông tin video' });
    try {
      const v = JSON.parse(stdout.trim());
      res.json({
        videoId: v.id,
        title: v.title,
        description: (v.description || '').slice(0, 600),
        author: v.uploader || v.channel,
        views: v.view_count,
        thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Helper lấy trực tiếp stream URL từ cache hoặc yt-dlp
function fetchStreamUrl(videoId) {
  const cached = urlCache.get(videoId);
  if (cached && cached.expireTime > Date.now()) {
    return Promise.resolve(cached.url);
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const fmtArg = `18/b[ext=mp4][height<=720]/b[ext=mp4]/b/best`;
  const cmd = `yt-dlp ${YT_FLAGS} -f "${fmtArg}" --get-url "${ytUrl}"`;

  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        return reject(new Error(stderr || 'yt-dlp get-url failed'));
      }
      const lines = (stdout || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('http://') || l.startsWith('https://'));
      const directUrl = lines[0];
      if (!directUrl) return reject(new Error('Không tìm thấy URL hợp lệ trong kết quả: ' + (stdout || '').slice(0, 100)));

      // Cache 2 tiếng
      urlCache.set(videoId, { url: directUrl, expireTime: Date.now() + 2 * 3600 * 1000 });
      resolve(directUrl);
    });
  });
}

// ─── API: Proxy stream về client (Hỗ trợ đầy đủ Range 206 cho iOS Safari) ────
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const directUrl = await fetchStreamUrl(videoId);
    const client = directUrl.startsWith('https') ? https : http;

    const upHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': '*/*',
    };
    if (req.headers.range) {
      upHeaders['range'] = req.headers.range;
    }

    const upReq = client.get(directUrl, { headers: upHeaders }, (upRes) => {
      const responseHeaders = {
        'Content-Type': upRes.headers['content-type'] || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      };
      if (upRes.headers['content-length']) responseHeaders['Content-Length'] = upRes.headers['content-length'];
      if (upRes.headers['content-range']) responseHeaders['Content-Range'] = upRes.headers['content-range'];

      res.writeHead(upRes.statusCode || 200, responseHeaders);
      upRes.pipe(res);
    });

    upReq.on('error', (err) => {
      console.error('[upstream proxy error]', err.message);
      if (!res.headersSent) res.status(502).end('Upstream error');
    });

    req.on('close', () => {
      upReq.destroy();
    });
  } catch (err) {
    console.error('[stream error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Tránh crash process
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║         Boitube Server Running       ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`\n  Local:  http://localhost:${PORT}`);
  console.log(`  iOS:    http://${ip}:${PORT}  ← nhập vào Safari iPhone\n`);
});
