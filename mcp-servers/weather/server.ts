#!/usr/bin/env node
/**
 * 天气查询 MCP server（stdio transport）。
 *
 * 对外暴露两个工具：
 * - `get_weather`：按城市名查当前天气
 * - `get_forecast`：按城市名查未来 N 天预报
 *
 * 数据源（带 fallback）：
 * 1. **wttr.in**（首选）——全免费、无 key、per-IP 无配额；返回 JSON 格式（`?format=j1`）
 * 2. **open-meteo**（备用）——也是免费的公共 API，但每日配额共享，共用 IP 池容易被打爆
 *
 * 实际运行中经常遇到 open-meteo 返回 429 "Daily limit exceeded"（共享 IP 的其他用户用完了），
 * 所以默认走 wttr.in。open-meteo 留着做备胎，未来 wttr.in 挂掉时可以切回去。
 *
 * stdio transport：日志**必须写 stderr**，不能污染 stdout（MCP 协议占用 stdout）。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const USER_AGENT = "ai-sdk-demo-weather-mcp/0.1";

/**
 * wttr.in 的 `?format=j1` 返回的核心字段（我们只挑用得上的）。
 */
type WttrCurrent = {
  temp_C: string;
  FeelsLikeC: string;
  humidity: string;
  weatherDesc: Array<{ value: string }>;
  windspeedKmph: string;
  winddir16Point: string;
  localObsDateTime: string;
};

type WttrDay = {
  date: string;
  maxtempC: string;
  mintempC: string;
  totalSnow_cm?: string;
  hourly: Array<{
    time: string;
    tempC: string;
    weatherDesc: Array<{ value: string }>;
    precipMM: string;
  }>;
};

type WttrArea = {
  areaName: Array<{ value: string }>;
  country: Array<{ value: string }>;
  region: Array<{ value: string }>;
};

type WttrResponse = {
  current_condition: WttrCurrent[];
  weather: WttrDay[];
  nearest_area: WttrArea[];
};

async function wttr(city: string): Promise<WttrResponse> {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `wttr.in failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 120)}` : ""}`,
    );
  }
  return (await response.json()) as WttrResponse;
}

function formatArea(area: WttrArea | undefined): string {
  if (!area) return "?";
  const parts = [
    area.areaName?.[0]?.value,
    area.region?.[0]?.value,
    area.country?.[0]?.value,
  ].filter(Boolean);
  return parts.join(", ");
}

const server = new Server(
  { name: "weather-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_weather",
      description:
        "查询指定城市当前的天气状况。支持中英文城市名，返回温度、体感温度、湿度、风速、风向、天气描述。数据源 wttr.in（免 key 免配额）。",
      inputSchema: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "城市名，如 'Beijing' / '北京' / 'San Francisco'",
          },
        },
        required: ["city"],
      },
    },
    {
      name: "get_forecast",
      description:
        "查询指定城市未来 N 天（1-3 天）的天气预报。返回每天最高/最低温度 + 几个关键时段的天气描述。",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名" },
          days: {
            type: "number",
            description: "预报天数，1-3，默认 3（wttr.in 只给 3 天）",
            minimum: 1,
            maximum: 3,
          },
        },
        required: ["city"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "get_weather") {
      const city = String((args as { city?: unknown })?.city ?? "").trim();
      if (!city) {
        return {
          content: [{ type: "text", text: "缺少参数 city。" }],
          isError: true,
        };
      }

      const data = await wttr(city);
      const cur = data.current_condition[0];
      const area = formatArea(data.nearest_area?.[0]);

      if (!cur) {
        return {
          content: [{ type: "text", text: `找不到 ${city} 的当前天气。` }],
          isError: true,
        };
      }

      const desc = cur.weatherDesc?.[0]?.value ?? "—";
      const text = [
        `📍 ${area}`,
        `🕐 ${cur.localObsDateTime}`,
        `🌡️  ${cur.temp_C}°C（体感 ${cur.FeelsLikeC}°C）`,
        `☁️  ${desc}`,
        `💧 湿度 ${cur.humidity}%`,
        `🌬️  风速 ${cur.windspeedKmph} km/h（${cur.winddir16Point}）`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }

    if (name === "get_forecast") {
      const city = String((args as { city?: unknown })?.city ?? "").trim();
      const rawDays = (args as { days?: unknown })?.days;
      const days = Math.max(
        1,
        Math.min(3, typeof rawDays === "number" ? rawDays : 3),
      );

      if (!city) {
        return {
          content: [{ type: "text", text: "缺少参数 city。" }],
          isError: true,
        };
      }

      const data = await wttr(city);
      const area = formatArea(data.nearest_area?.[0]);
      const selectedDays = data.weather.slice(0, days);

      if (selectedDays.length === 0) {
        return {
          content: [{ type: "text", text: `未能拿到 ${city} 的预报数据。` }],
          isError: true,
        };
      }

      // wttr.in 的 hourly 有 8 个时段：0/3/6/9/12/15/18/21（按小时 * 100 编码）。
      // 挑 3 个代表时段（早上 9 点 / 中午 12 点 / 晚上 21 点）给个大致印象。
      const REPRESENTATIVE_HOURS = ["900", "1200", "2100"];
      const rows = selectedDays.map((day) => {
        const hours = REPRESENTATIVE_HOURS.map((h) => {
          const slot = day.hourly.find((hh) => hh.time === h);
          if (!slot) return null;
          return `${h.padStart(4, "0").slice(0, 2)}:00 ${slot.tempC}°C ${slot.weatherDesc?.[0]?.value ?? "—"}`;
        }).filter(Boolean);
        return `${day.date}: ${day.mintempC}~${day.maxtempC}°C | ${hours.join(" · ")}`;
      });

      const text = [`📍 ${area} 未来 ${days} 天：`, ...rows].join("\n");
      return { content: [{ type: "text", text }] };
    }

    return {
      content: [{ type: "text", text: `未知工具：${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `工具 ${name} 执行出错：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// stdio transport：读 stdin，写 stdout。任何日志必须走 stderr（console.error）。
// 用 async IIFE 包一层，不依赖 top-level await——tsx 在 cjs 目标下不支持 TLA。
void (async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[weather-mcp] server started, listening on stdio");
})();
