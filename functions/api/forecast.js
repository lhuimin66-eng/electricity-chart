export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const period = body.period || "最新时间段";
    const data = Array.isArray(body.data) ? body.data : [];

    const cacheKey = await createCacheKey(period, data);

    const cached = await env.AI_CACHE.get(cacheKey);
    if (cached) {
      return Response.json({
        source: "cache",
        ...JSON.parse(cached)
      });
    }

    const forecast = buildForecast(data);
    const summary = await buildSummary(env, period, data, forecast);

    const responseData = {
      forecast,
      summary: "【forecast-v6】" + summary
    };

    await env.AI_CACHE.put(cacheKey, JSON.stringify(responseData), {
      expirationTtl: 60 * 60 * 24 * 7
    });

    return Response.json({
      source: "ai",
      ...responseData
    });
  } catch (error) {
    return Response.json(
      {
        source: "error",
        forecast: [],
        summary: "AI 预测接口异常，请稍后重试。",
        error: String(error)
      },
      { status: 500 }
    );
  }
}

function buildForecast(data) {
  const recent = data.slice(-15);
  const lastDate = recent.at(-1)?.日期 || "4.30";
  const dates = getNextDates(lastDate, 15);

  const genValues = recent.map(i => toNumber(i["发电侧总成交量（MWh）"])).filter(v => v !== null);
  const userValues = recent.map(i => toNumber(i["用户侧总成交量（MWh)"])).filter(v => v !== null);
  const priceValues = recent.map(i => toNumber(i["用户侧总平均价（元/MWh）"])).filter(v => v !== null);

const genForecast = forecastSeries(genValues, 15, 0.04, 0.015);
const userForecast = forecastSeries(userValues, 15, 0.04, 0.015);
const priceForecast = forecastPriceSeries(priceValues, 15);

  return dates.map((date, index) => ({
    date,
    genVolume: round(genForecast[index], 3),
    userVolume: round(userForecast[index], 3),
    avgPrice: round(priceForecast[index], 2)
  }));
}

function forecastSeries(values, count, maxStepRate = 0.04, waveRate = 0.015) {
  if (!values.length) return Array(count).fill(null);

  const avg = average(values);
  const last = values.at(-1);
  const diffs = [];

  for (let i = 1; i < values.length; i++) {
    diffs.push(values[i] - values[i - 1]);
  }

  let trend = diffs.length ? average(diffs) : 0;

  if (Math.abs(trend) < Math.abs(avg) * 0.0008) {
    trend = avg * 0.001;
  }

  const maxStep = Math.abs(avg) * maxStepRate;
  trend = clamp(trend, -maxStep, maxStep);

  const result = [];

  for (let i = 1; i <= count; i++) {
    const seasonalWave = Math.sin(i / 2.8) * Math.abs(avg) * waveRate;
    const microWave = Math.cos(i / 1.9) * Math.abs(avg) * waveRate * 0.45;
    const value = last + trend * i + seasonalWave + microWave;
    const min = avg * 0.92;
    const max = avg * 1.08;

    result.push(clamp(value, min, max));
  }

  return result;
}
function forecastPriceSeries(values, count) {
  const cleanValues = values
    .map(toNumber)
    .filter(v => v !== null && Number.isFinite(v));

  if (!cleanValues.length) {
    return Array(count).fill(null);
  }

  const avg = average(cleanValues);
  const last = cleanValues.at(-1);

  let trend = 0;

  if (cleanValues.length >= 2) {
    const firstHalf = cleanValues.slice(0, Math.ceil(cleanValues.length / 2));
    const secondHalf = cleanValues.slice(Math.floor(cleanValues.length / 2));

    trend = (average(secondHalf) - average(firstHalf)) / count;
  }

  if (Math.abs(trend) < 0.18) {
    trend = last >= avg ? 0.22 : -0.22;
  }

  trend = clamp(trend, -0.7, 0.7);

  const result = [];

  for (let i = 1; i <= count; i++) {
    const wave = Math.sin(i * 0.9) * 1.8;
    const smallWave = Math.cos(i * 1.35) * 0.9;
    const dayOffset = ((i % 5) - 2) * 0.28;

    const value = last + trend * i + wave + smallWave + dayOffset;
    const min = avg - 12;
    const max = avg + 12;

    result.push(clamp(value, min, max));
  }

  return result;
}
async function buildSummary(env, period, data, forecast) {
  try {
    if (!env.AI) {
      return defaultSummary();
    }

    const prompt = `
你是电力市场数据分析助手。
请根据最近十五日实际数据和未来十五日简单趋势预测，生成一句简洁说明。
要求：
1. 文字控制在100字以内；
2. 不要夸大预测准确性；
3. 明确这是基于近期数据的趋势参考；
4. 不要使用 Markdown。

分析时段：${period}
最近十五日数据：${JSON.stringify(data)}
预测结果：${JSON.stringify(forecast)}
`;

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        {
          role: "system",
          content: "你是专业的电力市场数据分析助手。"
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    return result.response || result.result || result.text || defaultSummary();
  } catch (error) {
    return defaultSummary();
  }
}

function defaultSummary() {
  return "基于最近十五日成交电量与电价变化进行简单趋势外推，预测结果仅供趋势参考。";
}

function getNextDates(lastDate, count) {
  const [month, day] = lastDate.split(".").map(Number);
  const base = new Date(2026, month - 1, day);
  const dates = [];

  for (let i = 1; i <= count; i++) {
    const next = new Date(base);
    next.setDate(base.getDate() + i);
    dates.push(`${next.getMonth() + 1}.${next.getDate()}`);
  }

  return dates;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  if (value === null || value === undefined) return null;
  return Math.min(Math.max(value, min), max);
}

function round(value, digits) {
  if (value === null || value === undefined) return null;
  return Number(value.toFixed(digits));
}

async function createCacheKey(period, data) {
  const raw = JSON.stringify({
    type: "forecast-v6",
    period,
    data
  });

  const bytes = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return `forecast:${hash}`;
}
