/**
 * assistant-notify — 当 Pi 需要你关注时发送通知
 *
 * 解决的场景：Pi 在后台跑长任务时，assistant 已经产出消息 / 停下来等你，
 * 但你在别的窗口，收不到及时提醒。
 *
 * 触发时机（mode）：
 *   - "settled"：agent_settled —— Pi 完全停下来等待输入时通知（默认，适合"跑完叫我"）
 *   - "message"：message_end —— assistant 中途发来问题/征求确认时立即通知
 *   - "both"   ：两者都通知
 *
 * 通知通道（可分别开关）：
 *   - desktop   ：notify-send 原生桌面通知（KDE/GNOME 等）
 *   - bell      ：终端响铃 \x07
 *   - osc       ：终端 OSC 777 / OSC 99 通知（Ghostty/iTerm2/WezTerm/Kitty）
 *   - sound     ：paplay 播放提示音
 *   - kdeconnect：通过 KDE Connect 发到手机（需先 /notify device <id>）
 *   - webhook   ：通过 Webhook 推到手机（Telegram / ntfy / Bark / Server酱 / PushPlus）
 *
 * 命令：
 *   /notify                         查看当前配置
 *   /notify test                    发送一条测试通知
 *   /notify on|off                  总开关
 *   /notify mode settled|message|both
 *   /notify min-duration <秒>       完成通知的最短任务时长
 *   /notify privacy status|summary|full
 *   /notify retry on|off
 *   /notify <channel> on|off        desktop / bell / osc / sound / kdeconnect / webhook
 *   /notify device <deviceId>      设置 KDE Connect 设备（/notify devices 查看）
 *   /notify webhook                查看 webhook 配置
 *   /notify webhook on|off|test
 *   /notify webhook telegram <bot_token> <chat_id>
 *   /notify webhook ntfy|bark|serverchan|pushplus <target>
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

type NotifyMode = "settled" | "message" | "both";
type Channel = "desktop" | "bell" | "osc" | "sound" | "kdeconnect" | "webhook";
type WebhookType = "telegram" | "ntfy" | "bark" | "serverchan" | "pushplus";
type NotificationKind = "done" | "attention" | "test";
type PrivacyMode = "status" | "summary" | "full";

interface NotificationMeta {
  kind: NotificationKind;
  project?: string;
  session?: string;
  elapsedMs?: number;
}

interface NotifyConfig {
  enabled: boolean;
  mode: NotifyMode;
  desktop: boolean;
  bell: boolean;
  osc: boolean;
  sound: boolean;
  soundFile: string;
  kdeconnect: boolean;
  deviceId: string;
  webhook: boolean;
  webhookType: WebhookType;
  webhookTarget: string;
  webhookChatId: string;
  minDurationSeconds: number;
  privacy: PrivacyMode;
  retry: boolean;
}

const CONFIG_PATH = join(homedir(), CONFIG_DIR_NAME, "agent", "assistant-notify.json");

const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  mode: "settled",
  desktop: true,
  bell: true,
  osc: true,
  sound: false,
  soundFile: "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga",
  kdeconnect: false,
  deviceId: "",
  webhook: false,
  webhookType: "telegram",
  webhookTarget: "",
  webhookChatId: "",
  minDurationSeconds: 20,
  privacy: "summary",
  retry: true,
};

const SOUND_CANDIDATES = [
  "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga",
  "/usr/share/sounds/freedesktop/stereo/complete.oga",
  "/usr/share/sounds/freedesktop/stereo/bell.oga",
];

const RETRY_DELAYS_MS = [2000, 5000, 15000];

function loadConfig(): NotifyConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<NotifyConfig>;
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch {
    // 配置损坏时回退默认值，不打断 Pi
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: NotifyConfig): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // 写失败不致命
  }
}

/** 从 assistant message 中抽取纯文本 */
function assistantText(message: unknown): string {
  const m = message as { content?: unknown };
  const content = m?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type?: string; text?: string } => (b as { type?: string })?.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("\n");
  }
  return "";
}

/** 判断这条 assistant 消息是否在向你提问 / 征求意见 */
function needsAttention(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[?？]\s*$/.test(t)) return true;
  return /请问|请确认|请告诉|需要你|需要您|是否继续|是否可以|能否|等你|由你决定|等待你的|you need to|can you|should i|let me know|your call|waiting for/i.test(t);
}

function snippet(text: string, max = 160): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function cleanNotificationText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "【代码已省略】")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "【图片】")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds > 0 ? `${minutes}分${restSeconds}秒` : `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}小时${restMinutes}分` : `${hours}小时`;
}

