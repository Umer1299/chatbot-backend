import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export const leadCaptureTool = new DynamicStructuredTool({
  name: 'capture_lead',
  description: 'Call when user provides contact info or expresses purchase intent.',
  schema: z.object({
    name: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    message: z.string(),
    score: z.number().min(0).max(100).optional(),
  }),
  func: async ({ name, email, phone, message, score = 0 }) => {
    const bubbleWebhook = process.env.BUBBLE_API_URL;
    if (!bubbleWebhook) {
      console.warn('BUBBLE_API_URL not set, lead not captured');
      return 'Lead capture endpoint not configured.';
    }
    const payload = {
      name: name || 'Anonymous',
      email: email,
      phone: phone,
      source: 'Chatbot',
      message: message,
      leadScore: score,
      timestamp: new Date().toISOString(),
    };
    try {
      const response = await fetch(bubbleWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Bubble responded ${response.status}`);
      return `Lead captured (score ${score}). Thank you!`;
    } catch (err) {
      console.error('Lead capture failed:', err);
      return 'I had trouble capturing your info. Please try again later.';
    }
  },
});