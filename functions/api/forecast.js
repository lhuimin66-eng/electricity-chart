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

    const prompt = `
你是电力市场数据趋势预测助手。
请根据用户提供的最近十五日交易数据，简单预测未来十五日趋势。

要求：
1. 只基于已提供数据做趋势外推，不要声称使用了天气、往年数据或外部数据；
2. 预测指标包括：发电侧成交电量、用户侧成交电量、用户侧平均电价；
3. 预测结果用于数据平台展示，仅供趋势参考；
4. 未来十五日预测值应围绕最近十五日均值上下波动，不要出现离谱跳变；
5. 如果最近十五日整体上升，可适度上调；如果下降，可适度下调；如果波动不明显，则保持平稳小幅波动；
6. 单日变化幅度尽量控制在最近均值的10%以内；
7. 必须只返回 JSON，不要返回 Markdown，不要解释过程。

返回格式必须严格如下：
{
  "forecast": [
    {
      "date": "5.1",
      "genVolume": 12345.67,
      "userVolume": 12345.67,
      "avgPrice": 380.12
    }
  ],
  "summary": "预计未来十五日..."
}

分析时段：${period}
最近十五日数据：${JSON.stringify(data)}
`;

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: prompt,
        temperature: 0.3
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      return Response.json(
        {
          source: "error",
          forecast: [],
          summary: "AI 预测暂不可用，请稍后重试。",
          error: errorText
        },
        { status: 500 }
      );
    }

    const result = await aiResponse.json();
    const text = result.output_text || "";

    const parsed = parseJsonFromText(text);

    if (!parsed || !Array.isArray(parsed.forecast)) {
      return Response.json(
        {
          source: "error",
          forecast: [],
          summary: "AI 预测结果格式异常，请稍后重试。",
          raw: text
        },
        { status: 500 }
      );
    }

    const responseData = {
      forecast: parsed.forecast.slice(0, 15),
      summary: parsed.summary || "预测结果仅供趋势参考。"
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

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch (err) {
      return null;
    }
  }
}

async function createCacheKey(period, data) {
  const raw = JSON.stringify({
    type: "forecast",
    period,
    data
  });

  const bytes = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return `forecast:${hash}`;
}
