#!/usr/bin/env node
/**
 * 天气查询 MCP server（stdio transport）。
 *
 * 对外暴露两个工具：
 * - `get_weather`：按城市名查当前天气
 * - `get_forecast`：按城市名查未来 N 天预报
 *
 * 数据源用 open-meteo.com 的免费公共 API（无需 API key，结构化 JSON）：
 * - 先调 geocoding API 把 "Beijing" → 纬经度
 * - 再调 forecast API 拿天气
 *
 * 为什么选 open-meteo：
 * - 完全免费、无 auth、无 quota 焦虑
 * - JSON 格式清晰，code/temperature/wind 等字段直接可读
 * - 支持几百个城市，天气 code 有公开映射表
 *
 * 启动方式：这个文件被 lib/mcp/weather-client.ts 通过 stdio spawn 运行。
 * 因为是 stdio transport：日志**必须写 stderr**，不能污染 stdout（MCP 协议占用 stdout）。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * WMO Weather interpretation code → 人类可读文本。
 * 参考 open-meteo 文档：https://open-meteo.com/en/docs
 */
const WEATHER_CODES: Record<number, string> = {
  0: "晴朗",
  1: "大部晴朗",
  2: "局部多云",
  3: "阴天",
  45: "雾",
  48: "冻雾",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "中阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};

type GeocodingResult = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  timezone?: string;
};

async function geocode(city: string): Promise<GeocodingResult | null> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", city);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`geocoding failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { results?: GeocodingResult[] };
  return data.results?.[0] ?? null;
}

async function fetchCurrentWeather(lat: number, lon: number) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m",
  );
  url.searchParams.set("timezone", "auto");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`forecast failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as {
    current: {
      time: string;
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      weather_code: number;
      wind_speed_10m: number;
      wind_direction_10m: number;
    };
    current_units: Record<string, string>;
    timezone: string;
  };
}

async function fetchForecast(lat: number, lon: number, days: number) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
  );
  url.searchParams.set("forecast_days", String(days));
  url.searchParams.set("timezone", "auto");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`forecast failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as {
    daily: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
    };
    daily_units: Record<string, string>;
    timezone: string;
  };
}

const server = new Server(
  { name: "weather-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// 列工具：客户端（AI SDK 的 MCP client）启动时会先问一次 tools/list。
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_weather",
      description:
        "查询指定城市当前的天气状况。支持中英文城市名，会返回温度、体感温度、湿度、风速、天气描述。",
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
        "查询指定城市未来 N 天（1-7 天）的天气预报。返回每天的最高/最低温度、降水量、天气描述。",
      inputSchema: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "城市名",
          },
          days: {
            type: "number",
            description: "预报天数，1-7，默认 3",
            minimum: 1,
            maximum: 7,
          },
        },
        required: ["city"],
      },
    },
  ],
}));

// 调用工具：LLM 决定调哪个工具后，AI SDK 的 MCP client 会发 tools/call 过来。
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

      const geo = await geocode(city);
      if (!geo) {
        return {
          content: [{ type: "text", text: `找不到城市：${city}` }],
          isError: true,
        };
      }

      const weather = await fetchCurrentWeather(geo.latitude, geo.longitude);
      const c = weather.current;
      const u = weather.current_units;
      const condition = WEATHER_CODES[c.weather_code] ?? `code ${c.weather_code}`;
      const location = [geo.name, geo.admin1, geo.country]
        .filter(Boolean)
        .join(", ");

      const text = [
        `📍 ${location}（${weather.timezone}）`,
        `🕐 ${c.time}`,
        `🌡️  ${c.temperature_2m}${u.temperature_2m}（体感 ${c.apparent_temperature}${u.apparent_temperature}）`,
        `☁️  ${condition}`,
        `💧 湿度 ${c.relative_humidity_2m}${u.relative_humidity_2m}`,
        `🌬️  风速 ${c.wind_speed_10m} ${u.wind_speed_10m}（${c.wind_direction_10m}°）`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }

    if (name === "get_forecast") {
      const city = String((args as { city?: unknown })?.city ?? "").trim();
      const rawDays = (args as { days?: unknown })?.days;
      const days = Math.max(
        1,
        Math.min(7, typeof rawDays === "number" ? rawDays : 3),
      );

      if (!city) {
        return {
          content: [{ type: "text", text: "缺少参数 city。" }],
          isError: true,
        };
      }

      const geo = await geocode(city);
      if (!geo) {
        return {
          content: [{ type: "text", text: `找不到城市：${city}` }],
          isError: true,
        };
      }

      const forecast = await fetchForecast(geo.latitude, geo.longitude, days);
      const d = forecast.daily;
      const u = forecast.daily_units;
      const location = [geo.name, geo.admin1, geo.country]
        .filter(Boolean)
        .join(", ");

      const rows = d.time.map((date, i) => {
        const cond =
          WEATHER_CODES[d.weather_code[i]] ?? `code ${d.weather_code[i]}`;
        return `${date}: ${cond} · ${d.temperature_2m_min[i]}~${d.temperature_2m_max[i]}${u.temperature_2m_max} · 降水 ${d.precipitation_sum[i]}${u.precipitation_sum}`;
      });

      const text = [
        `📍 ${location}（${forecast.timezone}）未来 ${days} 天：`,
        ...rows,
      ].join("\n");

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
