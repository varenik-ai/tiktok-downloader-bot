import https from "https";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const BOT_TOKEN = process.env.BOT_TOKEN;
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "10");
const COUNTERS_FILE = join(tmpdir(), "counters.json");

function getCounters() {
  try {
    if (existsSync(COUNTERS_FILE)) return JSON.parse(readFileSync(COUNTERS_FILE, "utf8"));
  } catch {}
  return {};
}

function saveCounters(data) {
  try { writeFileSync(COUNTERS_FILE, JSON.stringify(data), "utf8"); } catch {}
}

function checkLimit(userId) {
  const counters = getCounters();
  const today = new Date().toISOString().slice(0, 10);
  const key = `${userId}_${today}`;
  const count = counters[key] || 0;
  if (count >= DAILY_LIMIT) return false;
  counters[key] = count + 1;
  saveCounters(counters);
  return true;
}

function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    };
    const req = https.request(options, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve(JSON.parse(buf)));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text, extra = {}) {
  return tgRequest("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

function deleteMessage(chatId, messageId) {
  return tgRequest("deleteMessage", { chat_id: chatId, message_id: messageId });
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.tiktok.com/" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.end();
  });
}

function sendVideoBuffer(chatId, buffer) {
  return new Promise((resolve, reject) => {
    const boundary = randomBytes(16).toString("hex");
    const part1 = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="supports_streaming"\r\n\r\ntrue\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`
    );
    const part2 = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([part1, buffer, part2]);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/sendVideo`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length
      }
    };
    const req = https.request(options, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve(JSON.parse(buf)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getTikTokVideo(url) {
  return new Promise((resolve, reject) => {
    const formData = `url=${encodeURIComponent(url)}&hd=1`;
    const options = {
      hostname: "www.tikwm.com", path: "/api/", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(formData), "User-Agent": "Mozilla/5.0" }
    };
    const req = https.request(options, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(buf);
          if (json.code === 0 && json.data) resolve(json.data);
          else reject(new Error("Не удалось получить видео"));
        } catch { reject(new Error("Ошибка парсинга")); }
      });
    });
    req.on("error", reject);
    req.write(formData);
    req.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  const update = req.body;
  const message = update?.message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const userId = message.from.id;
  const lang = message.from?.language_code || "en";
  const isRu = lang.startsWith("ru") || lang.startsWith("uk") || lang.startsWith("be");
  const text = message.text?.trim() || "";

  if (text === "/start") {
    await sendMessage(chatId,
      isRu
        ? `👋 <b>Привет!</b>\n\nЯ скачиваю видео из TikTok <b>без водяного знака</b>.\n\nПросто отправь мне ссылку на видео TikTok — и я пришлю тебе чистый mp4.\n\n📎 Пример:\n<code>https://www.tiktok.com/@user/video/123456</code>`
        : `👋 <b>Hello!</b>\n\nI download TikTok videos <b>without watermark</b>.\n\nJust send me a TikTok link and I'll send you a clean mp4.\n\n📎 Example:\n<code>https://www.tiktok.com/@user/video/123456</code>`
    );
    return res.status(200).json({ ok: true });
  }

  const isTikTok = text.includes("tiktok.com") || text.includes("vm.tiktok.com") || text.includes("vt.tiktok.com");
  if (!isTikTok) {
    await sendMessage(chatId,
      isRu
        ? "❌ Отправь ссылку на видео TikTok.\n\nПример:\n<code>https://www.tiktok.com/@user/video/123</code>"
        : "❌ Send a TikTok video link.\n\nExample:\n<code>https://www.tiktok.com/@user/video/123</code>"
    );
    return res.status(200).json({ ok: true });
  }

  if (!checkLimit(userId)) {
    await sendMessage(chatId,
      isRu
        ? `⛔ <b>Лимит на сегодня исчерпан</b>\n\nБесплатно доступно ${DAILY_LIMIT} скачиваний в день.\nВозвращайся завтра! 🌅`
        : `⛔ <b>Daily limit reached</b>\n\n${DAILY_LIMIT} free downloads per day.\nCome back tomorrow! 🌅`
    );
    return res.status(200).json({ ok: true });
  }

  const waitMsg = await sendMessage(chatId,
    isRu ? "⏳ Скачиваю видео, подожди секунду..." : "⏳ Downloading, please wait..."
  );
  const waitMsgId = waitMsg?.result?.message_id;

  try {
    const data = await getTikTokVideo(text);
    const videoUrl = data.hdplay || data.play;

    const buffer = await downloadBuffer(videoUrl);
    const fileSizeMb = buffer.length / (1024 * 1024);

    if (fileSizeMb > 50) {
      if (waitMsgId) await deleteMessage(chatId, waitMsgId);
      await sendMessage(chatId,
        isRu
          ? `❌ Видео слишком большое (${fileSizeMb.toFixed(1)} МБ).\nTelegram принимает файлы до 50 МБ через бота.`
          : `❌ Video is too large (${fileSizeMb.toFixed(1)} MB).\nTelegram bots support up to 50 MB.`
      );
    } else {
      const result = await sendVideoBuffer(chatId, buffer);
      if (waitMsgId) await deleteMessage(chatId, waitMsgId);
      if (result?.ok) {
        // Отправляем подпись отдельным сообщением — так ссылка будет кликабельной
        await sendMessage(chatId,
          `${isRu ? "⬇️ Скачать TikTok без водяного знака → @tiktok_pro_save_bot" : "⬇️ Download TikTok without watermark → @tiktok_pro_save_bot"}`
        );
      } else {
        await sendMessage(chatId,
          isRu
            ? `❌ Не удалось отправить видео: ${result?.description || "неизвестная ошибка"}`
            : `❌ Failed to send video: ${result?.description || "unknown error"}`
        );
      }
    }

  } catch (err) {
    if (waitMsgId) await deleteMessage(chatId, waitMsgId);
    await sendMessage(chatId,
      isRu
        ? `❌ <b>Не удалось скачать видео</b>\n\nВозможные причины:\n• Видео приватное\n• Неверная ссылка\n• Попробуй ещё раз через минуту`
        : `❌ <b>Failed to download video</b>\n\nPossible reasons:\n• Private video\n• Invalid link\n• Try again in a minute`
    );
  }

  return res.status(200).json({ ok: true });
}
