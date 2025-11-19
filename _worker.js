// 文件路径: functions/_worker.js

const TELEGRAM_BOT_TOKEN = '8437310331:AAGJLFRLtFSLBwMfJ6Pb2yDQy-Xa5uE99HU';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const WEBSITE_URL_CONST = 'https://zhijiesou-top-tg.skka3134.workers.dev';

// 🔴 虽然 HTML 里也有一份，但为了 Telegram Bot 的按钮，这里也需要留一份
const ADS_CONFIG = [
  {
    'text': "📱 流量卡办理",
    'url': "https://h5.lot-ml.com/ProductEn/Index/70fedaf6239f2173"
  },
  {
    'text': "✈️ 机场推荐",
    'url': "https://naiixi.com/signupbyemail.aspx?MemberCode=b2f3ab200e774fd5b921e274669c900420251030144409"
  }
];

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const path = url.pathname;
    const currentOrigin = WEBSITE_URL_CONST || url.origin;

    // 1. 首页及静态资源：交给 Cloudflare Pages 系统自动处理
    // 当请求 / 或 index.html 或 /favicon.ico 时，env.ASSETS.fetch 会去读取你上传的 index.html
    if (path === '/' || path === '/index.html' || path.startsWith('/assets/')) {
      return env.ASSETS.fetch(request);
    }
    
    // 2. API 和 Bot 逻辑（拦截）
    if (path === '/bot/set-webhook') {
      return await registerWebhook(currentOrigin);
    }
    if (path === '/api/search') {
      return handleApiSearch(request, env, currentOrigin);
    }
    if (request.method === 'POST' && path === '/bot/webhook') {
      return handleTelegramUpdate(request, env, currentOrigin);
    }

    // 3. 短链接跳转逻辑 (排除点号文件，如 .txt, .png)
    // 如果不是 API 且不包含点号，假设是短链 ID
    if (path.length > 1 && !path.includes('.')) {
        // 先尝试按短链处理
        const redirectResp = await handleRedirectRequest(request, env, context);
        // 如果短链处理返回了 302 跳转，就返回跳转
        if (redirectResp.status === 302) {
            return redirectResp;
        }
        // 如果数据库里没找到这个短链 (404)，则回退给 Pages 尝试寻找是否有同名静态文件
        // 比如你有一个文件叫 /about，不是短链，那应该显示页面
        return env.ASSETS.fetch(request); 
    }

    // 4. 其他情况（如 404），交给 Pages 处理（显示默认 404 页面）
    return env.ASSETS.fetch(request);
  },
};

// ================= 以下逻辑函数保持原样，直接复制即可 =================
// (此处为了节省篇幅，下面的 searchDatabase, handleApiSearch, registerWebhook 等
//  所有辅助函数与你之前提供的代码完全一致，不需要修改，直接粘贴在 export default 后面)

