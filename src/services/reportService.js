import pool from '../db/pool.js';

export async function generateWeeklyReport(businessId) {
  // Get conversation stats for the last 7 days
  const { rows: stats } = await pool.query(`
    SELECT COUNT(DISTINCT session_id) AS total_conversations,
           COUNT(*) AS total_messages,
           AVG(ai_response_length) AS avg_response_length,
           COUNT(*) FILTER (WHERE role = 'user') AS user_messages,
           COUNT(*) FILTER (WHERE role = 'assistant' AND is_unanswered = true) AS failed_messages
    FROM messages
    WHERE business_id = $1
      AND created_at > NOW() - INTERVAL '7 days'
  `, [businessId]);

  const totalConversations = parseInt(stats[0]?.total_conversations) || 0;
  const totalMessages = parseInt(stats[0]?.total_messages) || 0;
  const avgResponseLength = Math.round(parseFloat(stats[0]?.avg_response_length) || 0);
  const failedMessages = parseInt(stats[0]?.failed_messages) || 0;
  const failureRate = totalMessages > 0 ? (failedMessages / totalMessages * 100).toFixed(1) : 0;

  // Leads generated
  const { rows: leads } = await pool.query(
    `SELECT COUNT(*) AS count FROM leads WHERE business_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [businessId]
  );
  const leadsGenerated = parseInt(leads[0]?.count) || 0;

  // Top questions (normalize: lowercase, remove punctuation, trim, first 6-10 words)
  const { rows: questions } = await pool.query(
    `SELECT LOWER(REGEXP_REPLACE(content, '[[:punct:]]', '', 'g')) AS cleaned, COUNT(*) AS cnt
     FROM messages
     WHERE business_id = $1 AND role = 'user' AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY cleaned
     ORDER BY cnt DESC LIMIT 15`,
    [businessId]
  );
  const topQuestions = questions.map(q => {
    const words = q.cleaned.trim().split(/\s+/);
    return { text: words.slice(0, 8).join(' '), count: parseInt(q.cnt) };
  }).sort((a, b) => b.count - a.count).slice(0, 5);

  // Failed questions are user turns whose matching assistant reply was marked unanswered.
  // Do not mark every question in a session as failed just because another turn failed.
  const { rows: failedQs } = await pool.query(
    `SELECT LOWER(REGEXP_REPLACE(m.content, '[[:punct:]]', '', 'g')) AS cleaned, COUNT(*) AS cnt
     FROM messages m
     JOIN LATERAL (
       SELECT a.is_unanswered
       FROM messages a
       WHERE a.business_id = m.business_id
         AND a.session_id = m.session_id
         AND a.role = 'assistant'
         AND a.created_at >= m.created_at
       ORDER BY a.created_at ASC
       LIMIT 1
     ) a ON true
     WHERE m.business_id = $1
       AND m.role = 'user'
       AND m.created_at > NOW() - INTERVAL '7 days'
       AND a.is_unanswered = true
     GROUP BY cleaned
     ORDER BY cnt DESC LIMIT 10`,
    [businessId]
  );
  const failedQuestions = failedQs.map(q => {
    const words = q.cleaned.trim().split(/\s+/).slice(0, 8).join(' ');
    return { text: words, count: parseInt(q.cnt) };
  }).slice(0, 5);

  // Top intent categories
  const { rows: intents } = await pool.query(
    `SELECT intent_category, COUNT(*) AS cnt
     FROM messages WHERE business_id = $1 AND role = 'user' AND intent_category IS NOT NULL
       AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY intent_category ORDER BY cnt DESC`,
    [businessId]
  );
  const topIntentCategories = intents.map(i => ({ category: i.intent_category, count: parseInt(i.cnt) }));

  // Peak day
  const { rows: peak } = await pool.query(
    `SELECT TO_CHAR(created_at, 'Day') AS day, COUNT(*) AS cnt
     FROM messages WHERE business_id = $1 AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY day ORDER BY cnt DESC LIMIT 1`,
    [businessId]
  );
  const peakUsageDay = peak[0]?.day?.trim() || null;

  // Insights & recommendations (simple rule-based)
  const insights = [];
  const recommendations = [];
  if (topIntentCategories.find(c => c.category === 'pricing')?.count > 5) {
    insights.push('Most users asked about pricing.');
  }
  if (failedQuestions.length > 0) {
    insights.push('The chatbot struggled to answer some user questions.');
    recommendations.push('Review the top unanswered questions and add to knowledge base.');
  }
  if (failureRate > 30) {
    recommendations.push('Increase chatbot knowledge: many responses are failing.');
  }
  if (topIntentCategories.find(c => c.category === 'booking') && leadsGenerated < 2) {
    recommendations.push('Consider enabling appointment booking in the chatbot.');
  }

  return {
    totalConversations,
    totalMessages,
    leadsGenerated,
    topQuestions,
    failedQuestions,
    failureRate: parseFloat(failureRate),
    topIntentCategories,
    avgResponseLength,
    peakUsageDay,
    insights,
    recommendations
  };
}
