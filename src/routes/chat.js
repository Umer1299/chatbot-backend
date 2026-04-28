diff --git a/src/routes/chat.js b/src/routes/chat.js
index ffef917815956ba20ff663fb3fde95a7bf19e47a..ca24673f262310115888300a65680e6e689b1d7c 100644
--- a/src/routes/chat.js
+++ b/src/routes/chat.js
@@ -39,119 +39,122 @@ router.post('/', tokenAuth, domainRestriction, async (req, res) => {
   const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
 
   const activeModel = requestedModel || settings.model || process.env.DEFAULT_MODEL;
 
   if (!ALLOWED_MODELS.has(activeModel)) {
     return res.status(400).json({ error: 'Invalid model' });
   }
 
   const finalPrompt = systemPrompt || settings.systemPrompt || 'You are a helpful assistant.';
 
   const moderation = await moderateInput(message);
   if (moderation.flagged) {
     return res.status(400).json({ error: 'Message violates policy' });
   }
 
   if (countTokens(message, activeModel) > 600) {
     return res.status(400).json({ error: 'Message too long (600 token limit)' });
   }
 
   let keepAlive, timeoutId;
 
   if (isStreaming) {
     res.setHeader('Content-Type', 'text/event-stream');
     res.setHeader('Cache-Control', 'no-cache');
     res.setHeader('Connection', 'keep-alive');
+    res.setHeader('X-Accel-Buffering', 'no');
     res.flushHeaders?.();
 
     keepAlive = setInterval(() => {
       if (!res.writableEnded) res.write(':\n\n');
     }, 15000);
 
     timeoutId = setTimeout(() => {
       if (!res.writableEnded) {
         res.write(`data: ${JSON.stringify({ type: 'error', message: 'Timeout' })}\n\n`);
         res.end();
       }
       clearInterval(keepAlive);
     }, 30000);
   }
 
   async function runModel(modelName) {
     const t1 = Date.now();
     const history = await getLastMessages(namespace, sessionId);
     console.log(`History fetch: ${Date.now() - t1} ms`);
 
     // Cache key using namespace + first 100 chars of message
     const cacheKey = `rag:${namespace}:${message.slice(0, 100)}`;
     let ragDocs;
     const t2 = Date.now();
     const cached = await redisClient.get(cacheKey);
     if (cached) {
       ragDocs = JSON.parse(cached);
       console.log(`Pinecone cache hit: ${Date.now() - t2} ms`);
     } else {
       const retriever = await getRetriever(namespace, 4);
       ragDocs = await retriever.getRelevantDocuments(message);
       await redisClient.setex(cacheKey, 300, JSON.stringify(ragDocs));
       console.log(`Pinecone retrieval (cache miss): ${Date.now() - t2} ms`);
     }
 
     let context = ragDocs.map(d => d.pageContent).join('\n');
 
-    let input = `System:${finalPrompt}\nContext:${context}\nUser:${message}`;
+    let systemWithContext = `${finalPrompt}\n\nRelevant context:\n${context}`;
+    let input = `System:${systemWithContext}\nUser:${message}`;
     let tokens = countTokens(input, modelName);
 
     while (tokens > 600 && context.length > 200) {
       context = context.slice(0, context.length * 0.8);
-      input = `System:${finalPrompt}\nContext:${context}\nUser:${message}`;
+      systemWithContext = `${finalPrompt}\n\nRelevant context:\n${context}`;
+      input = `System:${systemWithContext}\nUser:${message}`;
       tokens = countTokens(input, modelName);
     }
 
     if (tokens > 600) throw new Error('Context too large');
 
     let fullResponse = '';
     const model = new ChatOpenAI({
       modelName,
       temperature: 0.2,
       maxTokens: 600,
       streaming: isStreaming,
       callbacks: isStreaming
         ? [{
             handleLLMNewToken(token) {
               fullResponse += token;
               if (!res.writableEnded) {
                 res.write(`data: ${JSON.stringify({ token })}\n\n`);
               }
             }
           }]
         : undefined
     });
 
     const t3 = Date.now();
     const response = await model.invoke([
-      { role: 'system', content: finalPrompt },
+      { role: 'system', content: systemWithContext },
       ...history,
       { role: 'user', content: message }
     ]);
     console.log(`OpenAI invoke: ${Date.now() - t3} ms`);
 
     if (!isStreaming || !fullResponse) {
       fullResponse = response.content || '';
     }
 
     await addMessage(namespace, sessionId, 'user', message);
     await addMessage(namespace, sessionId, 'assistant', fullResponse);
 
     const outputTokens = countTokens(fullResponse, modelName);
 
     await redisClient.incrbyfloat(
       `cost_usd:${namespace}`,
       estimateCost(modelName, tokens, outputTokens)
     );
 
     const lead = detectLead(message);
     if (lead.isLead) {
       const exists = await redisClient.get(`lead:${namespace}:${sessionId}`);
       if (!exists) {
         await leadCaptureTool.func({ ...lead.contactInfo, message, score: lead.score });
         await redisClient.setex(`lead:${namespace}:${sessionId}`, 86400, '1');
@@ -183,26 +186,26 @@ router.post('/', tokenAuth, domainRestriction, async (req, res) => {
       if (!res.writableEnded) {
         res.write(`data: ${JSON.stringify({ type: 'meta', ...result })}\n\n`);
         res.write('data: [DONE]\n\n');
         res.end();
       }
       clearInterval(keepAlive);
       clearTimeout(timeoutId);
     } else {
       res.json(result);
     }
 
   } catch (err) {
     if (isStreaming) {
       if (!res.writableEnded) {
         res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
         res.end();
       }
       clearInterval(keepAlive);
       clearTimeout(timeoutId);
     } else {
       res.status(500).json({ error: err.message });
     }
   }
 });
 
-export default router;
\ No newline at end of file
+export default router;
