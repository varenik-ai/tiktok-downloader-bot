import https from "https";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

function sendVideo(chatId, videoUrl, caption) {
  return tgRequest("sendVideo", { chat_id: chatId, video: videoUrl, caption, parse_mode: "HTML", supports_streaming: true });
}

function sendPhoto(chatId, thumbUrl, caption, downloadUrl) {
  return tgRequest("sendPhoto", {
    chat_id: chatId, photo: thumbUrl, caption, parse_mode: "HTML",
    reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "⬇️ Скачать видео", url: downloadUrl }]] })
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

async function getFileSize(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, { method: "HEAD" }, res => {
      resolve(parseInt(res.headers["content-length"] || "0"));
    });
    req.on("error", () => resolve(0));
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
  const text = message.text?.trim() || "";

  if (text === "/start") {
    await sendMessage(chatId,
      `👋 <b>Привет!</b>\n\n` +
      `Я скачиваю видео из TikTok <b>без водяного знака</b>.\n\n` +
      `Просто отправь мне ссылку на видео TikTok — и я пришлю тебе чистый mp4.\n\n` +
      `📎 Пример:\n<code>https://www.tiktok.com/@user/video/123456</code>`
    );
    return res.status(200).json({ ok: true });
  }

  const isTikTok = text.includes("tiktok.com") || text.includes("vm.tiktok.com") || text.includes("vt.tiktok.com");
  if (!isTikTok) {
    await sendMessage(chatId, "❌ Отправь ссылку на видео TikTok.\n\nПример:\n<code>https://www.tiktok.com/@user/video/123</code>");
    return res.status(200).json({ ok: true });
  }

  if (!checkLimit(userId)) {
    await sendMessage(chatId,
      `⛔ <b>Лимит на сегодня исчерпан</b>\n\n` +
      `Бесплатно доступно ${DAILY_LIMIT} скачиваний в день.\n` +
      `Возвращайся завтра! 🌅`
    );
    return res.status(200).json({ ok: true });
  }

  const waitMsg = await sendMessage(chatId, "⏳ Скачиваю видео, подожди секунду...");
  const waitMsgId = waitMsg?.result?.message_id;

  try {
    const data = await getTikTokVideo(text);
    const videoUrl = data.hdplay || data.play;
    const thumbUrl = data.cover;
    const caption = `❤️ Скачано @tiktok_save_pro_bot`;
    const fileSize = await getFileSize(videoUrl);
    const fileSizeMb = fileSize / (1024 * 1024);

    if (waitMsgId) await deleteMessage(chatId, waitMsgId);

    if (fileSize > 0 && fileSizeMb > 50) {
      // Больше 50 МБ — превью + кнопка скачать напрямую
      await sendPhoto(
        chatId,
        thumbUrl,
        caption + `\n\n📦 ${fileSizeMb.toFixed(1)} МБ · нажми кнопку чтобы скачать`,
        videoUrl
      );
    } else {
      // До 50 МБ — пробуем отправить видео
      const result = await sendVideo(chatId, videoUrl, caption);
      // Если Telegram не смог отправить — даём прямую ссылку
      if (!result?.ok) {
        await sendPhoto(
          chatId,
          thumbUrl,
          caption + `\n\n⬇️ Нажми кнопку чтобы скачать`,
          videoUrl
        );
      }
    }

  } catch (err) {
    if (waitMsgId) await deleteMessage(chatId, waitMsgId);
    await sendMessage(chatId,
      `❌ <b>Не удалось скачать видео</b>\n\n` +
      `Возможные причины:\n` +
      `• Видео приватное\n` +
      `• Неверная ссылка\n` +
      `• Попробуй ещё раз через минуту`
    );
  }

  return res.status(200).json({ ok: true });
}
