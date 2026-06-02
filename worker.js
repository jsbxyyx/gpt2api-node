/**
 * Cloudflare Worker - ChatGPT (Codex) 代理
 *
 * 所需环境变量（在 Cloudflare Worker 设置中配置）:
 *   DB_URL    - Supabase 项目 URL，例如 https://xxxx.supabase.co
 *   DB_APIKEY - Supabase anon/service_role key
 *   API_KEY   - （可选）访问此代理所需的 ******
 *
 * 建表语句（在 Supabase SQL 编辑器中执行）:
 *
 *   CREATE TABLE gpt_tokens (
 *     id              serial          PRIMARY KEY,
 *     email           text,
 *     account_id      text,
 *     access_token    text,
 *     refresh_token   text,
 *     id_token        text,
 *     expired_at      timestamptz,
 *     last_refresh_at timestamptz,
 *     is_active       boolean         NOT NULL DEFAULT true,
 *     type            text            NOT NULL DEFAULT 'codex'
 *   );
 *
 *   CREATE TABLE gpt_api_keys (
 *     id        serial  PRIMARY KEY,
 *     key       text    NOT NULL UNIQUE,
 *     is_active boolean NOT NULL DEFAULT true
 *   );
 *
 * 部署方式（不使用 wrangler）:
 *   直接将本文件内容粘贴到 Cloudflare Workers 编辑器即可。
 */

// ──────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_CLIENT_VERSION = '0.101.0';
const CODEX_USER_AGENT =
  'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const MODELS = [
  { id: 'gpt-5.3-codex', object: 'model', created: 1770307200, owned_by: 'openai' },
  { id: 'gpt-5.2-codex', object: 'model', created: 1765440000, owned_by: 'openai' },
];

// ──────────────────────────────────────────────────────────────
// 数据库操作（Supabase REST API）
// ──────────────────────────────────────────────────────────────
async function db_select(db_url, apikey, table, where) {
  const res = await fetch(
    db_url + '/rest/v1/' + table + '?' + new URLSearchParams(where),
    {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        apikey: apikey,
        Authorization: 'Bearer ' + apikey,
      },
    }
  );
  return res.json();
}

async function db_insert(db_url, apikey, table, data) {
  await fetch(db_url + '/rest/v1/' + table, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: apikey,
      Authorization: 'Bearer ' + apikey,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(data),
  });
}

async function db_update(db_url, apikey, table, data, where) {
  await fetch(
    db_url + '/rest/v1/' + table + '?' + new URLSearchParams(where),
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        apikey: apikey,
        Authorization: 'Bearer ' + apikey,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(data),
    }
  );
}

async function db_delete(db_url, apikey, table, where) {
  await fetch(
    db_url + '/rest/v1/' + table + '?' + new URLSearchParams(where),
    {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        apikey: apikey,
        Authorization: 'Bearer ' + apikey,
      },
    }
  );
}

// ──────────────────────────────────────────────────────────────
// Token 管理
// ──────────────────────────────────────────────────────────────

// 简单轮询计数器（Worker 实例内有效）
let _roundRobinIndex = 0;

/**
 * 从数据库取一个活跃 token（轮询）
 */
async function getActiveToken(db_url, apikey) {
  const tokens = await db_select(db_url, apikey, 'gpt_tokens', {
    is_active: 'eq.true',
    select: 'id,email,account_id,access_token,refresh_token,id_token,expired_at,last_refresh_at,type',
  });

  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error('没有可用的活跃 Token');
  }

  const token = tokens[_roundRobinIndex % tokens.length];
  _roundRobinIndex = (_roundRobinIndex + 1) % tokens.length;
  return token;
}

/**
 * 判断 token 是否在 5 分钟内过期
 */
function isExpired(token) {
  if (!token.expired_at) return true;
  return new Date(token.expired_at).getTime() - Date.now() < 5 * 60 * 1000;
}

/**
 * 刷新 access_token 并更新数据库
 */