async function handleStaticAssets(request, env, path) { /* ...保留代码... */ } // 其实这个函数在 env.ASSETS 模式下用处不大了，但留着兼容 R2 也行
async function searchDatabase(query, page, env, originUrl) {
    if (!env.DB) return { success: false, error: "Database binding not found" };
    const pageSize = 10;
    const minQueryLength = 2;
    const maxQueryLength = 100;
    if (!query || query.trim().length === 0) return { success: false, error: "关键词不能为空" };
    if (query.length < minQueryLength || query.length > maxQueryLength) {
        return { success: false, error: `关键词长度限制 ${minQueryLength}-${maxQueryLength}` };
    }
    try {
        const keywords = processQueryLikePython(query);
        if (keywords.length === 0 || keywords.length > 100) {
             return { success: false, error: "无法提取有效关键词" };
        }
        const ftsQuery = keywords.map(kw => {
            if (/^[a-zA-Z0-9]+$/.test(kw)) {
                return kw + '*';
            } else {
                return `"${kw}"`;
            }
        }).join(' OR ');
        const offset = (page - 1) * pageSize;
        const countSql = `SELECT count(*) as total FROM resource_fts WHERE title MATCH ?1;`;
        const countStmt = env.DB.prepare(countSql).bind(ftsQuery);
        const countResult = await countStmt.first();
        const total = countResult ? countResult.total : 0;
        let processedResults = [];
        if (total > 0 && offset < total) {
            const idsSql = `SELECT rowid FROM resource_fts WHERE title MATCH ?1 ORDER BY rank LIMIT ?2 OFFSET ?3;`;
            const idsStmt = env.DB.prepare(idsSql).bind(ftsQuery, pageSize, offset);
            const idsResult = await idsStmt.all();
            if (idsResult.results && idsResult.results.length > 0) {
                const ids = idsResult.results.map(r => String(r.rowid));
                const placeholders = ids.map(() => '?').join(',');
                const dataSql = `
                    SELECT rowid as id, title_raw, short_url, drive_type
                    FROM resource WHERE rowid IN (${placeholders});
                `;
                const dataStmt = env.DB.prepare(dataSql).bind(...ids);
                const { results } = await dataStmt.all();
                const resultsMap = new Map(results.map(r => [r.id.toString(), r]));
                processedResults = ids.map(id => resultsMap.get(id)).filter(Boolean).map(r => ({
                    title: r.title_raw || '',
                    short_url: `${originUrl}/${r.short_url}`,
                    drive_type: r.drive_type
                }));
            }
        }
        const totalPages = Math.ceil(total / pageSize);
        return {
            success: true,
            data: processedResults,
            pagination: {
                page: page,
                pageSize: pageSize,
                total: total,
                totalPages: totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1
            }
        };
    } catch (e) {
        console.error("D1 Database Error:", e);
        return { success: false, error: "数据库查询执行失败", details: e.message };
    }
}
async function handleApiSearch(request, env, originUrl) {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) {
        return new Response(JSON.stringify({ success: false, error: "缺少参数 q" }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }
    const result = await searchDatabase(query, page, env, originUrl);
    return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
async function registerWebhook(workerOrigin) {
  const webhookUrl = `${workerOrigin}/bot/webhook`;
  const targetUrl = `${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
  try {
    const response = await fetch(targetUrl);
    const result = await response.json();
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(`Error setting webhook: ${e.message}`, { status: 500 });
  }
}
async function handleTelegramUpdate(request, env, originUrl) {
  try {
    const update = await request.json();
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env, originUrl);
      return new Response('OK');
    }
    if (update.message && update.message.text) {
      await handleBotMessage(update.message, env, originUrl);
      return new Response('OK');
    }
  } catch (e) {
    console.error('Update parsing error:', e);
  }
  return new Response('OK');
}
async function handleBotMessage(message, env, originUrl) {
  const chatId = message.chat.id;
  const text = message.text.trim();
  if (text.startsWith('/')) {
    if (text === '/start' || text === '/help') {
      await sendMessage(chatId, '👋 欢迎！直接发送关键词即可搜索资源。\n也可以访问网页版搜索：' + originUrl);
    }
    return;
  }
  await executeSearchAndReply(chatId, text, 1, env, originUrl);
}
async function handleCallbackQuery(query, env, originUrl) {
  const chatId = query.message.chat.id;
  const data = query.data;
  const [pagePart, queryPart] = data.split('|');
  const page = parseInt(pagePart.split(':')[1]);
  const keyword = queryPart.split(':')[1];
  await executeSearchAndReply(chatId, keyword, page, env, originUrl, query.message.message_id);
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: query.id })
  });
}
async function executeSearchAndReply(chatId, query, page, env, originUrl, messageIdToEdit = null) {
  const searchResult = await searchDatabase(query, page, env, originUrl);
  if (!searchResult.success) {
    const errorMsg = `❌ 错误: ${searchResult.error}`;
    if (messageIdToEdit) await editMessage(chatId, messageIdToEdit, errorMsg);
    else await sendMessage(chatId, errorMsg);
    return;
  }
  const { data, pagination } = searchResult;
  if (data.length === 0) {
    const msg = `🔍 未找到关于 "${query}" 的资源。`;
    if (messageIdToEdit) await editMessage(chatId, messageIdToEdit, msg);
    else await sendMessage(chatId, msg);
    return;
  }
  let messageText = `🔍 搜索 "<b>${query}</b>"\n`;
  messageText += `━━━━━━━━━━━━━━━━\n`;
  messageText += `📊 共找到 ${pagination.total} 个结果 (第 ${pagination.page}/${pagination.totalPages} 页)\n`;
  messageText += `━━━━━━━━━━━━━━━━\n`;
  data.forEach((item, index) => {
    const safeTitle = item.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const driveName = item.drive_type === 1 ? 'ali' : 'quark';
    messageText += `${index + 1}. 📦 [${driveName}] <a href="${item.short_url}">${safeTitle}</a>\n\n`;
  });
  const buttons = [];
  const navRow = [];
  const safeQuery = query.length > 20 ? query.substring(0, 20) : query;
  if (pagination.hasPrev) {
    navRow.push({ text: '⬅️ 上一页', callback_data: `p:${page - 1}|q:${safeQuery}` });
  }
  if (pagination.hasNext) {
    navRow.push({ text: '下一页 ➡️', callback_data: `p:${page + 1}|q:${safeQuery}` });
  }
  if (navRow.length > 0) buttons.push(navRow);
  if (ADS_CONFIG && ADS_CONFIG.length > 0) {
    const randomAd = ADS_CONFIG[Math.floor(Math.random() * ADS_CONFIG.length)];
    buttons.push([{ text: randomAd.text, url: randomAd.url }]);
  }
  const replyMarkup = { inline_keyboard: buttons };
  if (messageIdToEdit) {
    await editMessage(chatId, messageIdToEdit, messageText, replyMarkup);
  } else {
    await sendMessage(chatId, messageText, replyMarkup);
  }
}
async function sendMessage(chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
async function editMessage(chatId, messageId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
async function handleRedirectRequest(request, env, context) {
    const url = new URL(request.url);
    const short_url = url.pathname.substring(1);
    if (!env.DB) return new Response("Database error", { status: 500 });
    try {
        const selectSql = `SELECT long_url1, long_url2 FROM resource WHERE short_url = ?1`;
        const selectStmt = env.DB.prepare(selectSql).bind(short_url);
        const result = await selectStmt.first();
        if (!result) {
            // 返回 404 表示不是短链，交给调用者决定（调用者会转去 ASSETS）
            return new Response("Not found", { status: 404 });
        }
        let targetUrl = result.long_url2;
        if (!targetUrl || targetUrl === 'NULL') {
            targetUrl = result.long_url1;
        }
        if (!targetUrl) return new Response("Invalid link target", { status: 404 });
        context.waitUntil((async () => {
            try {
                const updateSql = `UPDATE resource SET click_count = COALESCE(click_count, 0) + 1 WHERE short_url = ?1`;
                await env.DB.prepare(updateSql).bind(short_url).run();
            } catch (dbError) {
                console.error(`Click count update failed for "${short_url}":`, dbError);
            }
        })());
        return Response.redirect(targetUrl, 302);
    } catch (e) {
        console.error("Redirect Error:", e);
        return new Response("Internal Server Error", { status: 500 });
    }
}
function processQueryLikePython(text) {
    if (!text) return [];
    let processed = text.replace(/[^a-zA-Z\u4e00-\u9fa5]/g, ' ');
    processed = processed.replace(/\s+/g, ' ').trim();
    if (!processed) return [];
    const tokens = [];
    const englishWords = processed.match(/[a-zA-Z]{2,}/g);
    if (englishWords) tokens.push(...englishWords);
    const chineseChars = processed.replace(/[^\u4e00-\u9fa5]/g, '');
    if (chineseChars.length > 1) {
        for (let i = 0; i < chineseChars.length - 1; i++) {
            tokens.push(chineseChars.substring(i, i + 2));
        }
    }
    return tokens;
}
