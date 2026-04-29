export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const period = body.period || "全部数据";
    const data = Array.isArray(body.data) ? body.data : [];

    const cacheKey = await createCacheKey(period, data);

    const cached = await env.AI_CACHE.get(cacheKey);
    if (cached) {
      return Response.json({
        source: "cache",
        analysis: cached
      });
    }

    const prompt = `
你是电力市场数据分析助手。
请根据以下数据生成一段适合放在数据分析平台顶部的简洁分析。
要求：
1. 不要编造数据；
2. 重点分析成交电量、电价变化趋势；
3. 文字控制在120字以内；
4. 语言正式、清楚；
5. 只输出分析文字，不要输出标题。

分析时段：${period}
数据：${JSON.stringify(data)}
`;

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: prompt
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      return Response.json(
        {
          source: "error",
          analysis: "AI 分析暂不可用，请稍后重试。",
          error: errorText
        },
        { status: 500 }
      );
    }

    const result = await aiResponse.json();
    const analysis = result.output_text || "暂无分析结果。";

    await env.AI_CACHE.put(cacheKey, analysis, {
      expirationTtl: 60 * 60 * 24 * 7
    });

    return Response.json({
      source: "ai",
      analysis
    });
  } catch (error) {
    return Response.json(
      {
        source: "error",
        analysis: "AI 分析接口异常，请稍后重试。",
        error: String(error)
      },
      { status: 500 }
    );
  }
}

async function createCacheKey(period, data) {
  const raw = JSON.stringify({ period, data });
  const bytes = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return `analysis:${hash}`;
}