async function refreshToken(db_url, apikey, token) {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    scope: 'openid profile email',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token 刷新失败 (${res.status}): ${body}`);
  }

  const { access_token, refresh_token, id_token, expires_in } = await res.json();
  const now = new Date();
  const expired_at = new Date(now.getTime() + expires_in * 1000).toISOString();

  const updated = {
    ...token,
    access_token,
    refresh_token: refresh_token || token.refresh_token,
    id_token: id_token || token.id_token,
    expired_at,
    last_refresh_at: now.toISOString(),
  };

  // 写回数据库（不阻塞主流程，但我们这里等待确保一致性）
  await db_update(db_url, apikey, 'gpt_tokens', {
    access_token: updated.access_token,
    refresh_token: updated.refresh_token,
    id_token: updated.id_token,
    expired_at: updated.expired_at,
    last_refresh_at: updated.last_refresh_at,
  }, { id: 'eq.' + token.id });

  return updated;
}

/**
 * 获取有效的 access_token（自动刷新）
 */
async function getValidAccessToken(db_url, apikey) {
  let token = await getActiveToken(db_url, apikey);
  if (isExpired(token)) {
    token = await refreshToken(db_url, apikey, token);
  }
  return token.access_token;
}

// ──────────────────────────────────────────────────────────────
// 请求 / 响应格式转换
// ──────────────────────────────────────────────────────────────

/**
 * OpenAI chat completions 格式 → Codex responses 格式
 */
function transformRequest(openaiRequest) {
  const { model, messages, stream = true, ...rest } = openaiRequest;

  let instructions = '';
  const userMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const content = Array.isArray(msg.content)
        ? msg.content.map((c) => c.text || c).join('\n')
        : msg.content;
      instructions += (instructions ? '\n' : '') + content;
    } else {
      userMessages.push(msg);
    }
  }

  const input = userMessages.map((msg) => {
    const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';
    return {
      type: 'message',
      role: msg.role,
      content: Array.isArray(msg.content)
        ? msg.content.map((c) => {
            if (c.type === 'text') return { type: contentType, text: c.text || c };
            if (c.type === 'image_url')
              return { type: 'input_image', image_url: c.image_url?.url || c.image_url };
            return c;
          })
        : [{ type: contentType, text: msg.content }],
    };
  });

  const codexRequest = {
    model: model || 'gpt-5.3-codex',
    input,
    instructions: instructions || '',
    stream,
    store: false,
  };

  if (rest.temperature !== undefined) codexRequest.temperature = rest.temperature;
  if (rest.max_tokens !== undefined) codexRequest.max_tokens = rest.max_tokens;
  if (rest.top_p !== undefined) codexRequest.top_p = rest.top_p;

  return codexRequest;
}

/**
 * 将单行 SSE 数据（来自 Codex）转换为 OpenAI 格式的 SSE 行
 * 返回字符串或 null（忽略此行）
 */
function transformStreamLine(line, model, state) {
  if (!line.startsWith('data:')) return null;

  const data = line.slice(5).trim();
  if (data === '[DONE]') return 'data: [DONE]\n\n';

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (parsed.type === 'response.created') {
    state.responseId = parsed.response?.id;
    state.createdAt = parsed.response?.created_at || Math.floor(Date.now() / 1000);
    state.model = parsed.response?.model || model;
    return null;
  }

  const id = state.responseId || 'chatcmpl-' + Date.now();
  const created = state.createdAt || Math.floor(Date.now() / 1000);
  const modelName = state.model || model;

  if (parsed.type === 'response.output_text.delta') {
    return (
      'data: ' +
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [
          { index: 0, delta: { role: 'assistant', content: parsed.delta || '' }, finish_reason: null },
        ],
      }) +
      '\n\n'
    );
  }

  if (parsed.type === 'response.reasoning_summary_text.delta') {
    return (
      'data: ' +
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: parsed.delta || '' },
            finish_reason: null,
          },
        ],
      }) +
      '\n\n'
    );
  }

  if (parsed.type === 'response.completed') {
    const usage = parsed.response?.usage || {};
    return (
      'data: ' +
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens || 0,
        },
      }) +
      '\n\n'
    );
  }

  return null;
}

/**
 * 从 Codex 非流式响应（包含多行 SSE）中提取 OpenAI 格式结果
 */
function transformNonStreamResponse(rawText, model) {
  for (const line of rawText.split('\n')) {
    if (!line.trim().startsWith('data:')) continue;
    const data = line.slice(5).trim();
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed.type !== 'response.completed') continue;

    const response = parsed.response || {};
    const output = response.output || [];
    let content = '';
    for (const item of output) {
      if (item.type === 'message' && item.content) {
        for (const part of item.content) {
          if (part.type === 'output_text') content += part.text || '';
        }
      }
    }
    const usage = response.usage || {};
    return {
      id: response.id || 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      },
    };
  }
  throw new Error('未收到完整响应（response.completed 事件缺失）');
}

// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────

function generateSessionId() {
  return crypto.randomUUID();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message, status = 500, type = 'proxy_error') {
  return jsonResponse({ error: { message, type, code: status } }, status);
}

// ──────────────────────────────────────────────────────────────
// 认证
// ──────────────────────────────────────────────────────────────

/**
 * 若 API_KEY 环境变量已设置，则校验请求头中的 ******
 */
async function authenticate(request, env) {
  if (!env.API_KEY) return true; // 未配置则不鉴权

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (token === env.API_KEY) return true;

  // 也可以从数据库 api_keys 表校验
  if (env.DB_URL && env.DB_APIKEY) {
    const rows = await db_select(env.DB_URL, env.DB_APIKEY, 'gpt_api_keys', {
      key: 'eq.' + token,
      is_active: 'eq.true',
    });
    if (Array.isArray(rows) && rows.length > 0) return true;
  }

  return false;
}

// ──────────────────────────────────────────────────────────────
// 代理处理
// ──────────────────────────────────────────────────────────────

async function handleChatCompletions(request, env) {
  // 鉴权
  const authed = await authenticate(request, env);
  if (!authed) return errorResponse('Unauthorized', 401, 'auth_error');

  if (!env.DB_URL || !env.DB_APIKEY) {
    return errorResponse('DB_URL 和 DB_APIKEY 环境变量未配置', 500, 'config_error');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('无效的请求体', 400, 'invalid_request');
  }

  const model = body.model || 'gpt-5.3-codex';
  const isStream = body.stream === true;

  let accessToken;
  try {
    accessToken = await getValidAccessToken(env.DB_URL, env.DB_APIKEY);
  } catch (e) {
    return errorResponse(e.message, 503, 'token_error');
  }

  const codexRequest = transformRequest({ ...body, stream: isStream });

  const upstream = await fetch(`${CODEX_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': CODEX_USER_AGENT,
      Version: CODEX_CLIENT_VERSION,
      'Openai-Beta': 'responses=experimental',
      Session_id: generateSessionId(),
      Accept: isStream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(codexRequest),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    return errorResponse(text || '上游请求失败', upstream.status);
  }

  // ── 流式响应 ──
  if (isStream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // 在后台处理上游流
    (async () => {
      const reader = upstream.body.getReader();
      const state = {};
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            const out = transformStreamLine(line, model, state);
            if (out) await writer.write(encoder.encode(out));
          }
        }

        // 处理剩余缓冲区
        if (buffer.trim()) {
          const out = transformStreamLine(buffer, model, state);
          if (out) await writer.write(encoder.encode(out));
        }

        // 确保发送 [DONE]
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        await writer.write(
          encoder.encode(
            'data: ' +
              JSON.stringify({ error: { message: e.message, type: 'stream_error' } }) +
              '\n\n'
          )
        );
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // ── 非流式响应 ──
  const rawText = await upstream.text();
  try {
    const result = transformNonStreamResponse(rawText, model);
    return jsonResponse(result);
  } catch (e) {
    return errorResponse(e.message, 502, 'upstream_error');
  }
}

// ──────────────────────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, method } = { pathname: url.pathname, method: request.method };

    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 路由
    if (pathname === '/v1/chat/completions' && method === 'POST') {
      return handleChatCompletions(request, env);
    }

    if (pathname === '/v1/models' && method === 'GET') {
      return jsonResponse({ object: 'list', data: MODELS });
    }

    if (pathname === '/health' && method === 'GET') {
      return jsonResponse({ status: 'ok' });
    }

    return errorResponse('Not Found', 404, 'not_found');
  },
};