/** OSC 转义序列中的字段不能包含控制字符和分号 */
function sanitizeOsc(s: string): string {
  return s.replace(/[\x00-\x1f\x7f;]/g, " ").trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTelegramMessage(title: string, body: string, meta: NotificationMeta): string {
  const presentation = {
    done: {
      icon: "✅",
      label: "回复摘要",
      status: "🟢 <i>正在等待你的输入</i>",
    },
    attention: {
      icon: "🙋",
      label: "需要查看",
      status: "🟠 <i>需要你查看或回复</i>",
    },
    test: {
      icon: "🧪",
      label: "测试内容",
      status: "🔔 <i>Telegram 推送通道正常</i>",
    },
  }[meta.kind];

  const elapsed = meta.elapsedMs === undefined ? "" : `  ·  ⏱ ${formatDuration(meta.elapsedMs)}`;
  const lines = [`${presentation.icon} <b>${escapeHtml(title)}</b>${elapsed}`];
  const context: string[] = [];
  if (meta.project) context.push(`📁 <code>${escapeHtml(meta.project)}</code>`);
  if (meta.session) context.push(`🧵 ${escapeHtml(snippet(meta.session, 48))}`);
  if (context.length > 0) lines.push("", context.join("  ·  "));

  if (body) {
    lines.push("", `💬 <b>${presentation.label}</b>`, escapeHtml(body));
  }
  lines.push(
    "",
    `${presentation.status}  ·  🕒 ${new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })}`,
  );
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();
  let runStartedAt = 0;
  let runHadAssistant = false;
  let lastAssistantText = "";
  let lastMessageNotifyAt = 0;
  let lastSettledNotifyAt = 0;

  async function run(cmd: string, args: string[]): Promise<void> {
    try {
      await pi.exec(cmd, args, { timeout: 5000 });
    } catch {
      // 通知失败不应影响 Pi 运行
    }
  }

  function notifyOsc(title: string, body: string): void {
    const t = sanitizeOsc(title);
    const b = sanitizeOsc(body);
    if (process.env.KITTY_WINDOW_ID) {
      process.stdout.write(`\x1b]99;i=1:d=0;${t}\x1b\\`);
      process.stdout.write(`\x1b]99;i=1:p=body;${b}\x1b\\`);
    } else {
      process.stdout.write(`\x1b]777;notify;${t};${b}\x07`);
    }
  }

  function resolveSoundFile(): string {
    if (cfg.soundFile && existsSync(cfg.soundFile)) return cfg.soundFile;
    for (const f of SOUND_CANDIDATES) {
      if (existsSync(f)) return f;
    }
    return "";
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function httpRequest(url: string, init: RequestInit): Promise<void> {
    const attempts = cfg.retry ? RETRY_DELAYS_MS.length + 1 : 1;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);

      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        continue;
      }

      if (res.ok) return;

      const detail = snippet(await res.text().catch(() => ""), 240);
      const error = new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      if (res.status < 500 && res.status !== 429) throw error;
      lastError = error;
    }

    throw lastError ?? new Error("通知请求失败");
  }

  async function httpGet(url: string): Promise<void> {
    await httpRequest(url, { method: "GET" });
  }

  async function httpPost(url: string, init: RequestInit = {}): Promise<void> {
    await httpRequest(url, { method: "POST", ...init });
  }

  function normalizeTarget(target: string, prefix: string): string {
    return target.includes("://") ? target.replace(/\/$/, "") : `${prefix}/${target}`;
  }

  function elapsedMs(): number | undefined {
    return runStartedAt > 0 ? Math.max(0, Date.now() - runStartedAt) : undefined;
  }

  function notificationMeta(kind: NotificationKind, ctx: ExtensionContext): NotificationMeta {
    return {
      kind,
      project: basename(ctx.cwd) || ctx.cwd,
      session: pi.getSessionName(),
      elapsedMs: kind === "test" ? undefined : elapsedMs(),
    };
  }

  function notificationBody(text: string, fallback: string): string {
    if (cfg.privacy === "status") return "";
    const cleaned = cleanNotificationText(text) || fallback;
    return snippet(cleaned, cfg.privacy === "summary" ? 220 : 1800);
  }

  async function sendWebhook(title: string, body: string, meta: NotificationMeta): Promise<void> {
    const text = cfg.webhookType === "telegram"
      ? formatTelegramMessage(title, body, meta)
      : `${title}\n${body}`;
    switch (cfg.webhookType) {
      case "telegram": {
        const token = cfg.webhookTarget.replace(/\/$/, "");
        const chatId = cfg.webhookChatId;
        if (!token || !chatId) throw new Error("Telegram 未配置");
        await httpPost(`https://api.telegram.org/bot${token}/sendMessage`, {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
        return;
      }
      case "ntfy": {
        const base = normalizeTarget(cfg.webhookTarget, "https://ntfy.sh");
        await httpPost(base, { headers: { Title: title }, body });
        return;
      }
      case "bark": {
        const base = normalizeTarget(cfg.webhookTarget, "https://api.day.app");
        await httpGet(`${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
        return;
      }
      case "serverchan": {
        await httpPost(`https://sctapi.ftqq.com/${cfg.webhookTarget}.send`, {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ title, desp: body }).toString(),
        });
        return;
      }
      case "pushplus": {
        await httpPost("https://www.pushplus.plus/send", {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: cfg.webhookTarget, title, content: body }),
        });
        return;
      }
    }
  }

  async function notifyChannels(title: string, body: string, meta: NotificationMeta): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (cfg.desktop) jobs.push(run("notify-send", ["-a", "Pi", "-u", "normal", title, body]));
    if (cfg.bell) process.stdout.write("\x07");
    if (cfg.osc) notifyOsc(title, body);
    if (cfg.sound) {
      const sound = resolveSoundFile();
      if (sound) jobs.push(run("paplay", [sound]));
    }
    if (cfg.kdeconnect && cfg.deviceId) {
      jobs.push(run("kdeconnect-cli", ["-d", cfg.deviceId, "--ping-msg", `${title}：${body}`]));
    }
    if (cfg.webhook && cfg.webhookTarget) {
      jobs.push(sendWebhook(title, body, meta));
    }
    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[assistant-notify] 通知失败:", result.reason);
      }
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "assistant-notify",
      cfg.enabled ? `通知: 开 (${cfg.mode})` : "通知: 关",
    );
  }

  // ---------- 事件 ----------

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async () => {
    runStartedAt = Date.now();
    runHadAssistant = false;
    lastAssistantText = "";
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    runHadAssistant = true;
    lastAssistantText = assistantText(event.message);

    if (!cfg.enabled) return;
    if (cfg.mode !== "message" && cfg.mode !== "both") return;

    const text = assistantText(event.message);
    if (!needsAttention(text)) return;

    const now = Date.now();
    if (now - lastMessageNotifyAt < 3000) return;
    lastMessageNotifyAt = now;

    await notifyChannels(
      "Pi 需要你的关注",
      notificationBody(text, "assistant 发来一条需要关注的消息"),
      notificationMeta("attention", ctx),
    );
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!cfg.enabled) return;
    if (!runHadAssistant) return;
    if (cfg.mode === "message") return; // message 模式已在提问时通知过

    const now = Date.now();
    const duration = elapsedMs();
    if (duration !== undefined && duration < Math.max(0, cfg.minDurationSeconds) * 1000) return;
    if (now - lastSettledNotifyAt < 3000) return;
    lastSettledNotifyAt = now;

    const body = notificationBody(lastAssistantText, "Pi 已生成回复。");
    await notifyChannels("Pi 已完成", body, notificationMeta("done", ctx));
    updateStatus(ctx);
  });

  // ---------- 命令 ----------

  pi.registerCommand("notify", {
    description: "管理 assistant 通知：/notify [test|on|off|mode|min-duration|privacy|retry|webhook]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const first = (parts[0] ?? "").toLowerCase();
      const second = (parts[1] ?? "").toLowerCase();

      const status = () => {
        const on = (b: boolean) => (b ? "开" : "关");
        ctx.ui.notify(
          `通知: ${on(cfg.enabled)} · 模式: ${cfg.mode}\n规则: 最短 ${cfg.minDurationSeconds}s · 隐私 ${cfg.privacy} · 重试 ${on(cfg.retry)}\n通道: desktop:${on(cfg.desktop)} · bell:${on(cfg.bell)} · osc:${on(cfg.osc)} · webhook:${on(cfg.webhook)}${cfg.webhook ? ` (${cfg.webhookType})` : ""}`,
          "info",
        );
        updateStatus(ctx);
      };

      if (!first) {
        status();
        return;
      }

      switch (first) {
        case "test": {
          await notifyChannels(
            "Pi 通知测试",
            "如果你看到这条通知，说明 assistant-notify 工作正常。",
            notificationMeta("test", ctx),
          );
          ctx.ui.notify("测试通知已发送", "info");
          return;
        }
        case "on":
          cfg.enabled = true;
          saveConfig(cfg);
          status();
          return;
        case "off":
          cfg.enabled = false;
          saveConfig(cfg);
          status();
          return;
        case "mode": {
          if (second === "settled" || second === "message" || second === "both") {
            cfg.mode = second;
            saveConfig(cfg);
          } else {
            ctx.ui.notify("用法: /notify mode settled|message|both", "warning");
            return;
          }
          status();
          return;
        }
        case "min-duration": {
          const seconds = Number(second);
          if (!second || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
            ctx.ui.notify("用法: /notify min-duration <0-86400 秒>", "warning");
            return;
          }
          cfg.minDurationSeconds = Math.round(seconds);
          saveConfig(cfg);
          status();
          return;
        }
        case "privacy": {
          if (second !== "status" && second !== "summary" && second !== "full") {
            ctx.ui.notify("用法: /notify privacy status|summary|full", "warning");
            return;
          }
          cfg.privacy = second;
          saveConfig(cfg);
          status();
          return;
        }
        case "retry": {
          if (second !== "on" && second !== "off") {
            ctx.ui.notify("用法: /notify retry on|off", "warning");
            return;
          }
          cfg.retry = second === "on";
          saveConfig(cfg);
          status();
          return;
        }
        case "devices": {
          try {
            const res = await pi.exec("kdeconnect-cli", ["-a"], { timeout: 5000 });
            const list = (res.stdout || res.stderr || "没有检测到设备").trim();
            ctx.ui.notify(`KDE Connect 设备:\n${list.slice(0, 400)}`, "info");
          } catch {
            ctx.ui.notify("无法获取 KDE Connect 设备列表", "error");
          }
          return;
        }
        case "device": {
          if (!second) {
            ctx.ui.notify("用法: /notify device <deviceId>", "warning");
            return;
          }
          cfg.deviceId = parts.slice(1).join(" ");
          cfg.kdeconnect = true;
          saveConfig(cfg);
          status();
          return;
        }
        case "webhook": {
          if (!second) {
            ctx.ui.notify(
              cfg.webhook
                ? `webhook: 开 · 类型: ${cfg.webhookType} · 凭据: ${cfg.webhookTarget ? "已配置" : "未配置"}${cfg.webhookType === "telegram" ? ` · chat: ${cfg.webhookChatId}` : ""}`
                : "webhook: 关（未配置）",
              "info",
            );
            return;
          }
          if (second === "on") {
            cfg.webhook = true;
            saveConfig(cfg);
            status();
            return;
          }
          if (second === "off") {
            cfg.webhook = false;
            saveConfig(cfg);
            status();
            return;
          }
          if (second === "test") {
            try {
              await sendWebhook(
                "Pi 通知测试",
                "如果你在手机收到这条消息，说明 webhook 推送正常。",
                notificationMeta("test", ctx),
              );
              ctx.ui.notify("webhook 测试已发送", "info");
            } catch (e) {
              ctx.ui.notify(`webhook 测试失败: ${(e as Error).message}`, "error");
            }
            return;
          }
          const type = second as WebhookType;
          if (!["telegram", "ntfy", "bark", "serverchan", "pushplus"].includes(type)) {
            ctx.ui.notify("用法: /notify webhook telegram <bot_token> <chat_id> 或 /notify webhook ntfy|bark|serverchan|pushplus <target>", "warning");
            return;
          }
          const target = parts[2] ?? "";
          if (!target) {
            ctx.ui.notify(type === "telegram" ? "用法: /notify webhook telegram <bot_token> <chat_id>" : `用法: /notify webhook ${type} <target>`, "warning");
            return;
          }
          if (type === "telegram") {
            const chatId = parts[3] ?? "";
            if (!chatId) {
              ctx.ui.notify("用法: /notify webhook telegram <bot_token> <chat_id>\n（chat_id 可用 @userinfobot 查询）", "warning");
              return;
            }
            cfg.webhookChatId = chatId;
          }
          cfg.webhookType = type;
          cfg.webhookTarget = target;
          cfg.webhook = true;
          saveConfig(cfg);
          ctx.ui.notify(`webhook 已配置 (${type}) 并开启，可用 /notify webhook test 验证`, "info");
          updateStatus(ctx);
          return;
        }
        default: {
          const channel = first as Channel;
          if (["desktop", "bell", "osc", "sound", "kdeconnect"].includes(channel)) {
            if (second === "on" || second === "off") {
              (cfg as Record<string, boolean | string>)[channel] = second === "on";
              saveConfig(cfg);
              status();
              return;
            }
          }
          ctx.ui.notify("用法: /notify [test|on|off|mode|min-duration|privacy|retry|webhook|desktop|bell|osc|sound|kdeconnect]", "warning");
          return;
        }
      }
    },
  });
}
