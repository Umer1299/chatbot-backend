import 'dotenv/config';

const BASE = 'http://localhost:' + (process.env.PORT || 3000);

async function req(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, body: data };
}

async function run() {
  console.log('\n=== INTEGRATION TESTS ===\n');
  let TOKEN = '', BUSINESS_ID = '', BOT_ID = '';

  // 1. Health
  const h = await req('GET', '/healthz');
  console.log(h.status === 200
    ? '✅ Health OK'
    : '❌ Health: ' + h.status);

  // 2. Auth token
  const auth = await req('POST', '/api/auth/token', {
    bubbleUserId: 'it_' + Date.now(),
    email: 'it@chatflowai.com',
    businessName: 'IT Test Co',
    industry: 'construction'
  });
  if (auth.status === 200 && auth.body.token) {
    TOKEN = auth.body.token;
    BUSINESS_ID = auth.body.businessId;
    BOT_ID = auth.body.botId;
    console.log('✅ Auth token received');
    console.log('   BusinessId:', BUSINESS_ID);
    console.log('   BotId:', BOT_ID);
  } else {
    console.error('❌ Auth failed:', auth.status, auth.body);
    process.exit(1);
  }

  const AH = { Authorization: 'Bearer ' + TOKEN };

  // 3. Get available models
  const models = await req('GET', '/api/business/models', null, AH);
  console.log(models.status === 200
    ? '✅ GET /business/models — available: ' + models.body.availableModels?.length
    : '❌ GET /business/models: ' + models.status);

  // 4. Model access denied (trial + claude-opus)
  const deny = await req('PATCH', '/api/business/model',
    { modelId: 'claude-opus' }, AH);
  console.log(deny.status === 403
    ? '✅ claude-opus denied on trial (403)'
    : '❌ claude-opus should be 403, got: ' + deny.status);

  // 5. Model allowed (trial + gpt-4o-mini)
  const allow = await req('PATCH', '/api/business/model',
    { modelId: 'gpt-4o-mini' }, AH);
  console.log(allow.status === 200
    ? '✅ gpt-4o-mini allowed on trial'
    : '❌ gpt-4o-mini should be 200, got: ' + allow.status);

  // 6. Invalid model rejected
  const invalid = await req('PATCH', '/api/business/model',
    { modelId: 'fake-model-xyz' }, AH);
  console.log(invalid.status === 400
    ? '✅ Invalid model rejected (400)'
    : '❌ Invalid model should be 400, got: ' + invalid.status);

  // 7. Business status
  const status = await req('GET', '/api/business/status', null, AH);
  console.log(status.status === 200
    ? '✅ GET /business/status — isDisabled: ' + status.body.isDisabled
    : '❌ GET /business/status: ' + status.status);

  // 8. Disable chatbot
  const disable = await req('POST', '/api/business/disable',
    { reason: 'IT test disable', disabledBy: 'bubble' }, AH);
  console.log(disable.status === 200
    ? '✅ POST /business/disable OK'
    : '❌ POST /business/disable: ' + disable.status);

  // 9. Wait for cache clear
  await new Promise(r => setTimeout(r, 600));

  // 10. Preview shows isDisabled: true
  const preview = await req('GET',
    '/api/business/bot-config/' + BOT_ID + '/preview');
  const previewOK = preview.status === 200 && preview.body.isDisabled === true;
  console.log(previewOK
    ? '✅ Preview shows isDisabled: true'
    : '❌ Preview disabled state wrong: ' + JSON.stringify(preview.body));

  // 11. Preview does NOT expose system_prompt
  const noLeak = !('system_prompt' in (preview.body || {}));
  console.log(noLeak
    ? '✅ Preview does not expose system_prompt'
    : '❌ SECURITY: Preview exposes system_prompt!');

  // 12. Enable chatbot
  const enable = await req('POST', '/api/business/enable', {}, AH);
  console.log(enable.status === 200
    ? '✅ POST /business/enable OK'
    : '❌ POST /business/enable: ' + enable.status);

  // 13. Admin routes require x-admin-key
  const chatbotsNoKey = await req('GET', '/api/chatbots');
  console.log(chatbotsNoKey.status === 401
    ? '✅ /api/chatbots requires admin key'
    : '❌ /api/chatbots should be 401, got: ' + chatbotsNoKey.status);

  // 14. Dashboard routes require JWT
  const leadsNoAuth = await req('GET', '/api/leads');
  console.log(leadsNoAuth.status === 401
    ? '✅ /api/leads requires JWT'
    : '❌ /api/leads should be 401, got: ' + leadsNoAuth.status);

  // 15. Scrape requires JWT
  const scrapeNoAuth = await req('POST', '/api/scrape/start',
    { url: 'https://example.com' });
  console.log(scrapeNoAuth.status === 401
    ? '✅ /api/scrape/start requires JWT'
    : '❌ /api/scrape/start should be 401, got: ' + scrapeNoAuth.status);

  console.log('\n=== DONE ===\n');
  process.exit(0);
}

run().catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
